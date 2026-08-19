// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gitCapture } from "./git-safe.ts";
import { join, resolve } from "node:path";

export const ROUTING_INTENTS = ["bounded-recon", "review", "implementation", "architecture", "package-research"] as const;
export const ROUTING_RISKS = ["low", "medium", "high", "critical"] as const;
type RoutingIntent = (typeof ROUTING_INTENTS)[number];
type RoutingRisk = (typeof ROUTING_RISKS)[number];

type Agent = { model: string; skill?: string; topGate?: boolean };
type Lane = { agent: string; maxRisk: RoutingRisk; cacheable: boolean; requiresGateReason?: boolean };
export interface RoutingPolicy {
  version: "1";
  promptContractVersion: string;
  toolContractVersion: string;
  budgets: { defaultUsd: number; highRiskUsd: number; maxChildrenPerWave: number };
  agents: Record<string, Agent>;
  lanes: Record<RoutingIntent, Lane>;
  escalationTargets: Record<RoutingIntent, string>;
  cache: { keyVersion: string; deterministicOperations: string[] };
}

export interface RouteInput {
  intent: RoutingIntent;
  risk: RoutingRisk;
  operation?: string;
  inputDigest?: string;
  sourceRevision?: string;
  gateReason?: string;
}
export interface RouteResult {
  selectedAgent: string;
  model: string;
  skill: string | undefined;
  escalationTarget: string;
  escalationDecision: "none" | "risk-escalation" | "gate-reason-required" | "gate-approved";
  cacheEligible: boolean;
  cacheKey?: string;
}

const riskRank: Record<RoutingRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Validates untrusted JSON without mutating it or consulting external state. */
export function validateRoutingPolicy(value: unknown): RoutingPolicy {
  if (!isRecord(value) || value.version !== "1") throw new Error("Unsupported routing policy version");
  if (!isNonEmptyString(value.promptContractVersion) || !isNonEmptyString(value.toolContractVersion)) throw new Error("Routing policy contract versions are required");
  if (!isRecord(value.budgets)) throw new Error("Invalid routing policy budgets");
  const defaultUsd = value.budgets.defaultUsd;
  const highRiskUsd = value.budgets.highRiskUsd;
  const maxChildrenPerWave = value.budgets.maxChildrenPerWave;
  if (typeof defaultUsd !== "number" || typeof highRiskUsd !== "number" || typeof maxChildrenPerWave !== "number"
    || !Number.isFinite(defaultUsd) || !Number.isFinite(highRiskUsd) || !Number.isInteger(maxChildrenPerWave)
    || defaultUsd < 0 || highRiskUsd < 0 || maxChildrenPerWave < 1) {
    throw new Error("Invalid routing policy budgets");
  }
  if (!isRecord(value.agents) || !isRecord(value.lanes) || !isRecord(value.escalationTargets) || !isRecord(value.cache)) throw new Error("Routing policy sections are required");
  const agents: Record<string, Agent> = {};
  for (const [name, agent] of Object.entries(value.agents)) {
    if (!isRecord(agent) || !isNonEmptyString(agent.model)
      || (agent.skill !== undefined && !isNonEmptyString(agent.skill))
      || (agent.topGate !== undefined && typeof agent.topGate !== "boolean")) {
      throw new Error(`Invalid routing agent: ${name}`);
    }
    agents[name] = {
      model: agent.model,
      skill: agent.skill as string | undefined,
      topGate: agent.topGate as boolean | undefined,
    };
  }
  const lanes = {} as Record<RoutingIntent, Lane>;
  const escalationTargets = {} as Record<RoutingIntent, string>;
  for (const name of Object.keys(value.lanes)) if (!ROUTING_INTENTS.includes(name as RoutingIntent)) throw new Error(`Unknown routing lane: ${name}`);
  for (const name of Object.keys(value.escalationTargets)) if (!ROUTING_INTENTS.includes(name as RoutingIntent)) throw new Error(`Unknown escalation lane: ${name}`);
  for (const intent of ROUTING_INTENTS) {
    const lane = value.lanes[intent];
    const escalation = value.escalationTargets[intent];
    if (!isRecord(lane) || !isNonEmptyString(lane.agent) || !ROUTING_RISKS.includes(lane.maxRisk as RoutingRisk)
      || typeof lane.cacheable !== "boolean" || (lane.requiresGateReason !== undefined && typeof lane.requiresGateReason !== "boolean")) {
      throw new Error(`Invalid routing lane: ${intent}`);
    }
    if (!agents[lane.agent]) throw new Error(`Unknown agent in lane ${intent}: ${lane.agent}`);
    if (!isNonEmptyString(escalation) || !agents[escalation]) throw new Error(`Unknown escalation target for ${intent}`);
    lanes[intent] = { agent: lane.agent, maxRisk: lane.maxRisk as RoutingRisk, cacheable: lane.cacheable, requiresGateReason: lane.requiresGateReason as boolean | undefined };
    escalationTargets[intent] = escalation;
  }
  if (!isNonEmptyString(value.cache.keyVersion) || !Array.isArray(value.cache.deterministicOperations)
    || !value.cache.deterministicOperations.every(isNonEmptyString)) throw new Error("Invalid routing cache policy");
  return {
    version: "1", promptContractVersion: value.promptContractVersion, toolContractVersion: value.toolContractVersion,
    budgets: { defaultUsd, highRiskUsd, maxChildrenPerWave },
    agents, lanes, escalationTargets, cache: { keyVersion: value.cache.keyVersion, deterministicOperations: [...value.cache.deterministicOperations] },
  };
}

