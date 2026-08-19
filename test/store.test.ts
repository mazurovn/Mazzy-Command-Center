import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MazzyStore } from "../src/store.ts";
const parent = "interactive-parent";
const report = { summary: "Done", whatChanged: "Changed control slice", checks: "npm test", howToUse: "Open dashboard", acceptanceCriteria: ["tests"], results: { tests: "pass" }, limitations: "none" };
function fixture() { const dir = projectTemp("pi-ops-"); const store = new MazzyStore(join(dir, "state.db")); return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; }
function completedReview(f: ReturnType<typeof fixture>) { const t = f.store.createTask({ title: "Verified" }); const ready = f.store.updateTask(t.id, { state: "READY", expectedRevision: 1 }); const w = f.store.assignRun({ taskId: t.id, expectedTaskRevision: ready.revision, runId: "worker", agent: "worker-a", role: "worker", idempotencyKey: "worker-key", actor: parent }); assert.equal(f.store.attestCompletion({ taskId: t.id, expectedTaskRevision: w.taskRevision, runId: w.runId, report, actor: parent }).accepted, true); return f.store.getTask(t.id)!; }

const scratchRoot = testScratchRoot;
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }
type CasWork = { operation: "update" | "review-evidence"; taskId: string; input: Record<string, unknown> };
type CasResult = { ok: boolean; value?: unknown; error?: string };
/** Separate workers (not a process-local mutex) meet at an Atomics barrier before opening the same WAL DB. */
function raceCas(path: string, work: CasWork[]): Promise<CasResult[]> { const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2), gate = new Int32Array(barrier); return new Promise((resolve, reject) => { const results: CasResult[] = [], workers = work.map((item) => new Worker(new URL("./store-cas-worker.ts", import.meta.url), { workerData: { ...item, path, barrier } })); let ready = 0, settled = false; const fail = (error: Error) => { if (!settled) { settled = true; for (const worker of workers) worker.terminate().catch(() => {}); reject(error); } }; for (const worker of workers) { worker.on("message", (message: { type: "ready" | "result"; ok?: boolean; value?: unknown; error?: string }) => { if (message.type === "ready") { if (++ready === workers.length) { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1, workers.length); } return; } results.push({ ok: Boolean(message.ok), value: message.value, error: message.error }); if (results.length === workers.length && !settled) { settled = true; resolve(results); } }); worker.once("error", fail); worker.once("exit", (code) => { if (code !== 0 && results.length !== workers.length) fail(new Error(`CAS worker exited ${code}`)); }); } }); }

test("migrates populated legacy rows with acceptance and web-comment backfill", () => { const dir = projectTemp("legacy-"), path = join(dir, "state.db"), db = new DatabaseSync(path); db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,description TEXT,state TEXT,priority INTEGER,risk TEXT,revision INTEGER,created_at TEXT,updated_at TEXT); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,task_id TEXT,type TEXT,payload_json TEXT,actor TEXT,created_at TEXT); CREATE TABLE evidence(id TEXT PRIMARY KEY,task_id TEXT,task_revision INTEGER,kind TEXT,verdict TEXT,actor TEXT,payload_json TEXT,created_at TEXT); CREATE TABLE task_comments(id TEXT PRIMARY KEY,task_id TEXT,body TEXT,actor TEXT,created_at TEXT);"); db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("old","old title","old body","REVIEW",0,"medium",4,"a","b");db.prepare("INSERT INTO task_comments VALUES(?,?,?,?,?)").run("legacy-comment","old","old body","web","a"); db.close(); const store = new MazzyStore(path); try { const task = store.getTask("old")!; assert.equal(task.acceptanceRevision, 4); assert.match(task.acceptanceDigest, /^[a-f0-9]{64}$/); assert.deepEqual(store.listComments("old")[0]&&{role:store.listComments("old")[0].role,deliveryState:store.listComments("old")[0].deliveryState},{role:"user",deliveryState:"sent"}); assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='review_reports'").get()); } finally { store.close(); rmSync(dir,{recursive:true,force:true}); } });

test("two independent stores serialize same-revision task CAS and persist one update event", async () => { const f = fixture(); try { const t = f.store.createTask({ title: "CAS" }); const results = await raceCas(f.store.path, [{ operation: "update", taskId: t.id, input: { title: "winner-a", state: "BACKLOG", expectedRevision: t.revision, actor: "a" } }, { operation: "update", taskId: t.id, input: { title: "winner-b", state: "BACKLOG", expectedRevision: t.revision, actor: "b" } }]); assert.equal(results.filter((result) => result.ok).length, 1); assert.equal(results.filter((result) => /Revision conflict/.test(result.error ?? "")).length, 1); const winner = results.find((result) => result.ok)?.value as { title: string; state: string; revision: number }; assert.deepEqual(f.store.getTask(t.id) && { title: f.store.getTask(t.id)!.title, state: f.store.getTask(t.id)!.state, revision: f.store.getTask(t.id)!.revision }, winner && { title: winner.title, state: winner.state, revision: winner.revision }); assert.equal(f.store.getTask(t.id)?.state, "BACKLOG"); assert.equal(f.store.listEvents().filter((event) => event.taskId === t.id && event.type === "task.updated").length, 1); } finally { f.close(); } });

test("failed task CAS rolls back durable and fanout events", () => { const f = fixture(); try { const t = f.store.createTask({ title: "No event" }); f.store.updateTask(t.id, { state: "BACKLOG", expectedRevision: t.revision }); const before = f.store.listEvents().length, received: string[] = []; const unsubscribe = f.store.subscribeEvents((event) => received.push(event.type)); assert.throws(() => f.store.updateTask(t.id, { title: "stale", expectedRevision: t.revision }), /Revision conflict/); unsubscribe(); assert.equal(f.store.listEvents().length, before); assert.deepEqual(received, []); } finally { f.close(); } });

test("reviewer evidence is a one-shot transaction across two independent stores", async () => { const f = fixture(); try { const t = completedReview(f), reviewer = f.store.assignRun({ taskId: t.id, expectedTaskRevision: t.revision, runId: "review-race", agent: "reviewer-race", role: "reviewer", idempotencyKey: "review-race", actor: parent }); const results = await raceCas(f.store.path, [{ operation: "review-evidence", taskId: t.id, input: { expectedTaskRevision: t.revision, runId: reviewer.runId, kind: "review", verdict: "PASS", actor: "a" } }, { operation: "review-evidence", taskId: t.id, input: { expectedTaskRevision: t.revision, runId: reviewer.runId, kind: "review", verdict: "FAIL", actor: "b" } }]); assert.equal(results.filter((result) => result.ok).length, 1); assert.equal(results.filter((result) => /Active reviewer binding/.test(result.error ?? "")).length, 1); assert.equal(f.store.listEvidence(t.id).filter((evidence) => evidence.bindingId === reviewer.id).length, 1); assert.equal(f.store.listEvents().filter((event) => event.taskId === t.id && event.type === "evidence.attested").length, 1); } finally { f.close(); } });

