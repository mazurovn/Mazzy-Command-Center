// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const packageRoot = join(import.meta.dirname, "..");

test("published orchestrator instructions retain the safe parent-attested comment import rule", () => {
  for (const relativePath of [
    "skills/mazzy-orchestrator/SKILL.md",
    "resources/agents/mazzy-orchestrator.md",
  ]) {
    const content = readFileSync(join(packageRoot, relativePath), "utf8");
    assert.match(content, /Children never (?:mutate|write) the discussion store/);
    assert.match(content, /parent imports[\s\S]*(?:mazzy_assignment action=import-comment)[\s\S]*matching bound `runId`/i);
    assert.match(content, /TASK_COMMENT/);
    assert.match(content, /Comments are [^.]*never evidence/i);
  }
});

test("standalone package metadata exposes only package-local runtime resources", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string; files: string[]; pi: { extensions: string[]; skills: string[] } };
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.files.includes("static"));
  assert.ok(!JSON.stringify(manifest).includes("pi-ops/packages"));
});