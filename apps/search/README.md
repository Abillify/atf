# @atf/search

Semantic and hybrid retrieval on PostgreSQL with pgvector. Express, running on Bun or Node 26.

One engine, no separate vector database. Search owns ingestion, chunking, embedding, indexing,
and query. It is consumed by [`@atf/runtime`](../runtime) for `retrieval` nodes and RAG, and
directly by models and agents over MCP.

## Run it

From the repository root:

```bash
cp apps/search/.env.example apps/search/.env
# Set POSTGRES_URL, EMBED_URL, EMBED_MODEL, and the embedding contract values.
bun run --filter @atf/search dev
```

The example sets `PORT=3002`, matching the documented multi-service layout. Search needs
PostgreSQL with the `vector` extension and an embedding endpoint. Both are provided by
[`deploy/examples/`](../../deploy/examples/). Verify a standalone instance with
`curl --fail http://127.0.0.1:3002/health`.

```bash
bun run --filter @atf/search test
bun run --filter @atf/search typecheck
bun run --filter @atf/search build        # Bun target
bun run --filter @atf/search build:node   # optional Node 26 artifact
```

## API surface

The generated documents at `GET /openapi.json` and `GET /openapi.yaml` are the detailed API
reference. The principal routes are:

| Endpoint | Purpose |
| --- | --- |
| `POST /ingest`, `/ingest-batch`, `/ingest-stream` | Ingest single, batch, and streaming documents |
| `POST /ingest-file` | Binary document ingest through `@atf/extract`. Mounted only when `CONVERTER_URL` is set, otherwise 404. Uploads the source to Extract (`/v2/uploads`), starts a v2 job and answers 202 with `job_id` and a `Location` for polling; the job's emitter stores the revision and the figure images |
| `PUT`, `GET /document-assets/:assetId` | v1 figure images. The owning document must already be visible, otherwise the write is refused |
| `POST /search` | Dense, hybrid, sparse, and optionally reranked retrieval (v1 shape, unchanged) |
| `POST /v2/search` | v2 retrieval with unit filters, small-to-big expansion, assets and navigation (below) |
| `/v2/documents/{ref}/revisions/…` | Resumable v2 ingest from Extract (below) |
| `PUT`, `GET`, `HEAD /v2/assets/{assetId}` | Revision-bound v2 assets with `thumb` / `preview` / `full` variants |
| `POST /evaluations/retrieval` | Evaluate retrieval results |
| `DELETE /delete` | Delete indexed content |
| `GET /documents`, `/document`, `/documents/content` | List and fetch documents, with score-keyset pagination |
| `GET /folders`, `/summary`, `/summaries` | Read folders and generated summaries |
| `GET /collections`, `/collection-stats` | Collection listing and statistics |
| `DELETE /collections/:name`, `POST /collections/:name/rename` | Collection administration |
| `/mcp`, `/mcp/v2026` | MCP endpoints for models and agents |
| `/admin/stats` | Operational statistics |
| `/auth/login`, `/auth/callback`, `/auth/logout` | OIDC browser session for the test UI |
| `/health`, `/metrics` | Health and Prometheus metrics |

### v2 search

`POST /v2/search` takes a JSON body and sits behind the same auth, tenant and collection-ACL
chain as `/search`; `X-Collection` selects the collection and the temporal headers below apply.
It reuses the v1 building blocks (RRF, rerank, diversify) and leaves `/search` untouched.

| Field | Values | Default |
| --- | --- | --- |
| `query` | non-empty string | required |
| `limit` | positive integer, capped at 100 | 10 |
| `granularity` | `chunk`, `section`, `page`, `document`; applied as a unit-type filter | any |
| `expand` | `none`, `neighbors`, `section`, `page` | `none` |
| `budget_chars` | positive integer, clamped to 200000 | 4000 |
| `include_assets` | `none`, `refs`, `thumbnails` | `refs` |
| `group_by` | `none`, `document`, `section` | `none` |
| `identifier_search` | boolean; adds the identifier list to hybrid RRF | `true` |
| `rerank` | boolean | `false` |
| `filters` | `pages` (`[start, end]`, `[page]` or `{start, end}`), `unit_type` (`chunk`, `table`, `figure`, `section`, `page`, `document`), `figure_kind`, `section_prefix` (array), `identifier` | none |

