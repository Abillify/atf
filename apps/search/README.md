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

The code default is `PORT=3000`; the example `.env` sets `PORT=3002`, matching the documented
multi-service layout (Runtime 3000, Control 3001, Search 3002, Gate 3003, Extract 3004). Search
needs PostgreSQL with the `vector` extension and an embedding endpoint. Both are provided by
[`deploy/examples/`](../../deploy/examples/). Verify a standalone instance with
`curl --fail http://127.0.0.1:3002/health` (or port 3000 when `PORT` is unset).

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
| `POST /ingest`, `/ingest-batch`, `/ingest-stream` | Ingest single, batch, and streaming documents. With authorization enabled the first write into a collection that does not exist yet is let through (no stored ACL yet) so the handler can create it; the MCP ingest tool tolerates the same case. A trusted writer (service credential, or a principal holding `vectorsearch.acl.manage`) may set explicit per-document viewers with `X-Allowed-Users` / `X-Allowed-Groups`; everyone else keeps the ACL derived from the principal |
| `POST /ingest-file` | Binary document ingest through `@atf/extract`. Mounted only when `CONVERTER_URL` is set, otherwise 404. Uploads the source to Extract (`/v2/uploads`), starts a v2 job and answers 202 with `job_id` and a `Location` for polling; the job's emitter stores the revision and the figure images |
| `POST /search` | Dense, hybrid, sparse, and optionally reranked retrieval (v1 shape, unchanged) |
| `POST /v2/search` | v2 retrieval with unit filters, small-to-big expansion, assets and navigation (below) |
| `/v2/documents/{ref}/revisions/…` | Resumable v2 ingest from Extract (below) |
| `GET /v2/documents/{ref}/diff` | Unit-level diff of one document between two RFC 3339 instants `from` / `to` (below): `added` / `removed` / `changed` (before/after excerpts, max 300 chars) / `unchanged_count` |
| `POST /v2/citations/check` | Check up to 500 cited chunks (`base_ref` + `chunk_id` from a search hit) against the revision visible today: `current` / `carried` (content unchanged in the current revision) / `changed` / `removed` / `unknown`, in input order |
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
| `hyde` | boolean; embeds a hypothetical answer document instead of the query (needs `HYDE_*` config); lexical matching and reranking keep the original query, the response reports `hyde_applied` | `false` |
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

### Answer-ready retrieval

`retrieve_for_answer` (MCP) and `POST /v2/retrieve` (HTTP) turn a question into the evidence that
fits a model's context in one call. By default no model takes part, so the same question over the
same index gives the same answer; `decomposition: "llm"` opts into a model-based split when one is
configured.

| Field | Meaning |
| --- | --- |
| `question` | Required. Cut at `SEARCH_MAX_QUERY_CHARS` like any query (`query_truncated`). |
| `budget_tokens` | 256–32000, default 4000. Counted with the tokenizer of the embedding model (character heuristic when unavailable). |
| `max_subqueries` | 1–6, default 4; the original question counts. |
| `decomposition` | `"rules"` (default) or `"llm"`. `llm` asks the model behind `RETRIEVE_DECOMPOSE_URL`/`RETRIEVE_DECOMPOSE_MODEL` for the split; without a configured model, or when its answer is unusable, the rules apply and the response still says `"rules"`. |
| `filter`, `path_prefix`, `valid_at`, `include_all_versions` | As on `search`. HTTP also takes the collection from `X-Collection` (default `documents`) and `X-Valid-At`. |

How it works: by default the question is cut at `?`, `;` and the conjunctions ` und `, ` sowie `,
` and `, ` as well as ` where both sides have at least three words, and duplicates are dropped;
the original always comes first. With `decomposition: "llm"` a configured model proposes the parts
instead (answers are cached per tenant like HyDE generations); its parts are merged behind the
original, and an unusable answer falls back to the rule-based split. Each part is searched (hybrid, 20 hits, up to 4 at a time, no
rerank, no grouping), and the ranked lists are fused by reciprocal rank (`Σ 1/(60+rank)`). A
repeated chunk and a near-duplicate text (equal first 512 characters after case and whitespace
folding) collapse to the higher-fused one. When a reranker is configured the top 50 are reranked
against the original question. Passages are packed greedily into `budget_tokens`, at most 3 per
document; one that does not fit is skipped, never cut, and packing stops looking once fewer than
64 tokens remain after a skip.

