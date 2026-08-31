# 8. Autopilot governance: human-approval gate and drift-guard circuit breaker

Date: 2026-07-13

## Status

Accepted

## Context

The Continuous Safety & Quality Autopilot (`src/autopilot/autopilot-engine.ts`)
closes the loop between three already-independent subsystems: the red-team
engine detects guardrail bypasses, the flow optimizer mines production
snapshots and generates hardened prompt variants, and the canary manager rolls
a winning variant to live traffic. `AutopilotEngine.onRedTeamRunCompleted()`
and `onHealthSnapshot()` (fed by a poller in `src/bootstrap/autopilot.ts`
sampling error rate, P95 latency, and the model-quality EMA) both fire the same
`execute()` cycle: mine → generate → evaluate → optionally promote → optionally
register a canary.

Left unconstrained, this loop can write a new *published* flow version — a
live prompt/model change — with no human in the path. Two distinct risks
follow from that:

1. **A single bad promotion.** The optimizer's own `minScoreImprovement` check
   only compares a candidate against its own immediately-measured baseline.
2. **A slow drift across many "locally correct" promotions.** Each individual
   promotion can clear its own baseline check yet the baseline itself is
   re-measured fresh from recent production traffic every cycle — a flow can
   walk its overall quality the wrong direction over a sequence of promotions
   that were each, individually, an improvement over what preceded them.

## Decision

Two independent governance guards sit in front of every automatic promotion,
both implemented in `AutopilotEngineImpl.execute()`:

### 1. `requireHumanApproval` (default `true`)

When set, the autopilot still runs the full mining → generate → evaluate cycle
— `this.optimizer.start({ ..., autoPromote: !this.config.requireHumanApproval,
... })` — so the recommendation is visible on the dashboard (`GET
/autopilot/runs/:id`), but `autoPromote` is passed as `false`, so the optimizer
never calls `FlowStore.publish()` itself. A human must call the optimizer's
`promote(runId, variantLabel)` explicitly (`POST
/optimizer/runs/:runId/promote`) to make a variant live.

`checkProductionReadiness` (`src/config/prod-gate.ts`) treats
`AUTOPILOT_REQUIRE_APPROVAL=false` in production as fatal unless the operator
has explicitly acknowledged it — the safe default requires no configuration at
all; opting out of the human gate is a deliberate, logged decision.

### 2. Drift-guard circuit breaker (`maxAutoPromotionsPerWindow`, default 3
per `driftWindowMs`, default 24h)

Only active when `requireHumanApproval` is `false` (the guard exists
specifically to bound *unattended* auto-promotion). Before starting an
optimizer cycle, `execute()` queries `this.history.listByFlow(run.flowId)` and
counts entries where `canaryRegistered === true` within the drift window. At
the limit, the cycle is marked `"skipped"` with reason "Drift-guard tripped"
and an `autopilot.drift_guard.tripped` audit-log entry is recorded — the loop
does not promote, but keeps running future cycles once the window ages out, so
a human notices the trend and reviews it rather than the loop silently
correcting or silently compounding it.

The promotion count backing this guard must survive a process restart —
otherwise a redeploy resets the counter at exactly the moment (right after a
bad rollout prompts an operator restart) it matters most. `AutopilotRunHistory`
is a separate interface from the bounded in-memory run registry
(`this.runs`/`this.runOrder`, capped at `maxRunsInMemory`, used for fast
`getRun()`/`listRuns()` reads) specifically so the durable count and the fast
read path can evolve independently:

- `InMemoryAutopilotRunHistory` — ring buffer, used when no database is
  configured. The guard still functions per-process but resets on restart.
- `PostgresAutopilotRunHistory` (`src/autopilot/autopilot-run-history.ts`) —
  writes to an `autopilot_runs` table on every `record()` call and mirrors
  into an in-memory ring so reads stay available during a brief database
  outage (same pattern as `PostgresAuditLog`). `record()` is called from a
  `finally` block in `execute()` — best-effort, never blocks or fails the
  cycle.

`createAutopilotRunHistory(database, logger)` in `autopilot-run-history.ts`
selects Postgres when a database is configured, else falls back to in-memory.

### Canary registration is separate from promotion

A promoted version is published unconditionally; canary registration
(`CanaryRegistrar`, implemented by `createCanaryFileRegistrar` in
`src/autopilot/canary-registrar.ts`) is best-effort on top of that — it upserts
`canary.yaml` in `FLOWS_DIR` and calls `canaryManager.reload()`. A registration
failure is logged and swallowed (`run.canaryRegistered` stays `false`); the
promotion itself is not rolled back, since a 100%-published version without a
canary ramp is still a valid, if less gradual, deployment.

## Consequences

- Production deployments get automatic guardrail-bypass and quality-regression
  response by default, without an operator having to configure anything, and
  without risking an unattended live prompt change — the safe path
  (`requireHumanApproval=true`) requires zero configuration.
- An operator who wants full autonomy must both flip
  `AUTOPILOT_REQUIRE_APPROVAL=false` *and* accept the readiness-gate warning in
  production, and even then is bounded by the drift-guard rather than able to
  auto-promote without limit.
- The drift-guard's promotion count is per-flow and window-based, not
  score-based — it cannot detect a single promotion that is a large quality
  regression missed by `minScoreImprovement` (that failure mode is the
  optimizer's own self-grading guard's responsibility, see
  `FlowOptimizer.execute()`'s judge/candidate-model check). It only catches the
  "many small locally-passing steps, net negative trend" pattern.
- `AutopilotRunHistory` is now the second durable-history-with-in-memory-mirror
  implementation in the codebase (after `PostgresAuditLog`) — a reusable
  pattern for any future feature that needs a counter or log to survive a
  restart without becoming a hard database dependency.
