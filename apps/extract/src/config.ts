// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * config.ts
 *
 * Application configuration: type definition and environment variable parsing.
 *
 * Every variable is parsed here with an explicit default, a range check and
 * cross-constraint validation, and the process fails fast on startup with a
 * descriptive message. Extract has its own environment contract: names that also
 * exist in Search or Runtime are NOT shared, except the access-control block
 * (`AUTHN_MODE`, `OIDC_*`, `UI_*`, …) which is deliberately identical so an
 * operator configures SSO once for the whole fabric.
 */

import { PAGE_LABELS, type PageLabel } from "@atf/extract-contract/v1";
import { figureKindSchema, type FigureKind } from "@atf/extract-contract/v2";

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

export interface ApiOidcIssuerConfig {
  /** Issuer URL — builds the discovery URL and validates the `iss` claim. */
  issuer: string;
  /**
   * Expected `aud` claim. When omitted, audience validation is skipped, which
   * means a token the same IdP minted for a *different* service authenticates
   * here. The production gate flags that.
   */
  audience?: string;
  /** Claim carrying the end-user identity. Default: `sub`. */
  userClaim?: string;
  /** Claim carrying group membership. Default: `groups`. */
  groupsClaim?: string;
  /** Claim carrying the tenant partition. */
  tenantClaim?: string;
  /** Claim carrying permissions as a string or string array. */
  scopesClaim?: string;
  /** Optional claim for client-id binding. */
  clientIdClaim?: string;
}

/**
 * OpenID Connect configuration for browser-based UI login.
 *
 * Identical in shape to Search's so the same IdP client can serve both.
 */
export interface OidcConfig {
  /** OIDC_ISSUER — issuer URL, used for discovery and `iss` validation. */
  issuer: string;
  /** OIDC_CLIENT_ID — registered client identifier. */
  clientId: string;
  /** OIDC_CLIENT_SECRET — client secret for the token exchange. */
  clientSecret: string;
  /** OIDC_REDIRECT_URI — exact callback URL; derived per request when null. */
  redirectUri: string | null;
  /** OIDC_SCOPES — space-separated scopes. Default: "openid profile email". */
  scopes: string;
  /** OIDC_SESSION_SECRET — HMAC secret signing session/transaction cookies. */
  sessionSecret: string;
  /** OIDC_ALLOWED_EMAILS — allow-list of exact addresses (empty = any). */
  allowedEmails: string[];
  /** OIDC_ALLOWED_EMAIL_DOMAINS — allow-list of domains (empty = any). */
  allowedEmailDomains: string[];
  /** OIDC_GROUPS_CLAIM — ID-token claim carrying group membership. */
  groupsClaim: string;
  /** OIDC_SESSION_TTL — session lifetime in seconds. Default: 28 800 (8 h). */
  sessionTtlSeconds: number;
}

/**
 * PostgreSQL persistence for v2 jobs (schema `extract`).
 *
 * Populated only when `EXTRACT_DATABASE_URL` is set. It is deliberately
 * optional: the v2 job model is new, whereas the v1 synchronous `/v1/ingest`
 * and `/convert` paths must keep working with no database at all. The
 * persistence layer therefore initialises lazily — a deployment that has not
 * enabled v2 jobs runs exactly as before and never opens a pool.
 */
export interface ExtractDatabaseConfig {
  /** EXTRACT_DATABASE_URL — libpq connection string for the extract schema. */
  url: string;
  /** EXTRACT_DB_POOL_MAX — max pooled connections. Default: 10. */
  poolMax: number;
  /**
   * EXTRACT_DB_STATEMENT_TIMEOUT_MS — per-query ceiling so a runaway query can
   * never pin a pool connection forever. 0 disables it. Default: 30 000.
   */
  statementTimeoutMs: number;
}

/**
 * The persistent job worker loop (design §9b, requirements 4.4, 4.5, 4.8).
 *
 * A worker claims jobs from the `extract.jobs` queue, holds a lease it renews
 * on a heartbeat, and fences every write on the lease epoch so a partitioned
 * "zombie" worker cannot overwrite a job another worker has taken over. These
 * tunables govern that loop; they always parse (with defaults) so the values
 * are validated at startup even in a deployment that has not enabled the
 * database, and the worker is only actually started when a store exists.
 */
export interface JobWorkerConfig {
  /**
   * JOB_LEASE_SECONDS — how long a claimed lease is valid before another worker
   * may take the job over. Must comfortably exceed the heartbeat interval so a
   * healthy worker never loses its own lease. Default 60.
   */
  leaseSeconds: number;
  /**
   * JOB_HEARTBEAT_INTERVAL_MS — how often a working worker renews its lease.
   * Default 20 000 (a third of the default lease).
   */
  heartbeatIntervalMs: number;
  /**
   * JOB_POLL_INTERVAL_MS — how long a worker waits after an empty queue poll
   * before trying again. Default 2 000.
   */
  pollIntervalMs: number;
  /**
   * JOB_MAX_TRANSIENT_WAIT_MS — how long a dependency (vision, text LLM, Search)
   * may stay unreachable with backoff before the job is parked in
   * `paused(reason=dependency)` and auto-resumed on recovery. Default 900 000
   * (15 min). Consumed by the stage runner in task 1.6.
   */
  maxTransientWaitMs: number;
  /**
   * VISION_TOKEN_ESTIMATE — rough per-page output-token estimate the stage
   * runner's budget guard checks before a vision call, so a job with an
   * (almost) exhausted `token_budget` is parked in `paused(reason=budget)`
   * before spending the call rather than after. A conservative estimate; the
   * actual spend is recorded from the model's usage after the call. Default
   * 4096.
   */
  visionTokenEstimate: number;
}

/**
 * Queue lanes and fairness (design §9a.5, requirement 6.6).
 *
 * A 10 000-page plan takes days of vision time; a handful of them claiming
 * every worker would starve the 40-page uploads behind them for just as long.
 * So a job whose `page_count` exceeds {@link largeJobPageThreshold} runs in a
 * separate "large" lane, and no more than {@link largeJobMaxConcurrency} large
 * jobs are ever leased across the whole worker fleet at once. The cap is
 * enforced in the claim query itself (it counts currently-leased large jobs and
 * declines to hand a worker another one past the cap), so it holds regardless
 * of how many workers poll the shared queue.
 *
 * A job whose `page_count` is still null — it has not reached the `preparing`
 * stage that probes the source — is treated as a NORMAL-lane job: its size is
 * unknown, so it is not counted against the large-lane cap and is freely
 * claimable. Once `preparing` records the page count a resumed/re-claimed job
 * lands in the correct lane. This is deliberate: withholding an unsized job
 * would stall every fresh job until something else sized it, and the worst case
 * of mis-laning one job for one claim (it turns out large after prepare) is a
 * single over-budget concurrent large job, self-correcting on its next claim.
 */
export interface QueueLaneConfig {
  /**
   * LARGE_JOB_PAGE_THRESHOLD — a job with STRICTLY MORE than this many pages
   * runs in the bounded large-job lane (design §9a.5: "über 1.000 Seiten").
   * Default 1000, so a 1000-page job is still normal and a 1001-page job is
   * large. A job with an unknown (null) page count is treated as normal until
   * `preparing` sizes it.
   */
  largeJobPageThreshold: number;
  /**
   * LARGE_JOB_MAX_CONCURRENCY — the most large-lane jobs leased across the
   * whole worker fleet at once (design §9a.5: "höchstens 1–2 parallele Jobs").
   * Kept small on purpose: a large job saturates the vision model's batch
   * capacity by itself, and the point of the lane is that small documents do
   * not wait days behind big ones. Default 1.
   */
  largeJobMaxConcurrency: number;
}

