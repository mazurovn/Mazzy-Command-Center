import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { MazzyStore } from "./store.ts";
import { legacyStorePathStrict, readProjectIdentity, resolveTrustedProjectRoot } from "./project.ts";
import { canonicalStorePathOf, resolveControlDb } from "./control-resolve.ts";
import { durableCutoverObserved, sameFile } from "./control-endpoint.ts";
import type { TaskState, TaskType } from "./types.ts";

/**
 * Unified project data-movement — safe first slice: evidence-contained,
 * cross-project TRANSFER / FORK of selected tasks between control DBs.
 *
 * Design:
 *  - STRUCTURAL evidence containment: import goes ONLY through MazzyStore.createTask
 *    / addComment (the public, guarded writer). It is physically impossible for a
 *    move to insert an evidence / run_binding / review_report row or to set a task
 *    DONE, because createTask refuses any state other than DRAFT/BACKLOG and never
 *    touches the authority tables. Forged PASS/DONE is therefore not policy-blocked
 *    but impossible by construction.
 *  - Every imported task is CLAMPED to BACKLOG, gets a FRESH id (no UUID collision,
 *    no overwrite of an existing destination task), acceptance resets to 1.
 *  - Comments are copied as history only (never evidence); reply threading and
 *    run/session metadata are dropped.
 *  - Bindings, evidence, reports, orchestration requests, events, notifications are
 *    NEVER imported (reported as dropped counts only).
 *  - Dry-run first: plan() returns counts + redacted digests and mutates nothing.
 *  - Source is never modified or deleted (copy, not move).
 *  - INV-3: only redacted relative-path digests cross the boundary, never a host path.
 *
 * This slice deliberately does NOT do: same-project id-preserving relocation,
 * merge into overlapping id-space, generation lease, or source retirement — those
 * are later phases in epic fb8a4408 / the unified-move epic.
 */

export type MoveOp = "transfer" | "fork" | "merge";

export type MoveSelection =
  | { kind: "all" }
  | { kind: "tasks"; taskIds: readonly string[] }
  | { kind: "state"; states: readonly TaskState[] };

export const MAX_SELECTED_TASKS = 500;

export type MoveEndpoint =
  // "active" routes through resolveControlDb — the SAME DB the session/tools/web use
  // (canonical under cutover, else legacy). This is the correct default so a move
  // never lands in a store the session cannot see.
  | { kind: "active"; cwd: string }
  | { kind: "canonical"; cwd: string }
  | { kind: "legacy"; cwd: string };

export interface MoveRequest {
  op: MoveOp;
  source: MoveEndpoint;
  destination: MoveEndpoint;
  selection: MoveSelection;
  actor: string;
  apply?: boolean;
}

export type MoveRefusal =
  | "source-unresolved" | "destination-unresolved" | "source-absent"
  | "same-endpoint" | "selection-empty" | "selection-too-large";

export interface MovePlan {
  schemaVersion: 1;
  op: MoveOp;
  sourceDigest: string;
  destinationDigest: string;
  selectedTasks: number;
  /** Rows that will be imported live (tasks + comments). */
  willImport: { tasks: number; comments: number };
  /** Authority rows deliberately NOT imported (reported for transparency). */
  dropped: { evidence: number; bindings: number; reports: number; nonBacklogClamped: number };
  refusals: MoveRefusal[];
  ok: boolean;
}

export interface MoveResult {
  schemaVersion: 1;
  op: MoveOp;
  applied: boolean;
  ok: boolean;
  imported: { tasks: number; comments: number };
  /** Number of source tasks whose content already existed in the destination and collapsed (merge). */
  mergedDuplicates: number;
  /** Post-import assertion: these MUST all be 0 (structural containment proof). */
  containment: { liveEvidence: number; liveBindings: number; liveReports: number; doneImported: number };
  detail: string;
}

