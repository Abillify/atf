# Architecture

ATF is a Bun workspace monorepo containing five independently deployable applications and
six shared contract packages. The applications communicate over documented HTTP and MCP
interfaces only. None imports another's source, and none reads another's private
configuration.

## System overview

```mermaid
flowchart TB
    subgraph clients["Clients"]
        chat["Chat frontend<br/>(OpenAI-compatible)"]
        sdk["SDK / curl"]
        hook["Webhook / schedule"]
    end

    subgraph atf["ATF"]
        control["<b>Control</b><br/>Next.js operator UI<br/>:3001"]
        runtime["<b>Runtime</b><br/>orchestration + OpenAI-compatible API<br/>:3000"]
        search["<b>Search</b><br/>semantic retrieval<br/>:3002"]
        gate["<b>Gate</b><br/>governed MCP gateway<br/>:3003"]
        extract["<b>Extract</b><br/>document to Markdown<br/>:3004"]
    end

    subgraph state["State"]
        pg[("PostgreSQL<br/>+ pgvector")]
        redis[("Redis<br/>optional")]
    end

    subgraph external["External"]
        models["Model providers<br/>OpenAI · Google · Anthropic<br/>Azure · Bedrock · local"]
        systems["Customer systems<br/>SQL · HTTP · MQTT · MCP"]
    end

    chat --> runtime
    sdk --> runtime
    hook --> runtime
    control -->|HTTP + SSE| runtime

    runtime -->|HTTP| search
    runtime -->|MCP| gate
    runtime --> models
    runtime --> pg
    runtime -.->|cluster coordination| redis

    search --> pg
    search --> models
    search -.->|POST /ingest-file → v2 job| extract

    extract -->|v1: POST /ingest + PUT /document-assets| search
    extract -->|v2: revisions + assets emitter| search
    extract -->|vision model| models
    extract --> pg

    gate --> systems
    gate -.->|approval + session state| redis
    gate --> pg
```

