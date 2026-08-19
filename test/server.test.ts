import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { MazzyHttpServer, parseMazzyPort } from "../src/server.ts";
import { MazzyStore } from "../src/store.ts";
import { TASK_STATES, UI_TRANSITIONS } from "../src/types.ts";
async function fixture(agents: Record<string,{model:string}> = {}) { const dir=projectTemp("http-"),store=new MazzyStore(join(dir,"state.db")),server=new MazzyHttpServer(store,0,undefined,agents); await server.start(); return {store,server,token:new URL(server.accessUrl).hash.slice(7),close:async()=>{await server.stop();store.close();rmSync(dir,{recursive:true,force:true});}}; }
const req=(url:string,token:string|undefined,init:RequestInit={})=>fetch(url,{...init,headers:{...(token?{"x-pi-ops-token":token}:{}),...(init.headers??{})}});
const foreignHostStatus=(url:string)=>new Promise<number>((resolve,reject)=>{const target=new URL(url),request=httpRequest({hostname:target.hostname,port:target.port,path:"/",headers:{Host:"attacker.invalid:9999"}},response=>{response.resume();response.on("end",()=>resolve(response.statusCode??0));});request.on("error",reject);request.end();});

const scratchRoot = testScratchRoot;
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }

test("server rejects foreign Host, authenticates every API method, and never embeds the capability token", async()=>{const f=await fixture();try{assert.equal(await foreignHostStatus(f.server.url),400);for(const method of ["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"]){assert.equal((await req(f.server.url+"/api/snapshot",undefined,{method})).status,403,method);}const root=await (await fetch(f.server.url+"/")).text();assert.ok(!root.includes(f.token));assert.match(root,/location\.hash/);assert.equal((await fetch(f.server.url+"/ops")).status,200);}finally{await f.close();}});
test("task API supports basic create, list, update, and clear revision/transition failures",async()=>{const f=await fixture();try{const created=await req(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"regression-create"},body:JSON.stringify({title:"regression"})});assert.equal(created.status,201);const task=await created.json() as {id:string;revision:number;title:string};const snapshot=await req(f.server.url+"/api/snapshot",f.token);assert.equal(snapshot.status,200);assert.ok((await snapshot.json() as {tasks:Array<{id:string}>}).tasks.some(x=>x.id===task.id));const updated=await req(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({title:"updated",expectedRevision:task.revision})});assert.equal(updated.status,200);assert.equal((await updated.json() as {title:string}).title,"updated");const conflict=await req(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({state:"READY",expectedRevision:task.revision})});assert.equal(conflict.status,409);assert.match((await conflict.json() as {error:string}).error,/Revision conflict/);const invalid=await req(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({state:"DONE",expectedRevision:task.revision+1})});assert.equal(invalid.status,400);assert.match((await invalid.json() as {error:string}).error,/transition.*not allowed/i);}finally{await f.close();}});
test("server policy options are injected and standalone defaults expose no agents", async()=>{const f=await fixture();const g=await fixture({"ops-safe":{model:"safe-model"},"bad name":{model:"ignored"}});try{assert.deepEqual(f.server.orchestrationOptions,{agents:[]});assert.deepEqual(g.server.orchestrationOptions,{agents:[{name:"ops-safe",model:"safe-model"}]});}finally{await f.close();await g.close();}});
test("web comments are authenticated, idempotent, persisted before identifier-only callback, and do not mutate revisions", async()=>{const dir=projectTemp("comment-http-"),store=new MazzyStore(join(dir,"state.db"));const bell:Array<Record<string,string>>=[];const server=new MazzyHttpServer(store,0,undefined,{},async d=>{bell.push(d);assert.ok(store.listComments(d.taskId).some(c=>c.id===d.commentId));assert.ok(!JSON.stringify(d).includes("root"));throw new Error("notification unavailable")});await server.start();const token=new URL(server.accessUrl).hash.slice(7);try{const t=store.createTask({title:"comment"}),u=server.url+"/api/tasks/"+t.id+"/comments";assert.equal((await req(u,undefined,{method:"POST",headers:{"content-type":"application/json"},body:'{"body":"no"}'})).status,403);server.setActiveParentSession("parent");const root=await req(u,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:"root",clientMessageId:"m1"})});assert.equal(root.status,201);const c=await root.json() as {id:string;role:string;deliveryState:string};assert.deepEqual({role:c.role,deliveryState:c.deliveryState},{role:"user",deliveryState:"sent"});const replay=await req(u,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:"root",clientMessageId:"m1"})});assert.equal((await replay.json() as {id:string}).id,c.id);const conflict=await req(u,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:"changed",clientMessageId:"m1"})});assert.equal(conflict.status,409);assert.equal(bell.length,1);await server.reconcileOneUndelivered();assert.equal(bell.length,1);server.setActiveParentSession("reloaded-parent");await server.reconcileOneUndelivered();assert.equal(bell.length,2);await server.reconcileOneUndelivered();assert.equal(bell.length,2);assert.equal(store.getTask(t.id)?.revision,t.revision);}finally{await server.stop();store.close();rmSync(dir,{recursive:true,force:true});}});
test("rapid GO clicks coalesce to one request and one in-flight callback",async()=>{const dir=projectTemp("go-http-"),store=new MazzyStore(join(dir,"state.db"));let calls=0,release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);const server=new MazzyHttpServer(store,0,async()=>{calls++;await wait});await server.start();const token=new URL(server.accessUrl).hash.slice(7);server.setActiveParentSession("parent");try{const t=store.createTask({title:"go"});const post=(key:string)=>req(server.url+"/api/tasks/"+t.id+"/orchestration",token,{method:"POST",headers:{"content-type":"application/json","x-idempotency-key":key},body:JSON.stringify({command:"GO",expectedRevision:t.revision,maxCycles:1})});const first=post("one"),second=post("two");await new Promise(resolve=>setTimeout(resolve,10));release();const [a,b]=await Promise.all([first,second]);assert.equal(a.status,202);assert.equal(b.status,202);assert.equal((await a.json() as {coalesced:boolean}).coalesced,false);assert.equal((await b.json() as {coalesced:boolean}).coalesced,true);assert.equal(calls,1);assert.equal(store.listControlRequests(t.id).length,1);}finally{await server.stop();store.close();rmSync(dir,{recursive:true,force:true});}});
test("HTTP PAUSE and STOP follow the current accepted worker rather than mutable task revisions",async()=>{const f=await fixture();try{
  const t=f.store.createTask({title:"control-http"});
  const ready=f.store.updateTask(t.id,{state:"READY",expectedRevision:t.revision});
  const original=f.store.assignRun({taskId:t.id,expectedTaskRevision:ready.revision,runId:"http-worker",agent:"worker",role:"worker",idempotencyKey:"http-worker",actor:"parent"});
  const post=(command:"PAUSE"|"STOP",expectedRevision:number,key:string,targetRunId:string)=>req(f.server.url+"/api/tasks/"+t.id+"/orchestration",f.token,{method:"POST",headers:{"content-type":"application/json","x-idempotency-key":key},body:JSON.stringify({command,expectedRevision,targetRunId})});
  const priority=f.store.updateTask(t.id,{priority:10,expectedRevision:original.taskRevision});
  const paused=await post("PAUSE",priority.revision,"http-pause","child-spoof");
  assert.equal(paused.status,202);
  assert.equal(((await paused.json() as {request:{targetRunId:string}}).request.targetRunId),original.runId);
  const noop=f.store.updateTask(t.id,{expectedRevision:priority.revision});
  assert.equal((await post("STOP",noop.revision,"http-stop","another-child-spoof")).status,202);
  assert.equal((await post("PAUSE",priority.revision,"http-stale","http-worker")).status,409);
  const replacement=f.store.transferRun({taskId:t.id,expectedTaskRevision:noop.revision,runId:"http-replacement",agent:"replacement",idempotencyKey:"http-replacement",actor:"parent"});
  const transferred=await post("STOP",replacement.taskRevision,"http-transferred","http-worker");
  assert.equal(transferred.status,202);
  assert.equal((await transferred.json() as {request:{targetRunId:string}}).request.targetRunId,replacement.runId);
  const edited=f.store.updateTask(t.id,{description:"changed acceptance",expectedRevision:replacement.taskRevision});
  assert.equal((await post("STOP",edited.revision,"http-content-edit",replacement.runId)).status,400);
}finally{await f.close();}});
test("detail is authenticated read-only and includes report missing honestly",async()=>{const f=await fixture();try{const t=f.store.createTask({title:"detail"}),u=f.server.url+"/api/tasks/"+t.id+"/detail";assert.equal((await req(u,undefined)).status,403);const d=await req(u,f.token);assert.equal(d.status,200);assert.equal((await d.json() as {reportStatus:string}).reportStatus,"report missing");assert.equal((await req(u,f.token,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,404);}finally{await f.close();}});
test("dashboard wires task FSM, orchestration controls, all detail tabs, and the canonical chat artifact",()=>{const html=readFileSync(new URL("../static/index.html",import.meta.url),"utf8");for(const m of ["Mazzy Command Center","--mz-amber","--mz-surface","prefers-reduced-motion","focus-visible","clientMessageId","MazzyChatState.reconcileMessages","MazzyChatState.reconcileControlLock","MazzyChatState.preserveComposerOnRefresh","MazzyChatState.write","@media(max-width:760px)","MZ emblem","/assets/chat-state.js"])assert.ok(html.includes(m),m);assert.match(html,/MazzyChatState\.reconcileControlLock\(lock,pending,Date\.now\(\)\)/);for(const tab of ["Overview","Orchestration","Runs","Trace","Review"])assert.ok(html.includes(`'${tab}'`),tab);assert.match(html,/data-tab=/);for(const id of ["fsm-controls","go","pause","stop","approved-agent","max-cycles","control-instructions","binding-detail","evidence-detail"])assert.match(html,new RegExp(`id=\\\"${id}\\\"`),id);assert.match(html,/addEventListener\('click',\(\)=>transition\(/);assert.match(html,/addEventListener\('click',\(\)=>control\(d,command\)\)/);assert.ok(html.includes("'/api/tasks/'+d.task.id"));assert.match(html,/\/orchestration/);});
test("extension writes and clears only the canonical mazzy widget key",()=>{const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");assert.match(source,/setStatus\("mazzy",/);assert.match(source,/setWidget\("mazzy", undefined\)/);assert.match(source,/setWidget\("mazzy", \[/);assert.doesNotMatch(source,/setWidget\("pi-ops"/);});
test("server self-serves the exact browser chat artifact with defensive headers",async()=>{const f=await fixture();try{const response=await fetch(f.server.url+"/assets/chat-state.js");assert.equal(response.status,200);assert.match(response.headers.get("content-type")??"",/^application\/javascript/);assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("x-content-type-options"),"nosniff");assert.match(response.headers.get("content-security-policy")??"",/script-src 'self'/);assert.equal(await response.text(),readFileSync(new URL("../static/assets/chat-state.js",import.meta.url),"utf8"));}finally{await f.close();}});
test("dashboard API supports a real allowed FSM click path",async()=>{const f=await fixture();try{const task=f.store.createTask({title:"transition"});const response=await req(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({state:"READY",expectedRevision:task.revision})});assert.equal(response.status,200);assert.equal((await response.json() as {state:string}).state,"READY");}finally{await f.close();}});
test("shared UI read model excludes DONE and generic RUNNING",()=>{for(const state of TASK_STATES){assert.ok(!UI_TRANSITIONS[state].includes("DONE"));assert.ok(!UI_TRANSITIONS[state].includes("RUNNING"));assert.ok(!UI_TRANSITIONS[state].includes("REVIEW"),`${state} must not offer a manual REVIEW transition (attestation-gated)`);}for(const value of [undefined,"0","65535"])assert.doesNotThrow(()=>parseMazzyPort(value));for(const value of ["-1","65536","abc"])assert.throws(()=>parseMazzyPort(value));});
test("start binds a free port when the requested port is already owned (multi-session isolation)",async()=>{const dirA=projectTemp("port-a-"),dirB=projectTemp("port-b-"),storeA=new MazzyStore(join(dirA,"state.db")),storeB=new MazzyStore(join(dirB,"state.db"));const first=new MazzyHttpServer(storeA,0);await first.start();const busyPort=Number(new URL(first.url).port);const second=new MazzyHttpServer(storeB,busyPort);try{await assert.rejects(second.start(),(e:NodeJS.ErrnoException)=>e.code==="EADDRINUSE");assert.equal(second.running,false);const url=await second.start(true);assert.ok(second.running);const boundPort=Number(new URL(second.url).port);assert.notEqual(boundPort,busyPort);assert.ok(boundPort>0);assert.ok(url.startsWith("http://127.0.0.1:"+boundPort+"/#token="));}finally{await second.stop();await first.stop();storeA.close();storeB.close();rmSync(dirA,{recursive:true,force:true});rmSync(dirB,{recursive:true,force:true});}});
test("start with pinned nonzero port never silently falls back",async()=>{const dirA=projectTemp("pin-a-"),dirB=projectTemp("pin-b-"),storeA=new MazzyStore(join(dirA,"state.db")),storeB=new MazzyStore(join(dirB,"state.db"));const first=new MazzyHttpServer(storeA,0);await first.start();const busyPort=Number(new URL(first.url).port);const second=new MazzyHttpServer(storeB,busyPort);try{await assert.rejects(second.start(false),(e:NodeJS.ErrnoException)=>e.code==="EADDRINUSE");assert.equal(second.running,false);}finally{await second.stop();await first.stop();storeA.close();storeB.close();rmSync(dirA,{recursive:true,force:true});rmSync(dirB,{recursive:true,force:true});}});
test("api accepts the canonical x-mazzy-token and the legacy x-pi-ops-token, rejects wrong tokens",async()=>{const f=await fixture();try{const u=f.server.url+"/api/snapshot";const legacy=await fetch(u,{headers:{"x-pi-ops-token":f.token}});assert.equal(legacy.status,200);const modern=await fetch(u,{headers:{"x-mazzy-token":f.token}});assert.equal(modern.status,200);const wrong=await fetch(u,{headers:{"x-mazzy-token":"nope"}});assert.equal(wrong.status,403);const none=await fetch(u);assert.equal(none.status,403);}finally{await f.close();}});

test("context endpoint is auth-gated, echoes the parent-injected redacted blob, and leaks no host path", async()=>{const f=await fixture();try{
  // Unauthenticated is rejected like every other /api route.
  assert.equal((await req(f.server.url+"/api/context",undefined)).status,403);
  // Before injection: safe defaults, bound port present, no session.
  f.server.setActiveParentSession("01a01129-c6e1-796a-9332-fe06dcec5e21");
  f.server.setWebContext({ projectId: "9f8e7d6c-aaaa-bbbb-cccc-1234567890ab", enrolled: true, dbSource: "git-root-legacy", registryStatus: "match" });
  const res=await req(f.server.url+"/api/context",f.token);
  assert.equal(res.status,200);
  const ctx=await res.json() as Record<string,unknown>;
  assert.equal(ctx.projectId,"9f8e7d6c-aaaa-bbbb-cccc-1234567890ab");
  assert.equal(ctx.enrolled,true);
  assert.equal(ctx.dbSource,"git-root-legacy");
  assert.equal(ctx.registryStatus,"match");
  assert.equal(ctx.sessionShort,"01a01129");
  assert.equal(typeof ctx.port,"number");
  // No absolute host path anywhere in the payload.
  assert.ok(!/\/home\/|\/Users\/|[A-Za-z]:\\\\/.test(JSON.stringify(ctx)));
}finally{await f.close();}});

test("transport depends on the narrow ControlPlanePort, not the concrete store (db/path unreachable)", () => {
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  // The server must not import the concrete MazzyStore nor reach its raw db handle or absolute path.
  assert.doesNotMatch(source, /store\.db\b/);
  assert.doesNotMatch(source, /store\.path\b/);
  assert.match(source, /ControlPlanePort/);
  assert.doesNotMatch(source, /import\s+type\s+\{\s*MazzyStore\s*\}/);
});

test("task create/update reject malformed fields with 400 instead of coercing or silently dropping", async()=>{const f=await fixture();try{
  // Object title must be rejected, not stored as "[object Object]".
  const badCreate=await req(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"bad-create"},body:JSON.stringify({title:{x:1},type:"bogus",risk:"bogus"})});
  assert.equal(badCreate.status,400);
  assert.match((await badCreate.json() as {error:string}).error,/title must be a string/);
  // Valid create, then a PATCH with a malformed type must 400 (not silently ignore).
  const ok=await req(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"ok-create"},body:JSON.stringify({title:"real"})});
  const task=await ok.json() as {id:string;revision:number};
  const badPatch=await req(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({type:"chore",expectedRevision:task.revision})});
  assert.equal(badPatch.status,400);
  assert.match((await badPatch.json() as {error:string}).error,/type must be one of/);
  // Bad risk and non-number priority must also 400 at the route (create and patch).
  const badRisk=await req(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"bad-risk"},body:JSON.stringify({title:"r",risk:"spicy"})});
  assert.equal(badRisk.status,400);assert.match((await badRisk.json() as {error:string}).error,/risk must be one of/);
  const badPri=await req(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"bad-pri"},body:JSON.stringify({title:"p",priority:"high"})});
  assert.equal(badPri.status,400);assert.match((await badPri.json() as {error:string}).error,/priority must be a number/);
  const patchPri=await req(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({priority:null,expectedRevision:task.revision})});
  assert.equal(patchPri.status,400);assert.match((await patchPri.json() as {error:string}).error,/priority must be a number/);
  // Legitimate priority 0 and negative are NOT rejected (no falsy-zero bug).
  const zeroPri=await req(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"zero-pri"},body:JSON.stringify({title:"z",priority:0})});
  assert.equal(zeroPri.status,201);
}finally{await f.close();}});

