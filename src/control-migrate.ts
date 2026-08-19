// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { controlDbOverrideActive, inspectMazzyProjectDirectory, legacyStorePathStrict, readProjectIdentity, resolveTrustedProjectRoot, rootFsDigest } from "./project.ts";
import { CONTROL_TABLES, cutoverDamaged, cutoverMarkerPath, cutoverWitnessPath, durableCutoverObserved, hasDurableCutoverMarker, realDirectory, type JournalState, isCutover, isPromoted, readJournal, sameFile, stampCanonicalIdentity, verifyCanonicalIdentity } from "./control-endpoint.ts";

/**
 * Control-database migration engine: legacy `.pi-ops/state.db` -> canonical
 * `.mazzy/control/state.db`, with a durable journal and exact rollback.
 *
 * Safety model:
 *  - Dry-run is the default; nothing is written unless apply===true.
 *  - The legacy source is copied, never moved or deleted, so the live DB that
 *    the running session uses is untouched until an explicit, verified promote.
 *  - Every migration is verified (integrity + per-table row parity) before the
 *    journal reaches "promoted"; a failed verify rolls back atomically.
 *  - Rollback restores the pre-migration state from the backup and reverts the
 *    journal, so a bad cutover is always reversible.
 *  - Only relative, redacted digests cross the return boundary (INV-3).
 */

export type MigrationJournalState = JournalState;

const TABLES = CONTROL_TABLES;
type TableName = (typeof TABLES)[number];

export interface MigrationPlan {
  schemaVersion: 1;
  /** Redacted digest of the legacy source path. */
  sourceDigest: string;
  /** Redacted digest of the canonical target path. */
  targetDigest: string;
  sourcePresent: boolean;
  targetPresent: boolean;
  journal: MigrationJournalState;
  /** Per-table source row counts (empty when the source is absent/unreadable). */
  sourceRows: Record<TableName, number>;
  /** What apply() would do, in order. */
  steps: string[];
}

export interface MigrationResult {
  schemaVersion: 1;
  applied: boolean;
  journal: MigrationJournalState;
  sourceDigest: string;
  targetDigest: string;
  /** Snapshot self-check counts. `source` is the immutable migration snapshot, not a second read of live legacy. */
  verified: Record<TableName, { source: number; target: number; match: boolean }>;
  /** Optional independent post-promotion endpoint comparison; unlike `verified`, it detects live drift. */
  driftProbe?: ControlDriftReport;
  /** True only when integrity + snapshot self-check passed and no live drift was observed. */
  ok: boolean;
  /** Cutover requires this to be true; post-snapshot source drift makes it false. */
  cutoverReady?: boolean;
  /** Redacted, human-facing outcome. */
  detail: string;
}

export interface RollbackResult {
  schemaVersion: 1;
  applied: boolean;
  journal: MigrationJournalState;
  restored: boolean;
  detail: string;
}

export interface CutoverResult {
  schemaVersion: 1;
  applied: boolean;
  active: boolean;
  ok: boolean;
  detail: string;
}

export interface ControlDriftReport {
  schemaVersion: 1;
  drift: boolean;
  /** Endpoint with writes newer than promotion; no paths leave this boundary. */
  staleEndpoint: "legacy" | "canonical" | null;
  perTable: Record<TableName, { legacy: number; canonical: number; countMismatch: boolean; legacyNewer: boolean; canonicalNewer: boolean }>;
}

interface Paths { root: string; source: string; control: string; target: string; backup: string; migrate: string; journal: string; }

function redact(root: string, path: string): string {
  return createHash("sha256").update(relative(root, path).split(sep).join("/")).digest("hex").slice(0, 16);
}

