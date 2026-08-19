// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import mazzyControl from "../src/index.ts";
import { applyMazzyInit as apply } from "../src/scaffold.ts";
import { testScratchRoot } from "./git-root.ts";

mkdirSync(testScratchRoot, { recursive: true });
// These tests exercise the parent-only command surface (init/doctor/registry/migrate/clean/status/url),
// which now asserts a parent context. Ensure the suite runs as the parent even when the runner itself
// executes inside a subagent session.
const priorSubagentChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
process.on("exit", () => { if (priorSubagentChild !== undefined) process.env.PI_SUBAGENT_CHILD = priorSubagentChild; });
const commandsRegistryDirectory = mkdtempSync(join(testScratchRoot, "registry-commands-"));
process.on("exit", () => rmSync(commandsRegistryDirectory, { recursive: true, force: true }));
const applyMazzyInit = (cwd: string) => apply(cwd, false, { registryDirectory: commandsRegistryDirectory });

test("Mazzy commands, legacy aliases, compatibility tools, and Ctrl+Alt+M shortcut register", () => {
  const commands = new Map<string, { handler: unknown }>(); const tools = new Set<string>(); const shortcuts: unknown[] = [];
  mazzyControl({ on() {}, registerTool(tool: { name: string }) { tools.add(tool.name); }, registerCommand(name: string, value: { handler: unknown }) { commands.set(name, value); }, registerShortcut(_key: unknown, value: unknown) { shortcuts.push(value); }, events: { emit() {} } } as never);
  for (const name of ["mazzy", "mazzy-url", "mazzy-server", "mazzy-menu", "mazzy-init", "mazzy-doctor", "mazzy-registry", "mazzy-migrate", "mazzy-move", "mazzy-clean", "ops", "ops-server"]) assert.ok(commands.has(name), name);
  assert.equal(commands.get("mazzy")?.handler, commands.get("ops")?.handler);
  assert.equal(commands.get("mazzy-server")?.handler, commands.get("ops-server")?.handler);
  for (const name of ["mazzy_route", "mazzy_task", "mazzy_assignment", "mazzy_discussion", "mazzy_control"]) assert.ok(tools.has(name), name);
  assert.equal(shortcuts.length, 1);
});