function endpointRoot(ep: MoveEndpoint): string | undefined { return resolveTrustedProjectRoot(ep.cwd); }
function endpointPath(ep: MoveEndpoint): string | undefined {
  const root = resolveTrustedProjectRoot(ep.cwd);
  if (!root) return undefined;
  // Structural write gate: a sealed resolution has no legal endpoint, including
  // explicit legacy/canonical forms.  This check is deliberately shared by plan
  // and apply so a path cannot be obtained between validation and opening.
  const resolution = resolveControlDb(ep.cwd);
  if (resolution.sealed) return undefined;
  if (ep.kind === "active") return resolution.path;
  // Explicit endpoints are never allowed to bypass the selected writer. In
  // particular, durable cutover retires legacy rather than merely hiding it.
  if (ep.kind === "legacy") {
    if (resolution.cutover || durableCutoverObserved(root)) return undefined;
    return resolution.effectiveEndpoint === "legacy" ? legacyStorePathStrict(ep.cwd) : undefined;
  }
  // kind:"canonical" is valid only when canonical is the active selected endpoint.
  if (resolution.effectiveEndpoint !== "canonical" || resolution.selection !== "canonical-promoted") return undefined;
  return canonicalStorePathOf(root);
}

/** Digest of the ROOT-RELATIVE path only (matches control-migrate's INV-3 convention);
 *  neither the absolute host path nor the project folder name is included. */
function redactDigest(path: string, root?: string): string {
  const rel = root ? relative(root, path).split(/[\\/]/).join("/") : path.split("/").slice(-2).join("/");
  return createHash("sha256").update(rel).digest("hex").slice(0, 16);
}

function sameFileByPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  // Endpoint aliasing is an inode/dev property, not a spelling property.
  return sameFile(a, b);
}

/** BACKLOG clamp: cross-project import may only produce DRAFT/BACKLOG (never earned state). */
function isNonBacklog(state: TaskState): boolean { return state !== "BACKLOG" && state !== "DRAFT"; }

interface SelectedTask {
  sourceId: string; title: string; description: string; type: TaskType; priority: number; risk: string; state: TaskState;
  comments: Array<{ body: string; role: string }>;
}

function selectTasks(store: MazzyStore, selection: MoveSelection): SelectedTask[] {
  let tasks = store.listTasks();
  if (selection.kind === "tasks") {
    const wanted = new Set(selection.taskIds);
    tasks = tasks.filter((t) => wanted.has(t.id));
  } else if (selection.kind === "state") {
    const wanted = new Set(selection.states);
    tasks = tasks.filter((t) => wanted.has(t.state));
  }
  return tasks.map((t) => ({
    sourceId: t.id, title: t.title, description: t.description, type: (t.type ?? "task") as TaskType,
    priority: t.priority, risk: t.risk, state: t.state,
    // Comments are history only; drop role-as-evidence, run/session metadata.
    comments: store.listComments(t.id).map((c) => ({ body: c.body, role: c.role })),
  }));
}

export function planDataMove(request: MoveRequest): MovePlan {
  const sourcePath = endpointPath(request.source);
  const destPath = endpointPath(request.destination);
  const sourceRoot = endpointRoot(request.source), destRoot = endpointRoot(request.destination);
  const sourceDigest = sourcePath ? redactDigest(sourcePath, sourceRoot) : "unresolved";
  const destinationDigest = destPath ? redactDigest(destPath, destRoot) : "unresolved";
  const refusals: MoveRefusal[] = [];
  if (!sourcePath) refusals.push("source-unresolved");
  if (!destPath) refusals.push("destination-unresolved");
  if (sourcePath && !existsSync(sourcePath)) refusals.push("source-absent");
  if (sourcePath && destPath && sameFileByPath(sourcePath, destPath)) refusals.push("same-endpoint");

  let selectedTasks = 0, comments = 0, evidence = 0, bindings = 0, reports = 0, nonBacklogClamped = 0;
  if (sourcePath && existsSync(sourcePath) && refusals.length === 0) {
    const store = new MazzyStore(sourcePath);
    try {
      const selected = selectTasks(store, request.selection);
      selectedTasks = selected.length;
      if (selectedTasks === 0) refusals.push("selection-empty");
      if (selectedTasks > MAX_SELECTED_TASKS) refusals.push("selection-too-large");
      // Determine which source task ids are in-selection, then count the authority
      // rows (evidence/bindings/reports) that will be DROPPED, and comments imported.
      const inSelection = (task: { id: string; state: TaskState }): boolean =>
        request.selection.kind === "all"
        || (request.selection.kind === "tasks" && (request.selection.taskIds as readonly string[]).includes(task.id))
        || (request.selection.kind === "state" && (request.selection.states as readonly TaskState[]).includes(task.state));
      for (const task of store.listTasks()) {
        if (!inSelection(task)) continue;
        if (isNonBacklog(task.state)) nonBacklogClamped += 1;
        const d = store.getTaskDetail(task.id);
        if (d) {
          comments += d.comments.length;
          evidence += d.evidence.length;
          bindings += d.bindings.length;
          reports += d.reportStatus === "present" ? 1 : 0;
        }
      }
    } finally { store.close(); }
  }

  return {
    schemaVersion: 1, op: request.op, sourceDigest, destinationDigest,
    selectedTasks,
    willImport: { tasks: selectedTasks, comments },
    dropped: { evidence, bindings, reports, nonBacklogClamped },
    refusals, ok: refusals.length === 0 && selectedTasks > 0,
  };
}

