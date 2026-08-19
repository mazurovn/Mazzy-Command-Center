// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readProjectIdentity, rootFsDigest } from "./project.ts";

/**
 * control-endpoint.ts — the SINGLE shared source of truth for control-DB endpoint
 * primitives previously copy-pasted across control-migrate / control-resolve /
 * control-db (journal codec, table inventory, trust predicates, identity + fs
 * stamps, generation stamps).
 *
 * A code audit showed the duplicated journal codec was not merely latent:
 * rollback persisted {state:"absent"} but every reader only recognised
 * prepared/verified/promoting/promoted and mapped everything else to "invalid",
 * so a *successful* rollback permanently wedged orchestrationGate into
 * redirect-consolidation. Unifying the codec here (and recognising "absent" and
 * "rolled-back") fixes that class of drift once, and the grep-guard test forbids
 * a fourth copy from reappearing.
 */

/** Journal FSM. "rolled-back" is a durable breadcrumb that resolves as absent. */
export type JournalState =
  | "absent" | "prepared" | "verified" | "promoting" | "promoted" | "cutover" | "rolled-back" | "invalid";

const ACTIVE_JOURNAL_STATES = new Set(["prepared", "verified", "promoting", "promoted", "cutover"]);

/**
 * Canonical journal decoder. Total, non-throwing. A missing file is "absent";
 * a well-formed {state:"absent"|"rolled-back"} breadcrumb decodes faithfully
 * (the bug fix — previously these read back as "invalid"); an active-FSM state
 * decodes to itself; anything else is "invalid".
 */
export function readJournal(journalPath: string): JournalState {
  if (!existsSync(journalPath)) return "absent";
  try {
    const value = JSON.parse(readFileSync(journalPath, "utf8")) as { state?: unknown };
    if (value.state === "absent") return "absent";
    if (value.state === "rolled-back") return "rolled-back";
    return typeof value.state === "string" && ACTIVE_JOURNAL_STATES.has(value.state) ? (value.state as JournalState) : "invalid";
  } catch { return "invalid"; }
}

/** True only for a verified promoted endpoint, whether awaiting or in durable cutover. */
export function isPromoted(state: JournalState): boolean { return state === "promoted" || state === "cutover"; }
/** True only when the durable cutover activation has been recorded. */
export function isCutover(state: JournalState): boolean { return state === "cutover"; }
/** True when no promotion has ever taken effect (never migrated or reverted). */
export function isInactive(state: JournalState): boolean { return state === "absent" || state === "rolled-back"; }

/** Canonical control-plane user tables, the single inventory (was duplicated 2×). */
export const CONTROL_TABLES = [
  "tasks", "events", "evidence", "run_bindings", "task_comments",
  "orchestration_requests", "review_reports", "comment_notifications",
] as const;
export type ControlTableName = (typeof CONTROL_TABLES)[number];

// ---- trust predicates (single definition; was 3×, one already divergent) ----

export function realFile(path: string): boolean {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}
export function realDirectory(path: string): boolean {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}
/**
 * True when two paths resolve to the same underlying file (dev+inode). Uses
 * statSync (follows symlinks) deliberately: this is used to detect ALIASING
 * (a symlink or hardlink that makes source==target), where following the link
 * is the correct, safer behaviour.
 */
export function sameFile(a: string, b: string): boolean {
  try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}
/**
 * True only when `control` is a real, non-symlinked directory whose realpath is
 * exactly <root>/.mazzy/control. Closes the symlinked-ancestor escape uniformly
 * for every reader and writer.
 */
export function trustedControlDir(root: string): boolean {
  const control = join(root, ".mazzy", "control");
  try {
    const s = lstatSync(control);
    if (!s.isDirectory() || s.isSymbolicLink()) return false;
    return realpathSync(control) === control;
  } catch { return false; }
}

// ---- canonical path layout (single source; migration-only helpers) ----

export function controlDirectory(root: string): string { return join(root, ".mazzy", "control"); }
export function canonicalStorePath(root: string): string { return join(root, ".mazzy", "control", "state.db"); }
export function journalPath(root: string): string { return join(root, ".mazzy", "control", "migrate", "journal.json"); }
/** Separate durable activation witness lets the resolver seal if the journal is later corrupted. */
export function cutoverMarkerPath(root: string): string { return join(root, ".mazzy", "control", "cutover.json"); }
/** Independent of the removable canonical subtree; it seals legacy after witness loss. */
export function cutoverWitnessPath(root: string): string { return join(root, ".mazzy", "cutover-witness.json"); }
export type WitnessState = "absent" | "active" | "inert" | "invalid";

/** A witness belongs to one checkout, not merely to a Git worktree's history. */
function witnessState(path: string, root: string): WitnessState {
  try {
    const detail = lstatSync(path);
    if (!detail.isFile() || detail.isSymbolicLink()) return "invalid";
    const value = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; active?: unknown; projectId?: unknown; rootFsDigest?: unknown };
    if (value.schemaVersion !== 1 || value.active !== true || typeof value.projectId !== "string" || typeof value.rootFsDigest !== "string") return "invalid";
    let projectId: string;
    try { projectId = readProjectIdentity(root).descriptor.projectId; } catch { return "invalid"; }
    const digest = rootFsDigest(root);
    if (!digest) return "invalid";
    return value.projectId === projectId && value.rootFsDigest === digest ? "active" : "inert";
  } catch (error) {
    // A non-directory ancestor means this evidence path cannot exist. Structural
    // damage is evaluated separately; do not misclassify its absent child as a
    // malformed publication witness in a never-cut-over checkout.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "invalid";
  }
}
export function cutoverWitnessState(root: string): WitnessState { return witnessState(cutoverWitnessPath(root), root); }
export function cutoverMarkerState(root: string): WitnessState { return witnessState(cutoverMarkerPath(root), root); }
export function hasDurableCutoverMarker(root: string): boolean { return cutoverMarkerState(root) === "active"; }
export function hasDurableCutoverWitness(root: string): boolean { return cutoverWitnessState(root) === "active"; }