test("mazzy-migrate exposes status/plan/apply/rollback with redaction and a safe no-op source", async () => {
  const root = mkdtempSync(join(testScratchRoot, "mazzy-migrate-command-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const projectId = randomUUID(); mkdirSync(join(root, ".mazzy"));
    writeFileSync(join(root, ".mazzy", "project.json"), `${JSON.stringify({ schemaVersion: 1, projectId, createdAt: "2026-01-01T00:00:00.000Z" })}\n`);
    const commands = new Map<string, { handler: unknown }>();
    mazzyControl({ on() {}, registerTool() {}, registerCommand(name: string, value: { handler: unknown }) { commands.set(name, value); }, registerShortcut() {}, events: { emit() {} } } as never);
    const notifications: Array<{ message: string; level: string }> = [];
    const ui = { notify(message: string, level: string) { notifications.push({ message, level }); } };
    const migrate = commands.get("mazzy-migrate")?.handler as (args: string, ctx: unknown) => Promise<void>;
    // status: read-only probe, redacted.
    await migrate("", { cwd: root, ui });
    assert.equal(JSON.parse(notifications[0]!.message).schemaVersion, 1);
    assert.equal(notifications[0]!.message.includes(root), false);
    assert.equal(notifications[0]!.message.includes(projectId), false);
    // plan: read-only, redacted.
    await migrate("plan", { cwd: root, ui });
    assert.equal(JSON.parse(notifications.at(-1)!.message).schemaVersion, 1);
    assert.equal(notifications.at(-1)!.message.includes(root), false);
    // apply with no legacy source: safe no-op, never a false success, no host path.
    await migrate("apply", { cwd: root, ui });
    const applied = JSON.parse(notifications.at(-1)!.message);
    assert.equal(applied.applied, false);
    assert.equal(applied.ok, false);
    assert.equal(notifications.at(-1)!.message.includes(root), false);
    // cutover-ready: read-only readiness probe, redacted, never a false ready.
    await migrate("cutover-ready", { cwd: root, ui });
    const ready = JSON.parse(notifications.at(-1)!.message);
    assert.equal(ready.schemaVersion, 1);
    assert.equal(ready.cutoverReady, false);
    assert.equal(notifications.at(-1)!.message.includes(root), false);
    // readiness alias resolves to the same probe.
    await migrate("readiness", { cwd: root, ui });
    assert.equal(JSON.parse(notifications.at(-1)!.message).cutoverReady, false);
    // apply --force is reachable (audit B1) and remains a safe no-op with no legacy source.
    await migrate("apply --force", { cwd: root, ui });
    const forced = JSON.parse(notifications.at(-1)!.message);
    assert.equal(forced.applied, false);
    assert.equal(forced.ok, false);
    // rollback --force is reachable and does not falsely claim a restore here.
    await migrate("rollback --force", { cwd: root, ui });
    assert.equal(JSON.parse(notifications.at(-1)!.message).restored, false);
    // unknown verb: usage error, and it advertises the new read-only readiness verb.
    await migrate("bogus", { cwd: root, ui });
    assert.equal(notifications.at(-1)!.level, "error");
    assert.match(notifications.at(-1)!.message, /cutover-ready/);
    assert.match(notifications.at(-1)!.message, /Usage: \/mazzy-migrate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup apply reports scan failure distinctly without claiming success", async () => {
  mkdirSync(testScratchRoot, { recursive: true }); const root = mkdtempSync(join(testScratchRoot, "mazzy-clean-failure-command-"));
  try {
    execFileSync("git", ["init", "-q", root]); applyMazzyInit(root);
    const outside = join(root, "outside"); mkdirSync(outside); const protectedFile = join(outside, "protected.txt"); writeFileSync(protectedFile, "keep");
    const tmp = join(root, ".mazzy", "work", "tmp"); rmSync(tmp, { recursive: true }); symlinkSync(outside, tmp, "dir");
    const commands = new Map<string, { handler: unknown }>();
    mazzyControl({ on() {}, registerTool() {}, registerCommand(name: string, value: { handler: unknown }) { commands.set(name, value); }, registerShortcut() {}, events: { emit() {} } } as never);
    const notifications: Array<{ message: string; level: string }> = [];
    const clean = commands.get("mazzy-clean")?.handler as (args: string, ctx: unknown) => Promise<void>;
    await clean("--apply", { cwd: root, ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } });
    assert.equal(existsSync(protectedFile), true);
    assert.deepEqual(notifications, [{ message: "Mazzy cleanup did not safely complete; some eligible files may have changed. No OS temporary files were touched.", level: "warning" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup apply reports receipt-write failure as truthful partial success", async () => {
  mkdirSync(testScratchRoot, { recursive: true }); const root = mkdtempSync(join(testScratchRoot, "mazzy-clean-command-"));
  try {
    execFileSync("git", ["init", "-q", root]); applyMazzyInit(root);
    const old = join(root, ".mazzy", "work", "tmp", "old.txt"); writeFileSync(old, "payload"); const stamp = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000); utimesSync(old, stamp, stamp);
    const manifests = join(root, ".mazzy", "manifests"); const outside = join(root, "outside"); rmSync(manifests, { recursive: true, force: true }); mkdirSync(outside); symlinkSync(outside, manifests, "dir");
    const commands = new Map<string, { handler: unknown }>();
    mazzyControl({ on() {}, registerTool() {}, registerCommand(name: string, value: { handler: unknown }) { commands.set(name, value); }, registerShortcut() {}, events: { emit() {} } } as never);
    const notifications: Array<{ message: string; level: string }> = [];
    const clean = commands.get("mazzy-clean")?.handler as (args: string, ctx: unknown) => Promise<void>;
    await clean("--apply", { cwd: root, ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } });
    assert.equal(existsSync(old), false);
    assert.deepEqual(notifications, [{ message: "Mazzy cleanup applied, but the receipt was not persisted.\ntmp: freed 1 files / 7 bytes", level: "warning" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mutating and token-revealing commands reject a child (subagent) context", async () => {
  const commands = new Map<string, { handler: unknown }>();
  mazzyControl({ on() {}, registerTool() {}, registerCommand(name: string, value: { handler: unknown }) { commands.set(name, value); }, registerShortcut() {}, events: { emit() {} } } as never);
  const prior = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const ctx = { cwd: testScratchRoot, hasUI: false, ui: { notify() {}, setStatus() {}, async select() { return undefined; } } };
    // Every mutating or token/server-lifecycle command must throw parent-only in a child context.
    for (const name of ["mazzy-init", "mazzy-doctor", "mazzy-registry", "mazzy-migrate", "mazzy-move", "mazzy-clean", "mazzy-server", "mazzy-url", "mazzy"]) {
      const handler = commands.get(name)?.handler as (args: string, ctx: unknown) => Promise<void>;
      assert.ok(handler, `command ${name} is registered`);
      await assert.rejects(handler("", ctx), /parent-only/, `${name} must reject a child context`);
    }
  } finally {
    if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = prior;
  }
});