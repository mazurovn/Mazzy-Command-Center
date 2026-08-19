// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ensureProjectIdentity, readProjectIdentity } from "../src/project.ts";
import { assertProjectRegistration, clearStaleProjectRegistryLock, enrollProjectRegistration, forgetCurrentProjectRegistration, forgetProjectRegistration } from "../src/project-registry.ts";
import { applyMazzyInit, mazzyDoctor, planMazzyInit, rollbackMazzyInit } from "../src/scaffold.ts";
import { testScratchRoot } from "./git-root.ts";

function temp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }
function git(root: string): void { execFileSync("git", ["init", "-q", root]); }
function setup(prefix = "registry-"): { root: string; registryDirectory: string } { const root = temp(`${prefix}root-`), registryDirectory = temp(`${prefix}state-`); git(root); ensureProjectIdentity(root); return { root, registryDirectory }; }
function clean(...paths: string[]): void { for (const path of paths) rmSync(path, { recursive: true, force: true }); }
function readIndex(directory: string): string { return readFileSync(join(directory, "registry.json"), "utf8"); }
async function children(roots: string[], registryDirectory: string): Promise<string[]> {
  const moduleUrl = new URL("../src/project-registry.ts", import.meta.url).href;
  const script = `import { enrollProjectRegistration } from ${JSON.stringify(moduleUrl)}; console.log(enrollProjectRegistration(process.argv[1], { registryDirectory: process.argv[2] }).status);`;
  return Promise.all(roots.map((root) => new Promise<string>((done, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root, registryDirectory], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", fail); child.once("exit", (code) => code === 0 ? done(stdout.trim()) : fail(new Error(stderr)));
  })));
}

// T1
 test("T1 enroll matches and assertion leaves index bytes and mtime unchanged", () => {
  const { root, registryDirectory } = setup("t1-");
  try {
    assert.equal(enrollProjectRegistration(root, { registryDirectory, now: "2026-01-01T00:00:00.000Z" }).status, "match");
    const before = readIndex(registryDirectory), mtime = statSync(join(registryDirectory, "registry.json")).mtimeMs;
    assert.equal(assertProjectRegistration(root, { registryDirectory }).status, "match");
    assert.equal(readIndex(registryDirectory), before); assert.equal(statSync(join(registryDirectory, "registry.json")).mtimeMs, mtime);
  } finally { clean(root, registryDirectory); }
});

// T2
 test("T2 distinct roots enroll distinct identities and digests", () => {
  const first = setup("t2-first-"), secondRoot = temp("t2-second-root-"); git(secondRoot); ensureProjectIdentity(secondRoot);
  try {
    assert.equal(enrollProjectRegistration(first.root, { registryDirectory: first.registryDirectory }).status, "match");
    assert.equal(enrollProjectRegistration(secondRoot, { registryDirectory: first.registryDirectory }).status, "match");
    const projects = JSON.parse(readIndex(first.registryDirectory)).projects as Array<{ projectId: string; rootDigest: string }>;
    assert.equal(projects.length, 2); assert.notEqual(projects[0].projectId, projects[1].projectId); assert.notEqual(projects[0].rootDigest, projects[1].rootDigest);
  } finally { clean(first.root, secondRoot, first.registryDirectory); }
});

// T3
 test("T3 copied descriptor is refused without index mutation", () => {
  const source = setup("t3-source-"), copy = temp("t3-copy-");
  try {
    enrollProjectRegistration(source.root, { registryDirectory: source.registryDirectory }); git(copy); mkdirSync(join(copy, ".mazzy")); cpSync(join(source.root, ".mazzy", "project.json"), join(copy, ".mazzy", "project.json"));
    const before = readIndex(source.registryDirectory);
    assert.equal(assertProjectRegistration(copy, { registryDirectory: source.registryDirectory }).status, "duplicate-project-id");
    assert.equal(enrollProjectRegistration(copy, { registryDirectory: source.registryDirectory }).status, "duplicate-project-id");
    assert.equal(applyMazzyInit(copy, true, { registryDirectory: source.registryDirectory }).registry?.status, "conflict"); assert.equal(readIndex(source.registryDirectory), before);
  } finally { clean(source.root, copy, source.registryDirectory); }
});

