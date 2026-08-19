// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { applyMazzyInit as apply, mazzyDoctor as doctor, planMazzyInit as plan, rollbackMazzyInit } from "../src/scaffold.ts";
import { readProjectIdentity, resolveOpsDbPath, resolveOpsDbPathDiagnostic } from "../src/project.ts";

const packageRoot = join(import.meta.dirname, "..");
const scratchRoot = testScratchRoot;
mkdirSync(scratchRoot, { recursive: true });
const scaffoldRegistryDirectory = mkdtempSync(join(scratchRoot, "registry-scaffold-"));
process.on("exit", () => rmSync(scaffoldRegistryDirectory, { recursive: true, force: true }));
const registryOptions = { registryDirectory: scaffoldRegistryDirectory };
const applyMazzyInit = (cwd: string, force = false) => apply(cwd, force, registryOptions);
const planMazzyInit = (cwd: string) => plan(cwd, registryOptions);
const mazzyDoctor = (cwd: string, dbPath: string, diagnostic?: ReturnType<typeof resolveOpsDbPathDiagnostic>) => doctor(cwd, dbPath, diagnostic, registryOptions);
function projectTemp(prefix: string): string { mkdirSync(scratchRoot, { recursive: true }); return mkdtempSync(join(scratchRoot, prefix)); }