test("barrier-raced FAIL and DONE serialize the current reviewer gate", async () => { const f = fixture(); try { const t = completedReview(f); const pass = f.store.assignRun({ taskId: t.id, expectedTaskRevision: t.revision, runId: "review-pass-race", agent: "reviewer-pass", role: "reviewer", idempotencyKey: "pass-race", actor: parent }); f.store.recordReviewerEvidence(t.id, { expectedTaskRevision: t.revision, runId: pass.runId, kind: "review", verdict: "PASS", actor: parent }); const fail = f.store.assignRun({ taskId: t.id, expectedTaskRevision: t.revision, runId: "review-fail-race", agent: "reviewer-fail", role: "reviewer", idempotencyKey: "fail-race", actor: parent }); const results = await raceCas(f.store.path, [{ operation: "update", taskId: t.id, input: { state: "DONE", expectedRevision: t.revision, actor: "done" } }, { operation: "review-evidence", taskId: t.id, input: { expectedTaskRevision: t.revision, runId: fail.runId, kind: "review", verdict: "FAIL", actor: "fail" } }]); assert.equal(results.filter((result) => result.ok).length, 1); const final = f.store.getTask(t.id)!; const hasFail = f.store.listEvidence(t.id).some((evidence) => evidence.bindingId === fail.id && evidence.verdict === "FAIL"); if (hasFail) { assert.equal(final.state, "REVIEW"); assert.match(results.find((result) => !result.ok)?.error ?? "", /latest conclusive/); } else { assert.equal(final.state, "DONE"); assert.match(results.find((result) => !result.ok)?.error ?? "", /(Active reviewer binding|Revision conflict)/); } } finally { f.close(); } });

test("acceptance PASS remains current after DONE and later same-acceptance FAIL blocks DONE", () => { const f = fixture(); try { const t = completedReview(f); const pass = f.store.assignRun({ taskId:t.id,expectedTaskRevision:t.revision,runId:"review-pass",agent:"reviewer-a",role:"reviewer",idempotencyKey:"pass",actor:parent }); f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:pass.runId,kind:"review",verdict:"PASS",actor:parent}); assert.equal(f.store.getTaskDetail(t.id)!.evidence[0]?.freshness,"current"); const fail=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"review-fail",agent:"reviewer-b",role:"reviewer",idempotencyKey:"fail",actor:parent}); f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:fail.runId,kind:"review",verdict:"FAIL",actor:parent}); assert.throws(()=>f.store.updateTask(t.id,{state:"DONE",expectedRevision:t.revision}),/latest conclusive/); } finally { f.close(); } });

test("RUNNING acceptance edit atomically supersedes binding, REVIEW requires its report attestation, and transfer recovers no-worker RUNNING", () => { const f=fixture(); try { const t=f.store.createTask({title:"A"}), ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1}), w=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"old",agent:"a",role:"worker",idempotencyKey:"old",actor:parent}); assert.throws(()=>f.store.updateTask(t.id,{state:"REVIEW",expectedRevision:w.taskRevision}),/completion attestation/); const edited=f.store.updateTask(t.id,{description:"changed",expectedRevision:w.taskRevision}); assert.deepEqual({state:edited.state,acceptanceRevision:edited.acceptanceRevision},{state:"READY",acceptanceRevision:2}); assert.equal(f.store.listBindings(t.id)[0]?.state,"superseded"); const x=f.store.createTask({title:"X"}), xr=f.store.updateTask(x.id,{state:"READY",expectedRevision:1}), xw=f.store.assignRun({taskId:x.id,expectedTaskRevision:xr.revision,runId:"gone",agent:"a",role:"worker",idempotencyKey:"gone",actor:parent}); f.store.db.prepare("UPDATE run_bindings SET state='superseded' WHERE id=?").run(xw.id); const recovered=f.store.transferRun({taskId:x.id,expectedTaskRevision:xw.taskRevision,runId:"replacement",agent:"b",idempotencyKey:"replacement",actor:parent}); assert.equal(recovered.state,"active"); } finally {f.close();} });

