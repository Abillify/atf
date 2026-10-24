<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Upgrade guide 0.3 → 0.19

Database migrations are additive and run under a PostgreSQL advisory lock,
so a migration job and booting replicas serialize safely. Who runs them is
controlled by `MIGRATE_ON_START` (see [DEPLOYMENT.md](../DEPLOYMENT.md)):
outside production a service migrates on start; with the production profile
(`ATF_PROFILE=production`; without it the service variable, e.g. `APP_ENV=production` for
Runtime, `MCPGATE_ENV` for the Gate, `NODE_ENV` for Search and Extract) and the variable unset
it does not, and the
standalone `bun run migrate` command (the Helm chart's pre-install/pre-upgrade
jobs) applies the schema instead. Manual steps exist only for configuration
and contracts. Before every upgrade, take a backup as described in
[runbooks/backup-restore.md](runbooks/backup-restore.md).

## Generic upgrade procedure

1. Read the release notes of every skipped version (especially the
   **Migration** sections in the [CHANGELOG](../CHANGELOG.md)).
2. Back up the Runtime, Search and Extract databases, the Extract source store
   (`SOURCE_STORE_DIR`), the Search asset store (inside the Search database with
   the default `ASSET_STORE_BACKEND=postgres`, or `ASSET_STORE_DIR` with the
   filesystem backend) and the audit anchor file.
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
`bun run eval:retrieval` and `bun run eval:retrieval:de`. Since 0.19.2 the
first bge-m3 numbers are committed in
`scripts/eval/baseline/retrieval.bge-m3.md` and the CI floors in
`scripts/eval/baseline/thresholds.json` are recalibrated on them; production
embedding settings are not affected.

### 0.16 → 0.17

Review the `[0.16.2]` and `[0.17.0]` sections of the [CHANGELOG](../CHANGELOG.md).
One behaviour change arrives with 0.16.2: an **unknown collection** on a Search
read or search route is now a typed `404` with `COLLECTION_NOT_FOUND` instead of
`403`. Clients and alerting rules that treated `403` on a read as "the collection
exists but I may not see it" must also accept `404`; a caller with a valid scope
now sees an empty index rather than a permission failure.

No schema change in any service. 0.17 is opt-in feature work: an `llm` node can
declare `config.figureEmbedding` to get a `show_figure` tool that embeds a
document figure from an `asset:<id>[#bbox]` search reference. The feature stays
off until the deployment sets `EMBED_SEARCH_FIGURES=true` **and**
`MEDIA_BASE_URL` (a reachable base URL for the Runtime's short-lived media
links); without either, a node that requests the tool emits a
`figure_embedding_unavailable` diagnostic instead. Existing flows are unaffected.

### 0.17 → 0.18

Review the `[0.18.0]` section of the [CHANGELOG](../CHANGELOG.md). Search global
schema version stays **9**, Runtime **47**, Extract **5** — no migration step,
but the HTTP surface changes:

1. Back up first — the Search database is now mandatory in the backup set: with
   the default `ASSET_STORE_BACKEND=postgres` the `vs_assets` table holds every
   stored figure's bytes (`runbooks/backup-restore.md`).
2. Confirm the `vs_document_assets` → `vs_assets` backfill completed (Step 1 of
   [document-intelligence-v2-migration.md](document-intelligence-v2-migration.md))
   — legacy assets are only retrievable through it from this version on.
3. Clients that call `PUT` / `GET /document-assets/:assetId` directly must
   switch to `GET /v2/assets/{id}?collection=…` **before** the rollout: the v1
   routes are removed and answer 404/405 after it.
4. Remove `SEARCH_UPLOAD_ASSETS` from Extract's environment (it is no longer
   read). The synchronous `/v1/ingest` path no longer uploads figure crops;
   figure images flow only through the v2 job pipeline, so a deployment that
   needs stored figures must run the v2 path (`EXTRACT_DATABASE_URL` +
   `SOURCE_STORE_DIR` on Extract, `BATCH_WORKER` on Search).
5. Roll out Search first, then Extract, then the rest. `/search` (v1) hits now
   report `asset_url` as `GET /v2/assets/{id}?collection=…` — clients that parse
   the URL shape must accept it.

0.18.1 is a security-patch release (dependency bumps, CBOR `__proto__` fix in
`@atf/security-kit`); no configuration or schema change.

#### Breaking or behaviour-changing, act before rolling out

- **Search v1 asset routes removed**: `PUT` / `GET /document-assets/:assetId`
  are gone. Anything writing assets through that route (custom ingest tooling)
  must use the v2 job pipeline; anything reading must use `GET /v2/assets/{id}`.
- **Extract v1 crop upload removed**: without a job store, the `/v1/ingest`
  response drops `assets_stored` / `assets_failed`, and no figure crops are
  stored at all. Text-only ingestion keeps working unchanged.