/**
 * The emitter that streams the staged outbox to Search (design §5 S8, §9b.3;
 * task 1.12, requirements 5.7, 6.3).
 *
 * The job runner stages one emit-outbox row per page and one asset-outbox row
 * per crop/page image. The emitter groups those staged pages into batches of
 * `emitBatchPages`, PUTs each batch at its seq (idempotent on the Content-Digest
 * Search already implements), uploads assets with bounded concurrency, and
 * commits a segment every `segmentPages` pages before the final `document.end`
 * commit. On a resume it first GETs the revision state and reconciles the outbox
 * against it, so it re-sends exactly what is missing — no duplicates, no loss.
 */
export interface EmitterConfig {
  /**
   * EMIT_BATCH_PAGES — pages grouped into one NDJSON batch sent to Search.
   * Default 20 (design §5 S8). Bounds the emitter's memory: it only ever holds
   * one batch of page records at a time, never the whole document.
   */
  emitBatchPages: number;
  /**
   * SEGMENT_PAGES — pages between segment commits. Default 250 (design §9a.3).
   * A committed segment is what `progressive` visibility makes searchable ahead
   * of the final commit; a larger segment trades earlier visibility for fewer
   * commit round-trips.
   */
  segmentPages: number;
  /**
   * ASSET_UPLOAD_CONCURRENCY — figure/page crops uploaded to Search in
   * parallel. Default 4 (design §5 S8). Bounded so a document with thousands of
   * crops cannot open thousands of concurrent PUTs.
   */
  assetUploadConcurrency: number;
  /**
   * FINALIZE_PASS — run the optional finalize pass at document end (design §5 S7
   * point 2, requirement 9.6). It is a deterministic, MODEL-FREE correction of
   * the outline metadata: once the whole document's heading-height distribution
   * is known, provisionally-mis-levelled unnumbered headings are re-ranked and
   * the affected `sectionPath` values corrected on `document.end`. Search then
   * re-embeds ONLY the units whose path changed (the expensive step), leaving
   * the rest untouched. Numbered / DOCX-style headings are authoritative and are
   * never moved. Default true; set false to emit the streaming outline as-is.
   */
  finalizePass: boolean; // FINALIZE_PASS (default: true)
}

/**
 * The durable, content-addressed source store (design §9a.1, requirement 4.13).
 *
 * A finished upload — whether it arrived in resumable chunks or was pulled from
 * a `source_url` — is moved here under a path derived from its whole-file
 * sha256. Content addressing makes storage idempotent: re-uploading the same
 * bytes lands on the same path, so a retried upload dedupes for free and a job
 * can always re-render deterministically from the one durable copy.
 */
export interface SourceStoreConfig {
  /** SOURCE_STORE_DIR — filesystem volume root for content-addressed sources. */
  dir: string;
  /**
   * UPLOAD_TMP_DIR — scratch directory the in-progress upload is streamed to
   * before its whole-file checksum is verified and it is moved into the store.
   * Kept separate from the store so a half-written or failed upload never
   * appears at a content-addressed path.
   */
  tmpDir: string;
}

/**
 * Pulling a source from a caller-supplied URL (design §9a.1, requirement 4.13).
 *
 * This is a server-side request forgery primitive in exactly the same way
 * `X-Callback-URL` is, so it reuses the callback controls: link-local and
 * metadata addresses are refused unconditionally, and `SOURCE_URL_ALLOWED_HOSTS`
 * — when set — is an allowlist with the same `.example.com`-matches-subdomains
 * convention as `CALLBACK_ALLOWED_HOSTS`.
 */
export interface SourceUrlConfig {
  /**
   * SOURCE_URL_ALLOWED_HOSTS — allowlist for `source_url` hosts. An entry
   * beginning with `.` matches any subdomain. Empty permits any host (still
   * minus link-local/metadata), which the production gate flags.
   */
  allowedHosts: string[];
  /** SOURCE_URL_MAX_BYTES — largest source a pull will accept. Default 2 GiB. */
  maxBytes: number;
  /** SOURCE_URL_TIMEOUT_MS — per-attempt timeout for the pull. Default 300 s. */
  timeoutMs: number;
}

/**
 * The text-LLM used for the summary hierarchy (design §5 S7 step 5, §9a.2;
 * task 2.7, requirement 9.5). This is the *already-configured* text model the
 * design names `SUMMARY_MODEL`/`HYDE_MODEL` — an OpenAI-compatible chat
 * endpoint (a vLLM in the reference deployment) — not a new model. Extract
 * gets its own `SUMMARY_*` block so the summary pass can run offline over the
 * pages it has just produced.
 *
 * The whole block is OPTIONAL: when `SUMMARY_URL` is unset this is `null`, the
 * summary hierarchy is skipped cleanly, and `document.end.summaries` stays
 * empty — exactly as a deployment without the text model degrades. A job never
 * fails for want of a summary endpoint.
 */
export interface SummaryConfig {
  /** SUMMARY_URL — full chat-completions URL (used as-is, no suffix appended). */
  url: string;
  /** SUMMARY_MODEL — the model id sent in the request body. */
  model: string;
  /** SUMMARY_API_KEY — optional Bearer credential; omitted means no header. */
  apiKey: string | null;
  /** SUMMARY_TIMEOUT_MS — per-request timeout. 0 disables. Default 120 000. */
  timeoutMs: number;
  /** SUMMARY_TEMPERATURE — sampling temperature. Default 0.1. */
  temperature: number;
  /** SUMMARY_MAX_TOKENS — output budget per summary. Default 512. */
  maxTokens: number;
  /** SUMMARY_MAX_RETRIES — transient-failure retries. Default 3. */
  maxRetries: number;
  /**
   * SUMMARY_REASONING_EFFORT — forwarded as `chat_template_kwargs` for models
   * with a thinking budget. Unset means the field is not sent (strict servers
   * reject unknown fields).
   */
  reasoningEffort: string | null;
}

/** Where converted documents are pushed when ingest is requested. */
export interface SearchTargetConfig {
  /** SEARCH_URL — base URL of the @atf/search service. */
  url: string;
  /** SEARCH_TOKEN — Bearer credential presented to Search. */
  token: string | null;
  /** SEARCH_COLLECTION — target collection. */
  collection: string;
  /** SEARCH_TIMEOUT_MS — per-request timeout. */
  timeoutMs: number;
  /** SEARCH_UPLOAD_ASSETS — push figure crops to /document-assets. */
  uploadAssets: boolean;
}

export interface Config {
  // ── Server ────────────────────────────────────────────────────────────────
  port: number; // PORT (default: 3004)
  nodeEnv: string; // NODE_ENV (default: "development")
  logLevel: string; // LOG_LEVEL (default: "info")
  /** PUBLIC_URL — external base URL, used for OIDC redirects behind a proxy. */
  publicUrl: string | null; // PUBLIC_URL

