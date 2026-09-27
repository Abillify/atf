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
| `POST /ingest-file` | Binary document ingest through `@atf/extract`. Mounted only when `CONVERTER_URL` is set, otherwise 404. Forwards Markdown only, so figure descriptions are indexed but the images are not (`X-Figure-Assets: not-stored`) |
| `PUT`, `GET /document-assets/:assetId` | Store and read original figure images. The owning document must already be visible, otherwise the write is refused |
| `POST /search` | Dense, hybrid, sparse, and optionally reranked retrieval |
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

### v2 revision hand-off

`/v2/documents/{ref}/revisions/…` and `/v2/assets/{assetId}` carry the resumable v2 ingest
(the OpenAPI document has the shapes). Behaviour worth knowing:

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
Runtime are not shared.

## Further reading

- [`docs/operations-and-retrieval.md`](../../docs/operations-and-retrieval.md) — operational
  behavior and retrieval tuning
- [`docs/adr/search/`](../../docs/adr/search/) — identity authority and pagination decisions
- [`apps/extract/README.md`](../extract/README.md) — the converter behind `/ingest-file`, and why
  its own `POST /v1/ingest` is the path to use when figure images should be viewable