Solid lines show configured request or persistence paths; they are not all mandatory for every
deployment or flow. Dashed lines are explicitly optional coordination paths. Runtime can run
without Search, Gate, or PostgreSQL for flows that do not require those capabilities, with
in-memory/per-replica trade-offs described below. Without Redis, Runtime and Gate degrade to
per-replica coordination rather than failing. Extract is optional in both directions: Search
mounts `/ingest-file` only when `CONVERTER_URL` is set, and Extract mounts `/v1/ingest` only
when `SEARCH_URL` is set. Extract's own PostgreSQL connection (`EXTRACT_DATABASE_URL`, schema
`extract`) is likewise optional: it is what turns on the persistent v2 job path — resumable
uploads, durable jobs, and the emitter — and when it is absent Extract falls back to the
original in-process synchronous conversion. The v2 data flow is described in
[Document Intelligence v2](#document-intelligence-v2-data-flow) below.

### Extract Outpost

The Outpost is a locally operated sync agent around `@atf/outpost-core`. Its Docker runtime
uses `/data` for sync state and file-backed credentials, while the Tauri desktop runtime keeps
credentials in the OS keychain and communicates with the same Node SEA sidecar over a local
Bearer-token-protected Control API. The sidecar binds only to loopback, reports its ephemeral
port on stdout and keeps OAuth loopback handling and keychain operations in the native host.

```mermaid
flowchart LR
  local[Local folder / S3 / Drive / Dropbox] --> outpost[Outpost Core]
  outpost --> extract[ATF Extract]
  desktop[Tauri host] -->|Control API + SSE| outpost
  desktop -->|keychain + loopback bridge| outpost
  outpost --> state[(Sync state)]
```

## Applications

### Runtime (`apps/runtime`)

The orchestration engine and the only public entry point for AI traffic. Bun + Hono.

Executes flow graphs, resolves models through named provider instances, enforces guardrails,
policy, approvals, and the PII vault, and records cost, traces, and audit entries. Exposes an
OpenAI-compatible surface so existing clients work unchanged, plus administrative and
monitoring APIs for Control.

Route groups: `/v1/*` (OpenAI-compatible chat, responses, models, embeddings), `/flows/*`,
`/runs/*`, `/admin/*`, `/monitoring/*`, `/security/*`, `/eval/*`, `/triggers/*`,
`/webhooks/*`, `/mcp`, `/health/*`, `/metrics`.

### Control (`apps/control`)

The operator and governance interface. Next.js 16, React 19.

Control uses Runtime's HTTP API and SSE monitoring stream. Its Next.js server delivers the
web application and optional response headers, but it imports no Runtime source and holds no
provider or database credentials. Production browser calls use relative same-origin URLs by
default and require deployment-owned reverse-proxy routing; an explicit
`NEXT_PUBLIC_BACKEND_URL` is a build-time development/cross-origin override. Control can be
deployed separately, behind a different ingress, or omitted entirely.

### Search (`apps/search`)

Semantic and hybrid retrieval over PostgreSQL with pgvector. Bun or Node, Express.

Owns ingestion, chunking, embedding, indexing, and query. Fuses dense and full-text results
with RRF and optionally reranks. Exposes REST endpoints (`/documents`, `/collections`,
`/summary`, `/folders`, `/admin/stats`), an MCP endpoint at `/mcp`, an OpenAPI document at
`/openapi.json`, `/metrics`, and `/health`.

Search is the one application with a Node build target (`build:node`) in addition to the Bun
target, for deployments that require a Node runtime.

### Gate (`apps/gate`)

An MCP gateway that turns declarative YAML into governed tools. Bun, Express.

Configuration comes from `MCPGATE_CONFIG_DIR`, not from environment variables alone. Each
tool declares its backend (SQL through Knex, HTTP, MQTT, MCP proxy, webhook, or a composite),
its parameter schema, and the scopes required to invoke it. User input is always bound as a
parameter; the verified caller identity flows into the query so a tool returns only rows that
caller may see.

Serves both MCP transports — streamable HTTP at `mcpPath` (default `/mcp`) and the legacy SSE
pair `/sse` and `/messages` — plus `/healthz`, `/readyz`, and a monitoring surface under
`/monitor/*`.

### Extract (`apps/extract`)

Document-to-Markdown extraction against the `atf-extract` contract. Bun or Node, Express.

Converts PDF, DOC, DOCX, XLS, XLSX, PNG, JPEG, GIF, TIFF, BMP and WebP into the canonical Markdown defined by
`packages/extract-contract`: `## Seite N` page markers, `<figure>` entries with normalised
geometry, per-page `<summary>` blocks, and HTML tables that preserve merged cells. Every format
funnels through one PDF page loop — office documents via LibreOffice — so page numbers, page
images and text offsets agree across formats.

Each page is rendered and sent to a vision model together with its text layer. The text layer is
authoritative for wording; the rendered page is authoritative for structure. Figure crops are
cut from a separately rendered, higher-resolution page.

It is the one application that needs external binaries: `poppler-utils` for PDF access and
`libreoffice` for office formats. That is precisely why it is a separate service rather than part
of Search — those dependencies have no business in the container that serves the query path.
The same reasoning applies one level down: with `CONVERTER_MODE=isolated` those binaries run in
a separate converter process (`dist/converter/server.js`) reached over a Unix socket, so the
code that parses attacker-controlled bytes does not share a process with the API tokens and
database credentials. Only command lines and output cross the socket; documents stay on a
shared scratch volume. Extract's own native parsers (BPMN, XLSX, DOCX, VSDX, e-mail) run in a
heap-limited Worker thread for the same reason.
Beyond wording and rendering, poppler also supplies page *geometry*: the deterministic page
analysis (S2) runs `pdftotext -bbox-layout` to read every word, line and block with coordinates,
normalises each box to `[0,1]`, and derives numbered-heading candidates and a font-size proxy from
the line heights. That geometry feeds bbox snapping, region text and the text fast-path downstream.
`-bbox-layout` needs poppler ≥ 0.42; Extract probes the capability at startup, reports it under
`dependencies.bbox_layout` in `/health`, and degrades S2 to a vision pass when it is absent rather
than failing.

Route groups: `/v1/convert` (sync, SSE, or async callback, selected by request header),
`/v1/ingest` (convert and index in one call, mounted only with `SEARCH_URL`), `/v2/uploads`
(resumable, content-addressed source upload) and `/v2/jobs` (persistent job control), both
mounted only when `EXTRACT_DATABASE_URL` is set, `/ui/*` (browser backend-for-frontend),
`/auth/*`, `/openapi.json`, `/metrics`, `/health`, and an operator upload UI at `/`.

With the v2 path active, `/v1/ingest` becomes a thin wrapper: the upload is stored, a v2 job is
created, and its emitter streams the revision **and figure assets** into Search — so figure
images are now stored, not only their descriptions. Without a database Extract keeps the
original behaviour, where `/v1/ingest` stores figure crops via `PUT /document-assets/:assetId`
and Search's `/ingest-file` proxy forwards Markdown only (images not stored).

Like Search, it has a Node build target (`build:node`) in addition to the Bun target.

## Shared contract packages

`packages/` holds the messages that cross service boundaries, each as a versioned package
with Zod validation and its own tests.

| Package | Version | Contract |
| --- | --- | --- |
| `@atf/identity-contract` | 1.1.0 | Verified principal and identity compatibility records |
| `@atf/transaction-contract` | 1.1.0 | Transaction envelope compatibility records |
| `@atf/evidence-contract` | 1.1.0 | Evidence and lineage compatibility records |
| `@atf/schema-compatibility` | 1.0.0 | Deterministic schema-evolution classification |
| `@atf/contract-adapter` | 1.0.0 | Explicit adapters between the contracts above |
| `@atf/extract-contract` | 2.0.0 | v2 NDJSON record stream (typed block model, figure transcriptions, asset references, codec, validator, Markdown view); v1 marker grammar under the `/v1` subpath |

`integration/system` exercises their combined lifecycle without external infrastructure, which
is what makes a contract break visible in CI rather than at deployment time.

`@atf/extract-contract` is additionally verified against the *consumer* rather than only against
itself: its test suite runs serialized output through Search's real
`document-structure.ts` parser, because a grammar both sides merely believe they agree on is how
page markers and figure bindings were silently lost before the package existed.

### Contract boundary status

Runtime, Search, and Gate still carry protocol-specific transaction and evidence envelopes
where their wire protocols genuinely differ. Those local envelopes are **not** aliases of the
shared records. Converging them requires an explicit compatibility migration through
`@atf/contract-adapter`; assuming they are already identical is the mistake this note exists
to prevent.

## Request path

A chat request through Runtime:

```mermaid
sequenceDiagram
    participant C as Client
    participant R as Runtime
    participant S as Search
    participant G as Gate
    participant M as Model provider

    C->>R: POST /v1/chat/completions
    R->>R: authenticate, resolve tenant, rate limit
    R->>R: compliance policy (model blocklist, data residency)
    R->>R: input guardrails
    R->>R: PII vault: tokenize before egress
    R->>S: retrieve top-K (retrieval node)
    S-->>R: chunks + citations
    R->>M: completion request
    M-->>R: response / tool call
    opt tool call requires approval
        R->>R: pause, emit pending approval
        R->>R: fail closed on timeout
    end
    R->>G: MCP tool invocation
    G->>G: authorize by scope, bind parameters
    G-->>R: tool result
    R->>R: validate tool output for injected instructions
    R->>R: groundedness check
    R->>R: output guardrails
    R->>R: PII vault: restore real values
    R-->>C: SSE stream
    R->>R: audit entry, cost ledger, debug trace
```

Stages are independently configured and many governance features are opt-in. The sequence above
shows the ordering when those controls are enabled: policy admission precedes graph execution,
PII tokenization precedes provider calls, and restoration follows output checks. A missing or
invalid `compliance-policy.yaml` currently disables that policy and allows execution; the
policy's `failClosed` field applies to evaluator exceptions only. Deployments that depend on the
policy must validate and monitor that it is loaded.

## Document Intelligence v2 data flow

The v2 ingestion path exists so that a 10 000-page document survives crashes, network faults,
and restarts without losing model tokens or producing duplicate index units. It splits the work
into two independently durable halves — Extract's persistent job and Search's revision — joined
by an at-least-once emitter that reconciles against the receiver.

```mermaid
flowchart LR
    src["Source<br/>(upload / source_url)"]
    subgraph extract["Extract · schema extract"]
        store[("SourceStore<br/>content-addressed")]
        job["Job<br/>lease · epoch · budget<br/>config/prompt hash"]
        stages["Staged pipeline<br/>render→text→vision→parse→crops<br/>per-unit checkpoints"]
        outbox["Emit + asset outbox<br/>pending→sent→acked"]
    end
    subgraph search["Search · pgvector"]
        rev["Revision<br/>idempotency-key · TTL"]
        staged[("Staged batches<br/>vs_ingest_batches")]
        bworker["Batch worker<br/>SKIP LOCKED"]
        units[("Index units + vs_assets<br/>deterministic unit_id")]
        ptr["Revision pointer<br/>atomic is_latest switch"]
    end

    src --> store --> job --> stages --> outbox
    outbox -->|"PUT batches (Content-Digest)"| rev
    outbox -->|"PUT assets (idempotent)"| rev
    rev --> staged --> bworker --> units
    outbox -->|"segment + final commit"| ptr
    ptr --> units
```

The invariants that make it resumable:

- **Content-addressed source.** The upload streams to disk and is stored under its sha256
  (`SOURCE_STORE_DIR`); full-resolution page images are re-rendered on demand rather than kept,
  so memory does not grow with page count. The resumable upload protocol (`/v2/uploads`) confirms
  bytes one chunk at a time so an aborted transfer resumes at the last confirmed offset.
- **Durable job with per-unit checkpoints.** Each job carries a lease (`expires_at`, `epoch`), a
  token budget, and a config/pipeline/prompt-hash snapshot. Every stage result is persisted with
  an `input_hash`; a resume reuses any checkpoint whose hash matches instead of re-calling the
  model, and every worker write is fenced against a stale lease epoch. A permanently failed unit
  is marked `failed` and the job continues; `retry-failed` re-runs only those units, and
  `reparse` re-applies the parser to persisted raw model responses with no new model calls.
- **Idempotent handover through an outbox.** Extract records every batch and asset in an outbox
  (`pending`) before sending, then reconciles against the revision's status on resume and sends
  only what is missing. Search accepts a batch only after staging it durably; batches carry a
  `Content-Digest` (a repeat is a no-op, a conflicting digest is a 409), and index units have
  deterministic ids, so retries never duplicate.
- **Decoupled batch worker.** Search's batch worker claims staged batches with `SKIP LOCKED`
  under a lease (`next_attempt_at` = lease expiry, fenced by a lease token), builds units,
  embeds, and upserts. If embedding fails the batch returns to `received` with backoff; a
  worker that dies keeps the batch hidden only until its lease expires. The worker is enabled
  with `BATCH_WORKER=true`.
- **Progressive visibility and atomic switch.** Under `visibility=progressive`, committed
  segments become searchable immediately — also for units the worker writes after the segment
  commit — and hits carry `revision_state=partial` with `pages_available`. The final commit is
  checked against the page count declared by `document.begin`/`document.end` (missing ranges →
  409) and recorded as a durable intent; the per-document revision pointer is switched only once
  every staged batch is processed (the commit answers `202 {pending: true}` until then, the old
  revision stays visible), with the `is_latest` flip in bounded, resumable chunks. A query never
  sees two revisions — or a replaced legacy v1 version — of the same document at once. Uncommitted
  revisions are swept after `REVISION_TTL` together with their units, identifiers, assets and a
  pointer that named them; a paused job's heartbeat extends it.

Both halves speak the single `@atf/extract-contract` v2 NDJSON record stream, and Search checks
the `X-Extract-Contract` header and refuses an incompatible major version.

### From documents to answers

The durable ingestion path above produces the raw material; the v2 extract, index, and runtime
layers turn it into retrievable, cited answers. The stages are additive over v1 — `/search` and
the v1 contract path keep working unchanged.

- **Streaming document pass (Extract).** Pages are analysed in strict page order with per-word
  geometry from `pdftotext -bbox-layout`, classified (`text`/`scan`/`drawing`/`mixed`), and
  deduplicated by render hash. A streaming pass builds a consistent outline (`sectionPath` per
  block), merges tables across page breaks, resolves cross-references, and extracts identifiers,
  persisting its state after every page so a resume never re-reads the whole document. Visual
  content is transcribed: a first pass yields each figure's `kind`, caption, snapped bounding
  box and summary; a second pass produces a structured transcription per kind (BPMN/flowchart →
  `process`, masks → `fields`, drawings, charts, table images). Large formats are split into
  overlapping **tiles**, each transcribed and merged, kept as `tile:` assets so a zoom is served
  from the tile rather than a downscaled page. Structured source formats are read by **native
  parsers** rather than rendered and guessed: DOCX heading levels, XLSX worksheets as tables,
  BPMN as a `process` transcription, and VSDX shapes and connectors (DOCX and VSDX keep the
  LibreOffice → PDF render for the page image). PPTX has no native parser; it is converted to
  PDF by LibreOffice and follows the PDF path. An optional
  **finalize pass** corrects outline metadata at document end and re-embeds only the units whose
  heading path changed.
- **Multi-level index with contextual embedding (Search).** From the blocks Search builds the
  units `chunk`, `table`, `figure`, `section`, `page`, and `document`, each with `section_path`,
  page range, a relationship graph (`parent`/`prev`/`next`/`figure_refs`), and filterable
  columns. The embedding input carries a **contextual header** (title, section path, pages,
  type, page summary, capped at 15 % of the chunk budget), which fixes the single largest v1
  quality defect. Lexical search keeps a German-stemmed vector and a separate identifier vector,
  and query identifiers add a **third RRF list** so exact codes rank correctly.
- **Retrieval pipeline (Search).** Query analysis → hybrid candidates → **rerank with context**
  (title, path, type, content, ≤ 1024 tokens) → diversification (per-section cap, table/figure
  collapse) → **small-to-big expansion** (`neighbors`/`section`/`page` within a char budget) →
  asset attach. `/v2/search` returns hits with `section_path`, `pages`, `expanded`,
  `assets[]`, `navigation`, and `evidence`; on-demand rendering (`/v2/render`) serves region
  and full-resolution zoom, cached as an asset variant.
- **Runtime and flows.** The **RAG node v2** (`ragProfiles` with `expand`, `granularity`,
  `include_assets`, and `assets: { attach, maxImages, variant }`) attaches image parts only when
  the responder confirms `visionInput`, and its evidence line and citations carry page and
  figure. **`inspect_image`** resolves `asset:<id>[#bbox]` references through MCP `get_asset`,
  parks the bytes as a run-scoped `img-N`, and evaluates them with the configured vision
  sub-LLM, fail-closed. Research flows are wired with the MCP navigation tools (`get_outline`,
  `get_section`, `get_pages`, `list_figures`, `get_asset`, `get_table`, `find_identifier`,
  `follow_ref`, …) and a research routine.
- **Scale and fairness.** Jobs over `LARGE_JOB_PAGE_THRESHOLD` pages run in a bounded large-job
  lane (`LARGE_JOB_MAX_CONCURRENCY`), and `PAGE_CONCURRENCY` is tuned against the vLLM batch
  capacity (see [DEPLOYMENT.md](DEPLOYMENT.md)).

The upgrade path is described in
[docs/document-intelligence-v2-migration.md](docs/document-intelligence-v2-migration.md); the
v2 retrieval tuning knobs are listed in
[docs/operations-and-retrieval.md](docs/operations-and-retrieval.md).

## State

**PostgreSQL**, when configured, is the durable store. Runtime uses it for the cost ledger,
audit log, jobs, approvals, tenants, and checkpoints; Search requires PostgreSQL/pgvector for
documents, chunks, revisions, staged batches, index units, and assets; Extract uses its own
`extract` schema (`EXTRACT_DATABASE_URL`) for v2 jobs, per-unit stage checkpoints, upload
sessions, and the emit/asset outbox. Runtime's tenant isolation combines application query
scoping with optional database row-level security. Enforced RLS requires the guided
`rls-setup --confirm` onboarding, `TENANT_RLS_ENABLED=true`, a least-privilege application
connection, and a separate `DATABASE_OPERATOR_URL` for privileged cross-tenant work.

**Redis** is optional and used only for coordination that must span replicas: pending
approvals, distributed rate limits, cluster-wide budgets, and Gate's transport session state.
Absent Redis, each feature degrades to per-replica scope with a documented trade-off rather
than blocking. Multi-replica deployments that rely on any of those behaviors need it.

## Toolchain

Bun 1.4.0 is the repository toolchain, the task runner, and the runtime for Bun-native
services. Node.js 26 is the single supported Node major and the runtime for Node-backed
artifacts. TypeScript 7.0.2 is pinned as a workspace dependency. There is no separate build
orchestrator; Bun workspaces and `--filter` provide it.

## Design rules

These are enforced in review and, where possible, in tests:

1. **Contracts over shared code.** Cross-service messages live in a contract package. An
   application never imports another application's source.
2. **Fail-closed boundaries are explicit.** Authentication, authorization, approvals, and
   configured policy checks deny on the failure modes documented for them. Exceptions are also
   explicit: no/invalid compliance-policy file disables that policy, PII detector failures
   default to open unless configured otherwise, and optional state can degrade to per-replica
   behavior. A path must not be called fail-closed without its configuration and fallback being
   stated.
3. **Configuration is validated at startup.** Runtime parses the environment declared in its
   Zod `EnvSchema` and exits with the full list of problems rather than failing at first use.
   Provider references are resolved and checked at boot. A few subsystems that accept an
   injectable environment record — the agent transaction fabric, the Rocket.Chat connect flow —
   read their own names outside the schema and validate at the point of use instead;
   [docs/CONFIGURATION.md](docs/CONFIGURATION.md) marks those explicitly. New variables belong
   in the schema.
4. **Declarative over inferred.** Data classes, approval requirements, and tool authorization
   are declared, not guessed from request content, because a misclassification would either
   leak or block real traffic.
5. **Degradation is designed.** Every optional dependency has a defined fallback and a stated
   trade-off; see ADR 0002.
6. **Evidence is verifiable when enabled.** Configured audit entries are hash-chained and
   configured evidence bundles are signed, so those records can be checked rather than merely
   trusted. Enabling the mechanisms does not by itself establish regulatory compliance.

## Further reading

- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) — what each subsystem does
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every environment variable
- [docs/adr/](docs/adr/) — the decisions behind the rules above, with their trade-offs
- [DEPLOYMENT.md](DEPLOYMENT.md) — production requirements
- [DEVELOPMENT.md](DEVELOPMENT.md) — working in this repository
