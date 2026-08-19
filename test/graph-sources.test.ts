// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { RgraGraphSource } from "../src/graph-sources/rgra-source.ts";
import { SpecDocSource } from "../src/graph-sources/spec-source.ts";
import { BacklogSource } from "../src/graph-sources/backlog-source.ts";
import { MemorySource, VectorsSource } from "../src/graph-sources/stub-sources.ts";
import { MazzyStore } from "../src/store.ts";

const root = testScratchRoot;
function tmp(prefix: string): string { mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, prefix)); }
const budget = { maxNodes: 1000, maxEdges: 4000 };

test("rgra source strips the absolute root and emits only relative refs (INV-3)", () => {
  const dir = tmp("gs-rgra-");
  try {
    const artifact = {
      root: "/home/example/project",
      hits: [
        { file: "/home/example/project/src/store.ts", identifier: "MazzyStore", action: "rename", renamesTo: "MazzyStore", specRefs: ["ADR-015", "INV-2"] },
        { file: "/home/example/project/src/x.ts", identifier: "FR-thing", action: "rename", specRefs: ["FR-001"] },
      ],
    };
    const p = join(dir, "graph.json");
    writeFileSync(p, JSON.stringify(artifact));
    const src = new RgraGraphSource(p);
    assert.equal(src.available(), true);
    const delta = src.load(budget);
    const blob = JSON.stringify(delta);
    assert.ok(!/\/home\//.test(blob), "no absolute path may survive");
    const fileNode = delta.nodes.find((n) => n.kind === "file");
    assert.equal(fileNode!.ref, "src/store.ts");
    // governs from a constraint clause (INV/ADR) to the symbol; realizes for FR
    assert.ok(delta.edges.some((e) => e.kind === "governs" && e.to === "symbol:MazzyStore"));
    assert.ok(delta.edges.some((e) => e.kind === "contains"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rgra source is unavailable when the artifact is missing or malformed", () => {
  const dir = tmp("gs-rgra-abs-");
  try {
    assert.equal(new RgraGraphSource(join(dir, "nope.json")).available(), false);
    const bad = join(dir, "bad.json"); writeFileSync(bad, "{not json");
    assert.equal(new RgraGraphSource(bad).available(), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("spec source extracts clause nodes and a definitional heading label", () => {
  const dir = tmp("gs-spec-"); const docs = join(dir, "docs"); mkdirSync(docs);
  try {
    writeFileSync(join(docs, "ARCHITECTURE.md"), "# Log\n\n### ADR-015 — Command Center rebrand\n\nText cites INV-2 and FR-001 together.\n");
    const src = new SpecDocSource(docs);
    assert.equal(src.available(), true);
    const delta = src.load(budget);
    const adr = delta.nodes.find((n) => n.id === "adr:ADR-015");
    assert.ok(adr, "ADR-015 node present");
    assert.match(adr!.label, /Command Center rebrand/, "definitional heading becomes the label");
    assert.equal(adr!.ref, "docs/ARCHITECTURE.md");
    // co-citation reference between INV-2 and FR-001 in the same section
    assert.ok(delta.edges.some((e) => e.kind === "references"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("spec source is unavailable with no markdown files", () => {
  const dir = tmp("gs-spec-empty-"); mkdirSync(join(dir, "docs"));
  try { assert.equal(new SpecDocSource(join(dir, "docs")).available(), false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backlog source emits task nodes and realizes-edges from cited clauses", () => {
  const dir = tmp("gs-backlog-"); const store = new MazzyStore(join(dir, "state.db"));
  try {
    const t = store.createTask({ title: "Implement ADR-016 split", description: "per INV-1 and FR-014", type: "feature", state: "BACKLOG", actor: "test" });
    const src = new BacklogSource(store);
    assert.equal(src.available(), true);
    const delta = src.load(budget);
    const node = delta.nodes.find((n) => n.id === `feature:${t.id}`);
    assert.ok(node, "feature node present");
    assert.equal(node!.status, "BACKLOG");
    const realized = delta.edges.filter((e) => e.from === `feature:${t.id}` && e.kind === "realizes").map((e) => e.to).sort();
    assert.deepEqual(realized, ["adr:ADR-016", "fr:FR-014", "inv:INV-001"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("memory and vectors stubs report unavailable and never contribute", () => {
  assert.equal(new MemorySource().available(), false);
  assert.equal(new VectorsSource().available(), false);
  assert.throws(() => new MemorySource().load(), /not implemented/);
});