<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Migration Guide

This guide describes how an existing deployment moves onto the Document Intelligence v2
ingestion path. The move is designed to be incremental and non-breaking: v1 ingest keeps
working the whole time, and each v2 capability is switched on by configuration rather than by a
flag day.

## What v2 changes, and what stays

| Area | v1 (before) | v2 (after) |
| --- | --- | --- |
| Extract → Search handover | one `POST /ingest` of Markdown, figure crops via `PUT /document-assets` | resumable `PUT` of contract batches into a **revision**, assets via `PUT /v2/assets`, atomic commit |
| Contract | v1 marker grammar (`## Seite N`, `<figure>`) | `@atf/extract-contract` v2 NDJSON record stream; v1 grammar remains under the `/v1` subpath |
| Extract processing | in-process, lost on crash | persistent **jobs** in the `extract` schema, resumable from the last checkpoint |
| Source intake | single upload | resumable chunked upload + SSRF-guarded `source_url` pull |
| Assets | `vs_document_assets`, figure descriptions only over `/ingest-file` | `vs_assets`, revision-bound, with `thumb`/`preview` variants and images stored |

What does **not** change:

- `/search` (v1) is untouched.
- `/ingest` still accepts v1 Markdown through the legacy adapter. Search now
  runs that Markdown through the contract's v1 parser, but the observable behaviour is the same.
- Existing figure **asset ids stay stable**, so anything that already resolved an asset keeps
  resolving it after the cutover.

## The contract v1 subpath

`@atf/extract-contract` is now version 2.0.0. The v2 typed block model, NDJSON codec and
validator are the default export; the v1 marker grammar is still available as a subpath import
(`@atf/extract-contract/v1`) and is what Search's legacy `/ingest` adapter uses. Search also
checks the `X-Extract-Contract` header on the v2 revision path and refuses an incompatible
**major** version, so a mismatched Extract build fails fast instead of writing garbage.

No action is required from a deployment for this — it is a code-level change — but a client that
pinned an exact workspace version of the contract package should update its reference.

## Step 1 — Migrate the asset table (`vs_document_assets` → `vs_assets`)

Search's migration runner creates the v2 revision/staging tables and the new `vs_assets` table,
then backfills it from the legacy `vs_document_assets` table. The backfill is:

- **automatic** — it runs as a global migration step at Search startup;
- **additive and idempotent** — legacy rows land as `kind='figure'`, `variant='full'`, with a
  `NULL` revision_id (v1 ingest wrote no revisions), and re-running does nothing on rows that
  already exist;
- **guarded** — on a fresh deployment that never created `vs_document_assets`, it is a clean
  no-op.

There is nothing to run by hand. On a large corpus, budget for the one-time backfill to run
during the first startup after the upgrade, and confirm it completed by checking that
`vs_assets` row counts match the legacy figure counts before decommissioning any tooling that
read `vs_document_assets` directly. The legacy table is left in place; drop it only after you
have confirmed the cutover.

## Step 2 — Enable the Extract database (`EXTRACT_DATABASE_URL`)

The persistent v2 job path — resumable uploads, durable jobs, the staged pipeline and the
emitter — is off until Extract has its own database.

- Set `EXTRACT_DATABASE_URL` to the shared PostgreSQL instance. Extract owns the `extract`
  schema; its migration runner creates the job, stage, upload and outbox tables at startup.
- Provision the persistent volumes: `SOURCE_STORE_DIR` (the content-addressed source store) and
  `UPLOAD_TMP_DIR` (scratch space for in-progress chunked uploads). Both must survive restarts,
  because a resumable upload's bytes live on the volume while its confirmed offset lives in the
  database.
- Optionally tune `EXTRACT_DB_POOL_MAX` and `EXTRACT_DB_STATEMENT_TIMEOUT_MS`.
- Configure the SSRF allowlist `SOURCE_URL_ALLOWED_HOSTS` before enabling `source_url` pulls; the
  production-readiness gate flags an empty allowlist. `SOURCE_URL_MAX_BYTES` and
  `SOURCE_URL_TIMEOUT_MS` bound each pull. See [SECURITY.md](../SECURITY.md).

When `EXTRACT_DATABASE_URL` is absent, Extract keeps its original in-process synchronous
behaviour, so this step is safe to defer.

With the database present, `/v1/ingest` automatically becomes a thin wrapper around a v2 job:
the upload is stored, a job is created, and its emitter streams the revision **and figure
assets** into Search — so figure images are now stored, not only their descriptions. Search's `/ingest-file` likewise starts a v2 job at Extract and returns the
job id.

## Step 3 — Enable the Search batch worker (`BATCH_WORKER`)

