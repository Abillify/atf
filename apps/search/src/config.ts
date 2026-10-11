// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * config.ts
 *
 * Application configuration: type definition and environment variable parsing.
 *
 * All environment variables are parsed here with explicit defaults, range
 * checks, and co-constraint validation (e.g. CHUNK_SIZE + CHUNK_OVERLAP must
 * both be set or both absent).  The server fails fast on startup with a
 * descriptive error message when the configuration is invalid.
 */

export interface UiBffConfig {
  /** Server-selected tenant for every verified browser session. */
  tenantId: string;
  /** Server-selected operation scopes; OIDC scopes are never promoted. */
  scopes: string[];
  /** Optional allowlist applied to groups from the verified ID token. */
  allowedGroups: string[];
  /** Exact group required in addition to admin scopes for UI administration. */
  operatorGroup: string | null;
}

export interface Config {
  postgresUrl: string; // POSTGRES_URL (required)
  defaultCollection: string; // DEFAULT_COLLECTION (default: "documents")
  embedUrl: string; // EMBED_URL (required)
  embedModel: string; // EMBED_MODEL (required)
  /** Immutable deployment/model revision used to detect unsafe in-place embedding drift. */
  embedModelRevision: string; // EMBED_MODEL_REVISION (default: EMBED_MODEL)
  /**
   * JSON field name used to pass texts in embedding requests.
   * TEI expects "inputs"; OpenAI-compatible servers expect "input".
   * Default: "inputs".
   */
  embedInputField: string; // EMBED_INPUT_FIELD (default: "inputs")
  /** Optional secondary embedder, enabled only when its model is configured. */
  embedFallbackUrl: string | null; // EMBED_FALLBACK_URL
  embedFallbackModel: string | null; // EMBED_FALLBACK_MODEL (enables fallback)
  embedFallbackInputField: string; // EMBED_FALLBACK_INPUT_FIELD (default: "input")
  /** Required vector dimension for both embedding paths when configured. */
  embedExpectedDimension: number | null; // EMBED_EXPECTED_DIMENSION (optional positive int)
  apiToken: string | null; // API_TOKEN (optional)
  port: number; // PORT (default: 3000)
  logLevel: string; // LOG_LEVEL (default: "info")
  defaultChunkSize: number | null; // CHUNK_SIZE (optional)
  defaultChunkOverlap: number | null; // CHUNK_OVERLAP (optional)

  // Reranking
  rerankUrl: string; // RERANK_URL (default: EMBED_URL)
  rerankModel: string | null; // RERANK_MODEL (required to enable)
  rerankInputSeparator: string; // RERANK_SEPARATOR (default: "\n")
  rerankCandidateMultiplier: number; // RERANK_CANDIDATE_MULTIPLIER (default: 4)
  /**
   * Optional relevance threshold (Requirement 4.8). When set, final search
   * results are filtered to `score >= MIN_RERANK_SCORE` (reranker score when
   * reranking was applied, retrieval score otherwise) and the response
   * carries an `abstention` signal; `abstain: true` when every candidate
   * fell below the threshold. Empty / unset = disabled, no field emitted.
   */
  minRerankScore: number | null; // MIN_RERANK_SCORE (default: empty = off)
  rerankEndpoint: "embeddings" | "rerank"; // RERANK_ENDPOINT (default: "rerank")
  /**
   * JSON field name used to pass documents in native rerank requests.
   * TEI expects "texts"; OpenAI-compatible servers expect "documents".
   * Default: "texts".
   */
  rerankDocumentsField: string; // RERANK_DOCUMENTS_FIELD (default: "texts")
  /** Optional secondary reranker, enabled only when its model is configured. */
  rerankFallbackUrl: string | null; // RERANK_FALLBACK_URL
  rerankFallbackModel: string | null; // RERANK_FALLBACK_MODEL (enables fallback)
  rerankFallbackInputSeparator: string; // RERANK_FALLBACK_SEPARATOR (default: "\n")
  rerankFallbackEndpoint: "embeddings" | "rerank"; // RERANK_FALLBACK_ENDPOINT
  rerankFallbackDocumentsField: string; // RERANK_FALLBACK_DOCUMENTS_FIELD

  hybridSearch: boolean; // HYBRID_SEARCH (default: true)
  bodyLimit: string; // BODY_LIMIT (default: "10mb")
  rateLimit: number; // RATE_LIMIT req/min/IP (default: 120, 0=disabled)

  /**
   * Trust X-Forwarded-For for rate limiting.
   * Enable only when running behind a known reverse proxy (nginx, ALB…).
   * Default: false (uses TCP address, immune to header spoofing).
   */
  trustProxy: boolean; // TRUST_PROXY (default: false)

  /** HNSW ef_search at query time (recall vs latency). Default: 100. */
  hnswEfSearch: number; // HNSW_EF_SEARCH (default: 100)
  /**
   * pgvector HNSW iterative-scan mode for dense/binary searches (Req 4.1).
   * `relaxed_order` (default) keeps recall under selective filters without
   * re-sorting; `strict_order` re-scans for exact ordering; `off` disables.
   * Automatically forced to `off` when pgvector < 0.8 (Req 4.2).
   */
  hnswIterativeScan: "relaxed_order" | "strict_order" | "off"; // HNSW_ITERATIVE_SCAN (default: relaxed_order)
  /** Cap on tuples visited per iterative-scan round. Default: 20000. */
  hnswMaxScanTuples: number; // HNSW_MAX_SCAN_TUPLES (default: 20000)
  /** HNSW ef_construction for new indexes. Default: 128. */
  hnswEfConstruction: number; // HNSW_EF_CONSTRUCTION (default: 128)
  /** HNSW m (max connections) for new indexes. Default: 16. */
  hnswM: number; // HNSW_M (default: 16)

  /** Use halfvec (16-bit float) for new collections. Default: false. */
  halfPrecision: boolean; // VECTOR_HALF_PRECISION (default: false)

  /**
   * Contextual chunk enrichment: characters of document beginning prepended
   * to each non-first chunk's embedding input (stored content unchanged).
   */
  contextPrefixSize: number | null; // CHUNK_CONTEXT_PREFIX_SIZE (default: null)

  /**
   * Server-wide default FTS language for new collections.
   * Can be overridden per collection via X-FTS-Language header at ingest time.
   * Default: "simple" (language-agnostic, no stemming).
   */
  defaultFtsLanguage: string; // FTS_LANGUAGE (default: "simple")

  /**
   * Abort embedding/reranking HTTP calls after this many milliseconds.
   * Set 0 to disable the timeout entirely (useful for local dev with slow models).
   * Default: 30 000.
   */
  fetchTimeoutMs: number; // FETCH_TIMEOUT_MS (default: 30000, 0 = disabled)

  /**
   * Automatically delete stats rows older than this many days.
   * Set 0 to disable. Default: 90.
   */
  statsRetentionDays: number; // STATS_RETENTION_DAYS (default: 90)

  /**
   * Store the raw query text in `vs_search_stats.query` in addition to the
   * hash. Off by default: raw search terms may carry personal or confidential
   * data, so only the hash lands in the database (Requirement 2.6).
   * Default: false.
   */
  statsStoreRawQuery: boolean; // STATS_STORE_RAW_QUERY (default: false)

  /**
   * Pepper for the HMAC-SHA-256 query hash in `vs_search_stats.query_hash`.
   * Without a pepper the plain SHA-256 is used, which is dictionary-attackable
   * for common queries; set this in production. null = no pepper.
   */
  statsQueryPepper: string | null; // STATS_QUERY_PEPPER (optional)

  /**
   * Metadata field whose value identifies the data subject in a document
   * (`metadata->>ERASURE_SUBJECT_METADATA_FIELD`), matched against the
   * identifiers of a subject-scoped `POST /v1/erasure` request in addition to
   * the `allowed_users` ACL column (Requirement 2.5).
   */
  erasureSubjectMetadataField: string; // ERASURE_SUBJECT_METADATA_FIELD (default: subject)

  // ── HyDE (Hypothetical Document Embeddings) ─────────────────────────────
  /** URL of the chat-completions server for HyDE expansion. Default: EMBED_URL. */
  hydeUrl: string; // HYDE_URL (default: EMBED_URL)
  /** Model to use for HyDE generation. Required to enable HyDE. */
  hydeModel: string | null; // HYDE_MODEL (optional)
  /** Max tokens for the hypothetical document. Default: 256. */
  hydeMaxTokens: number; // HYDE_MAX_TOKENS (default: 256)
  /** Enable model thinking/reasoning for OpenAI-compatible HyDE calls. Default: false. */
  hydeEnableThinking: boolean; // HYDE_ENABLE_THINKING (default: false)
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on HyDE HTTP calls.
   * Needed when HYDE_URL points at an OpenAI-compatible server that requires
   * authentication (e.g. an agent orchestrator). Ignored for Bedrock. null = no header.
   */
  hydeToken: string | null; // HYDE_TOKEN (optional)

