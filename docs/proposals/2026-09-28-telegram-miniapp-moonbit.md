# Telegram Mini App panel (MoonBit) — 2026-09-28

Owner: external panel in a bot, Mini App UI, MoonBit, public link, very hard auth. Alternative: Android instead of web.

## Decision
Ship **Telegram Mini App first**. Native Android is a second client of the same Go API; not instead of Mini App this quarter. Telegram already hosts the Android WebView.

## Hard split (keep MCC invariants)
- Mini App = **view + request**. Never dispatch agents from HTTP.
- Executor stays the parent-lifetime process on the VPS (no HTTP-caused execution).
- Auth: Telegram `initData` HMAC-SHA256 (`WebAppData` + bot token) on **Go backend only**. `auth_date` ≤ 60s. Allowlist of telegram user ids (owner first). Then issue a short-lived capability token (same idea as `/mazzy-url`).
- Do not validate hash in the browser. Do not reuse `@mazurov_mipt_bot` (that bot is Zoom/learning).

## MoonBit
Q3 2026: MoonBit wasm/js backend + Elm-style web. There is **no** official MoonBit Telegram SDK. UI compiles to wasm/js served as static Mini App. Telegram JS bridge stays a thin glue (`Telegram.WebApp.initData`).

## Link
`https://t.me/<NEW_BOT>/<app>?startapp=panel` after BotFather `/newapp`. HTTPS origin on VPS or tunnel. **Do not** expose current `127.0.0.1:7733` python/go stub to 0.0.0.0.

## Not this slice
Live public URL. Bot token in git. Opening lecture bot as a panel.
