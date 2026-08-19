// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { gitCapture, gitCheck } from "./git-safe.ts";
import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readProjectIdentity } from "./project.ts";

export type RegistryLocationSource = "default-state-home" | "explicit-override";
export interface RegistryLocationDiagnostic { source: RegistryLocationSource; }
export type RegistryAssertionStatus =
  | "match" | "unregistered" | "moved" | "duplicate-project-id" | "duplicate-canonical-root"
  | "registry-invalid" | "registry-key-missing" | "registry-busy" | "registry-unavailable" | "registry-capacity";
export interface ProjectRegistrationAssertion {
  status: RegistryAssertionStatus;
  schemaVersion: 1;
  registeredAt?: string;
  sameRepository?: boolean;
  identityIgnored?: boolean;
}
export interface RegistryOptions { registryDirectory?: string; now?: string; }

interface Entry { projectId: string; rootDigest: string; fsIdDigest: string; repoDigest: string; firstSeenAt: string; lastSeenAt: string; }
interface Registry { schema: "mazzy.project-registry"; version: 1; projects: Entry[]; }
interface Key { schema: "mazzy.project-registry-key"; version: 1; salt: string; }
interface Checkout { id: string; root: string; fsId: string; repoId: string; ignored: boolean; }
type DirectoryState = { kind: "open"; fd: number } | { kind: "absent" | "invalid" | "unavailable" };
type LockState = "locked" | "busy" | "invalid" | "unavailable";

const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const MAX_BYTES = 1024 * 1024, MAX_ENTRIES = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN_ERROR = "Project registry operation failed";
const unavailable = (): ProjectRegistrationAssertion => ({ status: "registry-unavailable", schemaVersion: 1 });
const fixed = (): never => { throw new Error(DOMAIN_ERROR); };
const isLinux = (): boolean => process.platform === "linux";

