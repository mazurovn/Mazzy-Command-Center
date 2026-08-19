// Mazzy Command Center
// Copyright (c) 2025 Mazurov N.N. (https://github.com/mazurovn)
// PolyForm Noncommercial 1.0.0 — free for noncommercial use (personal, research,
// education). Commercial use requires a separate license. See LICENSE.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadChatState() {
  const storage = new Map<string, string>();
  const context = vm.createContext({ globalThis: {}, Set, JSON });
  vm.runInContext(readFileSync(new URL("../static/assets/chat-state.js", import.meta.url), "utf8"), context);
  const state = (context.globalThis as { MazzyChatState: { reconcileMessages: Function; preserveComposerOnRefresh: Function; reconcileControlLock: Function; read: Function; write: Function; clear: Function; CANONICAL_KEY: string; LEGACY_KEYS: string[] } }).MazzyChatState;
  return { state, storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } };
}

test("the exact browser chat artifact deduplicates optimism and preserves focused drafts", () => {
  const { state } = loadChatState();
  const draft = { body: "in progress", selectionStart: 3, selectionEnd: 7, focused: true };
  assert.deepEqual(JSON.parse(JSON.stringify(state.preserveComposerOnRefresh(draft, true))), { preserveDom: true, draft });
  const messages = state.reconcileMessages([{ id: "server", clientMessageId: "m1" }], [{ id: "local", clientMessageId: "m1" }, { id: "local2", clientMessageId: "m2" }]);
  assert.deepEqual(Array.from(messages, (message: { id: string }) => message.id), ["server", "local2"]);
  assert.equal(state.reconcileControlLock({ createdAt: 100, ttlMs: 1000 }, false, 1099), true, "active lock remains held before its TTL boundary");
  assert.equal(state.reconcileControlLock({ createdAt: 100, ttlMs: 1000 }, false, 1100), false, "lock expires at its TTL boundary");
  assert.equal(state.reconcileControlLock({ createdAt: 100, ttlMs: 1000 }, true, 500), false, "server-pending controls override the client lock");
});

test("browser chat state writes only the canonical Mazzy key and clear removes legacy aliases", () => {
  const { state, storage } = loadChatState();
  for (const key of [state.CANONICAL_KEY, ...state.LEGACY_KEYS]) storage.setItem(key, "old");
  state.write(storage, { draft: "new" });
  assert.equal(storage.getItem(state.CANONICAL_KEY), '{"draft":"new"}');
  for (const key of state.LEGACY_KEYS) assert.equal(storage.getItem(key), null);
  state.clear(storage);
  assert.equal(storage.getItem(state.CANONICAL_KEY), null);
  for (const key of state.LEGACY_KEYS) assert.equal(storage.getItem(key), null);
});