The answer carries `question`, `subqueries`, `budget_tokens`, `used_tokens`, `truncated` (candidates
were left out because they did not fit), `reranked`, `decomposition` (the split actually used),
`content_trust: "untrusted"`, `injection_risk` and `evidence[]` with `id`, `reference`, `base_ref`, `title`, `section`, `page_start`/`page_end`,
`content`, `score`, `matched_subqueries` and the same labels per passage. A failing sub-question only
narrows the recall; a failing original question fails the call.

```bash
curl -s -X POST http://localhost:8080/v2/retrieve \
  -H "Authorization: Bearer $API_TOKEN" -H "X-Collection: handbuch" -H "Content-Type: application/json" \
  -d '{"question": "Welche Pflichtfelder hat die Maske M-2 und welche Rechte braucht der Benutzer dafür?", "budget_tokens": 3000}'
```

### v2 revision hand-off

Extract's emitter writes documents through these routes (the OpenAPI document has the shapes):

| Route | Purpose |
| --- | --- |
| `POST /v2/documents/{ref}/revisions` | Create a revision (`Idempotency-Key`, optional `X-Source-Id` claim) |
| `PUT /v2/documents/{ref}/revisions/{rev}/batches/{seq}` | Stage one NDJSON page batch (`Content-Digest`), up to `REVISION_BATCH_BODY_LIMIT` |
| `GET /v2/documents/{ref}/revisions/{rev}` | Revision state: `acceptedBatches`, `processedPages`, `missingAssets`, `committedSegments`, `commitPending` |
| `POST /v2/documents/{ref}/revisions/{rev}/segments/{n}/commit` | Segment commit; a `progressive` revision becomes searchable up to it |
| `POST /v2/documents/{ref}/revisions/{rev}/commit` | Final commit and atomic switch of the latest revision |
| `POST /v2/documents/{ref}/revisions/{rev}/heartbeat` | Extend the TTL of an uncommitted revision |
| `DELETE /v2/documents/{ref}/revisions/{rev}` | Abort and clean up |
| `POST /v2/sources/identify` | Register an ingest's source; answers `new`, `new_version` or `duplicate` and the canonical reference |
| `GET /v2/documents/{ref}/sources` | Every source of a document, indexed ones and skipped duplicates |

Behaviour worth knowing:

- A revision may name a collection that does not exist yet. The batch worker creates it on the
  first batch, with the embedding's vector size and the defaults of the v1 ingest paths
  (`FTS_LANGUAGE`, quantization, sparse vocabulary, embedding model provenance).
- A collection name that breaks the naming rule (a letter, then letters, digits or underscores)
  is 400 `INVALID_COLLECTION_NAME` before the access check; `POST /v2/search` on a collection
  that does not exist is 404 instead of a provenance mismatch.
- Every revision route checks `X-Extract-Contract`: absent is accepted, malformed is 400, a
  major other than 2 is 422. A `{ref}` that does not own the addressed revision is 409
  `REVISION_REFERENCE_MISMATCH`; reusing an `Idempotency-Key` for another document is 409.
- The final commit checks coverage against the page count from `document.begin`/`document.end`
  and answers 409 with `missingRanges` (including a missing first or last page). The stream is
  expected from page 1, or from `document.begin.firstPage` when the job processed a `pages`
  window (contract 2.4); the batch that carries `document.begin` can be any batch, and batch
  seqs stay absolute. An unknown page count without a staged `document.end` is 409
  `COMMIT_DOCUMENT_END_MISSING`.
- An accepted final commit whose batches are not all processed yet answers **202**
  `{committed: true, pending: true, isLatest: false}`; `GET …/revisions/{rev}` then reports
  `commitPending: true`. The batch worker performs the switch once the last batch is processed,
  and the previous revision stays visible until then. A replayed commit is idempotent.
- `PUT /v2/assets/{assetId}` requires a lowercase sha256 asset id. The revision from
  `X-Revision-Id` and/or `?revision=` must exist in the tenant and collection, belong to
  `X-Document-Reference` and not be aborted. An asset already bound to a live revision keeps that
  binding.

### Duplicates, version order and e-mail threads