/**
 * Affirmative activation proof only. Malformed publication evidence is never
 * authority for canonical; `cutoverDamaged` decides whether it seals legacy.
 * A valid witness copied to another checkout is inert.
 */
export function durableCutoverObserved(root: string): boolean {
  const outer = cutoverWitnessState(root), inner = cutoverMarkerState(root);
  return outer === "active" || inner === "active" || isCutover(readJournal(journalPath(root)));
}

/**
 * Malformed publication witnesses are irrevocable damage signals: they are only
 * created as part of cutover publication, so they always seal legacy fallback.
 */
function publicationEvidenceDamaged(root: string): boolean {
  return cutoverWitnessState(root) === "invalid" || cutoverMarkerState(root) === "invalid";
}

/** True when the canonical subtree cannot be trusted as a real local directory. */
function controlStructureDamaged(root: string): boolean {
  try {
    const mazzy = lstatSync(join(root, ".mazzy"));
    if (!mazzy.isDirectory() || mazzy.isSymbolicLink()) return true;
    const control = lstatSync(controlDirectory(root));
    return !control.isDirectory() || control.isSymbolicLink();
  } catch { return false; }
}

/**
 * Damage seals only when it can denote a requested cutover. Invalid external
 * publication evidence seals unconditionally; an invalid journal or substituted
 * canonical directory may also be an interrupted first migration, so it seals
 * only with affirmative activation evidence (or the process break-glass override).
 */
export function cutoverDamaged(root: string, breakGlass = false): boolean {
  if (publicationEvidenceDamaged(root)) return true;
  const journal = readJournal(journalPath(root));
  if (journal !== "invalid" && !controlStructureDamaged(root)) return false;
  return breakGlass || durableCutoverObserved(root) || isPromoted(journal);
}

// ---- identity + fs-digest stamp (F8: distinguishes copied checkouts) ----

/**
 * Stamp the canonical DB with the project identity AND a per-DB-salted digest of
 * the trusted root's (dev:ino). A cp -r copy has a different root inode, so its
 * fs digest will not match — this is the platform-independent F8 detector that
 * the registry (Linux-only) corroborates. No raw inode or host path is stored.
 */
export function stampCanonicalIdentity(target: string, projectId: string, rootFsDigest: string, promotedAt = new Date().toISOString()): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(target);
    db.exec("CREATE TABLE IF NOT EXISTS mazzy_control_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),project_id TEXT NOT NULL,root_fs_digest TEXT,promoted_at TEXT NOT NULL)");
    // Additive column for DBs stamped before the fs-digest existed.
    try { db.exec("ALTER TABLE mazzy_control_identity ADD COLUMN root_fs_digest TEXT"); } catch { /* already present */ }
    db.prepare("INSERT INTO mazzy_control_identity(singleton,project_id,root_fs_digest,promoted_at) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET project_id=excluded.project_id,root_fs_digest=excluded.root_fs_digest,promoted_at=excluded.promoted_at").run(projectId, rootFsDigest, promotedAt);
  } finally { db?.close(); }
}

export type IdentityVerdict = "match" | "mismatch" | "fs-mismatch" | "fs-absent" | "absent" | "unreadable";

/**
 * Verify the canonical DB identity through a read-only connection.
 * - "match": project id matches AND the root fs digest matches.
 * - "fs-mismatch": project id matches but the root fs digest differs => a copied
 *   checkout (F8). Fail closed.
 * - "fs-absent": project id matches but NO fs digest was stamped (a pre-fix
 *   promotion). Fail closed under cutover: an unstamped store gives no F8
 *   protection, so it must not be auto-selected without an explicit re-promotion.
 * - "mismatch": project id differs. "absent": no stamp. "unreadable": error.
 */
export function verifyCanonicalIdentity(target: string, root: string, rootFsDigest: string): IdentityVerdict {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mazzy_control_identity'").get();
    if (!table) return "absent";
    const row = db.prepare("SELECT project_id, root_fs_digest FROM mazzy_control_identity WHERE singleton=1").get() as { project_id?: unknown; root_fs_digest?: unknown } | undefined;
    if (typeof row?.project_id !== "string") return "absent";
    if (row.project_id !== readProjectIdentity(root).descriptor.projectId) return "mismatch";
    const stamped = typeof row.root_fs_digest === "string" ? row.root_fs_digest : "";
    // A blank stamp gives no F8 protection => fail closed (was a silent bypass).
    if (stamped.length === 0) return "fs-absent";
    if (stamped !== rootFsDigest) return "fs-mismatch";
    return "match";
  } catch { return "unreadable"; } finally { db?.close(); }
}