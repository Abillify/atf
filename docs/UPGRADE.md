<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Upgrade guide 0.3 → current (0.16)

Database migrations are additive and run under a PostgreSQL advisory lock,
so a migration job and booting replicas serialize safely. Who runs them is
controlled by `MIGRATE_ON_START` (see [DEPLOYMENT.md](../DEPLOYMENT.md)):
outside production a service migrates on start; with
`APP_ENV`/`NODE_ENV=production` and the variable unset it does not, and the
standalone `bun run migrate` command (the Helm chart's pre-install/pre-upgrade
jobs) applies the schema instead. Manual steps exist only for configuration
and contracts. Before every upgrade, take a backup as described in
[runbooks/backup-restore.md](runbooks/backup-restore.md).

## Generic upgrade procedure

1. Read the release notes of every skipped version (especially the
   **Migration** sections in the [CHANGELOG](../CHANGELOG.md)).
2. Back up the Runtime, Search and Extract databases, the outstore and the
   audit anchor file.
3. Pin the images by digest in your deployment system and review the SBOM
   and scan results.
4. Run the migrations (`bun run migrate` per service, or the Helm hooks:
   Runtime, then Search, then Extract), then update the services in this
   order: **Runtime → Gate → Search → Extract → Control**.
5. Check health (`/health/ready` on Runtime, Search and Extract, `/readyz` on
   the Gate) and run one end-to-end transaction (ingest → chat → evidence).
6. Verify the audit chain (`GET /admin/compliance/audit-anchor`).

## Version-specific milestones

### 0.3 → 0.8

No table or column changes. 0.4 adds opt-in image inspection
(`imageInspection`); 0.8 adds one index (Runtime schema version 40). There
is no independently versioned contract-package change; existing flows stay
valid.

### 0.9.x

- Search migrations: the global schema advances from version 4 to 8.
- With `EXTRACT_DATABASE_URL` set, Extract creates its own `extract` schema
  (version 2).
- **Contract breaking**: `@atf/extract-contract` 1.1.0 → **2.0.0**. The
  package root now exports the v2 record stream; code importing v1 symbols
  from the root must switch to `@atf/extract-contract/v1`.
- The conversion-callback SSRF policy is stricter and can refuse existing
  internal receivers (see the 0.9.0 **Security** section).
- Details, rollback and corpus re-ingest:
  [document-intelligence-v2-migration.md](document-intelligence-v2-migration.md).

### 0.10.x

No migration. OAuth 2.0 token exchange (`tokenExchange` in the Runtime,
`oauth.actorPolicy` in the Gate) is opt-in.

### 0.11 → 0.12

- Extract schema **version 3**: the nullable columns `created_by_subject`
  and `created_by_tenant` in `extract.jobs`. Existing jobs stay owner-less
  and admin-only; set owners for old jobs with a script if you need them.

### 0.13.0 → 0.13.2

- Runtime schema **version 41**: `flow_drafts`; each flow's current draft is
  backfilled as `default`.
- **Currency**: costs are labelled in `CURRENCY` (default `EUR`). Deployments
  that priced in US dollars set `CURRENCY=USD` **and**
  `NEXT_PUBLIC_CURRENCY=USD`; Control freezes `NEXT_PUBLIC_CURRENCY` at build
  time, so keep both aligned.

### 0.13.2 → 0.14

- Extract schema **version 5**: `extract.vision_daily_usage`.
- Set `MAX_PAGES` explicitly for long documents (0 = unlimited); production
  configurations with `SUBPROCESS_TIMEOUT_MS=0` must set a positive value.
- `CONVERTER_MODE=isolated`: a converter process from the Extract build must
  run next to Extract with the same `CONVERTER_SOCKET` and the same scratch
  volume (`TEMP_DIR`); `OCR_FALLBACK=tesseract` needs Tesseract and its
  language data installed.

### 0.14 → 0.15 (platform hardening)

- Production replicas no longer migrate on boot unless
  `MIGRATE_ON_START=true` is set; run `bun run migrate` (or the Helm hooks)
  before rolling out.
- Runtime schema versions 42–46: audit-log immutability trigger and anchor
  table, `audit_log_purge` with a pre-purge anchor and app-role revocations,
  `erasure_requests`, `api_keys.hash_alg` (peppered key hashing, migrated
  lazily on use), and the receipt transparency log (`receipt_log`,
  `receipt_tree_heads`).
