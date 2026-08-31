# 2. Optional dependencies with graceful degradation

Date: 2026-06-14

## Status

Accepted

## Context

aiperator is deployed across very different tiers: a single-process developer
box, a single container, and a multi-replica Kubernetes cluster with Postgres
and Redis. We want one codebase that runs in all of them without a "lite" build,
and we do not want a missing optional dependency to crash the server or silently
change correctness.

## Decision

Every infrastructure dependency beyond the LLM provider is **optional and
additive**, selected by an `AppConfig` flag and/or the presence of a connection
URL:

- **Postgres** (`DATABASE_URL`): durable cost ledger, audit/history, checkpoints,
  pgvector caches/RAG/memory. Absent → in-memory per-replica equivalents.
- **Redis** (`REDIS_URL`): cluster-wide monitoring fan-out, rate limiting,
  concurrency limiter, thread lock, response cache, **idempotency**. Absent →
  in-process equivalents.
- **Caching / guardrails / RBAC / BYOK / tracing / tickets**: each off by
  default, no-op when disabled.

Each feature picks a deliberate failure posture:

- **Security controls fail closed** — a malformed `access.json` denies all; a
  guardrail in `block` mode rejects on match.
- **Availability primitives fail open** — a Redis outage for the rate limiter,
  thread lock, global concurrency limiter or idempotency store degrades to prior
  behaviour rather than blocking traffic (overridable to closed where abuse
  protection outweighs availability, e.g. `RATE_LIMIT_FAIL_MODE=closed`).

The wiring lives in `src/index.ts`, which constructs the in-memory or
distributed implementation behind a shared interface and injects it.

## Consequences

- One build, three deployment tiers; `docker-compose up` works with nothing
  external configured.
- Interfaces (`IdempotencyStore`, `ThreadLock`, caches, stores) have both an
  in-memory and a Redis/Postgres implementation. New durable features must
  provide the in-memory fallback too.
- The trade-off of each fallback (e.g. per-replica budgets without Postgres) is
  documented at the call site and in the README, so operators know what they
  give up by not configuring the dependency.