The response is `{ results: [...] }`. Each hit carries `score`, `unit_id`, `unit_type`,
`reference`, `base_ref`, `title`, `pages` (`{start, end}` or `null`), `content` and:

- `section_path`: the heading path as a string array.
- `expanded`: with `expand` set, `{ mode, content, truncated, unit_count, budget_chars }`;
  `budget_chars` reports the effective, clamped value.
- `assets`: the hit's own figure and every figure it references (`relation: hit | referenced`,
  `asset_id`, `figure_id`, `kind`, `figure_kind`, `caption`, `page`, `bbox`). `refs` returns ids
  only; `thumbnails` adds the ACL-checked `thumb_url` and `url` (`/v2/assets/{id}?variant=…`).
  `none` omits the field.
- `navigation`: `prev`, `next`, `section_id` and the aliases `prev_unit_id`, `next_unit_id`,
  `parent_unit_id`, for walking the document in reading order.
- `evidence`: citation coordinates such as `chunk_id`, `block_ids`, `char_start`/`char_end`,
  `page_start`/`page_end`, `bbox`, `figure_refs`.
- `revision_state: "partial"` with `pages_available` when the hit comes from a still-growing
  progressive revision, and `group` when `group_by` merged hits.

### v2 revision hand-off

Extract's emitter writes documents through these routes (the OpenAPI document has the shapes):

| Route | Purpose |
| --- | --- |
| `POST /v2/documents/{ref}/revisions` | Create a revision (`Idempotency-Key`) |
| `PUT /v2/documents/{ref}/revisions/{rev}/batches/{seq}` | Stage one NDJSON page batch (`Content-Digest`), up to `REVISION_BATCH_BODY_LIMIT` |
| `GET /v2/documents/{ref}/revisions/{rev}` | Revision state: `acceptedBatches`, `processedPages`, `missingAssets`, `committedSegments`, `commitPending` |
| `POST /v2/documents/{ref}/revisions/{rev}/segments/{n}/commit` | Segment commit; a `progressive` revision becomes searchable up to it |
| `POST /v2/documents/{ref}/revisions/{rev}/commit` | Final commit and atomic switch of the latest revision |
| `POST /v2/documents/{ref}/revisions/{rev}/heartbeat` | Extend the TTL of an uncommitted revision |
| `DELETE /v2/documents/{ref}/revisions/{rev}` | Abort and clean up |

Behaviour worth knowing:

- Every revision route checks `X-Extract-Contract`: absent is accepted, malformed is 400, a
  major other than 2 is 422. A `{ref}` that does not own the addressed revision is 409
  `REVISION_REFERENCE_MISMATCH`; reusing an `Idempotency-Key` for another document is 409.
- The final commit checks coverage against the page count from `document.begin`/`document.end`
  and answers 409 with `missingRanges` (including a missing first or last page). An unknown page
  count without a staged `document.end` is 409 `COMMIT_DOCUMENT_END_MISSING`.
- An accepted final commit whose batches are not all processed yet answers **202**
  `{committed: true, pending: true, isLatest: false}`; `GET …/revisions/{rev}` then reports
  `commitPending: true`. The batch worker performs the switch once the last batch is processed,
  and the previous revision stays visible until then. A replayed commit is idempotent.
- `PUT /v2/assets/{assetId}` requires a lowercase sha256 asset id. The revision from
  `X-Revision-Id` and/or `?revision=` must exist in the tenant and collection, belong to
  `X-Document-Reference` and not be aborted. An asset already bound to a live revision keeps that
  binding.

### Background workers

**Batch worker** (`BATCH_WORKER=true`, off by default). Staged batches only become searchable
when a worker processes them: it claims `received` batches with `FOR UPDATE SKIP LOCKED` under a
lease, builds chunk/table/figure units (plus section/page/document summary units from
`document.end`), embeds and upserts them, and marks the batch `processed` in one transaction. An
embedding failure rolls the batch back to `received` with `BATCH_WORKER_BACKOFF_MS` backoff; unit
ids are deterministic, so reprocessing replaces in place. It also completes accepted final
commits once their last batch is processed. Any deployment using the revision API needs it on
at least one replica; `BATCH_WORKER_INTERVAL_MS` sets the poll interval (0 stops the loop).