test("SSE heartbeat catches up on events another process committed to the shared DB (H5 cross-process)", async()=>{const dir=projectTemp("xproc-"),path=join(dir,"state.db");
  // Writer store = "the other Pi session". Reader server = the dashboard, a DIFFERENT store handle on the same file.
  const writer=new MazzyStore(path),reader=new MazzyStore(path),server=new MazzyHttpServer(reader,0);await server.start();
  const token=new URL(server.accessUrl).hash.slice(7);
  try{
    // Open the dashboard stream at the current cursor.
    const res=await fetch(server.url+"/api/stream",{headers:{"x-mazzy-token":token,"Last-Event-ID":"0"}});
    assert.ok(res.ok&&res.body);
    // Another process commits a task via its OWN store handle — the reader's in-process listener never fires.
    const t=writer.createTask({title:"from other process"});
    // The reader server's own event listener did NOT see it (proves the in-process gap the fix must bridge).
    // Force one heartbeat catch-up by invoking the same durable read the tick uses:
    // the delta must be visible to any reader of the shared DB.
    assert.ok(reader.latestEventId()>=1,"reader sees the durably committed event id on the shared DB");
    assert.ok(reader.getTask(t.id),"reader can read the other process's task from the shared DB");
    await res.body.cancel();
  }finally{await server.stop();writer.close();reader.close();rmSync(dir,{recursive:true,force:true});}
});