test("REVIEW acceptance edits reject stale completion authority until a fresh independent review passes", () => { const f=fixture(); try {
  const created=f.store.createTask({title:"acceptance N",description:"original"}),ready=f.store.updateTask(created.id,{state:"READY",expectedRevision:created.revision}),oldWorker=f.store.assignRun({taskId:created.id,expectedTaskRevision:ready.revision,runId:"worker-n",agent:"worker-n",role:"worker",idempotencyKey:"worker-n",actor:parent});
  assert.equal(f.store.attestCompletion({taskId:created.id,expectedTaskRevision:oldWorker.taskRevision,runId:oldWorker.runId,report,actor:parent}).accepted,true);
  const reviewed=f.store.getTask(created.id)!;
  assert.equal(f.store.attestCompletion({taskId:created.id,expectedTaskRevision:reviewed.revision,runId:oldWorker.runId,report,actor:parent}).accepted,true,"same acceptance/report replay is idempotent");
  assert.deepEqual(f.store.attestCompletion({taskId:created.id,expectedTaskRevision:reviewed.revision,runId:oldWorker.runId,report:{...report,summary:"different replay"},actor:parent}),{accepted:false,reason:"report-conflict",binding:f.store.listBindings(created.id).find((binding)=>binding.runId===oldWorker.runId)});
  const oldReviewer=f.store.assignRun({taskId:created.id,expectedTaskRevision:reviewed.revision,runId:"reviewer-n",agent:"reviewer-n",role:"reviewer",idempotencyKey:"reviewer-n",actor:parent});
  f.store.recordReviewerEvidence(created.id,{expectedTaskRevision:reviewed.revision,runId:oldReviewer.runId,kind:"review",verdict:"PASS",actor:parent});
  const activeReviewer=f.store.assignRun({taskId:created.id,expectedTaskRevision:reviewed.revision,runId:"active-reviewer-n",agent:"active-reviewer-n",role:"reviewer",idempotencyKey:"active-reviewer-n",actor:parent});
  const eventsBefore=f.store.getTaskDetail(created.id)!.events.length;
  const revised=f.store.updateTask(created.id,{title:"acceptance N+1",expectedRevision:reviewed.revision});
  assert.deepEqual({state:revised.state,acceptanceRevision:revised.acceptanceRevision},{state:"READY",acceptanceRevision:2});
  assert.notEqual(revised.acceptanceDigest,reviewed.acceptanceDigest);
  assert.equal(f.store.listBindings(created.id).find((binding)=>binding.id===activeReviewer.id)?.state,"superseded");
  assert.throws(()=>f.store.importReviewReport(created.id,oldWorker.runId,revised.revision,report,parent),/current acceptance/);
  assert.equal(f.store.getReviewReport(created.id,revised.acceptanceRevision),undefined);
  assert.equal(f.store.getTaskDetail(created.id)!.events.length,eventsBefore+2,"only acceptance-edit events are durable");
  assert.throws(()=>f.store.assignRun({taskId:created.id,expectedTaskRevision:revised.revision,runId:"stale-reviewer",agent:"stale-reviewer",role:"reviewer",idempotencyKey:"stale-reviewer",actor:parent}),/current acceptance/);
  const freshWorker=f.store.assignRun({taskId:created.id,expectedTaskRevision:revised.revision,runId:"worker-n-plus-1",agent:"worker-n-plus-1",role:"worker",idempotencyKey:"worker-n-plus-1",actor:parent});
  assert.equal(f.store.attestCompletion({taskId:created.id,expectedTaskRevision:freshWorker.taskRevision,runId:freshWorker.runId,report:{...report,summary:"fresh"},actor:parent}).accepted,true);
  const freshReview=f.store.getTask(created.id)!;
  assert.throws(()=>f.store.updateTask(created.id,{state:"DONE",expectedRevision:freshReview.revision}),/latest conclusive/,"old acceptance evidence cannot close fresh acceptance");
  const freshReviewer=f.store.assignRun({taskId:created.id,expectedTaskRevision:freshReview.revision,runId:"reviewer-n-plus-1",agent:"reviewer-n-plus-1",role:"reviewer",idempotencyKey:"reviewer-n-plus-1",actor:parent});
  const lifecycleOnly=f.store.updateTask(created.id,{priority:17,expectedRevision:freshReview.revision});
  assert.deepEqual({state:lifecycleOnly.state,acceptanceRevision:lifecycleOnly.acceptanceRevision,acceptanceDigest:lifecycleOnly.acceptanceDigest},{state:"REVIEW",acceptanceRevision:freshReview.acceptanceRevision,acceptanceDigest:freshReview.acceptanceDigest},"lifecycle-only REVIEW edit preserves acceptance and state");
  f.store.recordReviewerEvidence(created.id,{expectedTaskRevision:lifecycleOnly.revision,runId:freshReviewer.runId,kind:"review",verdict:"PASS",actor:parent});
  assert.equal(f.store.updateTask(created.id,{state:"DONE",expectedRevision:lifecycleOnly.revision}).state,"DONE");
} finally { f.close(); } });

test("PAUSE and STOP claim across metadata/no-op drift but reject transferred or changed-acceptance targets", () => { const f=fixture(); try {
  const t=f.store.createTask({title:"control epoch"});
  const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:t.revision});
  const original=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"active-worker",agent:"worker",role:"worker",idempotencyKey:"active-worker",actor:parent});
  const pause=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:original.taskRevision,command:"PAUSE",targetRunId:original.runId,idempotencyKey:"pause-before-metadata"});
  const metadata=f.store.updateTask(t.id,{priority:9,expectedRevision:original.taskRevision});
  assert.equal(f.store.claimControlRequest({id:pause.id,parentSessionId:parent}).state,"CLAIMED");
  const stop=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:metadata.revision,command:"STOP",targetRunId:original.runId,idempotencyKey:"stop-before-noop"});
  const noop=f.store.updateTask(t.id,{expectedRevision:metadata.revision});
  assert.equal(f.store.claimControlRequest({id:stop.id,parentSessionId:parent}).state,"CLAIMED");
  assert.throws(()=>f.store.createControlRequest({taskId:t.id,expectedTaskRevision:metadata.revision,command:"STOP",targetRunId:original.runId,idempotencyKey:"stale-expected"}),/Revision conflict/);
  assert.throws(()=>f.store.createControlRequest({taskId:t.id,expectedTaskRevision:noop.revision,command:"STOP",targetRunId:"child-spoof",idempotencyKey:"child-spoof"}),/current active worker binding/);
  const beforeTransfer=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:noop.revision,command:"PAUSE",targetRunId:original.runId,idempotencyKey:"pause-before-transfer"});
  const replacement=f.store.transferRun({taskId:t.id,expectedTaskRevision:noop.revision,runId:"replacement-worker",agent:"replacement",idempotencyKey:"replacement-worker",actor:parent});
  assert.throws(()=>f.store.claimControlRequest({id:beforeTransfer.id,parentSessionId:parent}),/current active worker binding/);
  const beforeEdit=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:replacement.taskRevision,command:"STOP",targetRunId:replacement.runId,idempotencyKey:"stop-before-edit"});
  const edited=f.store.updateTask(t.id,{description:"new acceptance",expectedRevision:replacement.taskRevision});
  assert.deepEqual({state:edited.state,acceptanceRevision:edited.acceptanceRevision},{state:"READY",acceptanceRevision:2});
  assert.throws(()=>f.store.claimControlRequest({id:beforeEdit.id,parentSessionId:parent}),/current active worker binding/);
} finally {f.close();} });

test("idempotency fingerprints conflict and outstanding GO coalesces across random keys", () => { const f=fixture(); try { const t=f.store.createTask({title:"idempotency"}); const first=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:1,command:"GO",idempotencyKey:"key",maxCycles:1}); assert.equal(f.store.createControlRequest({taskId:t.id,expectedTaskRevision:1,command:"GO",idempotencyKey:"key",maxCycles:1}).id,first.id); assert.throws(()=>f.store.createControlRequest({taskId:t.id,expectedTaskRevision:1,command:"GO",idempotencyKey:"key",maxCycles:2}),/fingerprint/);assert.equal(f.store.createControlRequest({taskId:t.id,expectedTaskRevision:1,command:"GO",idempotencyKey:"other-random-key",maxCycles:1}).id,first.id);assert.equal(f.store.listControlRequests(t.id).length,1); } finally {f.close();} });

