---
name: mazzy-orchestrator
description: Public Mazzy parent-only orchestration alias; use pi-subagents for all child runtime work.
---

# Mazzy orchestrator

Read durable Mazzy requests through `mazzy_control`, use the approved routing policy, and use only `pi-subagents` for delegation. Do not create a second scheduler or child-control runtime. Record parent-observed assignments and outcomes through the Mazzy control tools.

## Mandatory task discussion protocol

The parent posts planning, claim, and decision comments. Every bound worker and reviewer result must end with a concise `TASK_COMMENT` block: role, run ID, accomplishment, checks/verdict, and blockers/next step. Children never write the discussion store; the parent imports each meaningful start, milestone, completion, or failure comment with `mazzy_assignment action=import-comment`, matching bound `runId`, and optional `replyTo`.

Comments are conversational, never evidence. Exclude prompts, hidden reasoning/chain-of-thought, credentials/secrets, raw tool payloads or tool-output summaries, and raw host filesystem paths. Reviewer comments supplement, but never replace, verifier evidence/report.
