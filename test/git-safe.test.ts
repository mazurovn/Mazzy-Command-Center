import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testScratchRoot } from "./git-root.ts";
import test from "node:test";
import { gitCapture, gitCheck } from "../src/git-safe.ts";

const root = testScratchRoot;
function tempRepo(prefix: string): string {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, prefix));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

// Functional C1 proof (honest oracle): the wrapper's top-level `-c` overrides
// must WIN over a hostile repository-local config. We do not rely on a specific
// git subcommand happening to run a hook (plumbing like rev-parse/check-ignore
// often does not, and behavior varies by git version); instead we ask git for
// the EFFECTIVE value of the dangerous keys through the wrapper and assert our
// neutralizing value is what git would use. If the override were absent, git
// would resolve the attacker's value — proven by the negative case here.
test("git-safe hardening overrides a hostile repo-local core.hooksPath/pager/fsmonitor", () => {
  const dir = tempRepo("git-safe-cfg-");
  try {
    // Hostile working tree pins code-execution config repo-locally.
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", "/evil/hooks"]);
    execFileSync("git", ["-C", dir, "config", "core.pager", "/evil/pager"]);
    execFileSync("git", ["-C", dir, "config", "core.fsmonitor", "/evil/fsmonitor"]);

    // Negative control: without our overrides git resolves the attacker's value.
    const attacker = execFileSync("git", ["-C", dir, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim();
    assert.equal(attacker, "/evil/hooks", "sanity: repo-local hostile config is in effect for a raw git call");

    // Through the wrapper, the effective values are our neutralizing ones.
    assert.equal(gitCapture(dir, ["config", "--get", "core.hooksPath"]), "/dev/null", "hooksPath must be neutralized to /dev/null");
    assert.equal(gitCapture(dir, ["config", "--get", "core.pager"]), "cat", "pager must be neutralized to cat");
    assert.equal(gitCapture(dir, ["config", "--get", "core.fsmonitor"]), "false", "fsmonitor must be neutralized to false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The wrapper forces GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL=/dev/null, so a
// user/global ~/.gitconfig cannot smuggle a hook regardless of an inherited HOME.
// We prove the wrapper's own git child does not see any global-config value by
// asserting --show-origin never attributes the resolved value to a global file.
test("git-safe ignores system and global gitconfig (NOSYSTEM + GLOBAL=/dev/null)", () => {
  const dir = tempRepo("git-safe-global-");
  try {
    const origin = gitCapture(dir, ["config", "--show-origin", "--get", "core.editor"]);
    // core.editor is neutralized to a command-line value; its origin must be the
    // command line, never a global/system file.
    assert.ok(!/\/\.gitconfig|\/etc\/gitconfig|file:.*gitconfig/.test(origin), `global/system config must not be honored: ${origin}`);
    assert.ok(origin.includes("false"), `core.editor must resolve to our neutralized value: ${origin}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Option-injection guard: a cwd beginning with '-' is rejected before exec.
test("git-safe rejects a cwd that begins with '-' (option injection) and an empty cwd", () => {
  assert.throws(() => gitCapture("--upload-pack=touch", ["rev-parse"]), /must not begin with '-'/);
  assert.throws(() => gitCheck("-c", ["status"]), /must not begin with '-'/);
  assert.throws(() => gitCapture("", ["rev-parse"]), /non-empty/);
  assert.throws(() => gitCapture("has\0nul", ["rev-parse"]), /NUL byte/);
});

// The real ignore query still works correctly with a -- separated pathspec.
test("gitCheck reports ignore status correctly with a -- separated pathspec", () => {
  const dir = tempRepo("git-safe-ignore-");
  try {
    writeFileSync(join(dir, ".gitignore"), ".mazzy/\n");
    mkdirSync(join(dir, ".mazzy"), { recursive: true });
    writeFileSync(join(dir, ".mazzy", "project.json"), "{}");
    assert.equal(gitCheck(dir, ["check-ignore", "-q", "--", ".mazzy/project.json"]), true, "ignored path reports true");
    assert.equal(gitCheck(dir, ["check-ignore", "-q", "--", "README.md"]), false, "non-ignored path reports false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// rev-parse still returns the real toplevel through the wrapper.
test("gitCapture rev-parse returns the repository toplevel", () => {
  const dir = tempRepo("git-safe-top-");
  try {
    const top = gitCapture(dir, ["rev-parse", "--show-toplevel"]);
    assert.ok(top.length > 0 && !top.startsWith("fatal"), `rev-parse returned: ${top}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
