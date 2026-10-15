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
  Reasoning output from thinking models is surfaced separately from the answer.
- **Agentic tool use.** A flow step can let the model select and call tools over MCP, then
  incorporate the results. `MAX_TOOL_STEPS` bounds the loop.
- **Flow as MCP server.** A flow can itself be exposed as an MCP tool, which lets one ATF
  deployment compose another.
- **Triggers.** A flow can start from an HMAC-signed webhook or on a schedule, not only from
  a chat request. `TRIGGERS_REQUIRE_SIGNATURE` controls signature enforcement.
- **Asynchronous jobs.** Long runs execute in the background and are polled by job id, with
  optional lease-based recovery after a replica restart.

## Document extraction

Extract converts documents into the canonical Markdown defined by `packages/extract-contract`,
which is the form Search indexes. It is an optional service: retrieval works without it for
callers that already hold Markdown.

- **Formats.** PDF, DOC, DOCX, XLS, XLSX, PNG, JPEG, GIF, TIFF, BMP and WebP. Office documents are laid out by LibreOffice
  first, so every format funnels through one PDF page loop and page numbers, page images and
  text offsets agree across formats.
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
  `extract.ingest` (plus `extract.delete` when mirroring deletes). Every secret supports a
  `_FILE` variant and the logger scrubs registered secrets.
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
- **Optional sparse vectors.** SPLADE-style sparse retrieval as a third signal.
- **Collections and versioning.** Multiple collections with their own language configuration,
  document versioning, and score-keyset pagination that stays stable across pages.
- **Storage efficiency.** Vector quantization and half-precision storage reduce index size.
- **Embedding drift protection.** `EMBED_MODEL_REVISION` and `EMBED_EXPECTED_DIMENSION` make
  an unsafe in-place embedding model change fail fast rather than silently degrade relevance.
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
  production (`TOOL_OUTPUT_VALIDATOR_ENABLED`, unset = on when `APP_ENV=production`); a finding
  is neutralised (`TOOL_OUTPUT_VALIDATOR_MODE=redact`) and recorded on the consuming node's trace
  as `indirect_prompt_injection` and in `aiperator_indirect_injection_total`.
  Retrieved chunks reach the model as a delimited untrusted-data block (`RETRIEVAL_CONTEXT_MODE`,
  unset = `spotlight` in production), and after a finding any tool not declared `readOnlyHint`
  needs human approval for the rest of the run (`TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`, unset = on
  in production; recorded as `tainted_write_tool_approval`). Search results carry
  `content_trust: untrusted` and an `injection_risk` hint.
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
  per-replica scope rather than blocking.
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
  personal data but cannot be erased automatically (the semantic cache, or in-memory checkpoint
  and assistant stores without `DATABASE_URL`) is listed with its gap in `GET /v1/me/data` and
  the compliance dossier, and makes every erasure report `partial` rather than `complete`. The
  audit log and `erasure_requests` are retained as accountability records.
- **Decision receipts.** With `DECISION_RECEIPTS_ENABLED` and `RECEIPT_SIGNING_KEY`, each chat
  completion and tool call yields a signed COSE_Sign1 receipt (`GET /v1/receipts/:id`), appended
  to a transparency log (`receipt_log`); the public key is served at
  `/.well-known/atf-receipt-jwks.json`. Rotation notes: `runbooks/key-rotation.md`.
- **Flow identity in traces.** Debug traces carry `flow_version`, `flow_digest` (a hash of the
  executed flow with includes expanded) and `subflow_versions[]`; CI fails a flow change without
  a `metadata.version` bump (`check:flow-versions`).
- **Verifiable evidence bundles.** A signed bundle ties an execution to its inputs, policy
  decisions, sources, and outputs (`EVIDENCE_BUNDLE_SECRET`).
- **Compliance dossier.** A single generated document collects the active policy, the audit
  chain verification result, executed erasures, retention windows, evaluation results, and
  the red-team posture score, with references to the architecture decisions behind them.
- **Decision provenance.** An explainability card reconstructs why a given answer was
  produced: which model, which sources, which policy decisions, which routing choice.

## Quality: evaluation, canary, shadow, replay

- **Evaluation runs.** Datasets, automated judge scoring, and matrix runs across model and
  prompt variants, suitable for use as a regression gate in CI. Eval cases can be collected from
  Studio test runs, each with a reference answer, and removed again (`DELETE /eval/cases/:id`).
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
- **Provider key pool.** Multiple keys per provider with automatic quarantine on error, which
  spreads provider-side rate limits.
- **Three cache layers.** Response cache, semantic cache for equivalent-meaning requests, and
  embedding cache (`RESPONSE_CACHE_ENABLED`, `SEMANTIC_CACHE_ENABLED`,
  `EMBEDDING_CACHE_ENABLED`).
- **Budgets and anomaly detection.** Hard per-tenant daily budgets reject requests once
  exhausted, threshold webhooks fire earlier, and spike detection flags unusual spend
  (`BUDGET_DAILY_PER_TENANT`, `COST_ANOMALY_ENABLED`).
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
