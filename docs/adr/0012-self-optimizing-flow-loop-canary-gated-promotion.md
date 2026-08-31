# 12. Self-optimizing flow loop with canary-gated, guarded auto-promotion

Date: 2026-07-13

## Status

Accepted

## Context

Flow quality (a system prompt's wording, its temperature) was static between
manual edits — nothing mined real production traffic to suggest or apply an
improvement. We wanted a loop that: mines what the flow actually produced in
production, evaluates candidate rewrites against that real traffic rather than
a synthetic benchmark, and — only when a candidate is genuinely better and the
operator has opted in — makes it live gradually rather than as a single
all-or-nothing cutover.

The obvious failure mode to design against: an LLM grading its own rewritten
output. If the same model that generated a variant also judges it, the score
is not independent — this is a documented failure mode of LLM-as-judge
evaluation (self-preferencing bias), not a hypothetical.

## Decision

`src/graph/flow-optimizer.ts`'s `FlowOptimizerImpl.execute()` runs a fixed
pipeline per `OptimizerConfig`:

1. **Mine** — pull recent `ExecutionSnapshot`s for the flow from `ReplayStore`
   and build an eval dataset via `buildAutoEvalDataset()` (dedup on, judge
   threshold 0.7). Skipped (not failed) when fewer than `minSamples` (default
   5) snapshots exist — `finishRun(run, "skipped", ...)`, not an error status.
2. **Baseline** — run the *current* flow definition against the mined dataset
   through `runEval()`, recording `baselineScore` and, per case,
   `baselineCases` (`OptimizerCaseResult[]`) — the traceable unit the
   dashboard renders so an operator can see exactly what the live flow
   answered for each real production input before any change.
3. **Self-grading guard** — before generating anything, if `autoPromote ===
   true` and `judgeModelId` is set, compare it against the target LLM node's
   `provider`/`model`. An exact match refuses the run outright
   (`"skipped"`, not silently proceeding with a biased judge) with a message
   naming the conflict and pointing at `promote()` for a manually-reviewed
   path instead. This check runs even before variant generation, so a
   misconfigured judge never wastes an LLM-generation call.
4. **Generate** — `generatePromptVariants()` produces `variantCount` (default
   3) candidate system prompts via `this.generatorModel`, steered by an
   optional `optimizationGoal` string (e.g. the security-hardening goal the
   autopilot injects — see ADR-0008).
5. **Evaluate each variant** — each variant is saved as a temporary draft
   under a synthetic flow id (`flowStore.saveDraft`), evaluated against the
   *same* mined dataset the baseline used (apples-to-apples), then deleted
   (best-effort cleanup, non-fatal on failure). `run.variants` is assigned to
   the live array *before* the loop starts, so a poll of `getRun()` observes
   variants appear one at a time — live progress rather than an all-or-nothing
   result at the end.
6. **Promote (optional)** — when `autoPromote === true`, the highest-scoring
   variant that clears `avgScore - baseline >= minScoreImprovement` (default
   0.05) is selected; `promoteVariant()` writes it back as a new **published**
   version via `flowStore.saveDraft()` + `flowStore.publish()`, restoring the
   original flow id so it goes live under the same id the operator already
   points traffic at. No qualifying variant means no promotion — the run still
   completes as `"done"` with the evaluation results visible for manual
   review.

The optimizer **never mutates the live published definition speculatively** —
every variant lives only as a scratch draft during evaluation. The only write
to the real flow id happens at the promotion step, and even then the prior
published version remains in the flow store's version history for instant
rollback (an existing `FlowStore` capability this loop relies on rather than
reimplements).

### Manual promotion path

`promote(runId, variantLabel, by)` lets an operator pick any evaluated variant
from a *completed* run (`run.status !== "done"` is rejected) and publish it
explicitly — this is the only path available when `autoPromote` was `false`
(the default for a synchronous `POST /optimizer/:flowId/run` call) or when the
self-grading guard refused auto-promotion. It reconstructs the variant
definition from the stored `systemPrompt` via `applyVariant()`, so the full
generation output does not need to be kept in memory between the eval run and
a later manual decision.

### Autonomous scheduling layered on top (`src/graph/optimizer-scheduler.ts`)

`OptimizerScheduler.tick()` turns the manually-triggered loop into a fully
unattended one, gated by three independent guards before starting a run for a
configured flow:

- **min-new-samples** — `countSnapshots(flowId) >= minNewSamples` (default
  50), a coarser "enough new traffic" gate than the optimizer's own
  `minSamples`, since the scheduler runs continuously and should not re-mine
  the same handful of snapshots on every tick.
- **cooldown** — `now - lastRunAt >= cooldownMs` (default = `intervalMs`) per
  flow, so a slow eval loop or a traffic burst cannot queue back-to-back runs
  for the same flow.
- **single-flight** — a flow with a non-terminal `activeRunId` is skipped
  entirely; the scheduler checks the *optimizer's own* run status
  (`optimizer.getRun(st.activeRunId)`) rather than keeping a redundant
  running/not-running flag, so the two can never disagree.

All three guards are independently unit-testable via injected `Clock` and
`SnapshotCounter` — the scheduler has no timer or `ReplayStore` dependency of
its own.

## Consequences

- A flow can improve itself from real traffic with no operator action beyond
  initial configuration (`OPTIMIZER_ENABLED`, schedule, `autoPromote: true`) —
  but every auto-promoted change is still bounded by `minScoreImprovement` and
  the self-grading guard, and instantly reversible via the flow store's
  version history.
- Every candidate is scored against the same real production inputs the
  baseline was scored against, not a static benchmark that can drift out of
  relevance from what the flow actually receives in practice.
- The self-grading guard only catches an *exact* provider+model match between
  judge and candidate. A judge that is a close sibling of the candidate model
  (e.g. two checkpoints of the same base model from different providers) is
  not caught — the guard is a specific, verifiable check, not a general
  bias detector.
- Auto-promotion writes directly to the flow store's published version; it
  does not by itself put the new version behind a canary ramp. Gradual
  traffic shifting on a promoted version is a separate concern, wired by the
  autopilot's `CanaryRegistrar` when the optimizer is driven through the
  autopilot loop (ADR-0008) rather than by the optimizer or its scheduler
  directly — a scheduled optimizer run with no autopilot involved publishes
  at 100% immediately.
- Per-tick scheduler failures (a snapshot-count error, a `start()` throw) are
  logged and skip only the affected flow; they never abort the tick for the
  remaining configured flows.
