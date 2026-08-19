import { canonicalizeClause, domainOf, type GraphDelta, type GraphEdge, type GraphNode, type GraphSource, type NodeKind, type SourceBudget } from "../graph-model.ts";
import { specRefsIn } from "../reverse-graph.ts";
import type { ControlPlanePort, TaskType } from "../types.ts";

/**
 * backlog-source — epic/feature/task nodes from the durable control store, with
 * `realizes` edges to any spec clause cited in a task's title/description. This
 * is what makes "which backlog items implement ADR-016" answerable in the graph.
 * INV-3: only opaque task ids and short titles cross; no host paths exist here.
 */
export class BacklogSource implements GraphSource {
  readonly id = "backlog";
  private readonly port: ControlPlanePort;
  constructor(port: ControlPlanePort) { this.port = port; }

  available(): boolean {
    try { this.port.snapshot(); return true; } catch { return false; }
  }

  load(budget: SourceBudget): GraphDelta {
    const snap = this.port.snapshot();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const kindOf = (t: TaskType): NodeKind => (t === "epic" ? "epic" : t === "feature" ? "feature" : "task");

    for (const task of snap.tasks) {
      if (nodes.length >= budget.maxNodes) break;
      const kind = kindOf(task.type);
      const id = `${kind}:${task.id}`;
      nodes.push({
        id, kind, domain: "backlog",
        label: task.title.slice(0, 60),
        status: task.state,
        weight: task.type === "epic" ? 3 : task.type === "feature" ? 2 : 1,
        sources: [this.id],
        meta: { state: task.state, risk: task.risk, priority: task.priority },
      });
      // realizes edges from cited clauses in title + description
      const cited = specRefsIn(`${task.title}\n${task.description}`);
      for (const raw of cited) {
        const clause = canonicalizeClause(raw);
        const ck = clauseKind(clause);
        if (!ck) continue;
        const specId = `${ck}:${clause}`;
        edges.push({ id: `${id}|realizes|${specId}`, from: id, to: specId, kind: "realizes", weight: 1, sources: [this.id] });
      }
    }
    return { nodes, edges };
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
