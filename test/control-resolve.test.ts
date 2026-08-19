// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testScratchRoot } from "./git-root.ts";
import { MazzyStore } from "../src/store.ts";
import { ensureProjectIdentity } from "../src/project.ts";
import { activateCutover, applyControlMigration, deactivateCutover } from "../src/control-migrate.ts";
import { resolveControlDb } from "../src/control-resolve.ts";

function projectTemp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }
/** Seed a legacy store and enroll a project identity so the canonical stamp can match. */
function seedLegacy(root: string, enroll = false): void {
  const store = new MazzyStore(join(root, ".pi-ops", "state.db"));
  store.createTask({ title: "seed", description: "seed" });
  store.close();
  if (enroll) ensureProjectIdentity(root);
}
const legacyPath = (root: string) => join(root, ".pi-ops", "state.db");
const canonicalPath = (root: string) => join(root, ".mazzy", "control", "state.db");

test("un-migrated project resolves to legacy (git-root-legacy), never canonical", () => {
  const root = projectTemp("resolve-legacy-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    const r = resolveControlDb(root);
    assert.equal(r.path, legacyPath(root));
    assert.equal(r.selection, "git-root-legacy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-git folder resolves to cwd-fallback legacy", () => {
  // Outside any git repo so resolveTrustedProjectRoot returns undefined.
  const root = mkdtempSync(join(tmpdir(), "resolve-cwd-"));
  try {
    const r = resolveControlDb(root);
    assert.equal(r.selection, "cwd-fallback");
    assert.equal(r.path, join(root, ".pi-ops", "state.db"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a verified promotion is observation-only by default and reconnects only under MAZZY_CUTOVER=1", () => {
  const root = projectTemp("resolve-promoted-");
  const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Default: selection reports canonical-promoted, but the PATH stays legacy (no split-brain).
    delete process.env.MAZZY_CUTOVER;
    const off = resolveControlDb(root);
    assert.equal(off.selection, "canonical-promoted");
    assert.equal(off.path, legacyPath(root));
    // Opt-in: the resolver reconnects onto the canonical store.
    process.env.MAZZY_CUTOVER = "1";
    const on = resolveControlDb(root);
    assert.equal(on.selection, "canonical-promoted");
    assert.equal(on.path, canonicalPath(root));
  } finally {
    if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable cutover selects canonical without environment and deactivation returns legacy", () => {
  const root = projectTemp("resolve-durable-cutover-");
  const prior = process.env.MAZZY_CUTOVER;
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    delete process.env.MAZZY_CUTOVER;
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    const active = resolveControlDb(root);
    assert.equal(active.path, canonicalPath(root));
    assert.equal(active.cutover, true);
    assert.equal(active.effectiveEndpoint, "canonical");
    assert.equal(deactivateCutover(root, { apply: true })!.ok, true);
    const inactive = resolveControlDb(root);
    assert.equal(inactive.path, legacyPath(root));
    assert.equal(inactive.cutover, false);
    assert.equal(inactive.effectiveEndpoint, "legacy");
  } finally {
    if (prior === undefined) delete process.env.MAZZY_CUTOVER; else process.env.MAZZY_CUTOVER = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("all activate/deactivate partial publication permutations resolve canonical or sealed", () => {
  const root = projectTemp("resolve-partial-cutover-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    const journal = join(root, ".mazzy", "control", "migrate", "journal.json");
    const marker = join(root, ".mazzy", "control", "cutover.json");
    const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value)}\n`);
    const cases: Array<{ journal: "promoted" | "cutover"; marker: boolean }> = [
      { journal: "promoted", marker: true }, // activation: marker published first
      { journal: "cutover", marker: false }, // activation: journal published first/marker lost
      { journal: "promoted", marker: true }, // deactivation: journal published first
      { journal: "cutover", marker: false }, // deactivation: marker removed first
    ];
    for (const partial of cases) {
      write(journal, { schemaVersion: 1, state: partial.journal });
      if (partial.marker) write(marker, { schemaVersion: 1, active: true }); else rmSync(marker, { force: true });
      const result = resolveControlDb(root);
      assert.ok(result.effectiveEndpoint === "canonical" || result.sealed, "partial cutover must not reopen unsealed legacy");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active cutover seals legacy fallback when canonical identity is corrupted", () => {
  const root = projectTemp("resolve-sealed-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    writeFileSync(join(root, ".mazzy", "project.json"), JSON.stringify({ schemaVersion: 1, projectId: "00000000-0000-4000-8000-000000000000", createdAt: "2026-01-01T00:00:00.000Z" }));
    const resolution = resolveControlDb(root);
    assert.equal(resolution.sealed, true);
    assert.equal(resolution.effectiveEndpoint, "legacy");
    assert.equal(resolution.path, legacyPath(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a never-cut-over invalid journal holds back to unsealed legacy", () => {
  const root = projectTemp("resolve-invalid-never-cut-over-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    const migrate = join(root, ".mazzy", "control", "migrate");
    mkdirSync(migrate, { recursive: true });
    writeFileSync(join(migrate, "journal.json"), "{malformed");
    const result = resolveControlDb(root);
    assert.equal(result.sealed, false);
    assert.equal(result.selection, "canonical-held");
    assert.equal(result.hold, "invalid-journal");
    assert.equal(result.path, legacyPath(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a partial/invalid journal holds back to legacy (canonical-held)", () => {
  const root = projectTemp("resolve-held-journal-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    // Create a canonical target + a non-promoted journal by hand.
    const migrate = join(root, ".mazzy", "control", "migrate");
    mkdirSync(migrate, { recursive: true });
    writeFileSync(canonicalPath(root), "");
    writeFileSync(join(migrate, "journal.json"), JSON.stringify({ schemaVersion: 1, state: "promoting" }));
    const r = resolveControlDb(root);
    assert.equal(r.selection, "canonical-held");
    assert.equal(r.hold, "invalid-journal");
    assert.equal(r.path, legacyPath(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a promoted journal with mismatched identity holds back to legacy", () => {
  const root = projectTemp("resolve-held-identity-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Corrupt the identity by pointing project.json at a different projectId.
    writeFileSync(join(root, ".mazzy", "project.json"), JSON.stringify({ schemaVersion: 1, projectId: "00000000-0000-4000-8000-000000000000", createdAt: "2026-01-01T00:00:00.000Z" }));
    const r = resolveControlDb(root);
    assert.equal(r.selection, "canonical-held");
    assert.equal(r.hold, "identity");
    assert.equal(r.path, legacyPath(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("durable cutover seals a substituted control symlink and an explicit override", () => {
  const root = projectTemp("resolve-cutover-symlink-"); const outside = projectTemp("resolve-cutover-outside-");
  const prior = process.env.MAZZY_DB;
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    process.env.MAZZY_DB = join(root, ".pi-ops", "state.db");
    const override = resolveControlDb(root);
    assert.equal(override.sealed, true); assert.equal(override.cutover, true);
    delete process.env.MAZZY_DB;
    rmSync(join(root, ".mazzy", "control"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".mazzy", "control"), "dir");
    const damaged = resolveControlDb(root);
    assert.equal(damaged.sealed, true);
    assert.equal(damaged.effectiveEndpoint, "legacy");
  } finally { if (prior === undefined) delete process.env.MAZZY_DB; else process.env.MAZZY_DB = prior; rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("a symlinked .mazzy can never select canonical", () => {
  const root = projectTemp("resolve-symlink-");
  const outside = projectTemp("resolve-symlink-outside-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    symlinkSync(outside, join(root, ".mazzy"), "dir");
    const r = resolveControlDb(root);
    assert.equal(r.path, legacyPath(root));
    assert.equal(r.selection, "git-root-legacy");
    assert.equal(r.sealed, false);
    assert.notEqual(r.selection, "canonical-promoted");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("a never-migrated non-directory control path remains an unsealed legacy fallback", () => {
  const root = projectTemp("resolve-control-file-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root);
    mkdirSync(join(root, ".mazzy"), { recursive: true });
    writeFileSync(join(root, ".mazzy", "control"), "not-a-directory");
    const result = resolveControlDb(root);
    assert.equal(result.sealed, false);
    assert.equal(result.selection, "git-root-legacy");
    assert.equal(result.effectiveEndpoint, "legacy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an active witness keeps a symlinked .mazzy sealed", () => {
  const root = projectTemp("resolve-active-mazzy-symlink-");
  const outside = projectTemp("resolve-active-mazzy-symlink-outside-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    const relocated = join(outside, "relocated-mazzy");
    renameSync(join(root, ".mazzy"), relocated);
    symlinkSync(relocated, join(root, ".mazzy"), "dir");
    const result = resolveControlDb(root);
    assert.equal(result.sealed, true);
    assert.equal(result.hold, "untrusted");
    assert.equal(result.effectiveEndpoint, "legacy");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("F3-5: malformed witness or marker seals a healthy promoted canonical instead of activating it", () => {
  const root = projectTemp("resolve-f35-malformed-");
  const outside = projectTemp("resolve-f35-outside-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    // Canonical remains a valid promoted snapshot while legacy advances.
    const late = new MazzyStore(legacyPath(root)); late.createTask({ title: "legacy ahead", description: "must not activate canonical" }); late.close();
    const malformed = [
      { name: "garbage", make: (path: string) => writeFileSync(path, "{not-json") },
      { name: "wrong-schema", make: (path: string) => writeFileSync(path, JSON.stringify({ schemaVersion: 2, active: true, projectId: "x", rootFsDigest: "x" })) },
      { name: "inactive", make: (path: string) => writeFileSync(path, JSON.stringify({ schemaVersion: 1, active: false, projectId: "x", rootFsDigest: "x" })) },
      { name: "missing-fields", make: (path: string) => writeFileSync(path, JSON.stringify({ schemaVersion: 1, active: true })) },
      { name: "empty", make: (path: string) => writeFileSync(path, "") },
      { name: "directory", make: (path: string) => mkdirSync(path) },
      { name: "symlink", make: (path: string) => symlinkSync(join(outside, "evidence"), path) },
    ];
    writeFileSync(join(outside, "evidence"), "outside sentinel");
    for (const evidence of ["cutover-witness.json", join("control", "cutover.json")]) {
      const path = join(root, ".mazzy", evidence);
      for (const shape of malformed) {
        rmSync(path, { recursive: true, force: true });
        shape.make(path);
        const result = resolveControlDb(root);
        assert.equal(result.sealed, true, `${evidence}/${shape.name}`);
        assert.equal(result.hold, "untrusted", `${evidence}/${shape.name}`);
        assert.equal(result.effectiveEndpoint, "legacy", `${evidence}/${shape.name}`);
        assert.equal(result.path, legacyPath(root), `${evidence}/${shape.name}`);
        assert.notEqual(result.path, canonicalPath(root), `${evidence}/${shape.name}`);
      }
      rmSync(path, { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("damaged durable evidence preserves an active override in diagnostics while sealed", () => {
  const root = projectTemp("resolve-damaged-override-"); const prior = process.env.MAZZY_DB;
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    process.env.MAZZY_DB = legacyPath(root);
    writeFileSync(join(root, ".mazzy", "cutover-witness.json"), "{malformed");
    const result = resolveControlDb(root);
    assert.equal(result.selection, "explicit-override");
    assert.equal(result.effectiveEndpoint, "override");
    assert.equal(result.sealed, true);
    assert.equal(result.hold, "untrusted");
  } finally { if (prior === undefined) delete process.env.MAZZY_DB; else process.env.MAZZY_DB = prior; rmSync(root, { recursive: true, force: true }); }
});

test("F2 regression: each affirmative durable fault point still activates canonical", () => {
  for (const activePoint of ["witness", "marker", "journal"] as const) {
    const root = projectTemp(`resolve-f2-${activePoint}-`);
    try {
      execFileSync("git", ["init", "-q", root]); seedLegacy(root, true);
      assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
      assert.equal(activateCutover(root, { apply: true })!.ok, true);
      const control = join(root, ".mazzy", "control");
      if (activePoint !== "witness") rmSync(join(root, ".mazzy", "cutover-witness.json"), { force: true });
      if (activePoint !== "marker") rmSync(join(control, "cutover.json"), { force: true });
      if (activePoint !== "journal") writeFileSync(join(control, "migrate", "journal.json"), JSON.stringify({ schemaVersion: 1, state: "promoted" }));
      const result = resolveControlDb(root);
      assert.equal(result.path, canonicalPath(root), activePoint);
      assert.equal(result.effectiveEndpoint, "canonical", activePoint);
      assert.equal(result.sealed, false, activePoint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("sol4 regression: active external witness plus missing control subtree remains sealed", () => {
  const root = projectTemp("resolve-sol4-");
  try {
    execFileSync("git", ["init", "-q", root]); seedLegacy(root, true);
    assert.equal(applyControlMigration(root, { apply: true })!.ok, true);
    assert.equal(activateCutover(root, { apply: true })!.ok, true);
    rmSync(join(root, ".mazzy", "control"), { recursive: true, force: true });
    const result = resolveControlDb(root);
    assert.equal(result.sealed, true);
    assert.equal(result.effectiveEndpoint, "legacy");
    assert.equal(result.path, legacyPath(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolution never leaks a host path in its diagnostic surface (INV-3)", () => {
  const root = projectTemp("resolve-redact-");
  try {
    execFileSync("git", ["init", "-q", root]);
    seedLegacy(root);
    const r = resolveControlDb(root);
    // The path field is used only to open the store; the selection/hold enums are the
    // diagnostic surface and must be plain enums (no host path).
    assert.match(r.selection, /^(explicit-override|canonical-promoted|canonical-held|git-root-legacy|cwd-fallback)$/);
    if (r.hold) assert.match(r.hold, /^(invalid-journal|identity|target-absent|untrusted)$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});