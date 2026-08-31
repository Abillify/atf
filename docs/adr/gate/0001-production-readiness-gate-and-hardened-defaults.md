# ADR-0001: Production-readiness gate and hardened defaults

- **Status:** Accepted
- **Date:** 2026-08-02
- **Context repo:** mcpgate

## Context

mcpgate's defaults were tuned for the case it was built for: drop it on a laptop,
point an IDE at it, get database tools over MCP in minutes. That produced a set
of choices that are correct for local use and wrong for a shared deployment:

- `/metrics` enabled and served to anyone who could reach the port.
- MCP sessions held in a plain in-process `Map`, pruned only when a client sent
  an explicit `DELETE` or its transport emitted `close`.
- No statement timeout on pooled database connections.
- `auth.oauth.issuer` and `auth.oauth.audience` merely *optional*.
- Monitor events carrying full tool arguments, full result rows and the entire
  decoded token payload into the dashboard buffer, the audit file and (when
  configured) a Redis channel.
- Start-up produced **warnings** for the open dashboard, `playground.allowWrite`
  and `router.llm.forwardBearerToken` — and nothing else.

aiperator, the primary consumer, had already adopted a *production-readiness
gate*: a permissive setting aborts start-up in `production` and warns everywhere
else. The asymmetry mattered in practice — an operator could satisfy aiperator's
gate and still deploy mcpgate wide open.

## Decision

**1. Adopt aiperator's production-readiness gate contract.**
`src/config/prod-gate.ts` returns `{ fatal, warnings, environment }`;
`src/index.ts` logs the warnings and `process.exit(1)`s on any fatal finding.
The environment comes from `MCPGATE_ENV`, falling back to `NODE_ENV` — and the
Dockerfile already sets `NODE_ENV=production`, so a containerised deployment is
gated with no extra configuration. That is deliberately the deployment that
needs it.

The gate is a pure function; start-up decides what to do with its output. This
keeps every rule unit-testable without a process exit.

**2. Close the defaults the gate would otherwise merely complain about.**

| Area | Before | Now |
| --- | --- | --- |
| `/metrics` | open | bearer token, or loopback-only when no token is set. `allowUnauthenticated: true` is an explicit, gate-fatal opt-out |
| MCP sessions | unbounded `Map` | `SessionStore` with an idle timeout (30 min) and a hard cap (2 000/instance) |
| DB connections | no timeout | `statementTimeoutMs`, default 30 s, applied per pooled connection |
| OAuth `iss`/`aud` | optional | **required**, with named `allowAnyIssuer` / `allowAnyAudience` opt-outs |
| Monitor/log payloads | verbatim | structural redaction at a single choke point |

**3. Refuse rather than evict when the session cap is reached.**
A new `initialize` beyond the cap gets `503` + `Retry-After`. Evicting a
stranger's live session to admit a newcomer would turn one client's misbehaviour
into everyone's outage and hide the capacity problem.

**4. Redact once, in `MonitorBus.publish`.**
There are four consumers of a monitor event (dashboard ring buffer, SSE
subscribers, audit file, Redis cluster bridge). Redacting at each of them
guarantees that the fifth one added later will leak. A single choke point is the
only version of this that stays true.

Claims use an **allowlist** (`sub`, `scope`, `preferred_username`, … — not
`email`, not `name`) because a token payload is a small, enumerable shape whose
purpose is to carry identity attributes. Tool arguments and results are
arbitrary, so they get a key **denylist** plus size caps.

## Consequences

**Good**

- A production deployment cannot start wide open by accident.
- Repeated `initialize` calls are no longer an unauthenticated-shaped memory
  exhaustion path.
- A pathological tool query costs one failed call instead of a pool slot held
  until the client goes away — which, over a long-lived MCP session, can be never.
- Audience confusion is closed: a token the same IdP minted for a *different*
  service no longer authenticates here.

**Costs and limits, stated plainly**

- **Breaking config change.** An existing `auth.oauth` block without `issuer` or
  `audience` now fails validation. This is intentional: the safe configuration
  should not be the one an operator has to discover. The error message names the
  opt-out flag.
- **`compose.yaml` sets `MCPGATE_ENV=development`.** The bundled example uses a
  short shared token, an open dashboard and superuser database logins, and the
  image sets `NODE_ENV=production`, so the gate would (correctly) refuse to
  start. Declaring the example as development keeps it usable while leaving the
  gate meaningful. The file says, in a comment, not to copy that line into a
  deployment.
- **Sessions remain per-process.** An MCP session owns a `Server` object and a
  live transport; that state is not serialisable, so it cannot be shared across
  replicas by moving metadata into Redis. Horizontal scaling still requires
  sticky routing on `Mcp-Session-Id`. The bounds fix memory growth, not
  distribution — documented rather than papered over.
- **Redaction is not a PII policy.** It removes credential- and
  identifier-*named* fields and caps payload size. A column called `name` still
  reaches the monitor. That is what the per-tool `redact` configuration and
  `monitoring.redact.extraKeys` are for.
- **SQL Server has no true statement timeout.** `LOCK_TIMEOUT` is the closest
  session-level cap and covers lock waits; a CPU-bound scan is not capped. Named
  in the code comment rather than implied.

## Alternatives considered

- **Warn louder instead of failing.** Rejected: the previous behaviour *was*
  warnings, and they did not prevent the misconfiguration this ADR exists to
  address.
- **Always fatal, regardless of environment.** Rejected: it would make local
  development unpleasant, and the realistic response to a gate that always fails
  is to switch it off.
- **Redis-backed session store for HA.** Rejected as impossible in this shape,
  not merely expensive — see above.
- **Evict LRU on cap.** Rejected — see decision 4.


## Webhook hardening addendum

Inbound webhook tools are a separate trust boundary: they do not pass through MCP
bearer/OIDC authentication. Production therefore requires each enabled webhook to
use HMAC with a secret, a trusted static `tenantId`, a finite payload `ttlSeconds`,
and the default replay-protection block. The HMAC canonical input is versioned JSON
containing `method`, `path`, configured `tenantId`, Unix-seconds timestamp, nonce,
and the base64 form of the exact raw body. Timestamp and nonce headers are mandatory
for HMAC webhooks. A process-local TTL/LRU nonce cache (`300s` age, `30s` skew,
`330s` cache TTL, `10,000` entries by default) rejects replays with HTTP 409.

Payloads are held in a tenant partition keyed only by the operator-configured
`tenantId`; reads require the same tenant from an already verified `tenant`, `tid`,
or `client_id` claim. `X-Tenant-*` and every other request header are intentionally
ignored. This avoids a cross-tenant cache leak and prevents a caller from selecting
another bucket with a header. The replay cache is per process; multi-replica
operators need sticky webhook routing or a shared replay store before claiming
cluster-wide replay guarantees.
