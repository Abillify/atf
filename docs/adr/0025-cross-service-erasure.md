<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 25. Cross-service erasure orchestrated by the Runtime

Date: 2026-10-08

## Status

Accepted

## Context

A data-subject erasure request (GDPR Art. 17) touches personal data spread
across four services: the Runtime (executions, PII-vault entries, retention
targets), Search (documents, revisions and search statistics), Extract
(documents and derived artifacts) and the Gate (its file audit sink).
Letting a human call four private endpoints in the right order is neither
auditable nor repeatable, and a partial run (Search reachable, Extract down)
must not silently report success.

## Decision

The Runtime is the entry point. Its erasure orchestrator
(`apps/runtime/src/compliance/erasure-orchestrator.ts`) serves the
self-service `DELETE /v1/me/data`, the operator DSAR
`POST /admin/compliance/forget` and tenant offboarding. It erases the
Runtime's own retention targets and fans the request out, in parallel, to
the `POST /v1/erasure` endpoints listed in `ERASURE_TARGETS`
(`[{service, url, tokenEnv}]`), with a per-call timeout and up to three
attempts with exponential backoff.

The self-service subject comes from the verified token only: `iss` and
`sub` are required and `sub` is the key; `email` counts as an identifier
only with `email_verified: true`, because several issuers can be trusted at
once and many IdPs let users choose their email. A token without a tenant
claim is refused (403 `TENANT_REQUIRED`) — self-service never erases across
tenants; that remains an operator action.

Each service implements `POST /v1/erasure` for its own stores only and
requires a dedicated scope — erasure is not implied by general admin
access: Search `vectorsearch.erasure`, Extract `extract.erasure`, Gate
`gate.erasure` (`apps/gate/src/server/erasure-routes.ts`). The Gate endpoint
erases subject events from its file audit sink (Req 2.8); a sink configured
as append-only reports `not_configured` instead of pretending. Every
endpoint is idempotent over `requestId`: a fingerprint over the
ZOD-parsed, canonically sorted request body makes semantically equal
retries replay the stored result instead of deleting again, and a reused
`requestId` with a different payload is rejected.

The shared request/response schema lives in `@atf/erasure-contract`. Each
store reports `ok`, `failed` or `not_configured`; the orchestrator persists
the operation with its per-store results in `erasure_requests` (migration
44) and aggregates them: `complete` when no store failed (`not_configured`
is a deliberate state, not a failure), `partial` for a mixed outcome,
`failed` when every store failed. The routes map this to HTTP 200, 207
(`ERASURE_PARTIAL`) and 502. Failed stores can be re-driven with
`POST /admin/compliance/erasures/{id}/retry`, which re-runs only the failed
ones. When a receipt signing key is configured, an operation with store
results yields a signed Erasure_Receipt (Ed25519 over canonical JSON,
status `complete` or `partial`), served by `GET /v1/me/data/erasures/{id}`.

Every erasure operation, including partial ones, is recorded through the
required (fail-closed) audit path of the Runtime. The Runtime's hash-chained
audit log itself is not erased: it is append-only (migration 42), and the
erasure action is recorded instead (accountability over deletion of the
trail).

## Consequences

- One authenticated, scoped, idempotent entry point for Art. 17 requests;
  retries are safe and the aggregate status is honest about partial
  failures.
- Erasure availability survives individual service outages: the operation
  completes partially and can be re-driven through the retry route.
- A service missing from `ERASURE_TARGETS` is not erased; operators must
  keep the list complete for their deployment.
- `partial` must be treated as an incident state by operators (see the
  incident runbook); monitoring should alert on non-`complete` results.
