// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testScratchRoot } from "./git-root.ts";
import { MazzyStore } from "../src/store.ts";
import { ensureProjectIdentity } from "../src/project.ts";
import { activateCutover, applyControlMigration, verifyControlDrift } from "../src/control-migrate.ts";
import { resolveControlDb } from "../src/control-resolve.ts";
import { inspectSingleMechanism, singleMechanismGate, orchestrationGate } from "../src/anti-tunnel.ts";

function projectTemp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }
function makeStore(root: string, ...segments: string[]): void {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.db"), "");
}

test("after a verified promotion under cutover, retained legacy is NOT a tunnel and the gate proceeds", () => {
  const root = projectTemp("anti-tunnel-promoted-");
  const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]);
    const store = new MazzyStore(join(root, ".pi-ops", "state.db"));
    store.createTask({ title: "seed", description: "seed" });
    store.close();
    ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    process.env.MAZZY_CUTOVER = "1";
    const report = inspectSingleMechanism(root);
    // Canonical is .mazzy/control; the retained .pi-ops must be flagged retained, not a tunnel.
    assert.equal(report.status, "UNIFIED");
    assert.equal(report.tunnelCount, 0);
    assert.equal(report.candidates.some((c) => c.retained), true);
    assert.equal(orchestrationGate(root).directive, "proceed");
  } finally {
    if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoted with cutover OFF (default) is still UNIFIED — pending canonical is not a tunnel", () => {
  const root = projectTemp("anti-tunnel-pending-");
  const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]);
    const store = new MazzyStore(join(root, ".pi-ops", "state.db"));
    store.createTask({ title: "seed", description: "seed" });
    store.close();
    ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Default (cutover unset): resolver selects legacy, but the promoted .mazzy/control
    // store on disk must NOT be counted as a tunnel (regression: a prior regression).
    delete process.env.MAZZY_CUTOVER;
    const report = inspectSingleMechanism(root);
    assert.equal(report.status, "UNIFIED");
    assert.equal(report.tunnelCount, 0);
    assert.equal(orchestrationGate(root).directive, "proceed");
  } finally {
    if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes to the effective endpoint are normal; only pending endpoint writes are drift", () => {
  const root = projectTemp("anti-tunnel-drift-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const store = new MazzyStore(join(root, ".pi-ops", "state.db"));
    store.createTask({ title: "seed", description: "seed" }); store.close();
    ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Pending promotion selects legacy: a legacy write is normal.
    const later = new MazzyStore(join(root, ".pi-ops", "state.db"));
    later.createTask({ title: "legacy-active", description: "normal" }); later.close();
    assert.equal(verifyControlDrift(root, "legacy")!.drift, false);
    assert.equal(orchestrationGate(root).directive, "proceed");
    // A write to the non-selected pending canonical endpoint is drift.
    const pending = new MazzyStore(join(root, ".mazzy", "control", "state.db"));
    pending.createTask({ title: "canonical-pending", description: "drift" }); pending.close();
    assert.equal(verifyControlDrift(root, "legacy")!.drift, true);
    assert.equal(orchestrationGate(root).directive, "redirect-consolidation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("post-cutover canonical writes remain unified and delegation proceeds", () => {
  const root = projectTemp("anti-tunnel-cutover-active-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const legacy = new MazzyStore(join(root, ".pi-ops", "state.db"));
    legacy.createTask({ title: "seed", description: "seed" }); legacy.close();
    ensureProjectIdentity(root);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    const active = resolveControlDb(root);
    assert.equal(active.effectiveEndpoint, "canonical");
    const canonical = new MazzyStore(active.path);
    canonical.createTask({ title: "canonical-active", description: "normal" }); canonical.close();
    assert.equal(inspectSingleMechanism(root).status, "UNIFIED");
    assert.equal(orchestrationGate(root).directive, "proceed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("single mechanism is UNIFIED when only the canonical store exists", () => {
  const dir = projectTemp("anti-tunnel-unified-");
  try {
    execFileSync("git", ["init", "-q", dir]);
    makeStore(dir, ".pi-ops");
    const report = inspectSingleMechanism(dir);
    assert.equal(report.status, "UNIFIED");
    assert.equal(report.unified, true);
    assert.equal(report.tunnelCount, 0);
    assert.equal(report.candidates.filter((c) => c.canonical).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("divergent nested store is detected as a tunnel and blocks the gate", () => {
  const dir = projectTemp("anti-tunnel-split-");
  try {
    execFileSync("git", ["init", "-q", dir]);
    makeStore(dir, ".pi-ops");              // canonical (git-root)
    makeStore(dir, "sub", "pkg", ".pi-ops"); // divergent tunnel
    const { pass, report } = singleMechanismGate(dir);
    assert.equal(pass, false);
    assert.equal(report.status, "TUNNELS_DETECTED");
    assert.equal(report.tunnelCount, 1);
    const tunnels = report.candidates.filter((c) => !c.canonical);
    assert.equal(tunnels.length, 1);
    assert.ok(tunnels[0].depth >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("report never leaks an absolute host path (INV-3)", () => {
  const dir = projectTemp("anti-tunnel-redact-");
  try {
    execFileSync("git", ["init", "-q", dir]);
    makeStore(dir, ".pi-ops");
    makeStore(dir, "nested", ".mazzy", "control");
    const serialized = JSON.stringify(inspectSingleMechanism(dir));
    assert.ok(!serialized.includes(dir), "serialized report must not contain the host path");
    assert.ok(!serialized.includes("/tmp"), "serialized report must not contain filesystem prefixes");
    for (const candidate of inspectSingleMechanism(dir).candidates) {
      assert.match(candidate.relDigest, /^[0-9a-f]{16}$/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("untrusted root (no git) yields UNRESOLVED and never passes the gate", () => {
  // Deliberately outside any Git repository so resolveTrustedProjectRoot returns undefined.
  const dir = mkdtempSync(join(tmpdir(), "anti-tunnel-unresolved-"));
  try {
    const { pass, report } = singleMechanismGate(dir);
    assert.equal(report.status, "UNRESOLVED");
    assert.equal(pass, false);
    assert.equal(report.canonicalDigest, null);
    assert.deepEqual(report.candidates, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canonical store is always represented even before it is created", () => {
  const dir = projectTemp("anti-tunnel-precreate-");
  try {
    execFileSync("git", ["init", "-q", dir]);
    const report = inspectSingleMechanism(dir);
    assert.equal(report.candidates.some((c) => c.canonical), true);
    assert.equal(report.status, "UNIFIED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});