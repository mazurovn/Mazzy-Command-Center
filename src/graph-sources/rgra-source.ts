// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { existsSync, readFileSync } from "node:fs";
import { canonicalizeClause, domainOf, isConstraintKind, type GraphDelta, type GraphEdge, type GraphNode, type GraphSource, type NodeKind, type SourceBudget } from "../graph-model.ts";

/**
 * rgra-source — code<->spec edges from the RGRA graph.json artifact.
 *
 * INV-3: the artifact carries an absolute `root` and absolute `scanned`/`file`
 * paths. This source strips `root` from every file ref so ONLY repo-relative
 * refs leave; the assembler's assertNoHostPaths gate is the fail-closed backstop.
 */
interface RgraHit { file: string; identifier: string; action: string; renamesTo?: string; specRefs: string[]; }
interface RgraJson { root: string; hits: RgraHit[]; }

export class RgraGraphSource implements GraphSource {
  readonly id = "rgra";
  private readonly jsonPath: string;
  constructor(jsonPath: string) { this.jsonPath = jsonPath; }

  available(): boolean {
    try { return existsSync(this.jsonPath) && typeof JSON.parse(readFileSync(this.jsonPath, "utf8")).root === "string"; }
    catch { return false; }
  }

  load(budget: SourceBudget): GraphDelta {
    const doc = JSON.parse(readFileSync(this.jsonPath, "utf8")) as RgraJson;
    const root = doc.root.replace(/\/+$/, "");
    const rel = (p: string): string => p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, "") : p.replace(/^\/+/, "");
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    const addNode = (n: GraphNode): void => { if (!nodes.has(n.id)) nodes.set(n.id, n); else nodes.get(n.id)!.weight += n.weight; };
    const addEdge = (from: string, to: string, kind: GraphEdge["kind"]): void => {
      const id = `${from}|${kind}|${to}`;
      if (!edges.has(id)) edges.set(id, { id, from, to, kind, weight: 1, sources: [this.id] });
      else edges.get(id)!.weight += 1;
    };

    for (const hit of doc.hits) {
      if (nodes.size >= budget.maxNodes) break;
      const file = rel(hit.file);
      const fileId = `file:${file}`;
      addNode({ id: fileId, kind: "file", domain: "code", label: file.split("/").pop() ?? file, ref: file, weight: 1, sources: [this.id] });
      const symId = `symbol:${hit.identifier}`;
      addNode({ id: symId, kind: "symbol", domain: "code", label: hit.identifier, weight: 1, sources: [this.id], status: hit.action === "carve_out" ? "carve_out" : undefined, meta: hit.renamesTo ? { renamesTo: hit.renamesTo } : undefined });
      addEdge(fileId, symId, "contains");
      // spec bindings from the hit's governing clauses
      for (const raw of hit.specRefs) {
        const clause = canonicalizeClause(raw);
        const kind = clauseKind(clause);
        if (!kind) continue;
        const specId = `${kind}:${clause}`;
        addNode({ id: specId, kind, domain: domainOf(kind), label: clause, weight: 1, sources: [this.id] });
        // constraint clause governs the symbol; demand clause is realized by it
        if (isConstraintKind(kind)) addEdge(specId, symId, "governs");
        else addEdge(symId, specId, "realizes");
      }
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}

function clauseKind(clause: string): NodeKind | undefined {
  if (clause.startsWith("ADR-")) return "adr";
  if (clause.startsWith("INV-")) return "inv";
  if (clause.startsWith("FR-")) return "fr";
  if (clause.startsWith("US-")) return "us";
  if (clause.startsWith("NFR-")) return "nfr";
  return undefined;
}