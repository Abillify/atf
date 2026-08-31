# 23. Durable Agent Runtime

Date: 2026-08-02

## Status

Accepted

## Context

The async/batch job mode (`job-store.ts`) already lets a client submit a
long-running flow execution and poll for the result later (`POST
/v1/chat/completions` with `metadata.async: true` → `202` + a job id, then
`GET /v1/jobs/:id`). Two implementations back it — an in-memory LRU and a
Redis-backed store — and the Redis one is already **durable across a
process restart**: the job *record* survives.

What none of that protected against: the job *executing*. `dispatchAsyncJob`
ran the flow in a detached `void (async () => {...})()` with no lease, no
heartbeat, and no signal to anything else if the process running it died
mid-flight. A crashed replica left the job's `status` frozen at `"running"`
forever — durable storage kept the stale record perfectly, which is exactly
the problem: nothing ever looked at it again to notice execution had
actually stopped. A client polling `GET /v1/jobs/:id` had no way to tell
"still working" apart from "abandoned".

## Decision

### Scope, stated precisely

This ADR delivers crash-**resilience**: the client eventually gets a real
terminal result (success or a stated failure) instead of a job stuck in
`running` indefinitely. It does **not** deliver exact mid-flow resumption —
a retried attempt re-runs the whole flow from a snapshot taken at
submission, not from wherever the crashed attempt had gotten to. True
mid-flow resumption would require every async job to establish a LangGraph
checkpoint thread (`checkpointer.ts`, keyed by a client-supplied
`conversation_id`), which async jobs do not do today; threading that through
is a materially larger change (partial-turn resumption semantics, deciding
what "resume" means for a job that had already streamed some tokens) that
is deliberately left for a later iteration rather than folded into this one
under a name ("durable") that would overclaim what it does.

### Lease + heartbeat, not a new consensus primitive

`JobRecord` gained `attempt`, `maxAttempts`, `leaseExpiresAt`, and
`resumePayload`. `markRunning(id, leaseMs?)` optionally starts a lease;
`heartbeat(id, leaseMs)` renews it (and, mirroring
`distributed-semaphore.ts`'s own heartbeat semantics, returns `false` rather
than resurrecting a lease already reaped from under a stalled caller);
`listOrphaned(nowMs)` finds `running` jobs whose lease has passed.

This deliberately reuses the shape `distributed-semaphore.ts`'s
`ACQUIRE_LUA`/`HEARTBEAT_LUA` already established for cluster-wide leases,
but not the Lua script itself — a semaphore's lease is a shared-capacity
sorted set (many holders, one key, over/under capacity is the whole
question); a job's lease is one key with one holder. The Redis
implementation instead maintains a single sorted-set INDEX
(`aiperator:jobs:running`, scored by `leaseExpiresAt`) so the periodic sweep
can find orphans with one `ZRANGEBYSCORE` instead of a `SCAN` over the
entire job keyspace (most of which is terminal, not running, on any real
deployment).

### The sweeper: retry, or fail cleanly — never resurrect silently

`job-recovery-sweeper.ts`'s `JobRecoverySweeper` mirrors
`optimizer-scheduler.ts`'s shape exactly (`tick()` exposed for tests/manual
runs, `start()`/`stop()` wrapping a `setInterval`, an overlap guard) — this
codebase's established pattern for "a periodic background pass over a
store", reused rather than reinvented. On each tick, for every orphaned job:
retry (via `requeueForRetry` + the injected `JobRetryRunner`) when attempts
remain and a `resumePayload` was recorded, else `fail` with a stated reason.

`requeueForRetry` checks `status === "running"` before requeuing — a real
bug caught while writing its tests: without that check, a job that settled
(completed, failed, or was already requeued) between `listOrphaned()` and
`requeueForRetry()` could be silently pulled back to `"queued"`, undoing its
actual, already-correct outcome. This is exactly the failure mode
`HEARTBEAT_LUA`'s own "only renew if the token is still present" check
exists to prevent, applied to the job store's simpler single-key lease.

### One execution path, used by both a first attempt and a retry

`runJobAttempt()` (in `metering.ts`) is the shared execution/settlement
logic: it marks the job running (with a lease when recovery is enabled),
runs a heartbeat timer for the duration of the flow (renewing at a third of
the lease window — the same margin the distributed semaphore's own
heartbeat uses relative to its `ttlMs`), executes the flow, and settles
`complete`/`fail`. Both `dispatchAsyncJob`'s first attempt and
`createJobRetryRunner`'s sweeper-driven retries call it — a retry is not a
second, subtly different code path that could drift from what the original
submission did.