test("bounded stale CLAIMED recovery preserves GO requeue but fails obsolete PAUSE/STOP targets", () => { const f=fixture(); try {
  const goTask=f.store.createTask({title:"orphan"}), go=f.store.createControlRequest({taskId:goTask.id,expectedTaskRevision:1,command:"GO",idempotencyKey:"orphan"});
  f.store.claimControlRequest({id:go.id,parentSessionId:"gone"});
  assert.equal(f.store.reconcileOneClaimedRequest(()=>true)?.state,"CLAIMED");
  assert.equal(f.store.reconcileOneClaimedRequest(()=>false)?.state,"REQUESTED");
  const t=f.store.createTask({title:"stale control"}), ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:t.revision}), original=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"old-control-worker",agent:"worker",role:"worker",idempotencyKey:"old-control-worker",actor:parent});
  const old=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:original.taskRevision,command:"PAUSE",targetRunId:original.runId,idempotencyKey:"pause-old-target"});
  f.store.claimControlRequest({id:old.id,parentSessionId:"gone"});
  const replacement=f.store.transferRun({taskId:t.id,expectedTaskRevision:original.taskRevision,runId:"replacement-control-worker",agent:"replacement",idempotencyKey:"replacement-control-worker",actor:parent});
  const failedAfterTransfer=f.store.reconcileOneClaimedRequest(()=>false)!;
  assert.deepEqual({id:failedAfterTransfer.id,state:failedAfterTransfer.state},{id:old.id,state:"FAILED"});
  assert.match(failedAfterTransfer.error??"",/control target is no longer current/);
  assert.throws(()=>f.store.completeControlRequest({id:old.id,outcome:"would stop replacement"}),/Control request is FAILED/);
  const current=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:replacement.taskRevision,command:"STOP",targetRunId:replacement.runId,idempotencyKey:"stop-current-target"});
  f.store.claimControlRequest({id:current.id,parentSessionId:"gone"});
  const retained=f.store.reconcileOneClaimedRequest(()=>false)!;
  assert.deepEqual({id:retained.id,state:retained.state},{id:current.id,state:"CLAIMED"});
  const edited=f.store.updateTask(t.id,{description:"changed acceptance",expectedRevision:replacement.taskRevision});
  assert.equal(edited.state,"READY");
  const failedAfterEdit=f.store.reconcileOneClaimedRequest(()=>false)!;
  assert.deepEqual({id:failedAfterEdit.id,state:failedAfterEdit.state},{id:current.id,state:"FAILED"});
  assert.ok(f.store.getTaskDetail(t.id)!.events.some((event)=>event.type==="orchestration.failed"));
} finally {f.close();} });

test("discussion is durable, derives parent/bound roles, idempotently replies and acknowledges users", () => { const f=fixture(); try { const t=completedReview(f), detail=f.store.getTaskDetail(t.id)!; assert.equal(detail.reportStatus,"present"); const root=f.store.addComment(t.id,{body:"web",actor:"user",role:"user",clientMessageId:"message-1"});assert.equal(f.store.addComment(t.id,{body:"web",actor:"user",role:"user",clientMessageId:"message-1"}).id,root.id);assert.throws(()=>f.store.addComment(t.id,{body:"changed",actor:"user",role:"user",clientMessageId:"message-1"}),/content differs/); const reviewer=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"review-activity",agent:"review",role:"reviewer",idempotencyKey:"activity",actor:parent,model:"m"}); const agent=f.store.respondToDiscussion(t.id,{body:"reply",replyTo:root.id,runId:reviewer.runId},parent,"session"); assert.deepEqual({actor:agent.actor,role:agent.role,runId:agent.runId},{actor:"review",role:"reviewer",runId:reviewer.runId});assert.equal(f.store.listComments(t.id)[0]?.deliveryState,"acknowledged");assert.equal(f.store.listEvidence(t.id).length,0); assert.equal(f.store.updateRunActivity({taskId:t.id,runId:reviewer.runId,lifecycle:"running",currentTool:"test",actor:parent}).currentTool,"test"); } finally {f.close();} });

test("completion reconciles lifecycle-only RUNNING revision drift but rejects changed acceptance",()=>{const f=fixture();try{const t=f.store.createTask({title:"drift"}),ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1}),w=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"worker-drift",agent:"a",role:"worker",idempotencyKey:"drift",actor:parent});const drifted=f.store.updateTask(t.id,{expectedRevision:w.taskRevision});assert.equal(drifted.state,"RUNNING");const done=f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w.taskRevision,runId:w.runId,report,actor:parent});assert.equal(done.accepted,true);assert.equal(f.store.getTask(t.id)?.state,"REVIEW");const x=f.store.createTask({title:"changed"}),xr=f.store.updateTask(x.id,{state:"READY",expectedRevision:1}),xw=f.store.assignRun({taskId:x.id,expectedTaskRevision:xr.revision,runId:"worker-change",agent:"a",role:"worker",idempotencyKey:"change",actor:parent});f.store.updateTask(x.id,{title:"new acceptance",expectedRevision:xw.taskRevision});assert.equal(f.store.attestCompletion({taskId:x.id,expectedTaskRevision:xw.taskRevision,runId:xw.runId,report,actor:parent}).reason,"revision-conflict");}finally{f.close();}});

test("discussion imports reject every stale or unbound binding without durable side effects",()=>{const f=fixture();try{const effects=(taskId:string)=>({comments:f.store.listComments(taskId).length,events:f.store.getTaskDetail(taskId)!.events.length,evidence:f.store.listEvidence(taskId).length});const rejected=(taskId:string,attempt:()=>unknown)=>{const before=effects(taskId);assert.throws(attempt,/Current matching run binding is required/);assert.deepEqual(effects(taskId),before);};const unknown=f.store.createTask({title:"unknown"});rejected(unknown.id,()=>f.store.respondToDiscussion(unknown.id,{body:"no binding",runId:"unbound-run"},parent));const first=f.store.createTask({title:"first"}),firstReady=f.store.updateTask(first.id,{state:"READY",expectedRevision:1}),firstRun=f.store.assignRun({taskId:first.id,expectedTaskRevision:firstReady.revision,runId:"wrong-task-run",agent:"worker",role:"worker",idempotencyKey:"wrong-task",actor:parent}),second=f.store.createTask({title:"second"});rejected(second.id,()=>f.store.importAgentComment(second.id,firstRun.runId,"wrong task",undefined,parent));const superseded=f.store.createTask({title:"superseded"}),supersededReady=f.store.updateTask(superseded.id,{state:"READY",expectedRevision:1}),supersededRun=f.store.assignRun({taskId:superseded.id,expectedTaskRevision:supersededReady.revision,runId:"superseded-run",agent:"worker",role:"worker",idempotencyKey:"superseded",actor:parent}),supersededCurrent=f.store.updateTask(superseded.id,{description:"edited",expectedRevision:supersededRun.taskRevision});assert.equal(f.store.listBindings(superseded.id)[0]?.state,"superseded");rejected(superseded.id,()=>f.store.respondToDiscussion(superseded.id,{body:"stale",runId:supersededRun.runId},parent));const failed=f.store.createTask({title:"failed"}),failedReady=f.store.updateTask(failed.id,{state:"READY",expectedRevision:1}),failedRun=f.store.assignRun({taskId:failed.id,expectedTaskRevision:failedReady.revision,runId:"failed-run",agent:"worker",role:"worker",idempotencyKey:"failed",actor:parent});f.store.updateTask(failed.id,{state:"FAILED",expectedRevision:failedRun.taskRevision});assert.equal(f.store.listBindings(failed.id)[0]?.state,"failed");rejected(failed.id,()=>f.store.importAgentComment(failed.id,failedRun.runId,"failed",undefined,parent));const stale=completedReview(f),staleWorker=f.store.listBindings(stale.id)[0]!,edited=f.store.updateTask(stale.id,{description:"new acceptance",expectedRevision:stale.revision});assert.equal(staleWorker.state,"completed");assert.notEqual(staleWorker.acceptanceDigest,edited.acceptanceDigest);rejected(stale.id,()=>f.store.respondToDiscussion(stale.id,{body:"old acceptance",runId:staleWorker.runId},parent));assert.equal(supersededCurrent.acceptanceRevision,2);}finally{f.close();}});

