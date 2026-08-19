// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveLegacyOpsDbPath, resolveOpsDbPathDiagnostic, resolveTrustedProjectRoot } from "./project.ts";
import { resolveControlDb } from "./control-resolve.ts";
import { sameFile } from "./control-endpoint.ts";
import { verifyControlDrift, type ControlDriftReport } from "./control-migrate.ts";

/**
 * Anti-tunnel service and single-mechanism gate.
 *
 * A "tunnel" is any parallel or divergent control-plane store (a stray
 * `.pi-ops/state.db` or `.mazzy/control/state.db` outside the canonical
 * resolution) that could split the backlog/tracker across two databases and
 * cause duplicated, diverging functionality. This module is a READ-ONLY,
 * pure projection over the filesystem: it never opens the writable store,
 * never changes DB selection, never spawns, and never lets a host path cross
 * its boundary (INV-3). Callers receive only relative, redacted digests.
 */

export type SingleMechanismStatus = "UNIFIED" | "TUNNELS_DETECTED" | "DRIFT" | "UNRESOLVED";

/** A discovered control-plane store, identified only by a redacted relative digest. */
export interface TunnelCandidate {
  /** Stable digest of the store's path relative to the project root. Never the raw path. */
  relDigest: string;
  /** Depth below the project root; 0 means directly under the canonical location. */
  depth: number;
  /** Which store family this candidate belongs to. */
  family: "legacy-pi-ops" | "mazzy-control";
  /** True only for the single store the resolver actually selects. */
  canonical: boolean;
  /** True for the legacy source deliberately retained after a verified promotion (expected, not a tunnel). */
  retained?: boolean;
}

export interface SingleMechanismReport {
  schemaVersion: 1;
  status: SingleMechanismStatus;
  resolution: "explicit-override" | "canonical-promoted" | "canonical-held" | "git-root-legacy" | "cwd-fallback";
  /** Digest of the canonical store the tracker + dashboard + tools all open. */
  canonicalDigest: string | null;
  /** Every store found under the root, including the canonical one. */
  candidates: TunnelCandidate[];
  /** Count of non-canonical stores (the tunnels the gate blocks on). */
  tunnelCount: number;
  /** True when exactly one store exists and it is the canonical one. */
  unified: boolean;
  /** Independent read-only comparison of retained endpoints when promoted. */
  drift?: ControlDriftReport;
}

const MAX_ENTRIES = 4096;
const MAX_DEPTH = 10;
const MAX_CANDIDATES = 128;

function redactRelative(root: string, candidate: string): string {
  const rel = relative(root, candidate);
  // Only a digest of the *relative* path leaves this module; the absolute host
  // path never crosses the boundary.
  return createHash("sha256").update(rel.split(sep).join("/")).digest("hex").slice(0, 16);
}

/** Bounded, symlink-safe scan for both legacy and canonical store families. */
function scanStores(root: string): Array<{ path: string; depth: number; family: TunnelCandidate["family"] }> {
  const found: Array<{ path: string; depth: number; family: TunnelCandidate["family"] }> = [];
  let entries = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH || entries >= MAX_ENTRIES || found.length >= MAX_CANDIDATES) return;
    let children: Dirent[];
    try { children = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (entries++ >= MAX_ENTRIES || found.length >= MAX_CANDIDATES) return;
      if (child.isSymbolicLink()) continue;
      const candidate = join(directory, child.name);
      if (child.isDirectory()) {
        if (child.name !== ".git" && child.name !== "node_modules") visit(candidate, depth + 1);
      } else if (child.isFile() && child.name === "state.db") {
        try {
          if (!lstatSync(directory).isDirectory()) continue;
        } catch { continue; }
        if (directory.endsWith(`.pi-ops`)) found.push({ path: candidate, depth, family: "legacy-pi-ops" });
        else if (directory.endsWith(join(".mazzy", "control"))) found.push({ path: candidate, depth, family: "mazzy-control" });
      }
    }
  };
  visit(root, 0);
  return found;
}


/**
 * Produce the single-mechanism gate report. Pure over filesystem state; safe to
 * call from a read path. Returns UNRESOLVED when the project root cannot be
 * trusted (no host path is inferred or leaked in that case).
 */