export function applyDataMove(request: MoveRequest): MoveResult {
  const plan = planDataMove({ ...request, apply: false });
  if (!plan.ok) {
    return { schemaVersion: 1, op: request.op, applied: false, ok: false, imported: { tasks: 0, comments: 0 }, mergedDuplicates: 0, containment: { liveEvidence: 0, liveBindings: 0, liveReports: 0, doneImported: 0 }, detail: `Refused: ${plan.refusals.join(", ") || "empty selection"}.` };
  }
  if (request.apply !== true) {
    return { schemaVersion: 1, op: request.op, applied: false, ok: true, imported: { tasks: 0, comments: 0 }, mergedDuplicates: 0, containment: { liveEvidence: 0, liveBindings: 0, liveReports: 0, doneImported: 0 }, detail: "Dry-run: pass apply=true to import the selected tasks (BACKLOG, fresh ids, history-only comments)." };
  }
  const sourcePath = endpointPath(request.source)!;
  const destPath = endpointPath(request.destination)!;
  // Cross-process move lock on the destination: O_CREAT|O_EXCL so two concurrent
  // moves into the same destination can't interleave. Stale locks (>2 min) are
  // reclaimed. Reuses the project-registry lock discipline.
  const lock = acquireMoveLock(destPath);
  if (!lock.ok) {
    return { schemaVersion: 1, op: request.op, applied: false, ok: false, imported: { tasks: 0, comments: 0 }, mergedDuplicates: 0, containment: { liveEvidence: 0, liveBindings: 0, liveReports: 0, doneImported: 0 }, detail: "Another data-move into this destination is in progress (lock busy); retry shortly." };
  }
  try {
  const source = new MazzyStore(sourcePath);
  let selected: SelectedTask[];
  try { selected = selectTasks(source, request.selection); } finally { source.close(); }

  const dest = new MazzyStore(destPath);
  // Scope the transfer/fork idempotency key by the SOURCE PROJECT IDENTITY, not the
  // path (which is the constant ".pi-ops/state.db" for every legacy endpoint). This
  // fixes the audit HIGH: two different source projects that happen to share task
  // ids (e.g. a cp -r copied checkout, F8) would otherwise collide and silently drop
  // the second source. Falls back to a path digest when identity is unavailable.
  const sourceRoot = endpointRoot(request.source);
  let sourceScope = redactDigest(sourcePath, sourceRoot);
  try { if (sourceRoot) sourceScope = readProjectIdentity(sourceRoot).descriptor.projectId; } catch { /* no identity: keep path digest */ }
  const sourceDigest = sourceScope;
  let importedTasks = 0, importedComments = 0, mergedDuplicates = 0;
  const importedIds: string[] = [];
  // Ids that already existed in the destination BEFORE this batch. Any createTask that
  // returns one of these (or a repeat within the batch) is a dedup replay, not an insert.
  const preExisting = new Set(dest.listTasks().map((t) => t.id));
  try {
    for (const t of selected) {
      // Idempotency key controls dedup semantics:
      //  - transfer/fork: keyed by (source digest, source task id) so re-applying the
      //    same source is idempotent, but two DIFFERENT sources stay distinct.
      //  - merge: keyed by CONTENT (title+description) so identical-content tasks from
      //    ANY project collapse into one in the overlapping destination id-space — a
      //    union without duplicates. createTask's content-fingerprint check still guards
      //    against a key reused with different content.
      const idempotencyKey = request.op === "merge"
        ? createHash("sha256").update(`merge\0${t.title}\0${t.description}`).digest("hex").slice(0, 40)
        : createHash("sha256").update(`${sourceDigest}\0${t.sourceId}`).digest("hex").slice(0, 40);
      // createTask refuses any non-DRAFT/BACKLOG state and never writes authority tables:
      // this is the structural containment guarantee. State is clamped to BACKLOG.
      let created;
      try {
        created = dest.createTask({
          title: t.title, description: t.description, type: t.type,
          priority: t.priority, risk: t.risk as never, state: "BACKLOG",
          actor: request.actor, idempotencyKey,
        });
      } catch (error) {
        // merge dedup: same content key with differing metadata (priority/risk/type) means
        // this content already exists in the destination — a union collapse, not an error.
        if (request.op === "merge" && /Idempotency key conflict/.test((error as Error).message)) { mergedDuplicates += 1; continue; }
        throw error;
      }
      // Accurate classification: a returned id that pre-existed or repeats within this
      // batch is a dedup collapse (no new row), otherwise a genuine import.
      const replay = preExisting.has(created.id) || importedIds.includes(created.id);
      if (replay) { mergedDuplicates += 1; continue; }
      importedIds.push(created.id);
      importedTasks += 1;
      for (const c of t.comments) {
        // Comments imported as system history; never as evidence, never threaded to foreign ids.
        dest.addComment(created.id, { body: `[imported] ${c.body}`.slice(0, 1900), actor: request.actor, role: "system" });
        importedComments += 1;
      }
    }
    // Post-import containment assertion: a REAL query over the imported task ids proves
    // no authority rows and no non-BACKLOG state leaked in (defense in depth).
    const containment = assertContainment(dest, importedIds);
    const ok = containment.liveEvidence === 0 && containment.liveBindings === 0 && containment.liveReports === 0 && containment.doneImported === 0;
    return {
      schemaVersion: 1, op: request.op, applied: true, ok,
      imported: { tasks: importedTasks, comments: importedComments },
      mergedDuplicates,
      containment,
      detail: ok
        ? `Imported ${importedTasks} task(s) as BACKLOG with ${importedComments} history comment(s)${request.op === "merge" ? `; ${mergedDuplicates} duplicate(s) collapsed` : ""}; no evidence/bindings/reports/DONE crossed over.`
        : "Containment assertion FAILED after import; this is a bug — investigate immediately.",
    };
  } finally { dest.close(); }
  } finally { lock.release(); }
}

