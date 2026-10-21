<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 31. Shared rate-limit backends and an explicit REPLICAS knob

Date: 2026-10-20

## Status

Accepted

## Context

ATF advertises stateless services that scale horizontally ("stateless, mehrere
Replicas"). Runtime and Gate largely delivered on that promise — their
rate-limit, concurrency, approval and idempotency stores move to Redis when
`REDIS_URL` is set, and the production gate refuses a memory backing in
production. Search and Extract did not: their HTTP rate limiters
(`RATE_LIMIT`, `REPLICAS`-relevant `RENDER_RATE_LIMIT`) were hard-wired to a
process-local GCRA map, and the Runtime's GitOps webhook router
(`POST /webhooks/git`, 10 req/min per IP) created its own in-memory store even
when a shared Redis store existed for `/v1/*`. A three-replica Search therefore
throttled each client at 3× the configured budget, and a webhook flood past one
replica's counter went unnoticed by the others — silently, with no operator
signal.

Auditing the remaining per-process state surfaced a second class of findings:
things that are *intentionally* per-replica (Gate SSE sessions, the metrics
ring, the stream-replay buffer, the model-pool cursor, budget-alert dedup, the
red-team scheduler) but equally invisible to operators, who had no declared
replica count to reason about and no gate that spoke up when a setting was
wrong for the topology they were actually running.

A latent bug found along the way made the stakes concrete: the security-kit's
Redis GCRA backend (and the Gate's per-identity limiter built on it) called
`client.eval(script, numKeys, ...keys, ...args)` — the redis-pkg v3 positional
signature. The installed `redis@5.x` parser reads the second argument as an
*options object* (`{ keys, arguments }`), so the legacy call produced
`EVAL script 0`: the Lua ran with zero keys, `KEYS[1]` was nil, the script
threw, and the backend's fail-closed default denied **everything**. Unit tests
missed it because the test fake mirrored the legacy call shape.

## Decision

1. **Backend injection in the kit middleware.**
   `createRateLimitMiddleware` (`@atf/security-kit`) accepts an optional
   `backend: RateLimitBackend` and an `onBackendError` hook. A backend exposing
   a synchronous `takeSync` keeps the middleware sync; a promise-returning
   backend (Redis) makes the middleware return a promise — Express/Hono handle
   both. Without a backend the behaviour is exactly the old process-local map.

2. **`RATE_LIMIT_REDIS_URL` for Search and Extract.** When set, both services'
   limiters run on a shared Redis GCRA backend (`createLazyRedisRateLimitBackend`
   in the kit: lazy cached connect, dynamic `redis` import so the package stays
   optional, failed connects are not cached so the next request retries).
   Extract's write limiter and render limiter use distinct key prefixes
   (`extract:rl`, `extract:render-rl`) so their different emission rates never
   share a bucket. These backends fail **open** on Redis errors — availability
   parity with the in-memory limiter they replace; the kit's Redis default
   stays fail-closed for security-critical consumers like the Gate.

3. **`REPLICAS` as a declared-topology knob.** Search, Extract and Runtime gain
   `REPLICAS` (default 1). It changes no runtime behaviour; the production
   gates use it: `REPLICAS > 1` without a shared store is a fatal (Search,
   Extract) or warning (Runtime) finding, and Runtime additionally warns when
   `REPLICAS > 1` with `RED_TEAM_SCHEDULE_FLOWS` set (every replica would run
   the schedule N× per interval).

4. **Runtime GitOps limiter shares the store.** `createHttpMiddleware` returns
   its `rateLimitStore` (Redis-backed when `REDIS_URL` is set) and the GitOps
   router uses it instead of a private in-memory store. No key collision: the
   `/v1/*` middleware keys `ip:<addr>`, the webhook keys the bare address.

5. **redis v5 EVAL signature fixed.** The kit's Redis backend and the Gate's
   per-identity limiter call `eval(script, { keys, arguments })` — the v4+/v5
   options-object form — with a regression test asserting the wire shape
   against the real parser's expectations.

## Consequences

- With `RATE_LIMIT_REDIS_URL` / `REDIS_URL` configured, the throttle budgets
  are genuinely per-client across the fleet, matching the stateless promise;
  forgetting the URL on a multi-replica deployment is a startup finding, not a
  silent 3× budget.
- The default (`REPLICAS=1`, no Redis URL) keeps single-container installs
  exactly as quiet and dependency-free as before — Redis stays optional.
- Fail-open on Search/Extract Redis errors is a deliberate availability trade:
  a Redis outage temporarily removes throttling on those data-plane services
  rather than denying service. The Gate's security-critical limiter keeps
  fail-closed semantics. For Extract this means a Redis outage lifts the
  request throttle in front of vision spend; the per-job token budget,
  `MAX_PAGES` and the per-tenant daily page budget still bound the cost, so
  alert on the "rate limit redis error — failing open" log line.
- Accepted residual per-replica state, now documented rather than hidden:
  Gate SSE sessions (sticky routing), the Runtime metrics ring and
  stream-replay buffer (per-pod views), the model-pool cursor (rotation
  fairness only), budget-alert dedup (a burst may alert once per replica), and
  the red-team scheduler (warned about via `REPLICAS`).
- The eval bug class is closed by a wire-shape test, not just a fake: any
  future backend must produce the options-object form the installed client
  parses. Deployments running the Gate with `store.type=redis` on redis v4+/v5
  were broken before this fix (all requests denied under fail-closed) — see
  the CHANGELOG Fixed entry.
- The Helm chart declares replicaCount: 2 and exports REPLICAS / MCPGATE_REPLICAS, so the production gates apply to a stock install; a shared Redis is required (global.redis).
- Still per process: the Runtime media store (show_figure links), the decision-receipt transparency log, and — without Redis — the Gate's pending approvals; the production gates warn about them when REPLICAS > 1.