- Search global schema version 9: `vs_search_stats.query_hash`; remaining
  legacy rows that may still carry raw query text are cleared.
- Search and Extract expose `/health/live` and `/health/ready`; `/health`
  stays unchanged. Runtime and Gate serve `/openapi.json` and
  `/openapi.yaml`.
- Review the **Changed** and **Security** sections of `[0.15.0]` in the
  CHANGELOG: several production-gate rules now refuse configurations that
  used to start.

### 0.15 → 0.16

Review the `[0.16.0]` section of the [CHANGELOG](../CHANGELOG.md), in particular its
**Migration** subsection. Steps, in order:

1. Take a backup, then run the migrations (`bun run migrate` or the Helm hooks): Runtime
   schema version **47** is the only schema change (see below). Search and Extract have none.
2. Search: decide the full-text language per collection (see the first item below) and run
   `bun run --filter @atf/search fts:language <collection> <language>` for each existing
   collection you want to switch. The script needs `POSTGRES_URL`.
3. Runtime, with several trusted issuers: set `JWT_ISSUER_TENANTS` before rolling out.
4. Control in BFF mode: set `CONTROL_PUBLIC_ORIGIN`.
5. Scripts and probes that call the Gate monitor: switch from `?token=` to the
   `Authorization` header.
6. Review the new defaults in the prompt-injection and shadow items below, then roll out
   Runtime → Gate → Search → Extract → Control.

New or changed environment variables (the full list with defaults is in
[CONFIGURATION.md](CONFIGURATION.md)): `JWT_ISSUER_TENANTS`, `CONTROL_PUBLIC_ORIGIN`,
`RETRIEVAL_CONTEXT_MODE`, `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`,
`TOOL_OUTPUT_VALIDATOR_ENABLED` (now on by default in production), `RERANK_SCORE_TRANSFORM`,
`RERANK_BATCH_SIZE`, `LLM_HTTP_KEEP_ALIVE`, `FTS_LANGUAGE` (default `german`),
`FTS_EXTRA_LANGUAGES`.

Contracts: no contract package changed in this release (`@atf/extract-contract` stays 2.3.0,
`@atf/identity-contract` 1.2.0). Search responses gain fields (`score_scale`,
`content_trust`, `injection_risk`); clients that validate strictly against the old shape must
allow them. Extract's API is unchanged.

#### Breaking or behaviour-changing, act before rolling out

- **Gate monitor**: `?token=` is no longer accepted on any monitor endpoint.
  Scripts send `Authorization: Bearer <token>`; the dashboard exchanges the
  token once via `POST /monitor/session` for an HttpOnly cookie.
- **Search full-text language**: `FTS_LANGUAGE` defaults to `german`. Existing
  collections keep their language; switch one with `bun run fts:language` in
  `apps/search` (recomputes its vectors). Deployments with mainly non-German content set
  `FTS_LANGUAGE` explicitly (`english` or `simple`).
- **Invalid compliance policy**: a broken `compliance-policy.yaml` no longer
  means "no policy". A hot reload keeps the last valid policy; at startup with
  no valid policy, chat and engine admission answer 503 until the file is
  fixed. A missing file still means "no policy".
- **Shadow runs**: sampling defaults to 5 % (`samplingRate` in `shadow.yaml`).
  Shadow and replay runs refuse tools without `readOnlyHint` and skip the
  assistant memory writes. Custom MCP servers that should take part in shadow
  runs must declare `readOnlyHint` on their lookup tools.
- **Control mutations** are no longer retried (`mutations.retry` 1 → 0).
- **Self-service erasure** (`DELETE /v1/me/data`): the subject is the token's `iss` plus `sub`;
  `email` counts only with `email_verified: true`. A token without `iss` gets 401, a token
  without a tenant claim gets 403 `TENANT_REQUIRED`. Check that your IdP issues both claims
  before you point users at the endpoint.
- **Trusted issuers**: with `JWT_ADDITIONAL_ISSUERS` and tenant isolation, set
  `JWT_ISSUER_TENANTS` (JSON map issuer → tenants, `"*"` for all). Production
  readiness fails without it when more than one issuer is trusted; a token
  whose issuer is not bound to its tenant gets 401.