  // ── Vision model ──────────────────────────────────────────────────────────
  /** VISION_URL — base URL of an OpenAI-compatible chat-completions API. */
  visionUrl: string; // VISION_URL (required)
  visionModel: string; // VISION_MODEL (required)
  /**
   * VISION_API_KEY — optional, because a self-hosted vLLM behind the cluster
   * network commonly has no auth. Omitted means no Authorization header.
   */
  visionApiKey: string | null; // VISION_API_KEY
  /**
   * VISION_TIMEOUT_MS — per-page timeout. Default 600 s: a dense A4 page on a
   * local 27B vision model routinely takes two to four minutes, and cutting it
   * off wastes the whole page. 0 disables the timeout.
   */
  visionTimeoutMs: number; // VISION_TIMEOUT_MS (default: 600000, 0=disabled)
  visionTemperature: number; // VISION_TEMPERATURE (default: 0.1)
  visionTopP: number; // VISION_TOP_P (default: 1.0)
  /**
   * VISION_MAX_TOKEN_VARIANTS — escalating output budgets, tried in order when
   * the model stops with `finish_reason: "length"`. A truncated page is a
   * silently corrupted page, so retrying with more room is the only correct
   * response; starting at the largest budget instead would slow every page down.
   */
  visionMaxTokenVariants: number[]; // VISION_MAX_TOKEN_VARIANTS (default: 8192,16384,32768)
  /** VISION_MAX_RETRIES — transient-failure retries per token budget. */
  visionMaxRetries: number; // VISION_MAX_RETRIES (default: 3)
  /**
   * VISION_REASONING_EFFORT — forwarded as `chat_template_kwargs` for models
   * that support a thinking budget. Unset means the field is not sent, which
   * matters because strict servers reject unknown fields.
   */
  visionReasoningEffort: string | null; // VISION_REASONING_EFFORT
  /**
   * VISION_SUPPORTS_JSON_SCHEMA — capability flag: the provider enforces
   * `response_format: json_schema` on chat completions (task 7.9, requirement
   * 5.10). Fail-closed like the runtime's model-capability rules: off unless
   * the operator states the backend supports it. A provider that rejects the
   * field anyway is handled by the client's fallback, not by failed pages.
   */
  visionSupportsJsonSchema: boolean; // VISION_SUPPORTS_JSON_SCHEMA (default: false)
  /** VISION_INPUT_TOKEN_COST — USD per million input tokens, for reporting. */
  visionInputTokenCost: number; // VISION_INPUT_TOKEN_COST (default: 0.15)
  /** VISION_OUTPUT_TOKEN_COST — USD per million output tokens. */
  visionOutputTokenCost: number; // VISION_OUTPUT_TOKEN_COST (default: 0.6)

  // ── Rendering ─────────────────────────────────────────────────────────────
  /**
   * RENDER_DPI — resolution the page is rasterised at for the vision model.
   * 200 is the knee of the curve: below it small table text stops being legible,
   * above it the image cost grows without improving transcription.
   */
  renderDpi: number; // RENDER_DPI (default: 200)
  /**
   * FIGURE_DPI — resolution figure crops are rendered at. Higher than
   * RENDER_DPI on purpose: a crop is shown to a human in a search result, and
   * re-rendering the page is cheap next to a vision call.
   */
  figureDpi: number; // FIGURE_DPI (default: 300)
  /**
   * FIGURE_PASS2_KINDS — the figure kinds that get a structured Pass-2
   * transcription (design §5 S5, requirement 8.3/8.6). A figure whose `kind` is
   * outside this set is described only, with no second model call. The default
   * covers every structured kind; `photo`/`diagram`/`other` are never in it.
   */
  figurePass2Kinds: FigureKind[]; // FIGURE_PASS2_KINDS (default: bpmn,flowchart,ui_mask,technical_drawing,chart,table_image)
  /**
   * FIGURE_PASS2_MIN_AREA — the smallest figure, as a fraction of the page
   * area, that is worth a Pass-2 call (requirement 8.6). A tiny inline icon
   * mis-tagged as a chart is not worth a model call; below this fraction Pass 2
   * is skipped. Default 0.02 (2 % of the page).
   */
  figurePass2MinArea: number; // FIGURE_PASS2_MIN_AREA (default: 0.02)
  /**
   * LABEL_COVERAGE_MIN — the minimum percentage of a figure's `labels` that
   * must appear in its Pass-2 transcription before the transcription is trusted
   * (requirement 8.4). Below it, Extract emits a warning and retries Pass 2
   * once. Default 60 (per cent).
   */
  labelCoverageMin: number; // LABEL_COVERAGE_MIN (default: 60)
  /**
   * TILE_TARGET_PIXELS — the long edge, in pixels, a single tile of a
   * large-format page is rendered towards (design §5 S6, task 5.1, requirement
   * 8.5). Drives both the tile count (page pixels / this) and the per-tile
   * render DPI, so a bigger value means fewer, sharper tiles. Default 2000, a
   * touch below the whole-page render target so a plan's tiles are legibly
   * sharper than the same plan sent as one downscaled image.
   */
  tileTargetPixels: number; // TILE_TARGET_PIXELS (default: 2000)
  /**
   * TILE_OVERLAP_FRACTION — the fraction of a tile's own extent that adjacent
   * tiles overlap by (design §5 S6, requirement 8.5). The 10 % default is the
   * spec value: enough that a symbol or dimension on a seam appears whole in at
   * least one tile, small enough that the merge's overlap-band dedup is cheap.
   * Bounded to [0, 0.5].
   */
  tileOverlapFraction: number; // TILE_OVERLAP_FRACTION (default: 0.1)
  /**
   * TILE_MAX_PER_PAGE — hard ceiling on `cols × rows` tiles for one page
   * (design §5 S6, requirement 8.6, budget guard). A vast A0 plan does not
   * spawn hundreds of vision calls; above this the grid is capped, keeping the
   * aspect ratio. Default 16 (a 4×4 grid).
   */
  tileMaxPerPage: number; // TILE_MAX_PER_PAGE (default: 16)
  /**
   * TEXT_FAST_PATH — enable the deterministic text fast-path (design §5 S3
   * "Text-Fast-Path", requirement 7.5). When a page classifies as `text` with
   * no table/figure candidates and usable `-bbox-layout` geometry, Extract
   * builds its blocks straight from that geometry and does NOT call the vision
   * model, saving an estimated 40–70 % of vision time on text-heavy documents.
   * The fidelity check stays active and gates eligibility: any anomaly falls
   * that page back to the normal vision path. Default true (opt-out), matching
   * design §13's recommendation ("aktiv, mit Fidelity-Gate").
   */
  textFastPath: boolean; // TEXT_FAST_PATH (default: true)
  /**
   * TEXT_FAST_PATH_MAX_INK_RATIO — the conservative fidelity gate for the fast
   * path (requirement 7.5). A `text` page only qualifies when the fraction of
   * ink OUTSIDE its text blocks is at or below this threshold; more ink than
   * that suggests hidden non-text content (a diagram, a stamp, a scanned
   * overlay) the text layer does not capture, so the page falls back to vision.
   * Deliberately low — a false fast-path (a page silently missing its
   * non-text content) is worse than a missed one. Default 0.04 (4 % of page
   * area), below the classifier's `highInkRatio` (0.06) so a `mixed`-leaning
   * page is never fast-pathed.
   */
  textFastPathMaxInkRatio: number; // TEXT_FAST_PATH_MAX_INK_RATIO (default: 0.04)
  /**
   * RENDER_MAX_PIXELS — hard ceiling on the output area of a `POST /v2/render`
   * response, in pixels (design §9a.1, requirement 14.4). A caller who asks for
   * a large `targetPixels`, or crops a poster-sized page, has the render DPI /
   * resize clamped DOWN to this so a single request cannot allocate a gigapixel
   * buffer. Defaults to the shared render budget (`MAX_RENDER_PIXELS`, ~40 MP)
   * so the on-demand render can never produce an image the decode step would
   * reject as a decompression bomb.
   */
  renderMaxPixels: number; // RENDER_MAX_PIXELS (default: 40000000)
  /**
   * RENDER_RATE_LIMIT — requests per minute per IP for `POST /v2/render`
   * (requirement 14.4). Each render spawns a poppler subprocess, so a burst is
   * CPU, not just bytes; the endpoint gets its own limiter on top of auth. A
   * zoom-heavy research session issues many small renders, so the default is
   * higher than the write-path `RATE_LIMIT`. 0 disables it.
   */
  renderRateLimit: number; // RENDER_RATE_LIMIT (default: 240, 0=disabled)
  /**
   * MAX_PAGES — refuse documents longer than this. 0 disables the limit.
   * The default is 500 (requirement 5.8): an unbounded upload occupies the
   * converter and spends model tokens per page without ceiling, so the
   * limit ships ON rather than off.
   */
  maxPages: number; // MAX_PAGES (default: 500, 0=unlimited)
  /**
   * VISION_BUDGET_PAGES_PER_DAY — vision pages a single tenant may spend
   * across all of its jobs per UTC day (requirement 5.8). Enforced by
   * `jobs/budget.ts` against a Postgres counter; a job that would cross the
   * limit fails with `BUDGET_EXCEEDED` (design §Budget). 0 disables the
   * daily cap — a warning in production, since the per-job token budget
   * alone does not bound a tenant's aggregate daily spend.
   */
  visionBudgetPagesPerDay: number; // VISION_BUDGET_PAGES_PER_DAY (default: 0, 0=unlimited)
  /** TEMP_DIR — scratch space for rendered pages and converted PDFs. */
  tempDir: string; // TEMP_DIR (default: "/tmp/atf-extract")
  /** PAGE_LABEL — page-marker label emitted in the canonical Markdown. */
  pageLabel: PageLabel; // PAGE_LABEL (default: "Seite")
  /** LIBREOFFICE_BIN — binary used to convert Word/Excel formats to PDF. */
  libreofficeBin: string; // LIBREOFFICE_BIN (default: "libreoffice")
  /** POPPLER_BIN_DIR — directory holding pdfinfo/pdftotext/pdftoppm. */
  popplerBinDir: string | null; // POPPLER_BIN_DIR
  /**
   * SUBPROCESS_TIMEOUT_MS — wall-clock ceiling on a single poppler or
   * LibreOffice invocation. A page whose render or text extraction hangs would
   * otherwise stall its slot in `PAGE_CONCURRENCY` forever and, at 10 000 pages,
   * wedge the whole job; a document that makes LibreOffice loop would never
   * return. The timeout turns a hang into a per-page warning (poppler) or a
   * retryable conversion failure (LibreOffice). 0 disables it.
   */
  subprocessTimeoutMs: number; // SUBPROCESS_TIMEOUT_MS (default: 120000, 0=disabled)
  /**
   * SUBPROCESS_MEMORY_LIMIT_MB — `prlimit --as` ceiling applied to each
   * converter subprocess on Linux (requirement 5.5). 0 disables the wrapper.
   *
   * Deliberately off by default: `--as` caps *virtual* address space, which
   * LibreOffice reserves far more generously than it uses, so a value tuned
   * for one image breaks conversions on another. In a container the cgroup
   * memory limit is the correct ceiling — set `mem_limit` there and leave
   * this at 0. Configure it on bare-metal Linux, where no cgroup applies.
   */
  subprocessMemoryLimitMb: number; // SUBPROCESS_MEMORY_LIMIT_MB (default: 0, 0=disabled)
  /**
   * SUBPROCESS_CPU_LIMIT_S — `prlimit --cpu` ceiling in CPU-seconds, SIGKILL
   * on breach (requirement 5.5). Unlike the wall-clock timeout this bounds
   * cumulative CPU across all of the converter's threads, so a process that
   * keeps yielding the CPU cannot stretch a spin indefinitely. It also bounds
   * an orphan: the `libreoffice` launcher execs `soffice.bin`, and a
   * wall-clock kill of the wrapper can leave the real process spinning — the
   * inherited CPU ceiling ends it. The default is generous (well above any
   * legitimate conversion) so it only ever catches runaways. 0 disables it.
   */
  subprocessCpuLimitSeconds: number; // SUBPROCESS_CPU_LIMIT_S (default: 900, 0=disabled)
  /**
   * CONVERTER_MODE — where the poppler/LibreOffice binaries execute
   * (requirement 5.7). `isolated` routes every conversion through a
   * newline-delimited JSON RPC over a Unix socket to the `extract-converter`
   * sidecar container — no network access, read-only root filesystem,
   * non-root, default (RuntimeDefault) seccomp profile — instead of spawning
   * them in this container. The socket carries only the {command, args, home,
   * timeoutMs} request and the stdout/stderr result; document bytes never
   * cross it, because the input and output directories live on a volume both
   * containers mount. `local` (the default) keeps the in-container spawns.
   */
  converterMode: "local" | "isolated"; // CONVERTER_MODE (default: local)
  /**
   * CONVERTER_SOCKET — filesystem path of the converter RPC socket when
   * CONVERTER_MODE=isolated. The extract container mounts the directory
   * containing it (connecting to a Unix socket needs write access to the
   * mount point); the converter container creates the socket there.
   */
  converterSocket: string; // CONVERTER_SOCKET (default: /run/atf-converter/converter.sock)

