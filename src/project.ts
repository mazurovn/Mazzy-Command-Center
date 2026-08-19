import { gitCapture } from "./git-safe.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type MazzyDbResolutionSource = "explicit-override" | "git-root-legacy" | "cwd-fallback";
/** Safe for public diagnostics: it deliberately contains no path or override value. */
export interface MazzyDbPathDiagnostic { source: MazzyDbResolutionSource; }

interface MazzyDbPathResolution { path: string; diagnostic: MazzyDbPathDiagnostic; }

export interface MazzyProjectDescriptor {
  schemaVersion: 1;
  projectId: string;
  createdAt: string;
}

export interface MazzyProjectIdentity {
  /** Canonical path is parent-only and must never cross the HTTP boundary. */
  root: string;
  descriptor: MazzyProjectDescriptor;
}

export type MazzyProjectDirectoryStatus = "missing" | "trusted" | "untrusted";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DESCRIPTOR_BYTES = 4096;
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export function resolveTrustedProjectRoot(cwd: string): string | undefined {
  try {
    const root = gitCapture(cwd, ["rev-parse", "--show-toplevel"]);
    return root ? realpathSync(root) : undefined;
  } catch { return undefined; }
}

function descriptorPath(root: string): string { return join(root, ".mazzy", "project.json"); }
function directoryStatus(root: string): MazzyProjectDirectoryStatus {
  const directory = dirname(descriptorPath(root));
  try {
    const metadata = lstatSync(directory);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && realpathSync(directory) === join(root, ".mazzy")
      ? "trusted" : "untrusted";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "untrusted";
  }
}
export function inspectMazzyProjectDirectory(cwd: string): MazzyProjectDirectoryStatus {
  const root = resolveTrustedProjectRoot(cwd);
  return root ? directoryStatus(root) : "untrusted";
}
function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Project identity path escapes the trusted project root");
  }
}
function parseDescriptor(content: string): MazzyProjectDescriptor {
  if (Buffer.byteLength(content) > MAX_DESCRIPTOR_BYTES) throw new Error("Project identity descriptor is too large");
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch { throw new Error("Invalid Mazzy project identity descriptor"); }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,projectId,schemaVersion"
      || value.schemaVersion !== 1 || typeof value.projectId !== "string" || !PROJECT_ID.test(value.projectId)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error("Invalid Mazzy project identity descriptor");
  }
  return { schemaVersion: 1, projectId: value.projectId, createdAt: value.createdAt };
}

/** Read and validate an existing descriptor without creating or migrating anything. */
export function readProjectIdentity(cwd: string, expectedProjectId?: string): MazzyProjectIdentity {
  const root = resolveTrustedProjectRoot(cwd);
  if (!root) throw new Error("Trusted Git project is required");
  if (directoryStatus(root) !== "trusted") {
    throw new Error("Mazzy project directory must be a real directory inside the trusted project");
  }
  const path = descriptorPath(root);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Project identity must be a regular file");
  assertInside(root, realpathSync(path));
  // O_NOFOLLOW is unavailable on some platforms. The lstat/fstat checks remain
  // fail-closed for ordinary substitution; POSIX additionally closes the final-link race.
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_DESCRIPTOR_BYTES) throw new Error("Invalid Mazzy project identity descriptor");
    const descriptor = parseDescriptor(readFileSync(fd, "utf8"));
    if (expectedProjectId !== undefined && descriptor.projectId !== expectedProjectId) {
      throw new Error("Project identity mismatch");
    }
    return { root, descriptor };
  } finally { closeSync(fd); }
}

/**
 * Enroll one immutable opaque identity. Exclusive hard-link publication prevents
 * two concurrent initializers from replacing each other's descriptor.
 */
