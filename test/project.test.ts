// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { linkSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import {
  ensureProjectIdentity, openProjectIdentity, readProjectIdentity,
  resolveLegacyOpsDbPath, resolveOpsDbPath, resolveOpsDbPathDiagnostic,
} from "../src/project.ts";

const scratchRoot = testScratchRoot;
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }

test("synthetic nested folders retain legacy Git-root DB resolution and source-only diagnostics", () => {
  const root = projectTemp("pi-ops-project-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const nestedA = join(root, "packages", "one"), nestedB = join(root, "packages", "two");
    mkdirSync(nestedA, { recursive: true }); mkdirSync(nestedB, { recursive: true });
    const atRoot = resolveOpsDbPath(root, undefined);
    assert.equal(atRoot, join(root, ".pi-ops", "state.db"));
    assert.equal(resolveOpsDbPath(nestedA, undefined), atRoot);
    assert.equal(resolveOpsDbPath(nestedB, undefined), atRoot);
    assert.deepEqual(resolveOpsDbPathDiagnostic(nestedA, undefined), { source: "git-root-legacy" });
    assert.deepEqual(Object.keys(resolveOpsDbPathDiagnostic(nestedA, undefined)), ["source"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveLegacyOpsDbPath equals resolveOpsDbPath today and stays git-root-legacy (decoupling seam)", () => {
  const root = projectTemp("pi-ops-legacy-seam-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const nested = join(root, "packages", "pkg"); mkdirSync(nested, { recursive: true });
    // The explicit legacy seam must resolve identically to the general resolver today,
    // so re-pointing migration source / probe legacy field is a zero-behaviour-change refactor.
    assert.equal(resolveLegacyOpsDbPath(root, undefined), resolveOpsDbPath(root, undefined));
    assert.equal(resolveLegacyOpsDbPath(nested, undefined), join(root, ".pi-ops", "state.db"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("synthetic unrelated Git roots retain distinct legacy DB paths", () => {
  const first = projectTemp("pi-ops-first-"), second = projectTemp("pi-ops-second-");
  try {
    execFileSync("git", ["init", "-q", first]); execFileSync("git", ["init", "-q", second]);
    assert.notEqual(resolveOpsDbPath(first, undefined), resolveOpsDbPath(second, undefined));
    assert.deepEqual(resolveOpsDbPathDiagnostic(first, undefined), { source: "git-root-legacy" });
    assert.deepEqual(resolveOpsDbPathDiagnostic(second, undefined), { source: "git-root-legacy" });
  } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); }
});

test("project enrollment creates stable opaque identities and wrong-project opens fail closed", () => {
  const first = projectTemp("mazzy-identity-first-"), second = projectTemp("mazzy-identity-second-");
  try {
    execFileSync("git", ["init", "-q", first]); execFileSync("git", ["init", "-q", second]);
    const firstIdentity = ensureProjectIdentity(first), replay = ensureProjectIdentity(join(first, ".mazzy"));
    const secondIdentity = ensureProjectIdentity(second);
    assert.equal(replay.descriptor.projectId, firstIdentity.descriptor.projectId);
    assert.notEqual(secondIdentity.descriptor.projectId, firstIdentity.descriptor.projectId);
    assert.equal(openProjectIdentity(first, firstIdentity.descriptor.projectId).descriptor.projectId, firstIdentity.descriptor.projectId);
    assert.throws(() => openProjectIdentity(second, firstIdentity.descriptor.projectId), /identity mismatch/);
    assert.deepEqual(Object.keys(firstIdentity.descriptor).sort(), ["createdAt", "projectId", "schemaVersion"]);
    assert.equal(JSON.stringify(firstIdentity.descriptor).includes(first), false);
  } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); }
});

test("Git worktrees enroll independent checkout identities", () => {
  const root = projectTemp("mazzy-identity-main-"); const worktree = `${root}-linked`;
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Mazzy Test"]);
    writeFileSync(join(root, "README.md"), "identity fixture\n");
    execFileSync("git", ["-C", root, "add", "README.md"]); execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const main = ensureProjectIdentity(root).descriptor.projectId;
    execFileSync("git", ["-C", root, "worktree", "add", "-qb", "identity-linked", worktree]);
    const linked = ensureProjectIdentity(worktree).descriptor.projectId;
    assert.notEqual(linked, main);
  } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent project enrollment publishes exactly one identity without temp debris", async () => {
  const root = projectTemp("mazzy-identity-race-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const moduleUrl = new URL("../src/project.ts", import.meta.url).href;
    const script = `import { ensureProjectIdentity } from ${JSON.stringify(moduleUrl)}; console.log(ensureProjectIdentity(process.argv[1]).descriptor.projectId);`;
    const ids = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    })));
    assert.equal(new Set(ids).size, 1);
    assert.equal(readdirSync(join(root, ".mazzy")).some((name) => name.startsWith(".project.")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project identity rejects malformed descriptors and symlink substitution", () => {
  const malformed = projectTemp("mazzy-identity-malformed-"), linked = projectTemp("mazzy-identity-linked-"), linkedDirectory = projectTemp("mazzy-identity-linked-directory-");
  try {
    execFileSync("git", ["init", "-q", malformed]); execFileSync("git", ["init", "-q", linked]);
    mkdirSync(join(malformed, ".mazzy"));
    writeFileSync(join(malformed, ".mazzy", "project.json"), '{"schemaVersion":1,"projectId":"not-a-uuid","createdAt":"now"}\n');
    assert.throws(() => readProjectIdentity(malformed), /Invalid Mazzy project identity/);
    const externalHardlink = join(malformed, "external-identity.json");
    writeFileSync(externalHardlink, '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000000","createdAt":"2026-01-01T00:00:00.000Z"}\n');
    rmSync(join(malformed, ".mazzy", "project.json")); linkSync(externalHardlink, join(malformed, ".mazzy", "project.json"));
    assert.throws(() => readProjectIdentity(malformed), /Invalid Mazzy project identity/);
    rmSync(join(malformed, ".mazzy", "project.json"));
    writeFileSync(join(malformed, ".mazzy", "project.json"), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000000","createdAt":"2026-01-01T00:00:00.000Z","path":"/secret"}\n');
    assert.throws(() => readProjectIdentity(malformed), /Invalid Mazzy project identity/);
    const outside = join(linked, "outside.json");
    writeFileSync(outside, '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000000","createdAt":"2026-01-01T00:00:00.000Z"}\n');
    mkdirSync(join(linked, ".mazzy")); symlinkSync(outside, join(linked, ".mazzy", "project.json"));
    assert.throws(() => readProjectIdentity(linked), /regular file/);
    execFileSync("git", ["init", "-q", linkedDirectory]);
    const externalDirectory = join(linkedDirectory, "external"); mkdirSync(externalDirectory);
    writeFileSync(join(externalDirectory, "project.json"), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000000","createdAt":"2026-01-01T00:00:00.000Z"}\n');
    symlinkSync(externalDirectory, join(linkedDirectory, ".mazzy"));
    assert.throws(() => readProjectIdentity(linkedDirectory), /real directory/);
    assert.throws(() => ensureProjectIdentity(linkedDirectory), /real directory/);
    assert.throws(() => openProjectIdentity(malformed, "invalid"), /Invalid expected project identity/);
  } finally { rmSync(malformed, { recursive: true, force: true }); rmSync(linked, { recursive: true, force: true }); rmSync(linkedDirectory, { recursive: true, force: true }); }
});

test("override collisions and unavailable-Git fallback retain existing resolution behavior", () => {
  const first = projectTemp("pi-ops-override-first-"), second = projectTemp("pi-ops-override-second-"), shared = join(scratchRoot, "shared-override.db"), fallback = projectTemp("pi-ops-fallback-");
  try {
    execFileSync("git", ["init", "-q", first]); execFileSync("git", ["init", "-q", second]);
    assert.equal(resolveOpsDbPath(first, shared), resolveOpsDbPath(second, shared));
    assert.deepEqual(resolveOpsDbPathDiagnostic(first, shared), { source: "explicit-override" });
    assert.deepEqual(resolveOpsDbPathDiagnostic(second, shared), { source: "explicit-override" });
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      assert.equal(resolveOpsDbPath(fallback, undefined), join(fallback, ".pi-ops", "state.db"));
      assert.deepEqual(resolveOpsDbPathDiagnostic(fallback, undefined), { source: "cwd-fallback" });
    } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
  } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); rmSync(fallback, { recursive: true, force: true }); }
});

test("two enrolled folders get distinct opaque identities and distinct isolated DBs", () => {
  const first = projectTemp("iso-first-"), second = projectTemp("iso-second-");
  try {
    execFileSync("git", ["init", "-q", first]); execFileSync("git", ["init", "-q", second]);
    const idA = ensureProjectIdentity(first).descriptor.projectId, idB = ensureProjectIdentity(second).descriptor.projectId;
    // Distinct opaque UUID identities, one per project folder.
    assert.notEqual(idA, idB);
    assert.match(idA, /^[0-9a-f-]{36}$/i); assert.match(idB, /^[0-9a-f-]{36}$/i);
    // Re-reading is stable and never bleeds across folders.
    assert.equal(readProjectIdentity(first).descriptor.projectId, idA);
    assert.equal(readProjectIdentity(second).descriptor.projectId, idB);
    // Each project resolves to its own control DB; no shared/global board.
    const dbA = resolveOpsDbPath(first, ""), dbB = resolveOpsDbPath(second, "");
    assert.notEqual(dbA, dbB);
    // Diagnostic is source-only and leaks no host path.
    assert.deepEqual(resolveOpsDbPathDiagnostic(first, ""), { source: "git-root-legacy" });
  } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); }
});