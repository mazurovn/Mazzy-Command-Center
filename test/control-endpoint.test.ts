// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { testScratchRoot } from "./git-root.ts";
import { MazzyStore } from "../src/store.ts";
import { ensureProjectIdentity } from "../src/project.ts";
import { applyControlMigration, rollbackControlMigration } from "../src/control-migrate.ts";
import { resolveControlDb } from "../src/control-resolve.ts";
import { orchestrationGate } from "../src/anti-tunnel.ts";
import { readJournal, hasDurableCutoverWitness } from "../src/control-endpoint.ts";
import { activateCutover } from "../src/control-migrate.ts";

function projectTemp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }
function seedPromoted(root: string): void {
  const s = new MazzyStore(join(root, ".pi-ops", "state.db"));
  s.createTask({ title: "t", description: "d" });
  s.close();
  ensureProjectIdentity(root);
  assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
}

test("shared journal codec recognises absent/rolled-back/promoted (not everything as invalid)", () => {
  const root = projectTemp("ce-codec-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedPromoted(root);
    const journal = join(root, ".mazzy", "control", "migrate", "journal.json");
    assert.equal(readJournal(journal), "promoted");
    rollbackControlMigration(root, { apply: true });
    // The rolled-back breadcrumb must decode faithfully, NOT as "invalid".
    assert.equal(readJournal(journal), "rolled-back");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hasDurableCutoverWitness reflects the external witness before and after activation", () => {
  const root = projectTemp("ce-witness-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedPromoted(root);
    // Promoted but not cut over: no durable witness yet.
    assert.equal(hasDurableCutoverWitness(root), false);
    const cut = activateCutover(root, { apply: true })!;
    assert.equal(cut.ok, true, cut.detail);
    // After activation the external witness exists and is recognised as active.
    assert.equal(hasDurableCutoverWitness(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("REGRESSION C-2: a successful rollback no longer wedges the orchestration gate", () => {
  const root = projectTemp("ce-rollback-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedPromoted(root);
    const rb = rollbackControlMigration(root, { apply: true })!;
    assert.equal(rb.restored, true);
    const r = resolveControlDb(root);
    // Must resolve as plain legacy (not canonical-held/invalid-journal), gate proceeds.
    assert.equal(r.selection, "git-root-legacy");
    assert.equal(r.hold, undefined);
    assert.equal(orchestrationGate(root).directive, "proceed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("F8 ENFORCEMENT: a cp -r copied checkout is held as duplicate-identity, never selected", () => {
  const root = projectTemp("ce-f8-"); const copy = projectTemp("ce-f8-copy-");
  const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]);
    seedPromoted(root);
    // cp -r the whole enrolled+promoted project (duplicates project.json + .mazzy/control).
    rmSync(copy, { recursive: true, force: true });
    cpSync(root, copy, { recursive: true });
    execFileSync("git", ["init", "-q", copy]);
    process.env.MAZZY_CUTOVER = "1";
    // The ORIGINAL still resolves canonical (its fs-digest matches its own inode).
    assert.equal(resolveControlDb(root).selection, "canonical-promoted");
    // The COPY is held: same projectId, different root inode => fs-mismatch.
    const rc = resolveControlDb(copy);
    assert.equal(rc.selection, "canonical-held");
    assert.equal(rc.hold, "duplicate-identity");
    assert.ok(rc.path.endsWith("/.pi-ops/state.db"));
  } finally {
    if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior;
    rmSync(root, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true });
  }
});

test("GREP-GUARD: journal decoder, sameFile, and the table inventory are single-sourced", () => {
  const srcDir = join(import.meta.dirname, "..", "src");
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "control-endpoint.ts");
  const read = (f: string) => readFileSync(join(srcDir, f), "utf8");
  // No other module may re-implement the journal FSM decoder...
  const decoder = /value\.state === "prepared" \|\| value\.state === "verified"/;
  assert.deepEqual(files.filter((f) => decoder.test(read(f))), [], "journal decoder must live only in control-endpoint.ts");
  // ...nor define its own sameFile...
  const sameFileDef = /function sameFile\(/;
  assert.deepEqual(files.filter((f) => sameFileDef.test(read(f))), [], "sameFile must live only in control-endpoint.ts");
  // ...nor hardcode the full control-table inventory literal.
  const tableLiteral = /"tasks", "events", "evidence", "run_bindings"/;
  assert.deepEqual(files.filter((f) => tableLiteral.test(read(f))), [], "CONTROL_TABLES must live only in control-endpoint.ts");
});

test("F8: a promoted store with NO fs-digest (pre-fix stamp) is held, not auto-selected under cutover", () => {
  const root = projectTemp("ce-fsabsent-");
  const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]);
    seedPromoted(root);
    // Simulate a pre-fix promotion by blanking the stamped root_fs_digest.
    const target = join(root, ".mazzy", "control", "state.db");
    const db = new DatabaseSync(target);
    db.exec("UPDATE mazzy_control_identity SET root_fs_digest='' WHERE singleton=1");
    db.close();
    process.env.MAZZY_CUTOVER = "1";
    const r = resolveControlDb(root);
    assert.equal(r.selection, "canonical-held", "an unstamped store must not be auto-selected");
    assert.ok(r.path.endsWith("/.pi-ops/state.db"));
  } finally {
    if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior;
    rmSync(root, { recursive: true, force: true });
  }
});