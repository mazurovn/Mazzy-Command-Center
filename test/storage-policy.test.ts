import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyMazzyInit as apply, mazzyDoctor as doctor } from "../src/scaffold.ts";
import { cleanupMazzyStorage, formatCleanupResult, loadStoragePolicy, storagePolicyPath, validateStoragePolicy, workspaceQuotaStatus, workspaceQuotaSummary, writeCleanupReceipt } from "../src/storage-policy.ts";
import { testScratchRoot } from "./git-root.ts";

mkdirSync(testScratchRoot, { recursive: true });
const storageRegistryDirectory = mkdtempSync(join(testScratchRoot, "registry-storage-"));
process.on("exit", () => rmSync(storageRegistryDirectory, { recursive: true, force: true }));
const registryOptions = { registryDirectory: storageRegistryDirectory };
const applyMazzyInit = (cwd: string) => apply(cwd, false, registryOptions);
const mazzyDoctor = (cwd: string, dbPath: string) => doctor(cwd, dbPath, undefined, registryOptions);
function projectTemp(prefix: string): string { mkdirSync(testScratchRoot, { recursive: true }); return mkdtempSync(join(testScratchRoot, prefix)); }
function setup(prefix: string): string {
  const root = projectTemp(prefix); execFileSync("git", ["init", "-q", root]); applyMazzyInit(root); return root;
}
function old(file: string): void { const stamp = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000); utimesSync(file, stamp, stamp); }
function policyCopy(root: string): Record<string, unknown> { return JSON.parse(readFileSync(storagePolicyPath(root), "utf8")) as Record<string, unknown>; }

