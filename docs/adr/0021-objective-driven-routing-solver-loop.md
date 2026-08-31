# 21. Objective-Driven Routing / Solver-Loop

Date: 2026-08-02

## Status

Accepted

## Context

`cost-router.ts`'s `"quality-aware"` strategy already does one useful thing:
pick the cheapest candidate model whose observed judge score clears a single
floor. That is a genuinely useful default, but it is also a special case of a
more general and more honestly-named problem an operator actually has —
*"minimize cost subject to a quality floor"*, or *"minimize cost subject to a
floor AND a hard cost cap"*, or any small combination of such constraints. The
existing strategy hardcodes one specific combination (quality floor + cheapest
tiebreak) into a strategy name; a second, third, or combined constraint would
each need its own bespoke strategy, with its own bespoke selection function,
indefinitely.

The Decision-Provenance Explainability Card (ADR-0017) already gives a
`router` node's routing decision full transparency (which target, which
candidates were considered). A model-selection decision made *inside* an `llm`
node via `config.routing` had no equivalent — a reader could see which model
ended up being used, but not why, nor what else was tried and rejected.

## Decision

`src/graph/objective-solver.ts` generalizes the single-constraint case into a
small, declarative constraint solver. A node declares a candidate pool and a
list of `ObjectiveClause`s (`metric: "quality" | "cost"`, `op: "gte" | "lte"`,
a target `value`) under `config.objective` — parallel to, but taking
precedence over, the older `config.routing` when both are present (a node
author moving to the more general mechanism never has to remove the old
config first).

**Solve semantics** (`solveObjective`):

- Candidates are evaluated **cost-ascending**, bounded by `maxAttempts`
  (default = full pool). The solver stops at the FIRST candidate that clears
  every declared clause — this is what "minimize cost subject to a
  constraint" means operationally: never pay for a more expensive model than
  the cheapest one that already holds the bar.
- **Exploration, not starvation.** A candidate with too few quality
  observations (`< minQualitySamples`) has its quality clause treated as
  unproven — eligible, not rejected — exactly like `selectQualityAware`
  already does. Cost clauses are never "unproven": a candidate is either
  priced or it isn't.
- **Bounded, not unbounded.** `maxAttempts` caps how many candidates are
  actually evaluated per solve. A large candidate pool never turns one routing
  decision into an unbounded scan.
- **Explicit, inspectable fallback.** When no attempted candidate clears every
  clause, a configured strategy (`"cheapest"` | `"best-quality"` | `"first"`)
  decides — and the result records `fallbackUsed: true` with a human-readable
  reason, so nobody mistakes a fallback pick for a genuinely satisfied
  objective when reading the attempt trace later.

The module is pure — no I/O, no provider calls — reusing the existing pricing
table (`observability/cost.ts`) and the exact `ModelQualityStats` shape
`cost-router.ts` already defines (the same production judge-score registry
`quality-aware` routing feeds, gated by `CANARY_JUDGE_MODEL`), rather than
inventing a parallel quality signal.

### Wiring

`src/graph/handlers/llm.ts`'s existing model-selection block gained one
precedence check: `parseObjectiveConfig(node.config)` is tried first; only
when absent does the flow fall through to the older `parseRoutingConfig`. On
every solve, a `aiperator_objective_solver_total{node,outcome}` counter is
recorded and the full attempt trace is emitted via the EXISTING
`runtime.onNodeDiagnostic` pipeline (`code: "objective_solver_attempt"`) — no
new capture-point plumbing was needed anywhere else in the engine, because
`DebugNodeDiagnostic.details` was already a free-form `Record<string,
unknown>` designed for exactly this kind of structured, per-node event.

### Observability

`src/observability/explain.ts` gained `ExplainStep.objectiveSolver`: it finds
the LAST `objective_solver_attempt` diagnostic on a node's debug-trace
timeline (the retry/fallback candidate chain elsewhere in `llm.ts` can re-run
model selection; the final diagnostic is the one that actually determined the
model the step used) and projects it into the card. This is a strict
extension of the same transparency `ExplainStep.routing` already gives a
`router` node's decision — a reader of the Decision-Provenance Card (or its
Markdown export, or the signed Evidence Bundle from ADR-0020, which wraps the
same card) now sees every candidate an `llm` node's objective solver tried, in
cost order, and which declared clauses each one cleared. The dashboard's
**Explain** tab (`ExplainCard.tsx`) renders the same detail per step.

## Consequences

- **Positive.** A flow author can declare an arbitrary small combination of
  cost/quality constraints once, per node, instead of the platform needing a
  new named strategy for every combination an operator might want. The
  solve is exactly as inspectable as a `router` node's decision already was —
  extending, not introducing, the transparency bar ADR-0017 set. Zero new
  provider calls or hot-path writes: quality observations are the same ones
  `quality-aware` routing already records wherever a judge runs.
- **Negative / residual.** Only `quality` and `cost` metrics are supported in
  this iteration — a `latency` clause was considered and deliberately left
  out: no per-model latency-tracking registry exists yet in the codebase, and
  adding one just to support an as-yet-undeclared clause type would have
  been scope creep disproportionate to what was actually needed to ship.
  Adding a metric later is a small, additive change (one more case in
  `evaluateClauses`), not a redesign. The solver's guarantee is a **soft
  routing hint**, exactly like the underlying quality registry it draws
  from — proven cost/quality data comes from production judging, which some
  deployments (no `CANARY_JUDGE_MODEL` configured) will never have; those
  deployments' quality clauses stay permanently unproven/exploratory, which
  is an honest degradation, not a silent failure.
- `config.objective` taking precedence over `config.routing` when both are
  declared is a documented, deliberate choice (the former subsumes the
  latter) — a node author who declares both and expects `routing` to win
  would be surprised; this is called out explicitly in the README and the
  handler's own inline comment to prevent that surprise.

## Implementation

- `src/graph/objective-solver.ts` — `ObjectiveClause`, `ObjectiveConfig`,
  `parseObjectiveConfig`, `solveObjective`, `ObjectiveSolveResult`,
  `ObjectiveAttempt`.
- `src/graph/handlers/llm.ts` — dispatch precedence
  (`config.objective` over `config.routing`), `onNodeDiagnostic`
  (`objective_solver_attempt`), `aiperator_objective_solver_total` metric.
- `src/observability/explain.ts` — `ExplainStep.objectiveSolver`,
  `extractObjectiveSolverDetail`, Markdown rendering.
- `apps/control/src/components/ExplainCard.tsx` — per-step attempt-trace
  rendering.
- `src/graph/__tests__/objective-solver.test.ts`,
  `src/observability/__tests__/explain.test.ts`,
  `apps/control/src/__tests__/ExplainCard.test.tsx`.