/** Token-owned move lock: never take over a live owner merely because its mtime is old. */
function acquireMoveLock(destPath: string): { ok: true; release: () => void } | { ok: false } {
  const dir = dirname(destPath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  const lockPath = `${destPath}.mazzy-move.lock`;
  const token = `${process.pid}-${Date.now()}-${randomBytes(16).toString("hex")}`;
  try {
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })); } finally { closeSync(fd); }
  } catch { return { ok: false }; }
  return { ok: true, release: () => {
    try {
      const value = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
      if (value.token === token) unlinkSync(lockPath);
    } catch { /* changed/unavailable lock is not ours to remove */ }
  } };
}

/** Real post-import containment check: for every imported task id, query the destination
 *  store's own detail and count any authority rows (evidence/bindings/reports) or non-BACKLOG
 *  state. Structurally always zero (import goes only through createTask/addComment), but querying
 *  it makes MoveResult.containment a genuine runtime safety net instead of a hardcoded zero. */
function assertContainment(dest: MazzyStore, importedIds: readonly string[]): MoveResult["containment"] {
  let liveEvidence = 0, liveBindings = 0, liveReports = 0, doneImported = 0;
  for (const id of importedIds) {
    const d = dest.getTaskDetail(id);
    if (!d) continue;
    liveEvidence += d.evidence.length;
    liveBindings += d.bindings.length;
    liveReports += d.reportStatus === "present" ? 1 : 0;
    if (d.task.state === "DONE") doneImported += 1;
  }
  return { liveEvidence, liveBindings, liveReports, doneImported };
}