/**
 * Resolves policy in public, portable precedence: explicit operator path, trusted
 * project policy, then the package-owned fallback. No monorepo path is required.
 */
export function resolveRoutingPolicyPath(cwd = process.cwd(), explicit = process.env.MAZZY_ROUTING ?? process.env.PI_OPS_ROUTING): string | URL {
  if (explicit?.trim()) return resolve(cwd, explicit.trim());
  try {
    const root = gitCapture(cwd, ["rev-parse", "--show-toplevel"]);
    const projectPolicy = join(root, ".pi", "mazzy", "routing.json");
    if (root && existsSync(projectPolicy)) return projectPolicy;
  } catch { /* An untrusted/non-Git directory deliberately uses the packaged default. */ }
  return new URL("../resources/routing.json", import.meta.url);
}
/** The only I/O in this module: reads and validates a versioned policy file. */
export function loadRoutingPolicy(path: string | URL = resolveRoutingPolicyPath()): RoutingPolicy {
  return validateRoutingPolicy(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function eligibleForCache(policy: RoutingPolicy, input: RouteInput, selectedAgent: string): boolean {
  // L4 candidates are deliberately narrower than read-only routing: no writer, verifier,
  // evidence, failure, uncertain, mutable, unknown, or incomplete inputs are cacheable.
  const operation = input.operation?.trim().toLowerCase();
  // Cacheable only on the recon lane, and only for that lane's own configured
  // agent (policy-driven, not a hardcoded agent id).
  const reconAgent = policy.lanes["bounded-recon"]?.agent;
  if (input.intent !== "bounded-recon" || selectedAgent !== reconAgent || !policy.lanes[input.intent].cacheable) return false;
  if (!operation || !policy.cache.deterministicOperations.includes(operation)) return false;
  if (!input.inputDigest || !/^[a-f0-9]{64}$/i.test(input.inputDigest) || !input.sourceRevision || !/^[a-f0-9]{7,64}$/i.test(input.sourceRevision)) return false;
  return true;
}

export function route(policy: RoutingPolicy, input: RouteInput): RouteResult {
  if (!ROUTING_INTENTS.includes(input.intent)) throw new Error(`Unknown routing intent: ${String(input.intent)}`);
  if (!ROUTING_RISKS.includes(input.risk)) throw new Error(`Unknown routing risk: ${String(input.risk)}`);
  const lane = policy.lanes[input.intent];
  let selectedAgent = lane.agent;
  let escalationDecision: RouteResult["escalationDecision"] = "none";
  const gateReason = input.gateReason?.trim();
  const riskEscalated = riskRank[input.risk] > riskRank[lane.maxRisk];
  if (riskEscalated) {
    selectedAgent = policy.escalationTargets[input.intent];
    escalationDecision = "risk-escalation";
  }
  let agent = policy.agents[selectedAgent];
  if (!agent) throw new Error(`Unknown selected routing agent: ${selectedAgent}`);
  if (agent.topGate || lane.requiresGateReason) {
    if (!gateReason) {
      selectedAgent = policy.lanes.review.agent;
      escalationDecision = "gate-reason-required";
      agent = policy.agents[selectedAgent];
      if (!agent) throw new Error(`Unknown review fallback routing agent: ${selectedAgent}`);
    } else if (lane.requiresGateReason && !riskEscalated) {
      escalationDecision = "gate-approved";
    }
  }
  const cacheEligible = eligibleForCache(policy, input, selectedAgent);
  const cacheKey = cacheEligible
    ? createHash("sha256").update(JSON.stringify([policy.cache.keyVersion, input.operation!.trim().toLowerCase(), input.inputDigest!.toLowerCase(), input.sourceRevision!.toLowerCase(), agent.model, policy.promptContractVersion, policy.toolContractVersion, agent.skill])).digest("hex")
    : undefined;
  return { selectedAgent, model: agent.model, skill: agent.skill, escalationTarget: policy.escalationTargets[input.intent], escalationDecision, cacheEligible, cacheKey };
}