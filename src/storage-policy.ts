// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export const STORAGE_POLICY_SCHEMA = "mazzy.storage-policy";
export const STORAGE_POLICY_VERSION = 1;
export const CANONICAL_WORKSPACE_DIRECTORIES = [
  "work/tmp", "work/prompts", "work/results", "work/sessions", "work/outputs", "work/worktrees", "work/missions",
  "memory/hot", "memory/warm", "memory/cold", "indexes/vector", "dag", "manifests",
] as const;
/** Only this explicitly disposable Mazzy-owned scratch directory is TTL-cleanable in W0. */
export const CLEANABLE_CATEGORIES = ["tmp"] as const;
export type CanonicalDirectory = typeof CANONICAL_WORKSPACE_DIRECTORIES[number];
export type CleanableCategory = typeof CLEANABLE_CATEGORIES[number];

export interface StoragePolicy {
  schema: typeof STORAGE_POLICY_SCHEMA;
  version: typeof STORAGE_POLICY_VERSION;
  directories: CanonicalDirectory[];
  quotas: Record<CanonicalDirectory, { maxBytes: number }>;
  retention: Record<CleanableCategory, { maxAgeSeconds: number }>;
  scan: { maxFiles: number; maxBytes: number };
}
export interface StorageUsage { files: number; bytes: number; }
export interface QuotaStatus extends StorageUsage { directory: CanonicalDirectory; maxBytes: number; withinQuota: boolean; scanComplete: boolean; }
/** Aggregate totals cover observed (completed) directories only. */
export interface WorkspaceQuotaSummary extends StorageUsage { directories: QuotaStatus[]; scanComplete: boolean; observedDirectories: number; incompleteDirectories: number; }
export interface CleanupCategoryResult extends StorageUsage { eligibleFiles: number; eligibleBytes: number; freedFiles: number; freedBytes: number; }
export interface CleanupResult { dryRun: boolean; policyVersion: number; categories: Record<CleanableCategory, CleanupCategoryResult>; }
export interface CleanupOptions { apply?: boolean; now?: number; maxDurationMs?: number; }
interface CleanupTestHooks { beforeDeleteCandidate?: (path: string) => void; }

