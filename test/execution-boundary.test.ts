// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Security invariants (hold under any architecture):
// two invariants that hold under BOTH the current adapter model AND the future
// Mazzy Command Center own-engine model. They defend the *real* property behind
// INV-1 — a taint boundary plus a spawn-free transport port — rather than the
// factually-overstated "module absence" wording these tests correct.

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const read = (name: string): string => readFileSync(srcDir + name, "utf8");

// Compute the transitive local-module import closure of an entry file. Only
// relative "./x.ts" imports are followed; bare/node: specifiers are recorded as
// leaf specifiers so we can assert on them. Returns { modules, specifiers }.
function importClosure(entry: string): { modules: Set<string>; specifiers: Set<string> } {
  const modules = new Set<string>();
  const specifiers = new Set<string>();
  const importRe = /(?:import|export)[^"']*?["'](\.\/[A-Za-z0-9_.-]+|node:[a-z/]+|@?[a-z0-9/@._-]+)["']/g;
  const visit = (name: string): void => {
    if (modules.has(name)) return;
    modules.add(name);
    let text: string;
    try { text = read(name); } catch { return; }
    for (const m of text.matchAll(importRe)) {
      const spec = m[1];
      if (spec.startsWith("./")) visit(spec.slice(2));
      else specifiers.add(spec);
    }
  };
  visit(entry);
  return { modules, specifiers };
}

// INV (transport port is spawn-free): ControlPlanePort — the only surface the
// HTTP server depends on — must never gain a method that could start, schedule,
// retry, or kill work. A frozen allowlist fails the build the moment a
// spawn-shaped verb is added to the wire boundary, under any architecture.
test("ControlPlanePort exposes only the frozen non-execution method allowlist", () => {
  const types = read("types.ts");
  const block = /export interface ControlPlanePort \{([\s\S]*?)\n\}/.exec(types);
  assert.ok(block, "ControlPlanePort interface must be present in types.ts");
  const methods = [...block[1].matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((m) => m[1]).sort();

  const allowlist = [
    "addComment", "claimCommentNotification", "claimControlRequest", "createControlRequest",
    "createTask", "getControlRequest", "getTask", "getTaskDetail", "latestEventId",
    "listBindings", "listComments", "listControlRequests", "listEvents", "markDelivered",
    "nextUndeliveredControlRequest", "reconcileOneClaimedRequest", "snapshot",
    "subscribeEvents", "unnotifiedComments", "updateTask",
  ].sort();
  assert.deepEqual(methods, allowlist, "ControlPlanePort method set changed — review against the execution-authority boundary before updating this allowlist");

  // Belt and suspenders: no method name may look like a spawn/lifecycle verb,
  // even if a future edit also updates the allowlist above by mistake.
  const forbidden = /^(spawn|exec|fork|run|start|dispatch|schedule|retry|kill|stop|pause|resume|launch|execute)/i;
  const offenders = methods.filter((name) => forbidden.test(name));
  assert.deepEqual(offenders, [], `ControlPlanePort must hold no execution-shaped verb: ${offenders.join(", ")}`);
});

// C4 primary control: the HTTP-terminating module's ENTIRE transitive import
// closure must be free of any process-creation capability. This is strictly
// stronger than the method-name allowlist (a name lint) — it proves that no code
// reachable from server.ts can even reference child_process, so no route handler
// or callback can transitively start work. If a future change makes server.ts
// import a module that pulls in git-safe/child_process, this fails.
test("server.ts import closure contains no process-creation capability", () => {
  const { modules, specifiers } = importClosure("server.ts");
  assert.ok(modules.has("server.ts"), "closure must include the entry");
  assert.ok(!specifiers.has("node:child_process"), `server.ts closure must not reach node:child_process; closure modules: ${[...modules].sort().join(", ")}`);
  assert.ok(!modules.has("git-safe.ts"), "server.ts closure must not include git-safe.ts (the only child_process holder)");
  for (const spec of ["node:cluster", "node:worker_threads"]) {
    assert.ok(!specifiers.has(spec), `server.ts closure must not reach ${spec}`);
  }
});

// INV (argv taint): every child_process call in a module reachable from the
// HTTP process must build its argv only from literals or validated paths, never
// from task/comment/instruction/report free text. We assert structurally that
// each execFileSync invocation's argv array contains no obvious free-text source
// identifier, and that the executable is a fixed literal (currently only "git").
test("every execFileSync in the source tree uses a literal executable and a non-free-text argv", () => {
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const callRe = /execFileSync\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)\s*,\s*(\[[^\]]*\])/g;
  const freeText = /\b(title|description|body|comment|instructions?|report|payload|summary|outcome|kind|message|prompt|params\.[a-z])/i;
  let sawAtLeastOne = false;

  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(callRe)) {
      sawAtLeastOne = true;
      const executable = m[1];
      const argv = m[2];
      assert.ok(/^["'`]git["'`]$/.test(executable), `${file}: execFileSync executable must be the literal "git", got ${executable}`);
      assert.ok(!freeText.test(argv), `${file}: execFileSync argv must not interpolate free text: ${argv}`);
      // argv entries must be string literals or previously-validated identifiers
      // (root/cwd/dir), never a raw template with an embedded expression.
      assert.ok(!/\$\{(?!(root|cwd|dir)\b)/.test(argv), `${file}: execFileSync argv template interpolates a non-path expression: ${argv}`);
    }
  }
  assert.ok(sawAtLeastOne, "expected to find at least one execFileSync call to guard");
});