// T4
 test("T4 a second valid identity at one canonical root is refused", () => {
  const first = setup("t4-first-"), replacement = temp("t4-replacement-");
  try {
    enrollProjectRegistration(first.root, { registryDirectory: first.registryDirectory }); git(replacement); ensureProjectIdentity(replacement);
    writeFileSync(join(first.root, ".mazzy", "project.json"), readFileSync(join(replacement, ".mazzy", "project.json")));
    assert.equal(assertProjectRegistration(first.root, { registryDirectory: first.registryDirectory }).status, "duplicate-canonical-root");
  } finally { clean(first.root, replacement, first.registryDirectory); }
});

// T5
 test("T5 same-filesystem move is read-only until enrollment refresh", () => {
  const { root, registryDirectory } = setup("t5-"); const moved = `${root}-moved`;
  try {
    enrollProjectRegistration(root, { registryDirectory }); renameSync(root, moved);
    assert.equal(assertProjectRegistration(moved, { registryDirectory }).status, "moved");
    assert.equal(enrollProjectRegistration(moved, { registryDirectory }).status, "match");
  } finally { clean(root, moved, registryDirectory); }
});

// T6
 test("T6 linked worktree siblings enroll independently and surface sameRepository", () => {
  const root = temp("t6-main-"), registryDirectory = temp("t6-state-"); const sibling = `${root}-worktree`;
  try {
    git(root); execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "test"]); writeFileSync(join(root, "README"), "x"); execFileSync("git", ["-C", root, "add", "README"]); execFileSync("git", ["-C", root, "commit", "-qm", "initial"]); ensureProjectIdentity(root);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", sibling]); ensureProjectIdentity(sibling);
    assert.equal(enrollProjectRegistration(root, { registryDirectory }).status, "match");
    assert.equal(enrollProjectRegistration(sibling, { registryDirectory }).status, "match");
    assert.equal(assertProjectRegistration(root, { registryDirectory }).sameRepository, true); assert.equal(assertProjectRegistration(sibling, { registryDirectory }).sameRepository, true);
  } finally { try { execFileSync("git", ["-C", root, "worktree", "remove", "--force", sibling]); } catch { /* cleanup */ } clean(root, sibling, registryDirectory); }
});

// T7
 test("T7 a clone containing a committed descriptor is rejected", () => {
  const source = setup("t7-source-"), clone = temp("t7-clone-");
  try {
    execFileSync("git", ["-C", source.root, "config", "user.email", "test@example.invalid"]); execFileSync("git", ["-C", source.root, "config", "user.name", "test"]); execFileSync("git", ["-C", source.root, "add", "-f", ".mazzy/project.json"]); execFileSync("git", ["-C", source.root, "commit", "-qm", "identity"]);
    enrollProjectRegistration(source.root, { registryDirectory: source.registryDirectory }); rmSync(clone, { recursive: true, force: true }); execFileSync("git", ["clone", "-q", source.root, clone]);
    assert.equal(assertProjectRegistration(clone, { registryDirectory: source.registryDirectory }).status, "duplicate-project-id");
  } finally { clean(source.root, clone, source.registryDirectory); }
});

// T8
 test("T8 a symlinked checkout alias matches its canonical registration", { skip: process.platform !== "linux" }, () => {
  const { root, registryDirectory } = setup("t8-"); const alias = `${root}-alias`;
  try { enrollProjectRegistration(root, { registryDirectory }); symlinkSync(root, alias, "dir"); assert.equal(assertProjectRegistration(alias, { registryDirectory }).status, "match"); }
  finally { clean(root, alias, registryDirectory); }
});

