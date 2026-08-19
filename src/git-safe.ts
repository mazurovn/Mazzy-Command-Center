// Mazzy Command Center
// Copyright (c) 2026 Mazurov N.N. (https://github.com/mazurovn)
// Proprietary source-available license — no modification or redistribution
// without prior written permission. See LICENSE.

import { execFileSync } from "node:child_process";

/**
 * git-safe.ts — the ONLY sanctioned way to invoke `git` anywhere in Mazzy.
 *
 * Security: a literal-argv `execFileSync("git", …)` is NOT safe by itself.
 * `git` executes repository-supplied code
 * and honors inherited environment on an otherwise-innocent invocation:
 *   - repo config `core.hooksPath` / `core.fsmonitor` / `core.pager` /
 *     `core.editor` / `include.path` runs an attacker's binary from a cloned or
 *     untrusted working tree even with a 100%-literal argv;
 *   - inherited `GIT_*` (`GIT_DIR`, `GIT_CONFIG*`, `GIT_SSH_COMMAND`, …),
 *     `LD_PRELOAD`, `NODE_OPTIONS`, and a writable `PATH` entry redirect what
 *     "git" is and does;
 *   - a pathspec beginning with `-` becomes an option without a `--` separator.
 *
 * This module neutralizes all of that centrally. Every git call site MUST route
 * through `gitCapture` / `gitCheck`; the execution-boundary test forbids a raw
 * `execFileSync("git", …)` anywhere else.
 */

// Top-level `git -c key=val` overrides applied to EVERY invocation. These run
// before the subcommand and defeat repository-supplied code-execution config.
const GIT_HARDENING: readonly string[] = [
  "-c", "core.hooksPath=/dev/null", // no repo-defined hooks execute
  "-c", "core.fsmonitor=false",     // no fsmonitor helper process is spawned
  "-c", "core.pager=cat",           // no pager subprocess
  "-c", "core.editor=false",        // no editor subprocess
  "-c", "protocol.ext.allow=never", // no ext:: transport helper execution
];

/**
 * A minimal, sanitized environment. We drop every inherited `GIT_*` and
 * injection vector (`LD_PRELOAD`, `NODE_OPTIONS`, …) by constructing the env
 * from scratch, and force git to ignore system + global config regardless of
 * `HOME`, so a user/global `.gitconfig` cannot smuggle a hook/pager/editor.
 */
function safeGitEnv(): NodeJS.ProcessEnv {
  return {
    // git must be resolvable; keep the inherited PATH but nothing else volatile.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",     // ignore /etc/gitconfig
    GIT_CONFIG_GLOBAL: "/dev/null", // ignore ~/.gitconfig regardless of HOME
    GIT_TERMINAL_PROMPT: "0",     // never block on a credential prompt
    GIT_OPTIONAL_LOCKS: "0",      // read-only calls take no locks
    LANG: "C",
    LC_ALL: "C",
  };
}

/** Reject anything that is not a plain, non-option directory path. */
function assertSafeCwd(cwd: string): void {
  if (typeof cwd !== "string" || cwd.length === 0) throw new Error("git cwd must be a non-empty path");
  if (cwd.startsWith("-")) throw new Error("git cwd must not begin with '-'");
  if (cwd.includes("\0")) throw new Error("git cwd must not contain a NUL byte");
}

/**
 * Run a read-only git subcommand in `cwd` and return trimmed stdout. `args` is
 * the subcommand and its flags only (e.g. ["rev-parse","--show-toplevel"]); the
 * hardening flags and `-C cwd` are prepended here. Throws on non-zero exit.
 */
export function gitCapture(cwd: string, args: readonly string[]): string {
  assertSafeCwd(cwd);
  return execFileSync("git", [...GIT_HARDENING, "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: safeGitEnv(),
  }).trim();
}

/**
 * Run a git subcommand purely for its exit status (e.g. `check-ignore -q`).
 * Returns true on exit 0, false on any non-zero exit or error. Callers that
 * pass a pathspec MUST place it after a literal "--" in `args`.
 */
export function gitCheck(cwd: string, args: readonly string[]): boolean {
  assertSafeCwd(cwd);
  try {
    execFileSync("git", [...GIT_HARDENING, "-C", cwd, ...args], {
      stdio: "ignore",
      env: safeGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}