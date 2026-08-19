// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeClause, domainOf, type GraphDelta, type GraphEdge, type GraphNode, type GraphSource, type NodeKind, type SourceBudget } from "../graph-model.ts";
import { SPEC_RE } from "../reverse-graph.ts";

/**
 * spec-source — the specification constellation from docs/*.md.
 *
 * Extracts every clause id and its nearest preceding heading as a label, and
 * emits a `references` edge when two clauses are cited within the same heading
 * section (co-citation). Only relative doc refs leave (INV-3).
 */
export class SpecDocSource implements GraphSource {
  readonly id = "spec";
  private readonly docsDir: string;
  constructor(docsDir: string) { this.docsDir = docsDir; }

  available(): boolean {
    try { return existsSync(this.docsDir) && readdirSync(this.docsDir).some((f) => f.endsWith(".md")); }
    catch { return false; }
  }

  load(budget: SourceBudget): GraphDelta {
    const files = readdirSync(this.docsDir).filter((f) => f.endsWith(".md")).sort();
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const labelOf = new Map<string, string>();

    for (const file of files) {
      const rel = `docs/${file}`;
      const lines = readFileSync(join(this.docsDir, file), "utf8").split("\n");
      let heading = "";
      const sectionClauses: string[] = [];
      const flushSection = (): void => {
        // co-citation references within one heading section (bounded to avoid n^2 blowup)
        const uniq = [...new Set(sectionClauses)].slice(0, 12);
        for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
          const [a, b] = [uniq[i], uniq[j]].sort();
          const id = `${a}|references|${b}`;
          if (!edges.has(id)) edges.set(id, { id, from: a, to: b, kind: "references", weight: 1, sources: [this.id] });
        }
        sectionClauses.length = 0;
      };
      for (const line of lines) {
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        if (h) { flushSection(); heading = h[1].trim().slice(0, 80); }
        for (const m of line.matchAll(SPEC_RE)) {
          const clause = canonicalizeClause(m[1]);
          const kind = clauseKind(clause);
          if (!kind) continue;
          const id = `${kind}:${clause}`;
          if (!nodes.has(id)) nodes.set(id, { id, kind, domain: domainOf(kind), label: clause, ref: rel, weight: 1, sources: [this.id] });
          else nodes.get(id)!.weight += 1;
          // Prefer a definitional heading (e.g. "### ADR-015 — …") as the label.
          if (heading.includes(clause) && !labelOf.has(id)) { labelOf.set(id, heading); nodes.get(id)!.label = heading; }
          sectionClauses.push(id);
          if (nodes.size >= budget.maxNodes) break;
        }
      }
      flushSection();
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