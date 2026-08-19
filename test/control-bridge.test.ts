// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";
import { fixedCommentDoorbell, fixedControlDoorbell } from "../src/control-bridge.ts";
import { assertMazzyParent } from "../src/index.ts";

test("fixed doorbell contains identifiers only, does not interpolate data, and selects delivery safely", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const go = fixedControlDoorbell(id, "GO", true);
  assert.deepEqual(go, { text: `/skill:mazzy-orchestrator requestId=${id} command=GO`, options: { deliverAs: "followUp", expandPromptTemplates: false } });
  assert.equal(fixedControlDoorbell(id, "PAUSE", true).options.deliverAs, "followUp");
  assert.equal(fixedControlDoorbell(id, "STOP", true).options.deliverAs, "steer");
  assert.equal(fixedControlDoorbell(id, "STOP", false).options.deliverAs, "followUp");
  assert.ok(!go.text.includes("operator"));
  assert.throws(() => fixedControlDoorbell("not-a-request", "GO", false), /Invalid control request id/);
});

test("discussion doorbell is fixed identifier-only followUp with no template expansion",()=>{const taskId="123e4567-e89b-42d3-a456-426614174000",commentId="123e4567-e89b-42d3-a456-426614174001";const bell=fixedCommentDoorbell(taskId,commentId);assert.deepEqual(bell,{text:`/skill:mazzy-orchestrator discussion taskId=${taskId} commentId=${commentId}`,options:{deliverAs:"followUp",expandPromptTemplates:false}});assert.ok(!bell.text.includes("body"));assert.throws(()=>fixedCommentDoorbell("bad",commentId),/identifier/);});

test("child runtime guard rejects control-plane bridge ownership", () => {
  const prior = process.env.PI_SUBAGENT_CHILD;
  try { process.env.PI_SUBAGENT_CHILD = "1"; assert.throws(() => assertMazzyParent(), /parent-only/); }
  finally { if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = prior; }
});