// T9
 test("T9 distinct-root concurrent enrollment preserves every entry and cleans locks", async () => {
  const registryDirectory = temp("t9-state-"), roots = Array.from({ length: 6 }, () => temp("t9-root-"));
  try {
    for (const root of roots) { git(root); ensureProjectIdentity(root); }
    const outcomes = await children(roots, registryDirectory);
    assert.ok(outcomes.every((status) => status === "match" || status === "registry-busy"));
    for (let index = 0; index < roots.length; index++) if (outcomes[index] === "registry-busy") assert.equal(enrollProjectRegistration(roots[index]!, { registryDirectory }).status, "match");
    assert.equal(JSON.parse(readIndex(registryDirectory)).projects.length, 6); assert.deepEqual(readdirSync(registryDirectory).filter((name) => name === ".registry.lock" || /^\.registry\..*\.tmp$/.test(name)), []);
  } finally { clean(...roots, registryDirectory); }
});

// T10
 test("T10 same-root concurrent enrollment has one valid entry", async () => {
  const { root, registryDirectory } = setup("t10-");
  try {
    const outcomes = await children(Array.from({ length: 6 }, () => root), registryDirectory);
    assert.ok(outcomes.every((status) => status === "match" || status === "registry-busy")); assert.equal(JSON.parse(readIndex(registryDirectory)).projects.length, 1);
  } finally { clean(root, registryDirectory); }
});

// T11
 test("T11 private permissions are enforced and loose index is fail-closed", { skip: process.platform !== "linux" }, () => {
  const { root, registryDirectory } = setup("t11-");
  try {
    enrollProjectRegistration(root, { registryDirectory }); const index = join(registryDirectory, "registry.json");
    assert.equal(statSync(registryDirectory).mode & 0o777, 0o700); assert.equal(statSync(index).mode & 0o777, 0o600); assert.equal(statSync(join(registryDirectory, "registry.key")).mode & 0o777, 0o600);
    const before = readIndex(registryDirectory); chmodSync(index, 0o644); assert.equal(assertProjectRegistration(root, { registryDirectory }).status, "registry-invalid"); assert.equal(readIndex(registryDirectory), before);
  } finally { clean(root, registryDirectory); }
});

// T12
 test("T12 malformed, oversized, symlinked, and hardlinked registry files fail closed", { skip: process.platform !== "linux" }, () => {
  const cases: Array<(directory: string) => void> = [
    (directory) => writeFileSync(join(directory, "registry.json"), "not-json"),
    (directory) => writeFileSync(join(directory, "registry.json"), "x".repeat(1024 * 1024 + 1)),
    (directory) => writeFileSync(join(directory, "registry.key"), "x".repeat(4097)),
    (directory) => { const victim = join(directory, "index-victim"); writeFileSync(victim, "victim"); rmSync(join(directory, "registry.json")); symlinkSync(victim, join(directory, "registry.json")); },
    (directory) => { const victim = join(directory, "key-victim"); writeFileSync(victim, "victim"); rmSync(join(directory, "registry.key")); symlinkSync(victim, join(directory, "registry.key")); },
    (directory) => { const copy = join(directory, "index-copy"); linkSync(join(directory, "registry.json"), copy); },
    (directory) => { const copy = join(directory, "key-copy"); linkSync(join(directory, "registry.key"), copy); },
  ];
  for (const mutate of cases) {
    const { root, registryDirectory } = setup("t12-");
    try { enrollProjectRegistration(root, { registryDirectory }); mutate(registryDirectory); assert.equal(assertProjectRegistration(root, { registryDirectory }).status, "registry-invalid"); }
    finally { clean(root, registryDirectory); }
  }
});

// T13
 test("T13 missing key with an index fails closed", () => {
  const { root, registryDirectory } = setup("t13-");
  try { enrollProjectRegistration(root, { registryDirectory }); rmSync(join(registryDirectory, "registry.key")); const before = readIndex(registryDirectory); assert.equal(assertProjectRegistration(root, { registryDirectory }).status, "registry-key-missing"); assert.equal(enrollProjectRegistration(root, { registryDirectory }).status, "registry-key-missing"); assert.equal(readIndex(registryDirectory), before); }
  finally { clean(root, registryDirectory); }
});

