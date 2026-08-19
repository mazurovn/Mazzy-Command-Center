// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import { gitCheck } from "./git-safe.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { CANONICAL_WORKSPACE_DIRECTORIES, initializeMazzyWorkspace, loadStoragePolicy, workspaceQuotaSummary } from "./storage-policy.ts";
import { validateRoutingPolicy } from "./routing.ts";
import {
  ensureProjectIdentity, inspectMazzyProjectDirectory, readProjectIdentity,
  resolveOpsDbPathDiagnostic, resolveTrustedProjectRoot,
  type MazzyDbPathDiagnostic, type MazzyDbResolutionSource,
} from "./project.ts";
import {
  assertProjectRegistration, enrollProjectRegistration, resolveRegistryLocationDiagnostic,
  type RegistryAssertionStatus, type RegistryLocationSource, type RegistryOptions,
} from "./project-registry.ts";
import { probeControlDb } from "./control-db.ts";
import { inspectSingleMechanism } from "./anti-tunnel.ts";
import { resolveControlDb } from "./control-resolve.ts";

export type PlanStatus = "create" | "skip" | "conflict" | "update";
export interface ScaffoldPlanEntry { path: string; status: PlanStatus; reason: string; }
/** `source`, when present, is a safe enum and never a database path or override value. */
export interface DoctorCheck { name: string; status: "PASS" | "WARN" | "FAIL"; hint: string; source?: MazzyDbResolutionSource | RegistryLocationSource; }
export interface InitResult { root?: string; dryRun: boolean; entries: ScaffoldPlanEntry[]; registry?: { status: PlanStatus; reason: string }; rolledBack?: boolean; }
interface DesiredTemplate { relativePath: string; content: string; prunedLegacyPackages?: number; prunedIneffectiveSubagentSettings?: number; }

const LEGACY_SELF_PACKAGE = "../mazzy-control-panel";
/** These extension-config keys are not read from project .pi/settings.json by pi-subagents 0.50.0. */
const INEFFECTIVE_PROJECT_SUBAGENT_SETTINGS = new Set([
  "artifactDir", "defaultSessionDir", "singleRunOutputBaseDir", "worktreeBaseDir", "globalConcurrencyLimit",
  "maxSubagentSpawnsPerRun", "maxSubagentDepth", "missions", "maxConcurrent",
]);
const resourceRoot = new URL("../resources/", import.meta.url);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const portable = (value: string) => !/(?:^|[\s"'])\/(?:home|Users)\//.test(value) && !/(?:token|api[_-]?key|secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i.test(value);
const readResource = (name: string) => readFileSync(new URL(name, resourceRoot), "utf8");
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; } return JSON.stringify(value); }
/** Managed arrays are additive: local order is retained and only missing defaults append. */
function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> { const out = { ...base }; for (const [key, value] of Object.entries(extra)) { const current = out[key]; if (Array.isArray(value) && Array.isArray(current)) { const seen = new Set(current.map(stableJson)); out[key] = [...current, ...value.filter((item) => { const identity = stableJson(item); if (seen.has(identity)) return false; seen.add(identity); return true; })]; } else if (typeof value === "object" && value && !Array.isArray(value) && typeof current === "object" && current && !Array.isArray(current)) out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>); else out[key] = value; } return out; }
/** Reject a write whose target file or any already-existing ancestor directory is a symlink: a symlinked .pi (or ancestor) could redirect scaffold writes outside the checkout. */
function assertNoSymlinkEscape(path: string): void {
  const resolved = resolve(path);
  let current = resolved;
  const chain: string[] = [];
  while (true) { chain.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  for (const segment of chain) { let stat; try { stat = lstatSync(segment); } catch { continue; } if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlinked path segment: ${segment}`); }
}
function atomic(path: string, content: string): void { assertNoSymlinkEscape(path); mkdirSync(dirname(path), { recursive: true }); assertNoSymlinkEscape(path); const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`); writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 }); renameSync(temp, path); }
function receiptPath(root: string): string { return join(root, ".pi", "mazzy", "state.json"); }
function receipt(root: string): Record<string, string> { try { const value = readJson(receiptPath(root)); return (value.templates && typeof value.templates === "object" ? value.templates : {}) as Record<string, string>; } catch { return {}; } }