- **Rollback after 0.18 is text-only**: figures indexed from 0.18 on live in
  `vs_assets` only; backing Extract out to the synchronous v1 path stops crop
  storage entirely (see the migration guide's Rollback section).

### 0.18 → 0.19

Review `[Unreleased]` in the [CHANGELOG](../CHANGELOG.md), in particular its
**Migration** subsection. The Runtime adds two migrations: 48 creates
`audit_chain_meta` (the canonical cut-off of the audit chain, item 6) and 49 adds
`erasure_requests.lease_token` (fencing of erasure runs). Search, Extract and the Gate
add none; the rest is configuration and clients. Do these **before** rolling out:

1. **Check the profile values.** `ATF_PROFILE` (new), `APP_ENV`, `MCPGATE_ENV` and
   `NODE_ENV` must be `development`, `staging`, `production` or `test`
   (case-insensitive). Any other non-blank value — `prod`, `local`, `ci`,
   `Production ` with a typo — now aborts the start of Runtime, Gate, Search and
   Extract, where it used to behave like `development` (all production gates
   off). `ATF_PROFILE` wins over the service variable; use `staging` to see the
   full fatal list as warnings before promoting a system to `production`.
2. **Search embedding fallback.** `EMBED_FALLBACK_MODEL` that differs from
   `EMBED_MODEL` aborts the Search start. If both identifiers name the same
   underlying model (an Ollama tag and a TEI repo id of the same weights), add
   `EMBED_FALLBACK_SAME_SPACE=true`; if they are different models, point the
   fallback at the same model — mixed vector spaces destroy relevance silently.
3. **Gate production gate.** Fatal in `production`: `monitoring.playground.enabled:
   true`, and a plaintext `http://` `server.publicUrl` or
   `monitoring.oidc.redirectUri`. Turn the playground off (or run `staging`) and
   use `https://`. Where the playground stays on outside production: dry-runs now
   need the tool's `requiredScopes` and obey policy deny, an OIDC session carries
   only the scopes in its IdP `tools` claim (no synthesised `tools:<access>`), and
   HTTP-tool dry-runs show `[redacted]` for credential headers.
4. **Replicas.** With `REPLICAS > 1`, Search and Extract require
   `RATE_LIMIT_REDIS_URL` in production (otherwise every replica hands out the
   full rate-limit budget); Runtime warns without `REDIS_URL`. The Helm chart now
   exports `REPLICAS` (Gate: `MCPGATE_REPLICAS`) from `replicaCount` — or the
   HPA's `maxReplicas` when autoscaling is on — and, only when you set
   `global.profile`, `ATF_PROFILE`. `replicaCount` defaults to 2, so **a
   production Search or Extract pod without `RATE_LIMIT_REDIS_URL` no longer
   starts**: provide the shared store (`extraEnv` or a secret), or set
   `replicaCount: 1`. `extraEnv` renders last and overrides the exported values.
   With `global.redis.enabled: true` and `global.redis.urlSecret` (name and key of an
   existing Secret holding the URL) the chart exports the URL as `REDIS_URL` to the
   Runtime and as `RATE_LIMIT_REDIS_URL` to Search and Extract; without it, provide
   `RATE_LIMIT_REDIS_URL` through `extraEnv` or a secret. The shared limiters
   fail **open** when Redis is unreachable (they log and allow), the same
   availability posture as the in-memory limiter they replace; for Extract that
   means a Redis outage removes the request throttle, so alert on the error log.
   The `redis` package must be installed in the image of any service that sets the
   URL (it loads on the first request).
5. **Rotate audit-exposed operator tokens.** Until this change the red-team routes
   wrote the raw `Authorization` header, and the optimizer routes the first 12
   characters of the bearer token, into the audit `actor`. Rotate those tokens,
   and restrict `GET /monitoring/audit` plus the log shipper's audit stream until
   you have. The rows stay in the hash chain (they cannot be removed without
   breaking it); a purge needs the documented `audit_log_purge` procedure with its
   pre-purge anchor.
6. **Verify the audit chain after the rollout.** The `details` hash is now
   key-sorted at every depth. Chains written before verify as before; the result
   reports `legacyForm` — the number of rows that verified only under the old hash
   form. Rows whose `details` Postgres had already reordered after they were
   hashed were false positives before and stay unverifiable.
   Migration 48 adds `audit_chain_meta`: the first row written after the upgrade records its id as
   the canonical cut-off, and from then on the legacy hash form is accepted only for rows below it
   (`legacy hash form after cut-off at id <n>` otherwise).
   **Do not run 0.18 and 0.19 Runtime pods side by side for this step.** The chart rolls out with
   `maxSurge: 1, maxUnavailable: 0`, so an old pod can write a legacy-form audit row after a new
   pod has set the cut-off, and verification then reports `legacy_hash_after_cutoff` for it. Scale
   the Runtime to 0 (or run this one rollout with a `Recreate` strategy) and start the new version
   only after every old pod has stopped. If it happened anyway — or after a rollback to 0.18 and a
   second upgrade — check that every reported row was written by an old pod during that window
   (actor, time), then move the cut-off to the first row written after the last old pod stopped:
   `UPDATE audit_chain_meta SET value = '<id>' WHERE key = 'canonical_cutoff_id'`. Record the
   change and the reason in your change log; the rows below the new cut-off verify in the legacy
   form, and nothing else in the chain changes.
7. **Search ranking.** The lexical branch ORs the query terms and no longer parses
   `websearch` syntax (`"phrase"`, `-term`, `OR`). Hybrid and FTS rankings change
   for natural-language questions (the lexical list is no longer empty). Re-run
   `bun run eval:retrieval`; tune `MIN_RERANK_SCORE`/`RETRIEVAL_*` only after that.
   Clients that depended on quoted phrases or exclusions must filter themselves.
8. **Extract.** A v2 job that would process more than `MAX_PAGES` pages (default
   500, `0` = unlimited) now fails terminally; the limit counts the pages the job
   covers (the last page of the requested range, e.g. `pages: "3-10"`), not the raw file. `DERIVED_PDF_CACHE` (default on) keeps
   converted PDFs under `TEMP_DIR/derived-pdf` — see below for its retention.
   `JOB_CONCURRENCY` (default 1) multiplies the model load: peak vision calls ≈
   `JOB_CONCURRENCY × PAGE_CONCURRENCY × replicas`.
   - **Local converter.** `CONVERTER_MODE=local` aborts the start in production
     unless you run `CONVERTER_MODE=isolated` or acknowledge the risk with
     `CONVERTER_ALLOW_LOCAL_HTML=true` (then it stays a readiness warning). In
     staging and development it is a warning, so check with `ATF_PROFILE=staging`.
     The Helm chart converts inside the Extract pod, so it exports the
     acknowledgement by default (`extract.config.converterAllowLocalHtml`).
   - **Pinned jobs restart once.** The LibreOffice version and the prompt
     versions (page 2.1.0, figure 2.1.0, summary 2.2.0) are part of the snapshot
     hashes. A job that is paused or running under `resume_policy: pin` when you
     upgrade no longer matches and has to be restarted. Let running jobs finish
     (or pause none) before the rollout; completed documents are unaffected.
   - **Retention.** `DELETE /v2/documents/{reference}` now removes the
     reference's jobs, upload sessions and unused source bytes in Extract; export
     a job first if you want to keep it. For everything else set a rule:
     `JOB_RETENTION_DAYS` (default 0 = keep; the production gate warns) drops
     finished jobs and their stored model responses after that many days,
     `UPLOAD_SESSION_MAX_AGE_HOURS` (default 72) drops abandoned resumable
     uploads, `RETENTION_SWEEP_INTERVAL_MINUTES` (default 60) sets the cadence.
     Source bytes are not swept by age because `/v2/render` needs them while
     Search serves the document; they go with the document or an erasure.
   - **`/v2/render`** renders only the requested region, once. Images can differ
     slightly from before (rendered at the reported DPI, not enlarged); a client
     that cached by pixel size is unaffected, one that assumed an upscaled size
     gets the pixels the source can deliver.
9. **Evidence signing (optional, recommended).** Set `EVIDENCE_SIGNING_KEY`
   (Ed25519) so anchors, evidence bundles and erasure receipts are verifiable by
   third parties against `GET /.well-known/atf-evidence-jwks.json`. Back the key
   up with the other signing secrets ([runbooks/backup-restore.md](runbooks/backup-restore.md))
   and keep the **public key of every key that ever signed an artefact you still
   have to verify**: the endpoint publishes only the current key, so after a
   rotation old artefacts need the archived JWKS
   ([runbooks/key-rotation.md](runbooks/key-rotation.md)). HMAC artefacts keep
   verifying with the old secrets; nothing breaks if you do nothing.

10. **Gate.** Imported MCP tools are `read` only when the downstream declares
    `annotations.readOnlyHint: true`; all others import as `write`, so write
    gating and approval rules apply — review which tools your read-only clients
    can still reach, or set `access` on the import/override. The monitor's logout
    is `POST /monitor/logout`; `GET` answers 405. OIDC login uses PKCE and a
    `nonce`; the IdP must support S256 and return the `nonce` claim. With several
    trusted OAuth issuers and tenant isolation, list each issuer's tenants in
    `tenantIsolation.issuerTenants` (fatal in production when empty).
11. **Search.** `FTS_RANKER=bm25` needs the ParadeDB `pg_search` extension and a
    `USING bm25` index on the collection table, created with pg_search's mandatory
    `key_field` parameter (this service creates neither). VectorChord-bm25 indexes are ignored. Tables
    without such an index use the full-text path and log a warning once; create the
    index and it is used within a minute. The lexical list ranks chunks that contain
    all query terms first (AND before OR) and uses at most 32 distinct terms of a
    query. New tuning settings (`RERANK_BATCH_SIZE`, `RERANK_BATCH_CONCURRENCY`,
    `HYDE_CACHE_TTL_SECONDS`, `BATCH_WORKER_EMBED_CONCURRENCY`) have defaults that
    change nothing you must act on; context expansion runs at most 8 hits in
    parallel (fixed); `/v2/search` now honours
    `X-Valid-At`, and grouped results mark gaps between non-adjacent chunks with
    `[…]`.
12. **Runtime.** An erasure that reached no store returns `failed` (502), not
    `complete`; `POST /admin/compliance/erasures/{id}/retry` also resumes an
    operation whose run died (202 while another run holds it). Cleartext subject
    identifiers disappear from an operation once it is `complete`. A deleted flow
    file now stops being served, and a flow file that does not load shows up in
    `/health/ready` as `flow_load: degraded` (never 503) and in the gauge
    `aiperator_flow_load_failures` — alert on it. Optional: `COMPLIANCE_POLICY_REQUIRED=true`
    refuses a production start without a compliance policy; the production gate
    warns while `EGRESS_ALLOWED_HOSTS` is empty. See also
    [EU-AI-ACT.md](EU-AI-ACT.md).
13. **Flow CI.** `check:flow-versions` now also counts `compliance-policy`,
    `access`, `canary`, `experiments` (and `constants` for flows that use it) as
    inputs of every flow: changing one needs a version bump of the affected flows.
    `cli.ts validate` prints the failing fields.
14. **Gate: who resolves an approval.** The resolver of a pending approval is now
    recorded from the verified identity of the caller (`ctx.subject`); the
    `approver` a client sends stays only as a display label (`declaredApprover`)
    in the event. Nothing is enforced until you opt in:
    `policies.approval.requireDifferentApprover: true` makes the requester unable
    to resolve its own request (403, the request is **not** consumed) and requires
    a different principal of the same tenant holding `policies.approval.approverScope`
    (default `approvals:resolve`). Turn it on only when approvals are resolved by
    people or a service that is not the requester; with the Runtime acting as the
    resolver for its own calls the same identity requests and resolves, and the
    option would block every approval.
15. **Tool results carry a content-trust label; taint mode (optional).** Gate adds
    `_meta["io.atf/content-trust"] = { content_trust: "untrusted", source }` to the
    results of executed tools (not to its own denials). Clients that validate
    `_meta` strictly must allow the key; the Runtime reads it. `TAINT_MODE`
    (Runtime, default `on-finding`) decides what taints an execution: the default
    is unchanged (an injection finding by the scanner). `on-untrusted-source` also
    taints it as soon as a result labelled untrusted is read, so
    `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL` then fires for every write after any
    such read, not only after a detected injection: expect more approval prompts
    in flows that read documents and then write. With
    `TAINT_MODE=on-untrusted-source`, results of MCP servers without
    `contentTrust: trusted` now taint the execution (previously only results
    labelled untrusted by Search or the Gate). Mark internal, curated servers
    with `contentTrust: trusted`.
16. **AI disclosure (optional).** `AI_DISCLOSURE=header` adds `X-AI-Generated: true`
    to successful `/v1/chat/completions` and `/v1/responses` responses;
    `field` adds `metadata.ai_generated: "true"` to a non-streaming JSON body (a
    stream carries the header). Default `off`; see [EU-AI-ACT.md](EU-AI-ACT.md).
17. **Health shows an open door.** With `AUTHN_MODE=disabled` Runtime
    (`/health`, `/health/ready`), Search and Extract (`/health`) and Gate
    (`/healthz`, `/readyz`) now include `"auth": "disabled"`, and the Runtime
    warns at start. The field is absent otherwise; a probe that compares the
    whole body to a fixed shape needs to allow it. The Runtime's production gate
    still refuses to start unauthenticated.
18. **Extract: page windows.** `pages` on `POST /v2/jobs` used to be accepted and
    **ignored**. It is now a contiguous window of the source, in source page
    numbers: `"5"`, `"3-10"`, `"5-"`, `"-8"`. A list such as `"1-10,15"` or a
    reversed window is rejected with 400, and a `from` beyond the source fails the
    job terminally, before any model call. `MAX_PAGES` counts the window. The
    indexed pages keep the source's own numbers (a window `"5-7"` yields pages 5, 6,
    7), and Search checks completeness over `[firstPage, pageCount]`. A native
    source (BPMN, a chart-free XLSX) is always staged whole. `@atf/extract-contract`
    is **2.4.0** (wire `atf-extract/2.4.0`): `document.begin` and `document.end`
    gain the optional `firstPage`. A Search without this change expects a stream to
    start at page 1 and rejects a window at the final commit, so **upgrade Search
    before you send windowed jobs**; streams without `pages` are unchanged in both
    directions.
