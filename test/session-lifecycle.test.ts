import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import mazzyControl from "../src/index.ts";

const scratchRoot = testScratchRoot;
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }> };
type Handler = (event: unknown, context: unknown) => Promise<void>;

// Regression: a shutdown->start cycle in the SAME checkout (/reload, resume,
// model switch) must reopen the control store and repaint the backlog widget.
// Previously session_shutdown left activeCwd set, so session_start short-circuited
// its `activeCwd !== ctx.cwd` guard, never reopened the store, and the dashboard
// showed an empty backlog with no db handle — exactly the "backlog 0" symptom.
test("session_shutdown then session_start in the same cwd reopens the store and repaints the backlog", async () => {
  const tools = new Map<string, Tool>(); const handlers = new Map<string, Handler>();
  const dir = projectTemp("pi-ops-lifecycle-");
  const child = process.env.PI_SUBAGENT_CHILD; const autoStart = process.env.PI_OPS_AUTO_START;
  let widgetLines: readonly string[] | undefined; let statusText: string | undefined;
  const ctx = () => ({
    cwd: dir,
    sessionManager: { getSessionId: () => "parent-session" },
    ui: {
      theme: { fg: (_style: string, text: string) => text },
      setStatus(_key: string, text?: string) { statusText = text; },
      setWidget(_key: string, lines?: readonly string[]) { widgetLines = lines ? [...lines] : lines; },
      notify() {},
    },
  });
  const readWidget = (): readonly string[] | undefined => widgetLines;
  try {
    execFileSync("git", ["init", "-q", dir]);
    delete process.env.PI_SUBAGENT_CHILD;
    process.env.PI_OPS_AUTO_START = "0";
    mazzyControl({ on(name: string, handler: Handler) { handlers.set(name, handler); }, registerTool(tool: Tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, events: { emit() {} } } as never);

    const start = handlers.get("session_start")!; const shutdown = handlers.get("session_shutdown")!;
    const taskTool = () => tools.get("mazzy_task")!;

    // First boot: open store, create a durable task, expect the widget to show it.
    await start({}, ctx());
    const created = (await taskTool().execute("create", { action: "create", title: "durable across reload" })).details as { id: string };
    assert.ok(created.id, "task created on first boot");
    // Force the widget to reflect the current store snapshot on first boot.
    await start({}, ctx()); // same cwd re-entry keeps the store; widget should render 1 backlog task
    const firstWidget = readWidget();
    assert.ok(firstWidget && firstWidget.some((l) => /backlog 1\b/.test(l)), `first boot widget shows the backlog task, got: ${JSON.stringify(firstWidget)}`);

    // The failing cycle: shutdown (tears down store) then start in the SAME cwd.
    widgetLines = undefined; statusText = undefined;
    await shutdown({}, {});
    await start({}, ctx());

    // The store must have reopened; the tool must be usable and the widget repainted.
    const snapshot = (await taskTool().execute("read", { action: "list" })).details as { tasks?: Array<{ id: string }> } | Array<{ id: string }>;
    const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks ?? [];
    assert.equal(tasks.length, 1, "store reopened after shutdown->start and still holds the task");
    const reloadedWidget = readWidget();
    assert.ok(reloadedWidget && reloadedWidget.some((l) => /backlog 1\b/.test(l)), `widget repainted after reload, got: ${JSON.stringify(reloadedWidget)}`);
    assert.notEqual(statusText, "Mazzy control endpoint sealed", "a clean canonical/legacy endpoint must never seal on a same-cwd reload");
  } finally {
    if (child === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = child;
    if (autoStart === undefined) delete process.env.PI_OPS_AUTO_START; else process.env.PI_OPS_AUTO_START = autoStart;
    const shutdown = handlers.get("session_shutdown"); if (shutdown) await shutdown({}, {});
    rmSync(dir, { recursive: true, force: true });
  }
});
