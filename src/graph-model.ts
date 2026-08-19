// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

/**
 * graph-model.ts — the unified spec<->component<->backlog graph model.
 *
 * Pure, zero-I/O. Sources emit canonical-id
 * nodes/edges; the assembler merges by id, normalizes governs/realizes to one
 * direction, sweeps dangling edges into visible "gap" nodes, derives facets that
 * drive the whole client UI, and runs a fail-closed INV-3 host-path gate.
 */

export type NodeDomain = "spec" | "code" | "backlog" | "memory";
export type NodeKind =
  | "adr" | "inv" | "fr" | "us" | "nfr" | "req"   // spec
  | "file" | "symbol"                              // code
  | "epic" | "feature" | "task"                    // backlog
  | "note" | "vector";                             // memory (R10, reserved)
export type EdgeKind =
  | "governs" | "realizes" | "references" | "depends" | "renames" | "contains";

export interface GraphNode {
  id: string;              // canonical `${kind}:${slug}` e.g. "adr:ADR-015"
  kind: NodeKind;
  domain: NodeDomain;
  label: string;
  ref?: string;            // repo-RELATIVE ref only, never a host path (INV-3)
  status?: string;         // enum-ish: task state, "carve_out", "gap", …
  weight: number;
  sources: string[];
  meta?: Record<string, string | number | boolean>;
}
export interface GraphEdge {
  id: string;              // `${from}|${kind}|${to}`
  from: string; to: string; kind: EdgeKind;
  weight: number;
  sources: string[];
}
export interface SourceReport {
  id: string; status: "ok" | "absent" | "error"; nodes: number; edges: number; note?: string;
}
export interface GraphFacets {
  domains: Array<{ id: NodeDomain; label: string; count: number }>;
  kinds: Array<{ id: NodeKind; domain: NodeDomain; label: string; count: number }>;
  edges: Array<{ id: EdgeKind; label: string; count: number }>;
}
export interface GraphDocument {
  version: 1;
  generatedAt: string;
  sources: SourceReport[];
  facets: GraphFacets;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  stats: { nodes: number; edges: number; orphans: number; coverageGaps: string[] };
}
export interface SourceBudget { maxNodes: number; maxEdges: number; }
export interface GraphDelta { nodes: GraphNode[]; edges: GraphEdge[]; note?: string; }
export interface GraphSource {
  readonly id: string;
  available(): boolean | Promise<boolean>;
  load(budget: SourceBudget): GraphDelta | Promise<GraphDelta>;
}

const DOMAIN_OF: Record<NodeKind, NodeDomain> = {
  adr: "spec", inv: "spec", fr: "spec", us: "spec", nfr: "spec", req: "spec",
  file: "code", symbol: "code",
  epic: "backlog", feature: "backlog", task: "backlog",
  note: "memory", vector: "memory",
};
export function domainOf(kind: NodeKind): NodeDomain { return DOMAIN_OF[kind] ?? "spec"; }

// Constraint-kind clauses store the spec->artifact relation as `governs`; demand
// kinds (fr/us) store artifact->spec as `realizes`. Used to pick one direction.
const CONSTRAINT_KINDS = new Set<NodeKind>(["adr", "inv", "nfr"]);
export function isConstraintKind(kind: NodeKind): boolean { return CONSTRAINT_KINDS.has(kind); }

/** Normalize a clause id: uppercase, zero-pad the numeric run to 3, fold the prime. */
export function canonicalizeClause(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\u2032/g, "'");
  const m = /^([A-Z]+(?:-[A-Z]+)?)-0*(\d+)('?)$/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(3, "0")}${m[3]}`;
}

