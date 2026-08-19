// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { existsSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fixedCommentDoorbell, fixedControlDoorbell } from "./control-bridge.ts";
import { MazzyHttpServer, parseMazzyPort } from "./server.ts";
import { legacyStorePathStrict, resolveOpsDbPathDiagnostic, readProjectIdentity, resolveTrustedProjectRoot } from "./project.ts";
import { SpecGraphAssembler } from "./spec-graph.ts";
import { RgraGraphSource } from "./graph-sources/rgra-source.ts";
import { SpecDocSource } from "./graph-sources/spec-source.ts";
import { BacklogSource } from "./graph-sources/backlog-source.ts";
import { MemorySource, VectorsSource } from "./graph-sources/stub-sources.ts";
import type { GraphProvider } from "./server.ts";
import type { ControlPlanePort } from "./types.ts";
import { resolveControlDb } from "./control-resolve.ts";
import { assertProjectRegistration, clearStaleProjectRegistryLock, forgetCurrentProjectRegistration } from "./project-registry.ts";
import { loadRoutingPolicy, resolveRoutingPolicyPath, route, ROUTING_INTENTS, ROUTING_RISKS } from "./routing.ts";
import { orchestrationGate } from "./anti-tunnel.ts";
import { applyMazzyInit, formatPlan, mazzyDoctor, planMazzyInit, rollbackMazzyInit } from "./scaffold.ts";
import { cleanupMazzyStorage, formatCleanupResult, type CleanupResult, writeCleanupReceipt } from "./storage-policy.ts";
import { probeControlDb } from "./control-db.ts";
import { activateCutover, applyControlMigration, cutoverReadiness, deactivateCutover, planControlMigration, rollbackControlMigration } from "./control-migrate.ts";
import { applyDataMove, planDataMove } from "./data-move.ts";
import { MazzyStore } from "./store.ts";
import { TASK_STATES, TASK_TYPES, type TaskRisk, type TaskState, type TaskType } from "./types.ts";

const RouteParams = Type.Object({
  intent: StringEnum(ROUTING_INTENTS),
  risk: StringEnum(ROUTING_RISKS),
  operation: Type.Optional(Type.String({ maxLength: 80 })),
  inputDigest: Type.Optional(Type.String({ maxLength: 64 })),
  sourceRevision: Type.Optional(Type.String({ maxLength: 64 })),
  gateReason: Type.Optional(Type.String({ maxLength: 500 })),
});

const TaskParams = Type.Object({
  action: StringEnum(["create", "list", "get", "update"] as const),
  id: Type.Optional(Type.String({ description: "Task UUID for get/update" })),
  title: Type.Optional(Type.String({ description: "Task title for create/update" })),
  description: Type.Optional(Type.String()),
  type: Type.Optional(StringEnum(TASK_TYPES)),
  state: Type.Optional(StringEnum(TASK_STATES)),
  priority: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
  risk: Type.Optional(StringEnum(["low", "medium", "high", "critical"] as const)),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Required for every update" })),
});

const AssignmentParams = Type.Object({
  action: StringEnum(["assign", "transfer", "import-completion", "record-evidence", "import-report", "import-comment", "update-monitor"] as const),
  taskId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 1 }),
  runId: Type.String({ minLength: 1, maxLength: 200 }),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  role: Type.Optional(StringEnum(["worker", "reviewer"] as const)),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  verdict: Type.Optional(StringEnum(["PASS", "FAIL", "UNCERTAIN"] as const)),
  payload: Type.Optional(Type.Unknown()),
  childSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  lifecycle: Type.Optional(StringEnum(["queued", "running", "paused", "needs_attention", "completed", "failed", "stopped"] as const)),
  model: Type.Optional(Type.String({ maxLength: 500 })),
  cycle: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  currentActivity: Type.Optional(Type.String({ maxLength: 500 })),
  currentTool: Type.Optional(Type.String({ maxLength: 500 })),
  report: Type.Optional(Type.Object({ summary: Type.String({ maxLength: 12000 }), whatChanged: Type.String({ maxLength: 12000 }), checks: Type.String({ maxLength: 12000 }), howToUse: Type.String({ maxLength: 12000 }), acceptanceCriteria: Type.Unknown(), results: Type.Unknown(), limitations: Type.String({ maxLength: 12000 }), model: Type.Optional(Type.String({ maxLength: 500 })), sessionId: Type.Optional(Type.String({ maxLength: 200 })), cycle: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) })),
});

