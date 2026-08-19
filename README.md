# Mazzy Command Center

**English** · [Русский](README.ru.md) · [Deutsch](README.de.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

**A parent-attested, localhost task command center for the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent.**

_By **Mazurov N.N.** — https://github.com/mazurovn · Proprietary, source-available
(no modification or redistribution without written permission — see [LICENSE](LICENSE))._

Mazzy Command Center is a project-local Pi extension that turns a Pi session into
a durable, auditable command center for agent-driven work: a task tracker, an
orchestration decision surface, a review/evidence ledger, and an authenticated
local web dashboard — all over a single embedded SQLite control plane.

> **Status: authenticated local pilot.** One machine, one trusted user,
> project-local persistence, and process-level parent/child boundaries. It is not
> (yet) a multi-user, multi-tenant, or remote-deployment product. See
> [Security & limits](#security--limits).

---

## What it does

Mazzy is a **control plane**, not a second execution runtime. It records and
governs work; the actual child execution is delegated to `pi-subagents`. The
parent Pi session is the only writer to the control plane — child agents never
mutate durable state directly; the parent attests observed results.

- **Durable task tracker** — epics / features / tasks / bugs with a revisioned
  lifecycle (`DRAFT → BACKLOG → READY → CLAIMED → RUNNING → REVIEW → DONE`, plus
  `BLOCKED / FAILED / CANCELLED`). Every update is optimistic-concurrency checked.
- **Parent-attested orchestration** — the parent binds an *observed* child run to
  a task before claiming it is running; `DONE` requires independent PASS evidence,
  never a comment.
- **Authenticated local dashboard** — a self-contained web UI on `localhost` with a
  capability token, live SSE updates, a Kanban board, and a task discussion drawer.
- **SDD/ADR graph view** — an in-browser visualization that links specification
  clauses (ADR/INV/FR), code components, and backlog items into one filterable
  connectivity graph, assembled from pluggable sources.
- **Safe scaffolding** — `mazzy-init` writes portable project templates with a
  dry-run default, guarded `--force`, and `--rollback`.

---

## Architecture at a glance

```
Human ── Pi commands / authenticated localhost browser ──┐
                                                          v
Pi parent + extension APIs ── Mazzy Command Center ── SQLite control plane
                             │       │        │
                             │       ├─ discussion / evidence / reports
                             │       └─ parent-attested control bridge
                             v
                   pi-subagents (the only child execution runtime)
```

**Core principles (invariants):**

- **Single execution runtime** — `pi-subagents` runs children; Mazzy never spawns,
  schedules, retries, or kills child work. It owns *decision* authority, not
  *execution* authority.
- **Parent-only writes** — control-plane mutations require the interactive parent;
  inherited child processes are refused.
- **No host paths cross the API** — only opaque ids, enums, and relative refs leave
  the localhost HTTP boundary.
- **Comments are never evidence** — reviewer/verifier evidence is the authoritative
  PASS/FAIL channel.
- **All `git` invocations are hardened** — repository-supplied config/hooks and
  inherited environment cannot influence execution.

A deeper conceptual overview lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Tools and commands

**Parent-only tools** (the LLM-visible surface):

| Tool | Purpose |
|---|---|
| `mazzy_task` | Create / list / get / update durable tasks (revisioned; `DONE` needs PASS evidence). |
| `mazzy_route` | Read-only policy preflight for delegation (never spawns). |
| `mazzy_assignment` | Parent-attested run binding, completion import, and reviewer evidence. |
| `mazzy_discussion` | Read/answer a durable task discussion. |
| `mazzy_control` | Claim/complete/fail dashboard GO / PAUSE / STOP requests. |

**Slash commands:** `/mazzy` (status + dashboard URL), `/mazzy-url` (access URL with
token), `/mazzy-server` (start/stop/status), `/mazzy-menu` (`Ctrl+Alt+M`),
`/mazzy-init`, `/mazzy-doctor`, `/mazzy-registry`, `/mazzy-clean`.

---

## Screenshots

**SDD/ADR connectivity graph** — specification (ADR/INV/FR), code, and backlog in one
filterable graph:

![SDD/ADR graph](docs/screenshot.png)

**Backlog board** — a Kanban board with a revisioned lifecycle:

![Backlog board](docs/screenshot-backlog.png)

---

## Installation

Mazzy Command Center is a **project-local Pi package**, installed into a project's
Pi configuration.

**Requirements**

| Component | Version |
|---|---|
| Node.js | `>= 22.19.0` |
| `@earendil-works/pi-coding-agent` | `0.84.2` (exact peer) |
| `@earendil-works/pi-ai` | `0.84.2` (exact peer) |
| `@earendil-works/pi-tui` | `0.84.2` (exact peer) |

**Install from npm** (recommended):

```bash
pi install npm:@mazurovn/mazzy-command-center
# then restart Pi so it discovers the extension.
```

**Install from GitHub:**

```bash
pi install git:github.com/mazurovn/Mazzy-Command-Center
```

**Install from a local checkout** (for development):

```bash
git clone https://github.com/mazurovn/Mazzy-Command-Center.git
cd Mazzy-Command-Center
npm install
pi install -l /path/to/Mazzy-Command-Center   # from your Pi project
```

**Verify**

```bash
npm run typecheck   # tsc, no emit
npm test            # node --test (requires a git-initialized working tree)
```

In a Pi session, run `/mazzy` to see status and the dashboard URL, or `/mazzy-url`
to reveal the authenticated access URL (the token is never written to logs).

---

## The web dashboard

Start it from Pi with `/mazzy-server start`, then open the URL from `/mazzy-url`.
The dashboard is a single self-contained page under a strict Content-Security
Policy (no external scripts). It provides:

- a **Backlog** Kanban board with drag-to-transition and a task discussion drawer;
- an **SDD/ADR** graph tab with domain/artifact/edge filters and node focus;
- a redacted project context chip (project id, session prefix, bound port) — never
  a host path.

Access is gated by a per-session capability token; the API rejects any request
without it and never embeds the token in the served HTML.

---

## Security & limits

This is an **authenticated local pilot**, and the README should not be read as a
production security claim.

- One machine, one trusted user; process-level parent/child boundaries.
- Not multi-user authorization, not tenant isolation, not remote identity, not a
  distributed writer lease.
- Local dashboard authentication, parent-only writes, task revisions, bound runs,
  and reviewer evidence gating are pilot controls — a dashboard action, a comment,
  or a parent acknowledgement is **not** proof of execution or verification.

Report a security concern via a private channel rather than a public issue.

---

## Development

```bash
npm run typecheck
npm test
```

- Source: `src/` (TypeScript, run under Node's native type stripping — no build step).
- Web UI: `static/` (self-contained HTML + vendored assets).
- Skills / templates: `skills/`, `resources/`.
- Tests: `test/` (Node's built-in test runner).

See [`docs/`](docs/) for the conceptual architecture and specification summary.

---

## Author

**Mazurov N.N.** — https://github.com/mazurovn

## License

**Proprietary, source-available.** Copyright (c) 2026 Mazurov N.N. All rights
reserved. You may view, run, and evaluate the Software, but you may **not** modify,
adapt, redistribute, or create derivative works without the Author's prior written
permission, and every permitted copy must retain the author attribution. See the
[LICENSE](LICENSE) file for the full terms. For any use beyond evaluation — including
modification or redistribution — contact the Author at https://github.com/mazurovn.
