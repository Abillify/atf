<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Redis Outage

Redis is shared infrastructure but not on the critical path for correctness:
every consumer degrades in a defined way. This runbook lists the per-service
behaviour, the log lines to alert on, and the recovery procedure.

Prerequisite: the `redis` package must be installed in the image of any service
that sets a Redis URL — the client loads lazily on the first request, so a
missing package only surfaces during an outage-relevant moment.

## Per-service behaviour during an outage

### Search and Extract — rate limiters fail **open**

Both request rate limiters (`apps/search/src/rate-limiter.ts`,
`apps/extract/src/rate-limiter.ts`) use `failMode: "open"`: if Redis errors,
the request is allowed. For Extract this means an outage removes the request
throttle entirely — an abusive or runaway client is no longer slowed down.

Log line to alert on (both services):

```text
rate limit redis error — failing open
```

Mitigate during a long outage by throttling at the gateway or ingress.

### Gate — identity rate limiter fails **closed** by default

The Gate's per-identity limiter (`apps/gate/src/server/identity-rate-limit.ts`)
reads `failMode` from config; the default is `closed`, i.e. a Redis error
rejects requests rather than allowing them. Expect user-visible 429/503-style
rejections during an outage unless `failMode` was explicitly set to `open`.

Log line to alert on:

```text
identity rate-limit redis check failed (failMode=<mode>): ...
```

### Runtime — `REDIS_URL` consumers degrade per component

- **Rate-limit store** (`middleware/rate-limit.ts`): fails **open** by default
  (`failMode` parameter defaults to `"open"`), logging
  `Rate-limit store error — allowing request (fail-open)`. Requests are not
  throttled while Redis is down.
- **Distributed approval gate** (`graph/distributed-approval.ts`): fails
  **soft** — Redis errors degrade to the local view only, logging
  `Approval listPending Redis error — returning local view only`. Approvals
  taken on other replicas are temporarily invisible.
- **OIDC session store** (`routes/oidc-session-store.ts`): reads fail
  **closed** — a session lookup error is treated as "no session", so users
  re-authenticate. Log lines: `OIDC session store GET failed — treating as no
  session`, `OIDC session store SET failed (silent renew may be unavailable)`.
- **Response cache** (`graph/response-cache.ts`): the shared cache store is
  used only when `REDIS_URL` is set; on errors the cache is simply missed and
  responses are recomputed.
- **Thread lock** (`bootstrap/engine.ts`, `createRedisThreadLock`): thread
  serialization degrades to the per-process view; avoid editing the same
  thread on two replicas during the outage.
- **Transaction ledger** (`transaction/ledger.ts`): ledger writes go through
  Redis scripts; while Redis is down, transactional bookkeeping that depends
  on it fails — pause new transactions that require the ledger rather than
  retrying in a loop.

## Alerting

Alert on the log lines above (they are the only signal for the fail-open
paths), plus generic Redis health (connectivity, memory, evictions). A
sustained `rate limit redis error — failing open` stream on Extract should be
treated as a throttle-loss incident, not just noise.

## Recovery

1. Restore Redis (or point the URLs at the failover instance) and confirm
   `PING` succeeds from each service's network namespace.
2. Restart order does not matter — clients reconnect — but restart a service
   if its client keeps erroring after Redis is healthy.
3. Verify recovery:
   - Search/Extract: the `rate limit redis error — failing open` log line
     stops and limits are enforced again.
   - Gate: identity checks pass again (if `failMode=closed`, user traffic
     recovers immediately).
   - Runtime: sessions resolve without re-auth storms; approval lists show
     cross-replica entries again.
4. Check for fallout from the degraded window: OIDC re-authentications,
    approvals that were only visible locally, and any transactions paused
    while the ledger was unavailable.