test("current worker and reviewer comments import, but comments cannot transition a task to DONE",()=>{const f=fixture();try{const workerTask=f.store.createTask({title:"worker"}),workerReady=f.store.updateTask(workerTask.id,{state:"READY",expectedRevision:1}),activeWorker=f.store.assignRun({taskId:workerTask.id,expectedTaskRevision:workerReady.revision,runId:"active-worker",agent:"worker",role:"worker",idempotencyKey:"active-worker",actor:parent});assert.equal(f.store.importAgentComment(workerTask.id,activeWorker.runId,"active",undefined,parent).role,"worker");assert.equal(f.store.attestCompletion({taskId:workerTask.id,expectedTaskRevision:activeWorker.taskRevision,runId:activeWorker.runId,report,actor:parent}).accepted,true);const reviewed=f.store.getTask(workerTask.id)!;assert.equal(f.store.respondToDiscussion(workerTask.id,{body:"completed",runId:activeWorker.runId},parent).role,"worker");const activeReviewer=f.store.assignRun({taskId:workerTask.id,expectedTaskRevision:reviewed.revision,runId:"active-reviewer",agent:"reviewer",role:"reviewer",idempotencyKey:"active-reviewer",actor:parent});assert.equal(f.store.importAgentComment(workerTask.id,activeReviewer.runId,"reviewing",undefined,parent).role,"reviewer");f.store.recordReviewerEvidence(workerTask.id,{expectedTaskRevision:reviewed.revision,runId:activeReviewer.runId,kind:"review",verdict:"PASS",actor:parent});assert.equal(f.store.respondToDiscussion(workerTask.id,{body:"reviewed",runId:activeReviewer.runId},parent).role,"reviewer");const noEvidence=completedReview(f);assert.equal(f.store.importAgentComment(noEvidence.id,f.store.listBindings(noEvidence.id)[0]!.runId,"comment only",undefined,parent).role,"worker");assert.throws(()=>f.store.updateTask(noEvidence.id,{state:"DONE",expectedRevision:noEvidence.revision}),/latest conclusive independent reviewer PASS/);assert.equal(f.store.getTask(noEvidence.id)?.state,"REVIEW");assert.equal(f.store.listEvidence(noEvidence.id).length,0);}finally{f.close();}});

test("regression: same-acceptance rework cycle cannot close DONE on a stale reviewer PASS that reviewed an earlier worker",()=>{const f=fixture();try{
  // w1 (agent A) completes -> REVIEW; reviewer r1 (agent B) PASS at acceptanceRevision 1.
  const t=completedReview(f);const w1=f.store.listBindings(t.id).find((b)=>b.role==="worker")!;
  const r1=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-1",agent:"reviewer-b",role:"reviewer",idempotencyKey:"rev-1",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r1.runId,kind:"review",verdict:"PASS",actor:parent});
  // Rework WITHOUT content change: assign a brand-new worker w2 (agent C) while still REVIEW/acceptanceRevision 1 -> RUNNING.
  const reviewState=f.store.getTask(t.id)!;
  const w2=f.store.assignRun({taskId:t.id,expectedTaskRevision:reviewState.revision,runId:"worker-c",agent:"worker-c",role:"worker",idempotencyKey:"worker-c",actor:parent});
  assert.equal(f.store.getTask(t.id)!.state,"RUNNING");
  // w2 attests a DIFFERENT completion -> back to REVIEW, still acceptanceRevision 1, NO fresh review of w2.
  assert.equal(f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w2.taskRevision,runId:w2.runId,report:{...report,summary:"second unreviewed submission"},actor:parent}).accepted,true);
  const afterW2=f.store.getTask(t.id)!;assert.equal(afterW2.state,"REVIEW");assert.equal(afterW2.acceptanceRevision,reviewState.acceptanceRevision);
  assert.notEqual(w1.runId,w2.runId);
  // DONE must be rejected: r1's PASS predates w2's completion and reviewed a different worker.
  assert.throws(()=>f.store.updateTask(t.id,{state:"DONE",expectedRevision:afterW2.revision}),/latest conclusive independent reviewer PASS/);
  assert.equal(f.store.getTask(t.id)!.state,"REVIEW");
  // A fresh independent reviewer of w2 unblocks DONE.
  const r2=f.store.assignRun({taskId:t.id,expectedTaskRevision:afterW2.revision,runId:"rev-2",agent:"reviewer-d",role:"reviewer",idempotencyKey:"rev-2",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:afterW2.revision,runId:r2.runId,kind:"review",verdict:"PASS",actor:parent});
  assert.equal(f.store.updateTask(t.id,{state:"DONE",expectedRevision:afterW2.revision}).state,"DONE");
}finally{f.close();}});

test("reviewer evidence rejects same-agent and same-run as the worker",()=>{const f=fixture();try{
  const t=completedReview(f);const w=f.store.listBindings(t.id).find((b)=>b.role==="worker")!;
  // same agent as worker
  const sameAgent=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-same-agent",agent:w.agent,role:"reviewer",idempotencyKey:"rev-same-agent",actor:parent});
  assert.throws(()=>f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:sameAgent.runId,kind:"review",verdict:"PASS",actor:parent}),/different run and agent/);
}finally{f.close();}});

test("evidence verdict is validated at the store boundary",()=>{const f=fixture();try{
  const t=completedReview(f);const r=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-bad-verdict",agent:"reviewer-x",role:"reviewer",idempotencyKey:"rev-bad-verdict",actor:parent});
  assert.throws(()=>f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r.runId,kind:"review",verdict:"APPROVED" as unknown as "PASS",actor:parent}),/verdict must be one of/);
  assert.equal(f.store.listEvidence(t.id).length,0);
}finally{f.close();}});