  // ── Document summarization (ingest-time context prefix) ──────────────────
  /** URL of the chat-completions server for summarization. Default: EMBED_URL. */
  summaryUrl: string; // SUMMARY_URL (default: EMBED_URL)
  /** Model for summarization. Required to enable X-Summarize. */
  summaryModel: string | null; // SUMMARY_MODEL (optional)
  /** Max tokens for the generated summary. Default: 256. */
  summaryMaxTokens: number; // SUMMARY_MAX_TOKENS (default: 256)
  /** Enable model thinking/reasoning for OpenAI-compatible summary calls. Default: false. */
  summaryEnableThinking: boolean; // SUMMARY_ENABLE_THINKING (default: false)
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on summary HTTP calls.
   * Needed when SUMMARY_URL points at an OpenAI-compatible server that requires
   * authentication (e.g. an agent orchestrator). Ignored for Bedrock. null = no header.
   */
  summaryToken: string | null; // SUMMARY_TOKEN (optional)
  /** Timeout for summary requests in ms. 0 = disabled. Default: 120 000. */
  summaryTimeoutMs: number; // SUMMARY_TIMEOUT_MS (default: 120000, 0 = disabled)
  /** Max parallel requests to the summary server. Default: 4. */
  summaryMaxConcurrency: number; // SUMMARY_MAX_CONCURRENCY (default: 4)

  // ── SPLADE sparse vectors ────────────────────────────────────────────────
  /** URL of the SPLADE embedding server. Default: EMBED_URL. */
  sparseUrl: string; // SPARSE_URL (default: EMBED_URL)
  /** SPLADE model name. Required to enable sparse search. */
  sparseModel: string | null; // SPARSE_MODEL (optional)
  /** Vocabulary size of the SPLADE model. Default: 30522. */
  sparseVocabSize: number; // SPARSE_VOCAB_SIZE (default: 30522)

  // ── Token counting (TEI /tokenize, bge-m3) ───────────────────────────────
  /**
   * URL of the TEI `/tokenize` endpoint used to measure chunk token counts
   * (Requirement 11.2). Defaults to a URL derived from EMBED_URL by reusing its
   * origin and replacing the path with `/tokenize`. When EMBED_URL is a
   * `bedrock…` pseudo-URL there is no TEI tokenizer, so this stays null and the
   * counter uses the character heuristic.
   */
  tokenizeUrl: string | null; // TOKENIZE_URL (default: derived from EMBED_URL)
  /**
   * Enable TEI `/tokenize` token counting. Off automatically for Bedrock (no
   * `/tokenize`). When disabled the token counter uses the character heuristic
   * directly without any HTTP call. Default: true (unless the backend is Bedrock).
   */
  tokenizeEnabled: boolean; // TOKENIZE_ENABLED (default: true, false for bedrock)
  /** Abort tokenize calls after this many ms. 0 disables the timeout. Default: 5 000. */
  tokenizeTimeoutMs: number; // TOKENIZE_TIMEOUT_MS (default: 5000, 0 = disabled)
  /** Bounded LRU cache size for token counts. 0 disables caching. Default: 2 048. */
  tokenizeCacheSize: number; // TOKENIZE_CACHE_SIZE (default: 2048, 0 = disabled)

  /**
   * Late chunking alpha (0–1). When set, blend each chunk's embedding with
   * the full-document embedding: final = alpha * chunk + (1-alpha) * doc.
   * null = disabled (use pure chunk embedding).
   */
  lateChunkingAlpha: number | null; // LATE_CHUNKING_ALPHA (default: null)

  /** RRF k parameter for hybrid search. Default: 60. */
  rrfK: number; // RRF_K (default: 60)

  /**
   * Per-list weights applied to the reciprocal-rank contributions in hybrid
   * (RRF) search (task 3.4, Requirement 12.3). The dense and full-text lists
   * always participate; the identifier list is added only when the query
   * carries a recognised identifier. Each weight scales its list's
   * `1/(rrfK + rank)` term, so the defaults of 1.0 reproduce the previous,
   * unweighted ranking exactly. Must be > 0.
   */
  rrfWeightDense: number; // RRF_WEIGHT_DENSE (default: 1.0)
  rrfWeightFts: number; // RRF_WEIGHT_FTS (default: 1.0)
  rrfWeightIdentifier: number; // RRF_WEIGHT_IDENTIFIER (default: 1.0)
  /**
   * Weight of the SPLADE sparse list in the RRF fusion (Requirement 4.3).
   * Must be > 0; only applied when the sparse branch participates.
   */
  rrfWeightSparse: number; // RRF_WEIGHT_SPARSE (default: 1.0)
  /**
   * Requirement 4.4: a list a document did not appear in contributes 0 to the
   * RRF fusion instead of the legacy `1/(k+1000)` pseudo-rank. Breaking
   * default (changed with this minor — see CHANGELOG/upgrade hint); set to
   * `false` to restore the legacy behaviour verbatim.
   */
  rrfMissingZero: boolean; // RRF_MISSING_ZERO (default: true)

  /**
   * Requirement 4.7: ranker for the lexical (full-text) list. `ts_rank_cd`
   * (default) uses PostgreSQL's coverage-density rank with length
   * normalisation. `bm25` is honoured only when a BM25 extension
   * (ParadeDB `pg_search` or VectorChord-bm25) is installed; without one,
   * the search service logs a warning once and keeps `ts_rank_cd`.
   */
  ftsRanker: "ts_rank_cd" | "bm25"; // FTS_RANKER (default: ts_rank_cd)

  /** Interval in ms for flushing buffered stats to DB. Default: 30 000. */
  statsFlushIntervalMs: number; // STATS_FLUSH_INTERVAL_MS (default: 30000)

  /**
   * Body size limit for POST /ingest-stream (NDJSON bulk endpoint).
   * Default: "50mb". Use standard Express size strings (e.g. "100mb").
   */
  streamBodyLimit: string; // STREAM_BODY_LIMIT (default: "50mb")

  /**
   * TTL in milliseconds for an uncommitted v2 revision (design §9b.3,
   * Requirement 5.10). A staged revision that is neither committed nor
   * heartbeated within this window is reaped by the TTL cleaner. Default:
   * 14 days. Set REVISION_TTL in seconds.
   */
  revisionTtlMs: number; // REVISION_TTL seconds (default: 14 days)

  /**
   * How often the revision TTL cleaner sweeps for expired revisions, in
   * milliseconds. 0 disables the background sweep. Default: 1 hour.
   */
  revisionTtlSweepMs: number; // REVISION_TTL_SWEEP_MS (default: 3600000)

  /**
   * How long a pending source claim (`POST /v2/sources/identify`) blocks a
   * duplicate of it while its ingest runs, in milliseconds. An expired claim no
   * longer counts, so an abandoned ingest never blocks a re-ingest for good.
   * Default: 24 hours. Set SOURCE_CLAIM_TTL in seconds.
   */
  sourceClaimTtlMs: number; // SOURCE_CLAIM_TTL seconds (default: 86400)

  /**
   * MinHash similarity from which two texts of the same document key count as
   * the same text (near-duplicate candidates). Default 0.9.
   */
  dedupNearThreshold: number; // DEDUP_NEAR_THRESHOLD (default: 0.9)

  /**
   * Similarity from which a near-duplicate whose version is unknown (or only a
   * file timestamp) is skipped as a duplicate rather than indexed as a new
   * version. Default 0.97.
   */
  dedupDuplicateSimilarity: number; // DEDUP_DUPLICATE_SIMILARITY (default: 0.97)

  /**
   * The v2 batch-processing worker (design §9b.3, task 1.10). When enabled, the
   * worker claims staged NDJSON batches (SKIP LOCKED), builds transitional index
   * units, embeds them and upserts them, marking each batch processed. Disabled
   * by default so a deployment opts in explicitly. Set BATCH_WORKER=true.
   */
  batchWorkerEnabled: boolean; // BATCH_WORKER (default: false)

