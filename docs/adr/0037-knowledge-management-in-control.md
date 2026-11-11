# 37. Show the knowledge base in Control without breaking "Control talks only to the Runtime"

Date: 2026-11-11

## Status

Proposed

## Context

The operator dashboard covers the Runtime's own surface — flows, executions,
approvals, posture — but an operator who wants to answer "what is actually in
the knowledge base right now?" still has to leave the dashboard. Collections,
documents and extraction jobs live in Search and Extract, and Control has no
view on them. The review follow-up (F3) asks for that view.

The obstacle is not rendering, it is an architectural rule. Control is built so
that every backend call goes to the Runtime and nowhere else: the BFF proxy
(`apps/control/src/lib/bff-allowlist.ts`) forwards only Runtime path prefixes,
the browser holds only the Runtime session/API credential, and the Runtime is
the single place that turns an operator identity into a scoped
transaction token (ADR 0035). Search and Extract authenticate with their own
API tokens (`SEARCH_API_TOKEN`, `EXTRACT_API_TOKEN`); neither knows what an
operator is, and per ADR 0035 a token minted for one service must not be valid
at another. Giving the browser — or the Next server — direct Search or Extract
credentials would end that design: the dashboard would hold a second class of
long-lived service credentials, and every future authorization rule would have
to be enforced in two places.

Two ways out exist that keep the rule. Both are described here; neither is
implemented, and this ADR deliberately does not pick one without a review.

### What is actually behind those surfaces today

The endpoints a knowledge-base view needs already exist and are stable enough
to build against. From `docs/openapi/search.json`:

| Need | Search endpoint |
| --- | --- |
| List collections with metadata | `GET /collections` |
| Document/chunk counts per collection | `GET /collection-stats` |
| List documents in a collection | `GET /documents` |
| One document reassembled from chunks | `GET /document` |
| Folder navigation | `GET /folders` |
| Stored summaries | `GET /summaries`, `GET /summary` |
| Recent ingest/search statistics | `GET /admin/stats` |

From `docs/openapi/extract.json`:

| Need | Extract endpoint |
| --- | --- |
| Persistent extraction jobs (create, list) | `GET /v2/jobs` |
| Queue overview (queued/running/failed counts) | `GET /v2/jobs/summary` |
| One job's status | `GET /v2/jobs/{id}` |
| Job controls (pause/resume/cancel/retry-failed/reparse) | `POST /v2/jobs/{id}/…` |
| Figures extracted by a job | `GET /v2/jobs/{id}/figures` |

Search also owns the mutating side (`POST /ingest`, `POST /ingest-batch`,
`DELETE /delete`, `DELETE /collections/{name}`, the whole `/v2/...` revision
protocol); Extract owns `POST /v2/uploads` and `POST /v1/ingest`. This ADR
scopes the dashboard to **read-only** in both directions: a dashboard that can
drop a collection is a different risk conversation, and the write paths already
have better frontends (the ingest APIs and the Outpost).

## Decision

Proposed for review — one of the two options below becomes the decision once a
human reviewer picks it. Both options share the same constraints:

- read-only endpoints only;
- tenant scoping enforced server-side, never by a UI filter;
- no new long-lived credential in the browser or in the Next server;
- every proxied path enumerated in an allowlist, mirroring
  `bff-allowlist.ts`'s posture (prefix match at segment boundaries, default
  deny).

### Option (a) — a thin read-only Runtime proxy

The Runtime gains a small set of operator-scoped routes that fetch from Search
and Extract with the Runtime's existing service credentials and the operator's
identity attached, e.g.:

```
GET /monitoring/knowledge/collections      → Search  GET /collections, /collection-stats
GET /monitoring/knowledge/documents        → Search  GET /documents, /document, /folders
GET /monitoring/knowledge/jobs             → Extract GET /v2/jobs, /v2/jobs/summary
```

Control adds one page and three allowlist prefixes; it learns nothing new about
Search or Extract.

- **Files touched.** Runtime: a new `routes/knowledge.ts` (shape mirrors
  `routes/services.ts` — `operatorAuth.authorize(header, token,
  "monitoring:read")`), registration in `bootstrap/routes-management.ts`,
  `openapi.ts` META_RULES entry, regenerated route table/OpenAPI. Control: one
  page under `(dashboard)/knowledge/`, `nav.ts` entry, both catalogues,
  `bff-allowlist.ts` prefixes, mock-backend routes.