// C1 completeness: cover ALL child_process entry points (not just execFileSync)
// and the OPTIONS argument. Anywhere in the tree, an exec/spawn family call must
// (a) live only in git-safe.ts, and (b) never pass a cwd/env/shell built from a
// free-text field. This closes the round-1 gap where only argv was inspected.
test("no child_process entry point outside git-safe.ts; no free-text options argument anywhere", () => {
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  // Match child_process FUNCTIONS only, never a method call like db.exec(...) or
  // regexp.exec(...): require the name is NOT preceded by a ".".
  const entryRe = /(?<![.\w])(execFileSync|execSync|execFile|exec|spawnSync|spawn|fork)\s*\(/g;
  const freeText = /\b(title|description|body|comment|instructions?|report|payload|summary|outcome|kind|message|prompt)\b|params\.[a-z]/i;
  // shell:true re-introduces a shell interpreter and is banned outright.
  const shellTrue = /shell\s*:\s*true/;
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(entryRe)) {
      if (file !== "git-safe.ts") {
        assert.fail(`${file}: child_process entry "${m[1]}" must not appear outside git-safe.ts`);
      }
      // Inspect the options object of THIS exec call (the segment from the call
      // site to the next "});" ), not unrelated cwd:/env: fields elsewhere in the
      // file (type unions, request payloads). A cwd/env/shell built from free text
      // is an execution-influence vector.
      const seg = text.slice(m.index, text.indexOf("})", m.index) + 2);
      for (const opt of seg.matchAll(/\b(cwd|env)\s*:\s*([^,}\n]+)/g)) {
        assert.ok(!freeText.test(opt[2]), `${file}: ${opt[1]} option of a child_process call must not be free text: ${opt[2].trim()}`);
      }
      assert.ok(!shellTrue.test(seg), `${file}: shell:true is banned in a child_process call`);
    }
  }
});

// Security: a literal argv is NOT a taint boundary. All git
// execution is centralized in src/git-safe.ts; every OTHER source module must be
// free of a raw child_process git invocation, so the hardening cannot be bypassed.
test("git execution is centralized in git-safe.ts; no other module invokes git directly", () => {
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "git-safe.ts");
  for (const file of files) {
    const text = read(file);
    assert.ok(!/from\s+["']node:child_process["']/.test(text), `${file}: only git-safe.ts may import node:child_process`);
    assert.ok(!/\b(execFileSync|execSync|exec|execFile|spawnSync|spawn|fork)\s*\(\s*["'`]git/.test(text), `${file}: raw git invocation found — route through gitCapture/gitCheck`);
  }
});

// C1 hardening presence: git-safe.ts must neutralize the named injection vectors.
// This is a structural assertion; the functional proof is the hook test below.
test("git-safe.ts neutralizes repo-config, hook, env, and option-injection vectors", () => {
  const gs = read("git-safe.ts");
  for (const guard of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.pager=cat", "core.editor=false", "protocol.ext.allow=never"]) {
    assert.ok(gs.includes(guard), `git-safe.ts must apply hardening flag: ${guard}`);
  }
  for (const env of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT"]) {
    assert.ok(gs.includes(env), `git-safe.ts must set a sanitized ${env}`);
  }
  // The env is constructed from scratch (allowlist), never spread from process.env,
  // so inherited GIT_*/LD_PRELOAD/NODE_OPTIONS cannot leak into the child.
  assert.ok(!/\.\.\.process\.env/.test(gs), "git-safe.ts must not spread the inherited environment into the git child");
  // cwd is validated against option-injection.
  assert.ok(/startsWith\("-"\)/.test(gs), "git-safe.ts must reject a cwd beginning with '-'");
});