**Revision TTL cleaner.** An uncommitted revision that is neither committed nor heartbeated
within `REVISION_TTL` seconds (default 14 days) is reaped every `REVISION_TTL_SWEEP_MS` (default
1 hour, 0 disables), cascading to its batches, segments, revision-bound assets and already
written units. A paused Extract job keeps its revision alive through the heartbeat route; a
committed revision is never reaped.

### Assets

`PUT /v2/assets/{assetId}` stores the `full` variant (PNG, JPEG, WebP or GIF, up to 20 MiB),
idempotent on the SHA-256 checksum, and eagerly generates `thumb` (512 px long edge) and
`preview` (1568 px). `GET`/`HEAD` take `?variant=thumb|preview|full` (default `full`) and
`?collection=` or `X-Collection`, and only resolve when the asset's document is visible to the
caller in its current revision (or a legacy v1 row). Two backends via `ASSET_STORE_BACKEND`:

- `postgres` (default): bytes in the `vs_assets` BYTEA column.
- `filesystem`: bytes under `ASSET_STORE_DIR` (required then) on a persistent volume; the
  `vs_assets` row keeps all metadata and a pointer.

With `CONVERTER_URL` set, zoom and full-resolution regions are rendered on demand by Extract's
`POST /v2/render` and cached as asset variants; `CONVERTER_TOKEN` must carry `extract.admin`.

### MCP navigation tools

Registered on the same MCP server as the search tools (`/mcp` and `/mcp/v2026`), with the same
tenant/ACL and revision-visibility gates, so navigation never reaches a unit or asset the caller
could not retrieve through search:

| Tool | Purpose |
| --- | --- |
| `get_outline` | Table of contents with section ids and pages (`reference`, `depth`, `limit`, `offset`) |
| `get_section` | One section as Markdown (`section_id` or `section_path`, `max_chars`) |
| `get_pages` | A page range as Markdown or summary (`from`, `to`, `format`, `max_chars`) |
| `get_context` | Reading-order neighbours of a unit (`unit_id`, `before`, `after`) |
| `list_figures` | Figures of a document or page range (`from_page`, `to_page`, `kind`), paginated |
| `get_asset` | An image as MCP image content (`variant`, optional `region` zoom with `target_pixels`); fails closed when `expected_document_reference` / `expected_figure_id` do not match |
| `get_table` | A logical table reassembled across pages (`table_id`, `rows`) |
| `find_identifier` | Exact occurrences of an identifier across the collection, paginated |
| `follow_ref` | Resolve the figures a unit references |

Every tool also accepts `collection`.

## Temporal document versions

Every ingested document may declare `X-Valid-From` (batch/NDJSON items use `valid_from`; an item overrides the shared header). Values must be RFC 3339 date-times with an explicit `Z` or numeric offset, for example `2026-03-01T09:00:00+01:00`; offset-less timestamps are rejected with HTTP 400. The database stores the nullable value on every chunk. Legacy rows use `effective_valid_from = COALESCE(valid_from, created)`.

`X-Include-All-Versions` and `X-Valid-At` are independent:

| Include all | Valid at | Result |
| --- | --- | --- |
| false/omitted | omitted | Rows marked `is_latest=true` (backwards-compatible current search) |
| true | omitted | Every stored version |
| true | `X` | Every version with `effective_valid_from <= X` |
| false/omitted | `X` | The version with the greatest effective start not after `X`, per logical document; all chunks of that version remain searchable; ties use `created`, then `id` |

```bash
# Current/latest
curl -H 'X-Collection: policies' --data 'retention' http://localhost:3002/search
# Complete history
curl -H 'X-Collection: policies' -H 'X-Include-All-Versions: true' --data 'retention' http://localhost:3002/search
# One version as of an instant
curl -H 'X-Collection: policies' -H 'X-Valid-At: 2026-03-01T00:00:00Z' --data 'retention' http://localhost:3002/search
# Every version introduced by that instant
curl -H 'X-Collection: policies' -H 'X-Include-All-Versions: true' -H 'X-Valid-At: 2026-03-01T00:00:00Z' --data 'retention' http://localhost:3002/search
```