- **Unknown collection.** On read and search routes a caller with a valid scope who addresses a
  collection that does not exist gets 404 (typed `COLLECTION_NOT_FOUND`) instead of 403, so an empty
  index is not reported as a permission failure. Write routes of the ingest family allow it for the
  first write, see the route table above.
- **Row ACL.** A revision is opened with the document's readers (`X-Allowed-Users/-Groups`,
  resolved by `rowAclForRevision`: a service caller's values as given, else the collection ACL;
  an end user only narrows to itself). It is stored on the revision and written onto every unit
  by the batch worker, so search, expansion, navigation and assets enforce it.
- **Sources.** `vs_document_sources` holds one row per ingest: the canonical reference, the
  document key (reference without file extension), file sha256, normalised-text hash,
  MinHash, Message-ID, version and status (`pending` claim, `indexed`, `duplicate`). Exact
  matches (sha256, text hash, Message-ID) are duplicates collection-wide; MinHash
  near-duplicates (`DEDUP_NEAR_THRESHOLD`, default 0.9) only within one document key, and
  only when the versions match or — without comparable content versions — the similarity
  reaches `DEDUP_DUPLICATE_SIMILARITY` (0.97). A pending claim expires after
  `SOURCE_CLAIM_TTL`; a deleted document no longer counts. Identification is serialised per
  collection, so two concurrent ingests of one file cannot both be new. Sources only match sources
  of the same row ACL: another audience's copy is neither a duplicate nor a version target, and
  `GET …/sources` lists only sources the caller may read.
  Documents indexed before this registry existed have no source row: another format still
  resolves to their reference (by document key, via the revision pointer), but they are not a
  duplicate target until re-ingested.
- **Version order.** `document.begin.version` is stored on the revision. The final switch
  moves the document pointer only when the new version is not older than the current one
  (labels compared numerically, `1.10 > 1.9`, then dates); an older version is committed and
  addressable but never the latest. Without comparable versions the last commit wins, as
  before.
- **Threads.** A committed e-mail (`document.begin.email`) is threaded by Message-ID,
  In-Reply-To, References and the Outlook Thread-Index root, with a subject + participant
  fallback, into `vs_mail_messages`; referenced ids are kept as placeholders so a reply
  ingested before its parent still joins. A message linking two threads merges them. An
  attachment (`parentReference`) joins its e-mail's thread. `X-Group-By-Document` /
  `group_by: document` / MCP `group_by_document` merge a thread into one result
  (chronological content, `document_group` on the hit), and `expand=document` (`X-Expand:
  document`) returns the whole thread — or a plain document — in reading order, default
  budget 50 000 characters. Every hit (and `get_document` / `get_summaries`) names its
  `document_group`; a grouped hit merged from several messages carries `group_members` and
  heads each message with `[Nachricht: <ref>]`. MCP `get_thread` reads a thread
  chronologically, each message with its own reference.
- **Document attributes.** `/ingest-file` passes `X-Title`, `X-Tags`, `X-Metadata`,
  `X-Link`, `X-Source` (and `X-Version`, `X-Source-Modified`, `X-Dedup`) to Extract's job;
  the batch worker writes title, tags, link, source and the metadata onto every unit, so tag
  and metadata filters treat a v2 document like a v1 one.

### Whole-document reads of v2 documents

`get_document`, `get_documents`, `get_summary` and `get_summaries` read a v2 document from its
body units only (`chunk`, `table`, `figure`; never Extract's `section`/`page`/`document` summary
units) in reading order — page, block position on the page, ordinal. A table contributes its
grid once (`metadata.display_len`; the "Spalte: Wert" lines are search-only), a figure its
transcription headed `[Abbildung <figure_id> · <kind> · asset_id=…]`, and a chunk ending in a
paragraph that runs over the page break is read without the carried continuation. The summary
is the `document` unit's (or a backfilled one), the title the first non-empty one.

**Split documents.** A document the caller ingests in several parts declares that with the
document attributes `metadata.split_of` (a string naming the whole, for example `"spec-1"`) and
optionally `metadata.split_order` (a number). Parts in the same folder (everything before the last
`/` of `base_ref`) with the same `split_of` form a group of kind `split_document` (the
`document_group` of a hit), and `get_documents` adds `siblings: [{ base_ref, title, order }]` to
each part: the other parts the caller may read, sorted by `split_order`. Nothing is inferred from
file names; a document without `split_of` has no group and no siblings.
`get_section` and `get_pages` (Markdown format) follow the same body rules and return the
summary units of the range apart, in `summaries`; `units` counts the body units.