- **Control behind a reverse proxy** (BFF mode): set `CONTROL_PUBLIC_ORIGIN` to
  the public origin. Without it the proxy must overwrite `X-Forwarded-Host`.
  In BFF mode there is no silent renewal; after expiry users sign in again.
- **Search rerank scores**: `RERANK_SCORE_TRANSFORM` defaults to `auto`, so a
  `relevance_score` already in [0, 1] is no longer passed through a sigmoid.
  If `MIN_RERANK_SCORE` was tuned against the old values, re-tune it or set
  `RERANK_SCORE_TRANSFORM=sigmoid`. Search responses always carry
  `score_scale`; do not compare scores of different scales.
- **Prompt-injection defences**: in production `RETRIEVAL_CONTEXT_MODE`
  defaults to `spotlight`, `TOOL_OUTPUT_VALIDATOR_ENABLED` to on and
  `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL` to on. After a finding, write tools
  need approval, or are denied when `APPROVAL_GATE_ENABLED` is off; plan the
  approver role before rollout. Read-only tools are unaffected.

#### Schema and observability

- Runtime schema version **47**: nullable `iss` on `executions` and
  `token_usage_log`. Self-service erasure matches rows with the caller's issuer
  or `NULL`, so older rows still match by `sub`. Roll all replicas to this
  version before relying on the issuer scoping.
- Debug traces carry `flow_digest` and `subflow_versions[]` next to
  `flow_version`. Run `bun run scripts/cli.ts validate <flows-dir> --require-version` in
  `apps/runtime` and `bun run check:flow-versions` in CI for your own flow
  repositories.

#### Eval stack

The eval compose stack embeds with `BAAI/bge-m3` (1024 dimensions) instead of
`bge-small-en-v1.5`. Re-ingest the eval corpus, then run
`bun run eval:retrieval` and `bun run eval:retrieval:de`. No bge-m3 numbers
are committed yet and the CI floors in `scripts/eval/baseline/thresholds.json`
are not recalibrated; production embedding settings are not affected.

## Known upgrade blockers

| Symptom | Cause | Fix |
| --- | --- | --- |
| Runtime does not start, `unknown column` | A replica of the previous version wrote after the migration | Run all replicas on one version; no mixed operation across migrations |
| 429 storm after the rollout | More replicas against the same provider quota | Raise the quota or configure a fallback model (`runbooks/scaling.md`) |
| Sessions gone after the upgrade | `OIDC_SESSION_SECRET` changed | Expected — log in again; use a rollout window if needed |
| Extract jobs hang | Converter sidecar without the shared socket/volume | Configure the sidecar as described above |
| Production replica starts against an old schema | `MIGRATE_ON_START` unset in production and no migration job ran | Run `bun run migrate` (or the Helm hooks) first |
| 401 on `/v1/*` after the upgrade, several issuers | `JWT_ISSUER_TENANTS` unset or does not list the issuer/tenant | Set the issuer → tenants map (`"*"` for all) |
| Monitor scripts fail with 401 | They send `?token=` to the Gate monitor | Send `Authorization: Bearer <token>` |
| Chat answers 503 | `compliance-policy.yaml` is unreadable or schema-invalid and no valid policy was loaded | Fix the file; `GET /admin/compliance-policy` shows the load error |
| A write tool is refused or waits for approval after a document search | Taint rule after an injection finding (`TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`) | Approve it, declare `readOnlyHint` on read-only tools, or opt out explicitly (readiness warning) |
| Everything is dropped after rerank (abstention) | `MIN_RERANK_SCORE` tuned against the old sigmoid-squashed scores | Re-tune it or set `RERANK_SCORE_TRANSFORM=sigmoid` |
| Compound words are not found | `german_compound` needs Hunspell files in the PostgreSQL image | See `operations-and-retrieval.md` (German full-text search) |

## Rollback

Migrations are additive, so rolling back to the previous version is possible
as long as no new columns or tables were written (for 0.13/0.14:
`flow_drafts`, `vision_daily_usage`; for 0.16: the nullable `iss` columns of
migration 47, which the older binary ignores). After a rollback from 0.16, collections whose
FTS language you switched keep `german` vectors; switch them back with `bun run fts:language`. Otherwise restore from the pre-upgrade
backup (`runbooks/backup-restore.md`) — the outstore is forward compatible.
