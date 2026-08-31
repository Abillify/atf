# @atf/search

Semantic and hybrid retrieval on PostgreSQL with pgvector. Express, running on Bun or Node 26.

One engine, no separate vector database. Search owns ingestion, chunking, embedding, indexing,
and query. It is consumed by [`@atf/runtime`](../runtime) for `retrieval` nodes and RAG, and
directly by models and agents over MCP.

## Run it

```bash
cp .env.example .env    # POSTGRES_URL, EMBED_URL, and EMBED_MODEL are required
bun run --filter @atf/search dev
```

Needs PostgreSQL with the `vector` extension and an embedding endpoint. Both are provided by
[`deploy/examples/`](../../deploy/examples/).

```bash
bun run --filter @atf/search test
bun run --filter @atf/search typecheck
bun run --filter @atf/search build        # Bun target
bun run --filter @atf/search build:node   # optional Node 26 artifact
```

## API surface

| Endpoint | Purpose |
| --- | --- |
| `POST /documents` | Ingest documents; batch and streaming |
| `GET /documents`, `/document` | List and fetch, with score-keyset pagination |
| `GET /documents/content` | Retrieve stored content |
| `GET /collections`, `/collection-stats` | Collection management and statistics |
| `GET /folders` | Hierarchical browsing |
| `POST /summary`, `GET /summaries` | Generated document summaries |
| `/mcp` | MCP endpoint for models and agents |
| `/openapi.json`, `/openapi.yaml` | Generated OpenAPI document |
| `/admin/stats` | Operational statistics |
| `/auth/login`, `/auth/callback`, `/auth/logout` | OIDC browser session for the test UI |
| `/health`, `/metrics` | Health and Prometheus metrics |

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
