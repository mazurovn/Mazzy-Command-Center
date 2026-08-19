// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoHostPaths, buildFacets, canonicalizeClause, domainOf, mergeDeltas,
  safeMessage, sweepDangling, type GraphDelta, type GraphDocument, type GraphNode,
} from "../src/graph-model.ts";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: extra.kind ?? "adr", domain: extra.domain ?? "spec", label: extra.label ?? id,
  weight: extra.weight ?? 1, sources: extra.sources ?? ["a"], ...extra,
});

test("canonicalizeClause zero-pads and folds the prime", () => {
  assert.equal(canonicalizeClause("ADR-15"), "ADR-015");
  assert.equal(canonicalizeClause("adr-015"), "ADR-015");
  assert.equal(canonicalizeClause("INV-2\u2032"), "INV-002'");
  assert.equal(canonicalizeClause("NFR-SEC-001"), "NFR-SEC-001");
  // FR-U## keeps its shape (the U-prefix is not a pure numeric run) — idempotent.
  assert.equal(canonicalizeClause("FR-U01"), "FR-U01");
});

test("mergeDeltas unions sources, sums weight, keeps first non-empty label", () => {
  const a: GraphDelta = { nodes: [node("adr:ADR-015", { label: "", sources: ["rgra"] })], edges: [{ id: "x|governs|y", from: "x", to: "y", kind: "governs", weight: 1, sources: ["rgra"] }] };
  const b: GraphDelta = { nodes: [node("adr:ADR-015", { label: "Rebrand", weight: 2, sources: ["spec"] })], edges: [{ id: "x|governs|y", from: "x", to: "y", kind: "governs", weight: 3, sources: ["spec"] }] };
  const { nodes, edges } = mergeDeltas([a, b]);
  const n = nodes.get("adr:ADR-015")!;
  assert.equal(n.weight, 3);
  assert.equal(n.label, "Rebrand", "empty label is replaced by the first non-empty one");
  assert.deepEqual(n.sources.sort(), ["rgra", "spec"]);
  assert.equal(edges.get("x|governs|y")!.weight, 4);
  assert.deepEqual(edges.get("x|governs|y")!.sources.sort(), ["rgra", "spec"]);
});

test("sweepDangling ghost-promotes a missing spec endpoint to a gap node and drops non-spec dangles", () => {
  const nodes = new Map([["file:src/x.ts", node("file:src/x.ts", { kind: "file", domain: "code" })]]);
  const edges = new Map([
    ["file:src/x.ts|realizes|adr:ADR-099", { id: "file:src/x.ts|realizes|adr:ADR-099", from: "file:src/x.ts", to: "adr:ADR-099", kind: "realizes" as const, weight: 1, sources: ["rgra"] }],
    ["file:src/x.ts|depends|file:missing.ts", { id: "file:src/x.ts|depends|file:missing.ts", from: "file:src/x.ts", to: "file:missing.ts", kind: "depends" as const, weight: 1, sources: ["rgra"] }],
  ]);
  const gaps = sweepDangling(nodes, edges);
  assert.deepEqual(gaps, ["adr:ADR-099"]);
  assert.equal(nodes.get("adr:ADR-099")!.status, "gap");
  assert.ok(edges.has("file:src/x.ts|realizes|adr:ADR-099"), "edge to a ghost-promoted spec node is kept");
  assert.ok(!edges.has("file:src/x.ts|depends|file:missing.ts"), "edge to a missing non-spec node is dropped");
});

test("buildFacets derives domain/kind/edge counts (drives the UI, nothing hardcoded)", () => {
  const nodes = [node("adr:ADR-1", { kind: "adr" }), node("file:a", { kind: "file", domain: "code" }), node("task:t", { kind: "task", domain: "backlog" })];
  const edges = [{ id: "adr:ADR-1|governs|file:a", from: "adr:ADR-1", to: "file:a", kind: "governs" as const, weight: 1, sources: ["x"] }];
  const f = buildFacets(nodes, edges);
  assert.deepEqual(f.domains.map((d) => d.id).sort(), ["backlog", "code", "spec"]);
  assert.deepEqual(f.kinds.map((k) => k.id).sort(), ["adr", "file", "task"]);
  assert.equal(f.kinds.find((k) => k.id === "file")!.domain, "code");
  assert.deepEqual(f.edges.map((e) => e.id), ["governs"]);
});

test("domainOf maps every kind to its domain", () => {
  assert.equal(domainOf("inv"), "spec");
  assert.equal(domainOf("symbol"), "code");
  assert.equal(domainOf("epic"), "backlog");
  assert.equal(domainOf("vector"), "memory");
});

test("assertNoHostPaths is a fail-closed INV-3 gate", () => {
  const base: GraphDocument = { version: 1, generatedAt: "", sources: [], facets: { domains: [], kinds: [], edges: [] }, nodes: [], edges: [], truncated: false, stats: { nodes: 0, edges: 0, orphans: 0, coverageGaps: [] } };
  assert.doesNotThrow(() => assertNoHostPaths({ ...base, nodes: [node("file:src/server.ts", { kind: "file", domain: "code", ref: "src/server.ts" })] }));
  assert.throws(() => assertNoHostPaths({ ...base, nodes: [node("file:x", { ref: "/home/example/project/x" })] }), /INV-3/);
  assert.throws(() => assertNoHostPaths({ ...base, nodes: [node("file:x", { label: "C:\\Users\\a" })] }), /INV-3/);
  assert.throws(() => assertNoHostPaths({ ...base, sources: [{ id: "s", status: "error", nodes: 0, edges: 0, note: "failed at /var/lib/secret" }] }), /INV-3/);
});

test("safeMessage strips absolute-path shapes", () => {
  assert.equal(safeMessage(new Error("cannot read /home/example/project/.mazzy/x.json now")), "cannot read <path> now");
  assert.ok(!/\/home\//.test(safeMessage(new Error("boom /home/example/f"))));
});