Search results expose both nullable `valid_from` and always-present `effective_valid_from`. The same `valid_at` contract is available in retrieval evaluation and the MCP `search`, `retrieve_evidence`, and `verified_evidence_pack` tools.

## Retrieval pipeline

```text
query
  ├─ dense    embed → HNSW vector search
  ├─ lexical  PostgreSQL full-text search
  └─ sparse   optional SPLADE-style vectors
        └─ RRF fusion → optional rerank → results + citations
```

Optional quality stages, each independently configurable: **HyDE** (search with a hypothetical
answer rather than the raw question), **semantic chunking** (split on meaning, not character
count), **late chunking** and **contextual retrieval** (give each chunk its document context so
it is not read out of context), and **reranking** (a second, more precise ordering, synchronous
or streamed, with an optional fallback reranker).

## Two things that will bite you

**Embedding revisions.** Changing the embedding model under an existing index silently destroys
relevance, because old and new vectors are not comparable. `EMBED_MODEL_REVISION` and
`EMBED_EXPECTED_DIMENSION` turn that into a startup failure instead. Set both, and treat a
revision change as a reindex.

**The embedding request field.** OpenAI-compatible servers expect `input`; TEI expects `inputs`.
`EMBED_INPUT_FIELD` selects it and defaults to `inputs`. A mismatch shows up as an opaque
upstream error.

## Access control

The verified identity is authoritative and is never taken from a client-supplied field
(ADR `search/0001`). Retrieval is scoped by identity and group membership. `AUTHN_MODE` defaults
to open for local development — it **must** be enabled before any deployment, including internal
ones.

## Configuration

[`.env.example`](.env.example) is the annotated starting point;
[`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) lists all variables, generated from
`src/config.ts`. Search has its own environment contract: variable names that also exist in
Runtime are not shared. Rollout order for the v2 variables:
[`docs/document-intelligence-v2-migration.md`](../../docs/document-intelligence-v2-migration.md).

The v2 variables worth deciding deliberately:

| Variable | Default | Why it matters |
| --- | --- | --- |
| `BATCH_WORKER` | false | Without it staged revision batches never become searchable |
| `BATCH_WORKER_INTERVAL_MS` | 2000 | Poll interval; 0 stops the loop |
| `BATCH_WORKER_BACKOFF_MS` | 30000 | Retry delay after an embedding failure |
| `REVISION_TTL` | 1209600 (seconds, 14 days) | Lifetime of an uncommitted, un-heartbeated revision |
| `REVISION_TTL_SWEEP_MS` | 3600000 | Cleaner interval; 0 disables |
| `REVISION_BATCH_BODY_LIMIT` | 50mb | Largest NDJSON page batch |
| `ASSET_STORE_BACKEND` | postgres | `postgres` or `filesystem` |
| `ASSET_STORE_DIR` | (unset) | Required for `filesystem` |
| `RRF_WEIGHT_DENSE`, `RRF_WEIGHT_FTS`, `RRF_WEIGHT_IDENTIFIER` | 1.0 | Per-list RRF weights (> 0); the identifier list only joins when the query carries an identifier |
| `TOKENIZE_ENABLED` | true (false for Bedrock) | Measured chunk token counts via TEI `/tokenize`; otherwise a character heuristic |
| `TOKENIZE_URL` | derived from `EMBED_URL` | |
| `TOKENIZE_TIMEOUT_MS` | 5000 | 0 disables |
| `TOKENIZE_CACHE_SIZE` | 2048 | 0 disables |
| `CONTEXT_HEADER_MAX_FRACTION` | 0.15 | Share of the chunk token budget the contextual header may use |
| `CONTEXTUAL_CHUNK_LLM` | false | One `SUMMARY_*` model call per chunk for a placement sentence; expensive |

## Further reading

- [`docs/operations-and-retrieval.md`](../../docs/operations-and-retrieval.md) — operational
  behavior and retrieval tuning
- [`docs/adr/search/`](../../docs/adr/search/) — identity authority and pagination decisions
- [`apps/extract/README.md`](../extract/README.md) — the converter behind `/ingest-file`, its v2
  job model and the emitter that writes into the revision API