export function inspectSingleMechanism(cwd: string): SingleMechanismReport {
  const root = resolveTrustedProjectRoot(cwd);
  if (!root) {
    return { schemaVersion: 1, status: "UNRESOLVED", resolution: resolveOpsDbPathDiagnostic(cwd).source, canonicalDigest: null, candidates: [], tunnelCount: 0, unified: false };
  }
  // Use the SAME resolver the running store uses, so "canonical" here is the DB
  // actually opened by tools+dashboard+web — not the legacy-only path.
  const resolved = resolveControlDb(cwd);
  const resolution = resolved.selection;
  const canonicalPath = resolved.path;
  const canonicalDigest = redactRelative(root, canonicalPath);
  // On a verified promotion BOTH the legacy .pi-ops store and the canonical
  // .mazzy/control store are EXPECTED (not tunnels) regardless of which one the
  // resolver currently selects: with cutover off it selects legacy while the
  // promoted .mazzy/control sits pending; with cutover on it selects canonical
  // while legacy is the retained rollback source. Whichever is not the selected
  // canonical is marked retained so neither is miscounted as a tunnel.
  const promoted = resolution === "canonical-promoted";
  const legacyPath = promoted ? resolveLegacyOpsDbPath(cwd) : undefined;
  const promotedCanonicalPath = promoted ? join(root, ".mazzy", "control", "state.db") : undefined;
  const stores = scanStores(root);
  const candidates: TunnelCandidate[] = stores.map((store) => {
    const canonical = sameFile(store.path, canonicalPath);
    const retained = !canonical && promoted && (
      (legacyPath !== undefined && sameFile(store.path, legacyPath)) ||
      (promotedCanonicalPath !== undefined && sameFile(store.path, promotedCanonicalPath))
    );
    return { relDigest: redactRelative(root, store.path), depth: store.depth, family: store.family, canonical, retained };
  });
  // Guarantee the canonical store appears even if the scan missed it (e.g. not yet created).
  if (!candidates.some((candidate) => candidate.canonical)) {
    candidates.push({ relDigest: canonicalDigest, depth: 0, family: resolution === "canonical-promoted" ? "mazzy-control" : "legacy-pi-ops", canonical: true });
  }
  // A tunnel is any store that is neither the canonical one nor the expected retained legacy.
  const tunnelCount = candidates.filter((candidate) => !candidate.canonical && !candidate.retained).length;
  const unified = tunnelCount === 0;
  const drift = promoted ? verifyControlDrift(cwd, resolved.effectiveEndpoint) : undefined;
  return {
    schemaVersion: 1,
    status: drift?.drift ? "DRIFT" : unified ? "UNIFIED" : "TUNNELS_DETECTED",
    resolution,
    canonicalDigest,
    candidates,
    tunnelCount,
    unified: unified && !drift?.drift,
    ...(drift ? { drift } : {}),
  };
}

/**
 * The gate: returns true only when the tracker runs on a single canonical
 * mechanism with no divergent tunnels. UNRESOLVED never passes.
 */
export function singleMechanismGate(cwd: string): { pass: boolean; report: SingleMechanismReport } {
  const report = inspectSingleMechanism(cwd);
  return { pass: report.status === "UNIFIED", report };
}

/**
 * Orchestrator-level directive derived from the single-mechanism gate. The
 * orchestrator consults this BEFORE delegating so it can redirect work to
 * consolidation instead of spawning against a split-brain backlog.
 */
export type OrchestrationDirective = "proceed" | "redirect-consolidation" | "hold-unresolved";

export interface OrchestrationGate {
  /** True when it is safe to delegate normal work. */
  clear: boolean;
  /** What the orchestrator should do next. */
  directive: OrchestrationDirective;
  /** Human-facing, path-redacted reason. */
  reason: string;
  /** The underlying single-mechanism report. */
  mechanism: SingleMechanismReport;
}

/**
 * Compute the orchestration gate directive. Pure/read-only; never spawns or
 * mutates. On TUNNELS_DETECTED the orchestrator should redirect to a
 * consolidation task rather than run against a divergent store.
 */
export function orchestrationGate(cwd: string): OrchestrationGate {
  const mechanism = inspectSingleMechanism(cwd);
  if (mechanism.status === "UNIFIED") {
    return { clear: true, directive: "proceed", reason: "Single canonical control mechanism; safe to delegate.", mechanism };
  }
  if (mechanism.status === "UNRESOLVED") {
    return { clear: false, directive: "hold-unresolved", reason: "Project root is untrusted; single-mechanism status is unresolved. Hold delegation until a trusted project root is established.", mechanism };
  }
  if (mechanism.status === "DRIFT") {
    return { clear: false, directive: "redirect-consolidation", reason: "Retained endpoint contains writes newer than promotion (redacted); consolidate before delegating.", mechanism };
  }
  return {
    clear: false,
    directive: "redirect-consolidation",
    reason: `${mechanism.tunnelCount} divergent control store${mechanism.tunnelCount === 1 ? "" : "s"} detected (redacted). Redirect to canonical-store consolidation before delegating new work to avoid split-brain backlog.`,
    mechanism,
  };
}