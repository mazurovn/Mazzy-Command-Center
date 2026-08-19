// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * reverse-graph.ts — code<->spec connectivity engine.
 *
 * Reverse-engineers the connectivity graph of the codebase and binds every node
 * to the specification (ADR/INV/FR clauses) by scanning identifiers and their
 * governing spec references. Pure/read-only: it reads files and returns a
 * structure; it performs no edits and no process execution. Used by the graph
 * view's code<->spec source.
 */

export type NodeKind = "symbol" | "file" | "spec";
export type Action = "rename" | "carve_out" | "prose" | "ignore";

export interface RgHit {
  file: string;      // repo-relative path
  line: number;      // 1-indexed
  text: string;      // the matched line, trimmed
  identifier: string;
  action: Action;
  renamesTo?: string;
  specRefs: string[]; // governing clauses cited on/near this line
  reason?: string;
}

export interface RenameRule {
  /** exact identifier (word-ish) to find */
  old: string;
  /** replacement */
  next: string;
  /** governing spec clause(s) */
  governs: string[];
  /** kind for reporting */
  kind: string;
}

export interface CarveOut {
  /** substring/identifier that must NOT be renamed */
  pattern: string;
  governs: string[];
  reason: string;
}

export interface RgFindings {
  hubs: Array<{ identifier: string; refs: number }>;
  orphans: string[];              // rename symbols with zero references found
  specCoverage: Array<{ clause: string; realizingNodes: number }>;
  coverageGaps: string[];         // clauses with zero realizing nodes
  unclassified: RgHit[];          // hits that matched no rule and no carve-out
}

export interface RgGraph {
  root: string;
  scanned: string[];
  hits: RgHit[];
  rules: RenameRule[];
  carveOuts: CarveOut[];
  findings: RgFindings;
  /** residual old identifiers still present AFTER a hypothetical/real apply. */
  residualOld: string[];
  /** RGRA-INV: residualOld must equal the carve-out identifier set exactly. */
  closedFrontier: boolean;
}

/** Single source of truth for spec-clause identifiers (shared with graph sources). */
export const SPEC_RE = /\b(ADR-\d+|INV-\d+['\u2032]?|FR-[A-Z]*\d+|US-\d+|NFR-[A-Z]+-\d+|P\d+|R\d+)\b/g;

/** Extract the distinct spec-clause identifiers cited in a text (order-stable). */
export function specRefsIn(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(SPEC_RE)) set.add(m[1]);
  return [...set];
}

const DEFAULT_EXCLUDE = new Set(["node_modules", ".git", ".mazzy", "dist", "coverage", "scripts", "package-lock.json"]);

/** Recursively list files under root with an allowed extension. */
export function listSource(root: string, exts = [".ts", ".js", ".html", ".md", ".json"]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (DEFAULT_EXCLUDE.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (exts.some((e) => entry.endsWith(e))) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Extract every spec identifier present in a text corpus (for spec->code binding). */
export function extractSpecClauses(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(SPEC_RE)) set.add(m[1]);
  return set;
}

function specRefsOnLine(line: string): string[] {
  const refs = new Set<string>();
  for (const m of line.matchAll(SPEC_RE)) refs.add(m[1]);
  return [...refs];
}

/**
 * Build the reverse graph. `applyView` controls the residual check:
 * - "before": count old identifiers as they are now (pre-apply planning view).
 * - "after": caller has already applied renames; residual should be carve-outs only.
 */
export function buildReverseGraph(
  root: string,
  rules: RenameRule[],
  carveOuts: CarveOut[],
  files?: string[],
): RgGraph {
  const scanned = (files ?? listSource(root)).sort();
  const hits: RgHit[] = [];
  const refCount = new Map<string, number>();
  const carvePatterns = carveOuts.map((c) => c.pattern);

  for (const file of scanned) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((raw, i) => {
      const line = raw;
      for (const rule of rules) {
        // word-ish match: identifier not part of a longer identifier
        const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(rule.old)}(?![A-Za-z0-9_])`, "g");
        if (!re.test(line)) continue;
        // Is this occurrence actually inside a carve-out token? (e.g. ".pi-ops")
        const carved = carvePatterns.find((p) => line.includes(p) && p.includes(rule.old));
        refCount.set(rule.old, (refCount.get(rule.old) ?? 0) + 1);
        hits.push({
          file: rel, line: i + 1, text: line.trim(), identifier: rule.old,
          action: carved ? "carve_out" : "rename",
          renamesTo: carved ? undefined : rule.next,
          specRefs: [...new Set([...rule.governs, ...specRefsOnLine(line)])],
          reason: carved ? `inside carve-out ${carved}` : undefined,
        });
      }
    });
  }

  // Findings
  const hubs = [...refCount.entries()].map(([identifier, refs]) => ({ identifier, refs }))
    .sort((a, b) => b.refs - a.refs).slice(0, 15);
  const orphans = rules.filter((r) => !(refCount.get(r.old))).map((r) => r.old);

  // spec -> code coverage: which governing clauses are realized by >=1 hit
  const clauseHitCount = new Map<string, number>();
  for (const h of hits) for (const c of h.specRefs) clauseHitCount.set(c, (clauseHitCount.get(c) ?? 0) + 1);
  const governedClauses = new Set<string>();
  for (const r of rules) for (const c of r.governs) governedClauses.add(c);
  for (const c of carveOuts) for (const cl of c.governs) governedClauses.add(cl);
  const specCoverage = [...governedClauses].sort().map((clause) => ({ clause, realizingNodes: clauseHitCount.get(clause) ?? 0 }));
  const coverageGaps = specCoverage.filter((s) => s.realizingNodes === 0).map((s) => s.clause);

  const unclassified: RgHit[] = []; // reserved: hits a rule matched but couldn't classify

  // Reverse oracle (before-apply simulation): apply every rename in-memory and
  // recount old identifiers. What survives must be ONLY occurrences protected by a
  // carve-out (e.g. `MazzyTask` never appears inside `.pi-ops`, but `pi-ops-` inside
  // `pi-ops-control-ui-v1` does). residualOld lists any old identifier that would
  // STILL appear after a clean apply and is NOT explained by a carve-out.
  const residualOld: string[] = [];
  for (const file of scanned) {
    const rel = relative(root, file);
    if (!hits.some((h) => h.file === rel)) continue;
    let text = readFileSync(file, "utf8");
    // Apply renames longest-first to avoid a short id rewriting inside a long one.
    for (const rule of [...rules].sort((a, b) => b.old.length - a.old.length)) {
      text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(rule.old)}(?![A-Za-z0-9_])`, "g"), rule.next);
    }
    for (const rule of rules) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(rule.old)}(?![A-Za-z0-9_])`, "g");
      for (const m of text.matchAll(re)) {
        // Is this surviving occurrence inside a carve-out token on its line?
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        const lineEnd = text.indexOf("\n", m.index); const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        const carved = carveOuts.find((c) => c.pattern.includes(rule.old) && line.includes(c.pattern));
        if (!carved) residualOld.push(`${rel}:${rule.old}`);
      }
    }
  }
  const closedFrontier = residualOld.length === 0;

  return { root, scanned: scanned.map((f) => relative(root, f)), hits, rules, carveOuts,
    findings: { hubs, orphans, specCoverage, coverageGaps, unclassified }, residualOld, closedFrontier };
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }