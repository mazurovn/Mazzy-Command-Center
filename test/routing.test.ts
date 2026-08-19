// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoutingPolicy, resolveRoutingPolicyPath, route, validateRoutingPolicy } from "../src/routing.ts";

const digest = "a".repeat(64);
const revision = "b".repeat(40);

const scratchRoot = testScratchRoot;
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }

test("routes bounded reconnaissance to the cheap default and produces stable L4 candidate keys", () => {
  const policy = loadRoutingPolicy();
  const input = { intent: "bounded-recon" as const, risk: "low" as const, operation: "symbol-lookup", inputDigest: digest, sourceRevision: revision };
  const first = route(policy, input);
  const second = route(policy, { ...input });
  assert.equal(first.selectedAgent, "scout");
  assert.equal(first.model, "auto");
  assert.equal(first.skill, "mazzy-bounded-recon");
  assert.equal(first.cacheEligible, true);
  assert.equal(first.cacheKey, second.cacheKey);
});

test("escalates risk and permits direct top-gate architecture only with a gate reason", () => {
  const policy = loadRoutingPolicy();
  const highRecon = route(policy, { intent: "bounded-recon", risk: "high" });
  assert.equal(highRecon.selectedAgent, "reviewer");
  assert.equal(highRecon.escalationDecision, "risk-escalation");
  const ungated = route(policy, { intent: "architecture", risk: "high" });
  assert.equal(ungated.selectedAgent, "reviewer");
  assert.equal(ungated.escalationDecision, "gate-reason-required");
  const gated = route(policy, { intent: "architecture", risk: "high", gateReason: "release security gate" });
  assert.equal(gated.selectedAgent, "planner");
  assert.equal(gated.escalationDecision, "gate-approved");
});

test("requires a gate reason before risk escalation reaches a top-gate agent", () => {
  const policy = loadRoutingPolicy();
  const criticalReview = route(policy, { intent: "review", risk: "critical" });
  assert.equal(criticalReview.selectedAgent, "reviewer");
  assert.equal(criticalReview.escalationDecision, "gate-reason-required");
  const highResearch = route(policy, { intent: "package-research", risk: "high" });
  assert.equal(highResearch.selectedAgent, "reviewer");
  assert.equal(highResearch.escalationDecision, "gate-reason-required");
  const approvedReview = route(policy, { intent: "review", risk: "critical", gateReason: "security release review" });
  assert.equal(approvedReview.selectedAgent, "planner");
  assert.equal(approvedReview.escalationDecision, "risk-escalation");
});

test("accepts agents without skills and rejects malformed and unknown-agent policies", () => {
  assert.throws(() => validateRoutingPolicy({ version: "2" }), /Unsupported/);
  const policy = loadRoutingPolicy();
  assert.equal(policy.agents["reviewer"]?.skill, undefined);
  assert.equal(policy.agents["planner"]?.topGate, true);
  const broken = structuredClone(policy) as unknown as { lanes: { review: { agent: string } } };
  broken.lanes.review.agent = "not-approved";
  assert.throws(() => validateRoutingPolicy(broken), /Unknown agent/);
  const unknownLane = structuredClone(policy) as unknown as { lanes: Record<string, unknown> };
  unknownLane.lanes.unapproved = {};
  assert.throws(() => validateRoutingPolicy(unknownLane), /Unknown routing lane/);
});

test("routing policy precedence is env, trusted project, then packaged fallback", () => {
  const dir = projectTemp("mazzy-routing-"); const old = process.env.PI_OPS_ROUTING;
  try {
    execFileSync("git", ["init", "-q", dir]); mkdirSync(join(dir, ".pi", "mazzy"), { recursive: true });
    const policyPath = join(dir, ".pi", "mazzy", "routing.json"); writeFileSync(policyPath, JSON.stringify(loadRoutingPolicy()));
    const envPath = join(dir, "env-routing.json"); writeFileSync(envPath, JSON.stringify(loadRoutingPolicy()));
    process.env.PI_OPS_ROUTING = envPath;
    assert.equal(resolveRoutingPolicyPath(dir), envPath);
    delete process.env.PI_OPS_ROUTING;
    assert.equal(resolveRoutingPolicyPath(dir), policyPath);
    rmSync(policyPath);
    const fallback = resolveRoutingPolicyPath(dir);
    assert.match(String(fallback), /resources\/routing\.json/); assert.equal(loadRoutingPolicy(fallback).version, "1");
  } finally { if (old === undefined) delete process.env.PI_OPS_ROUTING; else process.env.PI_OPS_ROUTING = old; rmSync(dir, { recursive: true, force: true }); }
});

test("malformed routing overrides fail only when loaded and leave fallback/dashboard callers usable", () => {
  const dir = projectTemp("mazzy-routing-bad-"); const old = process.env.PI_OPS_ROUTING;
  try {
    execFileSync("git", ["init", "-q", dir]); const malformed = join(dir, "bad.json"); writeFileSync(malformed, "{");
    process.env.PI_OPS_ROUTING = malformed;
    assert.equal(resolveRoutingPolicyPath(dir), malformed); // resolution/import is deliberately lazy
    assert.throws(() => loadRoutingPolicy(resolveRoutingPolicyPath(dir)), SyntaxError);
    delete process.env.PI_OPS_ROUTING; mkdirSync(join(dir, ".pi", "mazzy"), { recursive: true }); writeFileSync(join(dir, ".pi", "mazzy", "routing.json"), "not-json");
    assert.doesNotThrow(() => resolveRoutingPolicyPath(dir));
    assert.throws(() => loadRoutingPolicy(resolveRoutingPolicyPath(dir)), SyntaxError);
    rmSync(join(dir, ".pi", "mazzy", "routing.json"));
    assert.doesNotThrow(() => loadRoutingPolicy(resolveRoutingPolicyPath(dir)));
  } finally { if (old === undefined) delete process.env.PI_OPS_ROUTING; else process.env.PI_OPS_ROUTING = old; rmSync(dir, { recursive: true, force: true }); }
});

test("explicitly excludes writer, verifier, evidence, uncertain and incomplete work from caching", () => {
  const policy = loadRoutingPolicy();
  for (const input of [
    { intent: "implementation" as const, risk: "low" as const, operation: "symbol-lookup", inputDigest: digest, sourceRevision: revision },
    { intent: "review" as const, risk: "low" as const, operation: "symbol-lookup", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "evidence", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "writer", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "verifier", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "evidence", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "failure", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "uncertain", inputDigest: digest, sourceRevision: revision },
    { intent: "bounded-recon" as const, risk: "low" as const, operation: "symbol-lookup" },
  ]) assert.equal(route(policy, input).cacheEligible, false, input.operation);
});