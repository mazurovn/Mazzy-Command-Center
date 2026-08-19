/* Browser-owned Mazzy chat state. No module loader or inline policy exception required. */
(function (global) {
  "use strict";
  var CANONICAL_KEY = "mazzy-control-ui-v1";
  var LEGACY_KEYS = ["pi-ops-control-ui-v1"];
  function reconcileMessages(confirmed, optimistic) {
    var ids = new Set(confirmed.map(function (message) { return message.clientMessageId; }).filter(Boolean));
    return confirmed.concat(optimistic.filter(function (message) { return !message.clientMessageId || !ids.has(message.clientMessageId); }));
  }
  function preserveComposerOnRefresh(draft, commentsUnchanged) {
    return { preserveDom: Boolean(draft.focused && commentsUnchanged), draft: Object.assign({}, draft) };
  }
  function reconcileControlLock(lock, serverHasPending, now) {
    return Boolean(lock && !serverHasPending && now - lock.createdAt < lock.ttlMs);
  }
  function read(storage) {
    var raw = storage.getItem(CANONICAL_KEY);
    if (raw === null) for (var i = 0; i < LEGACY_KEYS.length && raw === null; i++) raw = storage.getItem(LEGACY_KEYS[i]);
    try { var v = raw ? JSON.parse(raw) : {}; return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; } catch (_) { return {}; }
  }
  function write(storage, value) { storage.setItem(CANONICAL_KEY, JSON.stringify(value)); LEGACY_KEYS.forEach(function (key) { storage.removeItem(key); }); }
  function clear(storage) { storage.removeItem(CANONICAL_KEY); LEGACY_KEYS.forEach(function (key) { storage.removeItem(key); }); }
  global.MazzyChatState = Object.freeze({ CANONICAL_KEY: CANONICAL_KEY, LEGACY_KEYS: LEGACY_KEYS.slice(), reconcileMessages: reconcileMessages, preserveComposerOnRefresh: preserveComposerOnRefresh, reconcileControlLock: reconcileControlLock, read: read, write: write, clear: clear });
}(globalThis));
