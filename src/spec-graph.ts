// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import {
  assertNoHostPaths, buildFacets, mergeDeltas, safeMessage, sweepDangling,
  type GraphDelta, type GraphDocument, type GraphEdge, type GraphNode, type GraphSource, type SourceBudget, type SourceReport,
} from "./graph-model.ts";

/**
 * spec-graph.ts — the server-side graph assembler.
 *
 * Merges a registry of GraphSources into one INV-3-clean GraphDocument, with a
 * TTL cache, hard node/edge caps (DoS bound), fail-closed host-path gate, and a
 * focus-subgraph helper. Constructed in index.ts with real sources and injected
 * into the HTTP server (setGraphProvider), so server.ts stays identity-free.
 */
export interface AssemblerOptions {
  maxNodes?: number;
  maxEdges?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULTS = { maxNodes: 1500, maxEdges: 6000, ttlMs: 30_000 };

export class SpecGraphAssembler {
  private cache?: { at: number; doc: GraphDocument };
  private readonly sources: GraphSource[];
  private readonly maxNodes: number;
  private readonly maxEdges: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(sources: GraphSource[], opts: AssemblerOptions = {}) {
    this.sources = sources;
    this.maxNodes = opts.maxNodes ?? DEFAULTS.maxNodes;
    this.maxEdges = opts.maxEdges ?? DEFAULTS.maxEdges;
    this.ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
    this.now = opts.now ?? (() => Date.now());
  }

  async build(): Promise<GraphDocument> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.doc;

    const budget: SourceBudget = { maxNodes: this.maxNodes, maxEdges: this.maxEdges };
    const deltas: GraphDelta[] = [];
    const reports: SourceReport[] = [];

    for (const src of this.sources) {
      let ok = false;
      try { ok = await src.available(); } catch { ok = false; }
      if (!ok) { reports.push({ id: src.id, status: "absent", nodes: 0, edges: 0 }); continue; }
      try {
        const d = await src.load(budget);
        deltas.push(d);
        reports.push({ id: src.id, status: "ok", nodes: d.nodes.length, edges: d.edges.length, note: d.note });
      } catch (e) {
        reports.push({ id: src.id, status: "error", nodes: 0, edges: 0, note: safeMessage(e) });
      }
    }

    const { nodes, edges } = mergeDeltas(deltas);
    const coverageGaps = sweepDangling(nodes, edges);

    // Truncation (DoS bound): drop lowest-weight edges first, then orphan nodes.
    let edgeList = [...edges.values()];
    let nodeList = [...nodes.values()];
    let truncated = false;
    if (edgeList.length > this.maxEdges) {
      edgeList = edgeList.sort((a, b) => b.weight - a.weight).slice(0, this.maxEdges);
      truncated = true;
    }
    if (nodeList.length > this.maxNodes) {
      const keep = new Set<string>();
      for (const e of edgeList) { keep.add(e.from); keep.add(e.to); }
      nodeList = nodeList
        .sort((a, b) => b.weight - a.weight)
        .filter((n, i) => i < this.maxNodes || keep.has(n.id))
        .slice(0, this.maxNodes);
      truncated = true;
    }
    // After node truncation, drop edges whose endpoints were removed.
    const present = new Set(nodeList.map((n) => n.id));
    edgeList = edgeList.filter((e) => present.has(e.from) && present.has(e.to));

    const orphans = countOrphans(nodeList, edgeList);
    const doc: GraphDocument = {
      version: 1,
      generatedAt: new Date(t).toISOString(),
      sources: reports,
      facets: buildFacets(nodeList, edgeList),
      nodes: nodeList,
      edges: edgeList,
      truncated,
      stats: { nodes: nodeList.length, edges: edgeList.length, orphans, coverageGaps },
    };

    // Fail-closed INV-3 gate on the fully assembled document.
    assertNoHostPaths(doc);

    this.cache = { at: t, doc };
    return doc;
  }

  /** BFS neighbourhood of a node id to a bounded depth (1..3). Read-only view. */
  static focusSubgraph(doc: GraphDocument, focusId: string, depth: number): GraphDocument {
    const d = Math.max(1, Math.min(3, Math.floor(depth) || 1));
    if (!doc.nodes.some((n) => n.id === focusId)) return { ...doc, nodes: [], edges: [], facets: buildFacets([], []), stats: { ...doc.stats, nodes: 0, edges: 0 } };
    const adj = new Map<string, GraphEdge[]>();
    for (const e of doc.edges) { (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e); (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e); }
    const keep = new Set<string>([focusId]);
    let frontier = [focusId];
    for (let i = 0; i < d; i++) {
      const next: string[] = [];
      for (const id of frontier) for (const e of adj.get(id) ?? []) {
        const other = e.from === id ? e.to : e.from;
        if (!keep.has(other)) { keep.add(other); next.push(other); }
      }
      frontier = next;
    }
    const nodes = doc.nodes.filter((n) => keep.has(n.id));
    const edges = doc.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    return { ...doc, nodes, edges, facets: buildFacets(nodes, edges), stats: { ...doc.stats, nodes: nodes.length, edges: edges.length, orphans: countOrphans(nodes, edges) } };
  }
}

function countOrphans(nodes: GraphNode[], edges: GraphEdge[]): number {
  const linked = new Set<string>();
  for (const e of edges) { linked.add(e.from); linked.add(e.to); }
  return nodes.filter((n) => !linked.has(n.id)).length;
}