/** Merge a list of deltas into node/edge maps by canonical id. */
export function mergeDeltas(deltas: GraphDelta[]): { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const d of deltas) {
    for (const n of d.nodes) {
      const prev = nodes.get(n.id);
      if (!prev) { nodes.set(n.id, { ...n, sources: [...new Set(n.sources)] }); continue; }
      prev.weight += n.weight;
      prev.sources = [...new Set([...prev.sources, ...n.sources])];
      if (!prev.label && n.label) prev.label = n.label;      // first non-empty wins
      if (!prev.ref && n.ref) prev.ref = n.ref;
      if (!prev.status && n.status) prev.status = n.status;
      if (n.meta) prev.meta = { ...n.meta, ...(prev.meta ?? {}) }; // existing wins
    }
    for (const e of d.edges) {
      const prev = edges.get(e.id);
      if (!prev) { edges.set(e.id, { ...e, sources: [...new Set(e.sources)] }); continue; }
      prev.weight += e.weight;
      prev.sources = [...new Set([...prev.sources, ...e.sources])];
    }
  }
  return { nodes, edges };
}

/** Sweep edges whose endpoints are missing; ghost-promote missing spec endpoints to gap nodes. */
export function sweepDangling(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): string[] {
  const gaps: string[] = [];
  const ensureGhost = (id: string): boolean => {
    if (nodes.has(id)) return true;
    const [kind] = id.split(":");
    if (["adr", "inv", "fr", "us", "nfr", "req"].includes(kind)) {
      nodes.set(id, { id, kind: kind as NodeKind, domain: "spec", label: id.split(":")[1] ?? id, status: "gap", weight: 1, sources: ["ghost"] });
      gaps.push(id);
      return true;
    }
    return false;
  };
  for (const [key, e] of [...edges]) {
    const okFrom = ensureGhost(e.from);
    const okTo = ensureGhost(e.to);
    if (!okFrom || !okTo) edges.delete(key);
  }
  return [...new Set(gaps)];
}

/** Build the facets that drive the client legend/filter — never hardcoded in HTML. */
export function buildFacets(nodes: GraphNode[], edges: GraphEdge[]): GraphFacets {
  const domainCount = new Map<NodeDomain, number>();
  const kindCount = new Map<NodeKind, number>();
  const edgeCount = new Map<EdgeKind, number>();
  for (const n of nodes) {
    domainCount.set(n.domain, (domainCount.get(n.domain) ?? 0) + 1);
    kindCount.set(n.kind, (kindCount.get(n.kind) ?? 0) + 1);
  }
  for (const e of edges) edgeCount.set(e.kind, (edgeCount.get(e.kind) ?? 0) + 1);
  const label = (s: string): string => s.replace(/(^|[-_])([a-z])/g, (_m, _s, c: string) => " " + c.toUpperCase()).trim();
  return {
    domains: [...domainCount].map(([id, count]) => ({ id, label: label(id), count })).sort((a, b) => a.id.localeCompare(b.id)),
    kinds: [...kindCount].map(([id, count]) => ({ id, domain: domainOf(id), label: id.toUpperCase(), count })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edgeCount].map(([id, count]) => ({ id, label: label(id), count })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const HOST_PATH_RE = /(^|["'\s:(=])(\/(?:home|Users|root|var|etc|tmp|mnt|opt)\/|[A-Za-z]:\\|~\/)/;

/** Fail-closed INV-3 gate: throw if any node/edge field carries a host path shape. */
export function assertNoHostPaths(doc: GraphDocument): void {
  const scan = (label: string, value: unknown): void => {
    if (typeof value !== "string") return;
    if (HOST_PATH_RE.test(value)) throw new Error(`INV-3 violation: host path in ${label}: ${value.slice(0, 80)}`);
  };
  for (const n of doc.nodes) {
    scan(`node.id`, n.id); scan(`node.label`, n.label); scan(`node.ref`, n.ref);
    if (n.meta) for (const [k, v] of Object.entries(n.meta)) scan(`node.meta.${k}`, v);
  }
  for (const s of doc.sources) scan(`source.note`, s.note);
}

/** Strip absolute-path shapes from a diagnostic message before it reaches the client. */
export function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/(\/(?:home|Users|root|var|etc|tmp|mnt|opt)\/[^\s"']*|[A-Za-z]:\\[^\s"']*)/g, "<path>").slice(0, 200);
}