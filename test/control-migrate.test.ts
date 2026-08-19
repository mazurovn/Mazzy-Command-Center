// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { testScratchRoot } from "./git-root.ts";
import { MazzyStore } from "../src/store.ts";
import { ensureProjectIdentity } from "../src/project.ts";
import { activateCutover, applyControlMigration, cutoverReadiness, deactivateCutover, planControlMigration, rollbackControlMigration, verifyControlDrift } from "../src/control-migrate.ts";
import { resolveControlDb } from "../src/control-resolve.ts";
import { applyMazzyInit } from "../src/scaffold.ts";

function projectTemp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }

/** Build a populated legacy store at <root>/.pi-ops/state.db and return counts. */
function seedLegacy(root: string): { tasks: number } {
  const legacy = join(root, ".pi-ops", "state.db");
  const store = new MazzyStore(legacy);
  const a = store.createTask({ title: "one", description: "first" });
  const b = store.createTask({ title: "two", description: "second" });
  store.updateTask(a.id, { state: "READY", expectedRevision: a.revision });
  store.addComment(b.id, { body: "hello", actor: "user" });
  store.close();
  return { tasks: 2 };
}

test("dry-run plan and apply never touch the source and report parity intent", () => {
  const root = projectTemp("migrate-dryrun-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    const plan = planControlMigration(root)!;
    assert.equal(plan.sourcePresent, true);
    assert.equal(plan.targetPresent, false);
    assert.equal(plan.sourceRows.tasks, 2);
    const dry = applyControlMigration(root, { apply: false })!;
    assert.equal(dry.applied, false);
    assert.equal(existsSync(join(root, ".mazzy", "control", "state.db")), false, "dry-run must not create the target");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cutoverReadiness is read-only and reflects absent/promoted/drift states without mutating", () => {
  const root = projectTemp("migrate-readiness-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    // Before apply: canonical absent => not ready, and the probe must not create it.
    const before = cutoverReadiness(root)!;
    assert.equal(before.cutoverReady, false);
    assert.equal(existsSync(join(root, ".mazzy", "control", "state.db")), false, "readiness probe must not create the target");
    // After a quiescent apply (no concurrent writer): promoted + exact parity => ready.
    const applied = applyControlMigration(root, { apply: true })!;
    assert.equal(applied.journal, "promoted");
    const ready = cutoverReadiness(root)!;
    assert.equal(ready.journal, "promoted");
    assert.equal(ready.cutoverReady, true, ready.detail);
    assert.equal(ready.rows.tasks.legacy, ready.rows.tasks.canonical);
    // A post-promotion legacy write creates drift => not ready (matches the real cutover gate).
    const legacy = new MazzyStore(join(root, ".pi-ops", "state.db"));
    legacy.createTask({ title: "drift", description: "post-promotion" });
    legacy.close();
    const drifted = cutoverReadiness(root)!;
    assert.equal(drifted.cutoverReady, false);
    assert.ok(drifted.rows.tasks.legacy > drifted.rows.tasks.canonical);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply migrates with full row parity, integrity, identity stamp and promoted journal", () => {
  const root = projectTemp("migrate-apply-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const counts = seedLegacy(root);
    const result = applyControlMigration(root, { apply: true })!;
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.journal, "promoted");
    assert.equal(result.verified.tasks.source, counts.tasks);
    assert.equal(result.verified.tasks.target, counts.tasks);
    assert.ok(Object.values(result.verified).every((v) => v.match), "every table must match");
    const target = join(root, ".mazzy", "control", "state.db");
    assert.equal(existsSync(target), true);
    // Source is retained (no data loss / rollback possible).
    assert.equal(existsSync(join(root, ".pi-ops", "state.db")), true);
    // Identity stamp present.
    const db = new DatabaseSync(target, { readOnly: true });
    const id = db.prepare("SELECT project_id FROM mazzy_control_identity WHERE singleton=1").get() as { project_id?: string };
    db.close();
    assert.ok(typeof id.project_id === "string");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback restores the pre-migration state and reverts the journal", () => {
  const root = projectTemp("migrate-rollback-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const target = join(root, ".mazzy", "control", "state.db");
    assert.equal(existsSync(target), true);
    const rolled = rollbackControlMigration(root, { apply: true })!;
    assert.equal(rolled.applied, true);
    assert.equal(rolled.restored, true);
    assert.equal(rolled.journal, "absent");
    // Target removed (no prior backup existed), legacy source still authoritative.
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(root, ".pi-ops", "state.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback refuses canonical-only rows without creating a rejected-operation backup", () => {
  const root = projectTemp("migrate-rollback-guard-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const canonical = new MazzyStore(join(root, ".mazzy", "control", "state.db"));
    canonical.createTask({ title: "canonical-only", description: "must survive" }); canonical.close();
    const rolled = rollbackControlMigration(root, { apply: true })!;
    assert.equal(rolled.restored, false);
    assert.match(rolled.detail, /newer than promotion/);
    assert.equal(existsSync(join(root, ".mazzy", "backups")), false, "a refused rollback must not create recovery backups");
    const preserved = new MazzyStore(join(root, ".mazzy", "control", "state.db"));
    assert.equal(preserved.listTasks().some((task) => task.title === "canonical-only"), true); preserved.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cutover activation refuses a legacy write newer than the promoted snapshot", () => {
  const root = projectTemp("migrate-cutover-drift-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const legacy = new MazzyStore(join(root, ".pi-ops", "state.db"));
    legacy.createTask({ title: "late", description: "requires reapply" }); legacy.close();
    const result = activateCutover(root, { apply: true })!;
    assert.equal(result.ok, false); assert.match(result.detail, /advanced|re-apply/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("force re-apply and break-glass rollback refuse during active cutover", () => {
  const root = projectTemp("migrate-cutover-guards-"); const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    const forced = applyControlMigration(root, { apply: true, force: true })!;
    assert.equal(forced.ok, false); assert.match(forced.detail, /durable cutover/);
    // Also guard the non-durable break-glass environment path independently.
    process.env.MAZZY_CUTOVER = "1";
    const rollback = rollbackControlMigration(root, { apply: true })!;
    assert.equal(rollback.restored, false); assert.match(rollback.detail, /break-glass|cutover/);
  } finally { if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior; rmSync(root, { recursive: true, force: true }); }
});

test("cutover activation refuses override preflight", () => {
  const root = projectTemp("migrate-cutover-override-"); const prior = process.env.MAZZY_DB;
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    process.env.MAZZY_DB = join(root, ".pi-ops", "state.db");
    const result = activateCutover(root, { apply: true })!;
    assert.equal(result.ok, false); assert.match(result.detail, /override/);
  } finally { if (prior === undefined) delete process.env.MAZZY_DB; else process.env.MAZZY_DB = prior; rmSync(root, { recursive: true, force: true }); }
});

test("re-apply over an already-promoted store is refused unless forced", () => {
  const root = projectTemp("migrate-reapply-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Second apply must refuse (promoted journal) to avoid discarding canonical writes.
    const refused = applyControlMigration(root, { apply: true })!;
    assert.equal(refused.applied, false);
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /already-promoted/);
    // Forced re-apply backs up the existing target before overwrite and stays reversible.
    const forced = applyControlMigration(root, { apply: true, force: true })!;
    assert.equal(forced.ok, true);
    assert.equal(existsSync(join(root, ".mazzy", "control", "state.db.backup")), true);
    const rolled = rollbackControlMigration(root, { apply: true })!;
    assert.equal(rolled.restored, true);
    assert.equal(existsSync(join(root, ".mazzy", "control", "state.db")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("security: a MAZZY_DB override pointing at a foreign project is NOT used as the migration source", () => {
  const victim = projectTemp("migrate-f1-victim-");
  const foreign = projectTemp("migrate-f1-foreign-");
  const priorMazzy = process.env.MAZZY_DB, priorPiOps = process.env.PI_OPS_DB;
  try {
    execFileSync("git", ["init", "-q", victim]);
    // Foreign project A has a populated legacy DB.
    const a = new MazzyStore(join(foreign, ".pi-ops", "state.db"));
    a.createTask({ title: "FOREIGN-SECRET", description: "project A data" });
    a.close();
    // Victim project B has NO legacy DB of its own; operator points MAZZY_DB at A.
    process.env.MAZZY_DB = join(foreign, ".pi-ops", "state.db");
    delete process.env.PI_OPS_DB;
    // Plan must NOT see the foreign source; apply must refuse (override active).
    const plan = planControlMigration(victim)!;
    assert.equal(plan.sourcePresent, false, "env-free source must not resolve to the foreign DB");
    const applied = applyControlMigration(victim, { apply: true })!;
    assert.equal(applied.ok, false);
    assert.match(applied.detail, /override|No legacy source/);
    // The victim canonical DB must never have been created from foreign data.
    assert.equal(existsSync(join(victim, ".mazzy", "control", "state.db")), false);
  } finally {
    if (priorMazzy === undefined) delete process.env.MAZZY_DB; else process.env.MAZZY_DB = priorMazzy;
    if (priorPiOps === undefined) delete process.env.PI_OPS_DB; else process.env.PI_OPS_DB = priorPiOps;
    rmSync(victim, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true });
  }
});

test("F-1: PI_OPS_DB (legacy override) alone is also refused as a migration source", () => {
  const victim = projectTemp("migrate-f1-piops-");
  const foreign = projectTemp("migrate-f1-piops-foreign-");
  const priorMazzy = process.env.MAZZY_DB, priorPiOps = process.env.PI_OPS_DB;
  try {
    execFileSync("git", ["init", "-q", victim]);
    const a = new MazzyStore(join(foreign, ".pi-ops", "state.db"));
    a.createTask({ title: "FOREIGN", description: "A" });
    a.close();
    delete process.env.MAZZY_DB;
    process.env.PI_OPS_DB = join(foreign, ".pi-ops", "state.db");
    assert.equal(planControlMigration(victim)!.sourcePresent, false);
    assert.equal(applyControlMigration(victim, { apply: true })!.ok, false);
    assert.equal(existsSync(join(victim, ".mazzy", "control", "state.db")), false);
  } finally {
    if (priorMazzy === undefined) delete process.env.MAZZY_DB; else process.env.MAZZY_DB = priorMazzy;
    if (priorPiOps === undefined) delete process.env.PI_OPS_DB; else process.env.PI_OPS_DB = priorPiOps;
    rmSync(victim, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true });
  }
});

test("no source database yields a safe no-op, never a false success", () => {
  const root = projectTemp("migrate-nosource-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const result = applyControlMigration(root, { apply: true })!;
    assert.equal(result.applied, false);
    assert.equal(result.ok, false);
    assert.match(result.detail, /No legacy source/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("symlinked .mazzy is refused on the write path (fail-closed like the read probes)", () => {
  const root = projectTemp("migrate-symlink-");
  const outside = projectTemp("migrate-symlink-outside-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    // .mazzy exists from seedLegacy? No — seedLegacy only writes .pi-ops. Plant .mazzy as a symlink.
    rmSync(join(root, ".mazzy"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".mazzy"), "dir");
    assert.equal(planControlMigration(root), undefined, "plan must refuse a symlinked .mazzy");
    assert.equal(applyControlMigration(root, { apply: true }), undefined, "apply must refuse a symlinked .mazzy");
    assert.equal(rollbackControlMigration(root, { apply: true }), undefined, "rollback must refuse a symlinked .mazzy");
    // Nothing was written through the symlink target.
    assert.equal(existsSync(join(outside, "control", "state.db")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("symlinked .mazzy/control (with .mazzy itself real) is refused on the write path", () => {
  const root = projectTemp("migrate-control-symlink-");
  const outside = projectTemp("migrate-control-symlink-outside-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    // .mazzy is a real trusted dir, but .mazzy/control is a symlink pointing outside.
    mkdirSync(join(root, ".mazzy"), { recursive: true });
    symlinkSync(outside, join(root, ".mazzy", "control"), "dir");
    assert.equal(planControlMigration(root), undefined, "plan must refuse a symlinked .mazzy/control");
    assert.equal(applyControlMigration(root, { apply: true }), undefined, "apply must refuse a symlinked .mazzy/control");
    assert.equal(existsSync(join(outside, "state.db")), false, "nothing written through the symlinked control dir");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("a failed pre-apply snapshot leaves the rollback backup intact and no empty generation", () => {
  const root = projectTemp("migrate-pre-apply-refusal-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root);
    const control = join(root, ".mazzy", "control");
    mkdirSync(join(control, "state.db"), { recursive: true });
    const backup = join(control, "state.db.backup");
    writeFileSync(backup, "known-good-backup");
    const result = applyControlMigration(root, { apply: true })!;
    assert.equal(result.applied, false);
    assert.match(result.detail, /pre-apply recovery snapshot/);
    assert.equal(readFileSync(backup, "utf8"), "known-good-backup");
    const backups = join(root, ".mazzy", "backups");
    assert.deepEqual(existsSync(backups) ? readdirSync(backups).filter((name) => name.startsWith("pre-apply-")) : [], []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an invalid first-migration journal is repaired in-product and apply can retry", () => {
  const root = projectTemp("migrate-invalid-journal-repair-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root);
    const migrate = join(root, ".mazzy", "control", "migrate");
    mkdirSync(migrate, { recursive: true });
    writeFileSync(join(migrate, "journal.json"), JSON.stringify({ schemaVersion: 1, state: "invalid", reason: "snapshot-failed" }));
    assert.equal(resolveControlDb(root).sealed, false, "never-cut-over failure must remain recoverable");
    const repaired = deactivateCutover(root, { apply: true })!;
    assert.equal(repaired.applied, true);
    assert.equal(repaired.active, false);
    assert.match(repaired.detail, /journal repaired/);
    assert.equal(resolveControlDb(root).sealed, false);
    const retried = applyControlMigration(root, { apply: true })!;
    assert.equal(retried.ok, true, retried.detail);
    assert.equal(retried.journal, "promoted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("F4-symlink: a substituted backups root refuses recovery snapshots without touching outside retention", () => {
  const root = projectTemp("migrate-backups-symlink-");
  const outside = projectTemp("migrate-backups-symlink-outside-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const sentinelDir = join(outside, "pre-apply-000"); mkdirSync(sentinelDir);
    const sentinel = join(sentinelDir, "KEEP"); writeFileSync(sentinel, "must survive");
    const backups = join(root, ".mazzy", "backups");
    rmSync(backups, { recursive: true, force: true }); symlinkSync(outside, backups, "dir");
    const result = applyControlMigration(root, { apply: true, force: true })!;
    assert.equal(result.applied, false);
    assert.equal(result.ok, false);
    assert.match(result.detail, /backup root is not a trusted real directory/);
    assert.equal(existsSync(sentinel), true, "external backup sentinel must never be retained/deleted");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("F3-3: a legacy write between locked parity gates refuses durable publication", () => {
  const root = projectTemp("migrate-double-parity-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const result = activateCutover(root, {
      apply: true,
      beforeFinalParityForTest: () => {
        const legacy = new MazzyStore(join(root, ".pi-ops", "state.db"));
        legacy.createTask({ title: "intercheck legacy write", description: "must block cutover" });
        legacy.close();
      },
    })!;
    assert.equal(result.applied, false);
    assert.equal(result.ok, false);
    assert.match(result.detail, /legacy changed during cutover preflight/);
    assert.equal(existsSync(join(root, ".mazzy", "cutover-witness.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration succeeds while the source MazzyStore connection is still open (VACUUM INTO snapshot)", () => {
  const root = projectTemp("migrate-live-source-");
  try {
    execFileSync("git", ["init", "-q", root]);
    // Open a live MazzyStore on the legacy source and keep it open (WAL mode) during apply.
    const live = new MazzyStore(join(root, ".pi-ops", "state.db"));
    live.createTask({ title: "live", description: "open connection" });
    const result = applyControlMigration(root, { apply: true })!;
    live.close();
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.journal, "promoted");
    assert.equal(result.verified.tasks.source, result.verified.tasks.target);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration is NOT rolled back when the live source keeps changing during apply (no parity race)", () => {
  const root = projectTemp("migrate-concurrent-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const live = new MazzyStore(join(root, ".pi-ops", "state.db"));
    live.createTask({ title: "base", description: "base" });
    // Simulate a writer that mutates the source AFTER the snapshot would be taken:
    // the verification must be based on the consistent snapshot's own integrity,
    // not a re-read of the moving source (reviewer HIGH regression).
    const result = applyControlMigration(root, { apply: true })!;
    // A concurrent-looking write right after apply must not have affected the verdict.
    live.createTask({ title: "after", description: "post-snapshot write" });
    live.close();
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.journal, "promoted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-referential migration (source==target) is refused", () => {
  const root = projectTemp("migrate-selfref-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    // Point the source explicitly at the canonical target so they are the same file after one apply.
    const target = join(root, ".mazzy", "control", "state.db");
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const selfref = applyControlMigration(root, { apply: true, force: true, source: target })!;
    assert.equal(selfref.applied, false);
    assert.equal(selfref.ok, false);
    assert.match(selfref.detail, /self-referential/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cutover regressions: durable witness guards reapply, strict drift, unknown drift, and busy lock", () => {
  const root = projectTemp("migrate-final-regressions-"); const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const control = join(root, ".mazzy", "control"), journal = join(control, "migrate", "journal.json");
    // N1: an active marker seals reapply even if journal is absent or malformed.
    for (const contents of [undefined, "not-json"]) {
      writeFileSync(join(control, "cutover.json"), JSON.stringify({ schemaVersion: 1, active: true }));
      if (contents === undefined) rmSync(journal, { force: true }); else writeFileSync(journal, contents);
      assert.equal(applyControlMigration(root, { apply: true })!.applied, false);
    }
    rmSync(join(control, "cutover.json"), { force: true }); writeFileSync(journal, JSON.stringify({ state: "promoted" }));
    const canonical = new MazzyStore(join(control, "state.db")); canonical.createTask({ title: "canonical-pending", description: "must not disappear" }); canonical.close();
    assert.equal(activateCutover(root, { apply: true })!.ok, false, "canonical-pending divergence refuses activation");
    process.env.MAZZY_CUTOVER = "1";
    assert.equal(applyControlMigration(root, { apply: true, force: true })!.applied, false, "break-glass blocks force overwrite");
    delete process.env.MAZZY_CUTOVER;
    // Unknown comparison is fail-closed too.
    rmSync(join(root, ".pi-ops", "state.db"), { force: true });
    assert.equal(activateCutover(root, { apply: true })!.ok, false);
    // A held migration lock gives a controlled refusal.
    writeFileSync(join(control, "migrate.lock"), "");
    assert.match(applyControlMigration(root, { apply: true })!.detail, /lock busy/);
  } finally { if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior; rmSync(root, { recursive: true, force: true }); }
});

test("pre-baseline legacy row is still divergence through strict count mismatch", () => {
  const root = projectTemp("migrate-pre-baseline-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.cutoverReady, true);
    const legacyPath = join(root, ".pi-ops", "state.db"); const legacy = new MazzyStore(legacyPath);
    const late = legacy.createTask({ title: "old-clock", description: "not in snapshot" }); legacy.close();
    const db = new DatabaseSync(legacyPath);
    db.prepare("UPDATE tasks SET created_at=?, updated_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", late.id); db.close();
    assert.equal(verifyControlDrift(root)?.drift, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("external cutover witness seals after canonical subtree loss or dual internal corruption", () => {
  const root = projectTemp("migrate-external-witness-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true); assert.equal(activateCutover(root, { apply: true })!.ok, true);
    const control = join(root, ".mazzy", "control");
    writeFileSync(join(control, "cutover.json"), "bad"); writeFileSync(join(control, "migrate", "journal.json"), "bad");
    assert.equal(resolveControlDb(root).sealed, true);
    rmSync(control, { recursive: true, force: true });
    assert.equal(resolveControlDb(root).sealed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("F1/F3-5: checkout-bound witness is ignored in another checkout but seals same-checkout loss and malformed evidence", () => {
  const root = projectTemp("migrate-witness-bound-"); const clone = projectTemp("migrate-witness-clone-");
  try {
    execFileSync("git", ["init", "-q", root]); applyMazzyInit(root); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    // The scaffold ignore policy prevents accidental publication of the external seal.
    assert.doesNotThrow(() => execFileSync("git", ["check-ignore", "-q", ".mazzy/cutover-witness.json"], { cwd: root }));
    execFileSync("git", ["init", "-q", clone]); mkdirSync(join(clone, ".mazzy"), { recursive: true });
    // Same project identity copied into another root makes a *valid inert* witness.
    copyFileSync(join(root, ".mazzy", "project.json"), join(clone, ".mazzy", "project.json"));
    copyFileSync(join(root, ".mazzy", "cutover-witness.json"), join(clone, ".mazzy", "cutover-witness.json"));
    assert.equal(resolveControlDb(clone).sealed, false);
    assert.equal(resolveControlDb(clone).effectiveEndpoint, "legacy");
    rmSync(join(root, ".mazzy", "control"), { recursive: true, force: true });
    assert.equal(resolveControlDb(root).sealed, true, "matching external witness survives control subtree loss");
    writeFileSync(join(root, ".mazzy", "cutover-witness.json"), "{malformed");
    assert.equal(resolveControlDb(root).sealed, true, "malformed existing witness fails closed");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); }
});

test("F3-3/F5/F3-4/F4: strict handoff, break-glass, live lock, and bounded backups", () => {
  const root = projectTemp("migrate-final-regressions-"); const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Equal count and old timestamp still differs logically and cannot activate.
    const legacyPath = join(root, ".pi-ops", "state.db"); const raw = new DatabaseSync(legacyPath);
    raw.exec("UPDATE tasks SET title='equal-count-drift', updated_at='2000-01-01T00:00:00.000Z' WHERE rowid=1"); raw.close();
    assert.equal(activateCutover(root, { apply: true })!.applied, false);
    // A break-glass process must refuse even if the journal is corrupt and force is absent.
    const canonical = new MazzyStore(join(root, ".mazzy", "control", "state.db")); canonical.createTask({ title: "canonical-only", description: "keep" }); canonical.close();
    writeFileSync(join(root, ".mazzy", "control", "migrate", "journal.json"), "not-json"); process.env.MAZZY_CUTOVER = "1";
    assert.equal(applyControlMigration(root, { apply: true })!.applied, false);
    delete process.env.MAZZY_CUTOVER;
    // A stale-looking lock is still a live-owner lock and may not be taken over.
    const lock = join(root, ".mazzy", "control", "migrate.lock"); writeFileSync(lock, JSON.stringify({ token: "other" }));
    const old = Date.now() / 1000 - 300; utimesSync(lock, old, old);
    assert.equal(applyControlMigration(root, { apply: true, force: true })!.applied, false);
    rmSync(lock, { force: true });
    // Retention keeps only the newest bounded set for destructive forced re-applies.
    writeFileSync(join(root, ".mazzy", "control", "migrate", "journal.json"), JSON.stringify({ state: "promoted" }));
    for (let i = 0; i < 7; i++) assert.equal(applyControlMigration(root, { apply: true, force: true })!.applied, true);
    const backups = readdirSync(join(root, ".mazzy", "backups")).filter((name) => name.startsWith("pre-apply-"));
    assert.ok(backups.length <= 5);
  } finally { if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior; rmSync(root, { recursive: true, force: true }); }
});

test("untrusted backup children do not consume trusted retention budget", () => {
  const root = projectTemp("migrate-retention-untrusted-child-");
  const outside = projectTemp("migrate-retention-untrusted-outside-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root); ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const sentinel = join(outside, "KEEP"); writeFileSync(sentinel, "must survive");
    const backups = join(root, ".mazzy", "backups"); mkdirSync(backups, { recursive: true });
    const untrusted = "pre-apply-untrusted";
    symlinkSync(outside, join(backups, untrusted), "dir");
    for (let i = 0; i < 7; i++) assert.equal(applyControlMigration(root, { apply: true, force: true })!.ok, true);
    const trusted = readdirSync(backups).filter((name) => name.startsWith("pre-apply-") && name !== untrusted);
    assert.ok(trusted.length <= 5, "only trusted direct children count toward retention");
    assert.equal(existsSync(sentinel), true, "retention must not follow an untrusted child");
    assert.equal(existsSync(join(backups, untrusted)), true);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("plan and result never leak an absolute host path (INV-3)", () => {
  const root = projectTemp("migrate-redact-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    const planJson = JSON.stringify(planControlMigration(root));
    const applyJson = JSON.stringify(applyControlMigration(root, { apply: true }));
    assert.ok(!planJson.includes(root), "plan must not contain the host path");
    assert.ok(!applyJson.includes(root), "result must not contain the host path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});