19. **Extract: earlier visibility, a different default.** The emitter now commits
    each segment as soon as its batches and assets are acknowledged, instead of
    after the last batch, and `SEGMENT_PAGES` defaults to **100** (was 250). With
    `visibility: progressive` the first pages of a long document are searchable
    while the rest is still being handed over; the processing phase before the
    hand-over is unchanged, so a document is still searchable only after all its
    pages are processed. Measured effect and the price (more commit round-trips,
    a longer hand-over until everything is searchable) are in the Extract README.
    `EMIT_BATCH_PAGES` stays 20; its value is now frozen per job when the first
    batch is sent, so changing it never re-maps the batches of a revision that is
    already open. The v1 ingest threshold for answering `202` instead of waiting is
    decoupled from `SEGMENT_PAGES` and stays at 250 pages.
20. **Transaction tokens: move off the shared secret (optional, recommended).**
    HS256 still works everywhere; the production gates of Gate and Search now warn
    while it is accepted ([ADR-0035](adr/0035-asymmetric-transaction-tokens-audience-per-service.md)).
    The runtime, the Gate and now Search can run on Ed25519 with each service
    keeping its own audience. In this order, so nothing is rejected at any step:
    1. Runtime: generate an Ed25519 key (PKCS#8 PEM) and set `TRANSACTION_SIGNING_KEY`;
       leave `TRANSACTION_SIGNING_ALG` as it is for now. While the algorithm is HS256,
       `GET /.well-known/atf-transaction-jwks.json` answers `{"keys":[]}`; it
       publishes the key once the algorithm is switched in step 4.
    2. Every verifier **accepts both**: Gate — keep `MCPGATE_TRANSACTION_HS256_SECRET`
       and add `MCPGATE_TRANSACTION_JWKS_URI` (default algorithms are then HS256 plus
       RS256/ES256/EdDSA); Search — keep `TRANSACTION_HS256_SECRET` and add
       `TRANSACTION_JWKS_URI` (new; default algorithms HS256, ES256, EdDSA). The JWKS
       URL must be https in Search production.
    3. Give each service its own audience: Gate `MCPGATE_TRANSACTION_AUDIENCE`
       (for example `mcpgate-taiga`), Search `TRANSACTION_AUDIENCE`, and on the
       runtime `AGENT_TRANSACTION_AUDIENCES='{"taiga":"mcpgate-taiga","search":"vectorsearch"}'`
       (server name → audience). Roll the verifiers first, then the runtime.
    4. Runtime: `TRANSACTION_SIGNING_ALG=EdDSA`. Tokens are now signed with the key.
    5. Verifiers drop HS256: remove the secret and set
       `MCPGATE_TRANSACTION_ALGORITHMS=EdDSA` / `TRANSACTION_ALGORITHMS=EdDSA`; the
       warnings stop. Remove `AGENT_TRANSACTION_SECRET` from the runtime.
    The JWKS publishes only the active key, so rotate in a quiet window: tokens
    signed with the old key that are still in flight (TTL ≤ 300 s) are refused.
21. **Flow evaluation (optional).** Matrix tasks and eval cases accept structured
    `assert` / `expected` checks (`contains`, `regex`, `jsonPath`, `toolCalled`,
    `maxTokens`, `finishReason`, `noDiagnostic`) next to the reference answer;
    existing cases keep working unchanged. `bun run eval:extract-quality` scores extraction (CER, Heading-F1,
    TEDS) against a golden set — see [scripts/eval/README.md](../scripts/eval/README.md).
22. **Config checks for several replicas.** The production gates now warn about
    things that are per process today (see "Not yet shared between replicas"
    below): Runtime — a media store serving `show_figure` links, and the receipts
    transparency log, with `REPLICAS > 1`; Gate — `server.pagination.secret`
    unset with a paginated database tool and `MCPGATE_REPLICAS > 1`.
23. **Flow files: YAML merge keys.** `<<` merge keys are now expanded. A flow that
    relied on the old behaviour (merged keys silently missing) now receives those
    keys. Run `bun run scripts/cli.ts validate <flows-dir>` in `apps/runtime`
    before the upgrade and review flows that use `<<`.
24. **Unknown node `config` keys.** Run `bun run scripts/cli.ts validate <flows-dir>`
    (in `apps/runtime`) before upgrading a production Runtime; every warning about an
    unknown config key becomes a flow load failure there. Rename typos or prefix
    annotation keys with `x-`.
25. **Gate monitor stream.** OIDC users now see only events of their own tenant
    (`monitoring.tenantScope: session`) and tool results only as digest
    (`monitoring.includeToolContent: false`). Set `tenantScope: all` and/or
    `includeToolContent: true` to restore the previous view. The static monitor
    token keeps the operator view (all events) either way.
26. **Runtime: `regulated` presets.** `ATF_PRESET=regulated` (and
    `regulated-multitenant`) now also set `TAINT_MODE=on-untrusted-source`,
    `AI_DISCLOSURE=header` and `COMPLIANCE_POLICY_REQUIRED=true`, and in the
    production operational profile they turn a missing `AUDIT_ANCHOR_FILE`, an empty
    `EGRESS_ALLOWED_HOSTS` and a missing `EVIDENCE_SIGNING_KEY` from warnings
    into start aborts. Set those four before upgrading, or override the preset
    values explicitly — an explicit environment variable always wins.
27. **Runtime: `PROFILE` is renamed to `ATF_PRESET`.** The preset variable was
    easily confused with the operational profile `ATF_PROFILE`. `PROFILE` still
    works in this release as a deprecated alias (same values) and logs a
    warning; rename it to `ATF_PRESET`. Setting both to different values stops
    startup.
28. **Search: contextual header in the lexical index (optional).** With
    `FTS_CONTEXTUAL_HEADER=on`, ingest writes the document title and section
    path into `ts_search` at weight `D` alongside the chunk content, so a
    keyword query for a term that only appears in the title finds every chunk
    of the document. It applies only to chunks ingested after it is turned on;
    existing rows keep their old index until re-ingested. A language migration
    (`bun run fts:language`) recomputes `ts_search` from the content alone and
    drops the `D` weighting until those chunks are ingested again.
29. **Gate: credential bindings stop the start.** A tool binding on `:ctx.rawToken`,
    on the whole header object `:ctx.headers`, or on `:ctx.headers.authorization`,
    `:ctx.headers.proxy-authorization` or `:ctx.headers.cookie` is rejected when the
    configuration loads (`Binding :ctx.<path> is not allowed (tool '<name>')`) and at
    call time. Single other headers such as `:ctx.headers.x-request-id` stay bindable.
    Tools that need the caller's credential use token exchange or passthrough.
    Search the Gate configuration for `:ctx.` before upgrading.
30. **Gate: `tenantIsolation.issuerTenants` keys must be configured issuers.** A key
    that is neither `auth.oauth.issuer`, one of `auth.oauth.additionalIssuers` nor
    `monitoring.oidc.issuer` stops the start
    (`tenantIsolation.issuerTenants has a key that is not a configured issuer: <key>`).
    Issuers compare without a trailing slash.
31. **Gate monitor OIDC login.** The session tenant now comes from the verified
    tenant claim and the issuer binding, as for API tokens. With
    `tenantIsolation.enabled` (required in production) an ID token without one of
    the `tenantIsolation.claimNames` is refused, where it used to fall back to the
    default tenant; with a non-empty `issuerTenants` the monitor issuer must be
    listed (`"*"` for operators who see every tenant). Both cases answer 401
    `ID token verification failed`; the log names the reason. Configure the
    workforce IdP to send the tenant claim and add `monitoring.oidc.issuer` to
    `issuerTenants` before upgrading, or operators lose access to the monitor.
32. **Gate: behaviour changes without a configuration change.**
    - Tool errors reach MCP clients as `Tool execution failed (reference <id>)`;
      the details are in the Gate log under that reference.
    - A call without the tool's `requiredScopes` is refused before any approval is
      requested; no pending approval is created for it.
    - An approval request resolves exactly once, also across replicas: a second
      concurrent `approvals/resolve` answers 404 (`-32004`). With Redis, more than
      `policies.approval.maxPending` (default 1000) open requests of a tenant answer
      503 until older ones resolve or expire.
    - Approval tokens record the resolver's owner (`aown`). With
      `policies.approval.requireDifferentApprover`, a token without it whose
      approver is the requester is rejected; tokens live for `ttlMs` (default 5 min),
      so this affects only tokens minted shortly before the rollout.
    - The production gate warns while `auth.oauth.allowedTokenTypes` is empty
      (access tokens are not type-checked) and while a database tool uses the `hash`
      redaction strategy without `MCPGATE_REDACTION_HASH_SECRET`. Setting the secret
      switches the digest to HMAC-SHA256, so hashed values in results change once.
    - `server.rateLimit.perIdentity.failMode` defaults to `closed`: with the Redis
      store unreachable the per-identity limiter rejects requests; set `open` to
      prefer availability.
33. **Search: request handling.**
    - Queries longer than `SEARCH_MAX_QUERY_CHARS` (default 400) are cut at a word
      boundary, never rejected; v1 answers then carry `X-Query-Truncated: true`, v2
      and MCP results `query_truncated: true`. Flows that append context to the
      query should raise the limit or move the context out of the query.
    - Transaction tokens without a `typ` header are rejected (tokens minted by the
      ATF Runtime carry `typ: at+jwt`).
    - `group_by_document` keeps at most `SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT`
      (default 8) chunks per document, so the context of a grouped answer can get
      shorter.
    - MCP `search` results are compact JSON; `SEARCH_MCP_PRETTY_JSON=true` restores
      the indentation (also for `trace` and `document_diff`).
    - Results name their revision (`revision_id`), and `document_diff` reports
      `truncated: true` instead of silently cutting long documents. Both are
      additive.
34. **Runtime: audit pseudonyms.** Erasure and policy audit entries carry hashes and
    pseudonyms instead of subject identifiers. Set `AUDIT_PSEUDONYM_PEPPER` (random,
    at least 32 characters), back it up with the other signing secrets and keep it
    stable: without it the pseudonym is an unkeyed SHA-256, and changing it changes
    the pseudonyms of later entries, so they no longer link to earlier ones.
35. **Extract: derived-PDF cache and delete semantics.**
    - The derived-PDF cache (item 8) is keyed by the source digest, the converter
      identity and, for HTML sources, the sanitizer revision, so a LibreOffice
      update or a sanitizer change converts again instead of reusing an old PDF.
      Its limits are enforced when a conversion is written, at start and every
      `RETENTION_SWEEP_INTERVAL_MINUTES`.
    - `DELETE /v2/documents/{reference}` on behalf of an end user removes jobs,
      upload sessions and source bytes only when Search actually deleted the
      reference; when Search deleted nothing for that caller the answer is 404 and
      Extract keeps its jobs, upload sessions and source bytes. A service call without an end-user identity still
      cleans up a reference Search never held.
36. **Runtime: streaming progress is opt-in.** Agent-harness progress reaches a
    streaming chat client as the SSE event `atf.progress` only when the request sends
    `X-ATF-Progress: 1` or `metadata.atf_progress: true`; without it the stream holds
    only OpenAI-compatible chunks, because OpenAI SDKs pass every `data:` frame on as a
    chunk. The debug trace (`progress` per node) and `GET /v1/jobs/{id}` report
    progress regardless.

### 0.19 → next

Changes since 0.19.3 that need operator attention:

1. Runtime: semantic-cache entries written before this release are not found any
   more (new namespace). The cache refills on its own; no action needed.

### Not yet shared between replicas (roadmap)

These are known single-process behaviours, not defects of a correct single-replica
deployment. With `REPLICAS > 1` they show up as warnings; plan around them.

| Behaviour | What happens with several replicas | What to do now |
| --- | --- | --- |
| Runtime media store (`show_figure` links) | A link minted by one replica 404s on another | Pin figure traffic to one replica or route `/v1/media/:id` stickily |
| Runtime receipts transparency log | Each replica keeps its own log | Run receipts on one replica, or accept per-replica logs |
| Gate pagination cursors | Signed with a per-process key unless `server.pagination.secret` is set | Set `server.pagination.secret` |
| Gate approval / invocation stores | In memory without Redis | `MCPGATE_TRANSACTION_REDIS_URL` (already fatal in production for `> 1` replica) |

Also decided and documented, not changed here:

- **Compliance policy.** `COMPLIANCE_POLICY_REQUIRED` stays opt-in. Without
  `COMPLIANCE_POLICY_REQUIRED` the Runtime only logs at startup that no compliance policy is
  loaded; with it, production refuses to start. A stricter default is planned for the
  next minor release, so set it now if you want the stricter behaviour early.
- **Retention.** `JOB_RETENTION_DAYS` stays 0 (keep everything); the production
  gate warns. A default above 0 is a candidate for a later release; set it now to
  match your retention policy.
- **Converter.** The Helm chart keeps `extract.config.converterAllowLocalHtml: true`
  because it converts inside the Extract pod. Running the converter as a sidecar
  (`CONVERTER_MODE=isolated`) is the follow-up that lets you turn it off.
- **Not done:** a multi-key JWKS for `EVIDENCE_SIGNING_KEY` was considered and
  left as it is.

**Derived-PDF cache retention.** The cache holds the full text of converted
documents as PDF. `DELETE /v2/documents/{id}` and `POST /v1/erasure` remove the
entries of the sources they delete, and the cache is bounded by
`DERIVED_PDF_CACHE_MAX_MB` (default 2048, `0` = unlimited) and
`DERIVED_PDF_CACHE_MAX_AGE_HOURS` (default 168, `0` = unlimited), counted from the
last use; a PDF a running job holds is never evicted. Still put `TEMP_DIR` on an
`emptyDir`/tmpfs where you can (it then disappears with the pod), or set
`DERIVED_PDF_CACHE=false`. A persistent `TEMP_DIR` — which `CONVERTER_MODE=isolated`
shares with the converter sidecar — is cleaned by these limits too, but keep it
in the erasure procedure.

**Contracts.** `@atf/extract-contract` 2.4.0 (additive: `pages` as a window,
`firstPage` on `document.begin`/`document.end`), `@atf/security-kit` 1.4.0,
`@atf/evidence-contract` 1.1.1, `@atf/erasure-contract` 1.0.1; wire constants and
bytes of signed payloads are unchanged. `@atf/transaction-contract` is unchanged. New workspace packages `@atf/canonical-json` 1.0.1 and `@atf/mcp-2026` 1.0.0.

**Rollback.** Migration 48 (`audit_chain_meta`) and migration 49
(`erasure_requests.lease_token`) stay in place; the older binary ignores the table and
the column, and the erasure table's new status value `in_progress` reads as `partial`
there. The audit cut-off stays recorded: rows a 0.18 binary writes after a rollback are
legacy-form rows above the cut-off, so a later upgrade reports them as
`legacy_hash_after_cutoff` — move the cut-off as described in item 6. Rolling back keeps
Ed25519 anchors, bundles and receipts written in the meantime: an older binary
does not understand `alg: "ed25519"` and reports them as unverifiable — keep the
new binary around for audits, or verify them offline with the `atf-verify`
binary from the release (`atf-verify --bundle <bundle.json> --jwks <url|file>`;
in a source checkout: `bun run scripts/atf-verify.ts`). The
`apps/runtime` alternative `bun run scripts/cli.ts verify-bundle <bundle.json>
--jwks <url|file>` remains available.

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
| Extract refuses to start in production: `CONVERTER_MODE is local` | The in-process converter is fatal in production since this release | `CONVERTER_MODE=isolated`, or acknowledge with `CONVERTER_ALLOW_LOCAL_HTML=true` |
| Helm: Extract pod exits at start, `CONVERTER_MODE is local` (custom values or manifests) | The chart's acknowledgement (`extract.config.converterAllowLocalHtml`) was set to false or the variable was not carried over | Restore it, or provide an isolated converter |
| Helm: Search/Extract pod exits at start in production, rate-limit store missing | The chart now declares `replicaCount` (default 2) as `REPLICAS` | Provide `RATE_LIMIT_REDIS_URL`, or `replicaCount: 1` |
| Pinned Extract job reports a changed snapshot after the upgrade | LibreOffice identity and prompt versions are part of the pipeline/prompt hash | Restart the job; finish running jobs before upgrading |
| 405 on `GET /monitor/logout` | Logout is `POST /monitor/logout` | Use the shipped page or a `POST` form |
| 404/405 on `/document-assets/:assetId` after the upgrade | The v1 asset routes were removed in 0.18.0 | Read via `GET /v2/assets/{id}?collection=…`; write via the v2 job pipeline |
| Figures missing after upgrading Extract | `SEARCH_UPLOAD_ASSETS` removed; v1 ingest no longer uploads crops | Run the v2 job path (`EXTRACT_DATABASE_URL`, `SOURCE_STORE_DIR`, `BATCH_WORKER`) |
| Chat answers 503 | `compliance-policy.yaml` is unreadable or schema-invalid and no valid policy was loaded | Fix the file; `GET /admin/compliance-policy` shows the load error |
| A write tool is refused or waits for approval after a document search | Taint rule after an injection finding (`TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`) | Approve it, declare `readOnlyHint` on read-only tools, or opt out explicitly (readiness warning) |
| Everything is dropped after rerank (abstention) | `MIN_RERANK_SCORE` tuned against the old sigmoid-squashed scores | Re-tune it or set `RERANK_SCORE_TRANSFORM=sigmoid` |
| Start aborts: `unknown operational profile` (Runtime, Gate, Search, Extract) | `ATF_PROFILE`/`APP_ENV`/`MCPGATE_ENV`/`NODE_ENV` is not `development`, `staging`, `production` or `test` (e.g. `prod`, `local`, `ci`) | Use one of the four values; `ATF_PROFILE` overrides the service variable |
| Search start aborts: `EMBED_FALLBACK_MODEL … differs from EMBED_MODEL` | The fallback would put a second embedding space into the index | Same model for both, or `EMBED_FALLBACK_SAME_SPACE=true` when both names serve the same weights |
| Gate refuses to start in production: playground / plaintext URL | `monitoring.playground.enabled` is on, or `server.publicUrl` / `monitoring.oidc.redirectUri` is `http://` | Disable the playground, use `https://` (or run `staging`) |
| Search/Extract refuse to start: `REPLICAS` without shared rate limit | `REPLICAS > 1` in production and no `RATE_LIMIT_REDIS_URL` | Set `RATE_LIMIT_REDIS_URL` (and install `redis` in the image), or declare `REPLICAS=1` only if that is true |
| Extract job `failed`, message `…the configured limit is N (MAX_PAGES)` | The job covers more pages than `MAX_PAGES` | Raise `MAX_PAGES`, request fewer pages (narrow the requested range, e.g. `pages: "3-10"`), or set `0` |
| Quoted phrases / `-term` in Search queries no longer behave as before | The lexical branch ORs plain terms; `websearch` syntax is not parsed | Filter client-side; use `filter`/identifier lookups for exact matches |
| `verifyChain` reports `legacyForm: N` | N rows verify only under the pre-fix hash form | Expected for chains older than the fix; not tampering. Rows after the canonical cut-off must verify canonically |
| Compound words are not found | `german_compound` needs Hunspell files in the PostgreSQL image | See `operations-and-retrieval.md` (German full-text search) |
| Flow missing after upgrade, `/health/ready` shows `flow_load: degraded` (the file and the "Unknown config keys" reason are in the flow load log) | Production profile rejects config keys the node type does not read | Fix the key or prefix it with `x-`; check with `cli.ts validate` |
| Gate does not start: `Binding :ctx.… is not allowed (tool '…')` | A tool binds the caller's token, the whole header object or the `authorization`/`proxy-authorization`/`cookie` header | Remove the binding; use token exchange or passthrough for credentials (item 29) |
| Gate does not start: `tenantIsolation.issuerTenants has a key that is not a configured issuer` | An issuer-binding key matches no OAuth or monitor issuer (typo, or an issuer that was removed) | Fix or remove the key (item 30) |
| Monitor login answers 401 `ID token verification failed` after the upgrade | The monitor ID token has no tenant claim, or its issuer is missing from a non-empty `issuerTenants` | Send the tenant claim from the IdP and bind the monitor issuer (item 31) |
| `verifyChain` reports `legacy_hash_after_cutoff` | A 0.18 Runtime pod wrote an audit row after a 0.19 pod set the canonical cut-off (rolling update or rollback) | Stop all old pods; move the cut-off past the rollout window after checking the rows (item 6) |

## Rollback

Migrations are additive, so rolling back to the previous version is possible
as long as no new columns or tables were written (for 0.13/0.14:
`flow_drafts`, `vision_daily_usage`; for 0.16: the nullable `iss` columns of
migration 47, which the older binary ignores). After a rollback from 0.16, collections whose
FTS language you switched keep `german` vectors; switch them back with `bun run fts:language`.
A rollback from 0.18 keeps `vs_assets` and its rows in place (harmless to an older binary),
but stops storing figure crops — see the 0.17 → 0.18 notes above. Otherwise restore from the
pre-upgrade backup (`runbooks/backup-restore.md`) — the Extract source store and the Search
asset store are forward compatible.