/** Remove the old self-install only when it is a stale path in this target project. */
function migrateLegacyPackages(root: string, current: Record<string, unknown>): { settings: Record<string, unknown>; pruned: number } {
  if (!Array.isArray(current.packages)) return { settings: current, pruned: 0 };
  const piDirectory = join(root, ".pi");
  let pruned = 0;
  const packages = current.packages.filter((entry) => {
    if (entry !== LEGACY_SELF_PACKAGE || existsSync(resolve(piDirectory, entry))) return true;
    pruned += 1;
    return false;
  });
  return pruned ? { settings: { ...current, packages }, pruned } : { settings: current, pruned: 0 };
}

function migrateIneffectiveProjectSubagentSettings(current: Record<string, unknown>): { settings: Record<string, unknown>; pruned: number } {
  const subagents = current.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return { settings: current, pruned: 0 };
  const retained = Object.fromEntries(Object.entries(subagents).filter(([key]) => !INEFFECTIVE_PROJECT_SUBAGENT_SETTINGS.has(key)));
  const pruned = Object.keys(subagents).length - Object.keys(retained).length;
  return pruned ? { settings: { ...current, subagents: retained }, pruned } : { settings: current, pruned: 0 };
}

function desired(root: string): DesiredTemplate[] {
  const settingsPath = join(root, ".pi", "settings.json"); let current: Record<string, unknown> = {};
  try { current = readJson(settingsPath); } catch { /* a malformed existing settings file is a conflict below */ }
  const legacyMigration = migrateLegacyPackages(root, current);
  const settingsMigration = migrateIneffectiveProjectSubagentSettings(legacyMigration.settings);
  return [
    { relativePath: ".pi/mazzy/routing.json", content: readResource("routing.json") },
    { relativePath: ".pi/agents/mazzy-orchestrator.md", content: readResource("agents/mazzy-orchestrator.md") },
    { relativePath: ".pi/settings.json", content: `${JSON.stringify(deepMerge(settingsMigration.settings, JSON.parse(readResource("settings.fragment.json")) as Record<string, unknown>), null, 2)}\n`, prunedLegacyPackages: legacyMigration.pruned, prunedIneffectiveSubagentSettings: settingsMigration.pruned },
    { relativePath: ".mazzy/README.md", content: readResource("mazzy-workspace.README.md") },
    { relativePath: ".mazzy/.gitignore", content: readResource("mazzy-workspace.gitignore") },
    { relativePath: ".mazzy/storage-policy.json", content: readResource("storage-policy.json") },
  ];
}

function settingsPlanReason(template: DesiredTemplate): string {
  const reasons: string[] = [];
  if (template.prunedLegacyPackages) reasons.push(`prune ${template.prunedLegacyPackages} stale legacy package path${template.prunedLegacyPackages === 1 ? "" : "s"}`);
  if (template.prunedIneffectiveSubagentSettings) reasons.push(`prune ${template.prunedIneffectiveSubagentSettings} ineffective pi-subagents project setting${template.prunedIneffectiveSubagentSettings === 1 ? "" : "s"}`);
  return reasons.length ? `${reasons.join(" and ")} and deep-merge defaults` : "deep-merge defaults";
}