// T14
 test("T14 registry and full doctor output contain no checkout, identity, digest, or salt", () => {
  const { root, registryDirectory } = setup("t14-");
  try {
    enrollProjectRegistration(root, { registryDirectory }); const index = readIndex(registryDirectory), key = readFileSync(join(registryDirectory, "registry.key"), "utf8"), id = readProjectIdentity(root).descriptor.projectId, report = JSON.stringify(mazzyDoctor(root, join(root, "doctor.db"), undefined, { registryDirectory }));
    for (const value of [root, root.split("/").at(-1)!, process.env.HOME || "__no_home__"]) { assert.equal(index.includes(value), false); assert.equal(key.includes(value), false); assert.equal(report.includes(value), false); }
    for (const value of [id, JSON.parse(index).projects[0].rootDigest, JSON.parse(key).salt]) assert.equal(report.includes(value), false);
  } finally { clean(root, registryDirectory); }
});

// T15
 test("T15 registry thrown errors use the fixed message without a cause", () => {
  assert.throws(() => forgetProjectRegistration("not-a-uuid", { registryDirectory: join(testScratchRoot, "t15-unused") }), (error: Error) => error.message === "Project registry operation failed" && error.cause === undefined);
});

// T16
 test("T16 forget removes one entry, writes exact backup, and supports re-enrollment", () => {
  const first = setup("t16-first-"), second = temp("t16-second-"); git(second); ensureProjectIdentity(second);
  try {
    enrollProjectRegistration(first.root, { registryDirectory: first.registryDirectory }); enrollProjectRegistration(second, { registryDirectory: first.registryDirectory }); const before = readIndex(first.registryDirectory);
    assert.deepEqual(forgetProjectRegistration(readProjectIdentity(first.root).descriptor.projectId, { registryDirectory: first.registryDirectory }), { removed: true }); assert.equal(readFileSync(join(first.registryDirectory, "registry.json.bak"), "utf8"), before); assert.equal(assertProjectRegistration(first.root, { registryDirectory: first.registryDirectory }).status, "unregistered"); assert.equal(enrollProjectRegistration(first.root, { registryDirectory: first.registryDirectory }).status, "match");
  } finally { clean(first.root, second, first.registryDirectory); }
});

// T17
 test("T17 dry-run plan and doctor do not write the registry", () => {
  const { root, registryDirectory } = setup("t17-");
  try { enrollProjectRegistration(root, { registryDirectory }); const before = readIndex(registryDirectory), mtime = statSync(join(registryDirectory, "registry.json")).mtimeMs; planMazzyInit(root, { registryDirectory }); mazzyDoctor(root, join(root, "doctor.db"), undefined, { registryDirectory }); assert.equal(readIndex(registryDirectory), before); assert.equal(statSync(join(registryDirectory, "registry.json")).mtimeMs, mtime); }
  finally { clean(root, registryDirectory); }
});

// T18
 test("T18 real scaffold rollback never changes the registry", () => {
  const { root, registryDirectory } = setup("t18-");
  try {
    enrollProjectRegistration(root, { registryDirectory }); applyMazzyInit(root, false, { registryDirectory });
    const agent = join(root, ".pi", "agents", "mazzy-orchestrator.md"); writeFileSync(agent, "local divergence");
    applyMazzyInit(root, true, { registryDirectory }); const before = readIndex(registryDirectory);
    assert.equal(rollbackMazzyInit(root).rolledBack, true); assert.equal(readFileSync(agent, "utf8"), "local divergence");
    assert.equal(readIndex(registryDirectory), before);
  } finally { clean(root, registryDirectory); }
});

