// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";
import { SpecGraphAssembler } from "../src/spec-graph.ts";
import type { GraphDelta, GraphSource } from "../src/graph-model.ts";

function fixedSource(id: string, delta: GraphDelta, ok = true): GraphSource {
  return { id, available: () => ok, load: () => delta };
}
const empty: GraphDelta = { nodes: [], edges: [] };

test("empty source list yields a valid empty document", async () => {
  const doc = await new SpecGraphAssembler([]).build();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.nodes, []);
  assert.equal(doc.stats.nodes, 0);
  assert.deepEqual(doc.facets.domains, []);
});

test("a failing source is reported as error while others still merge", async () => {
  const good = fixedSource("good", { nodes: [{ id: "adr:ADR-001", kind: "adr", domain: "spec", label: "A", weight: 1, sources: ["good"] }], edges: [] });
  const boom: GraphSource = { id: "boom", available: () => true, load: () => { throw new Error("kaboom at /home/example/secret"); } };
  const doc = await new SpecGraphAssembler([good, boom]).build();
  assert.equal(doc.sources.find((s) => s.id === "good")!.status, "ok");
  const err = doc.sources.find((s) => s.id === "boom")!;
  assert.equal(err.status, "error");
  assert.ok(!/\/home\//.test(err.note ?? ""), "error note must be host-path-scrubbed");
  assert.equal(doc.nodes.length, 1);
});

test("an absent source is a legend chip, not an error", async () => {
  const doc = await new SpecGraphAssembler([fixedSource("x", empty, false)]).build();
  assert.equal(doc.sources[0].status, "absent");
});

test("truncation drops lowest-weight edges, sets the flag, keeps the heavy subgraph", async () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `task:t${i}`, kind: "task" as const, domain: "backlog" as const, label: `t${i}`, weight: i, sources: ["s"] }));
  const edges = Array.from({ length: 10 }, (_, i) => ({ id: `task:t${i}|depends|task:t${(i + 1) % 10}`, from: `task:t${i}`, to: `task:t${(i + 1) % 10}`, kind: "depends" as const, weight: i, sources: ["s"] }));
  const doc = await new SpecGraphAssembler([fixedSource("s", { nodes, edges })], { maxEdges: 4, maxNodes: 1000 }).build();
  assert.equal(doc.truncated, true);
  assert.ok(doc.edges.length <= 4);
  assert.ok(doc.edges.every((e) => e.weight >= 6), "kept edges are the highest-weight ones");
});

test("cache returns the same document within the TTL and rebuilds after", async () => {
  let calls = 0;
  const src: GraphSource = { id: "c", available: () => true, load: () => { calls++; return empty; } };
  let clock = 1000;
  const asm = new SpecGraphAssembler([src], { ttlMs: 100, now: () => clock });
  await asm.build(); await asm.build();
  assert.equal(calls, 1, "second build within TTL is cached");
  clock += 200;
  await asm.build();
  assert.equal(calls, 2, "build after TTL re-reads the source");
});

test("assertNoHostPaths fires through the assembler on a leaking source (fail-closed)", async () => {
  const leak = fixedSource("leak", { nodes: [{ id: "file:x", kind: "file", domain: "code", label: "x", ref: "/home/example/secret", weight: 1, sources: ["leak"] }], edges: [] });
  await assert.rejects(new SpecGraphAssembler([leak]).build(), /INV-3/);
});

test("focusSubgraph returns the bounded neighbourhood of a node", async () => {
  const nodes = ["a", "b", "c", "d"].map((x) => ({ id: `task:${x}`, kind: "task" as const, domain: "backlog" as const, label: x, weight: 1, sources: ["s"] }));
  const edges = [
    { id: "task:a|depends|task:b", from: "task:a", to: "task:b", kind: "depends" as const, weight: 1, sources: ["s"] },
    { id: "task:b|depends|task:c", from: "task:b", to: "task:c", kind: "depends" as const, weight: 1, sources: ["s"] },
    { id: "task:c|depends|task:d", from: "task:c", to: "task:d", kind: "depends" as const, weight: 1, sources: ["s"] },
  ];
  const doc = await new SpecGraphAssembler([fixedSource("s", { nodes, edges })]).build();
  const d1 = SpecGraphAssembler.focusSubgraph(doc, "task:a", 1);
  assert.deepEqual(d1.nodes.map((n) => n.id).sort(), ["task:a", "task:b"]);
  const d2 = SpecGraphAssembler.focusSubgraph(doc, "task:a", 2);
  assert.ok(d2.nodes.length >= d1.nodes.length, "depth 2 is a superset of depth 1");
  const missing = SpecGraphAssembler.focusSubgraph(doc, "task:zzz", 1);
  assert.equal(missing.nodes.length, 0);
});