function location(options: RegistryOptions = {}): { directory: string; source: RegistryLocationSource } {
  const override = options.registryDirectory ?? process.env.MAZZY_REGISTRY_DIR;
  if (override?.trim()) return { directory: resolve(override.trim()), source: "explicit-override" };
  const home = homedir();
  if (!home) fixed();
  return { directory: join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "mazzy"), source: "default-state-home" };
}
export function resolveRegistryLocationDiagnostic(options?: RegistryOptions): RegistryLocationDiagnostic {
  try { return { source: location(options).source }; }
  catch { return { source: options?.registryDirectory?.trim() || process.env.MAZZY_REGISTRY_DIR?.trim() ? "explicit-override" : "default-state-home" }; }
}
function isPrivate(stat: Stats, file: boolean): boolean {
  if ((file ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink() || (file && stat.nlink !== 1)) return false;
  return (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code; }
function safeDirectory(directory: string, create: boolean): DirectoryState {
  try {
    if (create) {
      const absolute = resolve(directory), root = parse(absolute).root, parts = absolute.slice(root.length).split(sep).filter(Boolean);
      let current = root;
      for (let index = 0; index < parts.length; index++) {
        current = join(current, parts[index]!);
        try {
          const detail = lstatSync(current), final = index === parts.length - 1;
          if (final ? !detail.isDirectory() || detail.isSymbolicLink() : !statSync(current).isDirectory()) return { kind: "invalid" };
        } catch (error) {
          if (errno(error) !== "ENOENT") return { kind: "unavailable" };
          try { mkdirSync(current, { mode: 0o700 }); }
          catch (mkdirError) { if (errno(mkdirError) !== "EEXIST") return { kind: "unavailable" }; }
        }
      }
    }
    let detail: Stats;
    try { detail = lstatSync(directory); }
    catch (error) { return errno(error) === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" }; }
    if (!isPrivate(detail, false)) return { kind: "invalid" };
    const fd = openSync(directory, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    if (!isPrivate(fstatSync(fd), false)) { closeSync(fd); return { kind: "invalid" }; }
    if (create) fchmodSync(fd, 0o700);
    return { kind: "open", fd };
  } catch { return { kind: "unavailable" }; }
}
function procPath(directoryFd: number, name: string): string { return `/proc/self/fd/${directoryFd}/${name}`; }
function readPrivate(directoryFd: number, name: string): string | undefined {
  const file = procPath(directoryFd, name);
  try {
    const detail = lstatSync(file);
    if (!isPrivate(detail, true) || detail.size > MAX_BYTES) fixed();
    const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    try { if (!isPrivate(fstatSync(fd), true)) fixed(); return readFileSync(fd, "utf8"); }
    finally { closeSync(fd); }
  } catch (error) { if (errno(error) === "ENOENT") return undefined; throw error; }
}
function iso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function parseRegistry(content: string): Registry {
  if (Buffer.byteLength(content) > MAX_BYTES) fixed();
  try {
    const value: unknown = JSON.parse(content); if (!value || typeof value !== "object" || Array.isArray(value)) fixed();
    const record = value as Record<string, unknown>, rawProjects = record.projects;
    if (Object.keys(record).sort().join(",") !== "projects,schema,version" || record.schema !== "mazzy.project-registry" || record.version !== 1 || !Array.isArray(rawProjects) || rawProjects.length > MAX_ENTRIES) return fixed();
    const projects = rawProjects.map((item: unknown): Entry => {
      if (!item || typeof item !== "object" || Array.isArray(item)) fixed(); const entry = item as Record<string, unknown>;
      if (Object.keys(entry).sort().join(",") !== "firstSeenAt,fsIdDigest,lastSeenAt,projectId,repoDigest,rootDigest" || !UUID.test(String(entry.projectId)) || ![entry.rootDigest, entry.fsIdDigest, entry.repoDigest].every((item) => typeof item === "string" && B64.test(item)) || !iso(entry.firstSeenAt) || !iso(entry.lastSeenAt)) fixed();
      return entry as unknown as Entry;
    });
    if (new Set(projects.map((entry) => entry.projectId)).size !== projects.length || new Set(projects.map((entry) => entry.rootDigest)).size !== projects.length) fixed();
    return { schema: "mazzy.project-registry", version: 1, projects };
  } catch { return fixed(); }
}
function parseKey(content: string): Key {
  if (Buffer.byteLength(content) > 4096) fixed();
  try {
    const value: unknown = JSON.parse(content); if (!value || typeof value !== "object" || Array.isArray(value)) fixed();
    const key = value as Record<string, unknown>;
    if (Object.keys(key).sort().join(",") !== "salt,schema,version" || key.schema !== "mazzy.project-registry-key" || key.version !== 1 || typeof key.salt !== "string" || !B64.test(key.salt)) fixed();
    return key as unknown as Key;
  } catch { return fixed(); }
}
function digest(salt: string, value: string): string { return createHmac("sha256", Buffer.from(salt, "base64url")).update(value).digest("base64url"); }
function checkout(cwd: string): Checkout {
  const identity = readProjectIdentity(cwd), root = identity.root;
  let common = "";
  try { common = realpathSync(resolve(root, gitCapture(root, ["rev-parse", "--git-common-dir"]))); }
  catch { fixed(); }
  let ignored = false;
  if (gitCheck(root, ["check-ignore", "-q", "--", ".mazzy/project.json"])) ignored = true;
  const rootStat = statSync(root), repoStat = statSync(common);
  return { id: identity.descriptor.projectId, root, fsId: `${rootStat.dev}:${rootStat.ino}`, repoId: `${repoStat.dev}:${repoStat.ino}`, ignored };
}
function current(value: Checkout, salt: string): Checkout & { rootDigest: string; fsIdDigest: string; repoDigest: string } {
  return { ...value, rootDigest: digest(salt, value.root), fsIdDigest: digest(salt, value.fsId), repoDigest: digest(salt, value.repoId) };
}
function classify(registry: Registry, value: ReturnType<typeof current>): ProjectRegistrationAssertion {
  const byId = registry.projects.find((entry) => entry.projectId === value.id);
  const byRoot = registry.projects.find((entry) => entry.rootDigest === value.rootDigest);
  const sameRepository = registry.projects.some((entry) => entry.projectId !== value.id && entry.repoDigest === value.repoDigest);
  const advisory = { sameRepository, identityIgnored: value.ignored };
  if (byRoot && byRoot.projectId !== value.id) return { status: "duplicate-canonical-root", schemaVersion: 1, ...advisory };
  if (!byId) return { status: "unregistered", schemaVersion: 1, ...advisory };
  if (byId.rootDigest === value.rootDigest) return { status: "match", schemaVersion: 1, registeredAt: byId.firstSeenAt, ...advisory };
  if (byId.fsIdDigest === value.fsIdDigest) return { status: "moved", schemaVersion: 1, registeredAt: byId.firstSeenAt, ...advisory };
  return { status: "duplicate-project-id", schemaVersion: 1, registeredAt: byId.firstSeenAt, ...advisory };
}
function readState(directory: string): { directory: DirectoryState; registry?: Registry; rawRegistry?: string; key?: Key } {
  const directoryState = safeDirectory(directory, false);
  if (directoryState.kind !== "open") return { directory: directoryState };
  try {
    const rawRegistry = readPrivate(directoryState.fd, "registry.json"), rawKey = readPrivate(directoryState.fd, "registry.key");
    return { directory: directoryState, rawRegistry, registry: rawRegistry === undefined ? undefined : parseRegistry(rawRegistry), key: rawKey === undefined ? undefined : parseKey(rawKey) };
  } catch (error) { closeSync(directoryState.fd); throw error; }
}
function directoryAssertion(state: DirectoryState): ProjectRegistrationAssertion {
  return state.kind === "invalid" ? { status: "registry-invalid", schemaVersion: 1 } : state.kind === "absent" ? { status: "unregistered", schemaVersion: 1 } : unavailable();
}
export function assertProjectRegistration(cwd: string, options: RegistryOptions = {}): ProjectRegistrationAssertion {
  if (!isLinux()) return unavailable();
  let directory: string;
  try { directory = location(options).directory; } catch { return unavailable(); }
  try {
    const state = readState(directory);
    if (state.directory.kind !== "open") return directoryAssertion(state.directory);
    try {
      if (!state.registry) return { status: "unregistered", schemaVersion: 1 };
      if (!state.key) return { status: "registry-key-missing", schemaVersion: 1 };
      let value: Checkout;
      try { value = checkout(cwd); } catch { return { status: "unregistered", schemaVersion: 1 }; }
      return classify(state.registry, current(value, state.key.salt));
    } finally { closeSync(state.directory.fd); }
  } catch (error) { return error instanceof Error && error.message === DOMAIN_ERROR ? { status: "registry-invalid", schemaVersion: 1 } : unavailable(); }
}
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquire(directoryFd: number): LockState {
  const lock = procPath(directoryFd, ".registry.lock"), until = Date.now() + 1000;
  while (Date.now() < until) {
    try {
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); closeSync(fd); return "locked";
    } catch (error) {
      if (errno(error) !== "EEXIST") return errno(error) === "ELOOP" ? "invalid" : "unavailable";
      try { if (!isPrivate(lstatSync(lock), true)) return "invalid"; }
      catch (statError) { if (errno(statError) === "ENOENT") continue; return "unavailable"; }
      sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  return "busy";
}
function writePrivate(directoryFd: number, name: string, content: string): void {
  const target = procPath(directoryFd, name), temp = procPath(directoryFd, `.registry.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let made = false;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); made = true;
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target); made = false;
  } finally { if (made) try { unlinkSync(temp); } catch { /* cleanup only */ } }
}
function serialise(registry: Registry): string { return `${JSON.stringify(registry)}\n`; }
function hasCapacity(registry: Registry): boolean { return registry.projects.length <= MAX_ENTRIES && Buffer.byteLength(serialise(registry)) <= MAX_BYTES; }
function persist(fd: number, previous: string | undefined, next: Registry): void {
  if (previous !== undefined) writePrivate(fd, "registry.json.bak", previous);
  writePrivate(fd, "registry.json", serialise(next));
  try { fsyncSync(fd); } catch { /* best effort */ }
}
function writeDirectoryStatus(state: DirectoryState): ProjectRegistrationAssertion {
  return state.kind === "invalid" ? { status: "registry-invalid", schemaVersion: 1 } : unavailable();
}
export function enrollProjectRegistration(cwd: string, options: RegistryOptions = {}): ProjectRegistrationAssertion {
  if (!isLinux()) return unavailable();
  let directory: string, value: Checkout;
  try { directory = location(options).directory; value = checkout(cwd); } catch { return unavailable(); }
  const opened = safeDirectory(directory, true);
  if (opened.kind !== "open") return writeDirectoryStatus(opened);
  const fd = opened.fd;
  let locked = false;
  try {
    const lock = acquire(fd);
    if (lock !== "locked") return lock === "invalid" ? { status: "registry-invalid", schemaVersion: 1 } : lock === "busy" ? { status: "registry-busy", schemaVersion: 1 } : unavailable();
    locked = true;
    const rawRegistry = readPrivate(fd, "registry.json"), rawKey = readPrivate(fd, "registry.key");
    // Validate an existing index before classifying a missing key so corruption is never downgraded.
    if (rawRegistry !== undefined && rawKey === undefined) { parseRegistry(rawRegistry); return { status: "registry-key-missing", schemaVersion: 1 }; }
    let key: Key;
    if (rawKey === undefined) { key = { schema: "mazzy.project-registry-key", version: 1, salt: randomBytes(32).toString("base64url") }; writePrivate(fd, "registry.key", `${JSON.stringify(key)}\n`); }
    else key = parseKey(rawKey);
    const previous = rawRegistry === undefined ? undefined : parseRegistry(rawRegistry), registry: Registry = previous ? { ...previous, projects: previous.projects.map((entry) => ({ ...entry })) } : { schema: "mazzy.project-registry", version: 1, projects: [] };
    const resolved = current(value, key.salt), result = classify(registry, resolved);
    if (result.status === "duplicate-project-id" || result.status === "duplicate-canonical-root") return result;
    const now = options.now ?? new Date().toISOString(); if (!iso(now)) fixed();
    const existing = registry.projects.find((entry) => entry.projectId === resolved.id);
    if (existing) { existing.rootDigest = resolved.rootDigest; existing.fsIdDigest = resolved.fsIdDigest; existing.repoDigest = resolved.repoDigest; existing.lastSeenAt = now; }
    else registry.projects.push({ projectId: resolved.id, rootDigest: resolved.rootDigest, fsIdDigest: resolved.fsIdDigest, repoDigest: resolved.repoDigest, firstSeenAt: now, lastSeenAt: now });
    if (!hasCapacity(registry)) return { status: "registry-capacity", schemaVersion: 1 };
    persist(fd, rawRegistry, registry);
    const verified = parseRegistry(readPrivate(fd, "registry.json")!);
    if (!verified.projects.some((entry) => entry.projectId === resolved.id && entry.rootDigest === resolved.rootDigest) || previous?.projects.some((entry) => entry.projectId !== resolved.id && !verified.projects.some((candidate) => candidate.projectId === entry.projectId && candidate.rootDigest === entry.rootDigest))) fixed();
    return classify(verified, resolved);
  } catch (error) { return error instanceof Error && error.message === DOMAIN_ERROR ? { status: "registry-invalid", schemaVersion: 1 } : unavailable(); }
  finally { if (locked) try { unlinkSync(procPath(fd, ".registry.lock")); } catch { /* release best effort */ } closeSync(fd); }
}
export function clearStaleProjectRegistryLock(options: RegistryOptions = {}, minimumAgeMs = 120_000): { cleared: boolean; reason: "cleared" | "absent" | "fresh" | "unavailable" } {
  if (!isLinux() || !Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1) return { cleared: false, reason: "unavailable" };
  let directory: string; try { directory = location(options).directory; } catch { return { cleared: false, reason: "unavailable" }; }
  const opened = safeDirectory(directory, false); if (opened.kind === "absent") return { cleared: false, reason: "absent" }; if (opened.kind !== "open") return { cleared: false, reason: "unavailable" };
  const fd = opened.fd, lock = procPath(fd, ".registry.lock");
  try {
    let before: Stats;
    try { before = lstatSync(lock); } catch (error) { return errno(error) === "ENOENT" ? { cleared: false, reason: "absent" } : { cleared: false, reason: "unavailable" }; }
    if (!isPrivate(before, true)) return { cleared: false, reason: "unavailable" };
    if (Date.now() - before.mtimeMs < minimumAgeMs) return { cleared: false, reason: "fresh" };
    sleep(10);
    const after = lstatSync(lock);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || !isPrivate(after, true)) return { cleared: false, reason: "fresh" };
    unlinkSync(lock); return { cleared: true, reason: "cleared" };
  } catch { return { cleared: false, reason: "unavailable" }; }
  finally { closeSync(fd); }
}

export function forgetCurrentProjectRegistration(cwd: string, options: RegistryOptions = {}): { removed: boolean } {
  try { return forgetProjectRegistration(readProjectIdentity(cwd).descriptor.projectId, options); }
  catch { return { removed: false }; }
}

export function forgetProjectRegistration(projectId: string, options: RegistryOptions = {}): { removed: boolean } {
  if (!UUID.test(projectId)) return fixed();
  if (!isLinux()) return { removed: false };
  let directory: string;
  try { directory = location(options).directory; } catch { return { removed: false }; }
  const opened = safeDirectory(directory, false);
  if (opened.kind === "absent" || opened.kind === "unavailable") return { removed: false };
  if (opened.kind !== "open") return fixed();
  const fd = opened.fd;
  let locked = false;
  try {
    const lock = acquire(fd); if (lock !== "locked") return lock === "busy" ? { removed: false } : fixed();
    locked = true;
    const raw = readPrivate(fd, "registry.json"), rawKey = readPrivate(fd, "registry.key");
    if (!raw || !rawKey) return { removed: false };
    parseKey(rawKey); const registry = parseRegistry(raw), projects = registry.projects.filter((entry) => entry.projectId !== projectId);
    if (projects.length === registry.projects.length) return { removed: false };
    const next = { ...registry, projects }; if (!hasCapacity(next)) return fixed();
    persist(fd, raw, next); return { removed: true };
  } catch { return fixed(); }
  finally { if (locked) try { unlinkSync(procPath(fd, ".registry.lock")); } catch { /* release */ } closeSync(fd); }
}