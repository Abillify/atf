<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Scaling

ATF services scale independently; the databases and the LLM provider quota are
the usual bottlenecks. The Helm chart carries no replica counts — the
deployment system supplies them (see `DEPLOYMENT.md`, repository boundary).

## Sizing baseline (per service)

| Service | Scales with | First bottleneck | Lever |
| --- | --- | --- | --- |
| Runtime (3000) | Concurrent executions, tokens/s | Provider rate limit, then DB pool | Replicas; `DATABASE_POOL_MAX` |
| Gate (3003) | SSE connections, MCP sessions | File descriptors per SSE | Replicas + sticky routing for `/sse` |
| Search (3002) | Query rate, index size | Postgres (vector scan) | Replicas; index maintenance |
| Extract (3004) | Document pages/min | CPU during conversion | Replicas; `MAX_PAGES`, converter isolation |
| Control (3001) | UI users | — (Next.js, cheap) | Replicas |

## Horizontal scaling

1. All services are stateless **except**: Gate SSE sessions and in-memory rate
   limiters are per-process. Behind a load balancer use least-connection
   balancing; sticky sessions are required only for `/sse` and `/monitor/stream`
   (per-process connection state).
2. Scale Runtime on queue depth, not CPU: `GET /monitoring/queue` exposes
   pending executions; a good HPA target is "pending > 2× replicas sustained 2
   min". CPU is misleading because executions wait on LLM I/O.
3. Scale Extract on job backlog (`extract.jobs` rows in `queued`/`running`).
   Conversion is CPU-bound — give Extract pods CPU limits, not shared bursts, so
   one big PDF cannot starve neighbours.
4. The isolated converter (`CONVERTER_MODE=isolated`) runs as a sidecar next to
   Extract with the same `CONVERTER_SOCKET` and scratch volume — scaling Extract
   scales the converter 1:1 automatically; do not run a shared converter pool.

## Database

- Every Runtime replica opens at most `DATABASE_POOL_MAX` connections; total
  connections ≈ replicas × pool. Check against Postgres `max_connections`
  **before** raising replicas:
  `SELECT count(*) FROM pg_stat_activity;`
- If connections are the limit, raise Postgres `max_connections` or add PgBouncer
  (transaction mode) — do not shrink the pool below the burst concurrency or
  executions start queueing on checkout.
- Search vector queries degrade with index size; monitor p95 query time and plan
  partitioning/archival before it reaches seconds.

## LLM provider quota

Provider 429s are the most common "scale" incident. ATF's router retries and
falls back per model configuration; check `GET /v1/models` health and the
per-model error rates in `/metrics` before adding replicas — more replicas
against a fixed quota only multiplies 429s. Raise the quota with the provider or
add a fallback model instead.

## Load shedding

Under S1 overload, shed in this order (least damage first):

1. Disable non-interactive triggers (`/triggers` pause via Control).
2. Reduce `MAX_PAGES` on Extract to reject pathological documents early.
3. Scale Control to zero (UI only; API unaffected).
4. Only then shed Runtime chat traffic at the gateway.

## Autoscaling anti-patterns

- HPA on CPU for Runtime (I/O-bound — see above).
- Scaling Gate replicas without sticky `/sse` → reconnect storms.
- Restoring scratch volumes as "backup" (see `backup-restore.md`) — corrupts
  Extract.
