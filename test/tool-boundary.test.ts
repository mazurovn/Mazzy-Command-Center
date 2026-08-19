import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import mazzyControl, { assertMazzyParent, parentActorIdentity } from "../src/index.ts";

const scratchRoot = testScratchRoot;
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }

test("parent-only tool boundary rejects inherited child execution and derives actor locally", () => {
  const child = process.env.PI_SUBAGENT_CHILD; const parent = process.env.PI_OPS_PARENT_ID;
  try {
    process.env.PI_SUBAGENT_CHILD = "1";
    assert.throws(() => assertMazzyParent(), /parent-only/);
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_OPS_PARENT_ID = "interactive-parent";
    assert.doesNotThrow(() => assertMazzyParent());
    assert.equal(parentActorIdentity(), "interactive-parent");
  } finally {
    if (child === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = child;
    if (parent === undefined) delete process.env.PI_OPS_PARENT_ID; else process.env.PI_OPS_PARENT_ID = parent;
  }
});

test("a child cannot invoke import-comment and the parent import path requires a bound run", async () => {
  type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }> };
  const tools = new Map<string, Tool>(); const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const dir = projectTemp("pi-ops-tool-boundary-"); const child = process.env.PI_SUBAGENT_CHILD; const autoStart = process.env.PI_OPS_AUTO_START;
  try {
    // Make this project-local scratch directory its own Git root before session_start
    // can derive the compatibility DB path.
    execFileSync("git", ["init", "-q", dir]);
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_OPS_AUTO_START = "0";
    mazzyControl({ on(name: string, handler: (event: unknown, context: unknown) => Promise<void>) { handlers.set(name, handler); }, registerTool(tool: Tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, events: { emit() {} } } as never);
    await handlers.get("session_start")!({}, { cwd: dir, sessionManager: { getSessionId: () => "parent-session" }, ui: { theme: { fg: (_style: string, text: string) => text }, setStatus() {}, setWidget() {}, notify() {} } });
    const assignment = tools.get("mazzy_assignment")!, taskTool = tools.get("mazzy_task")!, routeTool = tools.get("mazzy_route")!;
    process.env.PI_SUBAGENT_CHILD = "1";
    await assert.rejects(assignment.execute("child-import", { action: "import-comment", taskId: "unreachable", expectedRevision: 1, runId: "unbound", kind: "child comment" }), /parent-only/);
    await assert.rejects(routeTool.execute("child-route", { intent: "bounded-recon", risk: "low" }), /parent-only/);
    delete process.env.PI_SUBAGENT_CHILD;
    const created = (await taskTool.execute("create", { action: "create", title: "discussion import" })).details as { id: string; revision: number };
    const ready = (await taskTool.execute("ready", { action: "update", id: created.id, state: "READY", expectedRevision: created.revision })).details as { revision: number };
    await assert.rejects(assignment.execute("unbound-import", { action: "import-comment", taskId: created.id, expectedRevision: ready.revision, runId: "unbound", kind: "unbound comment" }), /Current matching run binding is required/);
    const bound = (await assignment.execute("assign", { action: "assign", taskId: created.id, expectedRevision: ready.revision, runId: "bound-worker", agent: "worker", role: "worker", idempotencyKey: "bound-worker" })).details as { taskRevision: number };
    const imported = (await assignment.execute("bound-import", { action: "import-comment", taskId: created.id, expectedRevision: bound.taskRevision, runId: "bound-worker", kind: "parent-attested comment" })).details as { role: string; runId: string };
    assert.deepEqual({ role: imported.role, runId: imported.runId }, { role: "worker", runId: "bound-worker" });
  } finally {
    if (child === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = child;
    if (autoStart === undefined) delete process.env.PI_OPS_AUTO_START; else process.env.PI_OPS_AUTO_START = autoStart;
    const shutdown = handlers.get("session_shutdown"); if (shutdown) await shutdown({}, {});
    rmSync(dir, { recursive: true, force: true });
  }
});