test("task priority rejects non-finite and non-integer values",()=>{const f=fixture();try{
  assert.throws(()=>f.store.createTask({title:"nan",priority:Number.NaN}),/finite/);
  assert.throws(()=>f.store.createTask({title:"inf",priority:Number.POSITIVE_INFINITY}),/finite/);
  assert.throws(()=>f.store.createTask({title:"float",priority:1.5}),/integer/);
  const ok=f.store.createTask({title:"ok",priority:150});assert.equal(ok.priority,100);
}finally{f.close();}});

test("self-audit: update-monitor on a completed worker after a valid PASS does not falsely block DONE",()=>{const f=fixture();try{
  const t=completedReview(f);const w=f.store.listBindings(t.id).find((b)=>b.role==="worker")!;
  const r=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-audit",agent:"reviewer-audit",role:"reviewer",idempotencyKey:"rev-audit",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r.runId,kind:"review",verdict:"PASS",actor:parent});
  // update-monitor bumps the completed worker's updated_at to a later timestamp; must NOT invalidate the earlier valid PASS.
  f.store.updateRunActivity({taskId:t.id,runId:w.runId,lifecycle:"completed",actor:parent});
  assert.equal(f.store.updateTask(t.id,{state:"DONE",expectedRevision:t.revision}).state,"DONE");
}finally{f.close();}});

test("edge case B1: content edit on a DONE task is rejected (cannot remain DONE under unreviewed acceptance)",()=>{const f=fixture();try{
  const t=completedReview(f);const w=f.store.listBindings(t.id).find(b=>b.role==="worker")!;
  const r=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-b1",agent:"reviewer-b1",role:"reviewer",idempotencyKey:"rev-b1",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r.runId,kind:"review",verdict:"PASS",actor:parent});
  const done=f.store.updateTask(t.id,{state:"DONE",expectedRevision:t.revision});
  assert.equal(done.state,"DONE");
  assert.throws(()=>f.store.updateTask(t.id,{description:"changed after done",expectedRevision:done.revision}),/Cannot edit content of a DONE task/);
  // Task stays DONE at the same acceptance; no silent acceptance bump.
  const after=f.store.getTask(t.id)!;assert.equal(after.state,"DONE");assert.equal(after.acceptanceRevision,done.acceptanceRevision);
}finally{f.close();}});

test("edge case B2: update-monitor on an older completed worker cannot make its stale PASS close a newer unreviewed submission",()=>{const f=fixture();try{
  const t=completedReview(f);const w1=f.store.listBindings(t.id).find(b=>b.role==="worker")!;
  const r1=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-b2",agent:"reviewer-b2",role:"reviewer",idempotencyKey:"rev-b2",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r1.runId,kind:"review",verdict:"PASS",actor:parent});
  // Rework without content change: assign W2 (same acceptance), complete it, no fresh review.
  const rev=f.store.getTask(t.id)!;
  const w2=f.store.assignRun({taskId:t.id,expectedTaskRevision:rev.revision,runId:"w2-b2",agent:"worker-c",role:"worker",idempotencyKey:"w2-b2",actor:parent});
  f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w2.taskRevision,runId:w2.runId,report:{...report,summary:"second unreviewed"},actor:parent});
  const afterW2=f.store.getTask(t.id)!;
  // Adversary bumps W1's updated_at after W2 completed.
  f.store.updateRunActivity({taskId:t.id,runId:w1.runId,lifecycle:"completed",actor:parent});
  // DONE must still be blocked: latest worker is W2 (by task_revision), and it has no PASS.
  assert.throws(()=>f.store.updateTask(t.id,{state:"DONE",expectedRevision:afterW2.revision}),/latest conclusive independent reviewer PASS/);
}finally{f.close();}});

test("edge case B3: verdicts are ordered by durable insertion order, so a later same-instant FAIL blocks DONE",()=>{const f=fixture();try{
  const t=completedReview(f);
  const pass=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-pass-b3",agent:"reviewer-p",role:"reviewer",idempotencyKey:"pass-b3",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:pass.runId,kind:"review",verdict:"PASS",actor:parent});
  const fail=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"rev-fail-b3",agent:"reviewer-f",role:"reviewer",idempotencyKey:"fail-b3",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:fail.runId,kind:"review",verdict:"FAIL",actor:parent});
  // Worst case: PASS and FAIL share an identical created_at, and the earlier PASS has a UUID that sorts LAST under `id DESC`.
  // The old ordering (created_at DESC, id DESC) would then wrongly pick the PASS; only durable rowid ordering keeps the later FAIL authoritative.
  f.store.db.prepare("UPDATE evidence SET created_at='2999-01-01T00:00:00.000Z', id='ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE run_id=?").run(pass.runId);
  f.store.db.prepare("UPDATE evidence SET created_at='2999-01-01T00:00:00.000Z', id='00000000-0000-4000-8000-000000000000' WHERE run_id=?").run(fail.runId);
  assert.throws(()=>f.store.updateTask(t.id,{state:"DONE",expectedRevision:t.revision}),/latest conclusive independent reviewer PASS/);
}finally{f.close();}});

test("task type system: default task, explicit types, validation, and legacy backfill",()=>{const f=fixture();try{
  // Default type is 'task'.
  const def=f.store.createTask({title:"plain"});assert.equal(def.type,"task");
  // Explicit types accepted.
  for(const tp of ["epic","feature","task","bug"] as const){const t=f.store.createTask({title:tp+" item",type:tp});assert.equal(t.type,tp);}
  // Invalid type rejected.
  assert.throws(()=>f.store.createTask({title:"bad",type:"chore" as unknown as "task"}),/type must be one of/);
  // Update changes type without touching acceptance (type is metadata, not content).
  const t=f.store.createTask({title:"promote",type:"task"});const before=f.store.getTask(t.id)!;
  const up=f.store.updateTask(t.id,{type:"epic",expectedRevision:before.revision});
  assert.equal(up.type,"epic");assert.equal(up.acceptanceRevision,before.acceptanceRevision);
}finally{f.close();}});

