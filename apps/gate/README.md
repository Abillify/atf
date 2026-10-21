# @atf/gate

A governed MCP gateway. Bun + Express.

Gate turns declarative YAML into MCP tools that a model may call. It is the boundary where an
AI system is allowed to touch real systems, so it is built around one rule: the model can only
do what the configuration permits, always as the authenticated caller.

## Run it

From the repository root:

```bash
cp apps/gate/.env.example apps/gate/.env
bun run --filter @atf/gate dev
```

The example environment points `MCPGATE_CONFIG_DIR` at
[`deploy/examples/gate/`](../../deploy/examples/gate/), which contains a minimal `config.yaml`.
Gate reads tools and policies from that directory, not from environment variables. Verify the
standalone service with `curl --fail http://127.0.0.1:3003/readyz`.

```bash
bun run --filter @atf/gate test
bun run --filter @atf/gate typecheck
bun run --filter @atf/gate build
```

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `/mcp` (`mcpPath`) | Streamable HTTP MCP transport |
| `/sse`, `/messages` | Legacy SSE MCP transport pair |
| `/monitor/stream` | Live session and invocation events |
| `/monitor/tools`, `/monitor/tools/:name/run` | Tool inspection and manual invocation |
| `/monitor/login`, `/monitor/callback` | OIDC login for the monitor UI (PKCE S256, `nonce`) |
| `POST /monitor/logout` | Ends the monitor session (303); `GET` answers 405 |
| `POST /monitor/session` | Exchanges the static monitoring token for an HttpOnly session cookie |
| `/monitor/instructions` | Generated tool instructions for model prompts |
| `/healthz`, `/readyz` | Liveness and readiness |

### Monitor stream

`GET /monitor/stream` replays the recent ring buffer and streams live events. What a viewer
sees depends on how they authenticated:

- **Static monitor token (or a session made with it)** is the operator view — every event.
- **OIDC session** is scoped by `monitoring.tenantScope`: `session` (default) sends only events
  whose `tenantId` matches the session's tenant (events with no tenant are withheld); `all`
  sends every event, like the operator.
- **Tool results.** Unless `monitoring.includeToolContent` is `true`, `tool_result` events carry
  no `meta.content`; it is replaced by `meta.contentDigest` (`{ sha256, bytes }` — SHA-256 hex
  over the result's JSON and its UTF-8 length), so the dashboard shows that and how much a tool
  returned without leaking the data.

### Tool Playground

`POST /monitor/tools/:name/run` executes a tool from the dashboard. It is opt-in
(`monitoring.playground.enabled`, and `playground.allowWrite` for write-access tools), must be
**disabled in production** (the production gate treats it as fatal), and always runs through the
same governance pipeline as an MCP `tools/call`: policy evaluation, approval tokens, required
scopes, argument validation, per-identity rate limiting and audit events with the real caller
identity. Without the governance wiring the endpoint answers `503` (fail closed), for dry-runs as
well.

- **Identity.** When a monitor OIDC session is present, the session is the only identity source:
  a request-body `identity` is ignored, and the session carries exactly the scopes its IdP issued
  in the `tools` claim — the convenience scope `tools:<access>` is **not** added for it. With the
  static monitor token (a root credential) the body `identity` (subject, scopes, claims) is
  honoured, which is how scope-aware tools are exercised, and `tools:<access>` is synthesised.
- **Dry-run** (`"dryRun": true`) never executes, but it renders the tool's internals (SQL and
  bindings, URL, body). It therefore needs the same `requiredScopes` and obeys policy deny; HTTP
  tools show `[redacted]` for credential-bearing headers (`Authorization`, `Cookie`, `X-Api-Key`,
  and names containing `token`, `secret`, `password`, `credential`, `signature`). A dry-run is not
  rate limited and needs no approval token. Its monitor events use the same `playground-<hex>`
  session id as real runs.
- **Approval-required tools.** The endpoint has no field for an approval token, so a tool whose
  policy effect is `approval` answers `APPROVAL_REQUIRED` and cannot be completed from the
  playground; use an MCP client for it.
- **Groups.** `monitoring.oidc.requiredGroups` limits dashboard logins to members of specific IdP
  groups, read from the fixed id_token claim `groups` (Keycloak needs a groups mapper, Entra emits
  object ids). With the list empty every authenticated IdP user may log in — set it whenever the
  playground or the dashboard shows data you do not want every employee to see. In production the
  Gate warns while `monitoring.oidc.requiredGroups` is empty.