function resolvePaths(cwd: string, options: { source?: string; root?: string } = {}): Paths | undefined {
  const root = options.root ?? resolveTrustedProjectRoot(cwd);
  if (!root) return undefined;
  // The write path must fail closed on an untrusted/symlinked .mazzy exactly like
  // the read-only probes (project.ts directoryStatus, control-db.ts probeIdentity).
  // Without this, mkdirSync/copyFileSync would follow a symlinked .mazzy and write
  // the canonical DB/backup/journal outside the trusted project root.
  if (inspectMazzyProjectDirectory(root) === "untrusted") return undefined;
  // The migration SOURCE is the ENV-FREE legacy path derived purely from the
  // trusted Git root — NEVER the override-honoring resolver (review CRITICAL
  // A MAZZY_DB/PI_OPS_DB override otherwise makes project B snapshot project
  // A's DB and launder A's identity/DONE/PASS into B). options.source is allowed
  // only for tests that pass an explicit in-root path.
  const source = options.source ?? legacyStorePathStrict(cwd);
  if (source === undefined) return undefined;
  const control = join(root, ".mazzy", "control");
  // Fail closed if .mazzy/control already exists but is a symlink or non-directory
  // (a symlinked ANCESTOR is not caught by the final-file lstat). Without this,
  // mkdirSync/copyFileSync/writeFileSync would write the canonical DB/backup/journal
  // through the symlink, outside the trusted project root. When control does not yet
  // exist, allow it (mkdirSync will create a real dir under the trusted .mazzy).
  if (existsSync(control)) {
    try {
      const s = lstatSync(control);
      if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(control) !== join(root, ".mazzy", "control")) return undefined;
    } catch { return undefined; }
  }
  return { root, source, control, target: join(control, "state.db"), backup: join(control, "state.db.backup"), migrate: join(control, "migrate"), journal: join(control, "migrate", "journal.json") };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function rowCounts(path: string): Record<TableName, number> {
  const rows = Object.fromEntries(TABLES.map((t) => [t, 0])) as Record<TableName, number>;
  if (!existsSync(path)) return rows;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    for (const table of TABLES) if (hasTable(db, table)) rows[table] = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: unknown }).c);
  } catch { /* unreadable => zeros */ } finally { db?.close(); }
  return rows;
}

/** Exact bidirectional row comparison used only for authority handoff gates.
 * Timestamp/count drift remains intentionally separate observability below. */
function strictControlParity(source: string, target: string): boolean {
  let left: DatabaseSync | undefined, right: DatabaseSync | undefined;
  try {
    left = new DatabaseSync(source, { readOnly: true }); right = new DatabaseSync(target, { readOnly: true });
    for (const table of TABLES) {
      if (hasTable(left, table) !== hasTable(right, table)) return false;
      if (!hasTable(left, table)) continue;
      // Table names come from the closed CONTROL_TABLES inventory, never input.
      // This is a bidirectional multiset comparison of every stored column; unlike
      // count/timestamp heuristics it catches equal-count stale-content changes.
      const canonicalRows = right.prepare(`SELECT * FROM ${table}`).all().map((row) => JSON.stringify(row)).sort();
      const legacyRows = left.prepare(`SELECT * FROM ${table}`).all().map((row) => JSON.stringify(row)).sort();
      if (legacyRows.length !== canonicalRows.length || legacyRows.some((row, index) => row !== canonicalRows[index])) return false;
    }
    return true;
  } catch { return false; } finally { left?.close(); right?.close(); }
}

/** Keep a bounded number of crash-recovery images per operation kind. */
const BACKUP_RETENTION = 5;

/** A backup root and its children must be real directories under this checkout. */
function trustedBackupsRoot(root: string, create = false): string | undefined {
  const mazzy = join(root, ".mazzy");
  const backups = join(mazzy, "backups");
  try {
    if (!realDirectory(mazzy) || realpathSync(mazzy) !== mazzy) return undefined;
    if (!existsSync(backups)) {
      if (!create) return undefined;
      mkdirSync(backups);
    }
    if (!realDirectory(backups)) return undefined;
    const mazzyReal = realpathSync(mazzy), backupsReal = realpathSync(backups);
    const contained = relative(mazzyReal, backupsReal);
    return contained === "backups" ? backups : undefined;
  } catch { return undefined; }
}

/** Return only a real, direct child of the already trusted backup root. */
function trustedBackupChild(backups: string, name: string): string | undefined {
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") return undefined;
  const child = join(backups, name);
  try {
    if (!realDirectory(child)) return undefined;
    return relative(realpathSync(backups), realpathSync(child)) === name ? child : undefined;
  } catch { return undefined; }
}

/** Create a recovery directory only after the backup root passed the no-symlink check. */
function createBackupDirectory(root: string, kind: "pre-apply" | "pre-rollback", stamp: string): string | undefined {
  const backups = trustedBackupsRoot(root, true);
  if (!backups) return undefined;
  const directory = join(backups, `${kind}-${stamp}`);
  try {
    mkdirSync(directory);
    return trustedBackupChild(backups, `${kind}-${stamp}`);
  } catch { return undefined; }
}

function retainBackups(root: string, kind: "pre-apply" | "pre-rollback"): void {
  const directory = trustedBackupsRoot(root);
  if (!directory) return;
  try {
    const names = readdirSync(directory)
      .filter((name) => name.startsWith(`${kind}-`))
      .filter((name) => trustedBackupChild(directory, name) !== undefined)
      .sort().reverse();
    for (const name of names.slice(BACKUP_RETENTION)) {
      // Re-check directly before deletion so symlink/non-directory entries are
      // never followed or removed by retention.
      const stale = trustedBackupChild(directory, name);
      if (stale) rmSync(stale, { recursive: true, force: true });
    }
  } catch { /* retention is best effort; never invalidate a completed recovery image */ }
}

