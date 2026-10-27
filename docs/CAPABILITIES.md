# Capabilities

A functional reference for what ATF does. This document describes implemented behavior and
the configuration that governs it. It is not a deployment contract: every capability below
still depends on the operator enabling and verifying it. See
[DEPLOYMENT.md](../DEPLOYMENT.md) for the production requirements and
[CONFIGURATION.md](CONFIGURATION.md) for the variables referenced here.

## Contents

- [Orchestration and model access](#orchestration-and-model-access)
- [Document extraction](#document-extraction)
- [Outpost (local ingestion)](#outpost-local-ingestion)
- [Retrieval](#retrieval)
- [Governed tool and data access](#governed-tool-and-data-access)
- [Guardrails and safety](#guardrails-and-safety)
- [Human-in-the-loop approvals](#human-in-the-loop-approvals)
- [Privacy and the PII vault](#privacy-and-the-pii-vault)
- [Compliance and evidence](#compliance-and-evidence)
- [Citation impact (experimental)](#citation-impact-experimental)
- [Quality: evaluation, canary, shadow, replay](#quality-evaluation-canary-shadow-replay)
- [Cost and reliability control](#cost-and-reliability-control)
- [Multi-tenancy and identity](#multi-tenancy-and-identity)
- [Channels](#channels)
- [Observability](#observability)
- [Operator interface](#operator-interface)

---

## Orchestration and model access

Runtime executes AI workflows defined as declarative graphs and exposes OpenAI-compatible
endpoints for chat completions, Responses, model listing, and embeddings. Compatibility is
limited to the documented routes and fields; clients that rely on other OpenAI API surfaces may
need adaptation.

- **Flows as files.** Workflows are YAML documents validated against
  `apps/runtime/schemas/flow.schema.json` and loaded from `FLOWS_DIR`. Changes are picked up
  without a restart, so a flow is versionable and reviewable like source code. The Studio can
  write a flow back into its own file (operators with `flows:write`, only when `FLOWS_DIR` is
  writable — mount it read-only to disable this). Writes keep the authoring form: model
  shortcuts, `{{vars.*}}` references, prompt includes, sub-flow files and comments stay as
  they are, and a value-only edit changes just those lines. Every field, node type setting and
  expression is listed in the generated [FLOWS.md](FLOWS.md).
- **Flow variables.** `variables` values can reference other variables (`{{vars.x}}`),
  global constants from `FLOWS_DIR/constants.yaml` (`constants: { name: value }`, used as
  `{{const.name}}`), environment values whose name starts with `FLOW_PUBLIC_`
  (`{{env.FLOW_PUBLIC_REGION}}`; no other env is ever exposed to flows), and calculations
  (`{{= round(vars.max_tokens / 2) }}`: arithmetic, comparisons, `a ? b : c` and a fixed set of
  functions, no code execution). The same references work in any node or edge value. They are
  evaluated when the flow loads, in dependency order; cycles, unknown constants and calculation
  errors are validation errors. Variables supplied with a request are literals and are never
  evaluated.
- **Node types.** Twelve built-ins: `llm` (streaming call with an optional agent tool loop),
  `tool` (deterministic MCP calls), `router` (edge evaluation without a model), `classifier`
  (structured JSON output that routing conditions can read), `parallel` (conditional
  fan-out and merge), `retrieval` (embed, fetch top-K, inject as grounding context and
  citations), `memory` (recall long-term memories for the user or tenant scope),
  `agent-harness` (plans tasks with a model, then delegates each to allowlisted worker nodes
  or subflows; in plannerless coverage queues, optional
  `config.coverageQueue.targets.{summary,discovery,original}` entries route each assignment
  mode to a specific allowlisted worker, while omitted modes use the first valid allowlist
  target), `transform` (derives extra `classification` fields from existing ones via
  lookup tables in the YAML, with no model call), `trigger` (declarative boundary marker for
  webhook- or schedule-started flows; a no-op at execution time), `assistant-context`
  (resolves the per-user assistant and injects its identity, skill index and credential state
  before the answering `llm` node), and `assistant-learn` (terminal bookkeeping node that
  records the turn, settles skill canaries, and never fails the turn). Any other node type
  string is resolved through the plugin node-handler registry.
- **Conditional edges.** Edges carry conditions evaluated by a safe expression evaluator
  against run state and classification output, so branching needs no embedded code.
- **Provider abstraction.** Named inference endpoints are declared once in `PROVIDERS`; every
  model setting references a provider instance by `name`, never a protocol. Supported
  protocols cover OpenAI-compatible endpoints, Google, Anthropic, Azure OpenAI, AWS Bedrock,
  and local servers such as Ollama or LM Studio. Provider references are validated at
  startup, not at first use.
- **Streaming and multimodality.** Token streaming over SSE, image and file inputs, and vision
  models. Image generation is available only when an `llm` node declares a `config.mediaTools`
  generation tool (or a configured provider returns native generated media); generated files
  are served through Runtime's transient media route. There is no standalone `/images` API.
  A text-only `llm` node can additionally declare `config.imageInspection`: inline images are
  then parked in a run-scoped, byte-owned reference registry and replaced by short `img-N`
  references. A minimal configuration is:

  ```yaml
  config:
    imageInspection:
      llm:
        provider: private-vision
        model: vision-model
        parameters: { visionInput: true, maxTokens: 2048 }
      maxAnswerChars: 4000
  ```

  The registry requires Runtime's in-process media store but does not require `MEDIA_BASE_URL`,
  because inspection bytes are never served publicly. It keeps active bytes independently of the
  transient publication store, bounded to 32 references, 128 MiB per run and 25 MiB per image;
  the oldest references are evicted when a bound is crossed. Empty, oversized, malformed-base64,
  remote or otherwise undecodable images fail closed instead of reaching the text-only host.
  The inspection model must declare vision input support (or be explicitly attested with
  `parameters.visionInput: true`). The node receives an `inspect_image` tool — renamed with a
  suffix if necessary to avoid any configured or caller-tool collision — that asks the vision
  model about one live reference on demand. Its answer, not the pixels, enters the hosting
  model's context. Each inspection is a separate provider call with separately attributed usage,
  cost, metrics and synthetic tool-node trace data; provider failures are returned as bounded
  tool results and recorded as errors. Same-loop tool-result images are offloaded before each
  subsequent provider step, so their bytes are not repeatedly sent to the hosting provider.
  The reverse direction is `config.figureEmbedding`: the node receives a `show_figure` tool
  that takes an `asset:<id>[#bbox]` reference (or a bare asset id) from its own search results,
  fetches the bytes through the MCP `get_asset` tool with the caller's ACL (fail-closed),
  publishes them in the transient media store and returns a markdown image link the model
  pastes into its answer. The bytes never enter the model context, and there is no inline
  data-URI fallback. The tool is exposed only when the deployment sets
  `EMBED_SEARCH_FIGURES=true` and `MEDIA_BASE_URL`, and the node declares an `assetSource`;
  otherwise the node logs a `figure_embedding_unavailable` diagnostic. The media link is a
  capability URL: anyone who knows it can fetch the figure until the media store TTL expires,
  so enable it only where that is acceptable and prefer the `thumb` or `preview` variant.
  Reasoning output from thinking models is surfaced separately from the answer.
- **Agentic tool use.** A flow step can let the model select and call tools over MCP, then
  incorporate the results. `MAX_TOOL_STEPS` bounds the loop.
- **Flow as MCP server.** A flow can itself be exposed as an MCP tool, which lets one ATF
  deployment compose another.
- **Triggers.** A flow can start from an HMAC-signed webhook or on a schedule, not only from
  a chat request. `TRIGGERS_REQUIRE_SIGNATURE` controls signature enforcement.
- **Asynchronous jobs.** Long runs execute in the background and are polled by job id, with
  optional lease-based recovery after a replica restart.
- **Flow load failures are visible.** `/health/ready` carries an informational `flow_load`
  check (`degraded` with only the number of failed files in `flow_load_failures`; never a 503;
  file names and reasons are in the flow load log, not in the unauthenticated probe) and the gauge
  `aiperator_flow_load_failures` follows the same ledger. In the production profile a flow
  whose node `config` contains a key the node type does not read is not loaded at all;
  elsewhere the load logs a warning. `cli.ts validate` and `POST /flows/validate` report
  unknown config keys with a "did you mean" suggestion (`x-`-prefixed keys are author
  annotations and never reported).
- **Shadowed flows are reported.** An online (published) flow still overrides a same-id file
  flow, but not silently: startup warns about every shadowed file flow, `GET /flows/:id`
  reports `shadowsFile` plus the file baseline, publish and rollback record it, and a GitOps
  webhook push without runtime effect returns `shadowedFlows`.
- **Wildcard tool arguments.** `config.toolArgs` accepts `"*"` and `"<server>/*"` keys;
  wildcard arguments apply to every tool that declares them, exact references still win.
- **Harness coverage lanes and progress.** The plannerless agent harness can work several
  coverage assignments concurrently (`coverageQueue.lanes`, 1–8, merged in assignment order)
  and emits structured progress — phase, tasks done/total, coverage, elapsed time and ETA —
  as the SSE event `atf.progress`, in the debug trace, and in `GET /v1/jobs/{id}`.

## Document extraction

Extract converts documents into the canonical Markdown defined by `packages/extract-contract`,
which is the form Search indexes. It is an optional service: retrieval works without it for
callers that already hold Markdown.

- **Formats.** PDF, DOC, DOCX, XLS, XLSX, PPTX, VSDX, HTML, PNG, JPEG, GIF, TIFF, BMP and WebP,
  plus BPMN 2.0 XML and e-mail (EML, MSG, mbox) on the v2 job path. Office documents and HTML are
  laid out by LibreOffice first, so the rendered formats funnel through one PDF page loop and page
  numbers, page images and text offsets agree across them; BPMN, e-mail and a chart-free XLSX are
  parsed natively (no render, no model call). The v2 path delivers its result to Search as NDJSON
  batches.
- **Structure preserved.** `## Seite N` page markers, `<figure>` entries with normalised
  geometry, per-page `<summary>` blocks, and HTML tables that keep merged cells.
- **Text layer plus vision.** Each page is rendered at `RENDER_DPI` and sent to a vision model
  together with its extracted text layer. The text layer is authoritative for wording, the
  rendered page for structure.
- **Figure crops.** Cut from a separately rendered `FIGURE_DPI` page, so what an operator sees
  in a search result is sharper than the model's input.
- **Two retry axes.** Transport failures retry in place; a truncated completion escalates
  through the `VISION_MAX_TOKEN_VARIANTS` budget ladder and is counted separately in
  `extract_vision_truncations_total`. A page that cannot be completed becomes an empty page
  carrying a warning rather than failing the document.
- **Response modes selected by header.** Async callback (`X-Callback-URL`), streamed pages
  (`Accept: text/event-stream`), plain Markdown (`Accept: text/markdown`), or the default JSON
  envelope carrying figure geometry, warnings, token usage and timing telemetry. SSE reports
  `accepted`, queue/conversion progress, heartbeat, error and completion events in reading order.
  `X-Callback-Events` opts into equivalent serialized, best-effort progress POSTs without retries;
  terminal callbacks retain their configured retry budget.
- **Two Search paths.** `POST /v1/ingest` here converts and indexes including figure crops and
  requires `SEARCH_URL`; `POST /ingest-file` in Search proxies the upload and requires
  `CONVERTER_URL`, indexing figure descriptions but not the images
  (`X-Figure-Assets: not-stored`).
- **Bounded work.** `MAX_PAGES` (default 500), `MAX_UPLOAD_BYTES`, a decoded-pixel ceiling for
  images, `CONVERT_CONCURRENCY`, `PAGE_CONCURRENCY`, a queue that answers 503 with `Retry-After`
  past `QUEUE_MAX_DEPTH`, a per-tenant daily vision-page budget (`VISION_BUDGET_PAGES_PER_DAY`,
  `BUDGET_EXCEEDED`), and large uploads spooled to disk instead of the heap.
- **Page windows.** `pages` on a v2 job selects a window of the source (`"5"`, `"3-10"`,
  `"5-"`, `"-8"`; lists and reversed windows are a 400). Pages keep the source's numbering,
  `MAX_PAGES` counts the window, and Search spans the document unit over it; a native source
  (BPMN, a chart-free XLSX) ignores `pages`.
- **Job lanes.** A worker can run several jobs in parallel via `JOB_CONCURRENCY` (default 1 —
  sequential, range 1–32); the page scheduler refills a freed `PAGE_CONCURRENCY` slot as soon
  as a page settles instead of advancing in lockstep batches.
- **Derived-PDF cache.** Derived PDFs are reused across runs under `TEMP_DIR/derived-pdf`
  (`DERIVED_PDF_CACHE`, default on): a LibreOffice conversion is published once under a key of
  the source hash plus converter identity and hard-linked in on later runs, so retries and
  re-ingestion of an unchanged document skip the conversion. The cache is bounded by
  `DERIVED_PDF_CACHE_MAX_MB` and `DERIVED_PDF_CACHE_MAX_AGE_HOURS`.
- **Retention of derived data.** `JOB_RETENTION_DAYS` (default `0` = keep) sweeps finished
  jobs, `UPLOAD_SESSION_MAX_AGE_HOURS` (default 72) sweeps abandoned resumable uploads, and
  the sweep runs at start and hourly; sources are deliberately not swept by age because
  `/v2/render` renders zoom and tiles from them.
- **Hostile-document hardening.** ZIP containers are checked against `ZIP_MAX_*` before they
  are unpacked (`DOCUMENT_TOO_COMPLEX`), XML entity expansion is off, native parsers run in a
  heap-limited Worker thread, LibreOffice starts with macros and linked-content updates
  disabled, converter calls carry `prlimit` CPU and memory ceilings on Linux, and
  `CONVERTER_MODE=isolated` moves poppler, LibreOffice and Tesseract into a separate
  converter process. An optional Tesseract fallback (`OCR_FALLBACK`) keeps scanned pages
  searchable while the vision model is down.
- **Upload and callback hardening.** Uploads are type-sniffed rather than trusted, filenames
  never reach a process argument, converter subprocesses run without credentials in their
  environment, and callback targets refuse link-local and cloud metadata addresses
  unconditionally. `CALLBACK_ALLOWED_HOSTS` closes the remaining SSRF surface and the production
  readiness gate flags an empty value.
- **Split credentials.** `/v1/*` accepts machine credentials only, `/ui/*` the session cookie
  only. The ingest ACL headers can only narrow the caller's own identity.
- **Degradation is reported, not hidden.** Without LibreOffice the service stays healthy and
  reports `degraded_formats`; without poppler it reports unhealthy.

## Outpost (local ingestion)

The Outpost brings documents to Extract from places a server cannot reach: a local folder
on a workstation or file server, an S3 bucket, a Google Drive share, a Dropbox folder. It
runs **locally** — the cloud never gets pull access to the source; the Outpost pushes.

- **One engine, two runtimes.** The sync logic lives in
  [`packages/outpost-core`](../packages/outpost-core) and is shared verbatim by the Docker
  runtime ([`apps/outpost`](../apps/outpost)) and the desktop application
  ([`apps/outpost-desktop`](../apps/outpost-desktop)); a safety rule fixed once applies to both.
- **Mirror with a brake.** With `mirrorDelete: true`, deletions propagate to the Extract
  collection; a large candidate set pauses until an operator confirms the exact candidate
  hash (`confirm-deletes`), so a mount glitch cannot mass-delete a collection.
- **Least privilege.** Cloud sources use read-only scopes; Extract auth needs only
  `extract.ingest` (plus `extract.delete` when mirroring deletes, and `extract.acl.assign`
  when sources carry an access list). Every secret supports a `_FILE` variant and the
  logger scrubs registered secrets.
- **SharePoint and OneDrive (experimental).** The `sharepoint` source reads a document library through
  Microsoft Graph with client credentials (secret or certificate from a file). It lists with
  the drive delta query, syncs files only and skips folders. With `aclFromPermissions` the
  item permissions become the document access list: users by e-mail or UPN, groups through
  `aclGroupMap`. Sharing links are never adopted, and an item without a mappable user or
  group is skipped (and removed if synced before) instead of being ingested tenant-wide.
- **Source access lists.** A source can carry a static `acl` (users and groups), and an
  adapter can supply one per item; the item list wins. Extract applies such a list as sent
  only to a token holding the scope `extract.acl.assign` and reports the outcome in the
  `X-ACL-Applied` response header. Outpost fails an item, and deletes the document again,
  when the list was not applied, so a missing scope never publishes a document tenant-wide.
- **Desktop credential isolation.** The desktop app keeps tokens in the OS keychain
  (`me.abillify.atf-outpost`), bridged to the sidecar over a token-handshake stdio protocol;
  the WebView never sees credentials, and the sidecar's control API binds to loopback only.
  The Tauri updater is currently disabled (see the desktop README and
  [THREAT-MODEL.md](THREAT-MODEL.md)).

## Retrieval

Search provides semantic and hybrid retrieval on PostgreSQL with pgvector, so no separate
vector database is required.

- **Hybrid search.** Dense vector similarity and full-text search fused with Reciprocal Rank
  Fusion (`RRF_K`, `HYBRID_SEARCH`).
- **Reranking.** A second, more precise ordering pass over the candidate set, available
  synchronously or streamed, with an optional fallback reranker.
- **Retrieval quality techniques.** HyDE, semantic chunking, late chunking, and contextual
  retrieval prefixes, each independently configurable.
- **Answer-ready retrieval.** `retrieve_for_answer` (MCP) and `POST /v2/retrieve` split a question
  into sub-questions by rule, search each, fuse the lists by reciprocal rank, remove duplicates,
  optionally rerank against the original question and pack the passages into a token budget
  (`budget_tokens`), with every passage labelled as untrusted data. With
  `decomposition: "llm"` (experimental) a configured model splits the question instead of
  the rules.
- **Optional sparse vectors.** SPLADE-style sparse retrieval as a third signal.
- **Collections and versioning.** Multiple collections with their own language configuration,
  document versioning, and score-keyset pagination that stays stable across pages.
- **Storage efficiency.** Vector quantization and half-precision storage reduce index size.
- **Embedding drift protection.** `EMBED_MODEL_REVISION` and `EMBED_EXPECTED_DIMENSION` make
  an unsafe in-place embedding model change fail fast rather than silently degrade relevance.
- **Bounded query cost.** `SEARCH_MAX_QUERY_CHARS` (default 400) cuts longer queries at the
  last space (reported as `query_truncated`), and the lexical OR list uses at most 32 terms
  (longest first). The lexical list ranks chunks containing all query terms first, then by
  score.
- **Bounded document groups.** `group_by_document` keeps at most
  `SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT` (default 8) best-scoring chunks per document and
  marks the result `truncated` with `omitted_chunks`, so one document cannot turn the whole
  candidate pool into context.
- **Capability-gated navigation.** `collection_stats` reports which retrieval features a
  collection supports (`unitRows`, `unitGraph`, `outline`, `pages`), and Runtime hides the
  Search navigation tools a pinned collection cannot serve (cached,
  `COLLECTION_CAPABILITY_TTL_MS`, fail-open).
- **Traceability across time.** `trace` follows an identifier across two points in time
  (added/removed/changed occurrences by document and section), and `document_diff` (MCP and
  `GET /v2/documents/{base_ref}/diff`) compares a document's units between two points in
  time, aligned by section, unit id, then reading order.
- **Access control.** Retrieval is scoped by verified identity and group membership; the
  verified identity is authoritative and is never taken from a client-supplied field.

## Governed tool and data access

Gate is an MCP gateway that turns declarative configuration into governed tools.

- **Tools from configuration.** A YAML description becomes a validated MCP tool. No code is
  required to expose a query or an action.
- **Database coverage.** Knex supports PostgreSQL, MySQL, SQLite, SQL Server, and Oracle
  configurations. This repository installs and validates `pg` and `mysql2`; deployments using
  SQLite, SQL Server, or Oracle must supply a Knex-compatible driver (`sqlite3` or
  `better-sqlite3`, `tedious`, or `oracledb`) in the built artifact and verify it themselves.
  Gate also supports HTTP, MCP proxy, webhook, MQTT, and composite tool types.
- **Parameter binding only.** User input is always bound as a parameter and never
  interpolated into SQL.
- **Identity-aware queries.** The verified caller identity flows into the query, so a tool
  returns only the rows that caller may see.
- **Scope-based conditional behavior.** A tool can expose different fields or different
  statements depending on the caller's scopes.
- **Optional language router.** Natural-language tool selection, separated into read
  (`ask`) and write (`act`) paths so a read intent can never reach a mutating tool.
- **Two MCP transports.** The current streamable transport and the legacy SSE transport, with
  live session monitoring.
- **Monitor tenant scope.** The monitor stream filters events by the OIDC session's tenant
  (`monitoring.tenantScope`, default `session`) and replaces tool results with a SHA-256
  digest and size unless `monitoring.includeToolContent` is true; dashboard logins can be
  restricted to id_token `groups` members (`monitoring.oidc.requiredGroups`).

## Guardrails and safety

- **Input guardrails.** Pattern and model-based detection of prompt injection and jailbreak
  attempts before the request reaches the graph (`INPUT_GUARDRAILS_ENABLED`,
  `INPUT_GUARDRAIL_MODE`, `INPUT_GUARDRAIL_THRESHOLD`).
- **Output guardrails.** Response filtering and PII redaction on the way out
  (`OUTPUT_GUARDRAILS_ENABLED`, `GUARDRAIL_MODE`, `GUARDRAIL_REDACT_PII`).
- **Tool egress control.** Outbound tool traffic is checked against an egress policy, which
  is how data-loss prevention is applied to tool calls (`TOOL_EGRESS_GUARDRAIL`,
  `TOOL_EGRESS_MODE`). This does not intercept direct model-provider calls made by
  `config.imageInspection`; its vision provider must independently satisfy model allowlisting,
  residency and privacy requirements.
- **Tool output validation.** Data returned *by* a tool, and the chunks a `retrieval` node puts
  into the prompt, are inspected for injected instructions before they reach the model. This
  closes the indirect prompt injection path that output-only filtering misses. On by default in
  production (`TOOL_OUTPUT_VALIDATOR_ENABLED`, unset = on in the production profile
  (`ATF_PROFILE=production`, or `APP_ENV=production`)); a finding
  is neutralised (`TOOL_OUTPUT_VALIDATOR_MODE=redact`) and recorded on the consuming node's trace
  as `indirect_prompt_injection` and in `aiperator_indirect_injection_total`.
  Retrieved chunks reach the model as a delimited untrusted-data block (`RETRIEVAL_CONTEXT_MODE`,
  unset = `spotlight` in production), and after a finding any tool not declared `readOnlyHint`
  needs human approval for the rest of the run (`TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`, unset = on
  in production; recorded as `tainted_write_tool_approval`). Search results carry
  `content_trust: untrusted` and an `injection_risk` hint.
- **Content trust across services.** The taint signal survives the hop between services:
  Search labels every document-read response (per item and envelope, worst hit wins), the
  Runtime parses the labels into retrieved chunks and taints the execution on a `suspected`
  label, and the Gate marks executed tool results untrusted via MCP
  `_meta["io.atf/content-trust"]`. With `TAINT_MODE=on-untrusted-source` (default
  `on-finding`) the result of any MCP server not marked `contentTrust: trusted` taints the
  execution, so internal curated servers must be labelled explicitly.
- **AI disclosure.** `AI_DISCLOSURE=header|field` (default `off`) marks successful
  completions as AI-generated: `X-AI-Generated: true` on `/v1/chat/completions` and
  `/v1/responses`, or `metadata.ai_generated: "true"` in a JSON body (a stream carries the
  header).
- **Declarative tool authorization.** Which principal may invoke which tool is policy, not
  code, and it fails closed by default (`TOOL_AUTHZ_FAIL_CLOSED`).
- **Groundedness checking.** Answers are scored against the retrieved sources, semantically
  or by judge model, to detect claims the sources do not support
  (`GROUNDEDNESS_ENABLED`, `GROUNDEDNESS_MODE`, `GROUNDEDNESS_PASS_THRESHOLD`).
- **Continuous red teaming.** A scheduled attack suite probes configured flows, scores the
  results with a judge model, and tracks a security posture value over time
  (`RED_TEAM_ENABLED`, `RED_TEAM_INTERVAL_MS`).
- **Plugin sandbox.** Third-party plugins run behind a trust boundary with an allowlist and
  an execution timeout (`PLUGINS_SANDBOX`, `PLUGINS_ALLOWLIST`).
- **Code sandbox.** Generated or tool-provided code executes in a resource-bounded container
  with network access off by default (`SANDBOX_ENABLED`, `SANDBOX_NETWORK_ENABLED`).

## Human-in-the-loop approvals

Consequential actions can require a human decision before they execute.

- **Configurable scope.** Approval requirements are set per flow step or globally, with
  wildcard patterns such as every write tool of a given system
  (`APPROVAL_GATE_ENABLED`, `APPROVAL_REQUIRE_TOOLS`).
- **Pause instead of execute.** When the model wants a tool that requires approval, execution
  pauses and reports a pending approval with the tool name, the tenant, and the planned
  arguments. Credentials are never included in that payload.
- **Two decision surfaces.** An embedded approve/reject element in the chat response for
  compatible frontends, and a reviewer inbox in Control protected by RBAC.
- **Fail closed.** If nobody decides within `APPROVAL_TIMEOUT_MS` the request is rejected.
  Silence never results in an action.
- **Cluster-wide visibility.** With Redis configured, pending approvals are visible across
  replicas so any reviewer can decide. If Redis is unavailable the system degrades to
  per-replica scope rather than blocking. The Gate's 2026 endpoint keeps its pending
  approvals in Redis too, so request and resolve may hit different replicas.
- **Approver separation.** The resolver of an approval comes from the verified identity,
  never from a client-supplied label. `policies.approval.requireDifferentApprover` (default
  `off`) makes self-resolution a 403 without consuming the request: the resolver must be a
  different principal of the same tenant holding `policies.approval.approverScope`. The
  Gate's 2026 endpoint adds `approvals/list` (own requests, or the tenant's for scope
  holders) and `approvals/get` (status and, once approved, the one-shot token for the
  requester).
- **Audited.** Every decision, including timeouts, is written to the audit log and counted as
  a metric.

## Privacy and the PII vault

When enabled, the PII vault replaces values detected by its configured detectors with
meaningless placeholders before a model-provider call and restores mapped values in the
response. This is a conditional control, not a system-wide default: `PII_VAULT_ENABLED` is off
unless configured, detector failures default to `open`, and multimodal handling defaults to
`off`. Deployments that require a no-plaintext-egress guarantee must select the detector set,
use `PII_DETECTOR_FAIL_MODE=closed`, choose an explicit multimodal policy, and verify coverage
for their data. Only the request-scoped mapping is stored, encrypted, for restoration.

- **Structured detection.** Pattern and checksum detection for email addresses, phone
  numbers, IBANs, tax identifiers, and similar formats.
- **Unstructured detection.** An in-process NER model covers person names, locations, and
  organizations. An external detection service can be added
  (`PII_DETECTORS`, `PII_NER_MODEL`, `PII_REMOTE_ENDPOINT`).
- **Multimodal.** Images can be routed through a describe-and-detect path before they are
  forwarded (`PII_VAULT_MULTIMODAL_MODE`). With the default multimodal mode `off`, an
  `inspect_image` call sends the original image bytes to its configured vision provider; its
  textual answer then enters the hosting model context. Deployments requiring no-plaintext
  image egress must choose and fail-closed-test an explicit multimodal policy for this path.
- **Per-flow configuration.** Which detectors run and which types a flow tokenizes is set per
  flow, not only globally (`PII_VAULT_TYPES`, `PII_DETECTOR_FAIL_MODE`).
- **Reversible by design.** For values a configured detector successfully identifies, this is
  stronger than output-only redaction because those detected values are replaced before the
  provider call. It is not a blanket guarantee for undetected types, detector failures, or
  unconfigured multimodal inputs.

## Compliance and evidence

- **Policy as code, with an explicit activation boundary.** A valid
  `compliance-policy.yaml` in `FLOWS_DIR` can declare model allow/block rules, provider/data
  rules, approval requirements, retention, and audit rules. A missing file means no policy.
  An unreadable or schema-invalid file does not: a hot reload keeps the last valid policy, and
  at startup with no valid policy chat and engine admission answer 503 until the file is fixed
  (`GET /admin/compliance-policy` reports `loadError`, `stale` or `blocked`). There is no
  mandatory-policy mode yet, so a deleted file still disables the policy; `failClosed`
  controls exceptions during evaluation, not loading. Start from
  [`deploy/examples/flows/compliance-policy.example.yaml`](../deploy/examples/flows/compliance-policy.example.yaml).
- **Enforcement points and limits.** Model/data admission is applied by the centralized
  execution-admission path and chat preflight before graph execution; tool approval rules are
  checked when configured `llm` and deterministic `tool` nodes invoke a tool. Approval rules
  require the human approval gate to be enabled. A provider outside an allowlist or a known
  disallowed region blocks; a required but unknown provider region is advisory rather than
  blocking, so operators must supply region metadata when residency is a hard requirement.
- **Explicit data classes.** A flow declares the data classes it processes. Classification is
  deliberately declarative rather than inferred from request text. Missing or incorrect
  declarations prevent the corresponding data rule from matching, so flow review remains part
  of the control.
- **Tamper-evident audit log.** Audit entries are hash-chained and periodically anchored, so
  later modification is detectable (`AUDIT_ANCHOR_SECRET`, `AUDIT_ANCHOR_INTERVAL_MS`).
- **Retention and erasure.** Configurable retention sweeps and targeted erasure support
  right-to-be-forgotten requests (`RETENTION_ENABLED`, `RETENTION_MAX_AGE_DAYS`). Targets:
  `replay_snapshots`, `pii_vault`, `conversation_checkpoints`, `assistant_data`,
  `assistant_workspaces`, `cost_ledger`, `analysis_artifacts`, `rocketchat_connect_requests`,
  `autopilot_runs` (age purge only), `execution_history` (with the usage log) and
  `long_term_memory`; `RETENTION_MAX_AGE_DAYS` takes these names as keys. A store that holds
  personal data but cannot be erased automatically (in-memory checkpoint and assistant stores
  without `DATABASE_URL`, or a semantic cache on a vector store that cannot delete entries) is
  listed with its gap in `GET /v1/me/data` and the compliance dossier, and makes every erasure
  report `partial` rather than `complete`. The
  audit log and `erasure_requests` are retained as accountability records.
- **Decision receipts.** With `DECISION_RECEIPTS_ENABLED` and `RECEIPT_SIGNING_KEY`, each chat
  completion and tool call yields a signed COSE_Sign1 receipt (`GET /v1/receipts/:id`), appended
  to a transparency log (`receipt_log`); the public key is served at
  `/.well-known/atf-receipt-jwks.json`. Rotation notes: `runbooks/key-rotation.md`.
- **Flow identity in traces.** Debug traces carry `flow_version`, `flow_digest` (a hash of the
  executed flow with includes expanded) and `subflow_versions[]`; CI fails a flow change without
  a `metadata.version` bump (`check:flow-versions`).
- **Verifiable evidence bundles.** A signed bundle ties an execution to its inputs, policy
  decisions, sources, and outputs. `EVIDENCE_SIGNING_KEY` (Ed25519, preferred) makes the
  platform sign audit chain anchors, evidence bundles and — as a fallback — erasure receipts
  with one asymmetric identity; its public key is published at
  `GET /.well-known/atf-evidence-jwks.json` (OKP/Ed25519, never the private part), so an
  auditor verifies an artefact offline with no shared secret and no dependency on the
  platform being reachable. `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks
  <url|file>` verifies Ed25519 bundles; the legacy HMAC path (`EVIDENCE_BUNDLE_SECRET`,
  verified with `--secret`) still works but is deprecated in favour of Ed25519. Signed
  envelopes carry an `alg`/`algorithm` field and verification branches on it strictly —
  never a silent fallback between algorithms.
- **Compliance dossier.** A single generated document collects the active policy, the audit
  chain verification result, executed erasures, retention windows, evaluation results, and
  the red-team posture score, with references to the architecture decisions behind them.
- **Decision provenance.** An explainability card reconstructs why a given answer was
  produced: which model, which sources, which policy decisions, which routing choice.

## Citation impact (experimental)

- **Answer citation index.** With `CITATION_INDEX_ENABLED=true` and a PostgreSQL
  connection, the Runtime records the chunks each answer cited in the
  `answer_citations` table: tenant, user, execution, flow, document reference
  (`base_ref`), chunk id, revision and citation position. Opt-in, written
  fire-and-forget, and the rows hold no answer text — only the references.
  Retention sweeps and subject erasure cover the table (`RETENTION_ENABLED`).
- **Change detection in Search.** `POST /v2/citations/check` compares cited chunks
  against the revision visible today and reports `current`, `carried` (content
  unchanged in the current revision, compared in the database with whitespace collapsed),
  `changed`, `removed` or `unknown` per pair, in input order (up to 500 pairs). The
  reserved status `unverified` (a comparison that could not be completed) is counted
  but does not make an execution count as affected; it is currently not produced. The Runtime calls it through
  `CITATION_CHECK_URL` / `CITATION_CHECK_TOKEN`.
- **Impact report.** `GET /monitoring/citation-impact?since=<RFC 3339>` (operator
  plane, `monitoring:read`) groups the cited pairs of recent executions, checks them
  in blocks of up to 500 and lists the executions whose sources changed or
  disappeared, with a per-status summary. A request without `tenant_id` covers all
  tenants and requires an admin actor. With an evidence key (`EVIDENCE_SIGNING_KEY`)
  the report is signed (Ed25519) and verifiable offline with
  `atf-verify --citation-impact <file> --jwks <url|file>`.
- **Automation.** `bun run scripts/cli.ts citations impact [--since 90d] [--base-ref
  <ref>] [--out <file>] [--json]` prints or exports the same report and exits with
  code 2 when executions are affected, so a cron job can raise an alarm. See the
  [citation impact runbook](runbooks/citation-impact.md).

## Quality: evaluation, canary, shadow, replay

- **Evaluation runs.** Datasets, automated judge scoring, and matrix runs across model and
  prompt variants, suitable for use as a regression gate in CI. Eval cases can be collected from
  Studio test runs, each with a reference answer, and removed again (`DELETE /eval/cases/:id`).
- **Structured eval assertions.** Eval cases and matrix tasks accept `contains`, `regex`,
  `jsonPath` (restricted `$.a.b[0]` syntax), `toolCalled` (min/max, `server/tool` or bare
  name), `maxTokens`, `finishReason` (`equals`/`notEquals`) and `noDiagnostic` (e.g.
  `loop_blocked`, which checks the execution trace); a cell passes when its reference score
  and every assertion do.
- **Evidence-bound flow releases.** `bun run scripts/cli.ts flows release` (in `apps/runtime`) gates a flow release on a versioned
  bench file (`flows/bench/<flowId>.bench.yaml`): recorded conversations with assertions,
  a required pass rate plus optional thresholds (p50 latency, p50 tokens, cascade escalation
  rate, budget stops, p95 wall time), a SemVer check against a
  base revision, and a baseline comparison that rejects pass-rate regressions. A passing gate
  can emit an Ed25519-signed release receipt (`atf.flow-release-receipt`) over the flow digest,
  bench digest and results, verifiable independently with
  `atf-verify --release-receipt <file> --jwks <url|file>`.
- **Bench cases from executions (experimental).** `bun run scripts/cli.ts bench capture` (in `apps/runtime`)
  turns recorded executions (`--execution <id>`, chosen in the Control history) into bench
  cases for `flows release`: the conversation, a `toolCalled` assertion per tool the
  execution called, its finish reason, and token/latency caps with headroom over what was
  observed. Inputs containing personal data abort the capture unless `--allow-raw` is given;
  the result is validated against the bench contract before it is written. Bench files are
  committed expectations like any other code under review.
- **Extract quality eval.** `bun run eval:extract-quality` scores Extract output against a
  golden set — character error rate, Heading-F1 (text and strict with level) and table TEDS
  (and TEDS-S) — with a gating mode (`--max-cer`, `--min-heading-f1`, `--min-teds`) and a
  documented format for an operator's own sets.
- **Canary promotion.** A flow variant serves a fraction of traffic and is promoted or rolled
  back against configured criteria.
- **Shadow mode.** A sample of production requests (5 % unless an entry in `shadow.yaml` sets
  `samplingRate`, `1` mirrors all traffic) additionally runs against a candidate flow. Both
  answers are judged, and results aggregate per flow pair. The user always receives the
  stable production answer, so a migration can be measured on real traffic without exposing
  anyone to a worse response.
- **Replay.** An earlier execution can be re-run and compared against its original result
  (`REPLAY_ENABLED`).
- **Side effects in shadow and replay runs.** Both re-runs are for comparison only and never
  repeat side effects: only MCP tools that declare `readOnlyHint` are called (any other tool
  call fails and the model sees the error), approval-gated tools are denied without asking a
  reviewer, and assistant nodes skip their transcript, memory and preference writes. A
  candidate flow whose answer depends on a write tool therefore scores lower in shadow mode
  than it would in production.
- **Self-optimizing loop.** The optimizer generates flow variants, evaluates them, and can
  promote a winner behind a canary gate, with cooldowns and a minimum score improvement
  (`OPTIMIZER_ENABLED`, `OPTIMIZER_SCHEDULE_*`). It optimizes flows that exist only as files in
  `FLOWS_DIR` as well; promoting a variant publishes an online version that then takes precedence
  over the file. A run whose baseline or whose every variant could not be scored ends in `error`
  naming the reason instead of reporting a result there is nothing behind.
- **Autopilot governance.** Automated promotion is bounded by a drift guard, a per-window
  promotion cap, and an optional approval requirement (`AUTOPILOT_*`).

## Cost and reliability control

- **Objective-driven routing.** A solver selects a model per request against a stated
  objective such as lowest cost at a required quality level, using observed quality with a
  configurable half-life (`ROUTER_QUALITY_HALF_LIFE_MS`).
- **Model cascade (experimental).** An `llm` node with `config.cascade` lets a cheap model answer first and
  regenerates the answer once with `cascade.escalateTo` when the evidence is weak: too few
  distinct `[n]` citations (`minCitations`, default 1), a failed `sourcesCheck`, a best
  grounding score below `maxTopScore`, or a length cut-off. The rules need no model; the first
  attempt's text is held back until the decision is made, so a dropped answer never reaches the
  client. The decision is in the debug trace (`cascade`), as the `cascade_escalated` diagnostic
  and in `aiperator_cascade_escalations_total`. Tool calls of the first attempt are not undone,
  so use it on answering nodes whose tools only read.
- **Fallback chains and failover.** `FALLBACK_LLM` and `FALLBACK_CHAIN` switch providers when
  one fails, with a circuit breaker per provider. An unreachable provider (connection refused or
  closed, DNS failure, 5xx/408) fails over to the next candidate at once. While another candidate
  remains, the provider SDK's own retries are disabled so a dead endpoint costs one attempt; the
  last candidate keeps them. The raw provider error is recorded as the `llm_provider_error_detail`
  trace diagnostic, never in the model stream. A step prompt rejected by AI SDK message
  validation is reported separately as `llm_prompt_schema_invalid` with message index, role,
  and schema path but no prompt content, and an MCP error result records its bounded raw cause
  as `tool_result_error`. A deterministic tool node whose call throws reports
  `tool_execution_failed` with only the structural failure class (error name, HTTP status,
  upper-case peer error code); its node result stays anonymized. Warn- and error-level node
  diagnostics are also written to the server log with execution, flow, and node ids.
- **Model pools per shortcut.** A model shortcut in `flows/model-shortcuts.yaml` can name a pool
  of members (engine/model pairs or other shortcuts) with a selection strategy — `fallback`,
  `round-robin`, `weighted-round-robin`, `random`, `weighted-random`, or `least-used`. The `llm`
  and `classifier` handlers try the resolved candidates in the strategy's order, using each later
  member as a failover, and skip a member whose provider circuit breaker is open. Every pool member
  is included in the flow's model, capability, compliance, and token-limit accounting, so a rotated-
  to or failed-over model is never invisible to those checks.
- **Sticky pools for prefix caches.** A pool may set `sticky: execution | conversation`
  instead of rotating: a tool-carrying turn stays on the model that started the execution
  (`execution`) or on the model that answered the conversation (`conversation`, across
  executions), which is what a provider's prefix cache rewards. Failover still applies —
  the failed-over model becomes the sticky one.
- **Provider key pool.** Multiple keys per provider with automatic quarantine on error, which
  spreads provider-side rate limits.
- **Three cache layers.** Response cache, semantic cache for equivalent-meaning requests, and
  embedding cache (`RESPONSE_CACHE_ENABLED`, `SEMANTIC_CACHE_ENABLED`,
  `EMBEDDING_CACHE_ENABLED`).
- **Semantic cache lifecycle.** With a database the semantic cache is shared by all replicas.
  Expired entries are removed by a periodic sweep across all namespaces
  (`SEMANTIC_CACHE_PURGE_INTERVAL_SECONDS`, default 300), and erasing a user deletes that
  user's entries in the database, from every replica and from before a restart.
- **Budgets and anomaly detection.** Hard per-tenant daily budgets reject requests once
  exhausted, threshold webhooks fire earlier, and spike detection flags unusual spend
  (`BUDGET_DAILY_PER_TENANT`, `COST_ANOMALY_ENABLED`).
- **Per-run budgets.** A flow declares `budgets` (`maxTokens`, `maxToolCalls`, `maxWallMs`);
  the execution stops before the next model or tool call once a limit is reached and finishes
  with `finishReason: budget_exceeded`.
- **Shared rate-limit budgets.** `RATE_LIMIT_REDIS_URL` moves the Search and Extract HTTP
  rate limiters onto a shared Redis budget, so a multi-replica deployment throttles each
  client once fleet-wide instead of once per pod (the backends fail open on Redis errors);
  the Runtime's webhook router shares its `REDIS_URL`-backed store the same way. With
  `REPLICAS > 1` and no shared store, the production gate fails or warns.
- **FinOps accounting.** Usage and cost per tenant, day, and model, with forecasting and CO2
  accounting derived from configurable energy and grid-intensity factors.
- **Currency labelling.** Every cost display renders in one configured currency
  (`CURRENCY`, default `EUR`; the Control mirrors it via `NEXT_PUBLIC_CURRENCY`, frozen at
  build time). Values are never converted — only the label changes, and internal and wire
  field names (`cost_usd`, `maxCostUsd`, …) stay as they are. An unknown value falls back to
  `EUR` with a warning.
- **Idempotency.** A repeated request with the same idempotency key does not execute a
  consequential action twice (`IDEMPOTENCY_ENABLED`).
- **Limits.** Rate limiting per identity and per user, pre- and post-authentication buckets,
  concurrency caps, queue depth limits, and hard execution timeouts. Under a concurrency cap,
  waiting requests are admitted highest-priority-first (FIFO among equal priorities); a flow's
  effective priority is the maximum of its own `priority` and its LLM/classifier nodes' `priority`
  (integer 0–100, default 50), so a latency-sensitive flow can jump ahead of bulk work. Transient media storage
  additionally rejects empty or individual payloads above 25 MiB and retains at most 128 MiB;
  image-inspection registries apply the same byte ceilings plus a 32-reference LRU bound per
  execution. Evicted references report unavailable rather than resolving to another image.
- **Durable execution.** Optional checkpointing lets a long agent run survive a restart
  (`CHECKPOINTING_ENABLED`).

## Multi-tenancy and identity

- **Tenant isolation.** Separate tenants with their own keys and configuration, enforced in
  the database through row-level security when enabled (`TENANT_ISOLATION_ENABLED`,
  `TENANT_RLS_ENABLED`, `TENANT_RLS_REQUIRED`).
- **BYOK.** Tenants supply their own provider keys, stored encrypted
  (`BYOK_ENABLED`, `BYOK_MODE`, `BYOK_ENCRYPTION_KEY`).
- **Authentication.** JWT with JWKS verification, multiple issuers, and audience checks; or
  OIDC with a backend-driven session for the operator plane
  (`AUTHN_MODE`, `JWT_*`, `OIDC_*`).
- **Issuer to tenant binding.** With several trusted issuers, `JWT_ISSUER_TENANTS` limits the
  tenants each issuer may claim; other combinations get 401.
- **Token and key rotation.** Search and Extract accept `API_TOKEN_NEXT` next to `API_TOKEN`
  during a rotation; API keys can be peppered (`API_KEY_PEPPER`, lazy hash migration).
- **Transport security.** Search and Extract can serve HTTPS and verify client certificates
  (`TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_CLIENT_CA_FILE`).
- **RBAC.** Operator roles are mapped from token claims (`OPERATOR_ROLE_CLAIM`,
  `OPERATOR_ROLE_MAP`).
- **Agent identity broker.** Agents receive scoped, revocable identities rather than sharing a
  static credential, with a revocation console.
- **Trusted headers are explicit.** Identity headers are only honored from configured trusted
  sources (`TRUSTED_IDENTITY_HEADERS`, `STRICT_IDENTITY_HEADERS`).
- **One operating profile, one preset.** `ATF_PROFILE` (`development | staging | production`)
  sets the operating profile for all four services at once and wins over the service's own
  variable (`APP_ENV`, `MCPGATE_ENV`, …); an unknown value aborts startup. `ATF_PRESET`
  selects a preset (the old per-service `PROFILE` variable is a deprecated alias that warns,
  and a conflicting value stops startup); regulated presets turn on taint mode, AI
  disclosure and mandatory compliance policies, and in the production profile make a missing
  audit anchor file, an empty egress allowlist or a missing `EVIDENCE_SIGNING_KEY` fatal.

## Channels

The primary interface provides OpenAI-compatible chat, Responses, model-listing, and embedding
endpoints. Clients using those documented surfaces can often connect without an adapter; this is
not a claim of compatibility with the complete OpenAI API. Two additional inbound paths exist.

- **Webhooks.** A `trigger` node accepts a signed inbound call and starts a flow.
- **Rocket.Chat.** A direct-message assistant, off by default (`ROCKETCHAT_ENABLED`).

### Rocket.Chat

An outgoing Rocket.Chat integration posts to `POST /integrations/rocketchat/events`. Deliveries
authenticate with a shared token compared in constant time; the bot's own messages are dropped
before any work happens, so an assistant reply cannot trigger itself.

A message from a *bound* conversation starts a durable assistant run keyed on the Rocket.Chat
message id, so a redelivery resumes rather than duplicates. Replies go out through a
**transactional outbox**, not a direct call from the request path:

- Each run owns one deterministic message id, so progress updates edit that message via
  `chat.update` instead of flooding the room. The final answer marks the row `finalized`, after
  which its text is immutable — a late progress update cannot overwrite an answer.
- Delivery holds a row lock across the outbound call, so revoking a binding waits for an
  in-flight send rather than racing it.
- Failures are retried with exponential backoff up to an hour, and rows whose binding has been
  revoked are cancelled rather than delivered.

**Linking is consent, proved twice.** A message from an unknown conversation never reveals
whether it is known — the response is identical either way. When self-service connect is
configured, the user receives a short-lived opaque link and completes a **separate end-user OIDC
flow** that shares nothing with the operator session: its own PKCE exchange, its own signed
cookies, no operator role. Activation requires that the email in the verified ID token matches
the verified primary email the Rocket.Chat server reports for that account, so neither a
user-supplied address nor a chat display name can claim an identity. Ownership of the selected
assistant comes from the signed session cookie, never from a form field. `AIPERATOR-DISCONNECT`
in the conversation revokes the binding and cancels undelivered messages.

**Background authority is delegated, not shared.** The connect flow requires `offline_access`.
The resulting refresh token is encrypted with an AAD bound to the request, then re-encrypted
under an AAD bound to `(tenant, user, assistant, issuer)` when the binding activates; staging
secrets are erased in the same transaction and swept on expiry. Short-lived access tokens are
minted from it per run. Without an issuer, client, and secret the assistant still works
interactively and background runs report that they hold no credentials.

Requirements: PostgreSQL (three dedicated tables, all under row-level security), assistants
enabled, and an assistant encryption key. The connect flow additionally requires that its OIDC
issuer, client id, and client secret are **identical** to the delegation client — otherwise only
the webhook is mounted and unknown conversations get a "contact an administrator" reply. All
settings are listed in [CONFIGURATION.md](CONFIGURATION.md) under `ROCKETCHAT_*`; note that the
`ROCKETCHAT_CONNECT_*` group is read directly and is not validated at startup.

## Observability

- **OpenTelemetry traces** and **Prometheus metrics**, with metrics endpoint authentication
  controlled separately from the API (`METRICS_ENABLED`, `METRICS_AUTH`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`).
- **Structured logs** with redaction of configured fields.
- **Debug traces.** Per-execution traces including the resolved flow version, node timings,
  model calls, and policy decisions, with per-field text budgets so a trace cannot grow
  without bound.
- **Live monitoring.** SSE or WebSocket stream of execution events for the operator UI,
  with a connection cap and ticket-based authorization
  (`MONITORING_TRANSPORT`, `MONITORING_AUTH`, `MONITORING_MAX_CONNECTIONS`).
- **SLO tracking** and alert webhooks.
- **Flow SLOs (experimental).** A flow can declare service objectives under `slo:` (p50 and p95 latency,
  median tokens, maximum error rate) over the last `window` executions. A change from met
  to breached raises `aiperator_flow_slo_breach_total{flow_id, objective}` and logs a
  warning, and `GET /monitoring/flow-health` shows the state. Each replica evaluates its
  own executions.
- **Preflight with `atf-doctor`** (output format experimental). `bun run atf-doctor --service runtime|search|extract|gate`
  checks a service's environment file offline against its production-readiness gate, for the
  Runtime also the governance posture, and for the Gate its configuration directory (permissive
  defaults, approver separation, unpinned imported tools), without starting the service or
  printing a value from the file. It exits non-zero when a check fails.
- **Governance posture report.** `GET /monitoring/posture` (and `cli.ts posture`) list
  which governance controls are active — evidence key, anchors, egress, taint,
  disclosure, policy, receipts, shared state, flow load, audit pseudonym pepper,
  PII vault, approval gate, authentication mode, replicas — as ok/warn/fail, together
  with the operational profile, the preset and the production-gate result, so the
  configured control set is provable at a point in time.

## Operator interface

Control is a Next.js application for operating the platform.

- Flow registry with per-flow run statistics (runs, average runtime, average and total cost)
  over a selectable window of 1h, 1d, 1w or 1m (`GET /monitoring/flow-stats?since=`), and a
  flow diff page that compares any two flows or drafts (`GET /flows/diff/compare?from=&to=`,
  optional `fromDraft`/`toDraft`).
- **Studio** for building and changing flows: a canvas with auto-layout and
  tool links for settings-defined calls (parallel children, harness verifier and delegates) that
  dock right → left, apart from the top → bottom flow, with Start and End showing where a run
  begins and ends and what a request brings in and returns; the nodes of a sub-flow file drawn in
  a labelled box, with a palette to extract a selection into `subflows/<name>.yaml` or place an
  existing file on the canvas; a settings form per node type generated from Runtime's node type
  catalog (`GET /flows/node-types`) with the full node type reference beside it; an editor for the
  prompt file behind a `#[[file:prompts/….md]]` reference, so the prompt text itself is editable
  and not just the reference (`GET /flows/prompts/content`, `POST /flows/prompts/write`, both
  pinned to the flow directory's `prompts/` subtree), which can also save the edit under a new
  file name for this flow only or copy the text into the flow and drop the include; a variables table
  (typed values, usage counts, renaming that rewrites references); an expression builder
  behind every ƒx button with a variable browser, operators, a live result from Runtime, values
  from a pinned run, and a copilot for the field; named drafts — several working copies per
  flow (`GET/PUT/DELETE /flows/:id/drafts[/:draftId]`, the implicit draft route stays the
  `default` draft) with publish selecting a draft via `?draftId=`, and diff against the live
  version; a Copilot that proposes changes, including node settings, as a previewed overlay that
  must be accepted; an Optimize panel with cheaper candidate models for the canvas or the live
  flow; and test runs of the canvas state (an ephemeral test registration, never the live flow)
  or of the live flow, with per-node tokens, cost, and saving a run as an eval case with an
  expected answer. A request picked in the Live Graph can be attached to Run & Trace and
  inspected there.
- Execution history and trace viewer. The history table sorts server-side on its main
  columns (`GET /monitoring/history?sortBy=&sortDir=asc|desc`, whitelisted columns only,
  stable tiebreaker) — started, flow, user, nodes, latency, runtime, and cost. Requests of one
  conversation are grouped under a header row with flow, user, summed runtime and cost, and
  status; History and the Live Graph share a flow include/exclude and searchable user filter.
  The Live Graph enriches failed nodes with the error type, details, diagnostics timeline and
  failing tool result from the execution debug trace (`GET /monitoring/debug/:executionId`)
  while that trace is still held in memory.
- Approval inbox; approve and deny need the operator role. The dashboard is available in German
  and English (cookie `NEXT_LOCALE`). Control can run in BFF mode (`CONTROL_SESSION_MODE=bff`):
  a sealed session cookie (`CONTROL_SESSION_SECRET`), a same-origin guard on the backend proxy
  (`CONTROL_PUBLIC_ORIGIN`), and an allowlist of proxied paths.
- Cost, budget, and FinOps panels.
- Evaluation runs and eval cases (list and delete), canary status, shadow comparisons,
  autopilot state.
- Provider and pool health (reachability, capabilities, call/error/token counters, admission
  queue) and a provider testing bench (live model list, capability auto-test, ad-hoc prompt,
  latency and throughput).
- Tenant, key, and budget administration.
- Compliance dossier and DSAR handling.
- Assistants and skill registry administration.

Control talks to Runtime over the documented HTTP API only; it holds no private
configuration and imports no Runtime source directly.
