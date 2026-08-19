# Mazzy Command Center — Conceptual Architecture

This document is a **conceptual overview** of Mazzy Command Center: what it owns,
what it deliberately does not own, and the invariants that keep it safe. It is not
an implementation reference.

> **Status — authenticated local pilot.** Everything below describes the shipped
> single-machine, single-trusted-user pilot. Multi-user, multi-tenant, and remote
> deployment are out of scope for this release.

## 1. Product boundary

Mazzy Command Center is a project-local Pi extension. It owns the **control-panel
layer** over reused Pi capabilities and delegates all child execution to
`pi-subagents`.

| Boundary | Mazzy owns | Mazzy reuses / does not own |
|---|---|---|
| Decision & evidence | tasks, assignments, review reports, evidence, revisions, control requests | Pi session identity, child execution identity |
| Discussion | durable task comments, threading, parent import path, UI narration | optional session-messaging transport |
| Web UI | dashboard, status/menu, token handling, graph view | Pi TUI / extension host / public APIs |
| Scaffold | portable templates, init/doctor/rollback, routing policy | the consuming project's Git root and Pi config |
| Control bridge | parent-attested GO / PAUSE / STOP requests and run bindings | `pi-subagents` lifecycle & controls |
| Execution | **nothing** — no scheduler, worker, poller, daemon, or child lifecycle | `pi-subagents`, the sole execution runtime |

## 2. Component view

```
Human operator ── Pi commands / authenticated localhost browser ──┐
                                                                   v
Pi parent + extension APIs ── Mazzy Command Center ── SQLite control plane
                             │        │        │
                             │        ├─ discussion   ├─ evidence / reports
                             │        └─ control bridge
                             v
                    pi-subagents (only child runtime)
                             │
                    bound worker / reviewer runs
```

The parent owns tool writes and imports child results. A child may produce a
result, but it never writes the control plane directly.

## 3. Request → run → review

1. A human or the dashboard creates/updates a task and may submit a control request.
2. The authenticated parent reads and claims the request; comments alone authorize
   nothing.
3. For **GO**, the parent evaluates policy, invokes `pi-subagents`, observes the real
   run/session id, and records the matching binding. Mazzy never spawns a runtime.
4. A bound worker performs the work through `pi-subagents` and ends with a concise,
   safe `TASK_COMMENT`.
5. The parent imports meaningful child narration through the attested assignment path.
6. A bound reviewer independently checks the result and supplies verifier
   evidence/report — the authoritative PASS/FAIL channel.
7. Completion requires the applicable reviewer PASS evidence; the operator makes any
   remaining human decision.

**PAUSE / STOP** are explicit requests: the parent uses the `pi-subagents` control on
the observed target and records only the observed outcome. A dispatched
acknowledgement is never a claim that work completed.

## 4. Invariants

These are enforced by structure and tests, not merely convention.

- **INV — Single execution runtime.** `pi-subagents` is the only execution runtime.
  Mazzy never spawns, polls, schedules, retries, or kills child work. The only timer
  is the dashboard's SSE keep-alive; session-start recovery is a one-shot, not a loop.
- **INV — Control-plane store stays identity-free.** The store and HTTP server never
  resolve or hold project identity; identity resolution lives only in the composition
  root. The server receives an already-redacted context blob.
- **INV — No host path crosses the HTTP boundary.** Only opaque ids, source/status
  enums, and bounded transport-observable values (short session prefix, bound port)
  leave `localhost`. Absolute host paths never enter or leave the API — including a
  fail-closed gate on the graph endpoint.
- **INV — Comments are supplementary, never evidence.** Reviewer comments narrate;
  verifier evidence/report is authoritative for PASS/FAIL.
- **INV — Hardened process invocation.** Every `git` call is routed through a single
  wrapper that neutralizes repository-supplied config/hooks and inherited environment,
  requires `--` before pathspecs, and rejects option-injection — so an untrusted
  working tree cannot influence execution.

## 5. The graph view (SDD/ADR tab)

The dashboard renders a connectivity graph linking **specification** (ADR/INV/FR),
**code** (files/symbols), and **backlog** (epics/features/tasks). The graph is
assembled server-side from a registry of pluggable sources; a missing source
degrades to a greyed legend chip rather than an error. A fail-closed gate strips and
rejects any host path before the document leaves the API. Rendering is a vendored,
CSP-safe SVG renderer with no external dependency; all filtering is client-side and
derived from the payload, so new sources appear as new lanes and toggles without any
client change.

## 6. Persistence

Durable data — tasks, revisions, assignments/run bindings, comments, evidence,
review reports, and control-request state — lives in a project-local SQLite control
plane. The package ships code, the web UI, skills, and portable templates. It is a
reusable package; live state is not yet a specified export/import, encrypted-backup,
or cross-host replication system.

## 7. What this pilot is not

- Not multi-user authorization or tenant isolation.
- Not remote identity attestation or a distributed sole-writer lease.
- Not encrypted/portable durable storage or a production migration/recovery system.

A dashboard action, a dispatched control request, or a parent acknowledgement is not
proof of execution or verification.
