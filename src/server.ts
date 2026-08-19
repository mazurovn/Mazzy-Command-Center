import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CONTROL_COMMANDS, MAX_CONTROL_INSTRUCTIONS_LENGTH, TASK_STATES, TASK_TYPES, UI_TRANSITIONS, type ControlCommand, type ControlPlanePort, type TaskRisk, type TaskState, type TaskType } from "./types.ts";

const EVENT_REPLAY_LIMIT = 200;

const template = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const chatState = readFileSync(new URL("../static/assets/chat-state.js", import.meta.url), "utf8");
const graphView = readFileSync(new URL("../static/assets/graph-view.js", import.meta.url), "utf8");

/**
 * A GraphProvider yields the assembled spec<->component<->backlog graph. It is
 * injected from the composition root (index.ts) so server.ts never learns a host
 * path or identity (INV-2/INV-3). `focus` returns a bounded neighbourhood.
 */
export interface GraphProvider {
  build(): Promise<unknown>;
  focus(id: string, depth: number): Promise<unknown>;
}
/** Constant-time token check: compare fixed-length SHA-256 digests so request length/content cannot leak through timing. */
function tokenMatches(presented: string | string[] | undefined, expected: string): boolean { if (typeof presented !== "string" || !presented) return false; const a = createHash("sha256").update(presented).digest(), b = createHash("sha256").update(expected).digest(); return timingSafeEqual(a, b); }
export type ControlDoorbell = Readonly<{ requestId: string; command: ControlCommand }>;
/** Identifier-only notification; comment text never leaves the durable store through this callback. */
export type CommentDoorbell = Readonly<{ taskId: string; commentId: string }>;
export type ControlRequestCallback = (doorbell: ControlDoorbell) => void | Promise<void>;
export type CommentCallback = (doorbell: CommentDoorbell) => void | Promise<void>;
/** Opaque redacted context blob surfaced to the local web UI. The parent (index.ts) computes the whole object with only opaque IDs, source enums and status strings (never a host path, ADR-001 INV-3); the server treats it as a passthrough and never introspects or derives identity from it (INV-2). */
export type MazzyWebContext = Readonly<Record<string, string | number | boolean | undefined>>;

export function parseMazzyPort(value: string | undefined): number {
  if (value === undefined) return 4319;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) throw new Error("MAZZY_PORT must be an integer from 0 through 65535");
  const port = Number(value);
  if (port > 65535) throw new Error("MAZZY_PORT must be an integer from 0 through 65535");
  return port;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 64 * 1024) throw new Error("Request body is too large"); chunks.push(buffer); }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be an object");
  return parsed as Record<string, unknown>;
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" }); res.end(JSON.stringify(data));
}

export class MazzyHttpServer {
  private server?: Server;
  private readonly token = randomBytes(24).toString("hex");
  private readonly store: ControlPlanePort;
  /** Optional scope resolver. When present, a request may target another enrolled scope's store by opaque key; the default (no key) always resolves to the primary store, so single-scope behavior is unchanged. */
  private readonly resolveScope?: (scopeKey: string) => ControlPlanePort | undefined;
  private scopeSummaries: ReadonlyArray<{ scopeKey: string; label?: string }> = [];
  private primaryScopeKey?: string;
  private readonly requestedPort: number;
  private readonly controlCallback?: ControlRequestCallback;
  private readonly commentCallback?: CommentCallback;
  private readonly delivering = new Set<string>();
  private parentSessionId?: string;
  private injectedContext?: MazzyWebContext;
  private graphProvider?: GraphProvider;
  private readonly approvedAgents: Readonly<Record<string, { model: string }>>;
  private readonly streamClosers = new Set<() => void>();
  /** Set when start() had to bind an OS-assigned free port because the requested port was already in use. */
  private fellBackToFreePort = false;

