# Mazzy project-local runtime workspace

This directory is Mazzy-owned, project-local runtime storage. It is not a durable evidence store and its payloads are ignored by default.

`project.json` is the checkout-local opaque identity. It is ignored by Git,
created once by `/mazzy-init --apply`, and must not be copied between checkouts.

`/mazzy-init --apply` creates the canonical set:

- `work/tmp/`, `work/prompts/`, `work/results/`, `work/sessions/`, `work/outputs/`, `work/worktrees/`, and `work/missions/`;
- planned/reserved `memory/hot/`, `memory/warm/`, `memory/cold/`, `indexes/vector/`, and `dag/`; and
- `manifests/` for redacted aggregate cleanup receipts.

`storage-policy.json` is a validated versioned policy for per-directory scan bounds and canonical directory quotas. `/mazzy-clean` is dry-run by default; only `/mazzy-clean --apply` deletes old **regular files** from explicitly disposable Mazzy-owned `work/tmp/`. Until immutable artifact manifests ship, `work/results/` and `work/outputs/` are quota/warn-only, alongside sessions, worktrees, missions, memory, indexes, DAG data, manifests, databases, review reports, and evidence. Cleanup never follows symlinks and never touches OS temporary storage.

Memory tier retention, vector indexing, and DAG retention are **PLANNED**, not implemented. The exact pi-subagents 0.50.0 project package pin does not establish effective project-scoped runtime relocation/configuration. `projectRootResolution` is the documented project-settings control; the eight storage/runtime extension keys are intentionally not written into project `.pi/settings.json`. Mazzy does not auto-write user-global extension configuration, does not assert upstream system temporary storage was relocated, and does not redirect or clean upstream files. `/mazzy-doctor` reports this as a WARN; independently observe runtime behavior before relying on non-Mazzy storage.

Do not place credentials, hidden reasoning, raw tool payloads, unredacted transcripts, or database dumps in this workspace.
