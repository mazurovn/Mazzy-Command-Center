import { gitCheck } from "./git-safe.ts";
import { existsSync, lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  inspectMazzyProjectDirectory, resolveLegacyOpsDbPath, resolveOpsDbPathDiagnostic,
  resolveTrustedProjectRoot, rootFsDigest, type MazzyDbResolutionSource,
} from "./project.ts";
import { CONTROL_TABLES, type IdentityVerdict, type JournalState, readJournal, realDirectory, realFile, verifyCanonicalIdentity } from "./control-endpoint.ts";
import { resolveControlDb } from "./control-resolve.ts";

export type ControlDbTableName = "tasks" | "events" | "evidence" | "run_bindings" | "task_comments" | "orchestration_requests" | "review_reports" | "comment_notifications";
type IntegrityStatus = "ok" | "failed" | "unreadable";
type ForeignKeyStatus = "ok" | "violations" | "unreadable";
export type ControlDbProbe = {
  schemaVersion: 1;
  resolution: MazzyDbResolutionSource;
  identity: IdentityVerdict | "target-absent" | "override-skipped";
  legacyCandidates: number;
  legacy: { present: boolean; walResidue: boolean; integrity: IntegrityStatus; foreignKeys: ForeignKeyStatus; schemaVersion: number | null; rows: Record<ControlDbTableName, number> };
  /** Probe of the same endpoint the session would actually open. */
  active: { endpoint: "canonical" | "legacy" | "override"; present: boolean; walResidue: boolean; integrity: IntegrityStatus; foreignKeys: ForeignKeyStatus; schemaVersion: number | null; rows: Record<ControlDbTableName, number> };
  ignoreRuleObserved: boolean;
  migrationJournal: JournalState;
  /** Resolver state is diagnostic-only; paths never leave this probe. */
  effectiveEndpoint: "canonical" | "legacy" | "override";
  cutover: boolean;
  sealed: boolean;
};
export interface ControlDbProbeOptions { legacyPath?: string; resolution?: MazzyDbResolutionSource; }

const TABLES: ControlDbTableName[] = [...CONTROL_TABLES];
const emptyRows = (): Record<ControlDbTableName, number> => Object.fromEntries(TABLES.map((name) => [name, 0])) as Record<ControlDbTableName, number>;
const MAX_CANDIDATE_ENTRIES = 2048;
const MAX_CANDIDATE_DEPTH = 8;
const MAX_CANDIDATES = 64;

function hasTable(db: DatabaseSync, name: string): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
function probeLegacy(path: string): ControlDbProbe["legacy"] {
  const base = { present: existsSync(path), walResidue: existsSync(`${path}-wal`), integrity: "unreadable" as IntegrityStatus, foreignKeys: "unreadable" as ForeignKeyStatus, schemaVersion: null as number | null, rows: emptyRows() };
  if (!base.present) return base;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: unknown }>;
    base.integrity = integrity.every((row) => row.integrity_check === "ok") ? "ok" : "failed";
    base.foreignKeys = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length ? "violations" : "ok";
    if (hasTable(db, "schema_migrations")) {
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: unknown } | undefined;
      base.schemaVersion = row?.version === null || row?.version === undefined ? null : Number(row.version);
    }
    for (const table of TABLES) if (hasTable(db, table)) base.rows[table] = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: unknown }).count);
  } catch {
    base.integrity = "unreadable";
    base.foreignKeys = "unreadable";
    base.schemaVersion = null;
    base.rows = emptyRows();
  } finally { db?.close(); }
  return base;
}

/** Counts only regular legacy candidates, with fixed depth, entry, and result bounds. */
function legacyCandidateCount(root: string | undefined): number {
  if (!root) return 0;
  let entries = 0, found = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_CANDIDATE_DEPTH || entries >= MAX_CANDIDATE_ENTRIES || found >= MAX_CANDIDATES) return;
    let children: Dirent[];
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (entries++ >= MAX_CANDIDATE_ENTRIES || found >= MAX_CANDIDATES) return;
      if (child.isSymbolicLink()) continue;
      const candidate = join(directory, child.name);
      if (child.isDirectory()) {
        if (child.name !== ".git" && child.name !== "node_modules") visit(candidate, depth + 1);
      } else if (child.isFile() && child.name === "state.db") {
        try { if (lstatSync(directory).isDirectory() && directory.endsWith(".pi-ops")) found += 1; } catch { /* Ignore races and untrusted entries. */ }
      }
    }
  };
  visit(root, 0);
  return found;
}

function ignoredIdentity(root: string | undefined): boolean {
  if (!root) return false;
  try {
    // This is intentionally a boolean-only Git query; no output crosses the probe boundary.
    if (!gitCheck(root, ["check-ignore", "-q", "--", ".mazzy/project.json"])) throw new Error("not ignored");
    return true;
  } catch { return false; }
}

const regularFile = realFile;

function probeIdentity(root: string | undefined, resolution: MazzyDbResolutionSource): ControlDbProbe["identity"] {
  if (resolution === "explicit-override") return "override-skipped";
  if (!root || inspectMazzyProjectDirectory(root) !== "trusted") return "unreadable";
  const control = join(root, ".mazzy", "control"), target = join(control, "state.db");
  if (!existsSync(target)) return "target-absent";
  if (!realDirectory(control) || !regularFile(target)) return "unreadable";
  // Shared verifier includes both project identity and root fs digest (F8).
  return verifyCanonicalIdentity(target, root, rootFsDigest(root) ?? "");
}

function probeJournal(root: string | undefined): ControlDbProbe["migrationJournal"] {
  if (!root || inspectMazzyProjectDirectory(root) !== "trusted") return "invalid";
  const control = join(root, ".mazzy", "control"), migrate = join(control, "migrate"), journal = join(migrate, "journal.json");
  if (!existsSync(journal)) return "absent";
  if (!realDirectory(control) || !realDirectory(migrate) || !regularFile(journal)) return "invalid";
  // Single shared codec (was a third copy that could not read "absent"/"rolled-back").
  return readJournal(journal);
}

/** Read-only, path-free status probe. It never constructs the writable store or changes DB selection. */
export function probeControlDb(cwd: string, options: ControlDbProbeOptions = {}): ControlDbProbe {
  const diagnostic = options.resolution ? { source: options.resolution } : resolveOpsDbPathDiagnostic(cwd);
  // Always the explicit legacy path, so a future identity-gated resolver flip can
  // never make the "legacy" probe field silently describe the canonical store.
  const legacyPath = options.legacyPath ?? resolveLegacyOpsDbPath(cwd);
  const root = resolveTrustedProjectRoot(cwd);
  const resolution = resolveControlDb(cwd);
  return {
    schemaVersion: 1,
    resolution: diagnostic.source,
    identity: probeIdentity(root, diagnostic.source),
    legacyCandidates: legacyCandidateCount(root),
    legacy: probeLegacy(legacyPath),
    active: { endpoint: resolution.effectiveEndpoint, ...probeLegacy(resolution.path) },
    ignoreRuleObserved: ignoredIdentity(root),
    migrationJournal: probeJournal(root),
    effectiveEndpoint: resolution.effectiveEndpoint,
    cutover: resolution.cutover,
    sealed: resolution.sealed,
  };
}