  /**
   * How often the batch worker polls for staged batches, in milliseconds. 0
   * disables the background loop (the worker can still be driven via tick() in
   * tests). Default: 2000.
   */
  batchWorkerIntervalMs: number; // BATCH_WORKER_INTERVAL_MS (default: 2000)

  /**
   * Backoff applied to a batch's next_attempt_at after an embedding-service
   * failure, in milliseconds (Requirement 5.4). Default: 30000.
   */
  batchWorkerBackoffMs: number; // BATCH_WORKER_BACKOFF_MS (default: 30000)

  /**
   * Per-chunk contextual placement sentence via the SUMMARY_* text-LLM
   * (Requirement 11.6, design §6.3). When true, the batch worker asks the
   * summary model for ONE short sentence placing each `chunk` in the document
   * and appends it to the contextual embedding header. This is one model call
   * per chunk, so it is expensive and OFF by default — worthwhile offline with
   * a local vLLM. A text-LLM failure degrades to the header without the
   * sentence and never fails the batch. Requires SUMMARY_MODEL to be set.
   */
  contextualChunkLlm: boolean; // CONTEXTUAL_CHUNK_LLM (default: false)

  /**
   * Fraction of the chunk token budget the contextual embedding header may
   * occupy (Requirement 11.4). The header (title, section path, pages, type,
   * page summary) is measured with the token counter and truncated
   * summary-first to stay at or below this fraction of the max chunk tokens.
   * Must be in (0, 1). Default: 0.15 (15 %).
   */
  contextHeaderMaxFraction: number; // CONTEXT_HEADER_MAX_FRACTION (default: 0.15)

  /**
   * Body size limit for a single v2 revision NDJSON page batch
   * (PUT …/revisions/{rev}/batches/{seq}). Default: "50mb".
   */
  revisionBatchBodyLimit: string; // REVISION_BATCH_BODY_LIMIT (default: "50mb")

  /**
   * Backend for the v2 AssetStore (design §6.5, Requirement 14.2). `postgres`
   * stores asset bytes as BYTEA in vs_assets (the default). `filesystem` keeps
   * the bytes in a volume under {@link assetStoreDir} while metadata still lives
   * in vs_assets. Set ASSET_STORE_BACKEND=postgres|filesystem.
   */
  assetStoreBackend: "postgres" | "filesystem"; // ASSET_STORE_BACKEND (default: "postgres")

  /**
   * Filesystem root for asset bytes when {@link assetStoreBackend} is
   * `filesystem`. Ignored for the `postgres` backend. Set ASSET_STORE_DIR.
   */
  assetStoreDir: string | null; // ASSET_STORE_DIR (default: null)

  /**
   * Document converter backing POST /ingest-file.
   *
   * Opt-in: when CONVERTER_URL is unset the route is not mounted at all, so a
   * deployment without a converter answers 404 rather than failing at call time.
   * See `handlers/ingest-file.ts` for what the route does and does not do.
   */
  converter: ConverterConfig | null; // CONVERTER_URL (opt-in)

  /**
   * Use semantic (embedding-based) chunking instead of text-boundary chunking.
   * Requires CHUNK_SIZE to be set. Default: false.
   */
  semanticChunking: boolean; // SEMANTIC_CHUNKING (default: false)

  /**
   * Chapter splitting threshold (in chunks). When set, a document that would
   * produce MORE than this many chunks is split into chapter sub-documents at
   * Markdown heading boundaries (recursively at deeper levels for chapters that
   * are still too large). Each chapter becomes an independent unit with its own
   * `base_ref` (documentRef + "/<n>. <title>") and its own summary — so
   * "group by document" returns a chapter, not the whole file.
   * null / unset / 0 = disabled. Overridable per request via
   * X-Chapter-Split-Max-Chunks. Recommended value when enabling: 20.
   */
  chapterSplitMaxChunks: number | null; // CHAPTER_SPLIT_MAX_CHUNKS (default: null)

  /**
   * Percentile of inter-sentence cosine distances used as the breakpoint
   * threshold in semantic chunking. Higher = fewer, larger chunks.
   * Must be between 1 and 99. Default: 75.
   */
  breakpointPercentile: number; // BREAKPOINT_PERCENTILE (default: 75)

  /**
   * Binary quantization for new collections.
   * 'binary' adds a bit_vector column for fast Hamming-distance ANN with
   * float32 reranking (two-stage search). 'none' = float32 only.
   * Default: 'none'.
   */
  quantization: "none" | "binary"; // QUANTIZATION (default: "none")

  /**
   * LRU cache size for query embeddings.
   * Repeated search queries (RAG loops, identical user queries) hit the cache
   * instead of the embedding server. 0 = disabled. Default: 1000.
   */
  queryCacheSize: number; // QUERY_CACHE_SIZE (default: 1000)

  /**
   * Maximum number of connections in the PostgreSQL pool.
   * Default: 20. Tune based on your DB server's max_connections setting.
   */
  pgPoolMax: number; // PG_POOL_MAX (default: 20)

  /**
   * Per-query PostgreSQL statement timeout in milliseconds.
   * Prevents runaway queries from blocking a pool connection indefinitely.
   * Set 0 to disable. Default: 30 000.
   */
  pgStatementTimeoutMs: number; // PG_STATEMENT_TIMEOUT_MS (default: 30000)

  /**
   * OIDC JWT issuers for API / MCP machine-to-machine authentication.
   *
   * API clients present a JWT Bearer token obtained from any of the listed
   * OIDC providers. The server verifies the token's signature against the
   * provider's JWKS endpoint (discovered via
   * `<issuer>/.well-known/openid-configuration`) and validates standard
   * claims (`iss`, `exp`, optionally `aud`).
   *
   * Configured via `API_OIDC_ISSUERS` (JSON array). Empty array = disabled.
   */
  apiOidcIssuers: ApiOidcIssuerConfig[];

  /** Explicit authentication mode for API and MCP. */
  authnMode: "disabled" | "token" | "oidc" | "token_or_oidc";
  /** Domain-level authorization including operation rights and ACLs. */
  authzEnabled: boolean;
  /** Compatibility alias; internally only off|required, optional is migrated to off. */
  authzEnforcement: "off" | "required";
  /** Tenant partitioning of all tenant-scoped data operations. */
  tenantIsolationEnabled: boolean;
  /** Server-side tenant for single-tenant mode and non-OIDC principals. */
  defaultTenantId: string;
  /** Explicit, server-side permissions for the static service credential. */
  apiServiceScopes: string[];
  /** Deprecated alias for DEFAULT_TENANT_ID. */
  apiServiceTenantId: string | undefined;
  /** Deprecated alias for DEFAULT_TENANT_ID. */
  apiOidcDefaultTenantId: string | undefined;

  /**
   * Machine-to-machine service token for API and MCP clients.
   * Accepted as a Bearer token on all API routes (including /mcp, /ingest,
   * /search, etc.) but never shown on the admin-UI login page.
   * null = disabled.
   *
   * Use this when API_TOKEN is intentionally left empty (OIDC-only browser
   * login) but programmatic clients still need a stable shared secret.
   */
  monitorToken: string | null; // MONITOR_TOKEN
  /**
   * Refuse any request that establishes no end-user identity, instead of
   * treating it as a service/admin context with unrestricted read access.
   *
   * Off by default because a legitimate service-to-service ingest has no end
   * user. Turn it on where every read must be attributable to a person — then a
   * missing identity is a 403 rather than an escalation.
   *
   * ACL_REQUIRE_IDENTITY (default: false)
   */
  aclRequireIdentity: boolean;
  /**
   * Documented exception for the production gate: with `ACL_REQUIRE_IDENTITY`
   * disabled in production, this non-empty string (e.g. a ticket reference)
   * downgrades the fatal finding to a warning. It never relaxes runtime ACL
   * behaviour — it only acknowledges the risk.
   *
   * ACL_REQUIRE_IDENTITY_WAIVER (default: empty)
   */
  aclRequireIdentityWaiver: string;
  /**
   * Visibility of documents whose `allowed_users`/`allowed_groups` are both
   * empty. `allow` (default, backward compatible): every principal of the
   * tenant may read them. `deny`: only service or authorization-bypass
   * principals may; end users need an explicit ACL match (Req 3.2).
   *
   * DOCUMENT_ACL_DEFAULT (default: allow) — the production gate warns on `allow`.
   */
  documentAclDefault: "allow" | "deny";
  /**
   * Return the internal error message to the client in the `detail` field of a
   * 500 response. Off by default: for a database error that message is the
   * failing SQL, a constraint name or a column list. Clients always receive an
   * `errorId` that correlates with the server log.
   *
   * EXPOSE_ERROR_DETAIL (default: false) — refused by the production gate.
   */
  exposeErrorDetail: boolean;
  /**
   * Deployment environment, used by the production readiness gate.
   * NODE_ENV (default: "development").
   */
  nodeEnv: string;

