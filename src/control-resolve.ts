// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import {
  inspectMazzyProjectDirectory, resolveLegacyOpsDbPath, rootFsDigest,
  resolveOpsDbPathDiagnostic, resolveTrustedProjectRoot,
} from "./project.ts";
import {
  canonicalStorePath, cutoverDamaged, durableCutoverObserved, isInactive, isPromoted, journalPath, readJournal,
  realFile, trustedControlDir, verifyCanonicalIdentity,
} from "./control-endpoint.ts";

/** Identity-gated, read-only, total control DB resolver. */
export type ControlDbSelection =
  | "explicit-override"
  | "canonical-promoted"
  | "canonical-held"
  | "git-root-legacy"
  | "cwd-fallback";

export type ControlDbHold = "invalid-journal" | "identity" | "target-absent" | "untrusted" | "duplicate-identity";
export type EffectiveEndpoint = "canonical" | "legacy" | "override";

export interface ControlDbResolution {
  /** Internal filesystem path used solely to open the store. */
  path: string;
  /** Redacted diagnostic enum. */
  selection: ControlDbSelection;
  /** Actual effective endpoint; unlike selection this distinguishes pending promotion. */
  effectiveEndpoint: EffectiveEndpoint;
  /** True only when the returned path is the verified canonical endpoint. */
  cutover: boolean;
  /** A cutover was requested/recorded but a safe writable endpoint is unavailable. */
  sealed: boolean;
  /** Why canonical was held back. */
  hold?: ControlDbHold;
}

/** MAZZY_CUTOVER remains a break-glass activation for a single process. */
function envCutoverEnabled(): boolean { return process.env.MAZZY_CUTOVER?.trim() === "1"; }

function legacy(path: string, selection: ControlDbSelection, sealed: boolean, hold?: ControlDbHold): ControlDbResolution {
  return { path, selection, effectiveEndpoint: "legacy", cutover: false, sealed, ...(hold ? { hold } : {}) };
}

/**
 * Resolve without mutation. A durable journal `cutover` state activates canonical
 * across processes; MAZZY_CUTOVER=1 is intentionally only a break-glass override.
 * If activation is in effect and verification subsequently fails, `sealed` prevents
 * callers from silently reopening writable legacy.
 */
export function resolveControlDb(cwd: string): ControlDbResolution {
  const legacyPath = resolveLegacyOpsDbPath(cwd);
  const envCutover = envCutoverEnabled();
  const root = resolveTrustedProjectRoot(cwd);
  // Observe affirmative activation separately from damage before honoring an
  // override or evaluating .mazzy trust. Invalid publication evidence always
  // seals; a first-migration journal/structure fault seals only when cutover was
  // affirmatively requested (or this process enabled break-glass).
  const durableCutover = root ? durableCutoverObserved(root) : false;
  const damaged = root ? cutoverDamaged(root, envCutover) : false;
  const activation = envCutover || durableCutover;
  const overrideActive = resolveOpsDbPathDiagnostic(cwd).source === "explicit-override";
  // Preserve the selected override for diagnostics even while a damaged cutover
  // seal prevents any write. This does not make the override authoritative.
  if (damaged && overrideActive) {
    return { path: legacyPath, selection: "explicit-override", effectiveEndpoint: "override", cutover: activation, sealed: true, hold: "untrusted" };
  }
  if (damaged) return legacy(legacyPath, "git-root-legacy", true, "untrusted");
  if (overrideActive) {
    return { path: legacyPath, selection: "explicit-override", effectiveEndpoint: "override", cutover: activation, sealed: activation, ...(activation ? { hold: "untrusted" as const } : {}) };
  }
  if (!root) return legacy(legacyPath, "cwd-fallback", envCutover, envCutover ? "untrusted" : undefined);
  if (inspectMazzyProjectDirectory(root) !== "trusted") return legacy(legacyPath, "git-root-legacy", activation, activation ? "untrusted" : undefined);
  if (!trustedControlDir(root)) return legacy(legacyPath, "git-root-legacy", activation, activation ? "untrusted" : undefined);
  const target = canonicalStorePath(root);
  const journal = readJournal(journalPath(root));
  if (isInactive(journal)) return legacy(legacyPath, "git-root-legacy", activation, activation ? "invalid-journal" : undefined);
  if (!isPromoted(journal)) return legacy(legacyPath, "canonical-held", activation, "invalid-journal");
  if (!realFile(target)) return legacy(legacyPath, "canonical-held", activation, "target-absent");
  const identity = verifyCanonicalIdentity(target, root, rootFsDigest(cwd) ?? "");
  if (identity === "fs-mismatch") return legacy(legacyPath, "canonical-held", activation, "duplicate-identity");
  if (identity === "fs-absent" || identity !== "match") return legacy(legacyPath, "canonical-held", activation, "identity");
  if (activation) return { path: target, selection: "canonical-promoted", effectiveEndpoint: "canonical", cutover: true, sealed: false };
  return legacy(legacyPath, "canonical-promoted", false);
}

export function resolveControlDbPath(cwd: string): string { return resolveControlDb(cwd).path; }
export function canonicalStorePathOf(root: string): string { return canonicalStorePath(root); }