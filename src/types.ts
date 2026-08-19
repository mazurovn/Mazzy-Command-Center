// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

export const TASK_STATES = ["DRAFT", "BACKLOG", "READY", "CLAIMED", "RUNNING", "REVIEW", "BLOCKED", "DONE", "FAILED", "CANCELLED"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskRisk = "low" | "medium" | "high" | "critical";
/** Work-item classification for prioritization and planning. epic = large multi-task theme; feature = user-facing capability; task = ordinary unit of work (default); bug = defect fix. Additive: legacy rows backfill to "task". */
export const TASK_TYPES = ["epic", "feature", "task", "bug"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type RunRole = "worker" | "reviewer";
export type RunBindingState = "active" | "superseded" | "completed" | "failed";
export type RunLifecycle = "queued" | "running" | "paused" | "needs_attention" | "completed" | "failed" | "stopped";
export const RUN_LIFECYCLES = ["queued", "running", "paused", "needs_attention", "completed", "failed", "stopped"] as const;
export const MAX_TASK_COMMENT_LENGTH = 2_000;
export const MAX_CONTROL_INSTRUCTIONS_LENGTH = 4_000;
export const MAX_REPORT_FIELD_LENGTH = 12_000;
export const CONTROL_COMMANDS = ["GO", "PAUSE", "STOP"] as const;
export const CONTROL_REQUEST_STATES = ["REQUESTED", "DELIVERED", "CLAIMED", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
export type ControlRequestState = (typeof CONTROL_REQUEST_STATES)[number];

export const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ["BACKLOG", "CANCELLED"], BACKLOG: ["DRAFT", "READY", "CANCELLED"],
  READY: ["BACKLOG", "CLAIMED", "RUNNING", "BLOCKED", "CANCELLED"],
  CLAIMED: ["READY", "RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["REVIEW", "BLOCKED", "FAILED", "CANCELLED"],
  REVIEW: ["RUNNING", "READY", "DONE", "BLOCKED", "FAILED", "CANCELLED"],
  BLOCKED: ["BACKLOG", "READY", "RUNNING", "FAILED", "CANCELLED"], DONE: [],
  FAILED: ["BACKLOG", "READY", "CANCELLED"], CANCELLED: ["BACKLOG"],
};
/* DONE, RUNNING and REVIEW are attestation/assignment-gated (updateTask rejects a manual transition into any of them), so the dashboard must not offer them as direct move buttons — they are reached only through GO/completion/report attestation. */
export const UI_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = TASK_STATES.reduce((out, state) => {
  out[state] = ALLOWED_TRANSITIONS[state].filter((target) => target !== "DONE" && target !== "RUNNING" && target !== "REVIEW"); return out;
}, {} as Record<TaskState, readonly TaskState[]>);
export function isAllowedTransition(from: TaskState, to: TaskState): boolean { return ALLOWED_TRANSITIONS[from].includes(to); }

export interface MazzyTask {
  id: string; title: string; description: string; type: TaskType; state: TaskState; priority: number; risk: TaskRisk; executorActor?: string;
  /** Lifecycle concurrency token; completion/review transitions increment this. */ revision: number;
  /** Content acceptance token; only title/description changes increment this. */ acceptanceRevision: number; acceptanceDigest: string;
  createdAt: string; updatedAt: string;
}
export interface CreateTaskInput { title: string; description?: string; type?: TaskType; state?: TaskState; priority?: number; risk?: TaskRisk; actor?: string; /** Durable web-create replay key; parent calls need not supply one. */ idempotencyKey?: string; }
export interface UpdateTaskInput { title?: string; description?: string; type?: TaskType; state?: TaskState; priority?: number; risk?: TaskRisk; expectedRevision?: number; actor?: string; }

export type EvidenceVerdict = "PASS" | "FAIL" | "UNCERTAIN";
export interface MazzyEvidence { id: string; taskId: string; taskRevision: number; acceptanceRevision: number; kind: string; verdict: EvidenceVerdict; actor: string; payload: unknown; createdAt: string; runId?: string; bindingId?: string; }
export interface RecordEvidenceInput { kind: string; verdict: EvidenceVerdict; actor: string; payload?: unknown; expectedTaskRevision: number; }
export const TASK_COMMENT_ROLES = ["user", "orchestrator", "worker", "reviewer", "system"] as const;
export type TaskCommentRole = (typeof TASK_COMMENT_ROLES)[number];
export const TASK_COMMENT_DELIVERY_STATES = ["sent", "acknowledged", "failed"] as const;
export type TaskCommentDeliveryState = (typeof TASK_COMMENT_DELIVERY_STATES)[number];
/** `sending` is deliberately client-only and is never accepted or persisted. */
export interface MazzyTaskComment { id: string; taskId: string; body: string; actor: string; role: TaskCommentRole; deliveryState: TaskCommentDeliveryState; clientMessageId?: string; replyTo?: string; runId?: string; sessionId?: string; createdAt: string; acknowledgedAt?: string; error?: string; }
export interface AddTaskCommentInput { body: string; actor: string; role?: TaskCommentRole; clientMessageId?: string; replyTo?: string; runId?: string; sessionId?: string; }
export interface CommentResponseInput { body: string; replyTo?: string; runId?: string; }

export interface MazzyRunBinding {
  /** Immutable task revision captured when this assignment was created; not a lifecycle concurrency token. */
  id: string; taskId: string; taskRevision: number; acceptanceRevision: number; acceptanceDigest?: string; runId: string; agent: string; role: RunRole; state: RunBindingState;
  idempotencyKey: string; operationFingerprint: string; parentSessionId?: string; childSessionId?: string;
  lifecycle: RunLifecycle; model?: string; cycle?: number; lastActivityAt?: string; currentActivity?: string; currentTool?: string;
  createdAt: string; updatedAt: string;
}
export interface AssignRunInput { taskId: string; expectedTaskRevision: number; runId: string; agent: string; role: RunRole; idempotencyKey: string; actor: string; parentSessionId?: string; childSessionId?: string; payload?: unknown; model?: string; cycle?: number; }
export interface TransferRunInput { taskId: string; expectedTaskRevision: number; runId: string; agent: string; idempotencyKey: string; actor: string; parentSessionId?: string; childSessionId?: string; payload?: unknown; model?: string; cycle?: number; }
export interface UpdateRunActivityInput { taskId: string; runId: string; lifecycle: RunLifecycle; model?: string; cycle?: number; currentActivity?: string | null; currentTool?: string | null; actor: string; }

export interface ReviewReportInput { summary: string; whatChanged: string; checks: string; howToUse: string; acceptanceCriteria: unknown; results: unknown; limitations: string; model?: string; agent?: string; sessionId?: string; runId?: string; cycle?: number; }
export interface MazzyReviewReport extends ReviewReportInput { id: string; taskId: string; acceptanceRevision: number; workerRunId: string; agent: string; parentSessionId?: string; childSessionId?: string; createdAt: string; updatedAt: string; }
export interface CompletionAttestationInput { taskId: string; expectedTaskRevision: number; runId: string; actor: string; payload?: unknown; report?: ReviewReportInput; }
export interface ReviewerEvidenceInput { expectedTaskRevision: number; runId: string; kind: string; verdict: EvidenceVerdict; payload?: unknown; actor: string; }
export interface CompletionAttestation { accepted: boolean; reason?: "unknown-run" | "stale-or-superseded" | "revision-conflict" | "invalid-task-state" | "report-required" | "report-conflict"; task?: MazzyTask; binding?: MazzyRunBinding; }

export interface MazzyControlRequest {
  /** Response-only signal: a different GO click joined the original pending row. */
  coalesced?: boolean;
  id: string; idempotencyKey: string; operationFingerprint: string; taskId: string; expectedTaskRevision: number; command: ControlCommand; state: ControlRequestState;
  approvedAgent?: string; instructions?: string; maxCycles: number; targetRunId?: string; parentSessionId?: string; childSessionId?: string; childRunId?: string;
  requestedAt: string; deliveredAt?: string; claimedAt?: string; completedAt?: string; failedAt?: string; cancelledAt?: string; recoveredAt?: string; recoveryReason?: string; error?: string;
}
export interface CreateControlRequestInput { taskId: string; expectedTaskRevision: number; command: ControlCommand; idempotencyKey: string; approvedAgent?: string; instructions?: string; maxCycles?: number; targetRunId?: string; parentSessionId?: string; }
export interface ClaimControlRequestInput { id: string; parentSessionId: string; }
export interface CompleteControlRequestInput { id: string; childSessionId?: string; childRunId?: string; outcome?: string; }
export interface FailControlRequestInput { id: string; error: string; }

/** A quality gate is a read-only projection over durable facts (evidence, report, bindings), never a new writable state. status is computed, not stored, so it can never be faked by a comment or self-report. */
export const QUALITY_GATE_STATUSES = ["PASS", "FAIL", "PENDING", "MISSING", "STALE", "N/A"] as const;
export type QualityGateStatus = (typeof QUALITY_GATE_STATUSES)[number];
export const QUALITY_GATE_CATEGORIES = ["independent-review", "worker-report", "acceptance-freshness", "binding-integrity", "orchestration"] as const;
export type QualityGateCategory = (typeof QUALITY_GATE_CATEGORIES)[number];
export interface QualityGate { id: string; label: string; category: QualityGateCategory; required: boolean; status: QualityGateStatus; detail: string; }
/** Aggregate readiness the dashboard renders as an audit summary: whether every required gate is satisfied for the current acceptance. */
export interface QualityGateSummary { gates: QualityGate[]; requiredTotal: number; requiredPassed: number; blocking: number; readyForDone: boolean; }
export interface MazzyTaskDetail { task: MazzyTask; comments: MazzyTaskComment[]; bindings: MazzyRunBinding[]; requests: MazzyControlRequest[]; report?: MazzyReviewReport; reportStatus: "present" | "report missing" | "stale"; evidence: Array<MazzyEvidence & { freshness: "current" | "stale" }>; events: MazzyEvent[]; inconsistencies: string[]; qualityGates: QualityGateSummary; }
export interface MazzyEvent { id: number; taskId: string; type: string; payload: unknown; actor: string; createdAt: string; }
export interface MazzySnapshot { tasks: MazzyTask[]; counts: Record<TaskState, number>; states: readonly TaskState[]; allowedTransitions: Readonly<Record<TaskState, readonly TaskState[]>>; uiTransitions: Readonly<Record<TaskState, readonly TaskState[]>>; latestEventId: number; }
/** The exact durable-store surface the HTTP transport is allowed to touch. The server depends on this narrow port, never on the concrete MazzyStore, so the raw SQLite handle (`db`) and the absolute DB `path` are structurally unreachable from the transport layer (ADR-001 INV-2/INV-3). */
export interface ControlPlanePort {
  snapshot(): MazzySnapshot;
  getTaskDetail(taskId: string): MazzyTaskDetail | undefined;
  getTask(id: string): MazzyTask | undefined;
  createTask(input: CreateTaskInput): MazzyTask;
  updateTask(id: string, input: UpdateTaskInput): MazzyTask;
  listComments(taskId: string): MazzyTaskComment[];
  addComment(taskId: string, input: AddTaskCommentInput): MazzyTaskComment;
  listControlRequests(taskId: string): MazzyControlRequest[];
  getControlRequest(id: string): MazzyControlRequest | undefined;
  createControlRequest(input: CreateControlRequestInput): MazzyControlRequest;
  markDelivered(id: string): MazzyControlRequest;
  claimControlRequest(input: ClaimControlRequestInput): MazzyControlRequest;
  reconcileOneClaimedRequest(ownerAvailable: (sessionId: string) => boolean): MazzyControlRequest | undefined;
  nextUndeliveredControlRequest(): MazzyControlRequest | undefined;
  listBindings(taskId: string): MazzyRunBinding[];
  listEvents(afterId?: number, limit?: number): MazzyEvent[];
  latestEventId(): number;
  subscribeEvents(listener: (event: MazzyEvent) => void): () => void;
  unnotifiedComments(sessionId: string): MazzyTaskComment[];
  claimCommentNotification(taskId: string, commentId: string, sessionId: string): boolean;
}