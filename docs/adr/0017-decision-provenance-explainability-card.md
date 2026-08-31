# 17. Decision-Provenance Explainability Card

Date: 2026-07-20

## Status

Accepted

## Context

The platform already records a rich, but scattered, set of per-execution
facts: `ExecutionStore` has the node path, per-node models/tokens/cost and the
routing decision at each `router` node; `DebugTraceStore` has an untruncated
overlay (full prompts/responses) in a bounded in-memory ring; the PII vault
(ADR-0007) knows what it tokenized, but discards the value-free provenance the
moment the run finishes streaming (`release()`); and the audit log (durable,
hash-chained) records operator actions like an approval decision, keyed by
execution id as `target`.

None of these individually answer the question an EU AI Act Art. 13
(transparency) / Art. 14 (human oversight) audit, or a curious end user,
actually asks: **"why did the agent answer this way?"** Reconstructing that
today means an operator manually cross-referencing four different endpoints
(`/monitoring/history/:id`, `/monitoring/debug/:id`, the PII vault status, and
`/monitoring/audit?...`) and mentally assembling a narrative. No AI-gateway
competitor ships this synthesis as a first-class artefact either — it is a
genuine differentiator, not merely another "safety control" checkbox.

## Decision

Add `src/observability/explain.ts` — a **pure, read-only aggregator** with no
new hot-path write — that assembles one `ExplainCard` from the four sources
above, exposed at `GET /monitoring/explain/:executionId` (+ `?format=markdown`
for a downloadable artefact, mirroring the compliance dossier / RoPA pattern).

Two small capture-point additions were needed because the underlying data
either wasn't retained at all, or was thrown away too early:

1. **Groundedness overlay in the debug trace.** The groundedness/citation gate
   already emits a `groundedness` SSE chunk per node but never persisted it
   anywhere. `DebugNodeTrace` gained an optional `groundedness` field, set from
   the same `GroundednessReport` the SSE callback already builds
   (`handler-factories.ts`'s `onGroundedness`) — no new gate logic, just
   retaining what already existed for one more consumer.
2. **PII vault action summary surviving `release()`.** The vault's entries
   (token→plaintext mappings) are deliberately short-lived — released as soon
   as a run finishes streaming, by design (ADR-0007). But a *count* of what was
   tokenized (never the values) carries no PII exposure risk and is exactly
   what an explainability card needs. `PiiVaultImpl` gained a bounded
   (500-entry) in-memory ring of `PiiVaultActionSummary` (`{ totalTokenized,
   byType, byDetector }`) keyed by execution id, populated at both tokenize
   sites and read via `getActionSummary()` — orthogonal to, and unaffected by,
   `release()`.

The card degrades gracefully rather than failing closed on a missing source:
a debug trace that aged out of its ring, an execution with no PII vault
activity, or a deployment with no audit log configured all still produce a
valid — just sparser — card, with the gaps enumerated in `card.degraded` so a
reader knows what is missing rather than assuming completeness.

### Why not persist a new "decision log" table instead?

Considered and rejected for this iteration: it would duplicate data the
platform already durably or semi-durably stores (execution history, audit
log), adding a write on the hot path for a report that is read rarely (on
demand, by an operator investigating one execution) — the wrong trade for a
feature whose entire value is *synthesis*, not new data collection.

## Consequences

- **Positive.** Zero new hot-path writes beyond the two capture points above
  (both cheap, in-memory, and already-computed data being retained one step
  further). Fully backward compatible — every field is additive/optional.
  Unit-tested independent of any real execution (`src/observability/__tests__/
  explain.test.ts`, `src/routes/__tests__/explain.test.ts`).
- **Negative / residual.** The debug-trace overlay (full groundedness detail)
  is only as complete as the bounded in-memory ring, and is per-replica — an
  execution served by a different replica than the one answering the
  `/monitoring/explain` request will show `debug_trace_unavailable` even
  though the trace exists elsewhere. This mirrors the same per-replica
  limitation the debug trace store already has for `/monitoring/debug/:id`,
  not a new one introduced here. The PII action-summary ring is similarly
  per-replica and bounded.
- **Routing/override provenance is observed, not re-derived.** The card reports
  the routing decisions the engine actually recorded (`NodeExecutionEvent.
  routing_decision`) rather than re-running `resolveNodeConfig`/dispatch logic
  against reconstructed state — the latter would risk silently diverging from
  what actually happened if the flow definition changed between execution and
  card-read time.

## Implementation

- `src/observability/explain.ts` — `buildExplainCard`, `renderExplainCardMarkdown`.
- `src/routes/explain.ts` — `GET /monitoring/explain/:executionId` (`monitoring:read`).
- `src/types/debug-trace.ts` — `DebugNodeTrace.groundedness` field.
- `src/graph/graph-engine/handler-factories.ts` — captures the groundedness
  report into the debug trace alongside the existing SSE emission.
- `src/graph/pii-vault.ts` — `PiiVaultActionSummary`, `getActionSummary()`.
- `src/index.ts` — wires the route off `monitoringService` (always has an
  execution store, even without a database) + the engine's debug trace store,
  PII vault, and audit log.
- `apps/control/src/components/ExplainCard.tsx` — dashboard panel, shown as an
  **Explain** tab on `/traces` alongside the step-by-step and span-waterfall
  views.