function pathPresent(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

function registryPlan(status: RegistryAssertionStatus): { status: PlanStatus; reason: string } {
  const values: Record<RegistryAssertionStatus, { status: PlanStatus; reason: string }> = {
    match: { status: "skip", reason: "private registration matches this checkout" }, unregistered: { status: "create", reason: "private registration is absent" }, moved: { status: "update", reason: "checkout move needs registration refresh" },
    "duplicate-project-id": { status: "conflict", reason: "duplicate project identity requires manual resolution" }, "duplicate-canonical-root": { status: "conflict", reason: "canonical checkout is registered to another identity" },
    "registry-invalid": { status: "conflict", reason: "private registry validation failed; no registry write will occur" }, "registry-key-missing": { status: "conflict", reason: "private registry key is missing; no registry write will occur" },
    "registry-busy": { status: "skip", reason: "private registry is busy; registration is deferred" }, "registry-unavailable": { status: "skip", reason: "private registry is unavailable; registration is deferred" },
    "registry-capacity": { status: "skip", reason: "private registry capacity is reached; no registry write will occur" },
  };
  return values[status];
}

export function planMazzyInit(cwd: string, registryOptions: RegistryOptions = {}): InitResult {
  const root = resolveTrustedProjectRoot(cwd); if (!root) return { dryRun: true, entries: [{ path: ".pi", status: "conflict", reason: "trusted Git project is required" }], registry: registryPlan(assertProjectRegistration(cwd, registryOptions).status) };
  const directoryStatus = inspectMazzyProjectDirectory(root), prior = receipt(root), templates = desired(root);
  const entries = templates.map((template) => {
    const { relativePath, content } = template;
    if (directoryStatus === "untrusted" && relativePath.startsWith(".mazzy/")) {
      return { path: relativePath, status: "conflict" as const, reason: "untrusted .mazzy directory; never write through symlinks or non-directories" };
    }
    const file = join(root, relativePath); if (!existsSync(file)) return { path: relativePath, status: "create" as const, reason: "missing" }; const existing = readFileSync(file, "utf8"); if (relativePath === ".pi/settings.json") { try { JSON.parse(existing); } catch { return { path: relativePath, status: "conflict" as const, reason: "existing settings JSON is invalid" }; } } const expected = sha(content); if (sha(existing) === expected) return { path: relativePath, status: "skip" as const, reason: "already matches" }; if (prior[relativePath] === sha(existing) || relativePath === ".pi/settings.json") return { path: relativePath, status: "update" as const, reason: relativePath === ".pi/settings.json" ? settingsPlanReason(template) : "managed template changed" }; return { path: relativePath, status: "conflict" as const, reason: "diverges from managed template" };
  });
  const identityPath = join(root, ".mazzy", "project.json");
  if (directoryStatus === "untrusted") entries.push({ path: ".mazzy/project.json", status: "conflict", reason: "untrusted .mazzy directory; identity enrollment is refused" });
  else if (!pathPresent(identityPath)) entries.push({ path: ".mazzy/project.json", status: "create", reason: "opaque project identity is missing" });
  else {
    try { readProjectIdentity(root); entries.push({ path: ".mazzy/project.json", status: "skip", reason: "valid immutable project identity" }); }
    catch { entries.push({ path: ".mazzy/project.json", status: "conflict", reason: "invalid project identity; force never replaces identity" }); }
  }
  const registrationStatus = pathPresent(identityPath) ? assertProjectRegistration(root, registryOptions).status : "unregistered";
  return { root, dryRun: true, entries, registry: registryPlan(registrationStatus) };
}

export function applyMazzyInit(cwd: string, force = false, registryOptions: RegistryOptions = {}): InitResult {
  const plan = planMazzyInit(cwd, registryOptions); if (!plan.root) return plan; const root = plan.root, templates = desired(root), stamp = new Date().toISOString().replace(/[:.]/g, "-"), backed: string[] = [], untrustedDirectory = inspectMazzyProjectDirectory(root) === "untrusted";
  for (const entry of plan.entries) { if (entry.path === ".mazzy/project.json" || untrustedDirectory && entry.path.startsWith(".mazzy/") || entry.status === "skip" || entry.status === "conflict" && !force) continue; const item = templates.find((x) => x.relativePath === entry.path)!; const target = join(root, item.relativePath); if (existsSync(target) && readFileSync(target, "utf8") !== item.content) { const backup = join(root, ".pi", "mazzy", "backups", stamp, item.relativePath); atomic(backup, readFileSync(target, "utf8")); backed.push(item.relativePath); } atomic(target, item.content); }
  const identity = plan.entries.find((entry) => entry.path === ".mazzy/project.json");
  const ignorePolicy = plan.entries.find((entry) => entry.path === ".mazzy/.gitignore");
  if (identity?.status === "create" && ignorePolicy?.status === "conflict" && !force) {
    identity.status = "conflict";
    identity.reason = "identity enrollment waits for explicit acceptance of the divergent .mazzy/.gitignore";
  } else if (identity?.status === "create") {
    try { ensureProjectIdentity(root); }
    catch { identity.status = "conflict"; identity.reason = "identity enrollment failed safely; unrelated scaffold files were still applied"; }
  }
  if (identity?.status === "skip" || identity?.status === "create" && identity.reason !== "identity enrollment failed safely; unrelated scaffold files were still applied") {
    plan.registry = registryPlan(enrollProjectRegistration(root, registryOptions).status);
  }
  if (backed.length) atomic(join(root, ".pi", "mazzy", "backups", stamp, "manifest.json"), `${JSON.stringify({ files: backed }, null, 2)}\n`);
  // These Mazzy-owned paths are project-local. pi-subagents controls retain their
  // individually documented resolution behavior; this scaffold does not redirect them.
  if (!untrustedDirectory) initializeMazzyWorkspace(root);
  const hashes = Object.fromEntries(templates.filter((item) => !untrustedDirectory || !item.relativePath.startsWith(".mazzy/")).map((item) => [item.relativePath, sha(item.content)])); atomic(receiptPath(root), `${JSON.stringify({ packageVersion: "0.2.0", templates: hashes }, null, 2)}\n`);
  return { ...plan, dryRun: false };
}

export function rollbackMazzyInit(cwd: string): InitResult {
  const root = resolveTrustedProjectRoot(cwd); if (!root) return { dryRun: false, entries: [{ path: ".pi", status: "conflict", reason: "trusted Git project is required" }] }; const backups = join(root, ".pi", "mazzy", "backups"); if (!existsSync(backups)) return { root, dryRun: false, rolledBack: false, entries: [] }; const latest = readdirSync(backups).sort().at(-1); if (!latest) return { root, dryRun: false, rolledBack: false, entries: [] }; const manifest = readJson(join(backups, latest, "manifest.json")); const files = Array.isArray(manifest.files) ? manifest.files.filter((x): x is string => typeof x === "string") : []; for (const file of files) atomic(join(root, file), readFileSync(join(backups, latest, file), "utf8")); rmSync(join(backups, latest), { recursive: true, force: true }); return { root, dryRun: false, rolledBack: true, entries: files.map((path) => ({ path, status: "update", reason: "restored Mazzy backup" })) };
}

function hasHostAbsolutePath(spec: string): boolean { return /^(?:npm|git):\/(?:home|Users)\//.test(spec) || /(?:^|[?&#=])(?:\/(?:home|Users)\/|[A-Za-z]:[\\/])/.test(spec) || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(spec); }
function isAbsoluteLocalPath(spec: string): boolean { return isAbsolute(spec) || win32.isAbsolute(spec); }
/** True only when candidate is base itself or a descendant of base (no ../ escape). */
function pathWithin(base: string, candidate: string): boolean { const b = resolve(base), c = resolve(candidate); if (c === b) return true; const rel = c.startsWith(b + "/") ? c.slice(b.length + 1) : undefined; return rel !== undefined && !rel.startsWith(".."); }
function remoteSpecStatus(spec: string): "valid" | "invalid" | undefined {
  if (spec.startsWith("npm:")) return spec.length > 4 && !/\s/.test(spec) && !hasHostAbsolutePath(spec) ? "valid" : "invalid";
  if (spec.startsWith("git:")) return spec.length > 4 && !/\s/.test(spec) && !hasHostAbsolutePath(spec) ? "valid" : "invalid";
  if (spec.startsWith("git+") || spec.startsWith("https:")) {
    try { const url = new URL(spec.startsWith("git+") ? spec.slice(4) : spec); return (url.protocol === "https:" || url.protocol === "ssh:" || url.protocol === "git:") && !hasHostAbsolutePath(spec) ? "valid" : "invalid"; } catch { return "invalid"; }
  }
  return undefined;
}

function packageChecks(root: string): DoctorCheck[] {
  const settingsPath = join(root, ".pi", "settings.json");
  if (!existsSync(settingsPath)) return [];
  let settings: Record<string, unknown>;
  try { settings = readJson(settingsPath); } catch { return [{ name: "project package settings", status: "FAIL", hint: "Fix invalid `.pi/settings.json` before running /mazzy-init." }]; }
  if (!Array.isArray(settings.packages)) return [];
  const piDirectory = dirname(settingsPath);
  return settings.packages.reduce<DoctorCheck[]>((checks, entry, index) => {
    if (typeof entry !== "string") return checks;
    const name = `package specification ${index + 1}`;
    const remote = remoteSpecStatus(entry);
    if (remote === "valid") checks.push({ name, status: "PASS", hint: "Remote package spec is syntactically portable; registry availability was not checked." });
    else if (remote === "invalid") checks.push({ name, status: "FAIL", hint: "Remote package spec is not syntactically portable; use a valid npm, git, git+, or https spec without host paths." });
    else if (isAbsoluteLocalPath(entry)) checks.push({ name, status: "FAIL", hint: "Absolute local paths are host-specific; use a portable remote spec or a target-relative local path." });
    else if (entry !== LEGACY_SELF_PACKAGE && !pathWithin(piDirectory, resolve(piDirectory, entry))) checks.push({ name, status: "FAIL", hint: "Local package path escapes the target `.pi` directory; use a spec that resolves under `.pi`." });
    else if (existsSync(resolve(piDirectory, entry))) checks.push({ name, status: "PASS", hint: "Local package path resolves from the target `.pi` directory." });
    else checks.push({ name, status: "FAIL", hint: "Stale local package path: run /mazzy-init migration to prune or fix this stale local path." });
    return checks;
  }, []);
}

export function mazzyDoctor(cwd: string, dbPath: string, dbDiagnostic: MazzyDbPathDiagnostic = resolveOpsDbPathDiagnostic(cwd), registryOptions: RegistryOptions = {}): DoctorCheck[] {
  const root = resolveTrustedProjectRoot(cwd), checks: DoctorCheck[] = [];
  // Registry diagnostics are deliberately best-effort: doctor must retain every unrelated check.
  let registry: ReturnType<typeof assertProjectRegistration> = { status: "registry-unavailable", schemaVersion: 1 };
  let registryLocation: ReturnType<typeof resolveRegistryLocationDiagnostic> = { source: "default-state-home" };
  try { registry = assertProjectRegistration(cwd, registryOptions); } catch { /* degrade below */ }
  try { registryLocation = resolveRegistryLocationDiagnostic(registryOptions); } catch { /* safe enum default */ }
  const registryCheck: Record<RegistryAssertionStatus, { status: "PASS" | "WARN" | "FAIL"; hint: string }> = {
    match: { status: "PASS", hint: "Private project registration matches this checkout." }, unregistered: { status: "WARN", hint: "Private project registration is absent; run /mazzy-init --apply." }, moved: { status: "WARN", hint: "Checkout move is detected; run /mazzy-init --apply to refresh registration." },
    "duplicate-project-id": { status: "FAIL", hint: "Duplicate project identity detected; manually forget the stale local registration or enroll the copy separately." }, "duplicate-canonical-root": { status: "FAIL", hint: "Canonical checkout is registered to another identity; manual resolution is required." },
    "registry-invalid": { status: "FAIL", hint: "Private project registry validation failed; no registry write is attempted." }, "registry-key-missing": { status: "FAIL", hint: "Private project registry key is missing; no registry write is attempted." },
    "registry-busy": { status: "WARN", hint: "Private project registry is busy; retry later." }, "registry-unavailable": { status: "WARN", hint: "Private project registry is unavailable; scaffold repair remains available." },
    "registry-capacity": { status: "WARN", hint: "Private project registry capacity is reached; no registry write is attempted." },
  };
  checks.push({ name: "project registry", source: registryLocation.source, ...registryCheck[registry.status] });
  const resolutionHint: Record<MazzyDbResolutionSource, string> = {
    "explicit-override": "Override-selected database; the override value is intentionally not displayed. Read-only migration status is available, but identity-asserting selection is not implemented.",
    "git-root-legacy": "Legacy Git-root database resolution selected. Read-only migration status is available; identity-asserting selection and project isolation remain unimplemented.",
    "cwd-fallback": "CWD fallback database resolution selected. Read-only migration status is available; identity-asserting selection and project isolation remain unimplemented.",
  };
  checks.push({ name: "database resolution", status: "WARN", source: dbDiagnostic.source, hint: resolutionHint[dbDiagnostic.source] });
  // Probe errors are contained so corrupt/untrusted database state cannot suppress unrelated diagnostics.
  try {
    const control = probeControlDb(cwd, { legacyPath: dbPath, resolution: dbDiagnostic.source });
    const identityCheck: Record<typeof control.identity, { status: "PASS" | "WARN" | "FAIL"; hint: string }> = {
      match: { status: "PASS", hint: "Matching project and filesystem control-database identity observed." },
      mismatch: { status: "FAIL", hint: "Control-database identity does not match this checkout; no fallback or repair was attempted." },
      "fs-mismatch": { status: "FAIL", hint: "Control-database filesystem identity does not match this checkout; canonical endpoint is held." },
      "fs-absent": { status: "WARN", hint: "Control-database filesystem identity stamp is absent; re-promote before cutover." },
      absent: { status: "WARN", hint: "Control-database identity is absent; canonical endpoint is held." },
      "target-absent": { status: "WARN", hint: "No promoted control database is present; legacy resolution remains active." },
      unreadable: { status: "FAIL", hint: "Control-database identity could not be safely inspected; no repair was attempted." },
      "override-skipped": { status: "WARN", hint: "Control-database identity is intentionally skipped for an explicit override." },
    };
    checks.push({ name: "control database identity", ...identityCheck[control.identity] });
    checks.push({ name: "legacy database candidates", status: "WARN", hint: `${control.legacyCandidates} bounded legacy database candidate${control.legacyCandidates === 1 ? "" : "s"} observed; only counts are reported and no migration was attempted.` });
  } catch {
    checks.push({ name: "control database identity", status: "FAIL", hint: "Control-database identity could not be safely inspected; no repair was attempted." });
    checks.push({ name: "legacy database candidates", status: "WARN", hint: "Legacy database candidates could not be safely counted; no migration was attempted." });
  }
  checks.push({ name: "trusted project", status: root ? "PASS" : "FAIL", hint: root ? "Git root discovered." : "Run inside a trusted Git project." });
  const identityPath = root ? join(root, ".mazzy", "project.json") : "";
  const projectDirectoryStatus = root ? inspectMazzyProjectDirectory(root) : "untrusted";
  if (projectDirectoryStatus === "untrusted") {
    checks.push({ name: "project identity", status: "FAIL", hint: "The .mazzy path is a symlink or non-directory. Identity and workspace writes are refused; only unrelated .pi scaffold files may be repaired." });
  } else try {
    if (!root) throw new Error();
    const identity = readProjectIdentity(root);
    checks.push({ name: "project identity", status: "PASS", hint: `Opaque Project identity validates (schema ${identity.descriptor.schemaVersion}); identifier is intentionally redacted.` });
  } catch {
    const invalid = Boolean(identityPath && pathPresent(identityPath));
    checks.push({ name: "project identity", status: invalid ? "FAIL" : "WARN", hint: invalid
      ? "Project identity is invalid. Other scaffold files can be repaired, but identity is never replaced automatically; quarantine/repair is not implemented."
      : "Project identity is absent; run /mazzy-init --apply to enroll this checkout." });
  }
  let ignored = false;
  if (root) { if (gitCheck(root, ["check-ignore", "-q", "--", ".mazzy/project.json"])) ignored = true; }
  checks.push({ name: "project identity ignore rule", status: ignored ? "PASS" : "WARN", hint: ignored ? "Project identity is Git-ignored." : "Project identity is not Git-ignored; protect it before copying this checkout." });
  const settings = root ? join(root, ".pi", "settings.json") : "";
  const configured = (() => { try { const value = settings ? readJson(settings) : {}; return Array.isArray(value.packages) && value.packages.includes("npm:pi-subagents@0.50.0"); } catch { return false; } })();
  checks.push({ name: "pi-subagents project package pin", status: configured ? "PASS" : "WARN", hint: configured ? "Exact project package pin is observed." : "Run /mazzy-init --apply to add the exact pi-subagents package pin." });
  const agent = root && join(root, ".pi", "agents", "mazzy-orchestrator.md"); checks.push({ name: "agent templates", status: agent && existsSync(agent) ? "PASS" : "WARN", hint: agent && existsSync(agent) ? "Required template present." : "Run /mazzy-init --apply." });
  try { if (!root) throw new Error(); validateRoutingPolicy(readJson(join(root, ".pi", "mazzy", "routing.json"))); checks.push({ name: "routing policy", status: "PASS", hint: "Routing config validates." }); } catch { checks.push({ name: "routing policy", status: "WARN", hint: "Run /mazzy-init --apply to install a valid fallback." }); }
  const activeResolution = resolveControlDb(cwd);
  if (activeResolution.sealed) {
    checks.push({ name: "canonical database", status: "FAIL", hint: "Control endpoint is sealed after cutover verification failed; no writable fallback is permitted." });
  } else try { mkdirSync(dirname(activeResolution.path), { recursive: true }); const probe = `${activeResolution.path}.mazzy-write-probe`; writeFileSync(probe, "ok", { flag: "w" }); rmSync(probe); checks.push({ name: "canonical database", status: "PASS", hint: `Effective ${activeResolution.effectiveEndpoint} database directory is writable.` }); } catch { checks.push({ name: "canonical database", status: "FAIL", hint: "Check effective database directory permissions." }); }
  const workspace = root && join(root, ".mazzy", "work");
  if (projectDirectoryStatus === "untrusted") {
    checks.push({ name: "project-local workspace", status: "FAIL", hint: "Workspace inspection is refused while .mazzy is a symlink or non-directory." });
    checks.push({ name: "storage policy", status: "FAIL", hint: "Storage policy inspection is refused while .mazzy is untrusted." });
    checks.push({ name: "workspace quotas", status: "WARN", hint: "Quota scan is skipped while .mazzy is untrusted; no files were read or deleted." });
  } else {
    try {
      if (!workspace || !CANONICAL_WORKSPACE_DIRECTORIES.every((directory) => existsSync(join(root!, ".mazzy", directory)))) throw new Error();
      const probe = join(workspace, `.mazzy-write-probe-${process.pid}`); writeFileSync(probe, "ok", { flag: "wx" }); rmSync(probe);
      checks.push({ name: "project-local workspace", status: "PASS", hint: "Canonical Mazzy workspace directories are present and writable." });
    } catch { checks.push({ name: "project-local workspace", status: "FAIL", hint: "Run /mazzy-init --apply to create the canonical project-local workspace." }); }
    try {
      if (!root) throw new Error(); loadStoragePolicy(root);
      checks.push({ name: "storage policy", status: "PASS", hint: "Versioned storage policy validates." });
    } catch { checks.push({ name: "storage policy", status: "FAIL", hint: "Run /mazzy-init --apply to install a valid Mazzy storage policy." }); }
    try {
      if (!root) throw new Error(); const quotaSummary = workspaceQuotaSummary(root); const quotas = quotaSummary.directories; const incomplete = quotas.filter((quota) => !quota.scanComplete); const exceeded = quotas.filter((quota) => quota.scanComplete && !quota.withinQuota);
      checks.push({ name: "workspace quotas", status: incomplete.length || exceeded.length ? "WARN" : "PASS", hint: incomplete.length ? `${incomplete.length} canonical workspace directory scan reached its bound; usage is unknown and no files were deleted.` : exceeded.length ? `${exceeded.length} canonical workspace quota${exceeded.length === 1 ? " is" : "s are"} exceeded; run /mazzy-clean (dry-run first).` : "Canonical workspace usage is within configured quotas." });
    } catch { checks.push({ name: "workspace quotas", status: "WARN", hint: "Quota usage could not be safely scanned; no files were deleted." }); }
  }
  const ineffectiveProjectSettings = root && existsSync(settings) ? (() => { try { const configuredSettings = readJson(settings); const subagents = configuredSettings.subagents; if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return []; return Object.keys(subagents).filter((key) => INEFFECTIVE_PROJECT_SUBAGENT_SETTINGS.has(key)); } catch { return []; } })() : [];
  checks.push({ name: "pi-subagents project settings", status: ineffectiveProjectSettings.length ? "WARN" : "PASS", hint: ineffectiveProjectSettings.length ? "Project settings contain extension-config keys that are not effective there; run /mazzy-init --apply to remove them." : "No known ineffective extension-config keys are present; projectRootResolution is the documented project-settings control. Other keys are preserved without effectiveness claims." });
  checks.push({ name: "pi-subagents runtime relocation/config", status: "WARN", hint: "Observed project package pin does not establish project-scoped or effective runtime relocation/config. Mazzy does not write user-global extension config; independently observe runtime behavior before relying on it." });
  checks.push({ name: "upstream async-status temp limitation", status: "WARN", hint: "CAVEAT: upstream async-status temporary-directory behavior is not configured by Mazzy; its exact storage path is not asserted here. Mazzy does not delete upstream temporary files." });
  checks.push({ name: "memory retention", status: "WARN", hint: "PLANNED: memory retention tiers are not implemented in this pass." });
  const packagePortability = root ? packageChecks(root) : []; checks.push(...packagePortability);
  const managed = root ? desired(root) : []; const safe = managed.every((item) => portable(item.content)) && packagePortability.every((item) => item.status === "PASS"); checks.push({ name: "portable managed output", status: safe ? "PASS" : "FAIL", hint: safe ? "Templates and target package paths are portable from the target `.pi` directory." : "Remove host-specific or stale package paths before applying." });
  checks.push({ name: "single runtime guard", status: "PASS", hint: "Mazzy delegates only through pi-subagents; no second scheduler is configured." });
  try {
    const mechanism = inspectSingleMechanism(cwd);
    const status = mechanism.status === "UNIFIED" ? "PASS" : mechanism.status === "UNRESOLVED" ? "WARN" : "FAIL";
    const hint = mechanism.status === "UNIFIED"
      ? "Single canonical control store: tracker, dashboard and tools share one mechanism; no divergent tunnels detected."
      : mechanism.status === "UNRESOLVED"
        ? "Project root is untrusted; single-mechanism status is unresolved and no host path was inferred."
        : mechanism.status === "DRIFT"
          ? "Retained non-selected endpoint contains post-promotion writes (redacted); re-apply/consolidate before cutover or delegation."
          : `${mechanism.tunnelCount} divergent control store${mechanism.tunnelCount === 1 ? "" : "s"} detected (redacted); consolidate to the canonical store to avoid split-brain backlog.`;
    checks.push({ name: "single mechanism (anti-tunnel)", status, hint });
  } catch { checks.push({ name: "single mechanism (anti-tunnel)", status: "WARN", hint: "Single-mechanism status could not be safely inspected; no store was opened." }); }
  try {
    const resolution = resolveControlDb(cwd);
    const cutoverHint: Record<typeof resolution.selection, string> = {
      "explicit-override": "An explicit MAZZY_DB/PI_OPS_DB override selects the control DB; the identity gate is bypassed by design.",
      "canonical-promoted": resolution.cutover ? "Durable or break-glass cutover is active: the verified canonical endpoint is effective." : "Canonical promotion is verified but not yet cut over; legacy remains effective.",
      "canonical-held": `A canonical control DB exists but is held back to legacy (${resolution.hold ?? "inconsistent"}); resolve the inconsistency or roll back.`,
      "git-root-legacy": "Using the legacy control DB (.pi-ops); no verified promotion is present. Run /mazzy-migrate plan to prepare the unified store.",
      "cwd-fallback": "Using a folder-local legacy control DB; project is not a trusted Git root.",
    };
    const status = resolution.sealed ? "FAIL" : resolution.selection === "canonical-held" || (resolution.selection === "canonical-promoted" && !resolution.cutover) ? "WARN" : "PASS";
    const hint = resolution.sealed ? "Cutover is active but canonical verification failed; writable legacy fallback is sealed." : cutoverHint[resolution.selection];
    checks.push({ name: `control DB cutover selection (${resolution.effectiveEndpoint})`, status, hint });
  } catch { checks.push({ name: "control DB cutover selection", status: "WARN", hint: "Cutover selection could not be safely inspected; the legacy store remains in use." }); }
  return checks;
}

export function formatPlan(result: InitResult): string { const entries = result.entries.map((entry) => `${entry.status.toUpperCase()} ${entry.path} — ${entry.reason}`); if (result.registry) entries.push(`REGISTRY ${result.registry.status.toUpperCase()} — ${result.registry.reason}`); return entries.join("\n") || "No Mazzy-managed files changed."; }