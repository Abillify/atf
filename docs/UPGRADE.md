<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Upgrade guide 0.3 → current (0.14)

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

### 0.14 → unreleased (platform hardening)

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
- Review the **Changed** and **Security** sections of `[Unreleased]` in the
  CHANGELOG: several production-gate rules now refuse configurations that
  used to start.

## Known upgrade blockers

| Symptom | Cause | Fix |
| --- | --- | --- |
| Runtime does not start, `unknown column` | A replica of the previous version wrote after the migration | Run all replicas on one version; no mixed operation across migrations |
| 429 storm after the rollout | More replicas against the same provider quota | Raise the quota or configure a fallback model (`runbooks/scaling.md`) |
| Sessions gone after the upgrade | `OIDC_SESSION_SECRET` changed | Expected — log in again; use a rollout window if needed |
| Extract jobs hang | Converter sidecar without the shared socket/volume | Configure the sidecar as described above |
| Production replica starts against an old schema | `MIGRATE_ON_START` unset in production and no migration job ran | Run `bun run migrate` (or the Helm hooks) first |

## Rollback

Migrations are additive, so rolling back to the previous version is possible
as long as no new columns or tables were written (for 0.13/0.14:
`flow_drafts`, `vision_daily_usage`). Otherwise restore from the pre-upgrade
backup (`runbooks/backup-restore.md`) — the outstore is forward compatible.