  constructor(store: ControlPlanePort, requestedPort = 4319, controlCallback?: ControlRequestCallback, safeAgents: Readonly<Record<string, { model: string }>> = {}, commentCallback?: CommentCallback, resolveScope?: (scopeKey: string) => ControlPlanePort | undefined) {
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Server port must be an integer from 0 through 65535");
    this.store = store; this.requestedPort = requestedPort; this.controlCallback = controlCallback; this.commentCallback = commentCallback; this.resolveScope = resolveScope;
    this.approvedAgents = Object.fromEntries(Object.entries(safeAgents).filter(([name, agent]) => /^[a-z0-9-]{1,100}$/i.test(name) && typeof agent.model === "string" && agent.model.length > 0 && agent.model.length <= 500).map(([name, agent]) => [name, { model: agent.model }]));
  }
  get running(): boolean { return Boolean(this.server?.listening); }
  /** Observable only for transport cleanup verification; streams carry no scheduler authority. */
  get activeEventStreams(): number { return this.streamClosers.size; }
  /** The port the server is actually listening on (OS-assigned when a fallback occurred), else the requested port. */
  get boundPort(): number { const address = this.server?.address() as AddressInfo | null; return address?.port ?? this.requestedPort; }
  /** True when the requested port was already in use (EADDRINUSE) and the OS assigned a different free port instead. */
  get portFallbackApplied(): boolean { return this.fellBackToFreePort; }
  get url(): string { const address = this.server?.address() as AddressInfo | null; return `http://127.0.0.1:${address?.port ?? this.requestedPort}`; }
  /** Share this URL out-of-band; its token is never inserted into root HTML. */
  get accessUrl(): string { return `${this.url}/#token=${this.token}`; }
  /** The bare capability token; surface it only over trusted local UI, never in root HTML. */
  get accessToken(): string { return this.token; }
  setActiveParentSession(parentSessionId: string | undefined): void { this.parentSessionId = parentSessionId?.trim() || undefined; }
  /** Parent-injected redacted context blob. The server never derives identity itself; it only echoes what the parent computed (INV-2). */
  setWebContext(context: MazzyWebContext | undefined): void { this.injectedContext = context; }
  setGraphProvider(provider: GraphProvider | undefined): void { this.graphProvider = provider; }
  /** Parent-injected list of enrolled scopes (opaque keys + optional labels; never host paths). Drives GET /api/projects and the left rail. */
  /** The opaque key of this server's primary scope, injected by the parent (never derived here). */
  setPrimaryScope(scopeKey: string | undefined): void { this.primaryScopeKey = typeof scopeKey === "string" && /^[0-9a-f-]{1,64}$/i.test(scopeKey) ? scopeKey : undefined; }
  setScopeSummaries(summaries: ReadonlyArray<{ scopeKey: string; label?: string }>): void { this.scopeSummaries = summaries.filter((s) => typeof s.scopeKey === "string" && /^[0-9a-f-]{1,64}$/i.test(s.scopeKey)).map((s) => ({ scopeKey: s.scopeKey, label: typeof s.label === "string" ? s.label.slice(0, 120) : undefined })); }
  /** Resolve the store a request targets. A missing/blank/primary scope key is the default store; a known other key resolves through the injected resolver; an unknown key returns undefined so the caller can 404 without leaking existence. */
  private storeFor(req: IncomingMessage): ControlPlanePort | undefined { const raw = req.headers["x-mazzy-project"]; const scopeKey = typeof raw === "string" ? raw.trim() : ""; if (!scopeKey) return this.store; if (!/^[0-9a-f-]{1,64}$/i.test(scopeKey)) return undefined; if (this.primaryScopeKey && this.primaryScopeKey === scopeKey) return this.store; return this.resolveScope ? this.resolveScope(scopeKey) : undefined; }
  /** Redacted context echoed to the authenticated web UI: the parent-supplied blob plus transport-observable session prefix and bound port. */
  private webContext(): Record<string, unknown> { const address = this.server?.address() as AddressInfo | null; return { ...(this.injectedContext ?? {}), sessionShort: this.parentSessionId ? this.parentSessionId.slice(0, 8) : undefined, port: address?.port ?? this.requestedPort }; }
  get orchestrationOptions(): { agents: Array<{ name: string; model: string }> } { return { agents: Object.entries(this.approvedAgents).map(([name, agent]) => ({ name, model: agent.model })).sort((a, b) => a.name.localeCompare(b.name)) }; }