  // Transaction Envelope v1 (MCP params._meta token or HTTP header)
  transactionEnforcement: "off" | "optional" | "required";
  transactionSecret: string | null;
  transactionIssuer: string;
  transactionAudience: string;
  transactionClockToleranceSeconds: number;
  transactionMaxTtlSeconds: number;

  /** Stateless MCP 2026-07-28 endpoint path. Default: /mcp/v2026. */
  mcp2026Path: string;
  /** Service metadata advertised by server/discover. */
  mcpServiceName: string;
  mcpServiceVersion: string;

  /**
   * OIDC / OpenID Connect login for the admin UI.
   * null = disabled. Populated only when OIDC_ISSUER, OIDC_CLIENT_ID,
   * OIDC_CLIENT_SECRET and OIDC_SESSION_SECRET are all set.
   */
  oidc: OidcConfig | null;
  /** Server-controlled policy for the cookie-authenticated /ui BFF. */
  uiBff: UiBffConfig;

  // ─── Token cost configuration (price per million tokens) ───────────────────
  embedInputTokenCost: number;
  embedOutputTokenCost: number;
  embedFallbackInputTokenCost: number;
  embedFallbackOutputTokenCost: number;
  sparseInputTokenCost: number;
  sparseOutputTokenCost: number;
  rerankInputTokenCost: number;
  rerankOutputTokenCost: number;
  rerankFallbackInputTokenCost: number;
  rerankFallbackOutputTokenCost: number;
  hydeInputTokenCost: number;
  hydeOutputTokenCost: number;
  summaryInputTokenCost: number;
  summaryOutputTokenCost: number;
}

/**
 * A single OIDC issuer entry for API/MCP JWT Bearer authentication.
 * Configured via the `API_OIDC_ISSUERS` JSON array.
 */
/**
 * The `@atf/extract` service that `POST /ingest-file` proxies binary uploads to.
 *
 * Search deliberately does not convert documents itself: PDF and office
 * conversion needs poppler and LibreOffice, which would add several hundred
 * megabytes and a document-parser attack surface to the container that serves
 * the query path. The converter runs as its own service and this is the address
 * of it.
 */
export interface ConverterConfig {
  /** CONVERTER_URL — base URL of @atf/extract. */
  url: string;
  /** CONVERTER_TOKEN — Bearer credential presented to the converter. */
  token: string | null;
  /**
   * CONVERTER_TIMEOUT_MS — a whole document, not a single page. Default 15 min:
   * conversion runs one vision call per page, so a long specification takes
   * minutes and a short timeout discards work that was nearly finished.
   */
  timeoutMs: number;
  /** CONVERTER_UPLOAD_LIMIT — body limit for POST /ingest-file. */
  uploadLimit: string;
}

export interface ApiOidcIssuerConfig {
  /**
   * Issuer URL — used to build the discovery URL and to validate the `iss`
   * claim in incoming JWTs. Trailing slash is handled automatically.
   */
  issuer: string;
  /**
   * Expected `aud` claim value (e.g. the registered client_id).
   * When omitted, audience validation is skipped — acceptable for
   * providers that set a custom audience or when any authenticated
   * principal from the issuer is trusted.
   */
  audience?: string;
  /**
   * Claim carrying the end-user identity used for ACL evaluation.
   * Defaults to `sub`. Set to e.g. `preferred_username` or `email` when the
   * values stored in a document's `allowed_users` are usernames rather than
   * opaque subject identifiers.
   */
  userClaim?: string;
  /**
   * Claim carrying the caller's group memberships, matched against a
   * document's `allowed_groups`. Accepts either a JSON array or a
   * space/comma-separated string. Defaults to `groups`.
   */
  groupsClaim?: string;
  /** Claim carrying the tenant-wide server partition. */
  tenantClaim?: string;
  /** Claim carrying permissions as a string or string array. */
  scopesClaim?: string;
  /** Optional claim for client-id/audience binding. */
  clientIdClaim?: string;
}

/**
 * OpenID Connect configuration for browser-based admin-UI login.
 *
 * The server performs the Authorization Code flow with PKCE, verifies the
 * returned ID token's signature against the provider's JWKS endpoint, and then
 * issues its own short-lived signed session cookie. Provider metadata
 * (authorization/token/JWKS endpoints) is fetched from the issuer's
 * `.well-known/openid-configuration` document at runtime.
 */
export interface OidcConfig {
  /** OIDC_ISSUER — issuer URL, used for discovery and `iss` validation. */
  issuer: string;
  /** OIDC_CLIENT_ID — registered client identifier. */
  clientId: string;
  /** OIDC_CLIENT_SECRET — client secret for the token exchange. */
  clientSecret: string;
  /**
   * OIDC_REDIRECT_URI — exact callback URL registered at the provider.
   * When null, it is derived at request time as `<base-url>/auth/callback`
   * (base URL from PUBLIC_URL or the incoming request).
   */
  redirectUri: string | null;
  /** OIDC_SCOPES — space-separated scopes. Default: "openid profile email". */
  scopes: string;
  /** OIDC_SESSION_SECRET — HMAC secret used to sign session/transaction cookies. */
  sessionSecret: string;
  /** OIDC_ALLOWED_EMAILS — allow-list of exact email addresses (empty = any). */
  allowedEmails: string[];
  /** OIDC_ALLOWED_EMAIL_DOMAINS — allow-list of email domains (empty = any). */
  allowedEmailDomains: string[];
  /** OIDC_GROUPS_CLAIM — verified ID-token claim carrying group membership. */
  groupsClaim: string;
  /** OIDC_SESSION_TTL — session lifetime in seconds. Default: 28 800 (8 h). */
  sessionTtlSeconds: number;
}