  // ── OCR fallback (requirement 5.11) ───────────────────────────────────────
  /**
   * OCR_FALLBACK — what happens to a scanned page (no text layer) when the
   * vision endpoint is down. `off` (default) fails the page for a later retry,
   * exactly as before. `tesseract` recognises the page text with Tesseract
   * instead and records a warning on the page, so a VLM outage degrades to
   * searchable OCR text rather than missing content. The binary must be
   * present in the image (or in the converter sidecar); a failing Tesseract
   * leaves the original vision failure in place.
   */
  ocrFallback: "off" | "tesseract"; // OCR_FALLBACK (default: off)
  /** TESSERACT_BIN — binary used for the OCR fallback. */
  tesseractBin: string; // TESSERACT_BIN (default: "tesseract")
  /**
   * OCR_LANG — Tesseract language(s), e.g. `deu` or `deu+eng`. The traineddata
   * files for every listed language must be installed in the image.
   */
  ocrLang: string; // OCR_LANG (default: "deu")

  // ── ZIP guard (requirement 5.1, 5.4) ──────────────────────────────────────
  /**
   * ZIP_MAX_ENTRIES — largest entry count a ZIP-based container (XLSX, VSDX,
   * DOCX, PPTX, DOCX embeddings) may declare. Checked against the central
   * directory before anything is inflated; a violation rejects the job with
   * `DOCUMENT_TOO_COMPLEX`.
   */
  zipMaxEntries: number; // ZIP_MAX_ENTRIES (default: 10000)
  /**
   * ZIP_MAX_TOTAL_BYTES — largest sum of declared uncompressed sizes across
   * all entries of one ZIP container.
   */
  zipMaxTotalBytes: number; // ZIP_MAX_TOTAL_BYTES (default: 536870912)
  /**
   * ZIP_MAX_ENTRY_BYTES — largest declared uncompressed size of a single ZIP
   * entry.
   */
  zipMaxEntryBytes: number; // ZIP_MAX_ENTRY_BYTES (default: 209715200)
  /**
   * ZIP_MAX_RATIO — largest accepted compression ratio (uncompressed /
   * compressed) of a single deflated entry. Normal document XML sits around
   * 10–30:1; anything past this is a bomb, not a document.
   */
  zipMaxRatio: number; // ZIP_MAX_RATIO (default: 100)
  /**
   * MAX_EMBED_DEPTH — how deep an Outlook `.msg` may nest embedded messages
   * before deeper ones are skipped with a warning (requirement 5.4).
   */
  maxEmbedDepth: number; // MAX_EMBED_DEPTH (default: 2)