  /**
   * Bind the dashboard. When allowPortFallback is set and the requested port is already
   * owned (EADDRINUSE, e.g. another Pi session/clone), transparently bind an OS-assigned
   * free port so every session runs its own isolated server instead of failing.
   */
  async start(allowPortFallback = false): Promise<string> {
    if (this.running) return this.accessUrl;
    const listen = (port: number): Promise<void> => new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      const onError = (error: NodeJS.ErrnoException) => { this.server = undefined; reject(error); };
      this.server.once("error", onError);
      this.server.listen(port, "127.0.0.1", () => { this.server!.off("error", onError); resolve(); });
    });
    this.fellBackToFreePort = false;
    try {
      await listen(this.requestedPort);
    } catch (error) {
      if (allowPortFallback && (error as NodeJS.ErrnoException).code === "EADDRINUSE" && this.requestedPort !== 0) { await listen(0); this.fellBackToFreePort = true; }
      else throw error;
    }
    return this.accessUrl;
  }
  async stop(): Promise<void> { for (const close of [...this.streamClosers]) close(); const server = this.server; this.server = undefined; if (!server?.listening) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  /** One bounded session-start recovery/delivery; this is deliberately not a poller. */
  async reconcileOneUndelivered(ownerAvailable: (sessionId: string) => boolean = (id) => id === this.parentSessionId): Promise<void> {
    this.store.reconcileOneClaimedRequest(ownerAvailable);
    const request = this.store.nextUndeliveredControlRequest();
    if (request && this.parentSessionId) await this.deliver(request.id, request.command);
    // Session-start is the only comment redelivery point; durable receipts prevent duplicates.
    if (this.parentSessionId) for (const comment of this.store.unnotifiedComments(this.parentSessionId)) { try { await this.notifyComment(comment.taskId, comment.id); } catch { /* Receipt remains durable; do not duplicate a failed callback in this session. */ } }
  }

  private validHost(host: string): boolean { const address = this.server?.address() as AddressInfo | null; const port = address?.port; return port !== undefined && (host === `127.0.0.1:${port}` || host === `localhost:${port}`); }
  private async deliver(requestId: string, command: ControlCommand): Promise<boolean> {
    const request = this.store.getControlRequest(requestId);
    if (!request) throw new Error(`Control request not found: ${requestId}`);
    if (request.state === "DELIVERED") return true;
    if (request.state !== "REQUESTED" || !this.parentSessionId || !this.controlCallback || this.delivering.has(requestId)) return false;
    this.delivering.add(requestId);
    try { await this.controlCallback({ requestId, command }); this.store.markDelivered(requestId); return true; }
    finally { this.delivering.delete(requestId); }
  }
  private async notifyComment(taskId: string, commentId: string): Promise<void> {
    if (!this.parentSessionId || !this.commentCallback) return;
    // Claim before callback: a lost callback result is not replayed into the same parent session.
    if (!this.store.claimCommentNotification(taskId, commentId, this.parentSessionId)) return;
    await this.commentCallback({ taskId, commentId });
  }
  private requireSameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin && origin !== this.url && origin !== this.url.replace("127.0.0.1", "localhost")) throw new Error("Origin rejected");
  }
  /** Header-authenticated SSE: comments are transport-only and never become durable events. */
  private openEventStream(req: IncomingMessage, res: ServerResponse, store: ControlPlanePort = this.store): void {
    const rawCursor = req.headers["last-event-id"] ?? req.headers["x-pi-ops-cursor"] ?? "0";
    const cursor = typeof rawCursor === "string" && /^\d+$/.test(rawCursor) ? Number(rawCursor) : 0;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", connection: "keep-alive" });
    // High-water mark of what this stream already delivered, so the heartbeat can catch up on events another Pi session committed to the shared DB (in-process fan-out never reaches this session).
    let delivered = cursor;
    const send = (event: { id: number; taskId: string; type: string; payload: unknown; actor: string; createdAt: string }) => { if (!res.writableEnded) { res.write(`id: ${event.id}\nevent: ops-event\ndata: ${JSON.stringify(event)}\n\n`); if (event.id > delivered) delivered = event.id; } };
    const reset = (latestId: number) => { if (!res.writableEnded) res.write(`id: ${latestId}\nevent: mazzy-reset\ndata: ${JSON.stringify({ type: "mazzy.reset", cursor: latestId, requiresFullSnapshot: true })}\n\n`); if (latestId > delivered) delivered = latestId; };
    const latest = store.latestEventId();
    const gap = cursor < Math.max(0, latest - EVENT_REPLAY_LIMIT);
    // Subscribe before reading the bounded replay so no live mutation can fall between them.
    const unsubscribe = store.subscribeEvents(send);
    // A transport heartbeat is deliberately an SSE comment, never an ops event.
    res.write(": keep-alive\n\n");
    if (gap) reset(latest);
    else for (const event of store.listEvents(cursor, EVENT_REPLAY_LIMIT)) send(event);
    // Cross-process catch-up: another Pi session sharing this DB commits events our in-process listener never sees.
    // On each heartbeat tick, reconcile the delivered high-water mark against the durable latest id and push the
    // bounded delta (or an mazzy-reset beyond the replay limit). A transport catch-up on an existing tick, not a poller.
    const heartbeat = setInterval(() => { if (res.writableEnded) return; const durableLatest = store.latestEventId(); if (durableLatest > delivered) { if (durableLatest - delivered > EVENT_REPLAY_LIMIT) reset(durableLatest); else for (const event of store.listEvents(delivered, EVENT_REPLAY_LIMIT)) send(event); } if (!res.writableEnded) res.write(": keep-alive\n\n"); }, 25_000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); this.streamClosers.delete(close); if (!res.writableEnded) res.end(); };
    this.streamClosers.add(close);
    req.once("close", close); req.once("aborted", close); res.once("close", close);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.validHost(req.headers.host ?? "")) { json(res, 400, { error: "Invalid Host header" }); return; }
      const url = new URL(req.url ?? "/", this.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ops" || url.pathname === "/ops/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); res.end(template); return; }
      if (req.method === "GET" && url.pathname === "/assets/chat-state.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'self'; frame-ancestors 'none'" }); res.end(chatState); return; }
      if (req.method === "GET" && url.pathname === "/assets/graph-view.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'self'; frame-ancestors 'none'" }); res.end(graphView); return; }
      if (url.pathname.startsWith("/api/")) {
        // Accept the canonical x-mazzy-token and the legacy x-pi-ops-token during the rename transition.
        const presented = req.headers["x-mazzy-token"] ?? req.headers["x-pi-ops-token"];
        if (!tokenMatches(presented, this.token)) { json(res, 403, { error: "Invalid control token" }); return; }
        if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method ?? "")) this.requireSameOrigin(req);
      }
      if (req.method === "GET" && (url.pathname === "/api/scopes" || url.pathname === "/api/projects")) { const primaryKey = this.primaryScopeKey ?? "primary"; json(res, 200, { projects: [{ id: primaryKey, primary: true }, ...this.scopeSummaries.filter((sc) => sc.scopeKey !== this.primaryScopeKey).map((sc) => ({ id: sc.scopeKey, label: sc.label, primary: false }))] }); return; }
      // Every task/board route below is project-scoped: a missing header uses the primary store; an unknown project id 404s without leaking existence (INV-3).
      const scoped = this.storeFor(req); if (!scoped) { json(res, 404, { error: "Project not found" }); return; }
      if (req.method === "GET" && url.pathname === "/api/snapshot") { json(res, 200, scoped.snapshot()); return; }
      if (req.method === "GET" && url.pathname === "/api/context") { json(res, 200, this.webContext()); return; }
      if (req.method === "GET" && url.pathname === "/api/events") { const after = Number(url.searchParams.get("after") ?? 0); json(res, 200, { events: scoped.listEvents(Number.isFinite(after) ? after : 0) }); return; }
      if (req.method === "GET" && url.pathname === "/api/stream") { this.openEventStream(req, res, scoped); return; }
      if (req.method === "GET" && url.pathname === "/api/graph") {
        if (!this.graphProvider) { json(res, 200, { version: 1, generatedAt: new Date().toISOString(), sources: [], facets: { domains: [], kinds: [], edges: [] }, nodes: [], edges: [], truncated: false, stats: { nodes: 0, edges: 0, orphans: 0, coverageGaps: [] } }); return; }
        const focus = url.searchParams.get("focus");
        if (focus !== null) {
          if (focus.length > 200 || !/^[a-z]+:[A-Za-z0-9_./:'-]+$/.test(focus)) throw new Error("focus must be a bounded canonical node id");
          const depth = Number(url.searchParams.get("depth") ?? 1);
          if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error("depth must be an integer 1..3");
          json(res, 200, await this.graphProvider.focus(focus, depth)); return;
        }
        json(res, 200, await this.graphProvider.build()); return;
      }
      if (req.method === "POST" && url.pathname === "/api/task-details") { const body = await readJson(req); if (!Array.isArray(body.taskIds) || body.taskIds.length > 1000 || body.taskIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]+$/.test(id))) throw new Error("taskIds must be a bounded array of task ids"); json(res, 200, { details: body.taskIds.map((id) => scoped.getTaskDetail(id)).filter((detail): detail is NonNullable<typeof detail> => Boolean(detail)) }); return; }
      if (req.method === "POST" && url.pathname === "/api/tasks") { const body = await readJson(req); const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : ""; if (!key || key.length > 200) throw new Error("Idempotency-Key is required"); if (typeof body.title !== "string") throw new Error("title must be a string"); if (body.description !== undefined && typeof body.description !== "string") throw new Error("description must be a string"); if (body.type !== undefined && !TASK_TYPES.includes(String(body.type) as TaskType)) throw new Error(`type must be one of ${TASK_TYPES.join(", ")}`); if (body.priority !== undefined && typeof body.priority !== "number") throw new Error("priority must be a number"); if (body.risk !== undefined && !["low", "medium", "high", "critical"].includes(String(body.risk))) throw new Error("risk must be one of low, medium, high, critical"); const task = scoped.createTask({ title: body.title, description: body.description as string | undefined, type: body.type as TaskType | undefined, priority: typeof body.priority === "number" ? body.priority : 0, risk: (body.risk as TaskRisk | undefined) ?? "medium", actor: "web", idempotencyKey: key }); json(res, 201, task); return; }
      const commentsMatch = /^\/api\/tasks\/([0-9a-f-]+)\/comments$/.exec(url.pathname);
      if (commentsMatch && req.method === "GET") { if (!scoped.getTask(commentsMatch[1]!)) { json(res, 404, { error: "Task not found" }); return; } json(res, 200, { comments: scoped.listComments(commentsMatch[1]!) }); return; }
      if (commentsMatch && req.method === "POST") { const body = await readJson(req); if (typeof body.body !== "string") throw new Error("Comment body must be a string"); if (body.replyTo !== undefined && typeof body.replyTo !== "string") throw new Error("replyTo must be a string"); if (body.clientMessageId !== undefined && typeof body.clientMessageId !== "string") throw new Error("clientMessageId must be a string"); const comment = scoped.addComment(commentsMatch[1]!, { body: body.body, actor: "user", role: "user", replyTo: body.replyTo as string | undefined, clientMessageId: body.clientMessageId as string | undefined }); try { await this.notifyComment(comment.taskId, comment.id); } catch { /* Durable sent row remains available; notification delivery is not message delivery. */ } json(res, 201, comment); return; }
      const orchestrationMatch = /^\/api\/tasks\/([0-9a-f-]+)\/orchestration$/.exec(url.pathname);
      if (orchestrationMatch && req.method === "GET") { if (!scoped.getTask(orchestrationMatch[1]!)) { json(res, 404, { error: "Task not found" }); return; } json(res, 200, { requests: scoped.listControlRequests(orchestrationMatch[1]!) }); return; }
      if (orchestrationMatch && req.method === "POST") {
        const body = await readJson(req); const command = String(body.command ?? "") as ControlCommand;
        if (!CONTROL_COMMANDS.includes(command)) throw new Error("command must be GO, PAUSE, or STOP");
        if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) throw new Error("expectedRevision is required");
        const idempotencyKey = typeof req.headers["x-idempotency-key"] === "string" ? req.headers["x-idempotency-key"] : "";
        if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("x-idempotency-key is required");
        const approvedAgent = body.approvedAgent === undefined || body.approvedAgent === "auto" ? undefined : String(body.approvedAgent);
        if (approvedAgent && !this.approvedAgents[approvedAgent]) throw new Error("Approved agent is not allowlisted");
        if (body.instructions !== undefined && (typeof body.instructions !== "string" || body.instructions.length > MAX_CONTROL_INSTRUCTIONS_LENGTH)) throw new Error(`instructions must be at most ${MAX_CONTROL_INSTRUCTIONS_LENGTH} characters`);
        if (body.maxCycles !== undefined && (!Number.isInteger(body.maxCycles) || Number(body.maxCycles) < 1 || Number(body.maxCycles) > 10)) throw new Error("maxCycles must be an integer from 1 through 10");
        const active = scoped.listBindings(orchestrationMatch[1]!).find((binding) => binding.role === "worker" && binding.state === "active");
        const request = scoped.createControlRequest({ taskId: orchestrationMatch[1]!, expectedTaskRevision: body.expectedRevision, command, idempotencyKey, approvedAgent, instructions: body.instructions as string | undefined, maxCycles: body.maxCycles as number | undefined, targetRunId: command === "GO" ? undefined : active?.runId, parentSessionId: this.parentSessionId });
        let delivered = false;
        try { delivered = await this.deliver(request.id, request.command); } catch { /* The committed REQUESTED row remains available for the next session start. */ }
        json(res, 202, { request: scoped.getControlRequest(request.id), pending: !delivered, coalesced: request.coalesced === true }); return;
      }
      const optionsMatch = /^\/api\/tasks\/([0-9a-f-]+)\/orchestration\/options$/.exec(url.pathname);
      if (optionsMatch && req.method === "GET") { if (!scoped.getTask(optionsMatch[1]!)) { json(res, 404, { error: "Task not found" }); return; } json(res, 200, this.orchestrationOptions); return; }
      const detailMatch = /^\/api\/tasks\/([0-9a-f-]+)\/detail$/.exec(url.pathname);
      if (req.method === "GET" && detailMatch) { const detail = scoped.getTaskDetail(detailMatch[1]!); if (!detail) { json(res, 404, { error: "Task not found" }); return; } json(res, 200, detail); return; }
      const match = /^\/api\/tasks\/([0-9a-f-]+)$/.exec(url.pathname);
      if (req.method === "PATCH" && match) { const body = await readJson(req); const state = body.state === undefined ? undefined : String(body.state) as TaskState; if (state !== undefined && !TASK_STATES.includes(state)) throw new Error(`Unknown state: ${state}`); const current = scoped.getTask(match[1]!); if (!current) { json(res, 404, { error: "Task not found" }); return; } if (state !== undefined && !UI_TRANSITIONS[current.state].includes(state)) throw new Error(`Drop/UI transition ${current.state} -> ${state} is not allowed by this task's uiTransitions`); /* Reject a supplied-but-invalid field instead of silently dropping it, so an operator never sees "accepted" for an edit the server ignored. */ if (body.title !== undefined && typeof body.title !== "string") throw new Error("title must be a string"); if (body.description !== undefined && typeof body.description !== "string") throw new Error("description must be a string"); if (body.type !== undefined && !TASK_TYPES.includes(String(body.type) as TaskType)) throw new Error(`type must be one of ${TASK_TYPES.join(", ")}`); if (body.priority !== undefined && typeof body.priority !== "number") throw new Error("priority must be a number"); if (body.risk !== undefined && !["low", "medium", "high", "critical"].includes(String(body.risk))) throw new Error("risk must be one of low, medium, high, critical"); const task = scoped.updateTask(match[1]!, { title: body.title as string | undefined, description: body.description as string | undefined, type: body.type as TaskType | undefined, state, priority: body.priority as number | undefined, risk: body.risk as TaskRisk | undefined, expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined, actor: "web" }); json(res, 200, task); return; }
      json(res, 404, { error: "Not found" });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); json(res, message === "Origin rejected" ? 403 : /Revision conflict|Idempotency key conflict/.test(message) ? 409 : 400, { error: message }); }
  }
}