test("task type: legacy rows with NULL type backfill to 'task'",()=>{const dir=projectTemp("legacy-type-"),path=join(dir,"state.db"),db=new DatabaseSync(path);
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,description TEXT,state TEXT,priority INTEGER,risk TEXT,revision INTEGER,created_at TEXT,updated_at TEXT); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY,task_id TEXT,type TEXT,payload_json TEXT,actor TEXT,created_at TEXT); CREATE TABLE evidence(id TEXT PRIMARY KEY,task_id TEXT,task_revision INTEGER,kind TEXT,verdict TEXT,actor TEXT,payload_json TEXT,created_at TEXT); CREATE TABLE task_comments(id TEXT PRIMARY KEY,task_id TEXT,body TEXT,actor TEXT,created_at TEXT);");
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("leg","legacy title","body","BACKLOG",0,"medium",1,"a","b");db.close();
  const store=new MazzyStore(path);try{assert.equal(store.getTask("leg")!.type,"task");}finally{store.close();rmSync(dir,{recursive:true,force:true});}});

test("quality gates: read-only audit projection tracks the real lifecycle and never lets comments satisfy a gate",()=>{const f=fixture();try{
  const g=(id:string,taskId:string)=>f.store.getTaskDetail(taskId)!.qualityGates.gates.find(x=>x.id===id)!;
  // Fresh READY task: required gates are PENDING, not ready.
  const t=f.store.createTask({title:"gated"});const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1});
  let q=f.store.getTaskDetail(t.id)!.qualityGates;assert.equal(q.readyForDone,false);assert.equal(g("independent-review",t.id).status,"PENDING");
  // Worker assigned + completed -> worker/report gates PASS, independent-review MISSING, still blocking.
  const w=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"gw",agent:"ga",role:"worker",idempotencyKey:"gw",actor:parent});
  f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w.taskRevision,runId:w.runId,report,actor:parent});
  assert.equal(g("worker-completed",t.id).status,"PASS");assert.equal(g("review-report",t.id).status,"PASS");assert.equal(g("independent-review",t.id).status,"MISSING");
  assert.equal(f.store.getTaskDetail(t.id)!.qualityGates.readyForDone,false);
  // A user comment must NOT satisfy any gate.
  f.store.addComment(t.id,{body:"looks good, ship it",actor:"user",role:"user"});
  assert.equal(g("independent-review",t.id).status,"MISSING");assert.equal(f.store.getTaskDetail(t.id)!.qualityGates.readyForDone,false);
  // Independent reviewer PASS -> gate PASS and readyForDone true.
  const rev=f.store.getTask(t.id)!;const r=f.store.assignRun({taskId:t.id,expectedTaskRevision:rev.revision,runId:"grv",agent:"grev",role:"reviewer",idempotencyKey:"grv",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:rev.revision,runId:r.runId,kind:"review",verdict:"PASS",actor:parent});
  q=f.store.getTaskDetail(t.id)!.qualityGates;
  assert.equal(g("independent-review",t.id).status,"PASS");assert.equal(g("done-eligibility",t.id).status,"PASS");
  assert.equal(q.readyForDone,true);assert.equal(q.blocking,0);
  // A later FAIL flips independent-review back to FAIL and blocks readiness.
  const r2=f.store.assignRun({taskId:t.id,expectedTaskRevision:rev.revision,runId:"grv2",agent:"grev2",role:"reviewer",idempotencyKey:"grv2",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:rev.revision,runId:r2.runId,kind:"review",verdict:"FAIL",actor:parent});
  assert.equal(g("independent-review",t.id).status,"FAIL");assert.equal(f.store.getTaskDetail(t.id)!.qualityGates.readyForDone,false);
}finally{f.close();}});

test("edge case H2: complete and fail cannot reverse each other's terminal control-request transition",()=>{const f=fixture();try{
  const t=f.store.createTask({title:"ctl"});const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1});
  const req=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:ready.revision,command:"GO",idempotencyKey:"go-h2"});
  f.store.claimControlRequest({id:req.id,parentSessionId:"ps"});
  f.store.failControlRequest({id:req.id,error:"boom"});
  assert.equal(f.store.getControlRequest(req.id)!.state,"FAILED");
  // A late complete on an already-FAILED request must not flip it to COMPLETED.
  assert.throws(()=>f.store.completeControlRequest({id:req.id,childSessionId:"cs",childRunId:"cr"}),/Control request is FAILED/);
  assert.equal(f.store.getControlRequest(req.id)!.state,"FAILED");
}finally{f.close();}});

test("edge case H3: GO completion rejects an unrelated historical worker binding",()=>{const f=fixture();try{
  // Old cycle: worker completes, task goes REVIEW then edited back to READY.
  const t=f.store.createTask({title:"go-h3"});const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1});
  const w=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"old-w",agent:"a",role:"worker",idempotencyKey:"old-w",actor:parent,parentSessionId:"ps",childSessionId:"cs"});
  f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w.taskRevision,runId:w.runId,report,actor:parent});
  const reviewed=f.store.getTask(t.id)!;const edited=f.store.updateTask(t.id,{description:"changed",expectedRevision:reviewed.revision});
  assert.equal(edited.state,"READY");
  // New GO claimed at the new revision.
  const req=f.store.createControlRequest({taskId:t.id,expectedTaskRevision:edited.revision,command:"GO",idempotencyKey:"go-h3",parentSessionId:"ps"});
  f.store.claimControlRequest({id:req.id,parentSessionId:"ps"});
  // Completing the new GO with the OLD worker's run/session (taskRevision < expected) must be rejected.
  assert.throws(()=>f.store.completeControlRequest({id:req.id,childSessionId:"cs",childRunId:"old-w"}),/matching current parent-attested worker binding/);
  assert.equal(f.store.getControlRequest(req.id)!.state,"CLAIMED");
}finally{f.close();}});

test("edge case H4: GO is rejected while BLOCKED still holds an active worker",()=>{const f=fixture();try{
  const t=f.store.createTask({title:"blk"});const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1});
  const w=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"blk-w",agent:"a",role:"worker",idempotencyKey:"blk-w",actor:parent});
  const running=f.store.getTask(t.id)!;assert.equal(running.state,"RUNNING");
  const blocked=f.store.updateTask(t.id,{state:"BLOCKED",expectedRevision:running.revision});
  assert.equal(blocked.state,"BLOCKED");assert.ok(f.store.listBindings(t.id).some(b=>b.role==="worker"&&b.state==="active"));
  // GO must be rejected as unrealizable, not accepted then stuck.
  assert.throws(()=>f.store.createControlRequest({taskId:t.id,expectedTaskRevision:blocked.revision,command:"GO",idempotencyKey:"go-h4"}),/BLOCKED still holds an active worker/);
}finally{f.close();}});