  // ── Parser isolation (requirement 5.2) ────────────────────────────────────
  /**
   * PARSE_ISOLATED — run the native parsers (BPMN, XLSX, DOCX, VSDX, e-mail)
   * in a Worker thread with a heap ceiling so a pathological document cannot
   * take the service down with it. When off — or when the sandbox fails to
   * start — parsers run in-process.
   */
  parseIsolated: boolean; // PARSE_ISOLATED (default: true)
  /**
   * PARSE_MEMORY_LIMIT_MB — old-generation heap ceiling for the isolated
   * parser thread (`resourceLimits.maxOldGenerationSizeMb`; enforced by the
   * Node production runtime, ignored by Bun). A parse that exceeds it fails
   * with `DOCUMENT_TOO_COMPLEX` instead of growing without bound.
   */
  parseMemoryLimitMb: number; // PARSE_MEMORY_LIMIT_MB (default: 512)

  // ── Limits ────────────────────────────────────────────────────────────────
  /** MAX_UPLOAD_BYTES — largest accepted upload. Default 50 MiB. */
  maxUploadBytes: number; // MAX_UPLOAD_BYTES (default: 52428800)
  /**
   * UPLOAD_MEMORY_THRESHOLD_BYTES — a multipart upload larger than this is
   * spooled to a scratch file under `TEMP_DIR/uploads` instead of the heap
   * (requirement 5.9), so a document waiting for a conversion slot does not
   * also hold its bytes there. 0 spools every upload. The scratch file is
   * removed when the request finishes; a startup sweep clears what a crashed
   * process left behind.
   */
  uploadMemoryThresholdBytes: number; // UPLOAD_MEMORY_THRESHOLD_BYTES (default: 8388608)
  /** BODY_LIMIT — limit for JSON/text request bodies. */
  bodyLimit: string; // BODY_LIMIT (default: "1mb")
  /**
   * CONVERT_CONCURRENCY — documents converted at once. Kept low because each
   * one holds a LibreOffice process and a page's worth of image buffers.
   */
  convertConcurrency: number; // CONVERT_CONCURRENCY (default: 2)
  /** PAGE_CONCURRENCY — pages of one document in flight against the model. */
  pageConcurrency: number; // PAGE_CONCURRENCY (default: 4)
  /** QUEUE_MAX_DEPTH — queued documents before new uploads get 503. */
  queueMaxDepth: number; // QUEUE_MAX_DEPTH (default: 32)
  rateLimit: number; // RATE_LIMIT req/min/IP (default: 120, 0=disabled)
  /** CALLBACK_MAX_RETRIES — delivery attempts for an async conversion result. */
  callbackMaxRetries: number; // CALLBACK_MAX_RETRIES (default: 3)
  /** CALLBACK_TIMEOUT_MS — per-attempt timeout for callback delivery. */
  callbackTimeoutMs: number; // CALLBACK_TIMEOUT_MS (default: 30000)
  /**
   * CALLBACK_ALLOWED_HOSTS — allowlist for `X-Callback-URL` hosts. An entry
   * beginning with `.` matches any subdomain.
   *
   * Empty permits any host, because an internal orchestrator on an arbitrary
   * cluster DNS name is the normal case. `X-Callback-URL` is a server-side
   * request forgery primitive, so the production gate flags the empty list.
   */
  callbackAllowedHosts: string[]; // CALLBACK_ALLOWED_HOSTS

  // ── Source store and resumable upload ─────────────────────────────────────
  /**
   * Where finished sources are stored content-addressed by sha256, and the
   * scratch directory an in-progress upload is streamed to first. Always
   * populated with defaults derived from `TEMP_DIR`; the v2 upload routes are
   * only mounted when the database is configured, but the paths are validated
   * unconditionally so a misconfigured volume fails at startup, not on first use.
   */
  sourceStore: SourceStoreConfig; // SOURCE_STORE_DIR
  /** Config for pulling a source from a caller-supplied `source_url`. */
  sourceUrl: SourceUrlConfig; // SOURCE_URL_ALLOWED_HOSTS

  // ── Persistence ───────────────────────────────────────────────────────────
  /**
   * Populated only when EXTRACT_DATABASE_URL is set; null keeps the service
   * database-free (v1 sync ingest only, no v2 jobs). The persistence layer
   * initialises lazily from this.
   */
  database: ExtractDatabaseConfig | null;

  // ── Job worker ────────────────────────────────────────────────────────────
  /** Lease/heartbeat/poll tunables for the persistent job worker loop. */
  jobWorker: JobWorkerConfig; // JOB_LEASE_SECONDS, JOB_HEARTBEAT_INTERVAL_MS, …

  // ── Queue lanes and fairness ──────────────────────────────────────────────
  /** Large-job lane threshold and bounded parallelism (requirement 6.6). */
  queueLane: QueueLaneConfig; // LARGE_JOB_PAGE_THRESHOLD, LARGE_JOB_MAX_CONCURRENCY

  // ── Emitter ───────────────────────────────────────────────────────────────
  /** Batch/segment/asset-concurrency tunables for the outbox emitter. */
  emitter: EmitterConfig; // EMIT_BATCH_PAGES, SEGMENT_PAGES, ASSET_UPLOAD_CONCURRENCY

  // ── Search integration ────────────────────────────────────────────────────
  /** Populated only when SEARCH_URL is set; null disables /v1/ingest. */
  search: SearchTargetConfig | null;

  // ── Summary text-LLM ──────────────────────────────────────────────────────
  /**
   * The text-LLM for the summary hierarchy (task 2.7). Populated only when
   * SUMMARY_URL is set; null skips the summary pass and leaves
   * `document.end.summaries` empty (summaries are optional, design §5 S7).
   */
  summary: SummaryConfig | null;

  // ── Access ────────────────────────────────────────────────────────────────
  authnMode: AuthnMode; // AUTHN_MODE (inferred from credentials)
  apiToken: string | null; // API_TOKEN
  monitorToken: string | null; // MONITOR_TOKEN
  apiOidcIssuers: ApiOidcIssuerConfig[]; // API_OIDC_ISSUERS (JSON array)
  authzEnabled: boolean; // AUTHZ_ENABLED (default: true)
  tenantIsolationEnabled: boolean; // TENANT_ISOLATION_ENABLED (default: true)
  defaultTenantId: string; // DEFAULT_TENANT_ID (default: "default")
  /** API_SERVICE_SCOPES — scopes granted to a static-token caller. */
  apiServiceScopes: string[]; // API_SERVICE_SCOPES
  /** API_SERVICE_TENANT_ID — tenant a static-token caller acts in. */
  apiServiceTenantId: string | undefined; // API_SERVICE_TENANT_ID
  trustProxy: boolean; // TRUST_PROXY (default: false)
  exposeErrorDetail: boolean; // EXPOSE_ERROR_DETAIL (default: false)
  oidc: OidcConfig | null; // OIDC_* (opt-in via OIDC_ISSUER)
  uiBff: UiBffConfig; // UI_*
}

/** Credentials the API accepts. */
export type AuthnMode = "disabled" | "token" | "oidc" | "token_or_oidc";

/** Operation scopes this service authorises against. */
export const EXTRACT_SCOPES = [
  "extract.convert",
  "extract.ingest",
  "extract.delete",
  "extract.metrics",
  "extract.admin",
] as const;

