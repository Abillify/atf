# @atf/gate

A governed MCP gateway. Bun + Express.

Gate turns declarative YAML into MCP tools that a model may call. It is the boundary where an
AI system is allowed to touch real systems, so it is built around one rule: the model can only
do what the configuration permits, always as the authenticated caller.

## Run it

```bash
cp .env.example .env
bun run --filter @atf/gate dev
```

Gate reads its tools and policies from YAML in `MCPGATE_CONFIG_DIR`, not from the environment.
See [`deploy/examples/gate/config.yaml`](../../deploy/examples/gate/config.yaml) for a minimal
file.

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
| `/monitor/login`, `/monitor/callback`, `/monitor/logout` | OIDC session for the monitor UI |
| `/monitor/instructions` | Generated tool instructions for model prompts |
| `/healthz`, `/readyz` | Liveness and readiness |

## Tools from configuration

A tool is a YAML declaration: its backend, its parameter schema, and the scopes required to
invoke it. No code.

Backends: **SQL** through Knex (PostgreSQL, MySQL, SQLite, SQL Server, Oracle), **HTTP**,
**MQTT**, **MCP proxy** to another server, **webhook**, **inline** built-in handlers,
**composite** tools that combine several of the above, and one purpose-built backend,
[**`taigaApi`**](#the-taigaapi-backend).

```yaml
tools:
  - name: ticket_lookup
    type: sql
    database: support
    description: Look up tickets belonging to the authenticated user.
    parameters:
      status:
        type: string
        enum: [open, closed]
    scopes: [tickets:read]
    query: |
      SELECT id, subject, status
      FROM tickets
      WHERE owner_id = :identity.subject
        AND status = :status
      ORDER BY created_at DESC
      LIMIT 50
```

Three properties of that example matter more than the syntax:

**Parameters are bound, never interpolated.** `:status` is a bound parameter. There is no code
path that concatenates model output into SQL.

**Identity is injected, not passed.** `:identity.subject` comes from the verified token, not
from the model's arguments. A model cannot ask for another user's tickets, because it never gets
to state whose tickets it wants.

**Scopes gate invocation.** A caller without `tickets:read` cannot invoke the tool at all, and
authorization fails closed.

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

`MCPGATE_APPROVAL_SECRET` must match Runtime's approval signing secret so an approval issued in
Runtime is accepted here.

`MCPGATE_TRANSACTION_REDIS_URL` is needed only when several replicas must share transaction and
session state.

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