const MAX_POLICY_BYTES = 32 * 1024;
const MAX_POLICY_VALUE = 1024 * 1024 * 1024 * 1024;
const MAX_SCAN_DURATION_MS = 5_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isPositiveSafeInteger = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
const inside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${sep}`);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export function storagePolicyPath(root: string): string { return join(root, ".mazzy", "storage-policy.json"); }
export function canonicalDirectoryPath(root: string, directory: CanonicalDirectory): string { return join(root, ".mazzy", directory); }

/** Validate the complete, versioned policy shape; present invalid policy never falls back silently. */
export function validateStoragePolicy(value: unknown): StoragePolicy {
  if (!isRecord(value) || !exactKeys(value, ["schema", "version", "directories", "quotas", "retention", "scan"])
    || value.schema !== STORAGE_POLICY_SCHEMA || value.version !== STORAGE_POLICY_VERSION || !Array.isArray(value.directories)
    || !isRecord(value.quotas) || !isRecord(value.retention) || !isRecord(value.scan)) throw new Error("Invalid Mazzy storage policy shape");
  if (value.directories.length !== CANONICAL_WORKSPACE_DIRECTORIES.length || value.directories.some((item, index) => item !== CANONICAL_WORKSPACE_DIRECTORIES[index])) {
    throw new Error("Storage policy directories must be the canonical Mazzy workspace list");
  }
  if (!exactKeys(value.quotas, CANONICAL_WORKSPACE_DIRECTORIES)) throw new Error("Storage policy quotas must cover exactly the canonical directories");
  const quotas = {} as StoragePolicy["quotas"];
  for (const directory of CANONICAL_WORKSPACE_DIRECTORIES) {
    const quota = value.quotas[directory]; const maxBytes = isRecord(quota) ? quota.maxBytes : undefined;
    if (!isRecord(quota) || !exactKeys(quota, ["maxBytes"]) || !isPositiveSafeInteger(maxBytes, MAX_POLICY_VALUE)) throw new Error(`Invalid quota for ${directory}`);
    quotas[directory] = { maxBytes };
  }
  if (!exactKeys(value.retention, CLEANABLE_CATEGORIES)) throw new Error("Storage policy retention must cover exactly tmp");
  const retention = {} as StoragePolicy["retention"];
  for (const category of CLEANABLE_CATEGORIES) {
    const rule = value.retention[category]; const maxAgeSeconds = isRecord(rule) ? rule.maxAgeSeconds : undefined;
    if (!isRecord(rule) || !exactKeys(rule, ["maxAgeSeconds"]) || !isPositiveSafeInteger(maxAgeSeconds, 366 * 24 * 60 * 60)) throw new Error(`Invalid retention rule for ${category}`);
    retention[category] = { maxAgeSeconds };
  }
  const maxFiles = value.scan.maxFiles; const scanMaxBytes = value.scan.maxBytes;
  if (!exactKeys(value.scan, ["maxFiles", "maxBytes"]) || !isPositiveSafeInteger(maxFiles, 100_000) || !isPositiveSafeInteger(scanMaxBytes, MAX_POLICY_VALUE)
    || CANONICAL_WORKSPACE_DIRECTORIES.some((directory) => scanMaxBytes < quotas[directory].maxBytes)) throw new Error("Invalid storage scan bounds");
  return { schema: STORAGE_POLICY_SCHEMA, version: STORAGE_POLICY_VERSION, directories: [...CANONICAL_WORKSPACE_DIRECTORIES], quotas, retention, scan: { maxFiles, maxBytes: scanMaxBytes } };
}

export function loadStoragePolicy(root: string): StoragePolicy {
  const rootReal = realpathSync(root); const file = storagePolicyPath(rootReal);
  if (!inside(rootReal, resolve(file)) || !existsSync(file)) throw new Error("Mazzy storage policy is missing");
  const detail = lstatSync(file);
  if (!detail.isFile() || detail.isSymbolicLink() || detail.size > MAX_POLICY_BYTES) throw new Error("Mazzy storage policy must be a small regular file");
  try { return validateStoragePolicy(JSON.parse(readFileSync(file, "utf8")) as unknown); } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Mazzy storage policy JSON is invalid");
    throw error;
  }
}

/** Idempotently create only the canonical project-local directory set. */
export function initializeMazzyWorkspace(root: string): void {
  const rootReal = realpathSync(root);
  for (const directory of CANONICAL_WORKSPACE_DIRECTORIES) mkdirSync(canonicalDirectoryPath(rootReal, directory), { recursive: true, mode: 0o700 });
}

function assertWithin(root: string, candidate: string): void { if (!inside(root, candidate)) throw new Error("Resolved path escapes the permitted Mazzy workspace"); }
function emptyCleanupResult(): CleanupCategoryResult { return { files: 0, bytes: 0, eligibleFiles: 0, eligibleBytes: 0, freedFiles: 0, freedBytes: 0 }; }
function bounded(nowStarted: number, maxDurationMs: number): void { if (Date.now() - nowStarted > maxDurationMs) throw new Error("Mazzy storage scan time bound exceeded"); }

interface ScanState { files: number; bytes: number; maxFiles: number; maxBytes: number; started: number; maxDurationMs: number; }
class ScanBoundExceeded extends Error { constructor() { super("Mazzy storage scan bound exceeded"); } }
function newScanState(policy: StoragePolicy, maxDurationMs: number): ScanState {
  return { files: 0, bytes: 0, maxFiles: policy.scan.maxFiles, maxBytes: policy.scan.maxBytes, started: Date.now(), maxDurationMs };
}
interface ScannedRegularFile { size: number; mtimeMs: number; dev: bigint; ino: bigint; mtimeNs: bigint; }
/** Scan state is intentionally per canonical directory: aggregate usage never disables another directory's inspection. */
function scanRegularFiles(directory: string, root: string, state: ScanState, onFile: (file: string, detail: ScannedRegularFile) => void): void {
  bounded(state.started, state.maxDurationMs); assertWithin(root, directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    bounded(state.started, state.maxDurationMs);
    const file = join(directory, entry.name); const detail = lstatSync(file);
    if (detail.isSymbolicLink()) continue;
    if (detail.isDirectory()) { const real = realpathSync(file); assertWithin(root, real); scanRegularFiles(real, root, state, onFile); continue; }
    if (!detail.isFile()) continue;
    const stable = lstatSync(file, { bigint: true });
    if (!stable.isFile() || stable.isSymbolicLink()) continue;
    const size = Number(stable.size);
    if (state.files >= state.maxFiles || size > state.maxBytes - state.bytes) throw new ScanBoundExceeded();
    state.files += 1; state.bytes += size;
    onFile(file, { size, mtimeMs: Number(stable.mtimeNs) / 1_000_000, dev: stable.dev, ino: stable.ino, mtimeNs: stable.mtimeNs });
  }
}

function safeDirectory(rootReal: string, directory: CanonicalDirectory): string | undefined {
  const mazzyRoot = join(rootReal, ".mazzy");
  if (!existsSync(mazzyRoot)) return undefined;
  const mazzyDetail = lstatSync(mazzyRoot);
  if (!mazzyDetail.isDirectory() || mazzyDetail.isSymbolicLink()) throw new Error("Mazzy workspace root is not a real directory");
  const mazzyReal = realpathSync(mazzyRoot); assertWithin(rootReal, mazzyReal);
  let current = mazzyReal;
  for (const part of directory.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) return undefined;
    const detail = lstatSync(current);
    if (!detail.isDirectory() || detail.isSymbolicLink()) throw new Error("Mazzy workspace directory is not a real directory");
    const real = realpathSync(current); assertWithin(mazzyReal, real); current = real;
  }
  return current;
}

export function workspaceQuotaStatus(root: string, policy = loadStoragePolicy(root), maxDurationMs = MAX_SCAN_DURATION_MS): QuotaStatus[] {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) throw new Error("Invalid storage scan duration");
  const rootReal = realpathSync(root);
  return CANONICAL_WORKSPACE_DIRECTORIES.map((directory) => {
    const usage: StorageUsage = { files: 0, bytes: 0 }; const real = safeDirectory(rootReal, directory); let scanComplete = true;
    try { if (real) scanRegularFiles(real, real, newScanState(policy, maxDurationMs), (_file, detail) => { usage.files += 1; usage.bytes += detail.size; }); }
    catch (error) { if (error instanceof ScanBoundExceeded) scanComplete = false; else throw error; }
    const maxBytes = policy.quotas[directory].maxBytes;
    return { directory, ...usage, maxBytes, withinQuota: scanComplete && usage.bytes <= maxBytes, scanComplete };
  });
}

/** Aggregate only completed per-directory observations; a bounded directory remains explicitly incomplete. */
export function workspaceQuotaSummary(root: string, policy = loadStoragePolicy(root), maxDurationMs = MAX_SCAN_DURATION_MS): WorkspaceQuotaSummary {
  const directories = workspaceQuotaStatus(root, policy, maxDurationMs);
  const observed = directories.filter((directory) => directory.scanComplete);
  return { directories, files: observed.reduce((total, directory) => total + directory.files, 0), bytes: observed.reduce((total, directory) => total + directory.bytes, 0), scanComplete: observed.length === directories.length, observedDirectories: observed.length, incompleteDirectories: directories.length - observed.length };
}

/** Cleanup is limited to old regular files in explicitly disposable Mazzy-owned work/tmp. */
export function cleanupMazzyStorage(root: string, options: CleanupOptions = {}, testHooks?: CleanupTestHooks): CleanupResult {
  const rootReal = realpathSync(root); const policy = loadStoragePolicy(rootReal);
  const maxDurationMs = options.maxDurationMs ?? MAX_SCAN_DURATION_MS;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) throw new Error("Invalid cleanup scan duration");
  const now = options.now ?? Date.now(); if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid cleanup clock");
  const categories = Object.fromEntries(CLEANABLE_CATEGORIES.map((category) => [category, emptyCleanupResult()])) as CleanupResult["categories"];
  const candidates: Array<{ category: CleanableCategory; path: string; detail: ScannedRegularFile }> = [];
  for (const category of CLEANABLE_CATEGORIES) {
    const real = safeDirectory(rootReal, `work/${category}` as CanonicalDirectory); if (!real) continue;
    scanRegularFiles(real, real, newScanState(policy, maxDurationMs), (path, detail) => {
      const result = categories[category]; result.files += 1; result.bytes += detail.size;
      if (now - detail.mtimeMs > policy.retention[category].maxAgeSeconds * 1000) { result.eligibleFiles += 1; result.eligibleBytes += detail.size; candidates.push({ category, path, detail }); }
    });
  }
  if (options.apply) for (const candidate of candidates) {
    const categoryRoot = safeDirectory(rootReal, `work/${candidate.category}` as CanonicalDirectory);
    if (!categoryRoot) throw new Error("Permitted cleanup directory disappeared during cleanup");
    const parent = realpathSync(dirname(candidate.path)); assertWithin(categoryRoot, parent);
    testHooks?.beforeDeleteCandidate?.(candidate.path);
    const detail = lstatSync(candidate.path, { bigint: true });
    if (!detail.isFile() || detail.isSymbolicLink() || detail.dev !== candidate.detail.dev || detail.ino !== candidate.detail.ino || detail.size !== BigInt(candidate.detail.size) || detail.mtimeNs !== candidate.detail.mtimeNs) throw new Error("Cleanup candidate changed during scan");
    unlinkSync(candidate.path); categories[candidate.category].freedFiles += 1; categories[candidate.category].freedBytes += candidate.detail.size;
  }
  return { dryRun: !options.apply, policyVersion: policy.version, categories };
}

function checkedReceiptDirectory(rootReal: string): { mazzyRoot: string; manifests: string } {
  const mazzyRoot = join(rootReal, ".mazzy");
  const mazzyDetail = lstatSync(mazzyRoot);
  if (!mazzyDetail.isDirectory() || mazzyDetail.isSymbolicLink()) throw new Error("Mazzy workspace root is not a real directory");
  const mazzyReal = realpathSync(mazzyRoot); assertWithin(rootReal, mazzyReal);
  const manifests = join(mazzyReal, "manifests");
  if (!existsSync(manifests)) mkdirSync(manifests, { recursive: false, mode: 0o700 });
  const manifestDetail = lstatSync(manifests);
  if (!manifestDetail.isDirectory() || manifestDetail.isSymbolicLink()) throw new Error("Mazzy manifest directory is not a real directory");
  const manifestsReal = realpathSync(manifests); assertWithin(mazzyReal, manifestsReal);
  return { mazzyRoot: mazzyReal, manifests: manifestsReal };
}

function openReceiptDirectory(directory: string): number {
  // The descriptor-backed path prevents a swapped manifest-directory symlink from
  // redirecting the write between validation and rename. Fail closed off platforms
  // that do not expose descriptor paths rather than falling back to a racy pathname.
  if (!existsSync("/proc/self/fd")) throw new Error("Secure cleanup receipt writes require descriptor-backed paths");
  return openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function receiptCounters(result: CleanupResult): Record<CleanableCategory, { freedFiles: number; freedBytes: number }> {
  if (!Number.isSafeInteger(result.policyVersion) || result.policyVersion < 1 || result.policyVersion > STORAGE_POLICY_VERSION) throw new Error("Invalid cleanup receipt policy version");
  return Object.fromEntries(CLEANABLE_CATEGORIES.map((category) => {
    const value = result.categories[category];
    if (!value || !isPositiveOrZeroSafeInteger(value.freedFiles, 100_000) || !isPositiveOrZeroSafeInteger(value.freedBytes, MAX_POLICY_VALUE)) throw new Error("Invalid cleanup receipt counters");
    return [category, { freedFiles: value.freedFiles, freedBytes: value.freedBytes }];
  })) as Record<CleanableCategory, { freedFiles: number; freedBytes: number }>;
}
const isPositiveOrZeroSafeInteger = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const RECEIPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Receipts contain bounded aggregate counters only; they deliberately contain no payload or path. */
export function writeCleanupReceipt(root: string, result: CleanupResult, timestamp = new Date().toISOString()): void {
  if (result.dryRun) return;
  if (!RECEIPT_TIMESTAMP.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid cleanup receipt timestamp");
  const categories = receiptCounters(result);
  const rootReal = realpathSync(root);
  const checked = checkedReceiptDirectory(rootReal);
  const descriptor = openReceiptDirectory(checked.manifests);
  const descriptorPath = `/proc/self/fd/${descriptor}`;
  let temporary: string | undefined;
  try {
    // Resolve both public paths before writing and retain their expected identities.
    const beforeWrite = checkedReceiptDirectory(rootReal);
    if (beforeWrite.mazzyRoot !== checked.mazzyRoot || beforeWrite.manifests !== checked.manifests) throw new Error("Mazzy manifest directory changed during receipt write");
    const contents = `${JSON.stringify({ schema: "mazzy.cleanup-receipt", version: 1, policyVersion: result.policyVersion, timestamp, categories }, null, 2)}\n`;
    const name = `cleanup-${timestamp.replace(/[:.]/g, "-")}-${createHash("sha256").update(contents).digest("hex").slice(0, 12)}.json`;
    const target = join(descriptorPath, name); temporary = join(descriptorPath, `.${basename(name)}.${process.pid}.tmp`);
    const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(file, contents, undefined, "utf8"); } finally { closeSync(file); }
    const temporaryDetail = lstatSync(temporary);
    if (!temporaryDetail.isFile() || temporaryDetail.isSymbolicLink()) throw new Error("Cleanup receipt temporary file is not a regular file");
    // Re-check immediately before the atomic operation. rename uses the retained
    // directory descriptor, so a later pathname swap cannot redirect it outside.
    const beforeRename = checkedReceiptDirectory(rootReal);
    if (beforeRename.mazzyRoot !== checked.mazzyRoot || beforeRename.manifests !== checked.manifests) throw new Error("Mazzy manifest directory changed during receipt write");
    renameSync(temporary, target); temporary = undefined;
    const targetDetail = lstatSync(target);
    if (!targetDetail.isFile() || targetDetail.isSymbolicLink()) throw new Error("Cleanup receipt is not a regular file");
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* best-effort private temporary cleanup */ } }
    closeSync(descriptor);
  }
}

export function formatCleanupResult(result: CleanupResult): string {
  const mode = result.dryRun ? "would free" : "freed";
  return CLEANABLE_CATEGORIES.map((category) => { const value = result.categories[category]; return `${category}: ${mode} ${result.dryRun ? value.eligibleFiles : value.freedFiles} files / ${result.dryRun ? value.eligibleBytes : value.freedBytes} bytes`; }).join("\n");
}