## Tools from configuration

A tool is a YAML declaration: its backend, its parameter schema, and the scopes required to
invoke it. No code.

Backends: **SQL** through Knex, with `pg` and `mysql2` installed by this repository. Knex can
also target SQLite, SQL Server, or Oracle when the deployment supplies the corresponding
compatible driver (`sqlite3`/`better-sqlite3`, `tedious`, or `oracledb`) in the built artifact;
those combinations are not covered by this repository's installed dependency set. Other
backends are **HTTP**, **MQTT**, **MCP proxy** to another server, **webhook**, **inline** built-in
handlers, **composite** tools that combine several of the above, and one purpose-built backend,
[**`taigaApi`**](#the-taigaapi-backend).

```yaml
tools:
  - name: ticket_lookup
    type: database
    database: support
    description: Look up tickets belonging to the authenticated user.
    inputSchema:
      type: object
      properties:
        status:
          type: string
          enum: [open, closed]
    requiredScopes: [tickets:read]
    rowLimit: 50
    query: |
      SELECT id, subject, status
      FROM tickets
      WHERE owner_id = :ctx.subject
        AND status = :param.status
      ORDER BY created_at DESC
```

Three properties of that example matter more than the syntax:

**Parameters are bound, never interpolated.** `:param.status` is a bound parameter. There is no
code path that concatenates model output into SQL.
**Identity is injected, not passed.** `:ctx.subject` comes from the verified token, not
from the model's arguments. A model cannot ask for another user's tickets, because it never gets
to state whose tickets it wants.

**Scopes gate invocation.** A caller without `tickets:read` cannot invoke the tool at all. A tool
that declares no `requiredScopes` is open to every authenticated caller whenever the policy's
`defaultEffect` is `allow`; the readiness gate warns about such tools. Authorization fails closed
only where you configure it to: scopes on the tool, `defaultEffect: deny` in the policy, and the
production gate.

Conditional statements let one tool return different fields for different scopes, so an admin
view and a user view can share a name without sharing a query.

## The `taigaApi` backend

One backend is not generic: `taigaApi` writes to [Taiga](https://taiga.io) project management.
It exists because four things it needs cannot be expressed as an `http` tool.

```yaml
tools:
  - name: taiga_task_create
    type: taigaApi
    operation: task_create        # task_create | task_update | story_points_update
    apiBaseUrl: https://taiga.example.com
    requiredScopes: [tools:write]
    inputSchema:
      type: object
      properties:
        project: { type: integer }
        user_story: { type: integer }
        subject: { type: string }
      required: [project, user_story, subject]
```

**The caller's identity does the writing.** There is no service credential. The caller's verified
OIDC access token is exchanged at `POST {apiBaseUrl}/api/v1/auth` for a user-scoped Taiga token,
so a write is attributable to a person and bounded by *their* Taiga permissions. A request
without a bearer token is refused with `TAIGA_USER_TOKEN_MISSING`. Exchanged tokens are cached
per `(apiBaseUrl, issuer, subject, tenant)` and expire with the OIDC token, whichever is sooner.

**Taiga requires optimistic locking.** Every update must carry the current `version`, so
`task_update` and `story_points_update` are read-modify-write: they `GET` the entity, take its
`version`, and `PATCH` with it. `story_points_update` additionally merges one role's points into
the existing points map rather than replacing it. A lost race returns
`TAIGA_VERSION_CONFLICT` instead of silently overwriting a colleague's edit.

**Responses are field-allowlisted.** Only a fixed set of fields is returned, so a Taiga schema
change cannot widen what reaches the model. Bodies are read under a byte cap, and HTTP statuses
map to stable codes (`TAIGA_VALIDATION_FAILED`, `TAIGA_FORBIDDEN`, `TAIGA_NOT_FOUND`, …) rather
than being passed through.

**`access` is fixed to `write`.** It cannot be declared read, which means response caching never
applies and the write-side authorization path always runs.

Like `http` and `mcp` tools, `taigaApi` is subject to the outbound host allow-list —
`server.outbound.allowedHosts` must be non-empty in production. Set `allowPrivateAddress: true`
only for a split-DNS deployment; it whitelists the exact configured hostname and nothing else.

> This backend has no automated test coverage yet. Treat the token exchange, version handling,
> and sanitizing as areas to verify against your own Taiga instance before relying on them.

## Optional language router

A router can pick a tool from a natural-language request. Read (`ask`) and write (`act`) paths
are separate, so a read intent can never be resolved to a mutating tool. Interpretation of
router results is documented in
[`docs/router-result-interpretation.md`](../../docs/router-result-interpretation.md).

## Transaction envelope and approvals

With `MCPGATE_TRANSACTION_ENFORCEMENT` on, every invocation must carry a valid signed
transaction envelope; `MCPGATE_TRANSACTION_ISSUER`, `_AUDIENCE`, and a key
(`_HS256_SECRET` or a JWKS URI) are all required, and Gate refuses to start otherwise. This is
what binds a tool call to the request that authorized it and gives evidence lineage something
to reference.

The key should be the issuer's public JWKS (`MCPGATE_TRANSACTION_JWKS_URI`; the Runtime serves
`/.well-known/atf-transaction-jwks.json`) with EdDSA or ES256 rather than a shared
`_HS256_SECRET`: a Gate that holds a shared secret can mint tokens for every other Gate that
shares it. `MCPGATE_TRANSACTION_ALGORITHMS` defaults to every algorithm the configured keys
allow, so a migration can accept HS256 and EdDSA at once and drop HS256 afterwards. Give each
Gate its own `_AUDIENCE` and map it on the Runtime with `AGENT_TRANSACTION_AUDIENCES`, so a
token minted for one Gate is refused by the others. The production gate warns while HS256 is
accepted and while the audience is the example value `mcpgate`
([ADR-0035](../../docs/adr/0035-asymmetric-transaction-tokens-audience-per-service.md); order of
the migration in [UPGRADE](../../docs/UPGRADE.md), item 20).

`MCPGATE_APPROVAL_SECRET` must match Runtime's approval signing secret so an approval issued in
Runtime is accepted here.

**Who resolves an approval.** The Gate records the resolver from the caller's verified identity;
the `approver` a client sends is kept only as a label (`declaredApprover`), and an event notes
when the resolver is the requester (`selfResolved`). With `policies.approval.requireDifferentApprover:
true` a requester cannot resolve its own request (403, the request stays pending) and the
resolver must be a different principal of the same tenant with the scope
`policies.approval.approverScope` (default `approvals:resolve`). It is off by default because a
Runtime that requests and resolves its own approvals would block itself; turn it on when people
or a separate service decide.

**Content trust.** Results of executed tools carry
`_meta["io.atf/content-trust"] = { "content_trust": "untrusted", "source": <tool type> }`. Tool
output is data from outside the platform, so a client that taints on untrusted input (Runtime
`TAINT_MODE=on-untrusted-source`) can act on it. Denials Gate produces itself carry no label.

`MCPGATE_TRANSACTION_REDIS_URL` is needed only when several replicas must share transaction and
session state.

## Tenants and issuers
With several trusted OAuth issuers and tenant isolation on, `tenantIsolation.issuerTenants` maps
each issuer to the tenants it may assert (`"*"` = any). A token from an unlisted issuer is a 401,
one claiming another tenant a 403; in production an empty map is fatal when more than one
issuer is trusted. The tenant comes from a claim the IdP issues: use one users cannot edit.
Imported MCP tools (`mcp.yaml` imports) are `read` only when the downstream server declares
`annotations.readOnlyHint: true`; otherwise they import as `write` unless the import or a tool
override sets `access`.
## Hardened defaults

Gate has a production readiness gate that refuses unsafe configurations rather than warning
about them (ADR `gate/0001`). Authentication is `disabled` only in the example config; enable it
before any deployment. `MCP_SCHEMA_COMPATIBILITY_MODE=strict` rejects a tool schema mismatch
instead of logging it.

## Configuration

[`.env.example`](.env.example) covers the process-level environment;
[`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) lists it in full. The YAML schema is
defined in `src/config/schema.ts`.

## Further reading

- [`docs/MCP-2026-CONTEXT-LAYER.md`](../../docs/MCP-2026-CONTEXT-LAYER.md) — MCP context layer
  design
- [`docs/adr/gate/`](../../docs/adr/gate/) — hardened defaults and scope-based conditions
- [`docs/CHANGELOG-gate.md`](../../docs/CHANGELOG-gate.md) — historical change record