export function loadConfig(): Config {
  // ── Env-var parse helpers ───────────────────────────────────────────────────
  //
  // Each helper reads one env variable, applies a default, validates the value,
  // and throws a descriptive Error on bad input.  Using helpers instead of
  // repeating the same boilerplate ~30 times keeps the function readable and
  // makes adding new variables a two-line change.

  function requireString(name: string): string {
    const v = process.env[name] ?? "";
    if (!v) throw new Error(`Missing required environment variable: ${name}`);
    return v;
  }

  function optionalString(name: string, fallback?: string): string | null {
    const v = (process.env[name] ?? "").trim();
    if (!v) return fallback !== undefined ? fallback : null;
    return v;
  }

  function parseIntEnv(
    name: string,
    defaultVal: number,
    opts: { min?: number; max?: number } = {},
  ): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return defaultVal;
    const parsed = parseInt(raw, 10);
    const { min = 1, max } = opts;
    if (
      !Number.isInteger(parsed) ||
      parsed < min ||
      (max !== undefined && parsed > max)
    ) {
      const range =
        max !== undefined ? `between ${min} and ${max}` : `>= ${min}`;
      throw new Error(
        `${name} must be an integer ${range}` +
          (min === 0 ? " (or 0 to disable)" : ""),
      );
    }
    return parsed;
  }

  function parseNonNegIntEnv(name: string, defaultVal: number): number {
    return parseIntEnv(name, defaultVal, { min: 0 });
  }

  function parseFloatEnv(
    name: string,
    defaultVal: number | null,
    exclusive?: { gt: number; lt: number },
  ): number | null {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return defaultVal;
    const parsed = parseFloat(raw);
    if (exclusive) {
      if (isNaN(parsed) || parsed <= exclusive.gt || parsed >= exclusive.lt) {
        throw new Error(
          `${name} must be a float in (${exclusive.gt}, ${exclusive.lt})`,
        );
      }
    }
    return parsed;
  }

  function parseBoolEnv(name: string, defaultVal: boolean): boolean {
    const raw = (process.env[name] ?? "").trim().toLowerCase();
    if (!raw) return defaultVal;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return defaultVal;
  }

  function parseEnumEnv<T extends string>(
    name: string,
    allowed: readonly T[],
    defaultVal: T,
  ): T {
    const raw = (process.env[name] ?? "").trim().toLowerCase() as T;
    if (!raw) return defaultVal;
    if (allowed.includes(raw)) return raw;
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }

  function resolveUrl(name: string, fallback: string): string {
    return optionalString(name) ?? fallback;
  }

  function parseCsvEnv(name: string): string[] {
    const raw = (process.env[name] ?? "").trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Parse the OIDC configuration block.
   *
   * OIDC is opt-in: when OIDC_ISSUER is empty the whole feature stays disabled
   * and this returns null. When the issuer is present, the remaining required
   * fields (client id/secret and a session secret) must also be set — otherwise
   * we fail fast so a half-configured provider can never silently do nothing.
   */
  function parseOidcConfig(): OidcConfig | null {
    const issuer = optionalString("OIDC_ISSUER");
    if (!issuer) return null;

    const clientId = optionalString("OIDC_CLIENT_ID");
    const clientSecret = optionalString("OIDC_CLIENT_SECRET");
    const sessionSecret = optionalString("OIDC_SESSION_SECRET");

    const missing: string[] = [];
    if (!clientId) missing.push("OIDC_CLIENT_ID");
    if (!clientSecret) missing.push("OIDC_CLIENT_SECRET");
    if (!sessionSecret) missing.push("OIDC_SESSION_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `OIDC is enabled (OIDC_ISSUER set) but missing: ${missing.join(", ")}`,
      );
    }
    if ((sessionSecret as string).length < 16) {
      throw new Error(
        "OIDC_SESSION_SECRET must be at least 16 characters for HMAC signing",
      );
    }

    return {
      issuer: issuer.replace(/\/+$/, ""),
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      redirectUri: optionalString("OIDC_REDIRECT_URI"),
      scopes: optionalString("OIDC_SCOPES") ?? "openid profile email",
      sessionSecret: sessionSecret as string,
      allowedEmails: parseCsvEnv("OIDC_ALLOWED_EMAILS").map((e) =>
        e.toLowerCase(),
      ),
      allowedEmailDomains: parseCsvEnv("OIDC_ALLOWED_EMAIL_DOMAINS").map((d) =>
        d.toLowerCase().replace(/^@/, ""),
      ),
      groupsClaim: optionalString("OIDC_GROUPS_CLAIM") ?? "groups",
      sessionTtlSeconds: parseIntEnv("OIDC_SESSION_TTL", 28_800, { min: 60 }),
    };
  }

  /**
   * Parse the API_OIDC_ISSUERS env var.
   *
   * Accepts a JSON array of issuer objects:
   *   [{"issuer":"https://...","audience":"client-id"},...]
   *
   * `audience` is optional per entry. An empty or absent env var returns [].
   */
  function parseApiOidcIssuers(): ApiOidcIssuerConfig[] {
    const raw = (process.env["API_OIDC_ISSUERS"] ?? "").trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `API_OIDC_ISSUERS: invalid JSON — ${err instanceof Error ? err.message : err}. ` +
          `Expected format: '[{"issuer":"https://...","audience":"optional-client-id"}]'`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("API_OIDC_ISSUERS must be a JSON array");
    }
    return parsed.map((entry: unknown, i: number) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`API_OIDC_ISSUERS[${i}]: each entry must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e["issuer"] !== "string" || !e["issuer"].trim()) {
        throw new Error(
          `API_OIDC_ISSUERS[${i}]: "issuer" must be a non-empty string`,
        );
      }
      for (const key of [
        "audience",
        "userClaim",
        "groupsClaim",
        "tenantClaim",
        "scopesClaim",
        "clientIdClaim",
      ]) {
        if (e[key] !== undefined && typeof e[key] !== "string") {
          throw new Error(
            `API_OIDC_ISSUERS[${i}]: "${key}" must be a string when present`,
          );
        }
      }
      return {
        issuer: (e["issuer"] as string).trim(),
        ...(e["audience"] !== undefined
          ? { audience: e["audience"] as string }
          : {}),
        ...(e["userClaim"] !== undefined
          ? { userClaim: e["userClaim"] as string }
          : {}),
        ...(e["groupsClaim"] !== undefined
          ? { groupsClaim: e["groupsClaim"] as string }
          : {}),
        ...(e["tenantClaim"] !== undefined
          ? { tenantClaim: e["tenantClaim"] as string }
          : {}),
        ...(e["scopesClaim"] !== undefined
          ? { scopesClaim: e["scopesClaim"] as string }
          : {}),
        ...(e["clientIdClaim"] !== undefined
          ? { clientIdClaim: e["clientIdClaim"] as string }
          : {}),
      };
    });
  }

  // ── Required fields ─────────────────────────────────────────────────────────
  const postgresUrl = requireString("POSTGRES_URL");
  const embedUrl = requireString("EMBED_URL");
  const embedModel = requireString("EMBED_MODEL");
  const embedModelRevision =
    optionalString("EMBED_MODEL_REVISION") ?? embedModel;

  // ── Simple optional fields ──────────────────────────────────────────────────
  const embedInputField = optionalString("EMBED_INPUT_FIELD") ?? "inputs";
  const embedFallbackModel = optionalString("EMBED_FALLBACK_MODEL");
  const embedFallbackUrl = embedFallbackModel
    ? (optionalString("EMBED_FALLBACK_URL") ?? embedUrl)
    : null;
  const embedFallbackInputField =
    optionalString("EMBED_FALLBACK_INPUT_FIELD") ?? "input";
  const embedExpectedDimensionRaw =
    process.env["EMBED_EXPECTED_DIMENSION"]?.trim();
  const embedExpectedDimension = embedExpectedDimensionRaw
    ? Number(embedExpectedDimensionRaw)
    : null;
  if (
    embedExpectedDimension !== null &&
    (!Number.isInteger(embedExpectedDimension) || embedExpectedDimension < 1)
  ) {
    throw new Error("EMBED_EXPECTED_DIMENSION must be a positive integer");
  }
  const defaultCollection = process.env["DEFAULT_COLLECTION"] || "documents";
  const apiToken = optionalString("API_TOKEN");
  const logLevel = process.env["LOG_LEVEL"] || "info";
  const bodyLimit = process.env["BODY_LIMIT"] || "10mb";
  const streamBodyLimit =
    (process.env["STREAM_BODY_LIMIT"] ?? "50mb").trim() || "50mb";
  const revisionBatchBodyLimit =
    (process.env.REVISION_BATCH_BODY_LIMIT ?? "50mb").trim() || "50mb";

  // ── v2 AssetStore (design §6.5, Requirement 14.2) ──────────────────────────
  const assetStoreBackendRaw = (process.env.ASSET_STORE_BACKEND ?? "postgres")
    .trim()
    .toLowerCase();
  if (
    assetStoreBackendRaw !== "postgres" &&
    assetStoreBackendRaw !== "filesystem"
  ) {
    throw new Error('ASSET_STORE_BACKEND must be "postgres" or "filesystem"');
  }
  const assetStoreBackend = assetStoreBackendRaw as "postgres" | "filesystem";
  const assetStoreDir = optionalString("ASSET_STORE_DIR");
  if (assetStoreBackend === "filesystem" && assetStoreDir === null) {
    throw new Error(
      "ASSET_STORE_DIR is required when ASSET_STORE_BACKEND=filesystem",
    );
  }
  const defaultFtsLanguage = (process.env["FTS_LANGUAGE"] ?? "simple")
    .trim()
    .toLowerCase();

  // ── Document converter (opt-in — enabled when CONVERTER_URL is set) ─────────
  // Without it, POST /ingest-file is not mounted, so a caller gets 404 rather
  // than a 502 from an address that was never configured.
  const converterUrl = optionalString("CONVERTER_URL");
  const converter: ConverterConfig | null =
    converterUrl === null
      ? null
      : {
          url: converterUrl.replace(/\/+$/, ""),
          token: optionalString("CONVERTER_TOKEN"),
          timeoutMs: parseNonNegIntEnv("CONVERTER_TIMEOUT_MS", 900_000),
          uploadLimit:
            (process.env["CONVERTER_UPLOAD_LIMIT"] ?? "50mb").trim() || "50mb",
        };

  // ── Integer fields ──────────────────────────────────────────────────────────
  const port = parseIntEnv("PORT", 3000, { min: 1, max: 65535 });
  const hnswEfSearch = parseIntEnv("HNSW_EF_SEARCH", 100);
  const hnswIterativeScan = parseEnumEnv(
    "HNSW_ITERATIVE_SCAN",
    ["relaxed_order", "strict_order", "off"] as const,
    "relaxed_order",
  );
  const hnswMaxScanTuples = parseIntEnv("HNSW_MAX_SCAN_TUPLES", 20_000, {
    min: 1,
  });
  const hnswEfConstruction = parseIntEnv("HNSW_EF_CONSTRUCTION", 128);
  const hnswM = parseIntEnv("HNSW_M", 16, { min: 2 });
  const fetchTimeoutMs = parseNonNegIntEnv("FETCH_TIMEOUT_MS", 30_000);
  const statsFlushIntervalMs = parseIntEnv("STATS_FLUSH_INTERVAL_MS", 30_000, {
    min: 1000,
  });
  const hydeMaxTokens = parseIntEnv("HYDE_MAX_TOKENS", 256);
  const summaryMaxTokens = parseIntEnv("SUMMARY_MAX_TOKENS", 256);
  // 0 disables the summary timeout entirely (see summary-client.ts). Use for
  // very slow local models or long chapter summaries; otherwise raise the value.
  const summaryTimeoutMs = parseNonNegIntEnv("SUMMARY_TIMEOUT_MS", 120_000);
  const summaryMaxConcurrency = parseIntEnv("SUMMARY_MAX_CONCURRENCY", 4);
  const sparseVocabSize = parseIntEnv("SPARSE_VOCAB_SIZE", 30522);
  const rrfK = parseIntEnv("RRF_K", 60);
  // Per-list RRF weights (task 3.4, Requirement 12.3). Positive floats; default
  // 1.0 preserves the previous unweighted ranking exactly.
  const parsePosFloatEnv = (name: string, defaultVal: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return defaultVal;
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a float > 0`);
    }
    return parsed;
  };
  const rrfWeightDense = parsePosFloatEnv("RRF_WEIGHT_DENSE", 1.0);
  const rrfWeightFts = parsePosFloatEnv("RRF_WEIGHT_FTS", 1.0);
  const rrfWeightIdentifier = parsePosFloatEnv("RRF_WEIGHT_IDENTIFIER", 1.0);
  const rrfWeightSparse = parsePosFloatEnv("RRF_WEIGHT_SPARSE", 1.0);
  const rrfMissingZero = parseBoolEnv("RRF_MISSING_ZERO", true);
  const ftsRanker = parseEnumEnv(
    "FTS_RANKER",
    ["ts_rank_cd", "bm25"] as const,
    "ts_rank_cd",
  );
  const breakpointPercentile = parseIntEnv("BREAKPOINT_PERCENTILE", 75, {
    min: 1,
    max: 99,
  });
  const queryCacheSize = parseNonNegIntEnv("QUERY_CACHE_SIZE", 1000);
  const pgPoolMax = parseIntEnv("PG_POOL_MAX", 20);
  const pgStatementTimeoutMs = parseNonNegIntEnv(
    "PG_STATEMENT_TIMEOUT_MS",
    30_000,
  );
  const statsRetentionDays = parseNonNegIntEnv("STATS_RETENTION_DAYS", 90);
  // Query statistics are hashed by default; the raw term is persisted only on
  // explicit opt-in (Requirement 2.6). The pepper makes the hash salted.
  const statsStoreRawQuery = parseBoolEnv("STATS_STORE_RAW_QUERY", false);
  const statsQueryPepper = optionalString("STATS_QUERY_PEPPER");
  // Subject-scoped erasure matches this metadata field plus allowed_users
  // (Requirement 2.5); "subject" is the convention Extract writes.
  const erasureSubjectMetadataField =
    optionalString("ERASURE_SUBJECT_METADATA_FIELD") ?? "subject";
  // REVISION_TTL is expressed in seconds; default 14 days.
  const revisionTtlMs =
    parseIntEnv("REVISION_TTL", 14 * 24 * 60 * 60, { min: 1 }) * 1000;
  const revisionTtlSweepMs = parseNonNegIntEnv(
    "REVISION_TTL_SWEEP_MS",
    3_600_000,
  );
  const sourceClaimTtlMs =
    parseIntEnv("SOURCE_CLAIM_TTL", 24 * 60 * 60, { min: 1 }) * 1000;
  const dedupNearThreshold =
    parseFloatEnv("DEDUP_NEAR_THRESHOLD", 0.9, { gt: 0, lt: 1.000001 }) ?? 0.9;
  const dedupDuplicateSimilarity =
    parseFloatEnv("DEDUP_DUPLICATE_SIMILARITY", 0.97, {
      gt: 0,
      lt: 1.000001,
    }) ?? 0.97;
  const batchWorkerEnabled = parseBoolEnv("BATCH_WORKER", false);
  const batchWorkerIntervalMs = parseNonNegIntEnv(
    "BATCH_WORKER_INTERVAL_MS",
    2_000,
  );
  const batchWorkerBackoffMs = parseNonNegIntEnv(
    "BATCH_WORKER_BACKOFF_MS",
    30_000,
  );
  const contextualChunkLlm = parseBoolEnv("CONTEXTUAL_CHUNK_LLM", false);
  const contextHeaderMaxFraction =
    parseFloatEnv("CONTEXT_HEADER_MAX_FRACTION", 0.15, { gt: 0, lt: 1 }) ??
    0.15;
  const rateLimit = parseNonNegIntEnv("RATE_LIMIT", 120);
  const contextPrefixSizeRaw = parseIntEnv("CHUNK_CONTEXT_PREFIX_SIZE", 0);
  const contextPrefixSize =
    contextPrefixSizeRaw > 0 ? contextPrefixSizeRaw : null;
  const chapterSplitMaxChunksRaw = parseNonNegIntEnv(
    "CHAPTER_SPLIT_MAX_CHUNKS",
    0,
  );
  const chapterSplitMaxChunks =
    chapterSplitMaxChunksRaw > 0 ? chapterSplitMaxChunksRaw : null;

  // ── Boolean fields ──────────────────────────────────────────────────────────
  const hybridSearch = parseBoolEnv("HYBRID_SEARCH", true);
  const trustProxy = parseBoolEnv("TRUST_PROXY", false);
  const aclRequireIdentity = parseBoolEnv("ACL_REQUIRE_IDENTITY", false);
  const aclRequireIdentityWaiver = (
    process.env["ACL_REQUIRE_IDENTITY_WAIVER"] ?? ""
  ).trim();
  const documentAclDefault = parseEnumEnv(
    "DOCUMENT_ACL_DEFAULT",
    ["allow", "deny"] as const,
    "allow",
  );
  const exposeErrorDetail = parseBoolEnv("EXPOSE_ERROR_DETAIL", false);
  const nodeEnv = (process.env["NODE_ENV"] ?? "development")
    .trim()
    .toLowerCase();
  const halfPrecision = parseBoolEnv("VECTOR_HALF_PRECISION", false);
  const semanticChunking = parseBoolEnv("SEMANTIC_CHUNKING", false);
  const hydeEnableThinking = parseBoolEnv("HYDE_ENABLE_THINKING", false);
  const summaryEnableThinking = parseBoolEnv("SUMMARY_ENABLE_THINKING", false);

  const legacyAuthzEnforcementRaw = process.env["AUTHZ_ENFORCEMENT"]?.trim();
  const legacyAuthzEnforcement = parseEnumEnv(
    "AUTHZ_ENFORCEMENT",
    ["off", "optional", "required"] as const,
    "off",
  );
  const authzEnabledRaw = process.env["AUTHZ_ENABLED"]?.trim();
  if (
    !authzEnabledRaw &&
    legacyAuthzEnforcementRaw?.toLowerCase() === "optional"
  ) {
    throw new Error(
      "AUTHZ_ENFORCEMENT=optional cannot be migrated safely; set AUTHZ_ENABLED explicitly to true or false",
    );
  }
  const authzEnabled = authzEnabledRaw
    ? parseBoolEnv("AUTHZ_ENABLED", false)
    : legacyAuthzEnforcement === "required";
  const authzEnforcement: "off" | "required" = authzEnabled
    ? "required"
    : "off";
  const tenantIsolationEnabled = parseBoolEnv(
    "TENANT_ISOLATION_ENABLED",
    false,
  );
  const legacyServiceTenantId =
    optionalString("API_SERVICE_TENANT_ID") ?? undefined;
  const legacyOidcTenantId =
    optionalString("API_OIDC_DEFAULT_TENANT_ID") ?? undefined;
  if (
    legacyServiceTenantId !== undefined &&
    legacyOidcTenantId !== undefined &&
    legacyServiceTenantId !== legacyOidcTenantId
  ) {
    throw new Error(
      "API_SERVICE_TENANT_ID and API_OIDC_DEFAULT_TENANT_ID must match during migration to DEFAULT_TENANT_ID",
    );
  }
  const defaultTenantId =
    optionalString("DEFAULT_TENANT_ID") ??
    legacyServiceTenantId ??
    legacyOidcTenantId ??
    "default";
  const apiServiceScopes = [
    ...new Set(
      parseCsvEnv("API_SERVICE_SCOPES")
        .flatMap((scope) => scope.split(/[\s,]+/))
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
  const apiServiceTenantId = legacyServiceTenantId ?? defaultTenantId;
  const apiOidcDefaultTenantId = legacyOidcTenantId ?? defaultTenantId;
  const transactionEnforcement = parseEnumEnv(
    "TRANSACTION_ENFORCEMENT",
    ["off", "optional", "required"] as const,
    "off",
  );
  const transactionSecret = optionalString("TRANSACTION_HS256_SECRET");
  const transactionIssuer =
    optionalString("TRANSACTION_ISSUER") ?? "vectorsearch-client";
  const transactionAudience =
    optionalString("TRANSACTION_AUDIENCE") ?? "vectorsearch";
  const transactionClockToleranceSeconds = parseNonNegIntEnv(
    "TRANSACTION_CLOCK_TOLERANCE_SECONDS",
    30,
  );
  const transactionMaxTtlSeconds = parseIntEnv(
    "TRANSACTION_MAX_TTL_SECONDS",
    900,
    { min: 1 },
  );
  const mcp2026Path = optionalString("MCP_2026_PATH") ?? "/mcp/v2026";
  if (!mcp2026Path.startsWith("/") || mcp2026Path === "/mcp") {
    throw new Error(
      "MCP_2026_PATH must be an absolute path distinct from /mcp",
    );
  }
  const mcpServiceName = optionalString("MCP_SERVICE_NAME") ?? "vectorsearch";
  const mcpServiceVersion = optionalString("MCP_SERVICE_VERSION") ?? "1.0.0";
  if (transactionEnforcement !== "off" && !transactionSecret) {
    throw new Error(
      "TRANSACTION_HS256_SECRET is required when TRANSACTION_ENFORCEMENT is optional or required",
    );
  }

  // ── Enum fields ─────────────────────────────────────────────────────────────
  const quantization = parseEnumEnv(
    "QUANTIZATION",
    ["none", "binary"] as const,
    "none",
  );
  const rerankEndpoint = parseEnumEnv(
    "RERANK_ENDPOINT",
    ["embeddings", "rerank"] as const,
    "rerank",
  );
  const rerankFallbackEndpoint = parseEnumEnv(
    "RERANK_FALLBACK_ENDPOINT",
    ["embeddings", "rerank"] as const,
    "rerank",
  );

  // ── Float fields ────────────────────────────────────────────────────────────
  const lateChunkingAlpha = parseFloatEnv("LATE_CHUNKING_ALPHA", null, {
    gt: 0,
    lt: 1,
  });

  // ── Reranking ───────────────────────────────────────────────────────────────
  const rerankUrl = resolveUrl("RERANK_URL", embedUrl);
  const rerankModel = optionalString("RERANK_MODEL");
  const rerankInputSeparator = optionalString("RERANK_SEPARATOR") ?? "\n";
  const rerankDocumentsField =
    optionalString("RERANK_DOCUMENTS_FIELD") ?? "texts";
  const rerankFallbackModel = optionalString("RERANK_FALLBACK_MODEL");
  const rerankFallbackUrl = rerankFallbackModel
    ? (optionalString("RERANK_FALLBACK_URL") ?? rerankUrl)
    : null;
  const rerankFallbackInputSeparator =
    optionalString("RERANK_FALLBACK_SEPARATOR") ?? "\n";
  const rerankFallbackDocumentsField =
    optionalString("RERANK_FALLBACK_DOCUMENTS_FIELD") ?? "texts";
  const rerankCandidateMultiplier = parseIntEnv(
    "RERANK_CANDIDATE_MULTIPLIER",
    4,
  );
  const minRerankScoreRaw = process.env["MIN_RERANK_SCORE"];
  let minRerankScore: number | null = null;
  if (minRerankScoreRaw !== undefined && minRerankScoreRaw.trim() !== "") {
    const parsed = Number.parseFloat(minRerankScoreRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error("MIN_RERANK_SCORE must be a finite number");
    }
    minRerankScore = parsed;
  }

  // ── Chunking (CHUNK_SIZE + CHUNK_OVERLAP must both be set or both absent) ──
  const chunkSizeRaw = process.env["CHUNK_SIZE"];
  const chunkOverlapRaw = process.env["CHUNK_OVERLAP"];
  let defaultChunkSize: number | null = null;
  let defaultChunkOverlap: number | null = null;

  if (chunkSizeRaw !== undefined || chunkOverlapRaw !== undefined) {
    if (chunkSizeRaw === undefined || chunkOverlapRaw === undefined) {
      throw new Error("Both CHUNK_SIZE and CHUNK_OVERLAP must be set together");
    }
    const parsedChunkSize = parseInt(chunkSizeRaw, 10);
    if (!Number.isInteger(parsedChunkSize) || parsedChunkSize <= 0)
      throw new Error("CHUNK_SIZE must be a positive integer");
    const parsedChunkOverlap = parseInt(chunkOverlapRaw, 10);
    if (!Number.isInteger(parsedChunkOverlap) || parsedChunkOverlap < 0)
      throw new Error("CHUNK_OVERLAP must be a non-negative integer");
    if (parsedChunkOverlap >= parsedChunkSize)
      throw new Error("CHUNK_OVERLAP must be less than CHUNK_SIZE");
    defaultChunkSize = parsedChunkSize;
    defaultChunkOverlap = parsedChunkOverlap;
  }

  // ── URL fallbacks for optional services ────────────────────────────────────
  const hydeUrl = resolveUrl("HYDE_URL", embedUrl);
  const hydeModel = optionalString("HYDE_MODEL");
  const hydeToken = optionalString("HYDE_TOKEN");
  const summaryUrl = resolveUrl("SUMMARY_URL", embedUrl);
  const summaryModel = optionalString("SUMMARY_MODEL");
  const summaryToken = optionalString("SUMMARY_TOKEN");
  const sparseUrl = resolveUrl("SPARSE_URL", embedUrl);
  const sparseModel = optionalString("SPARSE_MODEL");

  // ── Token counting (TEI /tokenize) ──────────────────────────────────────
  // Derive the tokenize URL from EMBED_URL by reusing the origin and replacing
  // the path with /tokenize (mirrors how the embedding/rerank clients derive
  // their endpoints from the same origin). Bedrock has no /tokenize endpoint,
  // so on a bedrock… EMBED_URL the derivation yields null and the counter
  // degrades to the character heuristic.
  const embedIsBedrock = embedUrl.startsWith("bedrock");
  function deriveTokenizeUrlFromEmbed(base: string): string | null {
    if (!base || base.startsWith("bedrock")) return null;
    try {
      const parsed = new URL(base);
      parsed.pathname = "/tokenize";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }
  const tokenizeUrl =
    optionalString("TOKENIZE_URL") ?? deriveTokenizeUrlFromEmbed(embedUrl);
  // Enabled by default, but never for Bedrock and never without a usable URL.
  const tokenizeEnabled =
    !embedIsBedrock &&
    tokenizeUrl !== null &&
    parseBoolEnv("TOKENIZE_ENABLED", true);
  const tokenizeTimeoutMs = parseNonNegIntEnv("TOKENIZE_TIMEOUT_MS", 5_000);
  const tokenizeCacheSize = parseNonNegIntEnv("TOKENIZE_CACHE_SIZE", 2_048);

  // ── OIDC login (opt-in — enabled when OIDC_ISSUER is set) ───────────────────
  const oidc = parseOidcConfig();

  // The browser BFF never derives tenant or operation scopes from the ID token
  // or request. Groups are signed by the IdP and can be narrowed further here.
  const uiBff: UiBffConfig = {
    tenantId: optionalString("UI_TENANT_ID") ?? defaultTenantId,
    scopes: [
      ...new Set(
        parseCsvEnv("UI_SCOPES")
          .flatMap((scope) => scope.split(/[\s,]+/))
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ],
    allowedGroups: [...new Set(parseCsvEnv("UI_ALLOWED_GROUPS"))],
    operatorGroup: optionalString("UI_OPERATOR_GROUP"),
  };

  // ── API/MCP OIDC JWT issuers (opt-in — enabled when API_OIDC_ISSUERS is set) ─
  const apiOidcIssuers = parseApiOidcIssuers();

  // ── Monitor token — web UI token login (opt-in) ──────────────────────────
  const monitorToken = optionalString("MONITOR_TOKEN");

  const inferredAuthnMode =
    apiToken !== null && apiOidcIssuers.length > 0
      ? "token_or_oidc"
      : apiOidcIssuers.length > 0
        ? "oidc"
        : apiToken !== null
          ? "token"
          : "disabled";
  const authnMode = parseEnumEnv(
    "AUTHN_MODE",
    ["disabled", "token", "oidc", "token_or_oidc"] as const,
    inferredAuthnMode,
  );
  if (
    (authnMode === "token" || authnMode === "token_or_oidc") &&
    apiToken === null
  ) {
    throw new Error(`API_TOKEN is required when AUTHN_MODE=${authnMode}`);
  }
  if (
    (authnMode === "oidc" || authnMode === "token_or_oidc") &&
    apiOidcIssuers.length === 0
  ) {
    throw new Error(
      `API_OIDC_ISSUERS is required when AUTHN_MODE=${authnMode}`,
    );
  }
  if (tenantIsolationEnabled && authnMode === "disabled") {
    throw new Error(
      "AUTHN_MODE=disabled cannot be used with TENANT_ISOLATION_ENABLED=true because no authenticated principal can select a tenant",
    );
  }
  if (
    tenantIsolationEnabled &&
    (authnMode === "token" || authnMode === "token_or_oidc") &&
    legacyServiceTenantId === undefined
  ) {
    throw new Error(
      `API_SERVICE_TENANT_ID is required when AUTHN_MODE=${authnMode} and TENANT_ISOLATION_ENABLED=true`,
    );
  }

  // ── Token cost configuration (price per million tokens, USD) ──────────────
  // Defaults are *fictional comparable prices*: what a similar model would cost
  // at a commercial provider. They apply even when running local models (which
  // report no real cost) so the Activity page always shows a meaningful
  // estimate. Override any value via the matching *_TOKEN_COST env var; set to
  // 0 explicitly to disable cost estimation for a component.
  //
  // Reference points (per 1M tokens, rounded, as of 2025):
  //   dense/sparse embeddings ≈ $0.02 in  (OpenAI text-embedding-3-small class)
  //   reranker                ≈ $0.10 in  (Cohere Rerank class, token-approx)
  //   HyDE / summary LLM      ≈ $0.15 in / $0.60 out (GPT-4o-mini class)
  const embedInputTokenCost =
    parseFloatEnv("EMBED_INPUT_TOKEN_COST", 0.02) ?? 0.02;
  const embedOutputTokenCost = parseFloatEnv("EMBED_OUTPUT_TOKEN_COST", 0) ?? 0;
  const embedFallbackInputTokenCost =
    parseFloatEnv("EMBED_FALLBACK_INPUT_TOKEN_COST", 0) ?? 0;
  const embedFallbackOutputTokenCost =
    parseFloatEnv("EMBED_FALLBACK_OUTPUT_TOKEN_COST", 0) ?? 0;
  const sparseInputTokenCost =
    parseFloatEnv("SPARSE_INPUT_TOKEN_COST", 0.02) ?? 0.02;
  const sparseOutputTokenCost =
    parseFloatEnv("SPARSE_OUTPUT_TOKEN_COST", 0) ?? 0;
  const rerankInputTokenCost =
    parseFloatEnv("RERANK_INPUT_TOKEN_COST", 0.1) ?? 0.1;
  const rerankOutputTokenCost =
    parseFloatEnv("RERANK_OUTPUT_TOKEN_COST", 0) ?? 0;
  const rerankFallbackInputTokenCost =
    parseFloatEnv("RERANK_FALLBACK_INPUT_TOKEN_COST", 0.1) ?? 0.1;
  const rerankFallbackOutputTokenCost =
    parseFloatEnv("RERANK_FALLBACK_OUTPUT_TOKEN_COST", 0) ?? 0;
  const hydeInputTokenCost =
    parseFloatEnv("HYDE_INPUT_TOKEN_COST", 0.15) ?? 0.15;
  const hydeOutputTokenCost =
    parseFloatEnv("HYDE_OUTPUT_TOKEN_COST", 0.6) ?? 0.6;
  const summaryInputTokenCost =
    parseFloatEnv("SUMMARY_INPUT_TOKEN_COST", 0.15) ?? 0.15;
  const summaryOutputTokenCost =
    parseFloatEnv("SUMMARY_OUTPUT_TOKEN_COST", 0.6) ?? 0.6;

  return {
    postgresUrl,
    defaultCollection,
    embedUrl,
    embedModel,
    embedModelRevision,
    embedInputField,
    embedFallbackUrl,
    embedFallbackModel,
    embedFallbackInputField,
    embedExpectedDimension,
    apiToken,
    port,
    logLevel,
    defaultChunkSize,
    defaultChunkOverlap,
    rerankUrl,
    rerankModel,
    rerankInputSeparator,
    rerankCandidateMultiplier,
    minRerankScore,
    rerankEndpoint,
    rerankDocumentsField,
    rerankFallbackUrl,
    rerankFallbackModel,
    rerankFallbackInputSeparator,
    rerankFallbackEndpoint,
    rerankFallbackDocumentsField,
    hybridSearch,
    bodyLimit,
    rateLimit,
    trustProxy,
    hnswEfSearch,
    hnswIterativeScan,
    hnswMaxScanTuples,
    hnswEfConstruction,
    hnswM,
    halfPrecision,
    contextPrefixSize,
    defaultFtsLanguage,
    fetchTimeoutMs,
    statsRetentionDays,
    statsStoreRawQuery,
    statsQueryPepper,
    erasureSubjectMetadataField,
    hydeUrl,
    hydeModel,
    hydeMaxTokens,
    hydeEnableThinking,
    hydeToken,
    summaryUrl,
    summaryModel,
    summaryMaxTokens,
    summaryEnableThinking,
    summaryToken,
    summaryTimeoutMs,
    summaryMaxConcurrency,
    sparseUrl,
    sparseModel,
    sparseVocabSize,
    tokenizeUrl,
    tokenizeEnabled,
    tokenizeTimeoutMs,
    tokenizeCacheSize,
    lateChunkingAlpha,
    rrfK,
    rrfWeightDense,
    rrfWeightFts,
    rrfWeightIdentifier,
    rrfWeightSparse,
    rrfMissingZero,
    ftsRanker,
    statsFlushIntervalMs,
    streamBodyLimit,
    revisionBatchBodyLimit,
    assetStoreBackend,
    assetStoreDir,
    revisionTtlMs,
    revisionTtlSweepMs,
    sourceClaimTtlMs,
    dedupNearThreshold,
    dedupDuplicateSimilarity,
    batchWorkerEnabled,
    batchWorkerIntervalMs,
    batchWorkerBackoffMs,
    contextualChunkLlm,
    contextHeaderMaxFraction,
    converter,
    semanticChunking,
    breakpointPercentile,
    chapterSplitMaxChunks,
    quantization,
    queryCacheSize,
    pgPoolMax,
    pgStatementTimeoutMs,
    oidc,
    uiBff,
    apiOidcIssuers,
    authnMode,
    authzEnabled,
    authzEnforcement,
    tenantIsolationEnabled,
    defaultTenantId,
    apiServiceScopes,
    apiServiceTenantId,
    apiOidcDefaultTenantId,
    monitorToken: monitorToken ?? null,
    aclRequireIdentity,
    aclRequireIdentityWaiver,
    documentAclDefault,
    exposeErrorDetail,
    nodeEnv: nodeEnv.length > 0 ? nodeEnv : "development",
    transactionEnforcement,
    transactionSecret,
    transactionIssuer,
    transactionAudience,
    transactionClockToleranceSeconds,
    transactionMaxTtlSeconds,
    mcp2026Path,
    mcpServiceName,
    mcpServiceVersion,
    embedInputTokenCost,
    embedOutputTokenCost,
    embedFallbackInputTokenCost,
    embedFallbackOutputTokenCost,
    sparseInputTokenCost,
    sparseOutputTokenCost,
    rerankInputTokenCost,
    rerankOutputTokenCost,
    rerankFallbackInputTokenCost,
    rerankFallbackOutputTokenCost,
    hydeInputTokenCost,
    hydeOutputTokenCost,
    summaryInputTokenCost,
    summaryOutputTokenCost,
  };
}
