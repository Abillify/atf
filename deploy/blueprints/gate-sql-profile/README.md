# Blueprint — Gate in front of one domain database

A Gate configuration that exposes a business database as three MCP tools: two read tools and
one write tool behind a human approval. The caller's identity comes from the token and is
bound into every statement with `:ctx.*` — the model never supplies a user name.

Neutral by design: the schema, tables and column names below are invented. Nothing here is
copied from a real deployment.

| Tool | Access | Shows |
| --- | --- | --- |
| `contract_lookup` | read | One contract by number. Conditional redaction, identity-bound `WHERE`. |
| `case_list` | read | The caller's cases, paged with signed keyset cursors. |
| `case_note_add` | write | Adds a note. Requires approval; the reviewer sees the actual arguments. |

## Prerequisites

- PostgreSQL reachable from the Gate (any version supported by the driver), with a role whose
  grants match what the tools need — a read-only role for the read tools is enough for a
  first try.
- Gate running from this repository, or an image of it. `--config-dir` points at this folder.
- An identity provider only when you switch to `mode: oauth`; the shipped file uses a static
  development token so it loads with nothing set up.

## Variables

Every interpolated value has a `:-placeholder` default so the file **loads offline**. That is
convenience, not safety: nothing in the defaults is a usable credential, and a placeholder
that survives into production is a vulnerability, not a fallback.

| Variable | Used for | Required for real use |
| --- | --- | --- |
| `ATF_BLUEPRINT_GATE_TOKEN` | static development token | yes (dev only) |
| `ATF_BLUEPRINT_GATE_CURSOR_SECRET` | signs pagination cursors (≥16 chars) | yes |
| `ATF_BLUEPRINT_GATE_APPROVAL_SECRET` | signs approval request states (≥16 chars) | yes, once approvals are used |
| `ATF_BLUEPRINT_DB_URL` | Postgres connection string | yes |
| `ATF_BLUEPRINT_OIDC_DISCOVERY_URL` | oauth block (commented out) | yes, with oauth |
| `ATF_BLUEPRINT_OIDC_ISSUER` | oauth block (commented out) | yes, with oauth |

## Start

Load it and check it offline:

```bash
bun run atf-doctor --service gate \
  --config-dir "$PWD/deploy/blueprints/gate-sql-profile" \
  --env-file /tmp/blueprint-gate.env
```

`--config-dir` is resolved against the probe's own working directory
(`apps/gate`), so pass an absolute path.

The expected result in development (`MCPGATE_ENV=development`) is **0 fatal findings and
5 warnings** — every one of them a deliberate property of a development blueprint, listed
here so a diff means something:

| Warning | Why it is expected here | What to do for real |
| --- | --- | --- |
| `auth.mode is 'static'` | one shared token, so there is no per-user identity to bind | switch to `mode: oauth` (block included, commented) |
| `server.allowedHosts is empty` | reachable as `localhost:3100` only | list the hostnames it is served under |
| `server.trustProxy is 1` | no proxy in front of a local run | set the real hop count, or `false` |
| `server.rateLimit.perIdentity.enabled is false` | single local caller | enable it once callers are people |
| `server.rateLimit.store.type is 'memory'` | single replica | `redis` store with `redisUrl` when replicating |

Run the same check against `MCPGATE_ENV=production` and it fails on three things —
`auth.mode`, `tenantIsolation.enabled`, and the static-mode warning again. Those are the two
decisions this blueprint defers: a real deployment needs a verified identity and tenant
isolation, and `tenantIsolation.enabled: false` here is a **to-do, not a recommendation**.
It stays off so the example queries stay readable; with it on, the Gate adds a tenant
predicate to every statement and each query needs an explicit `tenant_id` binding.

Start the service once the secrets are set:

```bash
MCPGATE_CONFIG_DIR="$PWD/deploy/blueprints/gate-sql-profile" bun run apps/gate/src/index.ts
```

## The parts worth reading in the file

- **`:ctx.username` in the `WHERE` clause of every read tool.** The tool cannot leak another
  user's rows because it has no parameter for "whose rows" — the answer comes from the token.
- **Conditional redaction.** `owner_address` is omitted only for readers without the
  `contractors` group. Note the fail-closed asymmetry: redaction conditions are evaluated
  against the *verified* context, never caller input, and with
  `authorization.enabled: false` every redaction condition counts as true — over-redaction
  rather than accidental disclosure.
- **No `LIMIT` in paged SQL.** The Gate wraps the query and mints signed cursors, so a
  `LIMIT` in your own SQL fights the pagination layer. `orderBy` must be stable, which is why
  `id DESC` is there alongside `updated_at DESC`.
- **`effect: approval` with `requireDifferentApprover: true`.** The person who asked cannot
  approve their own write. `fields` renders `{{args.case_id}}` — the arguments actually sent,
  so the reviewer approves the real call rather than a description of it.
- **`defaultEffect: deny`.** Every tool not named by a rule is refused. A tool added next
  week is not exposed to everyone by default.
- **`statementTimeoutMs: 10000`.** A model that writes a bad filter gets an error in ten
  seconds instead of holding a connection open for the duration of the default.

## Limits of this blueprint

- **Schema is illustrative.** `contracts.case`, `assignee_username` and the rest exist only
  in this file. Rewrite the queries; keep the identity binding.
- **One database, no pool sizing.** Pool defaults are fine for a demo and wrong for
  concurrency; `databases.contracts.pool` exists for that decision.
- **No `tenantIsolation`, no oauth, no metrics** — all three are on the real-deployment list
  above, and the production profile refuses the first two.
- **Approvals need somewhere to be resolved.** This file configures the pending store and its
  TTL; approving happens in Control (or against the approval API). Without an approver wired
  up, a write stays pending until `ttlMs` expires.
- **`server.outbound.allowedHosts` names a reserved `.invalid` host** to declare "no egress"
  explicitly, since an empty list is a fatal finding in production. Replace it with the real
  hosts the moment an HTTP tool exists.
