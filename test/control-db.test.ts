import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { probeControlDb } from "../src/control-db.ts";
import { ensureProjectIdentity, rootFsDigest } from "../src/project.ts";
import { stampCanonicalIdentity } from "../src/control-endpoint.ts";
import { mazzyDoctor } from "../src/scaffold.ts";
import { resolveOpsDbPath, resolveOpsDbPathDiagnostic } from "../src/project.ts";
import { testScratchRoot } from "./git-root.ts";

const TABLES = ["tasks", "events", "evidence", "run_bindings", "task_comments", "orchestration_requests", "review_reports", "comment_notifications"] as const;
mkdirSync(testScratchRoot, { recursive: true });
function project(prefix: string): string { const root = mkdtempSync(join(testScratchRoot, prefix)); execFileSync("git", ["init", "-q", root]); return root; }
function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function directState(path: string): { schema: string; rows: Record<string, number>; version: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = (db.prepare("SELECT group_concat(sql, '\n') AS text FROM sqlite_master ORDER BY name").get() as { text: string | null }).text ?? "";
    const rows = Object.fromEntries(TABLES.map((table) => [table, Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]));
    const version = Number((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version);
    return { schema, rows, version };
  } finally { db.close(); }
}
function seedLegacy(root: string, taskCount = 2): { path: string; db: DatabaseSync } {
  const directory = join(root, ".pi-ops"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "state.db"), db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(3);");
  for (const table of TABLES) db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, value TEXT)`);
  for (let i = 0; i < taskCount; i++) db.prepare("INSERT INTO tasks(value) VALUES(?)").run(`task-${i}`);
  for (const table of TABLES.filter((table) => table !== "tasks")) db.prepare(`INSERT INTO ${table}(value) VALUES(?)`).run(table);
  return { path, db };
}
function writeIdentity(root: string, projectId: string): void {
  mkdirSync(join(root, ".mazzy"));
  writeFileSync(join(root, ".mazzy", "project.json"), `${JSON.stringify({ schemaVersion: 1, projectId, createdAt: "2026-01-01T00:00:00.000Z" })}\n`);
}

test("A1 probe reports populated legacy integrity, schema version, and bounded row counts", () => {
  const root = project("control-db-a1-"); const seeded = seedLegacy(root);
  try {
    const result = probeControlDb(root);
    assert.equal(result.legacy.integrity, "ok"); assert.equal(result.legacy.foreignKeys, "ok"); assert.equal(result.legacy.schemaVersion, 3);
    assert.deepEqual(result.legacy.rows, { tasks: 2, events: 1, evidence: 1, run_bindings: 1, task_comments: 1, orchestration_requests: 1, review_reports: 1, comment_notifications: 1 });
  } finally { seeded.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("A2 probe preserves legacy main and WAL content", () => {
  const root = project("control-db-a2-"); const seeded = seedLegacy(root);
  try {
    assert.equal(existsSync(`${seeded.path}-wal`), true, "fixture keeps WAL content live");
    const before = { main: digest(seeded.path), wal: digest(`${seeded.path}-wal`), direct: directState(seeded.path) };
    const sharedMemoryBefore = statSync(`${seeded.path}-shm`).mtimeMs;
    probeControlDb(root);
    const after = { main: digest(seeded.path), wal: digest(`${seeded.path}-wal`), direct: directState(seeded.path) };
    assert.deepEqual(after, before);
    // F6: SQLite read-only WAL opens may update -shm metadata; it is intentionally excluded from content invariance.
    assert.ok(Number.isFinite(sharedMemoryBefore));
  } finally { seeded.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("A3 probe has no MazzyStore dependency and never applies a migration", () => {
  const root = project("control-db-a3-"); const seeded = seedLegacy(root);
  try {
    assert.doesNotMatch(readFileSync(new URL("../src/control-db.ts", import.meta.url), "utf8"), /from\s+["']\.\/store\.ts["']/);
    assert.equal(probeControlDb(root).legacy.schemaVersion, 3);
    assert.equal(directState(seeded.path).version, 3);
  } finally { seeded.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("A4 probe is project-local and serializes neither roots nor identities", () => {
  const projectA = project("control-db-a4-a-"), projectB = project("control-db-a4-b-"); const seededA = seedLegacy(projectA, 5), seededB = seedLegacy(projectB, 1);
  const identityA = randomUUID(), identityB = randomUUID();
  try {
    writeIdentity(projectA, identityA); writeIdentity(projectB, identityB);
    const result = probeControlDb(projectB), publicResult = JSON.stringify(result);
    assert.equal(result.legacy.rows.tasks, 1);
    for (const privateValue of [projectA, projectB, identityA, identityB]) assert.equal(publicResult.includes(privateValue), false);
  } finally { seededA.db.close(); seededB.db.close(); rmSync(projectA, { recursive: true, force: true }); rmSync(projectB, { recursive: true, force: true }); }
});

test("A5 corrupt legacy data degrades without suppressing doctor checks", () => {
  const root = project("control-db-a5-"), path = join(root, ".pi-ops", "state.db");
  try {
    mkdirSync(join(root, ".pi-ops")); writeFileSync(path, "not a sqlite database");
    assert.equal(probeControlDb(root).legacy.integrity, "unreadable");
    const report = mazzyDoctor(root, resolveOpsDbPath(root), resolveOpsDbPathDiagnostic(root));
    for (const name of ["database resolution", "control database identity", "legacy database candidates", "trusted project", "project identity", "canonical database"]) assert.ok(report.some((check) => check.name === name), name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probe identity delegates shared verifier and reports fs mismatch", () => {
  const root = project("control-db-fs-mismatch-");
  try {
    const identity = ensureProjectIdentity(root).descriptor.projectId;
    const control = join(root, ".mazzy", "control"); mkdirSync(control, { recursive: true });
    const target = join(control, "state.db"); new DatabaseSync(target).close();
    stampCanonicalIdentity(target, identity, `${rootFsDigest(root)}-different`);
    assert.equal(probeControlDb(root).identity, "fs-mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A6 legacy candidate discovery is bounded and count-only", () => {
  const root = project("control-db-a6-"); const seeded = seedLegacy(root);
  try {
    for (const directory of [join(root, "nested-one", ".pi-ops"), join(root, "nested-two", ".pi-ops")]) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "state.db"), "candidate"); }
    const result = probeControlDb(root), publicResult = JSON.stringify(result);
    assert.equal(result.legacyCandidates, 3);
    assert.equal(publicResult.includes(root), false);
    assert.equal(publicResult.includes(root.split("/").at(-1)!), false);
  } finally { seeded.db.close(); rmSync(root, { recursive: true, force: true }); }
});
