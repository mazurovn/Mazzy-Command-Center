// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { testScratchRoot } from "./git-root.ts";
import { MazzyStore } from "../src/store.ts";
import { ensureProjectIdentity } from "../src/project.ts";
import { applyDataMove, planDataMove } from "../src/data-move.ts";
import { activateCutover, applyControlMigration } from "../src/control-migrate.ts";

function projectTemp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }

/** Seed a legacy store in a project with a mix of task states + a comment. */
function seedSource(root: string): { doneId: string } {
  const store = new MazzyStore(join(root, ".pi-ops", "state.db"));
  const a = store.createTask({ title: "alpha", description: "first" });
  const b = store.createTask({ title: "beta", description: "second" });
  store.updateTask(a.id, { state: "READY", expectedRevision: a.revision });
  store.addComment(b.id, { body: "a note", actor: "user" });
  store.close();
  return { doneId: a.id };
}

test("sealed destination refuses data-move without changing retained legacy bytes", () => {
  const src = projectTemp("dm-sealed-src-"); const dst = projectTemp("dm-sealed-dst-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src); seedSource(dst); ensureProjectIdentity(dst);
    assert.equal(applyControlMigration(dst, { apply: true })!.ok, true);
    assert.equal(activateCutover(dst, { apply: true })!.ok, true);
    const legacy = join(dst, ".pi-ops", "state.db"); const before = readFileSync(legacy);
    // Identity damage after durable activation must seal all endpoint forms.
    writeFileSync(join(dst, ".mazzy", "project.json"), JSON.stringify({ schemaVersion: 1, projectId: "00000000-0000-4000-8000-000000000000", createdAt: "2026-01-01T00:00:00.000Z" }));
    const result = applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    assert.equal(result.ok, false);
    assert.deepEqual(readFileSync(legacy), before);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("active durable cutover refuses an explicit legacy move and preserves retired bytes", () => {
  const src = projectTemp("dm-retired-src-"); const dst = projectTemp("dm-retired-dst-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src); seedSource(dst); ensureProjectIdentity(dst);
    assert.equal(applyControlMigration(dst, { apply: true })!.ok, true); assert.equal(activateCutover(dst, { apply: true })!.ok, true);
    const legacy = join(dst, ".pi-ops", "state.db"), before = readFileSync(legacy);
    const result = applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    assert.equal(result.ok, false); assert.deepEqual(readFileSync(legacy), before);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("dry-run plan reports counts and mutates nothing", () => {
  const src = projectTemp("dm-src-"); const dst = projectTemp("dm-dst-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src);
    const plan = planDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op" });
    assert.equal(plan.ok, true);
    assert.equal(plan.selectedTasks, 2);
    // Destination must still be empty after a dry-run.
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    assert.equal(check.listTasks().length, 0);
    check.close();
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("transfer imports tasks as BACKLOG with fresh ids and history-only comments", () => {
  const src = projectTemp("dm-src2-"); const dst = projectTemp("dm-dst2-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    const { doneId } = seedSource(src);
    const result = applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.imported.tasks, 2);
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    const tasks = check.listTasks();
    assert.equal(tasks.length, 2);
    // Every imported task is BACKLOG, none carries the source id, none is DONE.
    for (const t of tasks) {
      assert.equal(t.state, "BACKLOG");
      assert.notEqual(t.id, doneId);
    }
    check.close();
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("CONTAINMENT: a DONE task with evidence never imports its evidence/binding/report or DONE state", () => {
  const src = projectTemp("dm-src3-"); const dst = projectTemp("dm-dst3-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    ensureProjectIdentity(src);
    // Build a task advanced past BACKLOG in the source (READY) with a comment.
    const store = new MazzyStore(join(src, ".pi-ops", "state.db"));
    const t = store.createTask({ title: "shipped", description: "done work" });
    store.updateTask(t.id, { state: "READY", expectedRevision: t.revision });
    store.addComment(t.id, { body: "progress note", actor: "user" });
    store.close();
    // Move everything to destination.
    const result = applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(result.containment, { liveEvidence: 0, liveBindings: 0, liveReports: 0, doneImported: 0 });
    // Destination has the task as BACKLOG with zero authority rows.
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    for (const task of check.listTasks()) {
      assert.equal(task.state, "BACKLOG");
      const d = check.getTaskDetail(task.id)!;
      assert.equal(d.evidence.length, 0);
      assert.equal(d.bindings.length, 0);
      assert.equal(d.reportStatus === "present", false);
    }
    check.close();
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("re-applying the same transfer is idempotent (no duplicate tasks)", () => {
  const src = projectTemp("dm-idem-src-"); const dst = projectTemp("dm-idem-dst-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src);
    const req = { op: "transfer" as const, source: { kind: "legacy" as const, cwd: src }, destination: { kind: "legacy" as const, cwd: dst }, selection: { kind: "all" as const }, actor: "op", apply: true };
    applyDataMove(req);
    applyDataMove(req); // second apply must not duplicate
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    assert.equal(check.listTasks().length, 2, "re-apply must not create duplicate tasks");
    check.close();
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("containment field is a real query, not a static stub (reports actual destination state)", () => {
  const src = projectTemp("dm-cont-src-"); const dst = projectTemp("dm-cont-dst-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src);
    const result = applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    // The containment counts come from querying every imported task's real detail.
    assert.deepEqual(result.containment, { liveEvidence: 0, liveBindings: 0, liveReports: 0, doneImported: 0 });
    assert.equal(result.ok, true);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("transfer key is scoped by source PROJECT IDENTITY (two distinct sources are not silently dropped)", () => {
  const a = projectTemp("dm-scope-a-"); const b = projectTemp("dm-scope-b-"); const dst = projectTemp("dm-scope-dst-");
  try {
    for (const p of [a, b, dst]) execFileSync("git", ["init", "-q", p]);
    // Two DISTINCT source projects (different identities), each with one task.
    ensureProjectIdentity(a); ensureProjectIdentity(b);
    const sa = new MazzyStore(join(a, ".pi-ops", "state.db")); sa.createTask({ title: "from-a", description: "x" }); sa.close();
    const sb = new MazzyStore(join(b, ".pi-ops", "state.db")); sb.createTask({ title: "from-b", description: "y" }); sb.close();
    applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: a }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: b }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    // Both distinct sources land => 2 tasks (identity-scoped keys don't collide).
    assert.equal(check.listTasks().length, 2);
    check.close();
  } finally { for (const p of [a, b, dst]) rmSync(p, { recursive: true, force: true }); }
});

test("source is never modified by a transfer (copy, not move)", () => {
  const src = projectTemp("dm-src4-"); const dst = projectTemp("dm-dst4-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src);
    const before = new MazzyStore(join(src, ".pi-ops", "state.db"));
    const beforeCount = before.listTasks().length; before.close();
    applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    const after = new MazzyStore(join(src, ".pi-ops", "state.db"));
    assert.equal(after.listTasks().length, beforeCount);
    after.close();
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("selection by state moves only matching tasks", () => {
  const src = projectTemp("dm-src5-"); const dst = projectTemp("dm-dst5-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src); // alpha->READY, beta->BACKLOG
    const result = applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "state", states: ["BACKLOG"] }, actor: "op", apply: true });
    assert.equal(result.imported.tasks, 1);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("merge collapses identical-content tasks into the overlapping destination (union, no duplicates)", () => {
  const a = projectTemp("dm-merge-a-"); const b = projectTemp("dm-merge-b-"); const dst = projectTemp("dm-merge-dst-");
  try {
    for (const p of [a, b, dst]) execFileSync("git", ["init", "-q", p]);
    // Two source projects each contain a task with IDENTICAL content, plus one unique each.
    const sa = new MazzyStore(join(a, ".pi-ops", "state.db"));
    sa.createTask({ title: "shared", description: "same everywhere" });
    sa.createTask({ title: "only-a", description: "unique to a" });
    sa.close();
    const sb = new MazzyStore(join(b, ".pi-ops", "state.db"));
    sb.createTask({ title: "shared", description: "same everywhere" });
    sb.createTask({ title: "only-b", description: "unique to b" });
    sb.close();
    // Merge A then B into destination.
    applyDataMove({ op: "merge", source: { kind: "legacy", cwd: a }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    const rb = applyDataMove({ op: "merge", source: { kind: "legacy", cwd: b }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    const titles = check.listTasks().map((t) => t.title).sort();
    // shared appears ONCE; only-a and only-b both present => 3 total, not 4.
    assert.deepEqual(titles, ["only-a", "only-b", "shared"]);
    assert.equal(rb.ok, true);
    // Accurate telemetry: B's merge imported only-b (1 new) and collapsed shared (1 dup).
    assert.equal(rb.imported.tasks, 1);
    assert.equal(rb.mergedDuplicates, 1);
    check.close();
  } finally { for (const p of [a, b, dst]) rmSync(p, { recursive: true, force: true }); }
});

test("merge dedups even when duplicate content has differing priority/risk (collapse, not error)", () => {
  const a = projectTemp("dm-merge2-a-"); const dst = projectTemp("dm-merge2-dst-");
  try {
    execFileSync("git", ["init", "-q", a]); execFileSync("git", ["init", "-q", dst]);
    const sa = new MazzyStore(join(a, ".pi-ops", "state.db"));
    sa.createTask({ title: "dup", description: "body", priority: 10, risk: "high" });
    sa.createTask({ title: "dup", description: "body", priority: -10, risk: "low" });
    sa.close();
    const r = applyDataMove({ op: "merge", source: { kind: "legacy", cwd: a }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
    assert.equal(r.ok, true, r.detail);
    // One imported, one collapsed — accurate counts even when metadata is identical.
    assert.equal(r.imported.tasks, 1);
    assert.equal(r.mergedDuplicates, 1);
    const check = new MazzyStore(join(dst, ".pi-ops", "state.db"));
    assert.equal(check.listTasks().length, 1, "identical content collapses to one despite metadata differences");
    check.close();
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("move lock: released after success; fresh and stale live-owner locks both refuse", () => {
  const src = projectTemp("dm-lock-src-"); const dst = projectTemp("dm-lock-dst-");
  const move = () => applyDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "all" }, actor: "op", apply: true });
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src);
    const lockPath = join(dst, ".pi-ops", "state.db.mazzy-move.lock");
    // 1) Normal move releases the lock.
    assert.equal(move().ok, true);
    assert.equal(existsSync(lockPath), false);
    // 2) A FRESH pre-created lock refuses a concurrent move, importing nothing.
    mkdirSync(join(dst, ".pi-ops"), { recursive: true });
    writeFileSync(lockPath, "");
    const busy = move();
    assert.equal(busy.ok, false);
    assert.equal(busy.imported.tasks, 0);
    // 3) An old mtime is not proof the owner died: it must not be stolen.
    const old = Date.now() / 1000 - 300;
    utimesSync(lockPath, old, old);
    assert.equal(move().ok, false);
    assert.equal(existsSync(lockPath), true);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("empty selection and same-endpoint are refused; INV-3 digests carry no host path", () => {
  const src = projectTemp("dm-src6-"); const dst = projectTemp("dm-dst6-");
  try {
    execFileSync("git", ["init", "-q", src]); execFileSync("git", ["init", "-q", dst]);
    seedSource(src);
    const empty = planDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: dst }, selection: { kind: "tasks", taskIds: [] }, actor: "op" });
    assert.equal(empty.ok, false);
    const same = planDataMove({ op: "transfer", source: { kind: "legacy", cwd: src }, destination: { kind: "legacy", cwd: src }, selection: { kind: "all" }, actor: "op" });
    assert.equal(same.refusals.includes("same-endpoint"), true);
    const serialized = JSON.stringify(empty) + JSON.stringify(same);
    assert.ok(!serialized.includes(src) && !serialized.includes(dst), "no host path in plan output");
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});