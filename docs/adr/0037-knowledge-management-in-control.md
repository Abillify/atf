# 37. Show the knowledge base in Control without breaking "Control talks only to the Runtime"

Date: 2026-11-11

## Status

Accepted (2026-11-12). Option (a), a read-only Runtime proxy, is the decision. Not yet
implemented; the implementation plan is part of this record.

## Context

The operator dashboard covers the Runtime's own surface — flows, executions, approvals,
posture — but an operator who wants to answer "what is actually in the knowledge base right
now?" still has to leave the dashboard. Collections, documents and extraction jobs live in
Search and Extract, and Control has no view on them.

The obstacle is not rendering, it is an architectural rule. Control is built so that every
backend call goes to the Runtime and nowhere else: the BFF proxy
(`apps/control/src/lib/bff-allowlist.ts`) forwards only Runtime path prefixes, the browser holds
only the Runtime session or API credential, and the Runtime is the single place that turns an
operator identity into a scoped transaction token (ADR 0035). Search and Extract authenticate
with their own service credentials (`API_TOKEN` per service, or OIDC); neither knows what an
operator is, and per ADR 0035 a token minted for one service is refused by another. Giving the
browser — or the Next server — direct Search or Extract credentials would end that design: the
dashboard would hold a second class of long-lived service credentials, and every future
authorization rule would have to be enforced in two places.

### What is behind those surfaces today

The endpoints a knowledge-base view needs exist (checked against `docs/openapi/search.json` and
`docs/openapi/extract.json`):

| Need | Service and endpoint |
| --- | --- |
| Collections with metadata | Search `GET /collections` |
| Document and chunk counts per collection | Search `GET /collection-stats` |
| Documents in a collection | Search `GET /documents` |
| Folder navigation | Search `GET /folders` |
| Stored summaries | Search `GET /summaries`, `GET /summary` |
| One document reassembled from chunks | Search `GET /document` |
| Recent ingest and search statistics | Search `GET /admin/stats` |
| Extraction jobs and queue overview | Extract `GET /v2/jobs`, `GET /v2/jobs/summary` |
| One job and its figures | Extract `GET /v2/jobs/{id}`, `GET /v2/jobs/{id}/figures` |

Search also owns the mutating side (`POST /ingest`, `DELETE /collections/{name}`, the `/v2`
revision protocol), Extract owns uploads and job controls (`/v2/uploads`,
`POST /v2/jobs/{id}/pause|resume|cancel|retry-failed|reparse`).

## Decision

**Option (a): a thin, read-only Runtime proxy.** The Runtime gains operator-scoped routes that
read from Search and Extract on behalf of the signed-in operator. Control adds one page and a
few allowlist prefixes and learns nothing about Search or Extract.

### Routes

```
GET /monitoring/knowledge/collections          → Search  GET /collections + GET /collection-stats
GET /monitoring/knowledge/documents            → Search  GET /documents, GET /folders
GET /monitoring/knowledge/summaries            → Search  GET /summaries
GET /monitoring/knowledge/stats                → Search  GET /admin/stats
GET /monitoring/knowledge/jobs                 → Extract GET /v2/jobs, GET /v2/jobs/summary
GET /monitoring/knowledge/jobs/{id}            → Extract GET /v2/jobs/{id}
```

The proxy forwards only these upstream paths with only the query parameters each one documents
(enumerated allowlist, default deny), and never forwards a client-supplied tenant.

### Permissions

- New operator permission `knowledge:read` for every route above. It is separate from
  `monitoring:read` because the payload is the customer's corpus metadata — document titles and
  folder names — not operational metrics. `OPERATOR_ROLE_MAP` assigns it like any other
  permission.
- **Full document text (`GET /document`) and figure crops (`GET /v2/jobs/{id}/figures`) are not
  part of this decision.** Reading a document's content in the dashboard is a second, stricter
  permission (`knowledge:content`) and a separate change, because it turns the operator plane
  into a reader of the corpus.
- No write operation is proxied. Ingest, delete and job control stay with their existing
  clients (ingest APIs, the Outpost, Extract's own UI).

### Identity and tenant separation

The Runtime calls Search and Extract with a transaction token (ADR 0035) for the target
service's audience, carrying the operator's verified tenant and `purpose: "operator-read"`. The
envelope field `purpose` exists already. The receiving service:

- accepts the token on the read endpoints listed above, and only there;
- refuses a token with `purpose: "operator-read"` on every other route;
- applies its normal tenant and ACL scoping from the token, so an operator sees exactly one
  tenant's corpus — never all tenants, as a deployment-wide `API_TOKEN` would.

A read always targets exactly one tenant. A platform operator who may see several tenants picks
one explicitly; the Runtime checks that permission and mints the token for that tenant. Search's
tenant-less `operatorScope()` stays reachable only from trusted server-side code, as its own
contract requires — never from a request, a proxied one included.

### Audit

Every proxied read records an audit entry (`knowledge.read`, operator, tenant, upstream path,
result count) — the read of customer corpus metadata becomes traceable, which a direct
browser-to-Search path could never be.

## Options considered and rejected

- **(b) Embed or link the existing surfaces.** Links already exist (`SERVICE_LINKS`, the
  `/services` page). Embedding would need a session mechanism Search and Extract do not have, and an operator
  holding a Search `API_TOKEN` sees all tenants — there is no per-operator tenancy to inherit.
  More expensive than (a), and weaker.
- **Browser talks to Search/Extract directly.** Puts service credentials in the dashboard,
  duplicates the authorization surface, breaks the BFF's default-deny posture.
- **The Next server proxies with its own service tokens.** Control becomes a second backend with
  its own secrets, outside the Runtime's audit trail, production gate and posture checks.
- **Replicate a metadata view into the Runtime's database.** A second, always slightly stale copy
  of the knowledge base with no invalidation story.

## Implementation plan

1. Search and Extract: accept transaction tokens with `purpose: "operator-read"` on the listed
   read endpoints; refuse them everywhere else; tests for both directions and for tenant scoping.
2. Runtime: `routes/knowledge.ts` (pattern of `routes/services.ts`), permission
   `knowledge:read`, audit entries, upstream allowlist, OpenAPI and route-table regeneration.
3. Control: page `(dashboard)/knowledge/`, nav entry, both i18n catalogues, BFF allowlist
   prefixes, e2e with the mock backend, accessibility sweep.
4. Docs: `docs/CAPABILITIES.md` (Operator interface) states the read-only boundary.

## Consequences

- The Runtime becomes, thinly, a gateway for operator reads of two more services — the same
  shape as its existing role for model traffic, tools and monitoring. ADR 0035 gains a second
  token purpose; this record is the reference for it.
- Operators can answer "what does tenant X have indexed" without leaving the dashboard, scoped
  to their tenant and audited.
- Explicitly out of scope: write operations, document content (`knowledge:content`), and a
  Search statistics tile on `/overview`.