- **Permissions.** A new operator scope (e.g. `knowledge:read`) rather than
  reusing `monitoring:read`, because the payload is corpus content, not
  operational metrics: document titles and folder names are the customer's
  data. Whether `GET /document` (full reassembled text) is inside the scope or
  a second, stricter one is the main open question for review.
- **Tenant separation.** The Runtime must pass the operator's tenant through:
  Search's list endpoints take a collection/tenant filter, and the proxy must
  derive it from the verified operator identity, not from a query parameter.
  This is exactly the transaction-token pattern of ADR 0035 — the Runtime
  mints a Search-audience token carrying the tenant, and Search enforces it.
  The deviation to note honestly: ADR 0035's tokens authorize *executions*;
  reusing the mechanism for an operator-initiated read needs either a new
  audience or a claim distinguishing the two, and Search must reject the wrong
  kind. That is real work on both sides, not a call-site change.
- **Cost.** Roughly: Runtime route + auth + tests ≈ 2–3 days; Search-side
  token-claim acceptance ≈ 1–2 days; Control page + i18n + e2e ≈ 2–3 days.
  The OpenAPI/route-table regeneration is mechanical.

### Option (b) — embed the existing surfaces

Search and Extract already render their own status UIs (Search's `/admin/stats`
backs an admin view; Extract's job queue is visible in its deployment). The
dashboard would link out — or frame — those surfaces instead of re-implementing
them. The F2 services page (`SERVICE_LINKS`, `GET /monitoring/services`,
`/services` in Control) is exactly this option in its weakest form: links, no
embedding.

- **Files touched.** None beyond `SERVICE_LINKS` entries; a stronger form
  (iframe) touches Control's CSP (`src/lib/csp-policy.ts` — `frame-ancestors`
  and `frame-src` today keep services out of frames deliberately) and Search's
  and Extract's own auth flows, which are API-token based and have no operator
  session to render an authenticated page with.
- **Permissions.** Unchanged — the operator authenticates at the embedded
  surface with that service's own credential.
- **Tenant separation.** Not the dashboard's problem any more; each service
  enforces its own. But that is also the weakness: an operator with the Search
  API token sees **all** tenants, because Search tokens are per-deployment,
  not per-operator. There is no per-operator tenancy to inherit.
- **Cost.** Near zero for links; the iframe variant is more expensive than
  option (a), not less, because it requires a session mechanism for Search and
  Extract that does not exist.

## Options considered and rejected

- **Browser talks to Search/Extract directly.** Rejected: puts service
  credentials in the dashboard, duplicates the authorization surface, and
  breaks the BFF's default-deny posture. This is the rule the ADR exists to
  protect.
- **The Next server proxies to Search/Extract with service tokens from its own
  environment.** Rejected: Control becomes a second backend with its own
  secrets, outside the Runtime's audit trail. Every knowledge-base read would
  bypass the Runtime's logging, posture checks, and production gate — the
  audit story (Req 8, ADR 0026) would have a hole exactly where corpus data is
  read.
- **Replicate a metadata view into the Runtime's database.** Rejected: a second
  copy of "what is in the knowledge base" that is always slightly stale, with
  no invalidation story.

## Consequences

- **If (a) is accepted:** the Runtime becomes (thinly) a gateway for operator
  reads of two more services. That is a real widening of its role — it is
  already the gateway for model traffic, tools, and monitoring; knowledge-base
  reads are the same shape, but the ADR text in 0035 should get a pointer here
  so the token-claim extension is traceable.
- **If (b) is accepted:** F3 closes with the services page and a documentation
  entry, and the dashboard stays honest about not covering the corpus. The
  operator still cannot answer "how many documents does tenant X have" without
  leaving the dashboard.
- **Either way:** the read-only boundary stated above should be written into
  `docs/CAPABILITIES.md` (Operator interface) so the next reviewer does not
  re-open the write-path question by accident.
- **Not decided here:** write operations (ingest, delete, collection drop),
  per-document content preview under a stricter scope, and whether Search's
  `/admin/stats` deserves its own tile on `/overview`.