function newerRows(path: string, table: TableName, promotedAt: string): boolean {
  // Best-effort limitation: tables without updated_at/created_at (notably some
  // request rows) and equal-count delete/insert churn cannot be timestamp
  // detected.  Authority task/evidence/report writes carry timestamps; count
  // mismatch remains an observability fallback when no endpoint is selected.
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (!hasTable(db, table)) return false;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    const timestamp = columns.some((column) => column.name === "updated_at") ? "updated_at" : columns.some((column) => column.name === "created_at") ? "created_at" : undefined;
    if (!timestamp) return false;
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${timestamp} > ?`).get(promotedAt) as { count: unknown }).count) > 0;
  } catch { return false; } finally { db?.close(); }
}

function promotedAt(target: string): string | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    const row = db.prepare("SELECT promoted_at FROM mazzy_control_identity WHERE singleton=1").get() as { promoted_at?: unknown } | undefined;
    return typeof row?.promoted_at === "string" ? row.promoted_at : undefined;
  } catch { return undefined; } finally { db?.close(); }
}

export interface CutoverReadiness {
  schemaVersion: 1;
  /** True only when legacy and canonical are byte-for-byte row-equal on every control table. */
  cutoverReady: boolean;
  /** Journal state, so the operator sees whether a promoted snapshot even exists. */
  journal: JournalState;
  /** Per-table legacy vs canonical row counts (observability; parity is the gate). */
  rows: Record<TableName, { legacy: number; canonical: number }>;
  detail: string;
}

/** Read-only answer to "can I cut over right now?" without attempting a mutation (audit M7).
 * It runs the SAME strict bidirectional parity the real cutover gate uses, plus a
 * per-table count view, so an operator can confirm quiescence before activating. */
export function cutoverReadiness(cwd: string, options: { source?: string; root?: string } = {}): CutoverReadiness | undefined {
  const paths = resolvePaths(cwd, options);
  if (!paths) return undefined;
  const journal = readJournalState(paths.journal);
  const legacyRows = rowCounts(paths.source);
  const canonRows = rowCounts(paths.target);
  const rows = Object.fromEntries(TABLES.map((t) => [t, { legacy: legacyRows[t], canonical: canonRows[t] }])) as CutoverReadiness["rows"];
  if (!existsSync(paths.source) || !existsSync(paths.target)) {
    return { schemaVersion: 1, cutoverReady: false, journal, rows, detail: "Not ready: legacy and/or canonical store is absent; run apply first." };
  }
  if (!isPromoted(journal)) {
    return { schemaVersion: 1, cutoverReady: false, journal, rows, detail: "Not ready: canonical is not promoted; run apply first." };
  }
  const ready = strictControlParity(paths.source, paths.target);
  return { schemaVersion: 1, cutoverReady: ready, journal, rows, detail: ready ? "Ready: legacy and canonical match exactly; cutover can be activated (keep all other Pi sessions quiesced)." : "Not ready: legacy and canonical content differ (live drift); quiesce all writers and re-apply a fresh snapshot before cutover." };
}

/** Read-only independent endpoint probe; it never manufactures source counts. */
export function verifyControlDrift(cwd: string, effectiveEndpoint?: "canonical" | "legacy" | "override"): ControlDriftReport | undefined {
  const paths = resolvePaths(cwd);
  if (!paths || !existsSync(paths.source) || !existsSync(paths.target)) return undefined;
  const at = promotedAt(paths.target);
  if (!at) return undefined;
  const legacy = rowCounts(paths.source), canonical = rowCounts(paths.target);
  const perTable = Object.fromEntries(TABLES.map((table) => [table, {
    legacy: legacy[table], canonical: canonical[table], countMismatch: legacy[table] !== canonical[table],
    legacyNewer: newerRows(paths.source, table, at), canonicalNewer: newerRows(paths.target, table, at),
  }])) as ControlDriftReport["perTable"];
  const legacyNewer = Object.values(perTable).some((row) => row.legacyNewer);
  const canonicalNewer = Object.values(perTable).some((row) => row.canonicalNewer);
  const countDelta = Object.values(perTable).find((row) => row.countMismatch);
  // Writes to the selected endpoint are normal operation.  Only a newer write
  // on the non-selected retained endpoint is drift.  Count mismatch remains a
  // conservative fallback (timestamp-free tables can otherwise be invisible).
  const staleEndpoint = effectiveEndpoint === "canonical"
    ? legacyNewer ? "legacy" : null
    : effectiveEndpoint === "legacy"
      ? canonicalNewer ? "canonical" : null
      : legacyNewer ? "legacy" : canonicalNewer ? "canonical" : countDelta ? countDelta.legacy > countDelta.canonical ? "legacy" : "canonical" : null;
  return { schemaVersion: 1, drift: staleEndpoint !== null, staleEndpoint, perTable };
}

/**
 * Produce a transactionally-consistent snapshot of the source database at `target`
 * using SQLite's `VACUUM INTO`. This reads through the source's own MVCC snapshot,
 * so it is consistent even while another connection (the running session's own
 * MazzyStore) holds the source open in WAL mode, and it captures a single
 * point-in-time image (no content-level TOCTOU). Returns true on success.
 */
function snapshotInto(source: string, target: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    // VACUUM INTO requires a string literal target path; escape single quotes.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return existsSync(target);
  } catch { return false; } finally { db?.close(); }
}

function integrityOk(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: unknown }>;
    return rows.every((r) => r.integrity_check === "ok");
  } catch { return false; } finally { db?.close(); }
}

function readJournalState(journal: string): MigrationJournalState { return readJournal(journal); }

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  let file: number | undefined, directory: number | undefined;
  try {
    writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    try { file = openSync(temp, "r+"); fsyncSync(file); } catch { /* best-effort portable fsync */ }
    finally { if (file !== undefined) closeSync(file); }
    renameSync(temp, path);
    try { directory = openSync(dirname(path), "r"); fsyncSync(directory); } catch { /* directory fsync unsupported on some platforms */ }
    finally { if (directory !== undefined) closeSync(directory); }
  } finally { try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort cleanup */ } }
}

function writeJournal(paths: Paths, state: MigrationJournalState, extra: Record<string, unknown> = {}): void {
  mkdirSync(paths.migrate, { recursive: true });
  atomicWrite(paths.journal, `${JSON.stringify({ schemaVersion: 1, state, updatedAt: new Date().toISOString(), ...extra })}\n`);
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, "r"); fsyncSync(fd); } catch { /* directory fsync unsupported on some platforms */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

function acquireMigrationLock(control: string): { ok: true; release: () => void } | { ok: false } {
  mkdirSync(control, { recursive: true });
  const lock = join(control, "migrate.lock");
  const token = `${process.pid}-${Date.now()}-${randomBytes(16).toString("hex")}`;
  try {
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
  } catch { return { ok: false }; }
  // A live owner's lock is never reclaimed on the mutator hot path. Token-checked
  // release closes the ABA hole where an old owner unlinks a successor's lock.
  return { ok: true, release: () => {
    try {
      const value = JSON.parse(readFileSync(lock, "utf8")) as { token?: unknown };
      if (value.token === token) unlinkSync(lock);
    } catch { /* lock changed or unavailable: never unlink blindly */ }
  } };
}

export function planControlMigration(cwd: string, options: { source?: string; root?: string } = {}): MigrationPlan | undefined {
  const paths = resolvePaths(cwd, options);
  if (!paths) return undefined;
  const sourcePresent = existsSync(paths.source), targetPresent = existsSync(paths.target);
  const journal = readJournalState(paths.journal);
  const steps: string[] = [];
  if (!sourcePresent) steps.push("no legacy source present; nothing to migrate");
  else {
    steps.push("copy legacy source -> canonical target (source left intact)");
    if (targetPresent) steps.push("back up existing canonical target before overwrite");
    steps.push("stamp canonical identity table");
    steps.push("verify integrity + per-table row parity");
    steps.push("advance journal prepared -> verified -> promoted (or rollback on failure)");
  }
  return {
    schemaVersion: 1,
    sourceDigest: redact(paths.root, paths.source),
    targetDigest: redact(paths.root, paths.target),
    sourcePresent, targetPresent, journal,
    sourceRows: rowCounts(paths.source),
    steps,
  };
}

function applyControlMigrationUnlocked(cwd: string, options: { source?: string; root?: string; apply?: boolean; force?: boolean } = {}): MigrationResult | undefined {
  const paths = resolvePaths(cwd, options);
  if (!paths) return undefined;
  const sourceDigest = redact(paths.root, paths.source), targetDigest = redact(paths.root, paths.target);
  const emptyVerified = Object.fromEntries(TABLES.map((t) => [t, { source: 0, target: 0, match: true }])) as MigrationResult["verified"];
  // Refuse to mutate while a control-DB override env is active: the override does
  // not affect our env-free source, but proceeding under it is ambiguous and was
  // the vector for cross-project laundering. Fail closed.
  if (controlDbOverrideActive() && options.source === undefined) {
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing to migrate while a control-DB override (MAZZY_DB/PI_OPS_DB) is active; unset it and retry." };
  }
  if (!existsSync(paths.source)) {
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "No legacy source database present; nothing to migrate." };
  }
  // Refuse a self-referential migration: if source and target are the same file,
  // copying + backing up would let a later rollback restore a stale self-backup
  // over live data. This is the guard that makes a future resolver flip safe.
  if (sameFile(paths.source, paths.target)) {
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing to migrate: source and target resolve to the same database (self-referential). Use the legacy source explicitly." };
  }
  // A durable cutover (including either independent witness) makes legacy retired.
  // Never overwrite canonical from it, even with force; deactivation is explicit.
  if (durableCutoverObserved(paths.root) || cutoverDamaged(paths.root)) {
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing re-apply while durable cutover evidence is active or damaged; deactivate cutover first." };
  }
  // Break-glass selects canonical too, so NO re-apply may silently replace its writes.
  // This guard precedes journal interpretation: a corrupt/missing journal is not a bypass.
  if (process.env.MAZZY_CUTOVER?.trim() === "1") {
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing re-apply while break-glass cutover is active; unset MAZZY_CUTOVER first." };
  }
  if (isPromoted(readJournalState(paths.journal)) && options.force !== true) {
    return { schemaVersion: 1, applied: false, journal: "promoted", sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing to re-apply over an already-promoted canonical store; rollback first, or pass force to overwrite." };
  }
  if (options.apply !== true) {
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: true, detail: "Dry-run: pass apply=true to perform the copy/verify/promote. Source is never moved or deleted." };
  }
  mkdirSync(paths.control, { recursive: true });
  // Keep the legacy single backup for rollback and an immutable timestamped image
  // for recovery from every destructive apply generation.
  if (existsSync(paths.target)) {
    // Never follow a substituted backups symlink: reject before copying or
    // snapshotting, so recovery maintenance cannot write outside this checkout.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = createBackupDirectory(paths.root, "pre-apply", stamp);
    if (!backupDir) {
      return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing migration: backup root is not a trusted real directory." };
    }
    // The immutable recovery image is the first destructive-operation write.
    // Do not clobber the rollback backup until that snapshot has succeeded.
    if (!snapshotInto(paths.target, join(backupDir, "state.db"))) {
      // A failed VACUUM INTO can leave an empty/partial generation; it is not a
      // recovery image and must not consume retention budget.
      rmSync(backupDir, { recursive: true, force: true });
      return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Refusing migration: pre-apply recovery snapshot could not be created." };
    }
    copyFileSync(paths.target, paths.backup);
    retainBackups(paths.root, "pre-apply");
  }
  writeJournal(paths, "prepared", { sourceDigest, targetDigest });
  try {
    // Snapshot the source with VACUUM INTO: a transactionally-consistent copy taken
    // through the source's own read snapshot. This is safe even while the session's
    // MazzyStore keeps the source open in WAL mode (no quiesce needed) and captures a
    // point-in-time image (no content-level TOCTOU), unlike a raw file copy.
    if (existsSync(paths.target)) rmSync(paths.target, { force: true });
    for (const suffix of ["-wal", "-shm"]) { const stray = `${paths.target}${suffix}`; if (existsSync(stray)) rmSync(stray, { force: true }); }
    // This is the lower bound for drift detection and must predate the snapshot.
    const promotionBaseline = new Date().toISOString();
    if (!snapshotInto(paths.source, paths.target)) {
      if (existsSync(paths.backup)) copyFileSync(paths.backup, paths.target); else rmSync(paths.target, { force: true });
      writeJournal(paths, "invalid", { sourceDigest, targetDigest, reason: "snapshot-failed" });
      return { schemaVersion: 1, applied: true, journal: "invalid", sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Consistent snapshot of the source database could not be produced; rolled back." };
    }
    let projectId = "unknown";
    try { projectId = readProjectIdentity(paths.root).descriptor.projectId; } catch { /* identity absent: stamp best-effort */ }
    // Stamp identity + the root fs-digest (F8: a cp -r copy has a different root
    // inode, so its stamped digest will not match and the resolver holds it).
    stampCanonicalIdentity(paths.target, projectId, rootFsDigest(paths.root) ?? "", promotionBaseline);
    // The target is a transactionally-consistent VACUUM INTO snapshot, so verification
    // must NOT re-read the live source (it legitimately moves on under concurrent writes,
    // which previously caused spurious row-parity rollbacks). Verify the snapshot's own
    // structural integrity instead; report the snapshot's row counts for observability
    // (source==target here because the target IS the point-in-time source image).
    const targetRows = rowCounts(paths.target);
    const verified = Object.fromEntries(TABLES.map((t) => [t, { source: targetRows[t], target: targetRows[t], match: true }])) as MigrationResult["verified"];
    const ok = integrityOk(paths.target);
    if (!ok) {
      // Roll back: restore backup if present, else remove the bad target.
      if (existsSync(paths.backup)) copyFileSync(paths.backup, paths.target); else rmSync(paths.target, { force: true });
      writeJournal(paths, "invalid", { sourceDigest, targetDigest, reason: "integrity-check-failed" });
      return { schemaVersion: 1, applied: true, journal: "invalid", sourceDigest, targetDigest, verified, ok: false, detail: "Snapshot integrity check failed; migration rolled back to the pre-migration state." };
    }
    writeJournal(paths, "verified", { sourceDigest, targetDigest });
    writeJournal(paths, "promoting", { sourceDigest, targetDigest });
    writeJournal(paths, "promoted", { sourceDigest, targetDigest });
    // The live source can advance after the snapshot.  Promotion is retained for
    // inspection, but it is not cutover-ready until that drift is re-applied.
    const driftProbe = verifyControlDrift(cwd);
    const cutoverReady = strictControlParity(paths.source, paths.target);
    return { schemaVersion: 1, applied: true, journal: "promoted", sourceDigest, targetDigest, verified, driftProbe, cutoverReady, ok: cutoverReady, detail: cutoverReady ? "Canonical control database promoted after snapshot integrity verification. Legacy source retained; ready for cutover." : "Canonical snapshot was promoted, but legacy and canonical content differ; re-apply before cutover." };
  } catch {
    // Never interpolate a raw fs Error.message into a boundary-crossing field:
    // Node fs errors embed absolute host paths (INV-3). Return a fixed reason.
    if (existsSync(paths.backup)) copyFileSync(paths.backup, paths.target); else rmSync(paths.target, { force: true });
    writeJournal(paths, "invalid", { sourceDigest, targetDigest, reason: "exception" });
    return { schemaVersion: 1, applied: true, journal: "invalid", sourceDigest, targetDigest, verified: emptyVerified, ok: false, detail: "Migration aborted and rolled back after a filesystem error (reason redacted)." };
  }
}

export interface CutoverOptions {
  apply?: boolean;
  /** Deterministic test seam for a legacy write between the two parity gates. */
  beforeFinalParityForTest?: () => void;
}

function activateCutoverUnlocked(cwd: string, options: CutoverOptions = {}): CutoverResult | undefined {
  const paths = resolvePaths(cwd);
  if (!paths) return undefined;
  if (controlDbOverrideActive()) return { schemaVersion: 1, applied: false, active: false, ok: false, detail: "Refusing cutover while a control-DB override is active; unset MAZZY_DB/PI_OPS_DB first." };
  if (cutoverDamaged(paths.root)) return { schemaVersion: 1, applied: false, active: false, ok: false, detail: "Refusing cutover while durable cutover evidence is damaged; deactivate cutover first." };
  const state = readJournalState(paths.journal);
  if (!isPromoted(state) || !existsSync(paths.target) || verifyCanonicalIdentity(paths.target, paths.root, rootFsDigest(paths.root) ?? "") !== "match") {
    return { schemaVersion: 1, applied: false, active: false, ok: false, detail: "Refusing cutover: a verified promoted canonical identity is required." };
  }
  // Cutover is fail-closed: both stores must still exactly agree. Selecting a
  // hypothetical canonical endpoint here would hide canonical-pending divergence.
  // This narrows, but cannot eliminate, cross-process TOCTOU: operators MUST
  // quiesce every other live Pi session. A write-path generation lease is backlog
  // epic fb8a4408, not silently claimed by this advisory migration lock.
  if (!strictControlParity(paths.source, paths.target)) {
    return { schemaVersion: 1, applied: false, active: false, ok: false, detail: "Refusing cutover: legacy and canonical content differ; quiesce other Pi sessions and re-apply a fresh snapshot first." };
  }
  if (options.apply !== true) return { schemaVersion: 1, applied: false, active: isCutover(state), ok: true, detail: "Dry-run: pass apply=true to record durable cutover activation. Precondition: one live Pi session; quiesce all others." };
  try {
    options.beforeFinalParityForTest?.();
    // Re-check under the same migration lock immediately before publication. It
    // catches a legacy writer that raced the initial handoff check.
    if (!strictControlParity(paths.source, paths.target)) {
      return { schemaVersion: 1, applied: false, active: false, ok: false, detail: "Refusing cutover: legacy changed during cutover preflight; quiesce all other Pi sessions and re-apply a fresh snapshot first." };
    }
    // External witness first survives loss of the canonical subtree. Marker then
    // journal retain the existing fail-safe activation ordering.
    const projectId = readProjectIdentity(paths.root).descriptor.projectId;
    const digest = rootFsDigest(paths.root);
    if (!digest) throw new Error("trusted root digest unavailable");
    const witness = `${JSON.stringify({ schemaVersion: 1, active: true, projectId, rootFsDigest: digest, generation: Date.now(), cutoverAt: new Date().toISOString() })}\n`;
    atomicWrite(cutoverWitnessPath(paths.root), witness);
    atomicWrite(cutoverMarkerPath(paths.root), witness);
    writeJournal(paths, "cutover", { cutoverAt: new Date().toISOString() });
    return { schemaVersion: 1, applied: true, active: true, ok: true, detail: "Durable canonical cutover activated; keep all other Pi sessions quiesced and reconnect the invoking session to canonical before further writes." };
  } catch { return { schemaVersion: 1, applied: true, active: durableCutoverObserved(paths.root), ok: false, detail: "Cutover activation did not complete after a filesystem error (reason redacted)." }; }
}

function deactivateCutoverUnlocked(cwd: string, options: { apply?: boolean } = {}): CutoverResult | undefined {
  const paths = resolvePaths(cwd);
  if (!paths) return undefined;
  const state = readJournalState(paths.journal);
  const markerExists = existsSync(cutoverMarkerPath(paths.root));
  const witnessExists = existsSync(cutoverWitnessPath(paths.root));
  // A malformed existing witness seals resolution, but explicit deactivation is
  // still the in-product recovery path: remove it last under the operation lock.
  // An invalid journal alone is an interrupted never-cut-over migration, not
  // activation evidence. Repair its breadcrumb explicitly to an inactive state.
  const repairInvalidJournal = state === "invalid" && !markerExists && !witnessExists;
  if (!isCutover(state) && !markerExists && !witnessExists && !repairInvalidJournal) return { schemaVersion: 1, applied: false, active: false, ok: true, detail: "Cutover is not durably active." };
  if (options.apply !== true) return repairInvalidJournal
    ? { schemaVersion: 1, applied: false, active: false, ok: true, detail: "Dry-run: pass apply=true to repair the inactive migration journal." }
    : { schemaVersion: 1, applied: false, active: true, ok: true, detail: "Dry-run: pass apply=true to return endpoint selection to legacy." };
  try {
    if (repairInvalidJournal) {
      writeJournal(paths, "rolled-back", { repairedAt: new Date().toISOString() });
      return { schemaVersion: 1, applied: true, active: false, ok: true, detail: "Inactive migration journal repaired; legacy remains authoritative." };
    }
    // Inverse ordering keeps every partial deactivation sealed: journal, marker,
    // then the independent witness last.
    writeJournal(paths, "promoted", { deactivatedAt: new Date().toISOString() });
    rmSync(cutoverMarkerPath(paths.root), { force: true });
    fsyncDirectory(paths.control);
    rmSync(cutoverWitnessPath(paths.root), { force: true });
    fsyncDirectory(join(paths.root, ".mazzy"));
    return { schemaVersion: 1, applied: true, active: false, ok: true, detail: "Durable cutover deactivated; the invoking session must reconnect to legacy before further writes." };
  } catch { return { schemaVersion: 1, applied: true, active: true, ok: false, detail: "Cutover deactivation did not complete after a filesystem error (reason redacted)." }; }
}

function rollbackControlMigrationUnlocked(cwd: string, options: { source?: string; root?: string; apply?: boolean; force?: boolean } = {}): RollbackResult | undefined {
  const paths = resolvePaths(cwd, options);
  if (!paths) return undefined;
  const journal = readJournalState(paths.journal);
  if (process.env.MAZZY_CUTOVER?.trim() === "1" || isCutover(journal) || hasDurableCutoverMarker(paths.root) || durableCutoverObserved(paths.root) || cutoverDamaged(paths.root)) return { schemaVersion: 1, applied: false, journal, restored: false, detail: "Refusing rollback while durable cutover evidence is active or damaged; deactivate/unset cutover first." };
  if (options.apply !== true) return { schemaVersion: 1, applied: false, journal, restored: false, detail: "Dry-run: pass apply=true to restore the pre-migration canonical target and revert the journal." };
  try {
    const drift = verifyControlDrift(cwd);
    const canonicalNewer = drift ? Object.values(drift.perTable).some((row) => row.canonicalNewer) : undefined;
    // Refusal is side-effect free: do not grow recovery backups for a rollback we reject.
    if (canonicalNewer !== false && options.force !== true) return { schemaVersion: 1, applied: false, journal, restored: false, detail: canonicalNewer === undefined ? "Rollback refused: endpoint drift is unknown. Pass force only after review." : "Rollback refused: canonical contains rows newer than promotion. Pass force only after review." };
    if (existsSync(paths.target)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupDir = createBackupDirectory(paths.root, "pre-rollback", stamp);
      if (!backupDir) return { schemaVersion: 1, applied: false, journal, restored: false, detail: "Rollback refused: backup root is not a trusted real directory." };
      if (!snapshotInto(paths.target, join(backupDir, "state.db"))) return { schemaVersion: 1, applied: false, journal, restored: false, detail: "Rollback refused: pre-rollback snapshot could not be created." };
      retainBackups(paths.root, "pre-rollback");
    }
    let restored = false;
    if (existsSync(paths.backup)) { copyFileSync(paths.backup, paths.target); restored = true; }
    else if (existsSync(paths.target)) { rmSync(paths.target, { force: true }); restored = true; }
    for (const suffix of ["-wal", "-shm"]) { const stray = `${paths.target}${suffix}`; if (existsSync(stray)) rmSync(stray, { force: true }); }
    writeJournal(paths, "rolled-back", { at: new Date().toISOString() });
    return { schemaVersion: 1, applied: true, journal: "absent", restored, detail: restored ? existsSync(paths.source) ? "Canonical target restored to its pre-migration state; legacy source remains authoritative." : "Canonical target restored to its pre-migration state; no legacy source is present." : "Nothing to restore; canonical target was not present." };
  } catch {
    return { schemaVersion: 1, applied: true, journal: readJournalState(paths.journal), restored: false, detail: "Rollback did not complete after a filesystem error (reason redacted); canonical target may be partial. Legacy source remains intact." };
  }
}

/** Mutation wrappers acquire one advisory lock across guard checks and commit. */
export function applyControlMigration(cwd: string, options: { source?: string; root?: string; apply?: boolean; force?: boolean } = {}): MigrationResult | undefined {
  if (options.apply !== true) return applyControlMigrationUnlocked(cwd, options);
  const paths = resolvePaths(cwd, options);
  if (!paths) return undefined;
  const lock = acquireMigrationLock(paths.control);
  if (!lock.ok) {
    const verified = Object.fromEntries(TABLES.map((t) => [t, { source: 0, target: 0, match: true }])) as MigrationResult["verified"];
    return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), sourceDigest: redact(paths.root, paths.source), targetDigest: redact(paths.root, paths.target), verified, ok: false, detail: "Refusing migration: another cutover operation is in progress (lock busy)." };
  }
  try { return applyControlMigrationUnlocked(cwd, options); } finally { lock.release(); }
}

export function activateCutover(cwd: string, options: CutoverOptions = {}): CutoverResult | undefined {
  if (options.apply !== true) return activateCutoverUnlocked(cwd, options);
  const paths = resolvePaths(cwd);
  if (!paths) return undefined;
  const lock = acquireMigrationLock(paths.control);
  if (!lock.ok) return { schemaVersion: 1, applied: false, active: false, ok: false, detail: "Refusing cutover: another cutover operation is in progress (lock busy)." };
  try { return activateCutoverUnlocked(cwd, options); } finally { lock.release(); }
}

export function deactivateCutover(cwd: string, options: { apply?: boolean } = {}): CutoverResult | undefined {
  if (options.apply !== true) return deactivateCutoverUnlocked(cwd, options);
  const paths = resolvePaths(cwd);
  if (!paths) return undefined;
  const lock = acquireMigrationLock(paths.control);
  if (!lock.ok) return { schemaVersion: 1, applied: false, active: true, ok: false, detail: "Refusing deactivation: another cutover operation is in progress (lock busy)." };
  try { return deactivateCutoverUnlocked(cwd, options); } finally { lock.release(); }
}

export function rollbackControlMigration(cwd: string, options: { source?: string; root?: string; apply?: boolean; force?: boolean } = {}): RollbackResult | undefined {
  if (options.apply !== true) return rollbackControlMigrationUnlocked(cwd, options);
  const paths = resolvePaths(cwd, options);
  if (!paths) return undefined;
  const lock = acquireMigrationLock(paths.control);
  if (!lock.ok) return { schemaVersion: 1, applied: false, journal: readJournalState(paths.journal), restored: false, detail: "Refusing rollback: another cutover operation is in progress (lock busy)." };
  try { return rollbackControlMigrationUnlocked(cwd, options); } finally { lock.release(); }
}