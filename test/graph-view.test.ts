import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadGraphView() {
  const win: Record<string, unknown> = {};
  const context = vm.createContext({ window: win, Math, JSON, Set, document: undefined });
  vm.runInContext(readFileSync(new URL("../static/assets/graph-view.js", import.meta.url), "utf8"), context);
  return win.MazzyGraphView as {
    layoutLanes: Function; layoutForce: Function; applyFilters: Function;
    neighborhood: Function; buildFacetModel: Function; colorForKind: Function;
  };
}

const doc = {
  version: 1,
  facets: {
    domains: [{ id: "spec", label: "Spec", count: 2 }, { id: "code", label: "Code", count: 1 }, { id: "backlog", label: "Backlog", count: 1 }],
    kinds: [{ id: "adr", domain: "spec", label: "ADR", count: 1 }, { id: "inv", domain: "spec", label: "INV", count: 1 }, { id: "file", domain: "code", label: "FILE", count: 1 }, { id: "task", domain: "backlog", label: "TASK", count: 1 }, { id: "quantum", domain: "spec", label: "QUANTUM", count: 1 }],
    edges: [{ id: "governs", label: "Governs", count: 1 }, { id: "references", label: "References", count: 1 }],
  },
  nodes: [
    { id: "adr:ADR-015", kind: "adr", domain: "spec", label: "Rebrand", weight: 3, sources: ["spec"] },
    { id: "inv:INV-002", kind: "inv", domain: "spec", label: "INV-002", weight: 1, sources: ["spec"] },
    { id: "file:src/x.ts", kind: "file", domain: "code", label: "x.ts", weight: 2, sources: ["rgra"] },
    { id: "task:t1", kind: "task", domain: "backlog", label: "T1", weight: 1, sources: ["backlog"] },
  ],
  edges: [
    { id: "adr:ADR-015|governs|file:src/x.ts", from: "adr:ADR-015", to: "file:src/x.ts", kind: "governs", weight: 2, sources: ["rgra"] },
    { id: "adr:ADR-015|references|inv:INV-002", from: "adr:ADR-015", to: "inv:INV-002", kind: "references", weight: 1, sources: ["spec"] },
    { id: "task:t1|governs|adr:ADR-015", from: "task:t1", to: "adr:ADR-015", kind: "governs", weight: 1, sources: ["backlog"] },
  ],
};

test("buildFacetModel synthesizes a colour for every kind including an unknown one", () => {
  const gv = loadGraphView();
  const model = gv.buildFacetModel(doc);
  const quantum = model.kinds.find((k: { id: string }) => k.id === "quantum");
  assert.ok(quantum, "unknown kind still appears in the facet model");
  assert.match(quantum.color, /^hsl\(/, "an unthemed kind gets a synthesized colour");
  assert.equal(model.kinds.length, 5);
});

test("layoutForce is deterministic for a fixed seed and never NaNs", () => {
  const gv = loadGraphView();
  const p1 = gv.layoutForce(doc.nodes, doc.edges, { w: 800, h: 600 }, 42);
  const p2 = gv.layoutForce(doc.nodes, doc.edges, { w: 800, h: 600 }, 42);
  assert.deepEqual(p1, p2, "same seed => identical layout");
  for (const id in p1) { assert.ok(Number.isFinite(p1[id].x) && Number.isFinite(p1[id].y), `${id} has finite coords`); }
});

test("layoutLanes puts each domain in its own x-band", () => {
  const gv = loadGraphView();
  const pos = gv.layoutLanes(doc.nodes, doc.edges, { w: 900, h: 600 });
  const specX = pos["adr:ADR-015"].x, codeX = pos["file:src/x.ts"].x, backlogX = pos["task:t1"].x;
  // domains sorted: backlog < code < spec => bands left to right
  assert.ok(backlogX < codeX && codeX < specX, `bands ordered: backlog(${backlogX}) < code(${codeX}) < spec(${specX})`);
  for (const id in pos) assert.ok(Number.isFinite(pos[id].x) && Number.isFinite(pos[id].y));
});

test("applyFilters hides deselected kinds and edges, and orphaned edges", () => {
  const gv = loadGraphView();
  const all = gv.applyFilters(doc, {});
  assert.equal(all.nodes.length, 4);
  // references off by caller
  const noRefs = gv.applyFilters(doc, { edges: { references: false } });
  assert.ok(!noRefs.edges.some((e: { kind: string }) => e.kind === "references"));
  // hide files => the governs edge to the file also drops
  const noFiles = gv.applyFilters(doc, { kinds: { file: false } });
  assert.ok(!noFiles.nodes.some((n: { kind: string }) => n.kind === "file"));
  assert.ok(!noFiles.edges.some((e: { to: string }) => e.to === "file:src/x.ts"));
});

test("neighborhood depth-2 is a superset of depth-1", () => {
  const gv = loadGraphView();
  const d1 = gv.neighborhood(doc, "file:src/x.ts", 1);
  const d2 = gv.neighborhood(doc, "file:src/x.ts", 2);
  assert.ok(d1["adr:ADR-015"], "depth1 reaches the governing ADR");
  for (const id in d1) assert.ok(d2[id], "every depth-1 node is in depth-2");
  assert.ok(d2["task:t1"] || d2["inv:INV-002"], "depth-2 reaches a second hop");
});