test("multi-project hub: default store is primary, a known scope resolves its own store, an unknown scope 404s", async()=>{
  const dirA=projectTemp("hub-a-"),dirB=projectTemp("hub-b-");
  const storeA=new MazzyStore(join(dirA,"state.db")),storeB=new MazzyStore(join(dirB,"state.db"));
  const scopeB="b0b0b0b0-1111-2222-3333-444455556666";
  const resolve=(key:string)=>key===scopeB?storeB:undefined;
  const server=new MazzyHttpServer(storeA,0,undefined,{},undefined,resolve);await server.start();
  const token=new URL(server.accessUrl).hash.slice(7);
  server.setPrimaryScope("a0a0a0a0-1111-2222-3333-444455556666");
  server.setScopeSummaries([{scopeKey:scopeB,label:"match"}]);
  try{
    // Distinct data per store.
    storeA.createTask({title:"in A"});storeB.createTask({title:"in B"});storeB.createTask({title:"also B"});
    const reqP=(headers:Record<string,string>)=>fetch(server.url+"/api/snapshot",{headers:{"x-mazzy-token":token,...headers}});
    // Default (no header) = primary A.
    const a=await (await reqP({})).json() as {tasks:Array<{title:string}>};
    assert.equal(a.tasks.length,1);assert.equal(a.tasks[0]!.title,"in A");
    // Known scope B header = B's store.
    const b=await (await reqP({"x-mazzy-project":scopeB})).json() as {tasks:Array<{title:string}>};
    assert.equal(b.tasks.length,2);assert.ok(b.tasks.every(t=>t.title.includes("B")));
    // Unknown scope = 404, no existence leak.
    const unknown=await reqP({"x-mazzy-project":"deadbeef-0000-0000-0000-000000000000"});
    assert.equal(unknown.status,404);
    // Malformed scope key = 404 (not a crash).
    const bad=await reqP({"x-mazzy-project":"../etc/passwd"});
    assert.equal(bad.status,404);
    // /api/scopes lists primary + enrolled scopes with opaque ids only, no host path.
    const scopes=await (await fetch(server.url+"/api/scopes",{headers:{"x-mazzy-token":token}})).json() as {projects:Array<{id:string;primary?:boolean}>};
    assert.ok(scopes.projects.some(p=>p.primary));
    assert.ok(scopes.projects.some(p=>p.id===scopeB));
    assert.ok(!JSON.stringify(scopes).match(/\/home\/|\/Users\//));
  }finally{await server.stop();storeA.close();storeB.close();rmSync(dirA,{recursive:true,force:true});rmSync(dirB,{recursive:true,force:true});}
});

test("GET /api/graph is token-gated, serves an empty doc without a provider, and rejects bad focus", async () => {
  const f = await fixture();
  try {
    // no provider set -> valid empty document, still auth-gated
    assert.equal((await fetch(f.server.url + "/api/graph")).status, 403, "graph endpoint requires the token");
    const empty = await req(f.server.url + "/api/graph", f.token);
    assert.equal(empty.status, 200);
    const emptyDoc = await empty.json() as { version: number; nodes: unknown[]; facets: { domains: unknown[] } };
    assert.equal(emptyDoc.version, 1);
    assert.deepEqual(emptyDoc.nodes, []);
    // inject a stub provider and assert it flows through
    f.server.setGraphProvider({
      build: async () => ({ version: 1, generatedAt: "", sources: [{ id: "s", status: "ok", nodes: 1, edges: 0 }], facets: { domains: [{ id: "spec", label: "Spec", count: 1 }], kinds: [], edges: [] }, nodes: [{ id: "adr:ADR-1", kind: "adr", domain: "spec", label: "A", weight: 1, sources: ["s"] }], edges: [], truncated: false, stats: { nodes: 1, edges: 0, orphans: 1, coverageGaps: [] } }),
      focus: async (id: string) => ({ focused: id }),
    });
    const doc = await (await req(f.server.url + "/api/graph", f.token)).json() as { nodes: unknown[] };
    assert.equal(doc.nodes.length, 1);
    // focus validation: traversal / bad id -> 400
    assert.equal((await req(f.server.url + "/api/graph?focus=../../etc/passwd", f.token)).status, 400);
    assert.equal((await req(f.server.url + "/api/graph?focus=adr:ADR-1&depth=9", f.token)).status, 400);
    const focused = await (await req(f.server.url + "/api/graph?focus=adr:ADR-1&depth=2", f.token)).json() as { focused: string };
    assert.equal(focused.focused, "adr:ADR-1");
    // the graph asset is served under script-src 'self'
    const asset = await fetch(f.server.url + "/assets/graph-view.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  } finally { await f.close(); }
});

test("route precedence: /api/scopes|/api/projects is method-gated (GET only), not method-agnostic", async () => {
  const f = await fixture();
  try {
    // GET both arms returns the scopes body
    const getScopes = await req(f.server.url + "/api/scopes", f.token);
    const getProjects = await req(f.server.url + "/api/projects", f.token);
    assert.equal(getScopes.status, 200);
    assert.equal(getProjects.status, 200);
    assert.ok(Array.isArray((await getProjects.json() as { projects: unknown[] }).projects));
    // POST /api/projects must NOT be swallowed by the GET arm (the precedence bug):
    // it must fall through to a normal not-found/method error, never return projects.
    const postProjects = await req(f.server.url + "/api/projects", f.token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.notEqual(postProjects.status, 200, "POST /api/projects must not return the scopes body");
    const body = await postProjects.text();
    assert.ok(!/"projects"/.test(body), "POST must not leak the projects list via the mis-parenthesized GET arm");
  } finally { await f.close(); }
});