export function ensureProjectIdentity(cwd: string): MazzyProjectIdentity {
  const root = resolveTrustedProjectRoot(cwd);
  if (!root) throw new Error("Trusted Git project is required");
  const directory = dirname(descriptorPath(root));
  const initialStatus = directoryStatus(root);
  if (initialStatus === "untrusted") throw new Error("Mazzy project directory must be a real directory inside the trusted project");
  if (initialStatus === "missing") mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryStatus(root) !== "trusted") throw new Error("Mazzy project directory must be a real directory inside the trusted project");
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  if (existsSync(descriptorPath(root))) return readProjectIdentity(root);
  const descriptor: MazzyProjectDescriptor = {
    schemaVersion: 1, projectId: randomUUID(), createdAt: new Date().toISOString(),
  };
  const temporary = join(directory, `.project.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(temporary, descriptorPath(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("Filesystem does not support atomic Mazzy project identity enrollment", { cause: error });
    }
  } finally { try { unlinkSync(temporary); } catch { /* Never mask publication outcome. */ } }
  if (typeof constants.O_DIRECTORY === "number") {
    try {
      const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch { /* Directory fsync is a durability enhancement and is not portable. */ }
  }
  return readProjectIdentity(root);
}

/** Fail-closed parent seam for future project-scoped store/API opening. */
export function openProjectIdentity(cwd: string, expectedProjectId: string): MazzyProjectIdentity {
  if (!PROJECT_ID.test(expectedProjectId)) throw new Error("Invalid expected project identity");
  return readProjectIdentity(cwd, expectedProjectId);
}

/** DB override env, honoring the legacy PI_OPS_DB during the rename transition. A blank/whitespace canonical override is treated as unset so it cannot mask a populated legacy value. */
function dbOverrideEnv(): string | undefined { const canonical = process.env.MAZZY_DB?.trim(); if (canonical) return process.env.MAZZY_DB; const legacy = process.env.PI_OPS_DB?.trim(); return legacy ? process.env.PI_OPS_DB : undefined; }
function resolveOpsDbPathResult(cwd: string, explicitOverride = dbOverrideEnv()): MazzyDbPathResolution {
  if (explicitOverride?.trim()) return { path: resolve(cwd, explicitOverride.trim()), diagnostic: { source: "explicit-override" } };
  try {
    const root = gitCapture(cwd, ["rev-parse", "--show-toplevel"]);
    if (root) return { path: resolve(root, ".pi-ops", "state.db"), diagnostic: { source: "git-root-legacy" } };
  } catch {
    // A non-repository directory has no project root; retain a local, deterministic fallback.
  }
  return { path: resolve(cwd, ".pi-ops", "state.db"), diagnostic: { source: "cwd-fallback" } };
}

/**
 * Resolves one control DB per Git worktree, irrespective of whether Pi starts at
 * the repository root or a nested package directory. PI_OPS_DB is deliberately
 * an explicit escape hatch for isolated tests and operator-selected databases.
 */
export function resolveOpsDbPath(cwd: string, explicitOverride = dbOverrideEnv()): string {
  return resolveOpsDbPathResult(cwd, explicitOverride).path;
}

/**
 * Resolves the LEGACY control DB path explicitly, never consulting any
 * canonical/cutover activation state. This is the stable seam the migration
 * source and the "legacy" probe field must use so that a future identity-gated
 * resolver flip can never make migration self-referential (source == target)
 * or mislabel the canonical store as "legacy". Behaviour today is identical to
 * resolveOpsDbPath; it is intentionally kept separate so the two meanings can
 * never be conflated later.
 */
export function resolveLegacyOpsDbPath(cwd: string, explicitOverride = dbOverrideEnv()): string {
  return resolveOpsDbPathResult(cwd, explicitOverride).path;
}

/** Returns only the selected resolution source; no host path or override value is exposed. */
export function resolveOpsDbPathDiagnostic(cwd: string, explicitOverride = dbOverrideEnv()): MazzyDbPathDiagnostic {
  return resolveOpsDbPathResult(cwd, explicitOverride).diagnostic;
}

/**
 * The legacy control DB path derived PURELY from the trusted Git root, with NO
 * environment override consulted. This is the only safe source for a migration:
 * A prior security review showed that deriving the migration source from
 * MAZZY_DB/PI_OPS_DB lets an operator point project B at project A's DB and
 * launder A's tasks/DONE/PASS + identity into B. A mutating data-movement op
 * must use THIS, never resolveLegacyOpsDbPath (which honors the override).
 * Returns undefined for a non-trusted (non-Git) root so the caller fails closed.
 */
export function legacyStorePathStrict(cwd: string): string | undefined {
  const root = resolveTrustedProjectRoot(cwd);
  return root ? resolve(root, ".pi-ops", "state.db") : undefined;
}

/** True when any control-DB override env (MAZZY_DB/PI_OPS_DB) is currently set. */
export function controlDbOverrideActive(): boolean { return dbOverrideEnv() !== undefined; }

/**
 * A path-free digest of the trusted root's filesystem identity (dev:ino), salted
 * by the project id. A cp -r copy of an enrolled checkout has a different root
 * inode, so this digest differs even though the copied project.json keeps the
 * same projectId — this is the platform-independent F8 (copied-checkout) detector.
 * Returns undefined for a non-trusted root or when identity is unavailable.
 * No raw inode, device number, or host path ever leaves this function.
 */
export function rootFsDigest(cwd: string): string | undefined {
  const root = resolveTrustedProjectRoot(cwd);
  if (!root) return undefined;
  try {
    const stat = lstatSync(root);
    const projectId = readProjectIdentity(root).descriptor.projectId;
    return createHash("sha256").update(`${projectId}\0${stat.dev}:${stat.ino}`).digest("hex").slice(0, 32);
  } catch { return undefined; }
}