export function loadConfig(): Config {
  // ── Env-var parse helpers ───────────────────────────────────────────────────
  // Each reads one variable, applies a default, validates, and throws a
  // descriptive Error. Same helper set as apps/search/src/config.ts so the two
  // services reject bad input identically.

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
    const parsed = Number.parseInt(raw, 10);
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
    defaultVal: number,
    range?: { min: number; max: number },
  ): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return defaultVal;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${name} must be a finite number`);
    }
    if (range && (parsed < range.min || parsed > range.max)) {
      throw new Error(`${name} must be between ${range.min} and ${range.max}`);
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

  function parseCsvEnv(name: string): string[] {
    const raw = (process.env[name] ?? "").trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * A comma-separated list of figure kinds, validated against the contract
   * enum. De-duplicated, order-independent. An empty value falls back to the
   * default; an unrecognised kind is a startup error rather than a silent drop,
   * so a typo in FIGURE_PASS2_KINDS never quietly disables Pass 2 for a kind.
   */
  function parseFigureKindsEnv(
    name: string,
    defaultVal: FigureKind[],
  ): FigureKind[] {
    const raw = parseCsvEnv(name).map((value) => value.toLowerCase());
    if (raw.length === 0) return defaultVal;
    const valid = new Set<string>(figureKindSchema.options);
    for (const value of raw) {
      if (!valid.has(value)) {
        throw new Error(
          `${name} must be a comma-separated list of figure kinds (${figureKindSchema.options.join(", ")}); got "${value}"`,
        );
      }
    }
    return [...new Set(raw as FigureKind[])];
  }

  /** Ascending, de-duplicated positive integers. */
  function parseIntListEnv(name: string, defaultVal: number[]): number[] {
    const raw = parseCsvEnv(name);
    if (raw.length === 0) return defaultVal;
    const parsed = raw.map((value) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `${name} must be a comma-separated list of positive integers`,
        );
      }
      return n;
    });
    return [...new Set(parsed)].sort((a, b) => a - b);
  }

  /**
   * OIDC is opt-in: an empty OIDC_ISSUER disables the whole feature. When the
   * issuer is present the remaining required fields must be too, so a
   * half-configured provider can never silently do nothing.
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

  /** `[{"issuer":"https://…","audience":"atf-extract"}]` */
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
    if (!Array.isArray(parsed))
      throw new Error("API_OIDC_ISSUERS must be a JSON array");
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

  /**
   * Persistence is opt-in; without EXTRACT_DATABASE_URL the service never opens
   * a pool and only the v1 synchronous paths are available. The v2 job routes
   * initialise the persistence layer lazily from this config.
   */
  function parseDatabase(): ExtractDatabaseConfig | null {
    const url = optionalString("EXTRACT_DATABASE_URL");
    if (!url) return null;
    return {
      url,
      poolMax: parseIntEnv("EXTRACT_DB_POOL_MAX", 10, { min: 1, max: 128 }),
      statementTimeoutMs: parseNonNegIntEnv(
        "EXTRACT_DB_STATEMENT_TIMEOUT_MS",
        30_000,
      ),
    };
  }

  /**
   * The job worker loop tunables. Always parse with defaults so the values are
   * validated at startup; the worker itself only runs when the database is
   * configured. The lease must exceed the heartbeat interval or a healthy
   * worker would race itself out of its own lease.
   */
  function parseJobWorker(): JobWorkerConfig {
    const leaseSeconds = parseIntEnv("JOB_LEASE_SECONDS", 60, {
      min: 5,
      max: 3600,
    });
    const heartbeatIntervalMs = parseIntEnv(
      "JOB_HEARTBEAT_INTERVAL_MS",
      20_000,
      {
        min: 1000,
      },
    );
    if (heartbeatIntervalMs >= leaseSeconds * 1000) {
      throw new Error(
        `JOB_HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}) must be less than JOB_LEASE_SECONDS (${leaseSeconds}s) so a healthy worker keeps its own lease`,
      );
    }
    return {
      leaseSeconds,
      heartbeatIntervalMs,
      pollIntervalMs: parseIntEnv("JOB_POLL_INTERVAL_MS", 2000, { min: 100 }),
      maxTransientWaitMs: parseNonNegIntEnv(
        "JOB_MAX_TRANSIENT_WAIT_MS",
        900_000,
      ),
      visionTokenEstimate: parseIntEnv("VISION_TOKEN_ESTIMATE", 4096, {
        min: 1,
      }),
    };
  }

  /**
   * The queue-lane tunables (requirement 6.6). Always parsed with defaults so
   * they are validated at startup even without the database; the claim query
   * only consults them when the worker actually runs. The threshold is a page
   * count (min 1) and the concurrency a small positive integer (min 1) — a cap
   * of 0 would wedge the large lane shut, so it is not allowed.
   */
  function parseQueueLane(): QueueLaneConfig {
    return {
      largeJobPageThreshold: parseIntEnv("LARGE_JOB_PAGE_THRESHOLD", 1000, {
        min: 1,
      }),
      largeJobMaxConcurrency: parseIntEnv("LARGE_JOB_MAX_CONCURRENCY", 1, {
        min: 1,
        max: 1024,
      }),
    };
  }

  /**
   * The emitter tunables. Always parse with defaults so they are validated at
   * startup even in a deployment without the database (which never runs the
   * emitter). The segment size must be at least the batch size, or a segment
   * commit could fire before its batch is even sent.
   */
  function parseEmitter(): EmitterConfig {
    const emitBatchPages = parseIntEnv("EMIT_BATCH_PAGES", 20, {
      min: 1,
      max: 10_000,
    });
    const segmentPages = parseIntEnv("SEGMENT_PAGES", 250, {
      min: 1,
      max: 100_000,
    });
    if (segmentPages < emitBatchPages) {
      throw new Error(
        `SEGMENT_PAGES (${segmentPages}) must be >= EMIT_BATCH_PAGES (${emitBatchPages}) so a segment always contains whole batches`,
      );
    }
    return {
      emitBatchPages,
      segmentPages,
      assetUploadConcurrency: parseIntEnv("ASSET_UPLOAD_CONCURRENCY", 4, {
        min: 1,
        max: 64,
      }),
      finalizePass: parseBoolEnv("FINALIZE_PASS", true),
    };
  }

  /**
   * The source store and upload scratch always resolve to a path, defaulting
   * under TEMP_DIR. They are validated even when the database (and therefore
   * the v2 upload routes) is disabled, so an unwritable volume is a startup
   * failure rather than a first-upload one.
   */
  function parseSourceStore(scratchRoot: string): SourceStoreConfig {
    return {
      dir: optionalString("SOURCE_STORE_DIR") ?? `${scratchRoot}/sources`,
      tmpDir: optionalString("UPLOAD_TMP_DIR") ?? `${scratchRoot}/uploads`,
    };
  }

  function parseSourceUrl(): SourceUrlConfig {
    return {
      allowedHosts: parseCsvEnv("SOURCE_URL_ALLOWED_HOSTS").map((host) =>
        host.toLowerCase(),
      ),
      // 2 GiB, matching the MAX_UPLOAD_BYTES ceiling design §5 S0 allows.
      maxBytes: parseIntEnv("SOURCE_URL_MAX_BYTES", 2_147_483_648, {
        min: 1024,
      }),
      timeoutMs: parseNonNegIntEnv("SOURCE_URL_TIMEOUT_MS", 300_000),
    };
  }

  /** Search is opt-in; without SEARCH_URL the /v1/ingest route is not mounted. */
  function parseSearchTarget(): SearchTargetConfig | null {
    const url = optionalString("SEARCH_URL");
    if (!url) return null;
    return {
      url: url.replace(/\/+$/, ""),
      token: optionalString("SEARCH_TOKEN"),
      collection: optionalString("SEARCH_COLLECTION") ?? "documents",
      timeoutMs: parseNonNegIntEnv("SEARCH_TIMEOUT_MS", 120_000),
      uploadAssets: parseBoolEnv("SEARCH_UPLOAD_ASSETS", true),
    };
  }

  /**
   * The summary text-LLM is opt-in: without SUMMARY_URL the summary hierarchy
   * (task 2.7) is skipped and `document.end.summaries` stays empty, so a
   * deployment that has not configured the text model behaves exactly as before
   * — the job still completes. When the URL is present the model id is required
   * too, so a half-configured endpoint cannot silently produce nothing. The
   * URL is used as-is (no path suffix appended), mirroring Search's
   * SUMMARY_URL semantics, because deployments point it straight at
   * `/v1/chat/completions`.
   */
  function parseSummary(): SummaryConfig | null {
    const url = optionalString("SUMMARY_URL");
    if (!url) return null;
    const model = optionalString("SUMMARY_MODEL");
    if (!model) {
      throw new Error("SUMMARY_MODEL is required when SUMMARY_URL is set");
    }
    return {
      url,
      model,
      apiKey: optionalString("SUMMARY_API_KEY"),
      // 0 disables the timeout (slow local models / long chapter summaries).
      timeoutMs: parseNonNegIntEnv("SUMMARY_TIMEOUT_MS", 120_000),
      temperature: parseFloatEnv("SUMMARY_TEMPERATURE", 0.1, {
        min: 0,
        max: 2,
      }),
      maxTokens: parseIntEnv("SUMMARY_MAX_TOKENS", 512, { min: 1 }),
      maxRetries: parseNonNegIntEnv("SUMMARY_MAX_RETRIES", 3),
      reasoningEffort: optionalString("SUMMARY_REASONING_EFFORT"),
    };
  }

  // ── Required fields ─────────────────────────────────────────────────────────
  const visionUrl = requireString("VISION_URL").replace(/\/+$/, "");
  const visionModel = requireString("VISION_MODEL");

  // ── Server ──────────────────────────────────────────────────────────────────
  const port = parseIntEnv("PORT", 3004, { min: 1, max: 65_535 });
  const nodeEnv = process.env["NODE_ENV"] || "development";
  const logLevel = process.env["LOG_LEVEL"] || "info";
  const publicUrl = optionalString("PUBLIC_URL");

  // ── Vision model ────────────────────────────────────────────────────────────
  const visionApiKey = optionalString("VISION_API_KEY");
  const visionTimeoutMs = parseNonNegIntEnv("VISION_TIMEOUT_MS", 600_000);
  const visionTemperature = parseFloatEnv("VISION_TEMPERATURE", 0.1, {
    min: 0,
    max: 2,
  });
  const visionTopP = parseFloatEnv("VISION_TOP_P", 1, { min: 0, max: 1 });
  const visionMaxTokenVariants = parseIntListEnv(
    "VISION_MAX_TOKEN_VARIANTS",
    [8192, 16_384, 32_768],
  );
  const visionMaxRetries = parseNonNegIntEnv("VISION_MAX_RETRIES", 3);
  const visionReasoningEffort = optionalString("VISION_REASONING_EFFORT");
  const visionSupportsJsonSchema = parseBoolEnv(
    "VISION_SUPPORTS_JSON_SCHEMA",
    false,
  );
  const visionInputTokenCost = parseFloatEnv("VISION_INPUT_TOKEN_COST", 0.15, {
    min: 0,
    max: 1_000,
  });
  const visionOutputTokenCost = parseFloatEnv("VISION_OUTPUT_TOKEN_COST", 0.6, {
    min: 0,
    max: 1_000,
  });

  // ── Rendering ───────────────────────────────────────────────────────────────
  const renderDpi = parseIntEnv("RENDER_DPI", 200, { min: 36, max: 1_200 });
  const figureDpi = parseIntEnv("FIGURE_DPI", 300, { min: 36, max: 1_200 });
  const figurePass2Kinds = parseFigureKindsEnv("FIGURE_PASS2_KINDS", [
    "bpmn",
    "flowchart",
    "ui_mask",
    "technical_drawing",
    "chart",
    "table_image",
  ]);
  const figurePass2MinArea = parseFloatEnv("FIGURE_PASS2_MIN_AREA", 0.02, {
    min: 0,
    max: 1,
  });
  const labelCoverageMin = parseIntEnv("LABEL_COVERAGE_MIN", 60, {
    min: 0,
    max: 100,
  });
  const tileTargetPixels = parseIntEnv("TILE_TARGET_PIXELS", 2000, {
    min: 256,
    max: 10_000,
  });
  const tileOverlapFraction = parseFloatEnv("TILE_OVERLAP_FRACTION", 0.1, {
    min: 0,
    max: 0.5,
  });
  const tileMaxPerPage = parseIntEnv("TILE_MAX_PER_PAGE", 16, {
    min: 1,
    max: 256,
  });
  const textFastPath = parseBoolEnv("TEXT_FAST_PATH", true);
  const textFastPathMaxInkRatio = parseFloatEnv(
    "TEXT_FAST_PATH_MAX_INK_RATIO",
    0.04,
    {
      min: 0,
      max: 1,
    },
  );
  const renderMaxPixels = parseIntEnv("RENDER_MAX_PIXELS", 40_000_000, {
    min: 1_000,
    max: 100_000_000,
  });
  const renderRateLimit = parseNonNegIntEnv("RENDER_RATE_LIMIT", 240);
  const maxPages = parseNonNegIntEnv("MAX_PAGES", 500);
  const visionBudgetPagesPerDay = parseNonNegIntEnv(
    "VISION_BUDGET_PAGES_PER_DAY",
    0,
  );
  const tempDir = optionalString("TEMP_DIR") ?? "/tmp/atf-extract";
  const pageLabelRaw = optionalString("PAGE_LABEL") ?? "Seite";
  const pageLabel = PAGE_LABELS.find(
    (label) => label.toLowerCase() === pageLabelRaw.toLowerCase(),
  );
  if (pageLabel === undefined) {
    throw new Error(`PAGE_LABEL must be one of: ${PAGE_LABELS.join(", ")}`);
  }
  const libreofficeBin = optionalString("LIBREOFFICE_BIN") ?? "libreoffice";
  const popplerBinDir = optionalString("POPPLER_BIN_DIR");
  const subprocessTimeoutMs = parseNonNegIntEnv(
    "SUBPROCESS_TIMEOUT_MS",
    120_000,
  );
  const subprocessMemoryLimitMb = parseNonNegIntEnv(
    "SUBPROCESS_MEMORY_LIMIT_MB",
    0,
  );
  const subprocessCpuLimitSeconds = parseNonNegIntEnv(
    "SUBPROCESS_CPU_LIMIT_S",
    900,
  );
  const converterMode = parseEnumEnv(
    "CONVERTER_MODE",
    ["local", "isolated"] as const,
    "local",
  );
  const converterSocket =
    optionalString("CONVERTER_SOCKET") ?? "/run/atf-converter/converter.sock";

  // ── OCR fallback (requirement 5.11) ───────────────────────────────────────
  const ocrFallback = parseEnumEnv(
    "OCR_FALLBACK",
    ["off", "tesseract"] as const,
    "off",
  );
  const tesseractBin = optionalString("TESSERACT_BIN") ?? "tesseract";
  const ocrLang = optionalString("OCR_LANG") ?? "deu";

  // ── ZIP guard (requirement 5.1, 5.4) ──────────────────────────────────────
  const zipMaxEntries = parseIntEnv("ZIP_MAX_ENTRIES", 10_000, { min: 1 });
  const zipMaxTotalBytes = parseIntEnv(
    "ZIP_MAX_TOTAL_BYTES",
    512 * 1024 * 1024,
    {
      min: 1024,
    },
  );
  const zipMaxEntryBytes = parseIntEnv(
    "ZIP_MAX_ENTRY_BYTES",
    200 * 1024 * 1024,
    {
      min: 1024,
    },
  );
  const zipMaxRatio = parseIntEnv("ZIP_MAX_RATIO", 100, { min: 1 });
  const maxEmbedDepth = parseNonNegIntEnv("MAX_EMBED_DEPTH", 2);

  // ── Parser isolation (requirement 5.2) ────────────────────────────────────
  const parseIsolated = parseBoolEnv("PARSE_ISOLATED", true);
  const parseMemoryLimitMb = parseIntEnv("PARSE_MEMORY_LIMIT_MB", 512, {
    min: 32,
  });

  // ── Limits ──────────────────────────────────────────────────────────────────
  const maxUploadBytes = parseIntEnv("MAX_UPLOAD_BYTES", 52_428_800, {
    min: 1024,
  });
  // Requirement 5.9: uploads above this are spooled to disk rather than held in
  // the heap while they wait for a conversion slot. 0 spools everything; there
  // is no fatal gate for it, because either setting is a valid operational
  // choice — the value only trades a syscall per upload against heap pressure.
  const uploadMemoryThresholdBytes = parseNonNegIntEnv(
    "UPLOAD_MEMORY_THRESHOLD_BYTES",
    8_388_608,
  );
  const bodyLimit = process.env["BODY_LIMIT"] || "1mb";
  const convertConcurrency = parseIntEnv("CONVERT_CONCURRENCY", 2, {
    min: 1,
    max: 64,
  });
  const pageConcurrency = parseIntEnv("PAGE_CONCURRENCY", 4, {
    min: 1,
    max: 64,
  });
  const queueMaxDepth = parseIntEnv("QUEUE_MAX_DEPTH", 32, { min: 1 });
  const rateLimit = parseNonNegIntEnv("RATE_LIMIT", 120);
  const callbackMaxRetries = parseNonNegIntEnv("CALLBACK_MAX_RETRIES", 3);
  const callbackTimeoutMs = parseIntEnv("CALLBACK_TIMEOUT_MS", 30_000, {
    min: 1,
  });
  const callbackAllowedHosts = parseCsvEnv("CALLBACK_ALLOWED_HOSTS").map(
    (host) => host.toLowerCase(),
  );

  // ── Source store and resumable upload ────────────────────────────────────────
  const sourceStore = parseSourceStore(tempDir);
  const sourceUrl = parseSourceUrl();

  // ── Persistence ─────────────────────────────────────────────────────────────
  const database = parseDatabase();
  const jobWorker = parseJobWorker();
  const queueLane = parseQueueLane();
  const emitter = parseEmitter();

  // ── Search integration ──────────────────────────────────────────────────────
  const search = parseSearchTarget();

  // ── Summary text-LLM ──────────────────────────────────────────────────────
  const summary = parseSummary();

  // ── Access ──────────────────────────────────────────────────────────────────
  const apiToken = optionalString("API_TOKEN");
  const monitorToken = optionalString("MONITOR_TOKEN");
  const apiOidcIssuers = parseApiOidcIssuers();
  const authzEnabled = parseBoolEnv("AUTHZ_ENABLED", true);
  const tenantIsolationEnabled = parseBoolEnv("TENANT_ISOLATION_ENABLED", true);
  const defaultTenantId = optionalString("DEFAULT_TENANT_ID") ?? "default";
  const apiServiceScopes = [
    ...new Set(
      parseCsvEnv("API_SERVICE_SCOPES")
        .flatMap((scope) => scope.split(/[\s,]+/))
        .filter(Boolean),
    ),
  ];
  const apiServiceTenantId =
    optionalString("API_SERVICE_TENANT_ID") ?? undefined;
  const trustProxy = parseBoolEnv("TRUST_PROXY", false);
  const exposeErrorDetail = parseBoolEnv("EXPOSE_ERROR_DETAIL", false);
  const oidc = parseOidcConfig();

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

  // The mode is inferred from the credentials that are actually configured, then
  // may be narrowed explicitly. Cross-validation catches the dangerous case: a
  // deployment that sets AUTHN_MODE=oidc but forgets API_OIDC_ISSUERS would
  // otherwise start with an auth middleware that can never succeed — or worse,
  // with a mode that silently falls through.
  const inferredAuthnMode: AuthnMode =
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
    apiServiceTenantId === undefined
  ) {
    throw new Error(
      `API_SERVICE_TENANT_ID is required when AUTHN_MODE=${authnMode} and TENANT_ISOLATION_ENABLED=true`,
    );
  }

  // A figure crop rendered above Search's asset ceiling cannot be stored, and
  // discovering that per figure at upload time wastes a whole conversion.
  if (figureDpi < renderDpi) {
    throw new Error(
      `FIGURE_DPI (${figureDpi}) must be >= RENDER_DPI (${renderDpi}); crops are shown to humans and must not be coarser than the model's input`,
    );
  }

  return {
    port,
    nodeEnv,
    logLevel,
    publicUrl,
    visionUrl,
    visionModel,
    visionApiKey,
    visionTimeoutMs,
    visionTemperature,
    visionTopP,
    visionMaxTokenVariants,
    visionMaxRetries,
    visionReasoningEffort,
    visionSupportsJsonSchema,
    visionInputTokenCost,
    visionOutputTokenCost,
    renderDpi,
    figureDpi,
    renderMaxPixels,
    renderRateLimit,
    figurePass2Kinds,
    figurePass2MinArea,
    labelCoverageMin,
    tileTargetPixels,
    tileOverlapFraction,
    tileMaxPerPage,
    textFastPath,
    textFastPathMaxInkRatio,
    maxPages,
    visionBudgetPagesPerDay,
    tempDir,
    pageLabel,
    libreofficeBin,
    popplerBinDir,
    subprocessTimeoutMs,
    subprocessMemoryLimitMb,
    subprocessCpuLimitSeconds,
    converterMode,
    converterSocket,
    ocrFallback,
    tesseractBin,
    ocrLang,
    zipMaxEntries,
    zipMaxTotalBytes,
    zipMaxEntryBytes,
    zipMaxRatio,
    maxEmbedDepth,
    parseIsolated,
    parseMemoryLimitMb,
    maxUploadBytes,
    uploadMemoryThresholdBytes,
    bodyLimit,
    convertConcurrency,
    pageConcurrency,
    queueMaxDepth,
    rateLimit,
    callbackMaxRetries,
    callbackTimeoutMs,
    callbackAllowedHosts,
    sourceStore,
    sourceUrl,
    database,
    jobWorker,
    queueLane,
    emitter,
    search,
    summary,
    authnMode,
    apiToken,
    monitorToken,
    apiOidcIssuers,
    authzEnabled,
    tenantIsolationEnabled,
    defaultTenantId,
    apiServiceScopes,
    apiServiceTenantId,
    trustProxy,
    exposeErrorDetail,
    oidc,
    uiBff,
  };
}
