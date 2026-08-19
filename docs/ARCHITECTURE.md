# Mazzy Command Center — Conceptual Architecture

_By Mazurov N.N. — https://github.com/mazurovn · PolyForm Noncommercial 1.0.0 (noncommercial use only; commercial license required)._

This document is a **conceptual overview** of Mazzy Command Center: a full agent
orchestrator and command center. It explains what Mazzy owns, the three-authority
model that lets it own a powerful engine safely, and the invariants that keep it
secure. It is not an implementation reference.

> **Status — authenticated local pilot, building toward the full command center.**
> The pilot ships the durable kernel, dashboard, graph view, and attested
> orchestration today. The own sub-agent engine, sub-agent creator, meta-agents,
> and tiered memory / DAG / RAG / vectors are the product direction and land
> incrementally. Sections marked *(direction)* are design intent, not yet shipped.

## 1. What Mazzy is

Mazzy Command Center is a project-local Pi extension that acts as a **command
center owning orchestration**: it decides *what runs next, with which agent, under
which budget and capability ceiling*, and it holds the durable plan, evidence,
memory, and knowledge graph. Execution runs through a provider interface Mazzy
owns — today the `pi-subagents` provider, growing into a first-party engine —
always behind a strict process boundary.

| Mazzy owns | Notes |
|---|---|
| **Orchestration authority** | the plan, scheduling decisions, agent selection, budgets, capability ceilings |
| **Task tracker & evidence** | tasks, revisions, assignments/run bindings, review reports, evidence |
| **Sub-agent engine & creator** *(direction)* | a first-party execution engine and a declarative agent creator |
| **Meta-agents** *(direction)* | agents whose output is proposals other agents act on |
| **Memory & knowledge** *(direction)* | hot / warm / cold memory, RAG, vectors, and a plan DAG (as context, never authority) |
| **Web command surface** | dashboard, status/menu, token handling, the spec↔code↔backlog graph |
| **Scaffold** | portable templates, init/doctor/rollback, routing policy |

## 2. The three-authority model (why owning an engine is safe)

Owning a powerful orchestration engine must never turn the web surface into a
remote-execution oracle. Mazzy therefore separates three distinct authorities:

1. **Scheduling authority — the kernel.** A pure planner computes *what should run
   next* from durable, typed records (no free text as an authorization input). It
   holds no process handles and starts nothing.
2. **Dispatch authority — Mazzy's own executor.** A separate, **network-less,
   parent-lifetime** process is the only component that actually launches work. It
   consumes single-use, integrity-checked dispatch authorizations; no process that
   terminates the HTTP socket can start work.
3. **Execution provider — replaceable.** Behind the executor sits a provider that
   runs the agent. Today this is `pi-subagents`; Mazzy owns the provider interface
   and is growing its own first-party engine. Swapping the provider changes nothing
   above it.

This split is what lets Mazzy be a full orchestrator *and* keep a hard structural
distance between the network surface and process creation.

## 3. Component view

```
Human operator ── Pi commands / authenticated localhost browser ──┐
                                                                   v
Pi parent + extension APIs ── Mazzy Command Center kernel ── SQLite kernel store
   (orchestration authority)  │        │        │
                              │        ├─ plan / evidence / reports
                              │        ├─ memory & knowledge graph  (direction)
                              │        └─ dispatch authorizations
                                        │  (single-use, integrity-checked)
                                        v
                          Mazzy executor  (separate, network-less process)
                                        │
                                        v
                          execution provider — pi-subagents today,
                          Mazzy's own engine (direction) — replaceable
```

## 4. Plan → dispatch → review

1. A human or the dashboard creates/updates work, or the planner proposes the next
   step from the durable plan.
2. Mazzy selects the agent, budget, and capability ceiling, and issues a single-use
   dispatch authorization.
3. The **executor** (not the web process) launches the run through the provider,
   observes the real run/session id, and binds it to the task.
4. The bound agent performs the work and returns a concise, safe result.
5. A bound reviewer independently checks it and supplies verifier evidence/report —
   the authoritative PASS/FAIL channel.
6. Completion requires the applicable reviewer PASS evidence; comments never satisfy
   a gate.

**PAUSE / STOP** act on the observed run through the provider's control surface and
record only the observed outcome. A dispatched acknowledgement is never a claim that
work completed.

## 5. Invariants

Enforced by structure and tests, not merely convention.

- **INV — No HTTP-caused execution.** No process that terminates an HTTP socket
  holds dispatch authority, and no HTTP-reachable verb can start work. Dispatch
  happens only in the executor, only against a valid single-use authorization.
- **INV — No free text drives execution.** Scheduling is a pure function of typed
  durable records; no `argv`/`env`/`cwd` byte is derived from task/comment/report
  text. Memory, vectors, and cache are *context, never authority*.
- **INV — Kernel store stays identity-free.** The store and HTTP server never
  resolve or hold project identity; identity lives only in the composition root.
- **INV — No host path crosses the HTTP boundary.** Only opaque ids, enums, and
  bounded transport values leave `localhost` — including a fail-closed gate on the
  graph endpoint.
- **INV — Comments are supplementary, never evidence.** Verifier evidence/report is
  authoritative for PASS/FAIL.
- **INV — Hardened process invocation.** Every `git` call is routed through a single
  wrapper that neutralizes repository-supplied config/hooks and inherited
  environment, requires `--` before pathspecs, and rejects option-injection.

## 6. Memory, knowledge, and the graph *(direction + shipped view)*

Mazzy's knowledge layer links **specification** (ADR/INV/FR), **code**
(files/symbols), and **backlog** (epics/features/tasks) into one filterable
connectivity graph, assembled server-side from a registry of pluggable sources. The
**SDD/ADR graph view ships today**; **tiered memory (hot/warm/cold), RAG, and vector
search** are first-class sources that plug into the same graph and retrieval path as
they land — always as *context*, never as an authorization input (see INV above). A
missing source degrades to a greyed legend chip. Rendering is a vendored, CSP-safe
SVG renderer with no external dependency.

## 7. Persistence

Durable data — plan, tasks, revisions, run bindings, comments, evidence, review
reports, control state, and (direction) memory/knowledge — lives in a project-local
SQLite kernel. The package ships code, the web UI, skills, and portable templates.

## 8. Pilot limits (honest scope)

The pilot is a single-machine, single-trusted-user deployment. It is **not** yet
multi-user authorization, tenant isolation, remote identity attestation, a
distributed sole-writer lease, or encrypted/portable backup and recovery. A
dashboard action, a dispatched control request, or an acknowledgement is not proof
of execution or verification.