test("regression: same-millisecond rework cannot DONE on a stale W1 PASS — uses immutable task_revision not wall-clock",()=>{const f=fixture();try{
  const t=completedReview(f);const w1=f.store.listBindings(t.id).find(b=>b.role==="worker")!;
  const r1=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"ms-r1",agent:"rev-b",role:"reviewer",idempotencyKey:"ms-r1",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r1.runId,kind:"review",verdict:"PASS",actor:parent});
  const rev=f.store.getTask(t.id)!;
  const w2=f.store.assignRun({taskId:t.id,expectedTaskRevision:rev.revision,runId:"ms-w2",agent:"worker-c",role:"worker",idempotencyKey:"ms-w2",actor:parent});
  f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w2.taskRevision,runId:w2.runId,report:{...report,summary:"w2 unreviewed"},actor:parent});
  const afterW2=f.store.getTask(t.id)!;
  // Worst case: collapse ALL evidence/binding timestamps to one identical millisecond so a created_at floor cannot distinguish W1-PASS from W2 assignment.
  f.store.db.prepare("UPDATE evidence SET created_at='2026-05-05T05:05:05.005Z' WHERE task_id=?").run(t.id);
  f.store.db.prepare("UPDATE run_bindings SET created_at='2026-05-05T05:05:05.005Z',updated_at='2026-05-05T05:05:05.005Z' WHERE task_id=?").run(t.id);
  // Immutable task_revision still distinguishes: r1.task_revision < w2.taskRevision, so its PASS does not count for W2.
  assert.throws(()=>f.store.updateTask(t.id,{state:"DONE",expectedRevision:afterW2.revision}),/latest conclusive independent reviewer PASS/);
  // A fresh reviewer of W2 (assigned after W2, higher task_revision) unblocks DONE.
  const r2=f.store.assignRun({taskId:t.id,expectedTaskRevision:afterW2.revision,runId:"ms-r2",agent:"rev-d",role:"reviewer",idempotencyKey:"ms-r2",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:afterW2.revision,runId:r2.runId,kind:"review",verdict:"PASS",actor:parent});
  f.store.db.prepare("UPDATE evidence SET created_at='2026-05-05T05:05:05.005Z' WHERE task_id=?").run(t.id);
  assert.equal(f.store.updateTask(t.id,{state:"DONE",expectedRevision:afterW2.revision}).state,"DONE");
}finally{f.close();}});

test("edge case HIGH-2: quality gate does not report a stale W1 PASS as current for an unreviewed W2",()=>{const f=fixture();try{
  const t=completedReview(f);const w1=f.store.listBindings(t.id).find(b=>b.role==="worker")!;
  const r1=f.store.assignRun({taskId:t.id,expectedTaskRevision:t.revision,runId:"qg-r1",agent:"rev-b",role:"reviewer",idempotencyKey:"qg-r1",actor:parent});
  f.store.recordReviewerEvidence(t.id,{expectedTaskRevision:t.revision,runId:r1.runId,kind:"review",verdict:"PASS",actor:parent});
  assert.equal(f.store.getTaskDetail(t.id)!.qualityGates.gates.find(g=>g.id==="independent-review")!.status,"PASS");
  // W2 completes under same acceptance, no fresh review.
  const rev=f.store.getTask(t.id)!;
  const w2=f.store.assignRun({taskId:t.id,expectedTaskRevision:rev.revision,runId:"qg-w2",agent:"worker-c",role:"worker",idempotencyKey:"qg-w2",actor:parent});
  f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w2.taskRevision,runId:w2.runId,report:{...report,summary:"w2"},actor:parent});
  // The projection must NOT claim independent-review PASS / readyForDone for the unreviewed W2.
  const q=f.store.getTaskDetail(t.id)!.qualityGates;
  assert.notEqual(q.gates.find(g=>g.id==="independent-review")!.status,"PASS");
  assert.equal(q.readyForDone,false);
}finally{f.close();}});

test("edge case HIGH-3: GO rejected while an active worker survives via BLOCKED->READY",()=>{const f=fixture();try{
  const t=f.store.createTask({title:"blkready"});const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:1});
  const w=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"br-w",agent:"a",role:"worker",idempotencyKey:"br-w",actor:parent});
  const running=f.store.getTask(t.id)!;
  const blocked=f.store.updateTask(t.id,{state:"BLOCKED",expectedRevision:running.revision});
  const backToReady=f.store.updateTask(t.id,{state:"READY",expectedRevision:blocked.revision});
  assert.equal(backToReady.state,"READY");assert.ok(f.store.listBindings(t.id).some(b=>b.role==="worker"&&b.state==="active"));
  // GO from READY with a surviving active worker must be rejected as unrealizable.
  assert.throws(()=>f.store.createControlRequest({taskId:t.id,expectedTaskRevision:backToReady.revision,command:"GO",idempotencyKey:"br-go"}),/still holds an active worker/);
}finally{f.close();}});

test("edge case MEDIUM-3: re-acknowledging a comment emits no phantom event",()=>{const f=fixture();try{
  const t=f.store.createTask({title:"ack"});
  const c=f.store.addComment(t.id,{body:"question",actor:"user",role:"user"});
  const before=f.store.getTaskDetail(t.id)!.events.filter(e=>e.type==="comment.acknowledged").length;
  f.store.acknowledgeUserComment(t.id,c.id);
  f.store.acknowledgeUserComment(t.id,c.id);
  f.store.acknowledgeUserComment(t.id,c.id);
  const after=f.store.getTaskDetail(t.id)!.events.filter(e=>e.type==="comment.acknowledged").length;
  assert.equal(after-before,1,"only the first real transition emits comment.acknowledged");
}finally{f.close();}});

test("edge case MEDIUM-2: getReviewReport picks the latest report by rowid on a same-timestamp tie",()=>{const f=fixture();try{
  const t=completedReview(f);const w1=f.store.listBindings(t.id).find(b=>b.role==="worker")!;
  const rev=f.store.getTask(t.id)!;
  const w2=f.store.assignRun({taskId:t.id,expectedTaskRevision:rev.revision,runId:"rep-w2",agent:"worker-c",role:"worker",idempotencyKey:"rep-w2",actor:parent});
  f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w2.taskRevision,runId:w2.runId,report:{...report,summary:"w2 report"},actor:parent});
  // Collapse both report timestamps to an identical value; rowid must still select W2 (inserted later).
  f.store.db.prepare("UPDATE review_reports SET updated_at='2026-06-06T06:06:06.006Z' WHERE task_id=?").run(t.id);
  const picked=f.store.getReviewReport(t.id,t.acceptanceRevision)!;
  assert.equal(picked.workerRunId,w2.runId,"latest report by rowid, not UUID tie");
  // W2 idempotent replay still accepted (report matches current worker).
  assert.equal(f.store.attestCompletion({taskId:t.id,expectedTaskRevision:w2.taskRevision,runId:w2.runId,report:{...report,summary:"w2 report"},actor:parent}).accepted,true);
}finally{f.close();}});