/** This test's scratch projects stay under `.mazzy/work/test`, never the OS temp directory. */
test("settings deep merge preserves existing arrays on apply and force, and rollback is exact", () => {
  const root = projectTemp("mazzy-settings-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const settings = join(root, ".pi", "settings.json"); mkdirSync(join(root, ".pi"), { recursive: true });
    const original = `${JSON.stringify({ extensions: ["local-extension", "npm:pi-subagents@0.50.0", { name: "object", flags: ["x"] }], packages: ["local-package", { name: "package-object" }], models: [{ name: "local-model" }], subagents: { runtime: "local-runtime", defaults: { freshSession: false, modelPreferences: ["local-model"] }, allowedModels: ["local-model"] } }, null, 2)}\n`;
    writeFileSync(settings, original, { encoding: "utf8" });
    applyMazzyInit(root);
    const plain = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    assert.deepEqual(plain.extensions, ["local-extension", "npm:pi-subagents@0.50.0", { name: "object", flags: ["x"] }]);
    assert.deepEqual(plain.packages, ["local-package", { name: "package-object" }, "npm:pi-subagents@0.50.0"]);
    assert.deepEqual(plain.models, [{ name: "local-model" }]);
    assert.deepEqual((plain.subagents as { defaults: { modelPreferences: string[] }; allowedModels: string[] }).defaults.modelPreferences, ["local-model"]);
    assert.deepEqual((plain.subagents as { defaults: { modelPreferences: string[] }; allowedModels: string[] }).allowedModels, ["local-model"]);
    assert.equal((plain.subagents as { runtime: string }).runtime, "local-runtime");
    assert.equal(rollbackMazzyInit(root).rolledBack, true);
    assert.equal(readFileSync(settings, "utf8"), original);

    applyMazzyInit(root, true);
    const forced = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    assert.deepEqual(forced.extensions, ["local-extension", "npm:pi-subagents@0.50.0", { name: "object", flags: ["x"] }]);
    assert.deepEqual(forced.packages, ["local-package", { name: "package-object" }, "npm:pi-subagents@0.50.0"]);
    assert.equal(rollbackMazzyInit(root).rolledBack, true);
    assert.equal(readFileSync(settings, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init removes eight ineffective extension-config keys plus legacy maxConcurrent while preserving unknown keys", () => {
  const root = projectTemp("mazzy-inert-subagents-");
  try {
    execFileSync("git", ["init", "-q", root]); mkdirSync(join(root, ".pi"), { recursive: true });
    const settings = join(root, ".pi", "settings.json");
    writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-subagents@0.50.0"], subagents: { projectRootResolution: "git-root", defaultModel: "local-model", userExtensionSetting: "preserve", artifactDir: "project", defaultSessionDir: "x", singleRunOutputBaseDir: "x", worktreeBaseDir: "x", globalConcurrencyLimit: 2, maxConcurrent: 2, maxSubagentSpawnsPerRun: 2, maxSubagentDepth: 1, missions: { directory: "x" } } }));
    const plan = planMazzyInit(root); assert.match(plan.entries.find((entry) => entry.path === ".pi/settings.json")?.reason ?? "", /prune 9 ineffective/);
    applyMazzyInit(root);
    const subagents = JSON.parse(readFileSync(settings, "utf8")).subagents as Record<string, unknown>;
    assert.deepEqual(subagents, { projectRootResolution: "git-root", defaultModel: "local-model", userExtensionSetting: "preserve" });
    const settingsCheck = mazzyDoctor(root, join(root, ".mazzy", "work", "doctor-probe")).find((check) => check.name === "pi-subagents project settings");
    assert.match(settingsCheck?.hint ?? "", /Other keys are preserved without effectiveness claims/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy self path is preserved when it resolves from the target .pi directory", () => {
  const root = projectTemp("mazzy-valid-legacy-");
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "mazzy-control-panel"), { recursive: true });
    mkdirSync(join(root, ".pi"), { recursive: true });
    const settings = join(root, ".pi", "settings.json");
    const original = `${JSON.stringify({ packages: ["../mazzy-control-panel", "npm:unrelated@1.0.0", { name: "preserved-object" }] }, null, 2)}\n`;
    writeFileSync(settings, original, { encoding: "utf8" });
    const plan = planMazzyInit(root);
    assert.doesNotMatch(plan.entries.find((entry) => entry.path === ".pi/settings.json")?.reason ?? "", /prune/);
    applyMazzyInit(root);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).packages, ["../mazzy-control-panel", "npm:unrelated@1.0.0", { name: "preserved-object" }, "npm:pi-subagents@0.50.0"]);
    assert.equal(rollbackMazzyInit(root).rolledBack, true);
    assert.equal(readFileSync(settings, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor validates remote specs syntactically and local specs from target .pi without network claims", () => {
  const root = projectTemp("mazzy-doctor-specs-");
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".pi", "local-package"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), `${JSON.stringify({ packages: ["npm:example@1.0.0", "git:owner/repo", "git+https://example.invalid/repo.git", "https://example.invalid/package.tgz", "./local-package"] }, null, 2)}\n`);
    const checks = mazzyDoctor(root, join(root, ".mazzy", "work", "doctor-probe")).filter((check) => check.name.startsWith("package specification"));
    assert.equal(checks.length, 5);
    assert.ok(checks.every((check) => check.status === "PASS"));
    assert.ok(checks.some((check) => check.hint.includes("registry availability was not checked")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Tarball-install E2E is deferred: this unit suite invokes scaffold functions directly so it
// does not depend on a globally configured Pi CLI. The release metadata gate requires that
// ordinary-project local-tarball smoke test before publication.
test("clean unrelated Git project prunes stale self path, diagnoses it, and rolls back byte-for-byte", () => {
  const root = projectTemp("mazzy-unrelated-");
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".pi"), { recursive: true });
    const settings = join(root, ".pi", "settings.json");
    const original = `${JSON.stringify({ packages: ["npm:unrelated@1.0.0", "../mazzy-control-panel", { name: "preserved-object", flags: ["x"] }, "https://example.invalid/plugin.tgz"] }, null, 2)}\n`;
    writeFileSync(settings, original, { encoding: "utf8" });
    const before = mazzyDoctor(root, join(root, ".mazzy", "work", "doctor-probe"));
    assert.ok(before.some((check) => check.status === "FAIL" && check.hint.includes("run /mazzy-init migration to prune or fix this stale local path")));
    const plan = planMazzyInit(root);
    assert.match(plan.entries.find((entry) => entry.path === ".pi/settings.json")?.reason ?? "", /prune 1 stale legacy package path/);
    applyMazzyInit(root);
    const applied = JSON.parse(readFileSync(settings, "utf8")) as { packages: unknown[] };
    assert.deepEqual(applied.packages, ["npm:unrelated@1.0.0", { name: "preserved-object", flags: ["x"] }, "https://example.invalid/plugin.tgz", "npm:pi-subagents@0.50.0"]);
    assert.ok(!applied.packages.includes("../mazzy-control-panel"));
    assert.equal(rollbackMazzyInit(root).rolledBack, true);
    assert.equal(readFileSync(settings, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor reports only a source enum for DB selection and warns about absent Project identity", () => {
  const root = projectTemp("mazzy-doctor-resolution-"), privateOverride = join(root, "private-override.db");
  try {
    execFileSync("git", ["init", "-q", root]);
    const diagnostic = resolveOpsDbPathDiagnostic(root, privateOverride);
    const report = mazzyDoctor(root, resolveOpsDbPath(root, privateOverride), diagnostic);
    const resolution = report.find((check) => check.name === "database resolution");
    assert.deepEqual(resolution, {
      name: "database resolution",
      status: "WARN",
      source: "explicit-override",
      hint: "Override-selected database; the override value is intentionally not displayed. Read-only migration status is available, but identity-asserting selection is not implemented.",
    });
    const publicOutput = JSON.stringify(report);
    assert.equal(publicOutput.includes(root), false);
    assert.equal(publicOutput.includes(privateOverride), false);

    const legacy = mazzyDoctor(root, resolveOpsDbPath(root), resolveOpsDbPathDiagnostic(root)).find((check) => check.name === "database resolution");
    assert.equal(legacy?.source, "git-root-legacy");
    assert.match(legacy?.hint ?? "", /Read-only migration status is available; identity-asserting selection and project isolation remain unimplemented\./);
    assert.ok(report.some((check) => check.name === "control database identity"));
    assert.ok(report.some((check) => check.name === "legacy database candidates"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("identity enrollment waits until divergent Git ignore policy is explicitly accepted", () => {
  const root = projectTemp("mazzy-identity-ignore-gate-");
  try {
    execFileSync("git", ["init", "-q", root]); mkdirSync(join(root, ".mazzy"));
    writeFileSync(join(root, ".mazzy", ".gitignore"), "# local divergent policy\n");
    const plain = applyMazzyInit(root);
    assert.equal(plain.entries.find((entry) => entry.path === ".mazzy/project.json")?.status, "conflict");
    assert.equal(existsSync(join(root, ".mazzy", "project.json")), false);
    applyMazzyInit(root, true);
    assert.ok(existsSync(join(root, ".mazzy", "project.json")));
    assert.match(execFileSync("git", ["check-ignore", "-v", ".mazzy/project.json"], { cwd: root, encoding: "utf8" }), /project\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("untrusted .mazzy directory is never followed and does not block .pi scaffold repair", { skip: process.platform === "win32" }, () => {
  const root = projectTemp("mazzy-untrusted-directory-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const external = join(root, "external-workspace"); mkdirSync(external, { mode: 0o755 });
    const modeBefore = statSync(external).mode & 0o777; symlinkSync(external, join(root, ".mazzy"));
    const plan = planMazzyInit(root);
    assert.ok(plan.entries.filter((entry) => entry.path.startsWith(".mazzy/")).every((entry) => entry.status === "conflict"));
    assert.doesNotThrow(() => applyMazzyInit(root)); assert.doesNotThrow(() => applyMazzyInit(root, true));
    assert.ok(existsSync(join(root, ".pi", "mazzy", "routing.json")));
    assert.deepEqual(readdirSync(external), []); assert.equal(statSync(external).mode & 0o777, modeBefore);
    const report = mazzyDoctor(root, join(root, ".pi-ops", "state.db"));
    assert.equal(report.find((item) => item.name === "project identity")?.status, "FAIL");
    assert.equal(report.find((item) => item.name === "project-local workspace")?.status, "FAIL");
    assert.equal(JSON.stringify(report).includes(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt project identity is reported but never blocks unrelated scaffold repair", () => {
  const root = projectTemp("mazzy-corrupt-identity-");
  try {
    execFileSync("git", ["init", "-q", root]); mkdirSync(join(root, ".mazzy"));
    const identityPath = join(root, ".mazzy", "project.json"), corrupt = "not-json\n";
    writeFileSync(identityPath, corrupt);
    assert.equal(planMazzyInit(root).entries.find((entry) => entry.path === ".mazzy/project.json")?.status, "conflict");
    assert.doesNotThrow(() => applyMazzyInit(root));
    assert.equal(readFileSync(identityPath, "utf8"), corrupt);
    assert.ok(existsSync(join(root, ".pi", "mazzy", "routing.json")));
    writeFileSync(join(root, ".pi", "agents", "mazzy-orchestrator.md"), "local divergence");
    assert.doesNotThrow(() => applyMazzyInit(root, true));
    assert.equal(readFileSync(identityPath, "utf8"), corrupt);
    const check = mazzyDoctor(root, join(root, ".pi-ops", "state.db")).find((item) => item.name === "project identity");
    assert.equal(check?.status, "FAIL"); assert.equal(JSON.stringify(check).includes(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable Mazzy scaffold plans, applies idempotently, force-backs up, rolls back, diagnoses, and keeps runtime payloads out of tarballs", () => {
  const root = projectTemp("mazzy-scaffold-");
  try {
    execFileSync("git", ["init", "-q", root]);
    const plan = planMazzyInit(root); assert.equal(plan.dryRun, true); assert.ok(plan.entries.every((entry) => entry.status === "create")); assert.equal(plan.registry?.status, "create");
    const applied = applyMazzyInit(root); assert.equal(applied.dryRun, false); assert.equal(applied.registry?.status, "skip");
    const agent = join(root, ".pi", "agents", "mazzy-orchestrator.md"); assert.ok(existsSync(agent));
    const identityPath = join(root, ".mazzy", "project.json"), identityBefore = readFileSync(identityPath, "utf8");
    const projectId = readProjectIdentity(root).descriptor.projectId;
    if (process.platform !== "win32") {
      assert.equal(statSync(identityPath).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, ".mazzy")).mode & 0o777, 0o700);
    }
    assert.match(execFileSync("git", ["check-ignore", "-v", ".mazzy/project.json"], { cwd: root, encoding: "utf8" }), /project\.json/);
    assert.ok(existsSync(join(root, ".mazzy", "README.md")));
    for (const directory of ["tmp", "prompts", "results", "sessions", "outputs", "worktrees", "missions"]) assert.ok(existsSync(join(root, ".mazzy", "work", directory)), directory);
    assert.ok(existsSync(join(root, ".mazzy", "memory", "hot")));
    assert.ok(existsSync(join(root, ".mazzy", "storage-policy.json")));
    assert.ok(planMazzyInit(root).entries.every((entry) => entry.status === "skip"));
    const original = readFileSync(agent, "utf8"); writeFileSync(agent, "divergent local template");
    assert.equal(planMazzyInit(root).entries.find((entry) => entry.path.endsWith("mazzy-orchestrator.md"))?.status, "conflict");
    applyMazzyInit(root, true); assert.notEqual(readFileSync(agent, "utf8"), "divergent local template");
    assert.equal(readProjectIdentity(root).descriptor.projectId, projectId);
    assert.equal(readFileSync(identityPath, "utf8"), identityBefore);
    assert.equal(rollbackMazzyInit(root).rolledBack, true); assert.equal(readFileSync(agent, "utf8"), "divergent local template");
    assert.equal(readFileSync(identityPath, "utf8"), identityBefore);
    const generated = [join(root, ".pi", "mazzy", "routing.json"), join(root, ".pi", "settings.json"), join(root, ".pi", "mazzy", "state.json")].map((file) => readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(generated, /\/(?:home|Users)\//); assert.doesNotMatch(generated, /(?:token|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i);
    const registryIndex = join(registryOptions.registryDirectory, "registry.json"), registryBefore = readFileSync(registryIndex, "utf8"), registryMtime = statSync(registryIndex).mtimeMs;
    const report = mazzyDoctor(root, join(root, ".mazzy", "work", "doctor-probe")); assert.ok(report.some((check) => check.name === "trusted project" && check.status === "PASS")); assert.equal(readFileSync(registryIndex, "utf8"), registryBefore); assert.equal(statSync(registryIndex).mtimeMs, registryMtime); assert.ok(report.some((check) => check.name === "project registry" && check.status === "PASS"));
    const identityCheck = report.find((check) => check.name === "project identity"); assert.equal(identityCheck?.status, "PASS"); assert.equal(JSON.stringify(identityCheck).includes(projectId), false); assert.equal(JSON.stringify(identityCheck).includes(root), false); assert.ok(report.some((check) => check.name === "routing policy" && check.status === "PASS")); assert.ok(report.some((check) => check.name === "project-local workspace" && check.status === "PASS")); assert.ok(report.some((check) => check.name === "storage policy" && check.status === "PASS")); assert.ok(report.some((check) => check.name === "workspace quotas" && check.status === "PASS")); assert.ok(report.some((check) => check.name === "memory retention" && check.hint.startsWith("PLANNED:")));
    assert.doesNotThrow(() => execFileSync("sha256sum", ["-c", "resources/SHA256SUMS"], { cwd: packageRoot, stdio: "ignore" }));
    const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8" })) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = packed.at(0)?.files.map((file) => file.path) ?? [];
    for (const excluded of [".mazzy/", ".pi/", ".pi-ops/", "test/", "tsconfig.json"]) assert.ok(!packedPaths.some((path) => path.startsWith(excluded)), excluded);
    assert.ok(!packedPaths.some((path) => /(?:state\.db|secret|token|\.jsonl)$/i.test(path)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scaffold refuses to write through a symlinked .pi directory", () => {
  const root = projectTemp("mazzy-symlink-"); const outside = projectTemp("mazzy-symlink-outside-");
  try {
    execFileSync("git", ["init", "-q", root]);
    // Replace .pi with a symlink pointing outside the checkout.
    symlinkSync(outside, join(root, ".pi"));
    assert.throws(() => applyMazzyInit(root, true), /symlinked path segment/);
    // Nothing was written through the symlink into the outside directory.
    assert.ok(!existsSync(join(outside, "mazzy", "state.json")));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("packageChecks fails a local package path that escapes .pi", () => {
  const root = projectTemp("mazzy-escape-");
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), `${JSON.stringify({ packages: ["../shared"] }, null, 2)}\n`, "utf8");
    const checks = mazzyDoctor(root, join(root, ".mazzy", "work", "probe"));
    assert.ok(checks.some((c) => c.status === "FAIL" && c.hint.includes("escapes the target `.pi` directory")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});