const DiscussionParams = Type.Object({
  action: StringEnum(["read", "respond"] as const),
  taskId: Type.String({ minLength: 1, maxLength: 100 }),
  commentId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const ControlParams = Type.Object({
  action: StringEnum(["read", "claim", "complete", "fail"] as const),
  id: Type.String({ minLength: 1, maxLength: 100 }),
  childSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  childRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});

/** Child processes must never obtain a control-plane writer through inherited extensions. */
export function assertMazzyParent(): void {
  if (process.env.PI_SUBAGENT_CHILD) throw new Error("Mazzy Command Center control-plane writes are parent-only");
}
/** Read a Mazzy env var, honoring the legacy PI_OPS_* name during the rename transition. */
export function mazzyEnv(suffix: string): string | undefined {
  const next = process.env[`MAZZY_${suffix}`]; if (next !== undefined) return next;
  return process.env[`PI_OPS_${suffix}`];
}
export function parentActorIdentity(): string { return mazzyEnv("PARENT_ID")?.trim() || "pi-parent"; }

/**
 * Compose the spec<->component<->backlog graph provider from real sources. This
 * is the ONLY place that learns host paths (repo root, package docs dir); the
 * assembler scrubs them and server.ts never sees them (INV-2/INV-3). Absent
 * sources (code-graph artifact missing, memory/vectors) degrade to legend chips.
 */
function buildGraphProvider(store: ControlPlanePort, projectRoot: string | undefined): GraphProvider {
  const docsDir = new URL("../docs", import.meta.url).pathname;
  // Optional code<->spec graph artifact under the project's Mazzy work area.
  const codeGraphPath = projectRoot ? `${projectRoot}/.mazzy/work/code-graph/graph.json` : new URL("../.mazzy/work/code-graph/graph.json", import.meta.url).pathname;
  const assembler = new SpecGraphAssembler([
    new RgraGraphSource(codeGraphPath),
    new SpecDocSource(docsDir),
    new BacklogSource(store),
    new MemorySource(),
    new VectorsSource(),
  ]);
  return {
    build: () => assembler.build(),
    focus: async (id: string, depth: number) => SpecGraphAssembler.focusSubgraph(await assembler.build(), id, depth),
  };
}

export default function mazzyCommandCenter(pi: ExtensionAPI) {
  let store: MazzyStore | undefined;
  let server: MazzyHttpServer | undefined;
  let activeCwd = "";
  let currentCtx: ExtensionContext | undefined;
  let routingPolicy: ReturnType<typeof loadRoutingPolicy> | undefined;
  let parentSessionId: string | undefined;
  let projectId: string | undefined;

  // Resolve the opaque project identity for the active checkout without ever exposing the host path.
  // Falls back to undefined for non-enrolled/non-Git folders; the DB is still folder-isolated.
  const resolveProjectId = (cwd: string): string | undefined => {
    try { return readProjectIdentity(cwd).descriptor.projectId; } catch { return undefined; }
  };
  /** Compute the redacted web context (opaque projectId, DB source enum, registry status). Never a host path (ADR-001 INV-3). */
  const computeWebContext = (cwd: string) => {
    let registryStatus: string | undefined;
    try { registryStatus = assertProjectRegistration(cwd).status; } catch { registryStatus = undefined; }
    // Redacted project-doc presence (booleans only, never a host path — INV-3). Lets the dashboard show "this project's spec/architecture" without exposing where they live on disk.
    const specPresent = existsSync(new URL("../docs/SDD.md", import.meta.url));
    const architecturePresent = existsSync(new URL("../docs/ARCHITECTURE.md", import.meta.url));
    // dbSource is the identity-gated selection (canonical-promoted once reconnected,
    // canonical-held when a promotion is pending/inconsistent, else legacy) — enum only, never a path.
    const resolution = resolveControlDb(cwd);
    return { projectId, enrolled: Boolean(projectId), dbSource: resolution.selection, effectiveEndpoint: resolution.effectiveEndpoint, cutover: resolution.cutover, sealed: resolution.sealed, registryStatus, specPresent, architecturePresent } as const;
  };

  const requireRoutingPolicy = (): ReturnType<typeof loadRoutingPolicy> => {
    routingPolicy ??= loadRoutingPolicy(resolveRoutingPolicyPath(activeCwd || process.cwd()));
    return routingPolicy;
  };

  const requireStore = (): MazzyStore => {
    if (!store) throw new Error("Mazzy Command Center store is not initialized");
    return store;
  };

  const updateUi = () => {
    if (!store || !currentCtx) return;
    const snapshot = store.snapshot();
    const active = snapshot.counts.RUNNING + snapshot.counts.REVIEW + snapshot.counts.BLOCKED;
    currentCtx.ui.setStatus("mazzy", currentCtx.ui.theme.fg(active ? "accent" : "dim", `Mazzy ${snapshot.tasks.length} · active ${active}`));
    if (snapshot.tasks.length === 0) {
      currentCtx.ui.setWidget("mazzy", undefined);
      return;
    }
    const line = `Mazzy  backlog ${snapshot.counts.BACKLOG}  ready ${snapshot.counts.READY}  running ${snapshot.counts.RUNNING}  review ${snapshot.counts.REVIEW}  blocked ${snapshot.counts.BLOCKED}`;
    currentCtx.ui.setWidget("mazzy", [currentCtx.ui.theme.fg("dim", line)], { placement: "aboveEditor" });
  };

  const startServer = async (): Promise<string> => {
    assertMazzyParent();
    if (!server) {
      const policy = requireRoutingPolicy();
      const safeAgents = Object.fromEntries(Object.entries(policy.agents).map(([name, agent]) => [name, { model: agent.model }]));
      server = new MazzyHttpServer(requireStore(), parseMazzyPort(mazzyEnv("PORT")), async ({ requestId, command }) => {
        const bridge = fixedControlDoorbell(requestId, command, !(currentCtx?.isIdle() ?? true));
        await pi.sendUserMessage(bridge.text, bridge.options);
      }, safeAgents, async ({ taskId, commentId }) => {
        const bridge = fixedCommentDoorbell(taskId, commentId);
        await pi.sendUserMessage(bridge.text, bridge.options);
      });
    }
    server.setActiveParentSession(parentSessionId);
    server.setWebContext(computeWebContext(activeCwd || process.cwd()));
    server.setPrimaryScope(projectId);
    server.setGraphProvider(buildGraphProvider(requireStore(), resolveTrustedProjectRoot(activeCwd || process.cwd())));
    // Each parent session owns its own server; if the default port is taken by another
    // session/clone, bind a free OS-assigned port instead of failing (unless MAZZY_PORT is pinned).
    return server.start(mazzyEnv("PORT") === undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (process.env.PI_SUBAGENT_CHILD) return;
    parentSessionId = ctx.sessionManager.getSessionId();
    if (activeCwd !== ctx.cwd) {
      await server?.stop();
      store?.close();
      activeCwd = ctx.cwd;
      // Identity-gated reconnection onto the unified control store. Fail-closed:
      // returns the legacy path unless a verified promotion exists, so this is a
      // no-op until /mazzy-migrate apply + reload. One store for tools+dashboard+web.
      const resolution = resolveControlDb(ctx.cwd);
      // A failed active cutover must never silently reopen writable legacy.
      if (resolution.sealed) {
        // Do not leave a closed store/server reachable through requireStore after
        // the fail-closed branch (a previous session may have owned legacy).
        store = undefined;
        server = undefined;
        currentCtx.ui.setStatus("mazzy", currentCtx.ui.theme.fg("warning", "Mazzy control endpoint sealed"));
        currentCtx.ui.notify("Mazzy cutover is active but canonical verification failed; legacy writes are sealed until repaired or cutover is deactivated.", "error");
        activeCwd = "";
        return;
      }
      store = new MazzyStore(resolution.path);
      projectId = resolveProjectId(ctx.cwd);
      server = undefined;
    }
    updateUi();
    if (mazzyEnv("AUTO_START") !== "0") {
      try {
        await startServer();
        const fallbackNote = server!.portFallbackApplied ? ` (port ${server!.boundPort}, default was busy)` : "";
        ctx.ui.setStatus("mazzy-web", ctx.ui.theme.fg("dim", `Mazzy web ${server!.url}${fallbackNote}${projectId ? ` · project ${projectId.slice(0, 8)}` : ""}`));
      } catch (error) {
        ctx.ui.setStatus("mazzy-web", ctx.ui.theme.fg("warning", "Mazzy web external/off"));
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          ctx.ui.notify(`Mazzy web failed: ${error instanceof Error ? error.message : error}`, "warning");
        }
      }
    }
    // Exactly one durable request is retried after a parent session starts; no timer/watch loop exists.
    queueMicrotask(() => { void server?.reconcileOneUndelivered(); });
  });

  pi.on("session_shutdown", async () => {
    await server?.stop();
    server = undefined;
    store?.close();
    store = undefined;
    // Reset the reconnection guard: session_start reopens the store only when
    // activeCwd !== ctx.cwd. Leaving activeCwd set meant a shutdown->start cycle
    // in the SAME checkout (/reload, resume, model switch) skipped reopening and
    // left store undefined — the dashboard/widget then showed an empty backlog
    // with no db handle or web port. Clearing it forces a clean re-open.
    activeCwd = "";
    currentCtx = undefined;
    parentSessionId = undefined;
  });

  pi.registerTool({
    name: "mazzy_route",
    label: "Mazzy Route",
    description: "Read-only policy preflight. It selects a bounded route and never spawns agents, calls RPC, or changes task state.",
    promptSnippet: "Select a Mazzy Command Center policy route before parent-controlled delegation",
    promptGuidelines: ["Use mazzy_route for a recommendation only; the parent remains the orchestration decision-maker."],
    parameters: RouteParams,
    async execute(_id, params) {
      assertMazzyParent();
      const result = route(requireRoutingPolicy(), params);
      // Orchestrator-level anti-tunnel gate: surface a single-mechanism directive so
      // the parent can redirect to consolidation instead of delegating against a
      // split-brain backlog. Read-only; never blocks the route computation itself.
      const gate = orchestrationGate(activeCwd || process.cwd());
      const enriched = { ...result, orchestrationGate: { clear: gate.clear, directive: gate.directive, reason: gate.reason, mechanismStatus: gate.mechanism.status, tunnelCount: gate.mechanism.tunnelCount } };
      return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }], details: enriched };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("mazzy_route ")) + theme.fg("muted", args.intent), 0, 0); },
    renderResult(result, _options, theme) {
      const first = result.content[0]; const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerTool({
    name: "mazzy_task",
    label: "Mazzy Task",
    description: "Create, list, get, or update durable Mazzy Command Center tasks. Every update requires expectedRevision. DONE additionally requires independent PASS evidence recorded by the control plane.",
    promptSnippet: "Manage durable backlog tasks in the Mazzy Command Center control plane",
    promptGuidelines: ["Use mazzy_task for durable project backlog state instead of inventing an informal task list."],
    parameters: TaskParams,
    async execute(_id, params) {
      assertMazzyParent();
      const db = requireStore();
      const actor = parentActorIdentity();
      let result: unknown;
      if (params.action === "create") {
        if (!params.title) throw new Error("title is required for create");
        result = db.createTask({
          title: params.title,
          description: params.description,
          type: params.type as TaskType | undefined,
          state: params.state as TaskState | undefined,
          priority: params.priority,
          risk: params.risk as TaskRisk | undefined,
          actor,
        });
      } else if (params.action === "list") {
        const all = db.listTasks(params.state as TaskState | undefined);
        result = { tasks: all.slice(0, 100), total: all.length, truncated: all.length > 100 };
      } else if (params.action === "get") {
        if (!params.id) throw new Error("id is required for get");
        result = db.getTask(params.id);
        if (!result) throw new Error(`Task not found: ${params.id}`);
      } else {
        if (!params.id) throw new Error("id is required for update");
        result = db.updateTask(params.id, {
          title: params.title,
          description: params.description,
          type: params.type as TaskType | undefined,
          state: params.state as TaskState | undefined,
          priority: params.priority,
          risk: params.risk as TaskRisk | undefined,
          expectedRevision: params.expectedRevision,
          actor,
        });
      }
      updateUi();
      // Identifier-only bus payload (never full durable content) — matches the identifier-only doorbell contract so no task title/description/report crosses the shared Pi event bus to other extensions.
      pi.events.emit("mazzy:task-changed:v1", { action: params.action, taskId: (result as { id?: string } | undefined)?.id, revision: (result as { revision?: number } | undefined)?.revision });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("mazzy_task ")) + theme.fg("muted", args.action), 0, 0);
    },
    renderResult(result, _options, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.length > 500 ? `${text.slice(0, 500)}…` : text), 0, 0);
    },
  });

  pi.registerTool({
    name: "mazzy_assignment",
    label: "Mazzy Assignment",
    description: "Parent-only control-plane attestation for assignment, transfer, completion import, and reviewer evidence. It never spawns, polls, listens, or authenticates child identity.",
    promptSnippet: "Record a parent-attested Mazzy Command Center run assignment or imported result",
    promptGuidelines: ["Only the interactive Pi parent may use this tool. Child claims remain opaque until parent attestation."],
    parameters: AssignmentParams,
    async execute(_id, params) {
      assertMazzyParent();
      const db = requireStore(); const actor = parentActorIdentity(); let result: unknown;
      if (params.action === "assign") {
        if (!params.agent || !params.role || !params.idempotencyKey) throw new Error("agent, role and idempotencyKey are required for assign");
        result = db.assignRun({ taskId: params.taskId, expectedTaskRevision: params.expectedRevision, runId: params.runId, agent: params.agent, role: params.role, idempotencyKey: params.idempotencyKey, actor, parentSessionId, childSessionId: params.childSessionId, payload: params.payload, model: params.model, cycle: params.cycle });
      } else if (params.action === "transfer") {
        if (!params.agent || !params.idempotencyKey) throw new Error("agent and idempotencyKey are required for transfer");
        result = db.transferRun({ taskId: params.taskId, expectedTaskRevision: params.expectedRevision, runId: params.runId, agent: params.agent, idempotencyKey: params.idempotencyKey, actor, parentSessionId, childSessionId: params.childSessionId, payload: params.payload, model: params.model, cycle: params.cycle });
      } else if (params.action === "import-completion") {
        if (!params.report) throw new Error("structured report is required for completion import");
        result = db.attestCompletion({ taskId: params.taskId, expectedTaskRevision: params.expectedRevision, runId: params.runId, payload: params.payload, report: { ...params.report, agent: params.agent }, actor });
      } else if (params.action === "record-evidence") {
        if (!params.kind || !params.verdict) throw new Error("kind and verdict are required for record-evidence");
        result = db.recordReviewerEvidence(params.taskId, { expectedTaskRevision: params.expectedRevision, runId: params.runId, kind: params.kind, verdict: params.verdict, payload: params.payload, actor });
      } else if (params.action === "import-report") {
        if (!params.report) throw new Error("structured report is required");
        result = db.importReviewReport(params.taskId, params.runId, params.expectedRevision, { ...params.report, agent: params.agent }, actor);
      } else if (params.action === "import-comment") {
        if (!params.kind) throw new Error("kind supplies the agent comment body");
        result = db.importAgentComment(params.taskId, params.runId, params.kind, params.replyTo, actor);
      } else {
        if (!params.lifecycle) throw new Error("lifecycle is required for update-monitor");
        result = db.updateRunActivity({ taskId: params.taskId, runId: params.runId, lifecycle: params.lifecycle, model: params.model, cycle: params.cycle, currentActivity: params.currentActivity, currentTool: params.currentTool, actor });
      }
      updateUi(); // Identifier-only bus payload; no binding/report content crosses the shared event bus.
      pi.events.emit("mazzy:assignment-changed:v1", { action: params.action, taskId: params.taskId, runId: params.runId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("mazzy_assignment ")) + theme.fg("muted", args.action), 0, 0); },
    renderResult(result, _options, theme) { const first = result.content[0]; const text = first?.type === "text" ? first.text : ""; return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.length > 500 ? `${text.slice(0, 500)}…` : text), 0, 0); },
  });

  pi.registerTool({
    name: "mazzy_discussion",
    label: "Mazzy Discussion",
    description: "Parent-only durable task discussion reader and responder. Read the identifier-only doorbell here; responses derive actor and role from the interactive parent or a matching bound run.",
    promptSnippet: "Read and answer a durable Mazzy Command Center task discussion message",
    promptGuidelines: ["Children must not use this tool. Never forge an agent role; use runId only for a matching parent-attested binding."],
    parameters: DiscussionParams,
    async execute(_id, params) {
      assertMazzyParent();
      const db = requireStore(); let result: unknown;
      if (params.action === "read") {
        const detail = db.getTaskDetail(params.taskId);
        if (!detail) throw new Error(`Task not found: ${params.taskId}`);
        const comment = params.commentId ? detail.comments.find((entry) => entry.id === params.commentId) : undefined;
        if (params.commentId && !comment) throw new Error("Comment not found on task");
        result = params.commentId ? { task: detail.task, comment, comments: detail.comments } : detail;
      } else {
        if (!params.body) throw new Error("body is required for respond");
        result = db.respondToDiscussion(params.taskId, { body: params.body, replyTo: params.replyTo ?? params.commentId, runId: params.runId }, parentActorIdentity(), parentSessionId);
      }
      updateUi();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("mazzy_discussion ")) + theme.fg("muted", args.action), 0, 0); },
    renderResult(result, _options, theme) { const first = result.content[0]; const text = first?.type === "text" ? first.text : ""; return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.length > 500 ? `${text.slice(0, 500)}…` : text), 0, 0); },
  });

  pi.registerTool({
    name: "mazzy_control",
    label: "Mazzy Control",
    description: "Parent-only claim/read/complete/fail boundary for dashboard GO, PAUSE and STOP requests. GO completion requires a matching current parent-attested worker binding; PAUSE/STOP completion records the parent-supplied observed outcome text. It never spawns or directly controls a child.",
    promptSnippet: "Inspect and acknowledge one durable dashboard orchestration request",
    promptGuidelines: ["Read the request and task through this tool, use mazzy_route or its approved agent only, then use pi-subagents controls yourself. Do not mark success until a real run/session observation exists."],
    parameters: ControlParams,
    async execute(_id, params) {
      assertMazzyParent();
      const db = requireStore(); let result: unknown;
      if (params.action === "read") {
        result = db.getControlRequest(params.id);
        if (!result) throw new Error(`Control request not found: ${params.id}`);
      } else if (params.action === "claim") {
        if (!parentSessionId) throw new Error("No active parent session");
        result = db.claimControlRequest({ id: params.id, parentSessionId });
      } else if (params.action === "complete") {
        result = db.completeControlRequest({ id: params.id, childSessionId: params.childSessionId, childRunId: params.childRunId, outcome: params.outcome });
      } else {
        if (!params.error) throw new Error("error is required for fail");
        result = db.failControlRequest({ id: params.id, error: params.error });
      }
      updateUi();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("mazzy_control ")) + theme.fg("muted", args.action), 0, 0); },
    renderResult(result, _options, theme) { const first = result.content[0]; const text = first?.type === "text" ? first.text : ""; return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.length > 500 ? `${text.slice(0, 500)}…` : text), 0, 0); },
  });

  const canonicalUrl = async (): Promise<string | undefined> => { try { if (!server?.running) await startServer(); return server!.url; } catch { return undefined; } };
  const startFailureMessage = (error: unknown): string => { const port = parseMazzyPort(mazzyEnv("PORT")); if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") return `Mazzy server port ${port} is pinned via MAZZY_PORT but already owned by another Pi session. Unset MAZZY_PORT to auto-bind a free port, or stop the other server.`; return `Mazzy server unavailable: ${error instanceof Error ? error.message : String(error)}`; };
  const scopeLine = (): string => `\nProject: ${projectId ?? "unenrolled (folder-isolated DB)"}\nSession: ${parentSessionId ?? "n/a"}`;
  const showStatus = async (ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); const url = await canonicalUrl(); const snapshot = requireStore().snapshot(); ctx.ui.notify(`Mazzy: ${snapshot.tasks.length} tasks · active ${snapshot.counts.RUNNING + snapshot.counts.REVIEW}${scopeLine()}\nDashboard: ${url ?? "unavailable"}\nUse /mazzy-url access to retrieve the capability access URL and token.`, "info"); updateUi(); };
  const serverCommand = async (args: string, ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); const action = args.trim() || "status"; if (action === "start") { try { if (!server?.running) await startServer(); ctx.ui.notify(`Mazzy server started: ${server!.url}`, "info"); } catch (error) { ctx.ui.notify(startFailureMessage(error), "error"); } } else if (action === "stop") { await server?.stop(); ctx.ui.setStatus("mazzy-web", undefined); ctx.ui.notify("Mazzy server stopped", "info"); } else if (action === "status") ctx.ui.notify(server?.running ? `Mazzy server: ${server.url}${scopeLine()}` : "Mazzy server is not owned by this session", "info"); else ctx.ui.notify("Usage: /mazzy-server start|stop|status", "error"); };
  const initCommand = async (args: string, ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); const flag = args.trim(); const result = flag === "--rollback" ? rollbackMazzyInit(ctx.cwd) : flag === "--apply" || flag === "--force" ? applyMazzyInit(ctx.cwd, flag === "--force") : planMazzyInit(ctx.cwd); ctx.ui.notify(`${result.dryRun ? "Mazzy init plan (dry-run)" : result.rolledBack ? "Mazzy rollback" : "Mazzy init applied"}\n${formatPlan(result)}`, "info"); };
  const doctorCommand = async (args: string, ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); const diagnostic = resolveOpsDbPathDiagnostic(ctx.cwd); const report = mazzyDoctor(ctx.cwd, legacyStorePathStrict(ctx.cwd) ?? resolveControlDb(ctx.cwd).path, diagnostic); const text = args.trim() === "--json" ? JSON.stringify(report) : report.map((item) => `${item.status} ${item.name} — ${item.hint}`).join("\n"); ctx.ui.notify(text, report.some((item) => item.status === "FAIL") ? "warning" : "info"); };
  const registryCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
    assertMazzyParent();
    const action = args.trim() || "status";
    if (action === "status") ctx.ui.notify(`Mazzy registry: ${assertProjectRegistration(ctx.cwd).status}`, "info");
    else if (action === "forget-current") { const result = forgetCurrentProjectRegistration(ctx.cwd); ctx.ui.notify(result.removed ? "Current checkout registration forgotten; project identity was not changed." : "No current registration was removed.", result.removed ? "info" : "warning"); }
    else if (action === "unlock-stale") { const result = clearStaleProjectRegistryLock(); ctx.ui.notify(result.cleared ? "Stale registry lock cleared." : `Registry lock not cleared: ${result.reason}.`, result.cleared ? "info" : "warning"); }
    else ctx.ui.notify("Usage: /mazzy-registry status|forget-current|unlock-stale", "error");
  };
  /** Stop-before-close-before-resolve reconnect prevents a mid-session cutover from
   * retaining an invisible writer on the old endpoint. */
  const reconnectControlStore = async (ctx: ExtensionContext): Promise<boolean> => {
    const wasRunning = Boolean(server?.running);
    await server?.stop();
    server = undefined;
    store?.close();
    store = undefined;
    const resolution = resolveControlDb(ctx.cwd);
    if (resolution.sealed) {
      activeCwd = "";
      ctx.ui.setStatus("mazzy", ctx.ui.theme.fg("warning", "Mazzy control endpoint sealed"));
      return false;
    }
    try {
      store = new MazzyStore(resolution.path);
      activeCwd = ctx.cwd;
      projectId = resolveProjectId(ctx.cwd);
      updateUi();
      if (wasRunning) await startServer(); // startServer sets fresh web context.
      return true;
    } catch {
      store = undefined;
      server = undefined;
      activeCwd = "";
      return false;
    }
  };
  const migrateCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
    assertMazzyParent();
    const arg = args.trim() || "status";
    if (arg === "status") { ctx.ui.notify(JSON.stringify(probeControlDb(ctx.cwd)), "info"); return; }
    if (arg === "plan") { const plan = planControlMigration(ctx.cwd); ctx.ui.notify(plan ? JSON.stringify(plan) : "Untrusted project root; migration plan is unavailable.", plan ? "info" : "warning"); return; }
    if (arg === "cutover-ready" || arg === "readiness") { const r = cutoverReadiness(ctx.cwd); ctx.ui.notify(r ? JSON.stringify(r) : "Untrusted project root; cutover readiness is unavailable.", r?.cutoverReady ? "info" : "warning"); return; }
    // `apply` re-snapshots legacy -> canonical. Over an already-promoted store the
    // engine refuses and advertises `force`; `apply --force` makes that remedy
    // executable (audit B1). Prefer the offline `rollback`->`apply` path in the runbook.
    if (arg === "apply" || arg === "--apply" || arg === "apply --force" || arg === "apply-force") { const force = arg.includes("force"); const result = applyControlMigration(ctx.cwd, { apply: true, force }); ctx.ui.notify(result ? JSON.stringify(result) : "Untrusted project root; migration was not attempted.", result?.ok ? "info" : "warning"); return; }
    if (arg === "rollback" || arg === "rollback --force" || arg === "rollback-force") { const force = arg.includes("force"); const result = rollbackControlMigration(ctx.cwd, { apply: true, force }); ctx.ui.notify(result ? JSON.stringify(result) : "Untrusted project root; rollback was not attempted.", result?.restored ? "info" : "warning"); return; }
    if (arg === "cutover") {
      const result = activateCutover(ctx.cwd, { apply: true });
      // Witness publication can succeed before later activation writes fail; after
      // any applied attempt close and re-resolve so legacy is never retained open.
      const reconnected = result?.applied ? await reconnectControlStore(ctx) : false;
      ctx.ui.notify(result ? `${JSON.stringify(result)}${result.applied ? reconnected ? "\nSession endpoint re-resolved." : "\nSession endpoint stopped; restart required before further writes." : ""}` : "Untrusted project root; cutover was not attempted.", result?.ok && reconnected ? "info" : "warning");
      return;
    }
    if (arg === "deactivate-cutover") {
      const result = deactivateCutover(ctx.cwd, { apply: true });
      // Partial deactivation can also change authority before reporting ok.
      const reconnected = result?.applied ? await reconnectControlStore(ctx) : false;
      ctx.ui.notify(result ? `${JSON.stringify(result)}${result.applied ? reconnected ? "\nSession endpoint re-resolved." : "\nSession endpoint stopped; restart required before further writes." : ""}` : "Untrusted project root; cutover deactivation was not attempted.", result?.ok && reconnected ? "info" : "warning");
      return;
    }
    ctx.ui.notify("Usage: /mazzy-migrate [status|plan|cutover-ready (read-only) | apply [--force]|rollback [--force]|cutover|deactivate-cutover] (mutations are parent-only; prefer the offline scripts/migrate.sh runbook for cutover)", "error");
  };
  const moveCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
    assertMazzyParent();
    // Usage: /mazzy-move <plan|apply> --from <path-cwd> [--state BACKLOG,READY]
    // For safety this first slice only supports moving FROM another project's cwd
    // into THIS project's legacy store; both endpoints are trusted roots, never env.
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const verb = parts[0] || "help";
    const opIdx = parts.indexOf("--op"); const op = (opIdx >= 0 ? parts[opIdx + 1] : "transfer") as "transfer" | "fork" | "merge";
    const fromIdx = parts.indexOf("--from"); const from = fromIdx >= 0 ? parts[fromIdx + 1] : undefined;
    const stateIdx = parts.indexOf("--state"); const states = stateIdx >= 0 ? parts[stateIdx + 1]?.split(",") : undefined;
    if ((verb !== "plan" && verb !== "apply") || !from || !["transfer", "fork", "merge"].includes(op)) { ctx.ui.notify("Usage: /mazzy-move plan|apply --from <source-project-cwd> [--op transfer|fork|merge] [--state BACKLOG,READY] (dry-run is default; imports tasks as BACKLOG, evidence-contained; merge collapses identical-content duplicates)", verb === "help" ? "info" : "error"); return; }
    const selection = states && states.length ? { kind: "state" as const, states: states as never } : { kind: "all" as const };
    // Both endpoints route through the resolver ("active"): the source reads whatever
    // that project's session reads, and the destination writes THIS session's real
    // store (canonical under cutover, else legacy) — never a store the session can't see.
    const request = { op, source: { kind: "active" as const, cwd: from }, destination: { kind: "active" as const, cwd: ctx.cwd }, selection, actor: parentActorIdentity() };
    const result = verb === "apply" ? applyDataMove({ ...request, apply: true }) : planDataMove(request);
    ctx.ui.notify(JSON.stringify(result), (result as { ok: boolean }).ok ? "info" : "warning");
  };
  const cleanCommand = async (args: string, ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); const flag = args.trim(); if (flag && flag !== "--apply") { ctx.ui.notify("Usage: /mazzy-clean [--apply] (dry-run is the default)", "error"); return; } let result: CleanupResult; try { result = cleanupMazzyStorage(ctx.cwd, { apply: flag === "--apply" }); } catch { ctx.ui.notify("Mazzy cleanup did not safely complete; some eligible files may have changed. No OS temporary files were touched.", "warning"); return; } if (flag === "--apply") { try { writeCleanupReceipt(ctx.cwd, result); } catch { ctx.ui.notify(`Mazzy cleanup applied, but the receipt was not persisted.\n${formatCleanupResult(result)}`, "warning"); return; } } ctx.ui.notify(`${result.dryRun ? "Mazzy cleanup dry-run" : "Mazzy cleanup applied"}\n${formatCleanupResult(result)}`, "info"); };
  const portLine = (): string => { if (!server) return ""; const requested = parseMazzyPort(mazzyEnv("PORT")); return server.portFallbackApplied ? `\nPort: ${server.boundPort} (requested ${requested} was in use by another Pi session — auto-assigned a free port)` : `\nPort: ${server.boundPort}`; };
  const showAccess = async (ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); try { if (!server?.running) await startServer(); ctx.ui.notify(`Mazzy access URL (open this — it carries the token):\n${server!.accessUrl}\n\nToken: ${server!.accessToken}${portLine()}${scopeLine()}`, "info"); } catch (error) { ctx.ui.notify(startFailureMessage(error), "error"); } };
  const menu = async (ctx: ExtensionContext): Promise<void> => { if (!ctx.hasUI) return; const choice = await ctx.ui.select("Mazzy Command Center", ["Dashboard URL", "Access URL", "Server start", "Server stop", "Task summary", "Doctor", "Cleanup dry-run", "Init dry-run"]); if (choice === "Dashboard URL") ctx.ui.notify(`Dashboard: ${(await canonicalUrl()) ?? "unavailable"}`, "info"); else if (choice === "Access URL") await showAccess(ctx); else if (choice === "Server start") await serverCommand("start", ctx); else if (choice === "Server stop") await serverCommand("stop", ctx); else if (choice === "Task summary") await showStatus(ctx); else if (choice === "Doctor") await doctorCommand("", ctx); else if (choice === "Cleanup dry-run") await cleanCommand("", ctx); else if (choice === "Init dry-run") await initCommand("", ctx); };
  const urlCommand = async (args: string, ctx: ExtensionContext): Promise<void> => { assertMazzyParent(); const arg = args.trim(); if (arg === "access" || arg === "") { await showAccess(ctx); return; } if (arg === "plain") { try { if (!server?.running) await startServer(); ctx.ui.notify(`Mazzy dashboard URL (no token): ${server!.url}${portLine()}\nUse /mazzy-url to reveal the access URL with token.`, "info"); } catch (error) { ctx.ui.notify(startFailureMessage(error), "error"); } return; } ctx.ui.notify("Usage: /mazzy-url [access|plain] — default shows the access URL with token", "error"); };
  const statusCommand = async (_args: string, ctx: ExtensionContext): Promise<void> => showStatus(ctx);
  pi.registerCommand("mazzy", { description: "Show concise Mazzy status and safe dashboard URL", handler: statusCommand });
  pi.registerCommand("mazzy-url", { description: "Show Mazzy access URL with token (use 'plain' for the token-less URL)", handler: async (args, ctx) => urlCommand(args, ctx) });
  pi.registerCommand("mazzy-server", { description: "Manage Mazzy server: start, stop, status", handler: serverCommand });
  pi.registerCommand("mazzy-menu", { description: "Open the Mazzy Command Center menu", handler: async (_args, ctx) => menu(ctx) });
  pi.registerCommand("mazzy-init", { description: "Plan or apply portable Mazzy project scaffolding", handler: async (args, ctx) => initCommand(args, ctx) });
  pi.registerCommand("mazzy-doctor", { description: "Run safe Mazzy diagnostics", handler: async (args, ctx) => doctorCommand(args, ctx) });
  pi.registerCommand("mazzy-registry", { description: "Inspect or explicitly repair the private Linux project registry", handler: async (args, ctx) => registryCommand(args, ctx) });
  pi.registerCommand("mazzy-migrate", { description: "Control-database migration: status|plan|cutover-ready (read-only), apply [--force]|rollback [--force]|cutover|deactivate-cutover (legacy source retained; writes canonical .mazzy/control + external witness and .mazzy/backups)", handler: async (args, ctx) => migrateCommand(args, ctx) });
  pi.registerCommand("mazzy-move", { description: "Cross-project data movement (transfer/fork tasks between projects; dry-run by default, evidence-contained)", handler: async (args, ctx) => moveCommand(args, ctx) });
  pi.registerCommand("mazzy-clean", { description: "Preview TTL cleanup; pass --apply to delete eligible Mazzy work files", handler: async (args, ctx) => cleanCommand(args, ctx) });
  // Backward-compatible aliases share exactly the public handlers.
  pi.registerCommand("ops", { description: "Alias for /mazzy", handler: statusCommand });
  pi.registerCommand("ops-server", { description: "Alias for /mazzy-server", handler: serverCommand });
  pi.registerShortcut(Key.ctrlAlt("m"), { description: "Open Mazzy menu", handler: async (ctx) => { if (ctx.hasUI && ctx.mode === "tui") await menu(ctx); } });
}