### Background workers

**Batch worker** (`BATCH_WORKER=true`, off by default). Staged batches only become searchable
when a worker processes them: it claims `received` batches with `FOR UPDATE SKIP LOCKED` under a
lease, builds chunk/table/figure units (plus section/page/document summary units from
`document.end`), embeds and upserts them, and marks the batch `processed` in one transaction. An
embedding failure rolls the batch back to `received` with `BATCH_WORKER_BACKOFF_MS` backoff; unit
ids are deterministic, so reprocessing replaces in place. It also completes accepted final
commits once their last batch is processed. Any deployment using the revision API needs it on
at least one replica; `BATCH_WORKER_INTERVAL_MS` sets the poll interval (0 stops the loop). A
wake-up drains up to 25 batches before sleeping, and the chunks of one batch are embedded
`BATCH_WORKER_EMBED_CONCURRENCY` (default 4) at a time.

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
| `list_figures` | Figures of a document or page range (`from_page`, `to_page`, `kind`), paginated. `kind` is a stored kind (`bpmn`, `flowchart`, `ui_mask`, `technical_drawing`, `chart`, `table_image`, `photo`, `diagram`, `other`) or an alias (`process`, `drawing`, `data`, `mask`, `table`); an unknown value is an error |
| `get_asset` | An image as MCP image content (`variant`, optional `region` zoom with `target_pixels`); fails closed when `expected_document_reference` / `expected_figure_id` do not match |
| `get_table` | A logical table reassembled across pages (`table_id`, `rows`) |
| `find_identifier` | Exact occurrences of an identifier across the collection or beneath `path_prefix`, paginated |
| `follow_ref` | Resolve the figures a unit references |
| `trace` | An identifier's occurrences across two points in time `valid_at_a` / `valid_at_b` — added / removed / changed (by content hash) per document + section, plus `unchanged_count` (see *Traceability*) |
| `document_diff` | One document's units between two points in time `from` / `to` — added / removed / changed (before/after excerpts) plus `unchanged_count` (see *Traceability*) |
| `retrieve_for_answer` | Question → evidence within a token budget (see *Answer-ready retrieval*) |
| `get_thread` | A whole e-mail thread chronologically (`reference` = a message's ref or `document_group.id`; `max_chars`, `offset`/`next_offset`, `path_prefix`) |

Every tool also accepts `collection`. The read tools (`get_outline`, `get_section`, `get_pages`,
`list_figures`, `get_table`, `find_identifier`, and `get_document`, `get_documents`,
`get_summary`, `get_summaries`) accept `valid_at` (RFC 3339 with offset) and read the version
valid at that instant, as search's `valid_at` selects it.

Every read and navigation response carries the content-trust labels (ADR-0032):
`content_trust: "untrusted"` plus an `injection_risk` hint (`none`/`suspected`) computed over
the returned text at query time — the same labelling `search` applies. A `none` is a hint, not
a guarantee; consumers (Runtime taint, Gate) act on the labels.

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

## Traceability across two points in time

Two read tools answer "what changed between two dates?" without re-ingesting anything. Both
read through the same temporal rule as `valid_at` (the version valid at each instant) and carry
the content-trust labels like every other read.

- **`trace` (MCP)** follows an identifier (e.g. `WE-01/A`) across two instants `valid_at_a` /
  `valid_at_b`: it runs the lexical identifier lookup at each instant and diffs the occurrences
  by document + section — `added` (only at b), `removed` (only at a), `changed` (present at
  both, `content_hash` differs; SHA-256 of the normalized content) and `unchanged_count`. Each
  occurrence carries `base_ref`, `reference`, `section`, `page_start` and a ≤300-char excerpt
  centered on the hit. `truncated: true` means at least one instant hit the lookup cap; narrow
  the collection or the identifier.
- **`document_diff` (MCP and `GET /v2/documents/{base_ref}/diff?collection=&from=&to=`)**
  compares one document's units between two RFC 3339 instants. Units are loaded at both
  instants via the navigation reads and aligned by `section_id`, then `unit_id`, then ordinal /
  reading order. The response is `{ base_ref, from, to, added, removed, changed,
  unchanged_count }`; `changed` entries carry `before_excerpt` / `after_excerpt` (max 300
  chars), and `added` / `removed` units carry a head excerpt.

Both tools are scoped by the caller's tenant/ACL exactly like `get_pages` — a diff can never
surface a unit the caller could not retrieve.

**`POST /v2/citations/check`** answers the complementary question "are the chunks I cited back
then still what a search would return today?". It takes up to 500 `{ base_ref, chunk_id }`
pairs (the `chunk_id` of a search hit — the v2 `unit_id` or the v1 `chunk_id`) and reports one
status per pair, in input order: `current` (the chunk belongs to the revision visible today),
`carried` (superseded, but its exact content exists unchanged in the current revision),
`changed` (superseded and the content is gone), `removed` (the document has no visible revision
anymore) and `unknown` (the caller cannot see that chunk at all). Current revisions are
resolved with the same temporal rule as `valid_at` at check time; each result also carries
`current_revision` when one is visible. Read-only, same headers and scopes as
`GET /v2/documents/{ref}/diff`. The Runtime consumes this endpoint for its citation
impact report (`CITATION_CHECK_URL`, `GET /monitoring/citation-impact`; see
[`docs/runbooks/citation-impact.md`](../../docs/runbooks/citation-impact.md)).

## Retrieval pipeline

```text
query
  ├─ dense    embed → HNSW vector search
  ├─ lexical  PostgreSQL full-text search
  └─ sparse   optional SPLADE-style vectors
        └─ RRF fusion → optional rerank → results + citations
```

The lexical list ORs the query terms (no `websearch` syntax). With `FTS_RANKER=bm25` it uses
BM25 only on a table that has a `USING bm25` index — the index is not created by this service;
a table without one falls back to the full-text ranking and logs a warning once (an index
created later is picked up within a minute). Hits of one document are grouped with `[…]`
between chunks that are not adjacent in it (`group_by_document`), and the MCP search tool
embeds the same normalised query as the REST routes.
Optional quality stages, each independently configurable: **HyDE** (search with a hypothetical
answer rather than the raw question; generations are cached per query for
`HYDE_CACHE_TTL_SECONDS`, default 600, 0 = off), **semantic chunking** (split on meaning, not character
count), **contextual vector blending** (an alpha blend of chunk and whole-document embeddings, `LATE_CHUNKING_ALPHA`) and **contextual retrieval** (give each chunk its document context so
it is not read out of context), and **reranking** (a second, more precise ordering, synchronous
or streamed, with an optional fallback reranker; many candidates go out as parallel batches of
`RERANK_BATCH_SIZE`, at most `RERANK_BATCH_CONCURRENCY` at a time; a failed batch keeps its
candidates behind the scored ones and marks the result `partial`, while
`RERANK_GLOBAL_CONCURRENCY` bounds rerank calls across the whole process). Context expansion of the
hits of one search runs at most 8 at a time (fixed). `/v2/search` honours
`X-Valid-At` like the other search routes, and `collection_stats` reports which retrieval
features a collection supports (`capabilities`: `unitRows`, `unitGraph`, `outline`, `pages`).

## Two things that will bite you

**Embedding revisions.** Changing the embedding model under an existing index silently destroys
relevance, because old and new vectors are not comparable. `EMBED_MODEL_REVISION` and
`EMBED_EXPECTED_DIMENSION` turn that into a startup failure instead. Set both, and treat a
revision change as a reindex.

**The embedding request field.** OpenAI-compatible servers expect `input`; TEI expects `inputs`.
`EMBED_INPUT_FIELD` selects it and defaults to `inputs`. A mismatch shows up as an opaque
upstream error.

## Transaction tokens

With `TRANSACTION_ENFORCEMENT` on, a tool call carries a signed transaction token from the
Runtime (the Agent Transaction Fabric envelope). Search verifies it with the shared
`TRANSACTION_HS256_SECRET`, or — preferably — with the issuer's public keys at
`TRANSACTION_JWKS_URI` (the Runtime serves `/.well-known/atf-transaction-jwks.json`) for
ES256/EdDSA tokens, so a verifier cannot mint tokens. `TRANSACTION_ALGORITHMS` lists what is
accepted at the same time (default: HS256 when the secret is set, plus ES256 and EdDSA when
the JWKS URL is set), which lets issuers switch one at a time; the token's `alg` only picks
the key source and only from that list. Search accepts transaction tokens with the JWT header
`typ` `at+jwt` or `txn+jwt`; any other `typ` is rejected. When the JWKS cannot be fetched
Search answers 503 `TRANSACTION_KEYS_UNAVAILABLE` (retryable) instead of 401. Issuer
(`TRANSACTION_ISSUER`) and audience (`TRANSACTION_AUDIENCE`, default `vectorsearch`) must
match, so a token minted for another service is refused. Production requires enforcement `required`, an https JWKS URL for the
asymmetric algorithms, and warns while HS256 is accepted. The migration order is in
[the upgrade guide](../../docs/UPGRADE.md) (item 20) and
[ADR-0035](../../docs/adr/0035-asymmetric-transaction-tokens-audience-per-service.md).

## Signed evidence packs

Set `SEARCH_EVIDENCE_SIGNING_KEY` (Ed25519, PEM PKCS#8 or a base64 32-byte seed, the format of the
Runtime's `EVIDENCE_SIGNING_KEY`) and the MCP `verified_evidence_pack` tool adds
`signature: { alg: "EdDSA", kid, value }` to the pack. The signature covers the canonical JSON
(`@atf/canonical-json`) of the pack without the `signature` member; the schema stays `v2`. The
public key is served unauthenticated at `/.well-known/atf-search-evidence-jwks.json` (404 while no
key is set). Without the variable the pack carries no `signature` field.

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
| `BATCH_WORKER_EMBED_CONCURRENCY` | 4 | Chunks of one batch embedded in parallel |
| `RERANK_BATCH_SIZE`, `RERANK_BATCH_CONCURRENCY` | 16, 2 | Candidates per rerank request, and requests in flight |
| `RERANK_GLOBAL_CONCURRENCY` | 0 | Rerank calls in flight across the whole process (0 = unlimited) |
| `HYDE_CACHE_TTL_SECONDS` | 600 | HyDE generation cache lifetime; 0 disables |
| `SEARCH_MAX_QUERY_CHARS` | 400 | Longer queries are cut at the last space before the limit; responses carry `query_truncated` |
| `SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT` | 8 | Best-scoring chunks kept per document by `group_by_document` (1-64); a cut document reports `truncated` and `omitted_chunks` |
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
| `TRANSACTION_JWKS_URI`, `TRANSACTION_ALGORITHMS` | (unset), derived | Verify ES256/EdDSA transaction tokens against the Runtime's JWKS; the algorithms accepted at the same time |
| `CONTEXTUAL_CHUNK_LLM` | false | One `SUMMARY_*` model call per chunk for a placement sentence; expensive |
| `FTS_CONTEXTUAL_HEADER` | off | `on` indexes the document title and section path (weight `D`) into `ts_search` of newly ingested chunks, so a keyword query for a title-only term finds them; existing rows are unchanged until re-ingestion |
| `FTS_COMPOUND_SPLIT` | off | `query` splits long query tokens against the collection's own lexicon (cached one hour, built asynchronously) and adds the matched lexemes to the lexical OR list, so `Kommissionierarbeitsplatz` also finds chunks containing `Arbeitsplatz` |
| `RATE_LIMIT_REDIS_URL` | (unset) | Shared backend for rate limiting; without it the limiter is per-process (ADR-0031) |
| `REPLICAS` | 1 | Expected replica count; with more replicas and no shared Redis the production warnings fire |
| `EMBED_FALLBACK_SAME_SPACE` | false | Startup aborts when `EMBED_FALLBACK_MODEL` differs from `EMBED_MODEL` unless this asserts both servers serve the same underlying model — a different fallback model would silently mix embedding spaces |

## Further reading

- [`docs/operations-and-retrieval.md`](../../docs/operations-and-retrieval.md) — operational
  behavior and retrieval tuning
- [`docs/adr/search/`](../../docs/adr/search/) — identity authority and pagination decisions
- [`apps/extract/README.md`](../extract/README.md) — the converter behind `/ingest-file`, its v2
  job model and the emitter that writes into the revision API