Search stages accepted batches durably and processes them out of band. Set `BATCH_WORKER=true`
on the Search service (or on a dedicated Search replica) to run the worker that claims staged
batches with `SKIP LOCKED`, builds index units, embeds, and upserts. Tune
`BATCH_WORKER_INTERVAL_MS` and `BATCH_WORKER_BACKOFF_MS` as needed. Without the worker, batches
stage but never become searchable, so this must be on for any deployment using the revision API.

Asset storage backend: `ASSET_STORE_BACKEND` defaults to `postgres` (bytes in a BYTEA column).
For `filesystem`, set `ASSET_STORE_DIR` to a persistent volume; the `vs_assets` row still carries
all metadata and a pointer.

Relevant emitter/handover tunables (all documented in
[CONFIGURATION.md](CONFIGURATION.md)): `EMIT_BATCH_PAGES`, `SEGMENT_PAGES`,
`ASSET_UPLOAD_CONCURRENCY`, `REVISION_TTL`, `REVISION_TTL_SWEEP_MS`, `REVISION_BATCH_BODY_LIMIT`.

## Step 4 — Deploy and verify

1. Roll out Search first (creates the v2 tables, runs the backfill), then Extract with
   `EXTRACT_DATABASE_URL`, `SOURCE_STORE_DIR`, `UPLOAD_TMP_DIR` and the SSRF allowlist set.
2. Confirm the two services agree on the contract: a v2 batch `PUT` carries
   `X-Extract-Contract`, and a major mismatch is rejected — a healthy pair never logs that
   rejection.
3. Ingest one document through `/v1/ingest` and confirm the response now carries `job_id` and
   `revision_id`, that the figure assets are retrievable via `GET /v2/assets/{id}`, and that a
   large document is answered `202` with a job to poll at `GET /v2/jobs/{id}`.
4. Existing v1 clients that still call `/ingest` with Markdown must keep succeeding unchanged.

## Rollback

The v2 path is additive. To back out, unset `EXTRACT_DATABASE_URL` (Extract returns to
synchronous conversion) and `BATCH_WORKER` (Search stops draining the staging tables). The
`vs_assets` table and its backfilled rows are harmless to leave in place; `vs_document_assets`
was never removed. No v1 route or stored v1 data is altered by enabling or disabling v2.

## Reprocessing existing corpora

Enabling v2 does not re-extract anything already indexed. Documents that went through the v2
path before these changes also keep what they were ingested with: no tags or metadata on their
units if they came through `/ingest-file`, headerless rows for table continuations, no
paragraph continuation across page breaks, no child documents for DOCX embeddings, and the
quoted history of e-mail replies removed even when the parent was never ingested. Re-ingest
those documents (or the affected collection) to pick up the new behaviour; the whole-document
reads (`get_document`, `get_summaries`) are fixed at read time and need no re-ingest.

To move an existing corpus onto the richer v2 extraction, run the re-ingest CLI `apps/extract/scripts/corpus-migrate.ts` after
steps 1–4:

```bash
# Print the usage-ordered plan and the expected asset ids; contacts no server
bun run apps/extract/scripts/corpus-migrate.ts --manifest corpus.json --plan

# Migrate, most-used documents first
bun run apps/extract/scripts/corpus-migrate.ts \
  --manifest corpus.json \
  --base-url https://extract.example \
  --token "$EXTRACT_TOKEN" \
  --collection documents \
  --out reports/corpus-migration.json
```

- **Manifest.** A JSON array, a `{ "documents": [...] }` wrapper, or NDJSON. Each entry names
  the `reference` and either an already stored `sourceSha256` or a `path` to upload, plus an
  optional `collection`, a usage signal (`hitCount`, `usage`, or `lastAccessed`) and the
  pre-migration asset ids (`assets[].priorAssetId`).
- **`version` mode (default).** Each document is posted to `/v1/ingest` with
  `X-Version-Mode: version` and followed through `/v2/jobs/{id}`. The new revision becomes
  visible only on its final commit, when Search switches `is_latest` atomically, so the corpus
  keeps answering from the old revision throughout.
- **Stable asset ids.** Asset ids derive from the reference and a local id, never from the
  image bytes. The tool recomputes them from the manifest and reports any id that differs from
  `priorAssetId`; a difference is a regression, not an expected change.
- `--plan` / `--dry-run`, or omitting `--base-url`, only prints the plan. `--poll-ms` (default
  2000) and `--timeout-ms` (default 24 h per document) bound job polling. The exit code is
  non-zero on argument errors or when any document failed.

With `EXTRACT_DATABASE_URL` set, the v2 wrapper behind `/v1/ingest` does not interpret
`X-Version-Mode` itself: versioning on the v2 path follows the emitter's revision flow (a new
revision, switched on commit). The header takes effect on Search's synchronous v1 `/ingest`
path, where it selects `replace` or `version`.