// T19
 test("T19 unavailable registry degrades while scaffold and identity still complete", () => {
  const root = temp("t19-root-"), unavailableDirectory = "/proc/mazzy-registry-unavailable-test";
  try { git(root); const result = applyMazzyInit(root, false, { registryDirectory: unavailableDirectory }); assert.equal(result.registry?.status, "skip"); assert.ok(readProjectIdentity(root).descriptor.projectId); assert.ok(statSync(join(root, ".pi")).isDirectory()); assert.doesNotThrow(() => mazzyDoctor(root, join(root, "doctor.db"), undefined, { registryDirectory: unavailableDirectory })); }
  finally { clean(root); }
});

 test("doctor never throws when the default state home is unavailable", () => {
  const root = temp("doctor-home-");
  try {
    git(root); const moduleUrl = new URL("../src/scaffold.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { mazzyDoctor } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(mazzyDoctor(process.argv[1], process.argv[2])));`, root, join(root, "doctor.db")], { encoding: "utf8", env: { ...process.env, HOME: "", XDG_STATE_HOME: "" } });
    const report = JSON.parse(output) as Array<{ name: string; status: string }>; assert.equal(report.find((check) => check.name === "project registry")?.status, "WARN");
  } finally { clean(root); }
});

// T20
 test("T20 store/server remain registry-free and tests use explicit registry locations", () => {
  const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"), server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(store, /projectId|registry/i); assert.doesNotMatch(server, /projectId|registry/i);
});

 test("symlinked registry ancestors are accepted consistently while the final directory stays real", { skip: process.platform !== "linux" }, () => {
  const root = temp("ancestor-root-"); git(root); ensureProjectIdentity(root);
  const realParent = temp("ancestor-parent-"), alias = `${realParent}-alias`, registryDirectory = join(alias, "registry");
  try {
    symlinkSync(realParent, alias, "dir");
    assert.equal(enrollProjectRegistration(root, { registryDirectory }).status, "match");
    assert.equal(assertProjectRegistration(root, { registryDirectory }).status, "match");
  } finally { clean(root, realParent, alias); }
});

test("explicit registry repair forgets only the current checkout and clears only a stable stale lock", () => {
  const { root, registryDirectory } = setup("repair-");
  try {
    enrollProjectRegistration(root, { registryDirectory });
    assert.deepEqual(forgetCurrentProjectRegistration(root, { registryDirectory }), { removed: true });
    assert.deepEqual(forgetCurrentProjectRegistration(root, { registryDirectory }), { removed: false });
    enrollProjectRegistration(root, { registryDirectory });
    const lock = join(registryDirectory, ".registry.lock"); writeFileSync(lock, "", { mode: 0o600 });
    assert.equal(clearStaleProjectRegistryLock({ registryDirectory }, 60_000).reason, "fresh");
    const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old);
    assert.deepEqual(clearStaleProjectRegistryLock({ registryDirectory }, 60_000), { cleared: true, reason: "cleared" });
    assert.equal(statSync(registryDirectory).isDirectory(), true);
  } finally { clean(root, registryDirectory); }
});

 test("capacity is rejected before persistence and leaves a parseable index untouched", () => {
  const { root, registryDirectory } = setup("capacity-");
  try {
    enrollProjectRegistration(root, { registryDirectory }); const indexPath = join(registryDirectory, "registry.json"), keyPath = join(registryDirectory, "registry.key"), key = readFileSync(keyPath, "utf8");
    const projects: Array<Record<string, string>> = []; const time = "2026-01-01T00:00:00.000Z";
    while (true) {
      const n = projects.length, hex = n.toString(16).padStart(12, "0"), digest = n.toString(36).padStart(43, "0");
      const entry = { projectId: `00000000-0000-4000-8000-${hex}`, rootDigest: digest, fsIdDigest: digest.replace(/^./, "b"), repoDigest: digest.replace(/^./, "c"), firstSeenAt: time, lastSeenAt: time };
      const candidate = `${JSON.stringify({ schema: "mazzy.project-registry", version: 1, projects: [...projects, entry] })}\n`;
      if (Buffer.byteLength(candidate) > 1024 * 1024 - 100) break; projects.push(entry);
    }
    const seeded = `${JSON.stringify({ schema: "mazzy.project-registry", version: 1, projects })}\n`; writeFileSync(indexPath, seeded); assert.equal(readFileSync(keyPath, "utf8"), key);
    assert.equal(enrollProjectRegistration(root, { registryDirectory }).status, "registry-capacity"); assert.equal(readIndex(registryDirectory), seeded); assert.doesNotThrow(() => JSON.parse(readIndex(registryDirectory)));
  } finally { clean(root, registryDirectory); }
});