### `resumePayload` excludes the caller's secret and preserves verified authorization

`JobResumePayload` carries the flow id, messages, and the already verified,
non-secret authorization context (`clientId`, `userId`, `role`, groups and
decoded claims) needed to repeat the same Execution Admission decision after a
crash. It never carries `ssoToken`, refresh tokens, provider keys, or other
credentials. Recovery therefore cannot silently lose `requiredScopes` or role
constraints, while durable storage still contains no reusable bearer secret.
If a future identity mechanism cannot be represented without a credential, its
jobs must be marked terminal instead of retried with weaker authority.

### `createJobRetryRunner` does not reconstruct the rich `finalize` closure

`dispatchAsyncJob`'s caller (`chat.ts`/`responses.ts`) builds a per-request
`finalize` closure carrying metrics, billing, canary/AB variant assignment,
idempotency, and shadow-mode side effects — all genuinely request-scoped
state that does not exist for a background retry initiated by the sweeper.
Reconstructing it would mean re-deriving canary bucket assignment and other
decisions a retry has no legitimate basis to make independently. The retry
runner therefore settles the job via the same `runJobAttempt()` path but
does not call that closure — the client reliably gets a result; a retried
attempt's contribution to cost/quality telemetry is a stated, narrower scope
than a first attempt's, not a silently dropped one.

## Consequences

- **Positive.** A crashed async job is now detectable (an expired lease) and
  recoverable (a bounded retry) instead of silently stuck. Zero new
  cluster-coordination primitive was introduced — the Redis running-index is
  a single sorted set, not a new lock service. `GET /v1/jobs/:id` exposes
  `attempt`/`max_attempts` so a client (or the dashboard's new `/jobs`
  lookup page) can tell a recovered job apart from one that simply took a
  while.
- **Negative / residual.** A retried attempt is a full re-run, which costs
  the same as the original attempt again — for a flow with real side
  effects beyond producing a chat response (e.g. a tool call that is not
  idempotent), a retry could repeat that side effect. This ADR does not add
  idempotency tracking for *tool calls within* a retried flow (the platform's
  existing `idempotency-store.ts` covers request-level idempotency, not
  intra-flow tool-call idempotency) — a flow author whose tools have
  non-idempotent side effects should not enable `JOB_RECOVERY_ENABLED` for
  that flow, or should make the relevant tools idempotent, same as they
  would need to for any other retry mechanism.
- Recovery is opt-in (`JOB_RECOVERY_ENABLED`, default `false`) and requires
  `JOBS_ENABLED=true` — a deployment that has not turned it on keeps the
  exact pre-existing (non-recoverable) async-job behaviour unchanged.

## Implementation

- `src/graph/job-store.ts` — `JobRecord.attempt`/`.maxAttempts`/
  `.leaseExpiresAt`/`.resumePayload`, `JobResumePayload`,
  `JobStore.heartbeat`/`.listOrphaned`/`.requeueForRetry`,
  `InMemoryJobStore`/`RedisJobStore` implementations (Redis: `aiperator:jobs:running` ZSET index).
- `src/graph/job-recovery-sweeper.ts` — `JobRecoverySweeper`,
  `createJobRecoverySweeper`, `JobRetryRunner`.
- `src/routes/chat/metering.ts` — `runJobAttempt` (shared execution path),
  `dispatchAsyncJob`'s `jobRecovery` option, `createJobRetryRunner`.
- `src/routes/chat.ts`, `src/routes/responses.ts` — `jobRecovery` wiring
  through `ChatRouterOptions`.
- `src/routes/jobs.ts` — `attempt`/`max_attempts` on `GET /v1/jobs/:id`.
- `src/config/schema.ts`, `src/config/load.ts` — `JOB_RECOVERY_ENABLED`/
  `_MAX_ATTEMPTS`/`_LEASE_MS`/`_SWEEP_INTERVAL_MS`.
- `src/index.ts` — sweeper construction + `start()`, gated on a job store
  being present and recovery being enabled.
- `apps/control/src/components/JobsPanel.tsx`, `apps/control/src/app/(dashboard)/jobs/page.tsx` —
  single-job lookup UI (no listing view — the backend has no admin listing
  route for jobs, unlike assistants; adding one was out of this feature's
  scope).
- `src/graph/__tests__/job-store.test.ts`,
  `src/graph/__tests__/job-store-redis.test.ts`,
  `src/graph/__tests__/job-recovery-sweeper.test.ts`,
  `src/routes/chat/__tests__/dispatch-async-job.test.ts`,
  `apps/control/src/__tests__/JobsPanel.test.tsx`.