/** Covers absent, non-numeric and invalid numeric values before policy values are used as numbers. */
test("storage policy validation has a complete safe-integer matrix and coherent per-directory scan bounds", () => {
  const root = setup("mazzy-storage-policy-");
  try {
    const policy = loadStoragePolicy(root);
    assert.equal(policy.directories.length, 13);
    for (const directory of policy.directories) assert.ok(existsSync(join(root, ".mazzy", directory)), directory);
    assert.throws(() => validateStoragePolicy({ ...policy, directories: ["work/tmp"] }), /canonical Mazzy workspace list/);

    const invalidValues: unknown[] = [undefined, "1", Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 0];
    for (const value of invalidValues) {
      const quota = policyCopy(root); const quotaRule = (quota.quotas as Record<string, Record<string, unknown>>)["work/tmp"]!;
      if (value === undefined) delete quotaRule.maxBytes; else quotaRule.maxBytes = value;
      assert.throws(() => validateStoragePolicy(quota), `quota ${String(value)}`);

      const retention = policyCopy(root); const retentionRule = (retention.retention as Record<string, Record<string, unknown>>).tmp!;
      if (value === undefined) delete retentionRule.maxAgeSeconds; else retentionRule.maxAgeSeconds = value;
      assert.throws(() => validateStoragePolicy(retention), `retention ${String(value)}`);

      const scanFiles = policyCopy(root); const scanFilesRule = scanFiles.scan as Record<string, unknown>;
      if (value === undefined) delete scanFilesRule.maxFiles; else scanFilesRule.maxFiles = value;
      assert.throws(() => validateStoragePolicy(scanFiles), `scan maxFiles ${String(value)}`);

      const scanBytes = policyCopy(root); const scanBytesRule = scanBytes.scan as Record<string, unknown>;
      if (value === undefined) delete scanBytesRule.maxBytes; else scanBytesRule.maxBytes = value;
      assert.throws(() => validateStoragePolicy(scanBytes), `scan maxBytes ${String(value)}`);
    }
    const valid = policyCopy(root); (valid.quotas as Record<string, Record<string, unknown>>)["work/tmp"]!.maxBytes = 1;
    (valid.retention as Record<string, Record<string, unknown>>).tmp!.maxAgeSeconds = 1;
    (valid.scan as Record<string, unknown>).maxFiles = 1;
    assert.equal(validateStoragePolicy(valid).scan.maxFiles, 1);
    const incoherent = policyCopy(root); (incoherent.scan as Record<string, unknown>).maxBytes = 1;
    assert.throws(() => validateStoragePolicy(incoherent), /scan bounds/);

    const report = mazzyDoctor(root, join(root, ".mazzy", "work", "doctor-probe"));
    assert.ok(report.some((check) => check.name === "project-local workspace" && check.status === "PASS"));
    assert.ok(report.some((check) => check.name === "storage policy" && check.status === "PASS"));
    assert.ok(report.some((check) => check.name === "workspace quotas" && check.status === "PASS"));
    assert.ok(report.some((check) => check.name === "pi-subagents project package pin" && check.status === "PASS"));
    assert.ok(report.some((check) => check.name === "pi-subagents runtime relocation/config" && check.status === "WARN"));
    assert.ok(report.some((check) => check.name === "upstream async-status temp limitation" && check.status === "WARN"));
    assert.ok(report.some((check) => check.name === "memory retention" && check.hint.startsWith("PLANNED:")));
    assert.ok(report.every((check) => !check.hint.includes(root)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup is dry-run by default and only deletes explicitly disposable Mazzy scratch", () => {
  const root = setup("mazzy-clean-");
  try {
    const tmp = join(root, ".mazzy", "work", "tmp", "old.txt");
    const result = join(root, ".mazzy", "work", "results", "old.txt");
    const output = join(root, ".mazzy", "work", "outputs", "old.txt");
    const session = join(root, ".mazzy", "work", "sessions", "old.txt");
    const manifest = join(root, ".mazzy", "manifests", "old.txt");
    const recent = join(root, ".mazzy", "work", "tmp", "recent.txt");
    for (const file of [tmp, result, output, session, manifest, recent]) writeFileSync(file, "payload");
    for (const file of [tmp, result, output, session, manifest]) old(file);
    const linked = join(root, ".mazzy", "work", "tmp", "linked-protected"); symlinkSync(session, linked);
    const preview = cleanupMazzyStorage(root, { now: Date.now() });
    assert.equal(preview.dryRun, true); assert.equal(preview.categories.tmp.eligibleFiles, 1); assert.ok(existsSync(tmp));
    assert.match(formatCleanupResult(preview), /tmp: would free 1 files/);
    const applied = cleanupMazzyStorage(root, { apply: true, now: Date.now() }); writeCleanupReceipt(root, applied, "2026-01-01T00:00:00.000Z");
    assert.throws(() => writeCleanupReceipt(root, { ...applied, categories: { tmp: { ...applied.categories.tmp, freedFiles: 100001 } } }, "2026-01-01T00:00:00.000Z"), /receipt counters/);
    assert.throws(() => writeCleanupReceipt(root, applied, "../not-a-timestamp"), /receipt timestamp/);
    assert.ok(!existsSync(tmp));
    for (const protectedFile of [result, output, session, manifest, recent]) assert.ok(existsSync(protectedFile), protectedFile);
    assert.ok(lstatSync(linked).isSymbolicLink());
    const receipts = execFileSync("find", [join(root, ".mazzy", "manifests"), "-name", "cleanup-*.json"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.equal(receipts.length, 1);
    const receipt = readFileSync(receipts[0]!, "utf8");
    assert.doesNotMatch(receipt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(Object.keys(JSON.parse(receipt).categories), ["tmp"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup rejects a regular-file replacement after scan without deleting the replacement", () => {
  const root = setup("mazzy-clean-replacement-");
  try {
    const candidate = join(root, ".mazzy", "work", "tmp", "old.txt"); const replacement = join(root, ".mazzy", "work", "tmp", "replacement.txt");
    writeFileSync(candidate, "same"); old(candidate); const scannedInode = lstatSync(candidate).ino; writeFileSync(replacement, "same");
    assert.throws(() => cleanupMazzyStorage(root, { apply: true, now: Date.now() }, { beforeDeleteCandidate(path) { renameSync(replacement, path); } }), /candidate changed during scan/);
    assert.notEqual(lstatSync(candidate).ino, scannedInode); assert.equal(readFileSync(candidate, "utf8"), "same");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup receipt refuses a manifest-directory symlink that escapes the Mazzy workspace", () => {
  const root = setup("mazzy-receipt-symlink-");
  try {
    const manifests = join(root, ".mazzy", "manifests");
    const outside = join(root, "outside-mazzy");
    rmSync(manifests, { recursive: true, force: true }); mkdirSync(outside);
    symlinkSync(outside, manifests, "dir");
    const applied = cleanupMazzyStorage(root, { apply: true, now: Date.now() });
    assert.throws(() => writeCleanupReceipt(root, applied, "2026-01-01T00:00:00.000Z"), /manifest directory is not a real directory/);
    assert.equal(existsSync(join(outside, "cleanup-2026-01-01T00-00-00-000Z-2b0e746f69c8.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-directory scan bounds inspect each compliant directory and fail closed only for the over-bound directory", () => {
  const root = setup("mazzy-clean-bounds-");
  try {
    const tmp = join(root, ".mazzy", "work", "tmp", "one.txt");
    const results = join(root, ".mazzy", "work", "results", "one.txt");
    writeFileSync(tmp, "one"); writeFileSync(results, "two"); old(tmp);
    const policy = policyCopy(root); (policy.scan as Record<string, unknown>).maxFiles = 1; writeFileSync(storagePolicyPath(root), `${JSON.stringify(policy)}\n`);
    const independent = workspaceQuotaStatus(root);
    for (const directory of ["work/tmp", "work/results"]) assert.deepEqual(independent.find((status) => status.directory === directory), { directory, files: 1, bytes: 3, maxBytes: (policy.quotas as Record<string, { maxBytes: number }>)[directory]!.maxBytes, withinQuota: true, scanComplete: true });

    const extra = join(root, ".mazzy", "work", "outputs", "two.txt"); const first = join(root, ".mazzy", "work", "outputs", "one.txt");
    writeFileSync(first, "one"); writeFileSync(extra, "two");
    const bounded = workspaceQuotaStatus(root).find((status) => status.directory === "work/outputs");
    assert.equal(bounded?.scanComplete, false); assert.equal(bounded?.withinQuota, false); assert.equal(bounded?.files, 1);
    const summary = workspaceQuotaSummary(root);
    assert.deepEqual({ files: summary.files, bytes: summary.bytes, scanComplete: summary.scanComplete, observedDirectories: summary.observedDirectories, incompleteDirectories: summary.incompleteDirectories }, { files: 2, bytes: 6, scanComplete: false, observedDirectories: 12, incompleteDirectories: 1 });
    const report = mazzyDoctor(root, join(root, ".mazzy", "work", "doctor-probe"));
    assert.ok(report.some((check) => check.name === "workspace quotas" && check.status === "WARN"));

    writeFileSync(join(root, ".mazzy", "work", "tmp", "two.txt"), "two");
    assert.throws(() => cleanupMazzyStorage(root, { apply: true }), /scan bound/);
    assert.ok(existsSync(tmp));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
