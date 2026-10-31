# Changelog

Notable changes to ATF are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Three things version independently of this file, because they are contracts rather than
releases:

- **Contract packages** under `packages/` carry their own versions. A breaking change to a
  cross-service message is a major bump there, and `integration/system` fails in CI when a
  change breaks the combined lifecycle.
- **Flows** declare `metadata.version` in their own YAML. That version appears as
  `flow_version` in the execution debug trace, which is how a deployed flow revision is
  verified after a rollout.
- **Node and tool schemas** are validated on load, so an incompatible flow fails at load
  time rather than mid-execution.

## [Unreleased]

### Added

- **Runtime** (model pools): busy-aware member selection for single-slot servers. A `PROVIDERS` entry can set `maxConcurrent` (requests the endpoint serves at once, e.g. `1` for llama.cpp with one slot) and `loadProbe: "llama-slots"`. A pool then only sends a call to such a member while it has capacity: a busy member moves behind the free ones (it stays a failover), and a sticky pool (`sticky: execution | conversation`) whose pinned member is busy uses the free member and moves the pin there. The load is the requests this Runtime process has in flight to the endpoint (counted at the HTTP transport for the `openai`/`ollama` protocols), pools' pending selections, and with `loadProbe` llama.cpp's live `GET /slots` state, which also sees other clients (cached 0.5 s, 400 ms timeout; a failed probe falls back to the local count). If every limited member is busy, the order stays unchanged. Providers without `maxConcurrent` behave as before.

## [0.23.0] - 2026-10-30

### Added

- **Extract**: `VISION_ENABLE_THINKING` and `SUMMARY_ENABLE_THINKING` send `chat_template_kwargs.enable_thinking` (alone or next to `reasoning_effort`). Qwen-style chat templates ignore `reasoning_effort` and switch their thinking block only with `enable_thinking`. Unset sends nothing, as before; a set value is part of the pipeline stand, so `pin` jobs pause when it changes.
- **Extract**: `SUMMARY_INPUT_TOKEN_COST` / `SUMMARY_OUTPUT_TOKEN_COST` (USD per million tokens, default 0) price the summary model next to the existing `VISION_*_TOKEN_COST`.
- **Extract** (`GET /v2/jobs`): `order=queue` lists the jobs a worker drives first, then the waiting ones (queued, paused) oldest first, then the finished ones; `status` filters by statuses or the groups `active`/`waiting`; `include=progress` adds per-stage `progress` and `etaSeconds` to each row with one grouped query; the response carries `total`. New `GET /v2/jobs/summary`: jobs per status and pause reason, summed tokens and cost, the emitted pages of the active jobs and the oldest waiting job.
- **Extract** (operator console, Jobs): a queue header with those counts (a tile filters the list), page navigation instead of "load more", the queue order by default, server-side status filter, page size, and live updates every 2/5/15 s (on by default) with per-row page progress, current stage and ETA.

### Fixed

- **Runtime** (audit): durable audit writes no longer fail with a separate operator database role. `PostgresAuditLog` appends the hash chain on the operator pool (`DATABASE_OPERATOR_URL`), but `rls-setup` had only granted `aiperator_operator` SELECT on `audit_log`. Every regulated action (approval decisions, key rotation, erasure, flow publish …) therefore answered 503 `AUDIT_UNAVAILABLE` and wrote no audit entry. Schema version 52 grants `INSERT` on `audit_log` and the id sequence (still no UPDATE/DELETE), and `rls-setup` does the same for new databases. A failed required audit write is now logged with its cause.
- **Runtime** (approvals): when the audit write fails after an approval decision, the in-chat widget now states that the decision took effect and only the audit entry is missing. Before, it said the decision was "not confirmed" and asked for a retry, although the approval was already consumed and the tool call went ahead.
- **Gate** (approvals): approval rules with `approval.lookup` work again when `MCPGATE_TRANSACTION_ENFORCEMENT=required`. The Gate ran the internal lookup through the TransactionFabric without a transaction token, so it was rejected ("Transaction token required"), the approval request failed with "Approval lookup failed" and the caller only saw a generic tool error. The lookup now runs as read-only approval enrichment outside the fabric (still through policy, scopes, rate limit and audit), the caller's transaction token stays reserved for the gated action, and a lookup tool that is not `access: read` is rejected. Composite and router lookups work the same way: their steps inherit the lookup mode, and every step must be read-only too.
- **Extract**: `cost_usd` was never written, so every job reported $0, and a job without `tokenBudget` did not book its tokens either. Every model call (failed attempts included) now books its tokens and their price, from the response's prompt/completion split, into the job row.
- **Extract** (operator console): the progress bars of the job list and the per-stage detail were never drawn (inline elements ignore width and height).

- **Outpost** (release): an Outpost release (`outpost-v*`) is no longer marked as the repository's "Latest" release, which belongs to the product releases (`v*`).
- **Outpost** (`local`, 0.1.2): files whose on-disk names are not NFC, typically folders copied from macOS (NFD), could not be opened on Linux and failed with "path guard rejected … candidate path not resolvable". `open` now maps the NFC `quellId` back to the on-disk name segment by segment before the path guard runs. The `quellId` and thus the document reference stay NFC, so nothing is re-ingested under a new reference. Two different entries with the same NFC form are rejected as ambiguous.

## [0.22.0] - 2026-10-28

### Security

- **Search, Extract**: every API route is rate limited per client IP (`RATE_LIMIT`). Before, only the ingest, search and v2 routes were; the read routes (`/documents`, `/document`, `/summaries`, …), the collection admin routes, `/ui`, the browser login (`POST /login`, which checks a token) and the OIDC routes were not. Health probes, `/metrics`, the evidence JWKS and the OpenAPI documents stay unlimited, and so do Search's MCP endpoints, whose callers (Gate, Runtime) bundle many users behind one IP and limit per identity themselves.
- **Gate**: `server.cors.origins: ["*"]` now answers a literal `*` without `Access-Control-Allow-Credentials`; before, it reflected any origin together with credentials, so any site could send cookie-authenticated requests. An explicit origin list keeps credentials.
- **Extract** (`/v2/uploads/{id}`): an id that is not a server-issued UUID is answered with 404 before it reaches a scratch-file path, and scratch files are confined to the scratch directory (Express decodes `%2F` in route parameters).
- **Runtime** (flows): `$include.patches` ignore `__proto__`, `constructor` and `prototype` keys.
- **Outpost**: the PKCE `code_verifier` is drawn uniformly from its alphabet (before, `byte % 66` favoured the first 58 characters).
- **ReDoS**: regular expressions that backtracked quadratically or exponentially on crafted input are replaced by linear scans or unambiguous patterns: trailing-slash trimming of issuers and URLs (new `trimTrailingSlashes` in the Security_Kit), the Bearer header parser in Gate and Runtime, the Gate monitor's JSON highlighter, HTML/Markdown normalisation in Search, figure and bbox parsing and page selections in `@atf/extract-contract` (2.4.1), and the S3 listing, AWS INI and certificate parsing in the Outpost.
- **Images**: `body-parser` 2.4.0 (CVE-2026-111181), `undici` 7.30.1 for the AI SDK in the Runtime image (CVE-2026-87018, -109383, -109829, -109869); the Control image no longer ships the npm, npx and corepack of its Node base, which carried vulnerable `undici` and `brace-expansion` copies.

### Added

- **CI**: the test jobs start a Redis 8.2 and run the Redis-backed stores and rate limiters against it with the real client (`TEST_REDIS_URL`): Gate approvals, pending approvals, webhook replay, transaction ledger, monitor cluster bridge, per-identity and IP rate limits, and the Security_Kit GCRA backend used by Search and Extract.

### Changed

- **Dependencies**: `redis` 6.3.0 (Gate, Search, Extract). The client now speaks RESP3 by default, applies a 5 s command timeout and negotiates maintenance notifications; it needs Redis 6 or later on the server (tested against 7.4 and 8.2). `jsdom` 30 for the Control tests.
- **Gate**: `rate-limit-redis` 6.0.2 is a regular dependency and ships in the image, so `server.rateLimit.store.type: redis` works without installing anything; before, the stock image refused to start with that setting because the package was missing.
- **Licensing**: `BlueOak-1.0.0` and `CC0-1.0` are allowed on their own; both come only from jsdom, a test dependency of Control.
- **Toolchain**: Bun 1.4.4 everywhere: `packageManager`, CI and release `BUN_VERSION`, `@types/bun` 1.4.4, and `engines.bun` `>=1.4.4 <2` in every workspace (before: toolchain 1.4.0, images 1.4.4). Node.js is pinned to 26.12.1 (`.nvmrc`, `.node-version`, CI `NODE_VERSION`, `engines.node` `>=26.12.1 <27`); the Control and Outpost images name `node:26.12.1-alpine` explicitly (same digest as before).

### Fixed

- **Gate** (approvals): with a Redis URL and the default `policies.approval.maxPending`, creating a pending approval always failed with "approval store unavailable", because the create script did not compile on Redis (and would have reported every write as a duplicate). Human-approval flows on a shared Redis work again.
- **Search, Extract, Gate** (rate limits): the shared Redis GCRA backend passed numbers to the Redis client, which accepts only strings, so every check failed. Search and Extract failed open (no shared limit with `RATE_LIMIT_REDIS_URL`), and the Gate per-identity limit with `store.type: redis` failed closed (every MCP call refused).
- **Search** (`/ingest`, `/search`): a body that is not text (a JSON object or array) is rejected with 400 instead of failing with a type error.
- **Extract** (email): HTML-to-text conversion and the Runtime's artifact stripping remove tags until none are left, so a removal cannot splice a new `<script>` or `<iframe>` together.
- **Search, Extract-contract** (tables): a backslash in a Markdown table cell is escaped before the pipe, so `a\|b` no longer splits the cell.

## [0.21.0] - 2026-10-27

### Security

- **Extract**: the new scope `extract.acl.assign` lets a trusted ingest client (such as Outpost) set `X-Allowed-Users`/`X-Allowed-Groups` as requested. Without it, requested access lists are still intersected with the caller's identity, and a service token without identity yields an empty (tenant-wide) access list, which Outpost-ingested documents silently received before.
- **Outpost**: an item with an access list fails (and is removed again) when Extract reports `X-ACL-Applied` other than `assigned`, instead of staying visible tenant-wide. An asynchronous job is cancelled before the document is removed, so its segments stop becoming searchable instead of the job running to completion first.
- **Outpost** (`sharepoint`): with `aclFromPermissions`, items without a mappable user or group (for example shared only via links) are no longer ingested with an empty, tenant-wide access list. They are reported as revoked, and a previously synced copy is removed even with `mirrorDelete` off.
- **Runtime** (erasure): erasure receipts are found by receipt id on Postgres again. The Runtime's SQL client stored stringified JSON bound to `$n::jsonb` as a JSON string scalar, so JSON operators on those columns matched nothing (also affected: the Postgres invocation ledger). Writers now cast through `::text::jsonb`, readers accept both shapes, and migration 51 repairs existing erasure, tenant and eval rows.

### Added

- **CI** (eval): answer-ready retrieval and the contextual-header run are gated by their own thresholds.
- **CI**: `check:jsonb-casts` fails on a bare `$n::jsonb` cast in Runtime SQL; an object parameter is marked with `jsonb-cast-ok:`.

### Changed

- **Dependencies**: every dependency on its latest release except `redis` (6.x switches to RESP3 and a 5 s default command timeout; kept on 5.x until it is tested against a real Redis), `jsdom` (30.x pulls in dependencies under BlueOak-1.0.0 and CC0-1.0, which are not on the license allowlist yet; kept on 26.x) and the toolchain pins (`@types/bun`, TypeScript). Notable: zod 4.6.7, undici 8.12.3 (Outpost, security kit), chokidar 6 (Runtime flow watcher, Outpost), MCP SDK 1.32.2, hono 4.13.14, express 5.3.0, multer 2.5.0, `@langchain/core` 1.3.0, Next.js 16.4.3, Tailwind CSS 4.3, Vite 8 with `@vitejs/plugin-react` 6 and Tauri 2.12 (Outpost Desktop, including a full `cargo update`), Biome 2.6.3 (Helm templates are no longer linted as YAML), the AI SDK and AWS SDK groups. Container bases move to `oven/bun:1.4.4` and the current `node:26-alpine` digest; the CodeQL, `docker/login-action` and `download-artifact` actions are updated.
- **Eval**: golden-set fixture 1.4.0 with reworded documents and questions (pages, figures, cells and question count unchanged). Retrieval metrics are not directly comparable with fixture 1.3.0; re-ingest a live golden corpus before comparing.

### Deprecated

- Deprecated environment variables and Gate options now log a warning at startup when set; `docs/DEPRECATIONS.md` lists every deprecated item with its replacement. They are removed in 1.0.0. The legacy tenant header warns once per Runtime process, and a `parallel` node that relies on the implicit `authoritativeTagField` default reports `deprecated_authoritative_tag_field_default` in the debug trace.

### Fixed

- **Runtime** (semantic cache, erasure): with a database-backed cache, erasing a user deletes that user's entries from every replica and from before a restart; entries written before user scoping are dropped on the first erasure. A failing delete now fails the erasure instead of reporting zero entries.
- **Runtime** (semantic cache): expired entries are removed by a periodic sweep across all namespaces (`SEMANTIC_CACHE_PURGE_INTERVAL_SECONDS`, default 300); before, they stayed in the database until the same namespace was written again.
- **Search** (`/v2/citations/check`): the "carried over" comparison runs in the database, with whitespace collapsed on both sides, so documents of any size are classified correctly instead of a false `changed` beyond 5000 units. The status `unverified` is part of the response schema and is counted separately by the Runtime citation-impact report and Control, but is currently not produced.
- **Tooling** (`atf-doctor`): without a readable `FLOWS_DIR` the report says that flows were not checked instead of reporting them as loaded.
- **Outpost** (`sharepoint`): a run that starts from the stored delta link lists changes only, and items it did not mention were treated as deleted (with `mirrorDelete` they were deleted once the threshold allowed it, otherwise marked `deleted-in-source`). Incremental listings now skip the absence-based delete phase; deletions arrive as tombstones and follow `mirrorDelete`.
- **Outpost** (release): the container image gets GitHub build-provenance and SBOM attestations like the other images, the Windows single-executable build resolves `node` and `postject` natively, and the macOS x64 build installs the x64 dependencies.

### Documentation

- Capabilities, metrics and retention, threat model and DPIA template cover atf-doctor, the SharePoint source, access-list assignment, flow SLOs, the citation index and the semantic-cache sweep.
- `docs/STABILITY.md` defines which surfaces are covered by semantic versioning from 1.0.0 and which features remain experimental.
- `SECURITY.md` states the support policy from 1.0.0 on.
- Capabilities mark experimental features; the README points to the stability contract.

## [0.20.0] - 2026-10-25

### Security

- **Runtime** (semantic cache): entries are scoped to tenant AND user, and a hit
  additionally requires an identical context (system prompt, injected sources,
  earlier turns); only the last user message is matched semantically. Before,
  every user of a tenant shared the cache and the whole prompt was embedded, so
  a long shared system prompt could produce hits between different questions or
  across users with different document access.

### Added

- **Search**: `POST /v2/citations/check` tells whether cited chunks are still current,
  carried over unchanged into the current revision, changed, removed, or unknown to the
  caller.
- **Runtime**: with `CITATION_INDEX_ENABLED=true` (needs `DATABASE_URL`) the chunks an
  answer cited are recorded per execution in `answer_citations`; the table is covered
  by retention and erasure.
- **Runtime**: `GET /monitoring/citation-impact` and `cli.ts citations impact` list
  past answers whose cited passages changed or disappeared in a newer document
  revision (Search `/v2/citations/check` via `CITATION_CHECK_URL`); the report is
  signed with the evidence key and verifiable with `atf-verify --citation-impact`.
- **Control**: Citation impact page lists answers whose sources changed.
- **Outpost**: `sharepoint` source for SharePoint Online and OneDrive for Business
  document libraries (Microsoft Graph, client credentials, delta sync);
  `aclFromPermissions` maps item permissions to the document access list.
- **Outpost**: sources may set `acl.users`/`acl.groups`; documents are ingested
  with that access list (Extract intersects it with the Outpost token's rights),
  and an ACL change re-uploads the document.
- **Eval**: `scripts/eval/retrieval.ts --retrieve` measures `POST /v2/retrieve`
  with the golden set (page recall, MRR, nDCG, latency; figures are not part of
  that response).
- **Eval**: the eval stack runs a second Search instance with
  `FTS_COMPOUND_SPLIT=query` on port 3013 for the German compound ablation.
- **CI** (eval): answer-ready retrieval and the German compound ablation run in
  the eval job, and the job summary tabulates all eval runs.
- **Runtime** (`flows release`): bench statistics report the cascade escalation
  rate, budget stops and p50/p95 wall time; bench files may cap them with
  `maxCascadeEscalationRate`, `maxBudgetExceeded` and `maxWallMsP95`.
- **Control**: a Governance posture page shows which controls are active
  (`GET /monitoring/posture`), grouped by area with ok/warn/fail.
- **Control** (trace view): node details show the cascade outcome and
  agent-harness progress, and a run stopped by an execution budget is marked
  as such.
- **Release**: `atf-verify` ships for linux-x64, linux-arm64, darwin-x64,
  darwin-arm64 and windows-x64, each attested. Container images are published
  for linux/amd64 and linux/arm64.
- **Search** (`retrieve_for_answer`): optional model-based question decomposition
  (`decomposition: "llm"` with `RETRIEVE_DECOMPOSE_URL`/`RETRIEVE_DECOMPOSE_MODEL`);
  without it, or when the model answer is unusable, the rule-based split applies
  unchanged. The response names the method used.
- **Search**: HyDE is available on `/v2/search` and the MCP search tool
  (`hyde: true`, needs the existing `HYDE_*` configuration); lexical matching
  and reranking keep the original query.
- **Tooling**: `bun run release:preflight` runs the CI gates locally, warns
  when the local Bun differs from the pinned one, scans the commits since the
  last tag with gitleaks and, with `--container`, checks the supply-chain
  inventory in a linux/amd64 container.
- **Tooling**: `bun run atf-doctor --service runtime|search|extract --env-file <file>`
  checks an environment file against the production gates and, for the Runtime,
  the governance posture, without starting the service.
- **Tooling** (`atf-doctor`): `--service gate --config-dir <dir>` checks a Gate
  configuration, including permissive policy defaults, approver separation, unpinned
  imported tools and an open monitor.
- **Runtime CLI**: `bench capture` turns executions into bench cases for `flows release`
  (tools called, finish reason, token and latency caps), refusing inputs with personal
  data unless `--allow-raw` is given.
- **Runtime**: flows may declare `slo` (latency percentiles, median tokens, error
  rate); the Runtime evaluates it over recent executions and reports breaches in
  `GET /monitoring/flow-health`, Control and `aiperator_flow_slo_breach_total`.
- **Outpost Desktop**: `check:desktop-updater` refuses release builds with the
  placeholder updater key; first tests for the sidecar API client.

- **Docs** (README): a looping recording of a Studio test run (animated WebP,
  with the WebM source under `docs/media/`).
- **Docs** (README): a short "Enterprise adoption and engineering" section on
  Abillify's consulting, integration and support offering.
- **Examples**: `deploy/examples/flows/06-request-pipeline.yaml`, the flow from
  that recording: transform, classifier, router, parallel fan-out with a
  conditional child, and a risk classifier on the change branch. Runs without
  external services.
### Changed

- **Runtime** (presets): `secure`, `regulated` and `regulated-multitenant` no
  longer enable the semantic cache; they keep the exact response cache and the
  embedding cache. Set `SEMANTIC_CACHE_ENABLED=true` explicitly to keep it.
- **Helm**: the chart version follows the product version (`version:sync` sets
  it, `verify:version` checks it). Releases push the chart to
  `oci://ghcr.io/abillify/charts/atf`, signed with cosign.
- **Runtime** (`flows release`): a flow's `slo` supplies the latency and token
  thresholds a bench file leaves out; the receipt records which source applied.

### Fixed

- **Runtime** (erasure): the semantic cache is erased per user, so erasure
  reports no longer turn `partial` because of it.
- **Runtime CLI** (`validate`): schema errors name the node and field
  (`nodes[0](answer).llm.provider`) instead of `[nodes] Invalid input`, a
  missing `PROVIDERS` is reported as the likely cause, and a skipped sub-flow
  node counts as a warning.
- **Search** (`trace`): the result reports `truncated: true` when an instant
  hit the lookup cap, instead of looking complete.
- **Gate** (approvals): the per-tenant `maxPending` limit holds under
  concurrent requests across replicas (check and insert run as one Redis
  script).

### Documentation

- Deployment guide: install from the OCI chart, verify chart and images with
  cosign, supported platforms.
- Threat model, DPIA template and operations/TCO guide cover answer-ready
  retrieval, trace and document diff, bench files and release receipts, the
  cascade and the Runtime's cost levers.
- `docs/CONFIGURATION-ESSENTIALS.md` lists the variables a production start
  needs per service; CI checks that every listed variable exists in the
  configuration reference.
- Citation impact: capabilities, configuration, runbook, threat model and DPIA notes.
- Flow releases: capturing bench cases from executions.

## [0.19.3] - 2026-10-24

### Added

- **Runtime** (`llm` node): `sourcesCheck.rejectOutOfRangeMarkers` (opt-in,
  default `false`) retries an attempt whose answer cites `[n]` outside the
  range of sources registered in this execution (`1..n`), for example a
  hallucinated `[491]` when only one source exists. The retry is answer-only
  (no tools) and carries guidance naming the valid range. On buffered answers
  (`suppressToolPreamble`) the check runs before release, so rejected text
  never reaches the client; `requireToolUse` nodes are skipped. The final
  attempt is released as-is. Diagnostics: `citation_marker_out_of_range_retry`
  and `citation_marker_out_of_range_rejected`. Markers inside fenced code are
  ignored. Documented in [docs/FLOWS.md](docs/FLOWS.md).

### Fixed

- **Search** (MCP 2026 `tools/call`): invalid tool arguments now return a
  `-32602` message that names the offending parameter and the expected values
  (up to five Zod issues, e.g. `granularity: Invalid option: expected one of …`)
  instead of a bare `Invalid tool arguments`, so models can correct the call.
  The `search` tool's `granularity` description now lists its four values and
  points to `unit_type` for figure and table hits.

## [0.19.2] - 2026-10-23

`0.19.1` was prepared on `main` but never tagged: the first CI run after the
repository went public surfaced the failures fixed below. Its changes ship
here, in `0.19.2`.

### Security

- **Images**: the `atf-extract` runtime base moved to the current
  `debian:bookworm-slim` digest, which carries `perl-base`
  5.36.0-7+deb12u4 and closes CVE-2026-13221, CVE-2026-42496, and
  CVE-2026-8376 (all CRITICAL, flagged by the CI image scan).
- **Outpost Desktop** (`apps/outpost-desktop`): the Rust lockfile moves
  `rustls` to 0.23.46 (RUSTSEC-2026-0346 to -0349), `rustls-webpki` to
  0.103.16 (RUSTSEC-2026-0382), and `webpki-root-certs` to 1.0.10
  (RUSTSEC-2026-0383); all three reach the app through the updater's HTTP
  client. `ctutils` moves to 0.4.5 (RUSTSEC-2026-0385, non-constant-time
  comparisons). The three `zip` 4.6.1 advisories (RUSTSEC-2026-0367 to -0369) stay
  open and are ignored with a recorded reason in `deny.toml` and the CI
  `cargo audit` call: `zip` is built only for Windows through
  `tauri-plugin-updater`'s `zip` feature, the fix (`zip` 9) needs the
  updater's 3.0 alpha, the updater checks the Minisign signature before it
  unpacks, and the app ships no updater artifacts. The ignores go away with
  the first stable updater release on `zip` 9.

### Added

- **Images / Supply chain**: shipped container images now carry a machine-readable
  license inventory. The release workflow scans every published service image with
  Trivy (`--scanners license`, checksum-pinned) and adds the per-image
  `atf-<service>-licenses.cdx.json` to the checksummed supply-chain bundle; the CI
  image-scan job smoke-tests the same scan on the extract image. The new
  [docs/IMAGE-LICENSES.md](docs/IMAGE-LICENSES.md) documents the image bases, the
  poppler (GPL-2.0-or-later/MPL-2.0) and LibreOffice (MPL-2.0/LGPL-3.0-or-later)
  packages in the extract image, why `execFile` process-boundary invocation keeps
  them outside ATF's derivative-work boundary, and where Debian's license texts and
  source availability live. Closes the gap between the npm/Cargo notices (which
  cover the dependency tree only) and the OS packages an image actually distributes.

### Changed

- **All workspaces**: consolidated dependency refresh applied directly from the
  open Dependabot PRs (not merged): `ai` 7.0.143 and the `@ai-sdk/*` provider
  packages, `@langchain/*`, `@modelcontextprotocol/sdk` 1.32.0 in every
  workspace that pins it (CVE-2026-111767/CVE-2026-111768), `hono` 4.13.11,
  the AWS SDK v3 train 3.1152.0, `next` 16.4.2 with React 19.3.1, `vitest`/
  `@vitest/coverage-v8` 5.0.5, `@playwright/test` 1.64.1, `yaml` 2.9.1,
  `uuid` 14.0.3, `fast-xml-parser` 5.11.2, `supertest` 7.3.1, and the
  `@types/*` bumps. The `outpost-desktop` Rust side moved to `keyring` 4.2.0
  and `getrandom` 0.4.3 (with `proptest` 1.12.0, `serde_json` 1.0.154,
  `tauri-plugin-autostart` 2.7.0). Docker bases moved to `oven/bun` 1.4.3
  (digest-pinned); the CodeQL, build-push, cosign, and QEMU workflow pins were
  bumped to their Dependabot targets. Two source adaptations were required:
  `streamText`'s widened return union in `ai` 7.0.143 is narrowed to the full
  result via `LlmStreamResult` (ATF never passes `experimental_lowMemory`),
  and the `media-tool` test mock now emits the flat V3 file-part `data` the
  v3→v4 adapter expects instead of a pre-tagged union.
- **CI**: the quickstart smoke now asserts real output: the chat completion must carry
  the mock's answer (an empty `finish_reason: "error"` reply passed before),
  and the `/v1/convert` check expects the vision mock's page text — the
  synchronous v1 path rasterises every page and calls the vision model; the
  text fast path exists only in the v2 job runner.
- **CI**: the `extract-dist` artifact budget is 5 MiB (was 4 MiB). CI builds with the
  pinned Bun 1.4.0 toolchain, whose bundle is 4.62 MB; newer Bun releases
  tree-shake `zod` further and produce about 3.8 MB locally.
- **CI**: the Outpost job's `cargo test` first builds the outpost-desktop
  frontend (`generate_context!()` embeds `frontendDist`) and creates an empty
  placeholder for the Tauri `externalBin` sidecar (tauri-build requires the
  file; the SEA sidecar is built only by `outpost-release.yml`). The job
  timeout is 60 minutes instead of 30.
- **CI**: the quickstart `/ingest-file` smoke sends the required
  `X-Reference` header, and the retrieval-eval stack runs Search and Extract
  with `ATF_PROFILE=development`, since the production-readiness gate refuses
  the stack's deliberately unauthenticated settings. The eval stack's TEI
  healthchecks call `curl` instead of `wget`, which the
  `text-embeddings-inference:cpu-1.9` image does not ship, so both model
  servers stayed unhealthy even after they reported ready. Search in the
  eval stack waits up to 10 minutes per embedding call
  (`FETCH_TIMEOUT_MS=600000`): bge-m3 on the runner's CPU needs far longer
  than the 30-second default for one ingest batch. Its rate limit is off
  (`RATE_LIMIT=0`), because the baseline and ablation runs send several
  hundred back-to-back queries from one client and hit the 120/min default.
- **Eval**: the retrieval gate is recalibrated on the first real bge-m3 run
  (fixture 1.3.0): `page_recall` 0.95 → 0.80 and `ndcg` 0.60 → 0.53 in
  `scripts/eval/baseline/thresholds.json`; `figure_recall`, `mrr` and the
  latency floors are unchanged. The old floors came from bge-small-en-v1.5 on
  fixture 1.2.0 and were never measured against bge-m3 — the job never got
  past stack start-up until this release. Measured: page recall@10 82.5 %,
  nDCG@10 0.5554, MRR@10 0.8957 (previously 100 % / 0.6602 / 0.9058 with the
  old model and fixture). Whether the gap comes from the model or from the
  harder fixture is not yet analysed; see
  `scripts/eval/baseline/retrieval.bge-m3.md`.

### Fixed

- **Deploy**: the quickstart `extract` stage in `deploy/examples/Dockerfile`
  kept `USER root` after its build-time apt block, so the image ran as root and
  the Trivy misconfiguration gate (DS-0002) failed the source scan. The stage
  now drops back to the base image's unprivileged `bun` user. (The other four
  quickstart stages inherit the base image's default user, which is root;
  compose drops all of their capabilities.)
- **Runtime** (`@atf/runtime`): the egress-guarded `fetch` sent buffered request
  bodies with chunked transfer encoding instead of a `Content-Length`. Servers
  that only honour `Content-Length` — Python's `http.server`, and with it the
  quickstart model mock — read an empty body, so a streamed chat completion
  came back as plain JSON and the Runtime answered with an empty message
  (`finish_reason: "error"`). Buffered bodies now declare their byte length.
- **Quickstart**: the Runtime could not reach `model-mock` at all, because the
  egress guard refuses private addresses. `deploy/examples/compose.yaml` now sets
  `EGRESS_ALLOW_PRIVATE_HOSTS=model-mock`, the one exact-host exception the
  stack needs.
- **Quickstart**: Search's `POST /ingest-file` answered 404, because it uploads
  to Extract's v2 routes and the quickstart Extract had no database, so
  `/v2/uploads` was never mounted. Extract now gets `EXTRACT_DATABASE_URL`
  pointing at the quickstart Postgres (its tables live in their own `extract`
  schema), and `/ingest-file` returns 202 with a job id.
- **Runtime OpenAPI**: `GET /health/ready` spread its `503` response object into
  the response map, so `description` and `content` appeared as bogus status
  codes and the real `503` was missing. The `503` response is now keyed under
  its status code, and a test pins that every response key is a status code.
  The committed baseline `docs/openapi/runtime.json` drops the two bogus keys;
  `openapi:check` reports that as breaking, but no client could have relied
  on keys that are not status codes.
- **Outpost Desktop** (`apps/outpost-desktop`): the OAuth loopback listener is
  non-blocking, and on macOS and Windows an accepted socket inherits that mode.
  Reading the browser's redirect then failed with `WouldBlock` whenever the
  request bytes had not arrived yet, so a source login could fail with
  "OAuth-Redirect konnte nicht gelesen werden". The accepted connection is now
  read in blocking mode with a 10-second timeout.
- **Eval / Search tests**: `scripts/eval/de-morphology.test.ts` and
  `apps/search/tests/lexical-golden-mrr.integration.test.ts` read the
  gitignored `scripts/eval/golden-set/corpus/` and failed on a fresh checkout.
  Both now build the corpus in memory with the same pure builder
  (`buildCorpus`/`renderMarkdown`), byte-identical to the generated files.

### Documentation

- **Images**: `DEPLOYMENT.md`, `DEVELOPMENT.md`, and `docs/IMAGE-LICENSES.md`
  now name the `oven/bun` 1.4.3 base the production Dockerfiles actually pin,
  instead of the previous 1.4.2.

## [0.19.0] - 2026-10-22

### Security

- **Search / Runtime / Gate** (`@atf/search`, `@atf/runtime`, `@atf/gate`):
  the prompt-injection taint signal no longer breaks between the services.
  Search's content-trust scan (German/English override phrases,
  chat-template tokens) deliberately flags payloads the Runtime's own
  tool-output regex does not, but its verdict never reached the Runtime: the
  document-read tools (`get_document`, `get_documents`, `get_thread`,
  `get_summary`, `get_summaries`) and navigation reads (`get_section`,
  `get_pages`, `get_context`, `get_table`, `follow_ref`) returned stored text
  with no `injection_risk` / `content_trust` label, and
  `parseVectorSearchResults` dropped the labels even a `search` response did
  carry. Now every document-read response is labelled (per item and on the
  envelope, worst hit wins), the Runtime parses the labels into `RagChunk`,
  and a new bridge `markTaintFromSearchLabels` taints the execution — the
  same consequence as a local validator finding, so write tools then require
  approval — when a Search `suspected` label appears anywhere in a tool
  payload (envelope, per-item, or nested in the MCP text-wrapper JSON). The
  Gate's byte-for-byte MCP passthrough is pinned by a regression test so a
  future proxy transformation cannot silently sever the chain. See
  [ADR 0032](docs/adr/0032-search-content-trust-labels-execution-taint.md).
- **Runtime** (`@atf/runtime`): the audit log no longer receives credential
  material as the `actor`. The three red-team routes that wrote audit entries
  (`POST /security/red-team/:flowId/run`,
  `POST /security/red-team/attacks/register`, `PUT /security/tool-authz`)
  stored the raw `Authorization` header, and the optimizer routes
  (`POST /optimizer/:flowId/run`, `POST /optimizer/analyze/:executionId`,
  `POST /optimizer/runs/:runId/promote`) stored the first 12 characters of the
  bearer token (`token:<12 chars>…`) — a real credential prefix for static
  tokens, written into a hash-chained row that cannot be removed without
  breaking the chain. The audit log is readable via `GET /monitoring/audit`
  and exported to log shippers. The `actor` is now the authorizer's resolved
  identity (token label / JWT subject, `anonymous` when the plane is open,
  `unknown` if an authorized request carried no identity); the promoter handed
  to the optimizer is the same label. Regression tests pin that no token
  material reaches the audit entry. **Operator action: see Migration.**
- **Runtime** (`@atf/runtime`): the audit chain hash over a record's `details`
  is canonicalised recursively (object keys sorted at every depth). The
  durable backend stores `details` in a Postgres `jsonb` column, which does not
  preserve key order (it stores keys by length, then bytes), so the write-time
  hash no longer matched the same record re-serialised after a jsonb
  round-trip and `verifyChain()` reported false `hash_mismatch` failures
  against Postgres. `verifyChain()` also still accepts the pre-fix hash form
  (`details` hashed in as-stored key order) and reports how many rows needed
  it as `legacyForm`, so chains written before this change that verified then
  keep verifying now; the legacy form is accepted only for rows written
  before the first canonical row (a later one is reported as
  `legacy_hash_after_cutoff`); a changed value, a changed `prev_hash` or any other
  field still breaks verification. Rows whose key order had been changed by
  jsonb after they were hashed in insertion order were false positives before
  the fix and cannot be told apart from tampering — they stay unverifiable.
  A new integration test (`TEST_POSTGRES_URL`) runs the round-trip against a
  real Postgres, including the number normalisation `jsonb` performs.

- **Gate** (`@atf/gate`): the Monitor Tool Playground no longer bypasses
  governance. Real tool runs are dispatched through the same
  `McpToolDispatcher` pipeline as an MCP `tools/call` — policy evaluation,
  approval tokens, required scopes, argument validation, per-identity rate
  limiting, transaction fabric and audit events with the real caller identity
  — instead of calling the executor directly under a hardcoded `"playground"`
  audit identity; without the governance wiring the playground fails closed
  with 503 rather than executing ungoverned. A request body `identity`
  (subject/scopes/claims) is ignored entirely whenever a verified OIDC session
  cookie is present, so an authenticated dashboard user can no longer
  self-grant arbitrary scopes or impersonate another subject, and the
  convenience scope `tools:<access>` is synthesised for the static-token
  operator only — an OIDC session carries exactly the scopes its IdP issued,
  so a tool that requires `tools:write` is no longer satisfied by every
  logged-in user. A dry-run (`dryRun: true`) still never executes, but it
  renders the tool's internals (SQL, bindings, URL, body), so it now has to
  pass the same required-scope check and policy deny as a real run, and an
  HTTP tool's dry-run replaces credential-bearing headers
  (`Authorization`, `Cookie`, `X-Api-Key`, …`token`/`secret`/`password`
  names) with `[redacted]`; dry-run events use the same `playground-<hex>`
  session id as real runs. `monitoring.oidc.requiredGroups`
  (new) restricts dashboard logins to id_token `groups` claim members and
  answers a refusal with 403 plus an `auth_failure` audit event. The OIDC
  state cookie now carries the `Secure` attribute behind TLS. The production
  gate gained three fatal checks: `monitoring.playground.enabled` must be
  `false` in production, and a plaintext-HTTP `server.publicUrl` or
  `monitoring.oidc.redirectUri` is rejected — bearer tokens, OAuth metadata
  and monitor session cookies would otherwise cross the wire unencrypted.

- **Extract** (`@atf/extract`): the HTML reference neutraliser that runs before
  LibreOffice lays out an HTML source is rewritten as a tag/attribute tokenizer
  instead of a set of tag regexes. The regexes ended a tag at the first `>`, so
  a `>` inside a quoted attribute value (`<img alt=">" src="http://…">`), a `/`
  used as an attribute separator (`<img/src="http://…">`, `<link/href=…>`,
  `<base/href=…>`), and an unquoted value each left the URL outside the match —
  a server-side request forgery and a local file read (`file:///…`) through the
  converter. CSS `url(…)`/`@import` are now neutralised only after CSS comments,
  CSS escape sequences (`u\72l(`) and HTML character references (`url&#40;…&#41;`)
  are resolved, and a `<style>` body is escaped so a `\3c` cannot re-materialise
  an end tag. Kept markup is re-serialised from the parsed parts, so what
  LibreOffice sees is exactly what the sanitizer decided. A second pass closes
  what the tokenizer still let through: tag and attribute names must be plain
  names (`<img"src=http://…>` and `<img a"src="…">` are dropped, not
  re-emitted), tokens also split at C0 controls, NEL and NBSP so the renderer's
  own parser cannot glue two of our tokens together, the doctype is re-emitted
  as the bare `<!DOCTYPE html>` (an internal subset such as
  `<!ENTITY e SYSTEM "file:///etc/passwd">` or an external identifier no longer
  survives), only raster `data:` images are kept (an SVG data URI is a nested
  document that can reference files itself), `image-set()`, `src()`,
  `image()`, `cross-fade()` and `element()` are removed together with `url()`
  (including vendor-prefixed and escaped spellings), and `<` / `>` inside kept
  attribute values are escaped. The derived-PDF cache key for HTML sources now
  includes a sanitizer revision, so a hardening change is never masked by a PDF
  rendered from the previous rewrite. The neutraliser remains a deny-list: it
  narrows the attack surface, it is not a substitute for
  `CONVERTER_MODE=isolated` — which the production gate now enforces: a `local`
  converter is fatal in `production` unless acknowledged with
  `CONVERTER_ALLOW_LOCAL_HTML=true` (see below).
- **Extract** (`@atf/extract`): document text is data in every model prompt
  (OWASP LLM01). The text layer, the heading hints, a figure's region text and
  caption, and the text and title handed to the summariser now sit inside
  `<rohtext>` / `<hinweise>` / `<beschriftung>` / `<dokumenttext>` / `<titel>`
  elements, every system prompt states that whatever stands there is content to
  transcribe or summarise and never an instruction, a literal closing tag in the
  document is broken so the document cannot end the element itself, and the
  Unicode tag block (U+E0000–E007F, the carrier of "ASCII smuggling") is removed.
  The prompt versions moved (`PAGE_PROMPT_VERSION` 2.1.0, `PASS2_PROMPT_VERSION`
  2.1.0, `SUMMARY_PROMPT_VERSION` 2.2.0), so the prompt hash changes — see
  Migration. Gate tool output and the Runtime taint rule are unchanged.
- **Extract** (`@atf/extract`): `CONVERTER_MODE=local` is now fatal in
  `production` (a warning in staging and development) unless the operator
  acknowledges the in-process converter with `CONVERTER_ALLOW_LOCAL_HTML=true`,
  which keeps it a warning. The HTML neutraliser is a deny-list and the page's
  own markup decides what LibreOffice loads, so `CONVERTER_MODE=isolated` is the
  boundary.
- **Extract** (`@atf/extract`): what Extract kept of a document no longer
  outlives it. `DELETE /v2/documents/{reference}` removes the reference's jobs —
  with the persisted model response of every page and both outboxes, which
  cascade — its upload sessions and `.part` files and the source bytes no other
  job uses, after Search answered (also when Search never held the reference; not
  when the Search call failed, so the retry still finds everything; on behalf of
  an end user only when Search deleted the reference in that caller's scope,
  otherwise the answer is 404 and Extract keeps them), plus the
  cached PDF conversions of its sources. `POST /v1/erasure` removes the same
  derived PDFs. New retention rules bound the rest: `JOB_RETENTION_DAYS` (default
  `0` = keep) sweeps finished jobs, `UPLOAD_SESSION_MAX_AGE_HOURS` (default 72)
  sweeps abandoned resumable uploads, and the derived-PDF cache is bounded by
  `DERIVED_PDF_CACHE_MAX_MB` (2048) and `DERIVED_PDF_CACHE_MAX_AGE_HOURS` (168),
  enforced when a conversion is written, at start and every
  `RETENTION_SWEEP_INTERVAL_MINUTES`, evicting by last use and never a PDF a
  running job of any renderer in the process holds. Sources are not swept
  by age on purpose: `/v2/render` renders zoom and tiles from them for as long as
  Search serves the document. The production gate warns while
  `JOB_RETENTION_DAYS` is `0`.
- **Runtime** (`@atf/runtime`): the erasure orchestrator no longer keeps the
  data subject in clear text forever, no longer leaves a crashed operation
  looking finished, and no longer calls an erasure that addressed nothing
  `complete`. The cleartext identifiers are removed from the stored operation as
  soon as it is `complete` (the signed receipt carries only pseudonymous hashes
  — SHA-256 of tenant id and identifier, pseudonymous personal data, not
  anonymous);
  an operation is stored as `in_progress` with a lease (`updated_at`, 15 min) and
  a replay or retry after the lease takes the zombie over atomically; a request
  that reached no store at all is `failed` with a synthetic
  `runtime.no_stores` result instead of vacuously `complete`; a retry no longer
  sends the runtime-only issuer to remote targets. HTTP: `in_progress` answers
  202.
- **Runtime** (`@atf/runtime`): `COMPLIANCE_POLICY_REQUIRED=true` makes
  production refuse to start without a loaded `compliance-policy.yaml` (a
  warning elsewhere), so residency and data-class rules cannot be silently
  absent; the production-readiness gate checks it and readiness reports
  `compliance_policy: missing`; the production gate warns while `EGRESS_ALLOWED_HOSTS` is empty
  (every public host reachable).
- **Gate** (`@atf/gate`): the monitor's OIDC login is hardened. Authorization
  requests use PKCE (S256) and a `nonce` bound to the signed state cookie; the
  ID-token verifier checks `nonce`, `nbf`, `iat` (60 s skew) and, with several
  audiences, `azp`; discovery and JWKS fetches time out after 10 s and are
  cached for one hour; the discovery `issuer` must equal the configured one.
  Logout is `POST /monitor/logout` (303); `GET /monitor/logout` answers 405 with
  `Allow: POST` so a cross-site link or image cannot end a session.
- **Gate** (`@atf/gate`): `tenantIsolation.issuerTenants` maps each trusted
  OAuth issuer to the tenants it may assert (`"*"` = any). With tenant
  isolation on and a non-empty map, a token from an unlisted issuer is 401 and
  one claiming another tenant is 403; the production gate makes an empty map
  fatal when more than one OAuth issuer is trusted. New readiness warnings:
  tools without `requiredScopes` under `defaultEffect: allow`, `trustProxy` with
  a per-IP limit, a disabled per-identity limiter, and `client_id` among the
  claim names.
- **Gate** (`@atf/gate`): imported MCP tools are `read` only when the
  downstream server declares `annotations.readOnlyHint: true` (and not
  destructive); everything else imports as `write`. An explicit `access` on the
  import or the override still wins. Before, an import without annotations
  defaulted to `read`.
- **Gate: the resolver of an approval comes from the verified identity.** The
  `approver` a client sent was recorded as given; it is now only a display label
  (`declaredApprover`), and the event records who actually resolved the request
  (`ctx.subject`) and whether that was the requester (`selfResolved`).
  `policies.approval.requireDifferentApprover` (default `false`) makes self-resolution
  impossible: the attempt is a 403 and the request is **not** consumed, and the
  resolver must be a different principal of the same tenant holding
  `policies.approval.approverScope` (default `approvals:resolve`). Off by default
  because a Runtime that requests and resolves its own approvals would block itself.
  An approval token records the resolver's owner (`aown`), so with the flag on a token
  whose approver is the requester is rejected even if it was issued before the flag was
  enabled. Production warns while the flag is off and approval rules exist, and when
  pending approvals are per process with more than one replica.
- **Transaction tokens no longer have to be a shared secret.** Search verifies
  ES256/EdDSA transaction tokens against the issuer's JWKS (`TRANSACTION_JWKS_URI`,
  `TRANSACTION_ALGORITHMS`), as the Gate and the Runtime's issuer already could; the
  algorithm in a token is checked against an allow-list before any key is used, HS256
  only against the secret and the asymmetric algorithms only against the JWKS. A
  verifier that holds only public keys cannot mint tokens. The Gate and Search
  production gates warn while HS256 is accepted, and the Gate warns when its audience
  is the shared example value `mcpgate`, so a token minted for one Gate is valid at
  all of them. Rolling migration without a flag day: verifiers accept both, then the
  Runtime switches, then HS256 is dropped (UPGRADE item 20,
  [ADR-0035](docs/adr/0035-asymmetric-transaction-tokens-audience-per-service.md)).
  `@atf/transaction-contract` is unchanged.
- **Gate marks tool results as untrusted content.** Results of executed tools carry
  `_meta["io.atf/content-trust"] = { content_trust: "untrusted", source }`, and the
  Runtime can treat reading one as taint (`TAINT_MODE=on-untrusted-source`, below).
- **Fewer documents lost to the single-process defaults.** Production gates warn when
  `REPLICAS > 1` meets a per-process store: the Runtime media store behind `show_figure`
  links and the receipts transparency log, and the Gate's `server.pagination.secret`
  for paginated database tools. Documented under "Not yet shared between replicas" in
  the upgrade guide, with the two new THREAT-MODEL rows (the `show_figure` capability
  link and the trusted-writer ACL override), each backed by file and line.
- With the production profile a flow whose node `config` contains a key the node type does not read is no longer loaded; it is reported as a flow load failure (readiness `flow_load: degraded`). Elsewhere the load logs a warning.
- Search bounds query cost: `SEARCH_MAX_QUERY_CHARS` (default 400) cuts longer queries at the last space (reported as `query_truncated`, on v1 as the header `X-Query-Truncated: true`), and the lexical OR list uses at most 32 terms (longest first).
- Search: the HyDE and query-embedding caches key entries by tenant and query, so cache hits no longer reveal across tenants which questions were asked.
- Search verifies the `typ` header of transaction tokens (`at+jwt` or `txn+jwt`) and answers 503 `TRANSACTION_KEYS_UNAVAILABLE` (retryable) when the JWKS is unreachable, instead of reporting an invalid token.
- Gate warns in production while `monitoring.oidc.requiredGroups` is empty (every identity-provider user could open the monitor).
- Gate monitor stream filters events by the OIDC session's tenant (`monitoring.tenantScope`, default `session`) and replaces tool results with a SHA-256 digest and size unless `monitoring.includeToolContent` is true.
- Runtime no longer writes the erased subject (user id, e-mail, external ids, issuer) into the audit log; erasure entries carry subject hashes and a keyed pseudonym (`AUDIT_PSEUDONYM_PEPPER`), and policy denials use the user id instead of the e-mail as actor.
- Search activity stream: events are filtered by the subscriber's tenant and carry only the names of metadata filters, not their values.
- Gate checks required scopes before approval, so callers without the scopes no longer create approval requests or consume approval tokens.
- Gate runs the approval lookup tool through the regular dispatcher (policy, rate limit, audit).
- Services warn when `ATF_PROFILE` downgrades a production service variable (for example `NODE_ENV=production` with `ATF_PROFILE=staging`); `@atf/security-kit` reports it as `shadowedProduction`.
- `@atf/security-kit`: the rate-limit middleware accepts `failMode: "closed"` and answers 503 when its shared backend throws (default stays `"open"`). The Gate normalizes `tenantIsolation.issuerTenants` keys (trailing slash), compares issuers without it, and refuses to start when a key is not a configured issuer. The Gate production check warns when a tool binds a mutable identity claim (`:ctx.claims.name`, `.email`, `.preferred_username`).
- Gate refuses tool bindings that hand out the caller's credentials (`:ctx.rawToken`, the whole `:ctx.headers` object, and the `authorization`, `proxy-authorization` and `cookie` headers) when the configuration loads and when a binding is resolved; other single headers stay bindable.
- Gate no longer closes an SSE session when a request with a bad token or another identity names its session id; only the owner's own connection ends it.
- The egress guard blocks the documentation address ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`) in addition to the private and reserved ranges it already refused.
- Eval regex assertions reject nested-quantifier patterns and match at most 100 000 characters.
- Extract's HTML sanitizer also drops javascript:, vbscript: and data: link targets (including entity-encoded forms and numeric character references without a closing `;`).

### Added

- Control shows a flow-health page: load failures, database flows shadowing files, versions/digests and the latest eval result per flow.
- `atf-verify` verifies Evidence Bundles, Ed25519 erasure receipts and audit-log exports (with anchors) offline, in addition to decision receipts; releases ship a Linux x64 binary.
- Evidence-bound flow releases: bench files (`flows/bench/<flow>.bench.yaml`), `cli.ts flows release` (bench gate, semver check against a base revision, baseline comparison) and Ed25519-signed release receipts verifiable with `atf-verify --release-receipt`. Version, digest and the base-revision check use the resolved flow (included sub-flows, prompts and model shortcuts), and a receipt is only signed when every bench case reports that `flow_version` and `flow_digest` in its debug trace.
- Search traceability: `trace` follows an identifier across two points in time (added/removed/changed occurrences; a hit counts only when the content contains the identifier itself, and activity events record only its length) and `document_diff` (MCP and `GET /v2/documents/{base_ref}/diff`) compares a document's units between two points in time with one query per side, also for units outside a section, and reports `truncated` when a side exceeds the unit limit.
- Search `FTS_CONTEXTUAL_HEADER=on` adds the document title and section path (weight D) to the lexical index of newly ingested chunks.
- Search `FTS_COMPOUND_SPLIT=query` splits long German compounds in the query against the collection's lexicon and adds the parts to the lexical OR list.
- **Packages** (`@atf/canonical-json`, `@atf/mcp-2026`): two shared
  implementation packages replace copy-pasted platform primitives.
  `@atf/canonical-json` is the single canonical serialiser — every
  hash-bound payload on the platform (signed erasure receipts, the audit
  chain, evidence and action-contract hashes, flow bundle hashes, policy
  hashes, cache keys, fingerprints) previously had its own variant of
  "sort keys, stringify deterministically", in five slightly different
  flavours whose outputs silently disagreed on edge cases (integer-like
  object keys, `Set` ordering, locale digits). It exposes the byte families
  the call sites actually depend on — a `JSON.stringify`-compatible family
  (which re-enumerates integer-like keys numerically first, matching V8) and
  a purely lexicographic concat family — plus canonical `Set` serialisation.
  Differential tests pin every migrated call site to its previous bytes.
  `@atf/mcp-2026` is the shared MCP `2026-07-28` stateless-protocol core:
  protocol/header constants, JSON-RPC error bodies and codes, request
  validation (protocol-meta negotiation, method/params shape), pagination,
  the stateless response envelope, and the client-side request metadata —
  previously implemented three times independently (Gate server, Search
  server, Runtime client) with drifting error codes and validation order.
- **Runtime** (`@atf/runtime`): the evidence chain becomes independently
  verifiable by third parties (ADR-0030). A new `EVIDENCE_SIGNING_KEY`
  (Ed25519, PEM PKCS#8 or a base64-encoded 32-byte seed) makes the platform
  sign audit chain anchors, evidence bundles, and — as a fallback — erasure
  receipts with one asymmetric identity instead of the operator's shared
  HMAC secret. The public key is published at
  `GET /.well-known/atf-evidence-jwks.json` (OKP/Ed25519, `kid` =
  `base64url(sha256(publicKey))`, never the private part), so an auditor or
  customer verifies an artefact offline with no shared secret and no
  dependency on the platform being reachable.
  `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file> [--kid <kid>]`
  (run in `apps/runtime` of a source checkout) verifies Ed25519 bundles
  against the JWKS — the bundle's own `kid` auto-selects the key — while
  `--secret <secret>` keeps verifying legacy HMAC artefacts. Signed
  envelopes carry an `alg`/`algorithm` field (`ed25519` / `hmac-sha256`;
  absent = legacy HMAC) and verification branches on it strictly: key
  material that cannot check the envelope's algorithm, or a mismatched
  `kid`, is a `signature_mismatch`, never a silent fallback.
- **Control** (`@atf/control`): the evidence-bundle download tooltip now
  names the offline verify command matching the bundle's algorithm
  (`--jwks …` for Ed25519, `--secret …` for legacy HMAC), in German and
  English.
- **Packages** (`@atf/security-kit`): the rate-limit middleware accepts a
  shared `backend` (any `RateLimitBackend`) plus an `onBackendError` hook,
  and the package ships `createLazyRedisRateLimitBackend` — a Redis GCRA
  backend that connects lazily on first request (cached, retried on failure,
  `redis` imported dynamically so it stays an optional dependency) and is
  closed via the limiter's `close()`. A backend with a synchronous
  `takeSync` keeps the middleware sync; promise backends are awaited.
- **Search / Extract** (`@atf/search`, `@atf/extract`): `RATE_LIMIT_REDIS_URL`
  moves the HTTP rate limiters (Search `vectorsearch:rl`; Extract
  `extract:rl` and the distinct `extract:render-rl` render bucket) onto a
  shared Redis budget, so a multi-replica deployment throttles each client
  once fleet-wide instead of once per pod. These backends fail open on Redis
  errors — availability parity with the in-memory limiter they replace.
  Both services also gain `REPLICAS` (default 1, declared topology for the
  production gate).
- **Runtime** (`@atf/runtime`): the GitOps webhook router now shares the
  middleware's `REDIS_URL`-backed rate-limit store instead of creating a
  private in-memory one, so the per-IP webhook budget is fleet-wide;
  `REPLICAS` (default 1) declares the replica count to the production gate.
- **Search** (`@atf/search`): `RERANK_BATCH_SIZE` (16) and
  `RERANK_BATCH_CONCURRENCY` (2) split a rerank over many candidates into
  bounded parallel batches; `HYDE_CACHE_TTL_SECONDS` (600, `0` = off) caches
  hypothetical-document generations (LRU 256, concurrent identical queries share
  one call); `BATCH_WORKER_EMBED_CONCURRENCY` (4) embeds a batch's chunks in
  parallel and the worker drains up to 25 batches per wake-up (honouring
  `stop()`); per-hit context expansion runs at most 8 hits in parallel (fixed,
  `src/concurrency.ts`, stops starting work after the first failure).
  `/v2/search` reads `X-Valid-At` like the other search routes, and
  `collection_stats` reports `capabilities { unitRows, unitGraph, outline,
  pages }` so a client can tell which retrieval features a collection supports.
- **Extract** (`@atf/extract`): `/v2/render` renders a page or a region once, at
  the DPI it chose and reports — see Changed. `CONVERTER_ALLOW_LOCAL_HTML`,
  `DERIVED_PDF_CACHE_MAX_MB`, `DERIVED_PDF_CACHE_MAX_AGE_HOURS`,
  `JOB_RETENTION_DAYS`, `UPLOAD_SESSION_MAX_AGE_HOURS` and
  `RETENTION_SWEEP_INTERVAL_MINUTES` (60) are new settings; the retention sweep
  runs at start and then hourly and never touches a running or paused job.
- **Runtime** (`@atf/runtime`): a flow file that fails to load is visible.
  `/health/ready` gains an informational `flow_load` check (`degraded` with the
  number of failed files as `flow_load_failures`, never a 503; file names and
  reasons stay in the flow load log, not in the unauthenticated probe) and the gauge
  `aiperator_flow_load_failures` follows the same ledger. A flow file deleted
  while the Runtime runs stops being served (the watcher ignored `unlink`).
- **Helm** (`deploy/helm/atf`): `global.profile` (opt-in; `""`, `development`,
  `staging`, `production`, `test`, validated by `values.schema.json`) is
  exported as `ATF_PROFILE` to Runtime, Gate, Search and Extract, and every
  service now receives `REPLICAS` (Gate: `MCPGATE_REPLICAS`) — the HPA's
  `maxReplicas` when autoscaling is on, else `replicaCount` — so the production
  gates judge the real topology. CI renders and asserts both.
- **Docs**: `docs/EU-AI-ACT.md` maps roles, the Annex III check and Art. 9, 10,
  12–15, 26 and 50 to the controls ATF provides, the evidence they produce and
  what stays with the operator; Art. 50 marking is not provided by the product.
- **Extract: `pages` selects a window of the source** (`@atf/extract-contract` 2.4.0,
  wire `atf-extract/2.4.0`). `"5"`, `"3-10"`, `"5-"` and `"-8"` are accepted, lists and
  reversed windows are a 400, a `from` past the end of the source fails the job before
  any model call, and `MAX_PAGES` counts the window. Pages keep the source's numbers;
  `document.begin` and `document.end` carry the optional `firstPage`, `pageCount` is the
  last page. The emitter keeps batch seqs absolute and puts `document.begin` into the
  first batch actually sent; Search checks completeness over `[firstPage, pageCount]`
  and spans the document unit over the window. A native source (BPMN, a chart-free
  XLSX) ignores `pages`.
- **Extract: render window.** `PreparedSource.prefetch` renders a run of pages with one
  `pdfinfo` and one `pdftoppm` call (the output files are read, not guessed, so the
  zero-padding of poppler cannot break it), looking up to eight pages ahead of the pages
  in flight; page sizes come from the window's `pdfinfo`, and runs of oversized pages are
  rendered as one window at their adaptive DPI; the figure-resolution render of a page is shared by all of its crops and
  by the crop re-cut at upload time. `scripts/bench-render-window.ts` measures it: with
  600 pages at 50 DPI 47.1 → 13.0 ms/page (window of 8, 3.6×) and 10.7 ms/page
  (window of 16); at the production 200 DPI rasterising dominates and the saving is
  6–11 %.
- **Extract: `scripts/bench-time-to-searchable.ts`.** Runs the real emitter against a
  simulated Search and reports when the first pages become searchable and when all are.
- **Evaluation: `bun run eval:extract-quality`.** Character error rate, Heading-F1 (text
  and strict with level) and table TEDS (and TEDS-S) of what Extract produced against a
  golden set, with a gating mode (`--max-cer`, `--min-heading-f1`, `--min-teds`) and a
  documented format for your own sets. The shipped set is synthetic; customer sets stay
  outside the repository.
- **Runtime: `TAINT_MODE=on-untrusted-source`** (default `on-finding`) taints an execution
  as soon as a result labelled untrusted by the Gate or Search, or a result of an MCP
  server without `contentTrust: trusted`, is read, so
  `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL` also covers reads without a detected injection.
  Mark internal, curated servers with `contentTrust: trusted`.
- **Runtime: `AI_DISCLOSURE=header|field`** (default `off`) marks successful completions
  as AI-generated: `X-AI-Generated: true` on `/v1/chat/completions`, `/v1/responses` and
  `/v1/responses/{id}`, or `metadata.ai_generated: "true"` (a string, as OpenAI metadata
  requires) in a JSON body (a stream carries the header); flows served as MCP tools carry
  `_meta["io.atf/ai-generated"]`.
- **Health reports an open door.** `"auth": "disabled"` in Runtime `/health` and
  `/health/ready`, Search and Extract `/health`, Gate `/healthz` and `/readyz` when
  `AUTHN_MODE=disabled`; the Runtime also warns at start.
- **Flow evaluation: structured assertions.** Eval cases and matrix tasks accept `contains`,
  `regex`, `jsonPath` (restricted `$.a.b[0]` syntax), `toolCalled` (min/max, `server/tool`
  or bare name) and `maxTokens` next to the reference answer; a cell passes when its
  reference score and every assertion do. Existing cases are unchanged.
- **Search: `TRANSACTION_JWKS_URI` and `TRANSACTION_ALGORITHMS`**, see Security.
- `cli.ts validate` and `POST /flows/validate` warn about node `config` keys the node type does not read (with a "did you mean" suggestion). Keys starting with `x-` are reserved for author annotations and never reported.
- Search: a PostgreSQL integration test pins lexical MRR@10 on the synthetic golden set (all-terms-first ranking at least 0.9 and never below the plain OR ranking).
- Runtime hides Search navigation tools that the pinned collection cannot serve, based on `collection_stats.capabilities` (cached, `COLLECTION_CAPABILITY_TTL_MS`, fail-open).
- Gate 2026 endpoint: `approvals/list` (own requests, or the tenant's requests for holders of `approverScope` when `requireDifferentApprover` is on) and `approvals/get` (status and, once approved, the one-shot approval token for the requester).
- Gate keeps pending approvals of the 2026 endpoint in Redis when a Redis URL is configured (`MCPGATE_TRANSACTION_REDIS_URL`, `server.rateLimit.store`, or `monitoring.cluster`), so request and resolve may hit different replicas.
- Agent harness: `coverageQueue.lanes` (1–8, default 1) works on several coverage assignments of the plannerless queue concurrently, each as its own delegation instance with separate tokens, prompts and trace entries; results are merged in assignment order.
- Agent harness emits structured progress (`phase`, tasks done/total, coverage, elapsed time, ETA) and records the last value per node in the debug trace. Streaming chat clients receive it as the SSE event `atf.progress` only when they opt in with `X-ATF-Progress: 1` or `metadata.atf_progress: true`; without the opt-in the stream carries only OpenAI-compatible chunks.
- `GET /v1/jobs/{id}` reports `progress` of a running agent-harness job (updated at most every 2 s).
- Agent harness `statusLanguage` (`en` or `de`) renders all status and task labels in one language; without it the previous texts stay unchanged.
- Flows accept `budgets` (`maxTokens`, `maxToolCalls`, `maxWallMs`): the execution stops before the next model or tool call once a limit is reached and finishes with `finishReason: budget_exceeded`. Token and wall-clock limits are checked before every model step of a tool loop, and an exhausted tool-call budget ends the loop instead of being reported to the model as a tool error.
- Model pools accept `sticky: execution | conversation` to keep calls of one execution or conversation on the same endpoint (prefix-cache affinity); failover still applies.
- Eval assertions `finishReason` (`equals`/`notEquals`) and `noDiagnostic` (e.g. `loop_blocked`) check the execution trace.
- `config.toolArgs` accepts `"*"` and `"<server>/*"` keys; wildcard arguments apply to tools that declare them, exact refs still win.
- `CHARS_PER_TOKEN` (default 4) and a per-model `charsPerToken` tune the token estimate used for context fitting and tool-result budgets.
- An LLM call rejected for exceeding the context length is retried once with a 25 % smaller context budget (diagnostic `context_length_retry`).
- Helm: `global.redis` exports a Redis URL from an existing Secret to Runtime (`REDIS_URL`) and Search/Extract (`RATE_LIMIT_REDIS_URL`); NOTES warn about the in-pod converter acknowledgement and about multiple replicas without Redis.
- `docs/CONFIGURATION.md` includes a generated reference of the Gate configuration file.
- `docs/METRICS-AND-RETENTION.md` lists the exported metrics with suggested alerts and every retention location with its setting.
- Search checks at startup that the embedding fallback produces vectors in the same space (canary, cosine ≥ 0.99) and counts embeddings per source.
- Search signs evidence packs with Ed25519 when `SEARCH_EVIDENCE_SIGNING_KEY` is set and publishes the key at `/.well-known/atf-search-evidence-jwks.json`.
- `@atf/security-kit`: the JWT verifier accepts `allowedTypes` to enforce the JWT `typ` header; the Gate exposes it as `auth.oauth.allowedTokenTypes` and warns in production while it is empty.
- READMEs for `@atf/canonical-json`, `@atf/mcp-2026`, `@atf/security-kit` and `@atf/observability`.
- Gate: an `mcpServers` import override accepts `pin` (SHA-256 of the downstream `description`, `inputSchema` and `annotations`); a tool whose advertised definition no longer matches is not exposed and an error with the seen digest is logged.
- `@atf/canonical-json` ships a byte specification and test vectors for every mode.
- Runtime publishes all public signing keys with their purpose at `/.well-known/atf-jwks.json`; the per-purpose JWKS endpoints remain.
- LLM nodes accept `stickyArgs`: an argument the model sets once (e.g. `valid_at`) is reused for later tool calls of the execution.
- Sub-flow includes accept `patches` that deep-merge into included nodes.
- Search groups documents ingested with the same `split_of` metadata as `split_document` and lists siblings in `get_documents`.
- Search `retrieve_for_answer` (MCP) and `POST /v2/retrieve`: rule-based question decomposition, multi-query reciprocal-rank fusion, optional rerank against the original question, de-duplication and packing into a token budget.
- LLM nodes accept `cascade`: an answer with too few citations, a failed sources check, a weak top grounding score or a length cut-off is regenerated once with `escalateTo` (diagnostic `cascade_escalated`, metric `aiperator_cascade_escalations_total`).
- Governance posture report: `GET /monitoring/posture` and `cli.ts posture` list which controls are active (evidence key, anchors, egress, taint, disclosure, policy, receipts, shared state, flow load, audit pseudonym pepper, PII vault, approval gate, authentication mode, replicas) as ok/warn/fail with an `area` per check, and name the operational profile, the preset and the production-gate result.
- Search results carry the `revision_id` of their revision.

### Changed

- **Runtime** (`@atf/runtime`): online (DB) flows still override same-id file
  flows, but the override is no longer silent (ADR 0034). Startup logs a
  warning naming every flow whose file version is shadowed by a published
  online flow; `GET /flows/:id` reports `shadowsFile: true` plus the current
  file baseline as `fileDefinition`; publish and rollback record
  `shadowsFile` in the audit entry and response, and deleting an online flow
  that reveals a file flow reports `revealsFile`. The GitOps webhook now
  intersects reloaded flows with the shadowed set: a trigger-branch push that
  has no runtime effect returns `shadowedFlows: [...]`, logs a warning, and
  says so in its message — instead of reporting a reload that never went live.
- **Extract** (`@atf/extract`): three throughput ceilings in the v2 pipeline
  are removed (ADR 0033). The page scheduler no longer advances in
  lockstep batches — `drivePages` refills a freed `PAGE_CONCURRENCY` slot
  as soon as a page settles instead of waiting for the whole batch, so one
  slow OCR page no longer idles the other slots, while an ordered publish
  buffer keeps page events and cumulative usage totals arriving in ascending
  page order (a page that failed transiently does not hold back its
  successors and, if it succeeds on a retry, follows them) (early pause/failure/lease-loss outcomes flush the
  ordered prefix first, then drain in-flight pages; peak in-flight stays
  ≤ `PAGE_CONCURRENCY`). A worker can now run several jobs in parallel via
  the new `JOB_CONCURRENCY` (default 1 — sequential as before, range 1–32):
  `loop()` keeps that many job lanes, claims only while below the limit
  (the fleet-wide large-job lane cap in the claim SQL is untouched), and
  `stop()` drains every lane before resolving; `tick()` still processes
  exactly one job. And derived PDFs are reused across runs under
  `TEMP_DIR/derived-pdf` (`DERIVED_PDF_CACHE`, default true): a PDF source
  stored under the scratch root is rendered in place with no per-run copy,
  and a LibreOffice conversion is published once under a key of the source
  sha256 plus the converter identity (`soffice --version`; only a successful
  probe is remembered, and while it fails the conversion runs uncached with a
  warning, so an upgrade invalidates old conversions) and hard-linked in atomically
  on later runs — retries and re-ingestion of an unchanged document skip
  the conversion entirely. Disabling the cache or `JOB_CONCURRENCY=1`
  reproduces the previous behaviour through configuration alone. See
  [ADR 0033](docs/adr/0033-extract-throughput-continuous-refill-job-lanes-derived-pdf-cache.md).
- **Consolidation** (no behaviour change): the three MCP 2026
  implementations (Gate `mcp/stateless-2026.ts`, Search `handlers/mcp.ts`,
  Runtime `mcp/wrapper/stateless-2026-client.ts`) now delegate to
  `@atf/mcp-2026`; per-endpoint differences (which methods are named,
  whether JSON-RPC 2.0 is required, keyed vs. bare `resources/read`) are
  configuration on the shared validator, not divergent code. The eleven
  canonical-JSON call sites across Runtime, Gate, Search and Extract
  likewise import `@atf/canonical-json`; the Gate's legacy `crypto/canonical.ts`
  stays verbatim on purpose — its quirky output is bound into signed cursors
  and approval digests that must verify across restarts.
- **Search** (`@atf/search`): `/v2/search` and the MCP `search` tool now run
  on one shared retrieval pipeline (`handlers/retrieval-pipeline.ts`) —
  embed → sparse → candidates → rerank → document groups → diversify/group →
  relevance threshold → slice → expansion → figure lookup. The two
  orchestrations had copy-pasted this sequence and drifted: different rerank
  input fitting, different threshold position relative to the limit slice,
  different over-fetch and sparse-failure handling. The deliberate
  per-endpoint differences (v2: token-fitted rerank with a two-candidate
  floor and the threshold AFTER the slice; MCP: unfitted rerank and the
  threshold BEFORE it) are explicit pipeline configuration. The v1 `/search`
  handler keeps its own header-driven orchestration; it
  already shares the stage primitives.
- **All services** (Runtime, Gate, Search, Extract): the production-readiness
  gates now key off an explicit operational profile resolved identically
  everywhere through `@atf/security-kit`
  (`packages/security-kit/src/prod-gate/profile.ts`). The platform-wide
  `ATF_PROFILE` (new) wins over the service variable (`APP_ENV`,
  `MCPGATE_ENV`, `NODE_ENV`), which previously had to spell `production`
  exactly and inconsistently per service. The value set is closed —
  `development`, `staging`, `production`, `test` — with unified trim +
  lowercase normalisation, and a non-blank unknown value now aborts startup
  with a named error instead of silently falling back to `development`, where
  every gate stays off: a typo like `prod` can no longer disable the
  production gates unnoticed. `staging` runs the checks in warn mode — the
  full fatal list is reported, startup continues — so a pre-production system
  surfaces exactly what a promotion to `production` would refuse. Existing
  `APP_ENV`/`MCPGATE_ENV`/`NODE_ENV` deployments keep working unchanged;
  Runtime's unrelated `PROFILE` preset variable (dev/secure/regulated config
  bundles) is untouched.
- **Runtime** (`@atf/runtime`): the evidence chain prefers Ed25519 wherever
  `EVIDENCE_SIGNING_KEY` is configured — audit anchors
  (`EVIDENCE_SIGNING_KEY` > `AUDIT_ANCHOR_SECRET` > inactive), evidence
  bundles (`EVIDENCE_SIGNING_KEY` > `EVIDENCE_BUNDLE_SECRET` >
  `AUDIT_ANCHOR_SECRET` > endpoint `404`), and erasure receipts
  (`ERASURE_RECEIPT_SIGNING_KEY` > `EVIDENCE_SIGNING_KEY` >
  `AUDIT_ANCHOR_SECRET` HMAC > unsigned). HMAC is demoted to a verify-only
  legacy path: pre-existing HMAC anchors and bundles verify byte-identically
  to before, and HMAC signing output is unchanged, so no historical artefact
  becomes unverifiable. The production gate warns (non-fatal) when a
  deployment still signs evidence with HMAC only, recommending
  `EVIDENCE_SIGNING_KEY` so third parties can verify independently; the
  compliance dossier and audit-anchor hints report which algorithm signed
  each artefact and how to check it.
- **Production gates** (Search, Extract, Runtime): the
  production-readiness checks now know the declared replica count
  (`REPLICAS`, default 1, see ADR 0031). `REPLICAS > 1` without a shared
  rate-limit store is fatal for Search and Extract (no
  `RATE_LIMIT_REDIS_URL`) and a warning for Runtime (no `REDIS_URL`),
  because every replica would otherwise hand out the full budget
  independently; Runtime additionally warns when `REPLICAS > 1` combined
  with `RED_TEAM_SCHEDULE_FLOWS`, which would run each scheduled test once
  per replica. Single-container defaults are unchanged and stay silent.
- **Packages** (independent SemVer): `@atf/security-kit` 1.0.0 → 1.4.0 (new
  exports `createLazyRedisRateLimitBackend` and the operational-profile
  resolver with `shadowedProduction`, JWT `allowedTypes`, rate-limit
  `failMode: "closed"`; `RedisEvalClient.eval` now has the `redis` v4/v5 options-object
  signature — the previous positional form never worked against any `redis`
  version the services install, see Fixed, and the package is workspace-private,
  so every in-repo consumer moved in the same change);
  `@atf/evidence-contract` 1.1.0 → 1.1.1 and `@atf/erasure-contract` 1.0.0 →
  1.0.1 (their canonicalisers are now thin re-exports of `@atf/canonical-json`;
  public API, wire constants and output bytes are unchanged, pinned by
  differential tests); `@atf/extract-contract` 2.3.0 → 2.4.0 (page windows, see
  Added). New packages `@atf/canonical-json` 1.0.1 and `@atf/mcp-2026` 1.0.0 run
  in the CI contract job. All `workspace:` references are
  exact. `@atf/schema-compatibility` keeps its own stable-value helper on
  purpose: it is not part of a signed or hashed payload.
- **Search** (`@atf/search`): the BM25 lexical path needs a `USING bm25` index
  on the table; the index is detected per table at start, and a table without
  one falls back to the full-text path with a one-time warning (before, a
  missing index failed the query); a table that gets the index later is picked
  up within a minute, without a restart. The activity summary no longer carries the
  query text (`query[N chars]`). `group_by_document` inserts `[…]`
  (`CHUNK_GAP_MARKER`) between chunks that are not adjacent in the document, so
  the model does not read two distant passages as one. The MCP search tool
  embeds the same normalised query as the REST routes and counts tokens with the
  configured counter.
- **Extract** (`@atf/extract`): `/v2/render` no longer converts and rasterises
  twice per request. It reads the page size (`pdfinfo`, with `/Rotate` applied)
  without rendering, picks the DPI, and rasterises only the requested region in
  one `pdftoppm -x -y -W -H` call; `X-Render-Dpi` is the resolution of the
  delivered pixels, a target above what the source can deliver returns the
  pixels it has instead of an enlarged image, and the tile named in
  `X-Render-Tile` comes from the page's real size. A whole page without a target
  keeps the pipeline's adaptive DPI. Office/HTML sources reuse the derived-PDF
  cache instead of converting per zoom.
- **Extract** (`@atf/extract`): the LibreOffice version is part of the pipeline
  hash (probed three times at start; an unknown identity leaves the hash as it
  was and bypasses the cache), so a converter upgrade is a resume decision and
  not a silent mix of two renderings.
- **Tooling**: `check:flow-versions` also treats `compliance-policy`, `access`,
  `canary` and `experiments` as shared files every flow depends on, and
  `constants` for flows that reference `const.<name>`. `cli.ts validate` names
  the offending fields of a schema failure and reports an unresolvable include,
  variable or shortcut for the file instead of aborting.
- **Release pipeline**: the release SBOM includes the desktop outpost's Rust
  crates (`--include-cargo`), the supply-chain bundle gets a GitHub provenance
  attestation, Dependabot now covers `deploy/images`, `apps/outpost` and the
  `outpost-desktop` crates, and the quickstart image is pinned by digest.
- **Extract: segments are committed while the hand-over is still running.** The emitter
  used to commit them after the last batch, so "progressive visibility" only began when
  everything was already in Search. A segment is now committed as soon as its batches and
  its assets are acknowledged. `SEGMENT_PAGES` defaults to 100 (was 250). Simulated
  hand-over of 600 pages, 20-page batches: the first pages are searchable after
  5.6 s → 1.0 s (100 pages instead of all 600), everything after 6.0 s → 6.5 s (+8 %).
  `EMIT_BATCH_PAGES` stays 20 — the benchmark shows a smaller batch buys no earlier
  visibility and costs a PUT per batch (10-page batches: +19 % hand-over, first pages after 1.2 s instead of 1.0 s). The processing
  phase that precedes the hand-over is unchanged. The batch size is frozen per job when its
  first batch is sent, so a changed setting never re-maps an open revision; the threshold
  above which `POST /v1/ingest` answers `202` is decoupled from `SEGMENT_PAGES` and stays
  at 250 pages.
- **Gate: approver semantics** (see Security); an approval event now has `declaredApprover`
  and `selfResolved`.
- Search: the lexical list ranks chunks that contain all query terms first (then by score).
  On the synthetic golden set this restores lexical MRR@10 from 0.70 to 1.00 while keeping
  the recall gain of the OR list.
- Search: `group_by_document` keeps at most `SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT`
  (default 8) best-scoring chunks per document and marks the result `truncated` with
  `omitted_chunks`; previously the whole candidate pool became context.
- Search validates transaction envelopes with the shared `@atf/transaction-contract`
  consumer schema; additional issuer claims no longer make Search reject an otherwise
  valid token.
- The `regulated` presets also set `TAINT_MODE=on-untrusted-source`, `AI_DISCLOSURE=header` and `COMPLIANCE_POLICY_REQUIRED=true`; in production they make a missing `AUDIT_ANCHOR_FILE`, an empty `EGRESS_ALLOWED_HOSTS` and a missing `EVIDENCE_SIGNING_KEY` fatal.
- The configuration preset variable is now `ATF_PRESET` (see Deprecated for `PROFILE`). Setting both to different values stops startup.
- Runtime keeps per-node execution state per delegation instance, and the debug trace names the instance (`instance_id`) when an agent-harness task delegated to a node.
- Search keeps the scores of successful rerank batches when one batch fails (`rerank.partial`), and `RERANK_GLOBAL_CONCURRENCY` bounds rerank calls per process.
- Search MCP results are compact JSON by default (`SEARCH_MCP_PRETTY_JSON=true` restores indentation); `collection_stats` uses one scan.
- GenAI spans carry `gen_ai.provider.name` in addition to `gen_ai.system`.
- The audit-anchor production warning recommends EVIDENCE_SIGNING_KEY.
- Dependabot uses the bun ecosystem; CI uploads HIGH image findings as SARIF without failing.
- GitHub releases use the version's CHANGELOG section as release notes.

### Deprecated

- The Runtime configuration preset variable `PROFILE` is a deprecated alias of `ATF_PRESET`; it keeps working and logs a warning.
- The Gate options `auth.oauth.allowAnyIssuer` and `allowAnyAudience` (also under `additionalIssuers`): they have had no effect since the issuer and audience became mandatory, and setting them to `true` now logs a startup warning.

### Fixed

- **Security kit / Gate** (`@atf/security-kit`, `@atf/gate`): the Redis
  rate-limit backend called `client.eval(script, numKeys, …)` — the redis
  v3 positional signature. The installed `redis` v4+/v5 client reads the
  second argument as an options object (`{ keys, arguments }`), so the call
  reached the server as `EVAL script 0`: the GCRA Lua script ran with no
  keys, threw on `KEYS[1]`, and — under the backend's fail-closed default —
  the Gate's per-identity Redis limiter denied **every** request against a
  real Redis v5. The call now uses the options-object form, with a
  regression test pinning the wire shape. Unit tests had missed this
  because the test fake mirrored the legacy call.
- **Extract** (`@atf/extract`): `MAX_PAGES` is now enforced on the v2 job
  runner, not only the v1 extractor. A v2 job that would process more pages
  than the limit — vision or native (BPMN/XLSX) — fails terminally before the
  first page is sent to the vision model and before emit-outbox staging, so an
  over-long upload with no token budget, or no attributable tenant, can no
  longer drive vision over every page unbounded. The check counts the pages the
  job covers (`min(document pages, pages.to)`), not the raw document size, and
  runs after the document was prepared (a LibreOffice conversion, and where
  version resolution needs it one summary call, can precede the refusal).
  `MAX_PAGES=0` still disables the check; tenant-less jobs remain bounded only
  by `MAX_PAGES` and the per-job token budget (the daily page budget needs a
  tenant). The production gate also warns when `CONVERTER_MODE=local` runs the
  converter inside the service's own container.
- **Search** (`@atf/search`): the lexical branch of FTS and hybrid search now
  matches query terms with OR (`to_tsquery` over quoted, deduplicated terms)
  instead of AND (`websearch_to_tsquery`). Natural-language questions no longer
  leave the lexical branch empty, which had silently degraded hybrid search to
  pure vector search. Scoring stays `ts_rank_cd` with length normalisation; the
  ParadeDB/VectorChord BM25 path is unchanged. **Behaviour change:** the
  lexical branch no longer understands `websearch_to_tsquery` syntax — quoted
  phrases (`"exact phrase"`), `-exclusion` and `OR` in a query are now ordinary
  terms; hyphenated words such as `E-Mail` or `A-009` stay one term, matching
  the whole-word lexeme `to_tsvector` indexes for them. An integration
  test against a real Postgres shows the legacy AND query matching nothing for a
  question whose chunk shares only some of its words, and the OR list finding
  it. Rankings of existing collections change; re-run your retrieval eval after
  upgrading (see Migration).
- **Search** (`@atf/search`): diversification is scoped per document. Equal
  `section_path` values in different documents (e.g. a chapter named
  `1 Einleitung` in several files) each get their own cap, and the
  same-`table_id` / same-`figure_id` collapse keys on the document as well —
  Extract numbers tables and figures per document, so two data sheets that both
  carry "table 1" no longer lose the lower-scoring one in `/v2/search`.
- **Search** (`@atf/search`): `/v2/search` now records the real search duration
  in the per-tenant search statistics instead of a constant `0`.
- **Search** (`@atf/search`): startup now fails when `EMBED_FALLBACK_MODEL` is
  set to a value different from `EMBED_MODEL` — the fallback could mix two
  vector spaces into one index. Operators who know both names serve the same
  underlying model (e.g. an Ollama tag and a TEI repo id for the same base
  model) opt in explicitly with `EMBED_FALLBACK_SAME_SPACE=true`.
- **Control** (`@atf/control`): graph edges are visible again. The design
  tokens are HSL triplets (`215 20% 65%`), and a bare `var(--edge-*)` as an SVG
  `stroke` computes to `none`; every edge, marker and canvas-dot colour is now
  wrapped in `hsl(…)`. The server-safe `translate` / `interpolate` helpers moved
  to `lib/i18n/translate.ts` (outside the `"use client"` provider module) so
  server components and loading boundaries no longer import a client reference.
- **Documentation** (no behaviour change): `docs/runbooks/backup-restore.md`
  named stores that do not exist — a Gate Postgres database (the Gate is
  stateless; its only persistent state is the optional monitor audit JSONL
  file) and an "Extract outstore" (the v2 source documents live in Extract's
  `SOURCE_STORE_DIR`, and since 0.18.0 the asset bytes live in Search's
  `vs_assets`). Following the old runbook skipped the Search database dump
  entirely, which with the default `ASSET_STORE_BACKEND=postgres` is the only
  copy of every stored figure. The dump/restore commands, the anchor-file
  pairing (Runtime, not Gate), the PITR section, and the evidence step of
  `docs/runbooks/incident.md` now match the actual stores.
  `docs/UPGRADE.md` covers 0.17 and 0.18 (v1 asset-route removal, `vs_assets`
  as the single asset store, the text-only rollback caveat).
- **Runtime** (`@atf/runtime`): the chokidar watcher handled `add` and `change`
  but not `unlink`, so a deleted flow stayed registered and executable until the
  next restart; a late read of a just-deleted file can no longer resurrect its
  load-failure entry.
- **Extract** (`@atf/extract`): `readPageSize` ignored `Page rot:`, so the size
  of a page with `/Rotate 90|270` was transposed for every consumer (adaptive
  DPI, tile planning, region renders).
- **Extract: `pages` was accepted and silently ignored.** The API stored the string as sent
  while the runner only read an object (`{to}`), so a request for a page range processed
  and billed the whole document. It is validated, normalised and applied now (see Added).
- The secret-scanning job no longer fails on reviewed false positives (type annotations
  matched by the generic-api-key rule); they are listed by fingerprint in `.gitleaksignore`,
  and `DEVELOPMENT.md` lists gitleaks as a local gate.
- Flow files expand YAML merge keys (`<<: *anchor`); previously the key stayed literal and the
  merged settings were silently missing. A merge key that cannot be expanded is now a load
  error naming the file and the path.
- Search no longer generates invalid SQL for a VectorChord-bm25 index: only ParadeDB pg_search is used for `FTS_RANKER=bm25`; any other BM25 index falls back to `ts_rank_cd`.
- Search documentation and comments no longer claim that the lexical ranker normalises by document length; flag 32 maps the score to rank/(rank+1).
- Erasure receipts signed with Ed25519 carry the key id (`kid`) in the envelope, and the public key of `ERASURE_RECEIPT_SIGNING_KEY` is published in `/.well-known/atf-evidence-jwks.json`, so receipts verify against the evidence JWKS alone.
- `eval:run` against a server reads tool calls, finish reason and diagnostics from the execution's debug trace, so `toolCalled` assertions work outside the in-process runner.
- Documentation no longer claims that the Helm chart carries no replica counts.
- CI: negated grep assertions in the Helm rendering step now fail the job when the pattern is present.
- `docs/THREAT-MODEL.md` matches the code again (approval separation, derived-PDF cache, converter gate, compliance policy, content-trust taint, audit pseudonyms, the compliance-policy readiness check and the Gate monitor stream) and its tables render correctly; the Gate README no longer mentions a Runtime approval secret.
- Runbooks reference existing endpoints and the Runtime audit chain; new runbooks cover a Redis outage and transaction-token rotation, and the incident runbook covers a compromised evidence key.
- Documentation names the existing bundle verifier (`cli.ts verify-bundle`) instead of a non-existent `atf verify-bundle` command.
- `docs/CAPABILITIES.md` lists the capabilities added in this release.
- `docs/CONFIGURATION.md` shows defaults and descriptions for Search and Extract variables validated at startup, and `REVISION_TTL` in seconds (default 1209600).
- Documentation describes the production profile through ATF_PROFILE, SECURITY.md covers evidence signing (Ed25519 and HMAC signature formats, erasure and decision receipts) and content trust, and DEPLOYMENT.md shows how to verify the release bundle attestation.
- Operations, DPIA, UI style, MCP 2026 and EU AI Act documents are updated (Redis requirement, per-process stores, current status, CI accessibility tests, shared MCP package, Articles 25, 27, 72/73 and 86).
- Runtime, Search, Gate and Outpost Desktop READMEs cover the new endpoints and settings, and Outpost Desktop describes credential handling accurately.
- OpenAPI documents: Extract reports the product version, and health schemas include auth and flow_load.
- Search v1/v2 embed the raw query when it consists only of noise characters, and v1 computes dense and sparse embeddings in parallel.
- Search `group_by_section` no longer merges equally named sections of different documents.
- Search keeps revisions apart when `include_all_versions` is set (diversification and document grouping).
- Gate monitor and playground derive the tenant like the MCP authenticator (claim names, issuer-tenant binding), pass the verified claims to tools, and read groups from `monitoring.oidc.groupsClaim`.
- `ARCHITECTURE.md` lists the current contract package versions, and `verify:version` now fails when that table drifts from the package manifests.
- `docs/README.md`, the root README and `ARCHITECTURE.md` reflect the current documents, gates, Redis behaviour and trust architecture.
- Gate no longer returns internal error messages of failed tools to MCP clients: the client receives `Tool execution failed (reference <id>)`, the full text stays in the log and the monitor stream.
- Gate keys the `hash` redaction strategy with `MCPGATE_REDACTION_HASH_SECRET` (HMAC-SHA256) and the production check warns while a tool hashes values without it; without the secret the digest is unchanged.
- Control renders server-side texts in the locale of each request.
- Long erasure runs renew their lease after every store group and stop when another worker took over.
- The supply-chain generator ignores installed packages that are not in bun.lock.
- Search full-text cursor paging returns every hit exactly once: the cursor follows the all-terms ranking tier, compares scores at the precision of `ts_rank_cd`, and ids sort numerically.
- Gate resolves a pending approval exactly once, also across replicas (a concurrent second `approvals/resolve` answers 404); the Redis approval store enforces `policies.approval.maxPending` per tenant (503) and expires its index.
- `docs/UPGRADE.md` has a "0.18 → 0.19" section (Runtime migrations 48 and 49, the audit cut-off rollout rule and its repair, page ranges, the media route, the compliance-policy behaviour, the Gate start aborts and monitor login change, and the Search, Runtime and Extract behaviour changes); `flows release` and `atf-verify --release-receipt` are named correctly.

### Migration

Read [docs/UPGRADE.md](docs/UPGRADE.md) ("0.18 → 0.19") before rolling this
out. The changes below can stop an existing deployment from starting or change
what it returns, without any code change on your side:

- **Unknown profile values abort the start.** `ATF_PROFILE`, `APP_ENV`,
  `MCPGATE_ENV` and `NODE_ENV` must be one of `development`, `staging`,
  `production`, `test` (case-insensitive, trimmed). `NODE_ENV=prod`, `local` or
  `ci` used to fall through to "no production gate" and now fail loudly. Fix the
  value, or set `ATF_PROFILE` explicitly.
- **`EMBED_FALLBACK_MODEL` ≠ `EMBED_MODEL` aborts the Search start.** If both
  names serve the same underlying model (different tag, same weights), set
  `EMBED_FALLBACK_SAME_SPACE=true`; otherwise point the fallback at the same
  model. A deployment that configured two different model identifiers must make
  this choice before upgrading.
- **Gate production gate.** `monitoring.playground.enabled: true` and a
  plaintext-`http://` `server.publicUrl` / `monitoring.oidc.redirectUri` are now
  fatal in `production`. Disable the playground (or run `staging`) and use
  `https://` URLs.
- **`REPLICAS > 1` needs a shared rate-limit store** (`RATE_LIMIT_REDIS_URL`) in
  Search and Extract in `production`; Runtime warns.
- **Audit log: rotate tokens that may have been written.** Before this change the
  red-team routes stored the raw `Authorization` header and the optimizer routes
  stored the first 12 characters of the bearer token as the audit `actor`. Treat
  those operator tokens as exposed and rotate them; restrict
  `GET /monitoring/audit` and your log shipper's audit stream until you have.
  Existing rows are part of the hash chain and are not rewritten. Verify the
  chain afterwards: `legacyForm` in the result counts rows that verify under the
  pre-fix hash form.
- **Search ranking and query syntax.** The lexical branch ORs query terms and no
  longer parses `websearch` syntax (`"phrase"`, `-term`, `OR`). Re-run your
  retrieval evaluation; clients that relied on quoted phrases or exclusions need
  to filter on their side.
- **Playground behaviour (Gate).** Dry-runs now require the tool's scopes and
  honour policy deny; an OIDC session no longer receives the synthesised
  `tools:<access>` scope. A tool that declares `requiredScopes: [tools:write]`
  needs that scope in the IdP's `tools` claim for dashboard users.
- **Extract.** v2 jobs that would process more than `MAX_PAGES` pages (default
  500; `0` disables) now fail terminally instead of running. `JOB_CONCURRENCY`
  and `RATE_LIMIT_REDIS_URL` are opt-in and change nothing until set;
  `DERIVED_PDF_CACHE` defaults to on and only reuses conversions under
  `TEMP_DIR/derived-pdf` (see UPGRADE for the retention caveat).
- **Signing.** Nothing breaks if you do nothing: HMAC anchors, bundles and
  receipts keep signing and verifying. Set `EVIDENCE_SIGNING_KEY` to move to
  Ed25519; back the key up with your other signing secrets (see the backup and
  key-rotation runbooks) and keep the public key of every key that ever signed
  an artefact you still need to verify.
- **Extract: local converter.** `CONVERTER_MODE=local` aborts the start in
  `production` unless `CONVERTER_ALLOW_LOCAL_HTML=true` (or the converter runs
  `isolated`). Decide before upgrading; the flag keeps the previous behaviour and
  leaves a readiness warning. The Helm chart runs LibreOffice inside the Extract
  pod and therefore exports the acknowledgement by default
  (`extract.config.converterAllowLocalHtml: true`); set it to `false` once an
  isolated converter is wired in.
- **Extract: one-time loss of pinned resumes.** The LibreOffice identity and the
  prompt versions (2.1.0 / 2.1.0 / 2.2.0) are part of the snapshot hashes, so a
  job paused or in flight under the `pin` resume policy at upgrade time no
  longer matches and must be restarted instead of resumed. Drain or finish
  running jobs first.
- **Helm: Search and Extract need Redis by default.** The chart now declares its
  replica count (`replicaCount` defaults to 2), so a production pod without
  `RATE_LIMIT_REDIS_URL` fails the production gate and does not start. Provide
  the shared store, or set `replicaCount: 1`. `global.profile` is opt-in; unset,
  no `ATF_PROFILE` is exported.
- **Gate.** Imported MCP tools default to `write` unless the downstream declares
  `annotations.readOnlyHint: true` — re-check which tools your clients can reach
  with a read-only scope. The dashboard logout is a `POST` (the shipped page is
  updated; a custom page or a link that used `GET /monitor/logout` now gets
  405). The IdP must accept PKCE and return the `nonce`.
- **Search.** Create a `USING bm25` index on tables that should use the BM25
  path; without one the full-text path is used and a warning is logged once.
- **Runtime erasure.** An erasure that reached no store now returns `failed`
  (HTTP 502) instead of `complete`; an operation another run still holds returns
  202. Operations stuck in `partial` from a crash before this change have no
  `in_progress` marker: retry them with `POST /admin/compliance/erasures/{id}/retry`.
- **Flow version gate.** A change to `compliance-policy`, `access`, `canary` or
  `experiments` (or `constants` for flows that use it) now requires a version
  bump of the affected flows in CI.
- **`DELETE /v2/documents/{reference}`** now also deletes the reference's jobs,
  upload sessions and unused source bytes in Extract. A job you wanted to keep
  for inspection must be exported before the delete.
- **`pages` on `POST /v2/jobs` now takes effect and is validated.** A client that sent a
  value that was ignored before (a list such as `1-10,15`, or text) gets a 400; a client
  that sent a range gets only that range. **Upgrade Search before sending windowed jobs**:
  an older Search expects a stream to start at page 1 and rejects a window at the final
  commit.
- **`SEGMENT_PAGES` defaults to 100** (was 250) and segments commit during the hand-over.
  Set `SEGMENT_PAGES=250` to restore the old granularity; the commit order cannot be
  switched back.
- **Gate approvals:** nothing changes until `policies.approval.requireDifferentApprover`
  is set; the `approver` field is a label only (UPGRADE item 14).
- **Clients and probes:** the optional `"auth": "disabled"` health field, the `_meta`
  content-trust key on Gate tool results and the 202/400 behaviour above are additive, but
  anything that compares a whole body to a fixed shape must allow them.
- **Transaction tokens:** optional move to Ed25519 with an audience per service, in the
  order of UPGRADE item 20.
- Run `bun run scripts/cli.ts validate <flows-dir>` (in `apps/runtime`) before upgrading a production Runtime; every warning about an unknown config key becomes a flow load failure there. Rename typos or prefix annotation keys with `x-`.
- Search queries longer than 400 characters are now cut. Flows that append large context to the query should raise `SEARCH_MAX_QUERY_CHARS` or move the context out of the query.
- Transaction tokens without a `typ` header are rejected by Search. Tokens minted by ATF Runtime already carry `typ: at+jwt`.
- Gate monitor: OIDC users now see only events of their own tenant (`monitoring.tenantScope: session`) and tool results only as digest (`monitoring.includeToolContent: false`). Set `tenantScope: all` and/or `includeToolContent: true` to restore the previous view.
- Set `AUDIT_PSEUDONYM_PEPPER` (random, ≥ 32 characters) and keep it stable; changing it changes the pseudonyms of later audit entries.
- `TAINT_MODE=on-untrusted-source` (also set by the `regulated` presets) taints an execution on every result of an MCP server without `contentTrust: trusted`; mark internal, curated servers with `contentTrust: trusted` before enabling it.
- Deployments with `PROFILE=regulated` (or `regulated-multitenant`) in production need `AUDIT_ANCHOR_FILE`, `EGRESS_ALLOWED_HOSTS`, `EVIDENCE_SIGNING_KEY` and a `compliance-policy.yaml` before upgrading; explicit env values still override the preset.
- Rename the preset variable `PROFILE` to `ATF_PRESET` at your convenience; while both are set they must have the same value, otherwise the start stops.
- Search MCP `search` results are compact JSON now; set `SEARCH_MCP_PRETTY_JSON=true` if a client relied on the 2-space indentation.
- Gate: a tool binding on `:ctx.rawToken`, `:ctx.headers`, or the `authorization`, `proxy-authorization` or `cookie` header stops the start (`Binding :ctx.<path> is not allowed`). Remove it before upgrading; use token exchange or passthrough for credentials.
- Gate: a `tenantIsolation.issuerTenants` key that is not a configured OAuth or monitor issuer stops the start (`... not a configured issuer`).
- Gate monitor OIDC login: with tenant isolation an ID token without a tenant claim is refused (it used to fall back to the default tenant), and a non-empty `issuerTenants` must list `monitoring.oidc.issuer`. Configure the IdP and the binding before upgrading, or operators lose monitor access.
- Runtime audit chain: do not run 0.18 and 0.19 Runtime pods side by side during this upgrade (scale to 0 or use a `Recreate` rollout); an old pod writing after the canonical cut-off makes verification report `legacy_hash_after_cutoff`. UPGRADE item 6 describes the repair.

## [0.18.1] — 2026-10-18

### Security

- **Runtime** (`@atf/runtime`): `hono` 4.13.5 → 4.13.7 (GHSA-hxh3-vqpv-xpqv, unescaped
  strings in `hono/jsx` boundary components; Runtime does not render `hono/jsx`).
- **Extract** (`@atf/extract`): `multer` 2.3.0 → 2.4.0 (CVE-2026-88932,
  GHSA-3pph-fpjx-jg34); multer now validates upload limits when the parser is built.
  Third-party notices and the SBOM are regenerated.
- **Security kit** (`@atf/security-kit`): CBOR decoding stores a `__proto__` map key as an
  own property instead of assigning it through the inherited setter, which dropped the key and
  let the payload choose the decoded map's prototype. Canonical round-trips hold again;
  `Object.prototype` was never affected.

### Changed

- **Quickstart image** (`deploy/examples/Dockerfile`): base `oven/bun` 1.4.2 → 1.4.3. The
  toolchain pin (1.4.0) and the digest-pinned production images (1.4.2) are unchanged.
- **CI** (SHA-pinned actions): `actions/setup-node` 7.0.0 → 7.1.0,
  `actions/upload-artifact` 7.0.1 → 7.0.2, `docker/setup-buildx-action` 3.12.0 → 4.4.1,
  `docker/login-action` 3.7.0 → 4.6.0, `softprops/action-gh-release` 2.6.2 → 3.0.3. The
  new majors only move the action runtime to Node 24; inputs used here are unchanged.

## [0.18.0] — 2026-10-18

### Removed

- **Search** (`@atf/search`): the legacy v1 asset routes `PUT` / `GET /document-assets/:assetId`
  are gone (breaking HTTP API change). `vs_assets` is now the single asset store: the MCP
  `get_document_asset` tool reads from it, and the `asset_url` of `/search` (v1) hits points to
  `GET /v2/assets/{id}?collection=…`. Assets uploaded through the old route remain retrievable
  through the existing `vs_document_assets` → `vs_assets` backfill. Clients calling
  `/document-assets` directly must switch to `/v2/assets`. See
  [docs/document-intelligence-v2-migration.md](docs/document-intelligence-v2-migration.md).
- **Extract** (`@atf/extract`): the synchronous `/v1/ingest` path no longer uploads figure crops,
  and `SEARCH_UPLOAD_ASSETS` is no longer read. Without a job store the response drops
  `assets_stored` / `assets_failed`; figure images flow only through the v2 job pipeline.

### Fixed

- **Extract** (`@atf/extract`): the v2 emitter now sends `x-figure-id`, `x-page` and `x-bbox` with
  each asset `PUT`, so stored figures carry their identity and placement. Previously
  `expected_figure_id` checks failed closed and region zooms were unavailable for these assets.
- **Search** (`@atf/search`): re-emitting an asset with identical bytes now backfills missing
  `figure_id` / `page` / `bbox` metadata instead of keeping stale `NULL` values.
- **Search** (`@atf/search`): `expected_document_reference` on `get_asset` and
  `get_document_asset` tolerates a `#unit:…` fragment copied from a search hit; a different
  document reference still fails closed.
- **Runtime** (`@atf/runtime`): image tool results delivered as an AI SDK v6 file part with a
  nested `{ type: "data" }` envelope are now recognised and offloaded like bare base64 MCP image
  content.

## [0.17.0] — 2026-10-18

### Added

- **Runtime** (`@atf/runtime`): an `llm` node can declare `config.figureEmbedding` to get a
  `show_figure` tool that embeds a document figure directly in its answer. The model passes
  an `asset:<id>[#bbox]` reference from a search hit, the bytes are fetched via the MCP
  `get_asset` tool with the caller's ACL (fail-closed) and served as a short-lived media link;
  they never enter the model context. The tool is exposed only with the new deployment gate
  `EMBED_SEARCH_FIGURES=true` plus `MEDIA_BASE_URL`; otherwise the node emits a
  `figure_embedding_unavailable` diagnostic. The link is a capability URL bounded by the
  media store TTL. Existing flows are unaffected.

## [0.16.2] — 2026-10-17

### Fixed

- **Search** (`@atf/search`): an unknown collection is now a typed 404
  (`COLLECTION_NOT_FOUND`) instead of 403 on read and search routes, so a caller with a
  valid scope sees an empty index rather than a permission failure.
- **Search**: with authorization enabled, the first ingest into a brand-new collection was
  refused because the collection-access middleware ran before `ensureCollection`. The ingest
  routes (`/ingest`, `/ingest-batch`, `/ingest-stream`, app and ui) now use a write variant
  that lets the first write through; the MCP ingest tool tolerates the same case.
- **Runtime** (`@atf/runtime`): MCP image content with a bare base64 payload on `data`
  (`{type:"image", data, mimeType}`, no `data:` prefix) is now recognised when image parts
  are parked. Only an image MIME type with a strictly decodable base64 alphabet qualifies,
  so remote `url`/`image` strings are never mistaken for payload bytes.

### Added

- **Search**: a trusted writer (service credential, or a principal holding
  `vectorsearch.acl.manage`) may set explicit per-document viewer lists on ingest with
  `X-Allowed-Users` / `X-Allowed-Groups`; all other callers keep the principal-derived ACL.
- **Extract** (`@atf/extract`) and **Search**: a composite-code identifier class
  (`composite_code`, e.g. `QAP-MDE-03`) is recognised before drawing numbers, so codes that
  differ only in their prefix no longer collapse to the same normalised value. Revision-style
  suffixes (`ZG-100`) and short alphanumeric codes (`WE01`, `VA01`) are matched as well.
- **Search**: table units now carry the identifier codes of their section, so a lookup by
  code no longer loses the table fragments to near-duplicate neighbours.

## [0.16.1] — 2026-10-16

### Fixed

- **Runtime** (`@atf/runtime`): `validateFlowSource` validated the raw flow
  template without model-shortcut expansion. A flow whose LLM node used
  `{shortcut: ...}` failed the `LlmConfig` schema at template-validation time
  (provider/model not yet expanded), so the parser silently fell back to the
  fully-defaulted clone — which had every `{{vars.*}}` placeholder baked to its
  default value. Per-request `variables` overrides (e.g. a caller supplying its
  own `collection`) were therefore ignored for any flow combining shortcuts with
  flow variables. The template clone is now expanded with
  shortcuts only (no variable resolution), so placeholder forms validate and
  win; flows with an unresolvable shortcut placeholder keep the defaulted
  fallback as before. New regression test
  `validate-source-placeholder.test.ts` covers placeholder survival, override
  delivery via `applyFlowVariables`, and the unknown-shortcut fallback.

## [0.16.0] — 2026-10-15

### Security

- **Control** (`@atf/control`): `next` 16.3.6 → 16.3.8 (CVE-2026-94483, SSRF and
  information disclosure in Image Optimization); transitively `@next/env` and
  `@next/swc-*` 16.3.6 → 16.3.8.
- **Extract, Search, workspace override** (`@atf/extract`, `@atf/search`, root
  `overrides`): `sharp` 0.35.4 → 0.35.5 (GHSA-wq5f-xc86-pv6w, bundled librsvg
  CVE-2026-96889); transitively `@img/sharp-*` 0.35.4 → 0.35.5 and
  `@img/sharp-libvips-*` 1.3.3 → 1.3.4. Third-party notices and the SBOM are
  regenerated.
- **Gate, Runtime, Search** (`@atf/gate`, `@atf/runtime`, `@atf/search`):
  `@modelcontextprotocol/sdk` 1.30.0 → 1.31.0 (CVE-2026-104850). A new root
  override pins `zod` to 4.4.3 so the SDK uses the same zod version as the
  workspaces and the MCP tool types stay compatible.
- **Security kit** (`@atf/security-kit`): `undici` 7.29.0 → 7.29.1 (CVE-2026-19534,
  CVE-2026-84961); the `undici` copy used by `@ai-sdk/provider-utils` moves to
  7.29.1 as well.
- **Outpost core** (`@atf/outpost-core`): `undici` 6.23.0 → 6.28.1 (CVE-2026-12151,
  CVE-2026-1526, CVE-2026-1528, CVE-2026-19534, CVE-2026-2229); stays on the 6.x line.
- **Outpost desktop** (`@atf/outpost-desktop`): `vite` 7.1.7 → 7.3.7 (CVE-2026-39363,
  CVE-2026-39364, CVE-2026-53571); `esbuild` 0.25.12 → 0.28.2 via root `overrides`,
  its binary is built with Go 1.26.5 instead of Go 1.23.12 (CVE-2025-68121 and further
  Go standard library findings).
- **Workspace overrides** (root `overrides`): `fast-uri` 3.1.6 → 3.1.7 (CVE-2026-84292,
  CVE-2026-84394); new pins `proxy-addr` 2.0.8 (CVE-2026-90711, via `express`) and
  `source-map-js` 1.2.2 (CVE-2026-93749). Third-party notices and the SBOM are
  regenerated.
- **Runtime DSAR erasure is user-scoped** (`DELETE /v1/me/data`,
  `POST /admin/compliance/forget`): a subject with a user identifier no longer
  erases the execution history, the permanent usage log (`token_usage_log`) and
  the PII vault of its whole tenant. Only the executions attributed to the user
  (usage-log `user_id`/`user_label` or `executions.user_name`) and the vault
  entries of those executions are erased; a tenant-wide erase needs a subject
  without user identifiers, which only the operator plane builds. The caller's
  email and JWT `sub` are both used as identifiers (and both appear hashed in
  the erasure receipt). The orchestrator keeps an email- or external-id-only
  subject user-scoped and no longer runs the local stores for a
  `reference`-scoped request. Retention targets now erase sequentially, PII
  vault first.
- **Self-service erasure is scoped to the token issuer** (`DELETE /v1/me/data`):
  two trusted issuers (`JWT_ADDITIONAL_ISSUERS`) in one tenant can hand out the
  same `sub`; erasing one user no longer removes the other issuer's executions
  and usage-log rows. Migration 47 adds a nullable `iss` column to `executions`
  and `token_usage_log`, written at the request boundary. A row matches when its
  `iss` equals the caller's issuer or is `NULL`, so rows written before the
  migration still match by `sub`. The orchestrator keeps the issuer for retries.
  `JWT_ADDITIONAL_ISSUERS` is documented as a platform-wide list.
- **OIDC logs no longer contain the user's email in clear** (Search, Extract):
  the login callback logs `emailHash`, a 12-character SHA-256 handle from the
  new `hashIdentifier()` in `@atf/security-kit`, instead of the address.
  `email` stays a normal log key everywhere else.
- **Gate logger uses the shared redaction** (Gate): log context and the `msg`
  text pass through `@atf/security-kit`, so JWT, Bearer and API-key shaped
  values are scrubbed from interpolated messages too. `MCPGATE_LOG_REDACT=0`
  still disables it. Debug logs of query bindings and the system prompt carry
  only a count or length and a digest.
- **An invalid compliance policy no longer switches enforcement off**
  (`compliance-policy.yaml`): a hot-reload of an unreadable or schema-invalid
  file keeps the last valid policy in force instead of dropping to "no
  policy"; at startup, with no valid policy yet, chat and engine admission deny
  every run with 503 until the file is fixed. `GET /admin/compliance-policy`
  reports the load error (`loadError`, `stale` or `blocked`), and the loader
  logs at error level. A missing file still means "no policy".
- **Search no longer logs raw queries or the acting identity**
  (`POST /search`, `POST /v2/search`): the "Incoming search query" info log
  carried the query text, user id and groups, contrary to the data-minimisation
  rule in `docs/operations-and-retrieval.md`. It now records only
  `queryLength`, `authenticatedUser` and `userGroupCount`.
- **Shadow and replay runs no longer repeat side effects**: both run with
  `suppressSideEffects`, so the MCP wrapper refuses every tool that does not
  declare `readOnlyHint`, approval-gated tools are denied without reaching a
  reviewer, and `assistant-context`/`assistant-learn` skip their transcript,
  memory and preference writes. Shadow sampling now defaults to 5 % instead of
  100 % (`samplingRate` in `shadow.yaml`, clamped to [0, 1]).
- **DSAR erasure and retention cover the remaining runtime stores**: new
  retention targets `conversation_checkpoints` (threads resolved from the
  execution history; age purge incl. orphaned writes), `assistant_data` (all
  `assistant_*` tables, both sides of messages and grants), `assistant_workspaces`
  (workspace files), `cost_ledger`, `analysis_artifacts`,
  `rocketchat_connect_requests` and `autopilot_runs` (age purge). A store that
  cannot be erased automatically is registered with its gap, fails the erasure
  and therefore turns `complete` into `partial`; `GET /v1/me/data` lists it as
  not erasable and the dossier names the gap.
- **Control in BFF mode** (`CONTROL_SESSION_MODE=bff`): SSO login, logout,
  refresh and the auth-config probe now go to the Runtime directly
  (`authUrl`) instead of the BFF proxy, which refuses `/monitoring/auth/` by
  design, so they no longer end in a 404. The proxy allowlist now covers Studio
  test runs (`/v1/chat/completions`) and receipt verification (`/v1/receipts`,
  `/.well-known/atf-receipt-jwks.json`).
- **Control approvals**: the Approve/Deny buttons are shown only from the
  operator role up (the Runtime requires `approvals:write`); viewers see who
  decides instead.
- **Control confirmations**: revoking API keys and delegations, removing BYOK
  provider keys, clearing a memory session, deleting token limits, running a
  retention sweep and erasing a subject (RTBF) now ask for confirmation.
- **Control mutations are no longer retried**: the global React Query default
  `mutations.retry` drops from 1 to 0, so a lost response can no longer repeat
  a POST (for example creating a second API key).
- **Control warning text contrast**: the light `--warning` token moves to
  amber-700 (≥ 4.5:1 on `--warning-soft`), fixing the axe colour-contrast
  failures on the security page.
- **CI runs Control's Playwright suite and the axe a11y sweep** (`control-e2e`
  job); the macOS-recorded visual-regression baselines stay excluded.
- **Gate monitor dashboard**: the page is served with a nonce-based
  Content-Security-Policy (`script-src 'nonce-…'`, `object-src 'none'`,
  `frame-ancestors 'none'`) and no inline event handlers. The monitoring token
  is no longer kept in `localStorage` or sent as `?token=`: the dashboard
  exchanges it once via `POST /monitor/session` (Authorization header) for a
  signed HttpOnly, SameSite=Strict cookie (8 h, invalidated by rotating the
  token); `/monitor/logout` clears it. **Breaking:** `?token=` is no longer
  accepted on any monitor endpoint — scripts must send
  `Authorization: Bearer <token>`.
- **German full-text search** (`@atf/search`): `FTS_LANGUAGE` now defaults to
  `german` (Snowball stemming) instead of `simple` and is validated at startup.
  Existing collections keep their language; the new `fts:language` script
  switches one and recomputes its vectors. `FTS_EXTRA_LANGUAGES` admits
  operator-installed configurations such as a Hunspell `german_compound` for
  compound splitting (checked against `pg_ts_config` at startup); setup in
  `docs/operations-and-retrieval.md`. **Upgrade:** deployments with mainly
  non-German content set `FTS_LANGUAGE` explicitly (for example `english` or
  `simple`).
- **Configuration reference** (`docs/CONFIGURATION.md`): Search and Extract
  variables now carry their member's JSDoc instead of only "Config member …",
  undocumented Runtime variables fall back to the JSDoc of the `AppConfig`
  member they load into, and Gate, Rocket.Chat-connect and agent-transaction
  variables have curated descriptions. Every security-relevant variable
  (credentials, trust anchors, authentication, isolation and debug switches) is
  described; the generator now fails when one is not, so a new one cannot ship
  undocumented. Variables without a description: 271 → 123 (strict count incl.
  placeholder and "read directly"-only notes: ≈ 560 → 216).

- **Search MCP tools declare behaviour hints**: every lookup tool (`search`,
  `get_outline`, `get_section`, …) now sets `readOnlyHint`, `ingest` and
  `delete_document` declare themselves as writes. Without the hint the
  Runtime's side-effect guard refused all Search tools in shadow and replay
  runs, so agentic RAG flows scored systematically worse there. A tool missing
  from `SEARCH_TOOL_ANNOTATIONS` now fails Search at startup.

- **DSAR self-service identity hardened** (`DELETE /v1/me/data`): the
  erasure subject is the verified token's `sub` and requires `iss`; `email`
  is used only with `email_verified: true` (an unverified `email` claim from
  any trusted issuer could otherwise name — and erase — another user). A
  token without a tenant claim is refused with 403 `TENANT_REQUIRED` instead
  of erasing the caller's identifiers in every tenant. The issuer is recorded
  in the audit entry. Callers whose tokens lack `iss` now get 401.

- **Role gating matches the Runtime's RBAC.** Runtime: starting an autopilot
  cycle (`POST /autopilot/trigger`) and running red-team attacks or refreshing
  the attack library (`POST /security/red-team/:flowId/run`,
  `…/attacks/refresh`) required only read permissions, so a viewer could
  trigger flow promotions and attack runs; they now need `flows:write`
  (admin). Control: write controls are disabled with a "Requires the … role"
  hint below the role the Runtime enforces (`useCanWrite`) — operator for
  memory, limits, eval cases and runs, provider tests, trigger test-fires and
  assistants admin; admin for Studio (previously gated at operator although
  every flow write needs admin), flow import/delete, version rollback,
  copilots, optimizer, autopilot, red-team, tool-authz and compliance actions.
- **Control BFF proxy refuses cross-site requests** (`/api/backend/*`):
  `Sec-Fetch-Site`/`Origin` are checked before the session cookie is used.

- **Issuer → tenant binding** (`JWT_ISSUER_TENANTS`): with several trusted
  token issuers (`JWT_ADDITIONAL_ISSUERS`, `token_or_oidc`), each could assert
  any tenant. The new JSON map binds every issuer to the tenants it may claim
  (`"*"` for all); a verified token whose issuer is unlisted or whose tenant
  is not bound to it is rejected with 401 on `/v1/*` and the operator plane.
  Production readiness fails when tenant isolation is on, more than one
  issuer is trusted and no binding is configured.

- **Log redaction in Runtime, Search and Extract**: only Gate redacted its
  logs. A shared redactor (`@atf/security-kit` `log-redact`) now runs on every
  entry of the Runtime logger and of Search's and Extract's pino loggers
  (entries, root and child bindings, messages): credential-named fields
  (`authorization`, `cookie`, `*_secret`, `access_token`, `token`, …) are
  replaced, JWT-, `Bearer …`- and `aip-…`-shaped values are scrubbed from any
  string including error messages and stacks, and strings are bounded. Token
  counters such as `prompt_tokens` stay readable.

- **Search score thresholds respect the score scale**: `MIN_RERANK_SCORE` was
  compared with whatever score the result carried — after a reranker fallback
  that meant RRF scores (≈ 0.016) or cosine/FTS values, so a threshold of 0.3
  dropped every hybrid result and reported abstention. Thresholds now carry
  their scale: `MIN_RERANK_SCORE` applies only to reranker scores, an MCP
  per-request `minScore` applies to the scale the call asked for. On a
  mismatch the results stay unfiltered and the response says
  `skipped: "scale_mismatch"`; `score_scale` (`rerank`/`cosine`/`rrf`/`fts`)
  names the exact scale of the final scores.

- **CI flow version check** (`bun run check:flow-versions`, Hygiene job):
  compared with the PR base (or the previous push), a flow whose definition
  changed — or whose `prompts/`/`subflows/` include changed — must raise its
  `metadata.version` (semver), and a new flow needs one. Otherwise two
  behaviours share one `flow_version` in traces and receipts. Flows
  directories are arguments, so deployment repositories can run the same
  check.

- **German morphology eval set** (`scripts/eval/golden-set/de-morphology.v1.json`,
  `bun run eval:retrieval:de`): 36 golden-set questions re-asked with other
  inflections, split compounds and derivations, answered by their base
  question. The v1 questions occur verbatim in the corpus and cannot show
  whether German stemming or compound splitting work; this set can. A test
  guards that every variant really departs from the corpus wording.

- **Indirect prompt-injection detection on by default in production and for
  RAG**: the tool-output validator was off unless enabled, and it never saw the
  chunks a `retrieval` node puts into the prompt. It now defaults to on when
  `APP_ENV=production` (explicit `TOOL_OUTPUT_VALIDATOR_ENABLED=false` opts out
  and raises a readiness warning), scans retrieved chunks as well as MCP tool
  results, and records every finding on the consuming node's debug trace
  (`indirect_prompt_injection`, with source and signals) and in
  `aiperator_indirect_injection_total`.

- **Retrieved context is handed to the model as untrusted data** (Runtime,
  `retrieval` node): `RETRIEVAL_CONTEXT_MODE=spotlight|legacy`. `spotlight`
  puts the chunks between delimiters with a random per-call nonce and tells the
  model that the block is data, not instructions; the `[n]` citation format and
  the "answer only from the context" instruction are unchanged. Unset it is
  `spotlight` with `APP_ENV=production` and `legacy` elsewhere. `legacy` in
  production raises a readiness warning.
- **Write tools need approval after an injection finding** (Runtime,
  `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`): once the injection scan has flagged
  retrieved or tool text, every tool that is not declared read-only
  (`readOnlyHint`, without `destructiveHint`) needs human approval for the rest
  of that run; tools without annotations count as write tools. Read-only tools
  are unaffected. Without an approval gate (`APPROVAL_GATE_ENABLED`) the call is
  denied. Unset it is on with `APP_ENV=production` and off elsewhere; it needs
  the scan (`TOOL_OUTPUT_VALIDATOR_ENABLED`) to have any effect, and an explicit
  `false` in production raises a readiness warning. Each forced approval writes
  the trace diagnostic `tainted_write_tool_approval`
  (`aiperator_taint_approvals_total`). The detection is heuristic; resistance
  against paraphrased or encoded attacks has not been red-teamed.
- **Search labels its results as untrusted** (`@atf/search`): `POST /search`,
  `POST /v2/search` and the MCP tools `search` and `retrieve_evidence` return
  `content_trust: "untrusted"` and an `injection_risk` hint (`none` or
  `suspected`, from a deterministic English/German phrase list over the
  returned text at query time, no model call, no re-ingest). `none` never means
  safe. No ingest-time score is stored.

### Added
- **Flow digest in the debug trace** (Runtime): `flow_digest` (`sha256:<hex>`
  over the executed flow with prompt files, sub-flows and model shortcuts
  expanded; layout and changelog excluded) and `subflow_versions[]` (path and
  declared `metadata.version` per merged sub-flow) sit next to `flow_version`.
  Equal digests mean equal flow logic even if a version was reused. The CLI
  command `validate --require-version` fails for an entry flow without a
  semantic `metadata.version`, and `check:flow-versions` now resolves includes
  through the flow parser.
- **Eval harness** (`scripts/eval`): the golden set (fixture 1.3.0) holds 24 unanswerable
  questions (`abstain: true`, 16.7 %); the German morphology set (1.1.0) adds 7 abstain
  variants. `retrieval.ts` reports abstention precision/recall, false-answer and
  false-abstention rate (`--abstain-min-score` sets the score gate). A German answer-level
  groundedness mini set (`bun run eval:groundedness`) scores answers with the runtime lexical
  Groundedness checker; live-model answers are "nicht gemessen" (requires live model).
- **Eval stack** (`scripts/eval/compose.eval.yaml`): the embedding model is now `BAAI/bge-m3`
  (multilingual, 1024 dimensions, `EMBED_EXPECTED_DIMENSION=1024`) instead of
  `bge-small-en-v1.5`. No bge-m3 numbers are recorded yet (`baseline/retrieval.bge-m3.md`);
  the committed baseline was measured with bge-small-en on fixture 1.2.0 and the CI floors in
  `baseline/thresholds.json` are not yet recalibrated for bge-m3.
- **Control** (`@atf/control`): the dashboard is localized in German and English
  (cookie `NEXT_LOCALE`). Texts live in `src/lib/i18n/catalogs/ui.en.ts` and `ui.de.ts`;
  `i18n-coverage.test.ts` fails on hard-coded UI text, thrown errors, `setError()` and
  toasts. `@babel/parser` 7.29.9 is a pinned devDependency for that test.
- **Control** (`@atf/control`): new `CONTROL_PUBLIC_ORIGIN` pins the host accepted by the
  BFF same-origin guard; `X-Forwarded-Host` is then ignored. An invalid value rejects every
  request that carries an `Origin`. Without it the legacy behaviour stays, and the reverse
  proxy must overwrite `X-Forwarded-Host`.

- Runtime, coverage harness: optional `coverageQueue.summaryTriage` for the
  staged queue. In `mode: hybrid`, a cross-encoder scores every open summary
  once after the seed (query = latest user message plus optional templates,
  score = maximum over the queries). By rank, the top `acceptTopK` share
  (default 7 %) is accepted, and ranks beyond `excludeBelowRank` (default 35 %)
  with a score below `excludeMaxScore` (default 0.01) are excluded. Only the
  gray zone goes to LLM triage. Each decision carries a reason
  (`Rerank-Rang r/N, Score s …`) and `triageSource: rerank`. Short summaries
  are never excluded, and global discovery can still reopen every exclusion.
  Fail-closed: when the reranker is missing, fails, times out or returns an
  incomplete score set, all summaries go to LLM triage in ledger order (trace
  diagnostic `summary_triage_rerank_fallback` with `reason`). The default is
  `mode: llm`; `mode: rerank` exists but is not enabled by default. Trace
  diagnostic `summary_triage_rerank_scored` reports accepted/excluded/gray and
  the reranker latency.
- Runtime, coverage harness: with a configured reranker (`RERANK_*`), Stage-1
  triage batches follow the summary rerank score even in `mode: llm`. The
  staged candidate freeze takes discovery-promoted documents first, then the
  highest scores, so an overflow drops the least relevant candidates.
  `summaryTriage.rerankOrder: false` turns this off. Without a reranker, the
  ledger order is unchanged.
- Runtime: `RERANK_BATCH_SIZE` (default 32) sets the maximum number of texts
  per TEI `/rerank` request.
- Runtime: `LLM_HTTP_KEEP_ALIVE` (default `true`) and the per-provider
  override `PROVIDERS[].keepAlive` / `keep_alive`. With `false`, requests to
  `openai`/`ollama` providers open a fresh connection each time instead of
  reusing a pooled socket. The egress guard (private-host allow-list, DNS
  pinning, redirect checks, response limit, timeouts) applies unchanged. Other
  outbound traffic (MCP, OIDC, reranker) is not affected.

### Changed

- Runtime, `config.refHandles`: on a node that shows the model short
  reference handles, a path-shaped `reference`/`base_ref` (or other reference
  key) that is neither a known handle nor a reference some tool result of this
  run contained is now rejected before the MCP call, with an
  `unregistered_ref` error in the same form as `unknown_ref_handle`. The
  message lists the valid handles and points to
  `list_documents(path_prefix)` for neighbouring chapters. This catches
  references the model assembles itself, e.g. the `link` file path plus a
  chapter title (9 of 15 `get_document` calls in one fds-auto run failed with
  "No document found"). `list_documents(path_prefix=…)`, values without `/`
  (thread ids) and arguments forced via `config.toolArgs` are never blocked;
  `link` stays unmasked because it is not a readable document.
  `expected_document_reference` is now resolved as a reference key too. Tool
  results of non-masking nodes and replayed history tool messages count as
  seen, and the check fails open (diagnostic `ref_strict_check_disabled`) once
  its bounded seen-reference set overflows. New trace diagnostics
  `unregistered_ref_rejected` and `unknown_ref_handle_rejected`. Known
  limitation: a real path the model copies from text that no tool result of
  the run or the replayed history contained is rejected, including paths that
  appear only in the user's message or the system prompt; the error tells the
  model to search or use `list_documents` instead.
- **Documentation** (no behaviour change): `docs/runbooks/key-rotation.md` covers
  receipt signing keys, `API_KEY_PEPPER`, `STATS_QUERY_PEPPER`, `API_TOKEN_NEXT`,
  `CONTROL_SESSION_SECRET` and TLS/mTLS; `docs/runbooks/backup-restore.md` lists
  keys, peppers and the FTS language in the backup scope;
  `docs/THREAT-MODEL.md` adds the issuer→tenant binding, shadow/replay side effects,
  log redaction, invalid-policy enforcement, the Gate monitor token and the Control
  BFF cross-site guard; `ARCHITECTURE.md` lists seven contract packages and separates
  package versions from wire constants; `DEPLOYMENT.md` describes the GHCR images
  (cosign signature, SLSA provenance, SBOM attestation) with an image-verification
  section and pinning by `image.digest`; `apps/outpost/README.md` names the
  `outpost-v<version>` image instead of `:latest`.

### Fixed
- **Search rerank scores keep their native scale** (`@atf/search`): Bedrock and
  OpenAI-compatible rerankers: `relevance_score` was squashed through a
  sigmoid unconditionally, so a score that was already a probability in [0, 1]
  was compressed into roughly [0.5, 0.73]. New `RERANK_SCORE_TRANSFORM`
  (`auto`, default; `sigmoid`; `none`): `auto` keeps values in [0, 1] and applies
  the sigmoid only to values outside it (logits). Set `sigmoid` to restore the
  old mapping, for example when `MIN_RERANK_SCORE` was tuned against it. The
  real Bedrock score scale was not verified against a live endpoint; the tests
  use fixed responses. `POST /search` and `POST /v2/search` now always carry
  `score_scale` (before: only in the abstention block), and the Runtime shows
  RRF and FTS scores in a citation's `similarity_score` relative to the best hit
  instead of clamping them as if they were cosine values.
- **Control** (`@atf/control`): approval decisions that fail or are answered with 403 now show
  a localized message in the card instead of failing silently; an empty 403 from the API
  client reads "Your role does not permit this action." `useApprovals().resolve` returns
  `{ ok, status }` instead of a boolean. BFF mode has no silent renewal; the README now
  documents the interactive SSO sign-in after expiry.

- Runtime, coverage harness: `triageSource: rerank` no longer survives when
  global discovery (path B) reopens a rerank exclusion or when the staged
  candidate freeze excludes a rerank-accepted document as budget overflow.
  The verifier manifest therefore shows a rerank origin only for decisions
  the reranker actually made. `rerankRank`/`rerankScore` stay as measurements.
- Runtime, summary rerank: the pass deadline and the execution abort now
  cancel the in-flight reranker requests (TEI batch requests, Bedrock
  `send`) instead of only abandoning them. An aborted execution is reported
  as fallback reason `aborted`; a deadline stays `timeout`.
- Runtime, summary rerank: one pass uses exactly one reranker backend. With
  TEI primary and Bedrock fallback, the backend that answers the first call
  is pinned for the pass; if it fails later, the whole pass falls back to
  LLM triage (`reranker_error`) instead of mixing uncalibrated TEI and
  Bedrock scores. A TEI that is down from the start still lets Bedrock score
  the whole pass.
- Runtime, TEI reranker: one `rerank`/`rerankOrThrow` call now has an overall
  deadline of 120 s across its sequential batches (before: up to 32 batches
  of 30 s each). It also bounds lenient callers such as the `parallel` RAG
  node.
- Runtime, coverage harness: an invalid `coverageQueue.summaryTriage` block no
  longer falls back to `mode: llm` silently; the trace diagnostic
  `summary_triage_config_invalid` names the invalid fields.
- Runtime, MCP: when the transport recovery of a shared session fails (e.g.
  the replacement handshake is reset), the caller gets the same
  `MCP server temporarily unavailable: … last connect attempt failed: …`
  error as the on-demand connect instead of the raw `read ECONNRESET`.
- Runtime, MCP: `reconnect()` without a live client now joins the
  single-flight of the on-demand connect and the transport recovery instead
  of racing a second handshake. With a live client it keeps a replacement
  that a recovery installed during its handshake and closes its own client.
- Runtime, `config.refHandles`: the `unregistered_ref` error names the
  concrete way out, `list_documents` with `path_prefix` set to the file (or
  folder) of the rejected reference, and the new field
  `suggested_path_prefixes` lists those prefixes.
- Runtime, flow loader: a duplicate node ID in an included sub-flow is
  reported once per load instead of twice (the editable source merge no
  longer warns; only the runtime merge does).
- Runtime, TEI reranker: the client sent up to 1000 texts in one `/rerank`
  request. TEI rejects more than its `max_client_batch_size` (default 32) with
  HTTP 422, and the client silently turned that into an empty result. Requests
  are now split into batches of at most `RERANK_BATCH_SIZE`, and the results
  are merged back to the input indices. Failures are logged with status and
  batch index. The new strict `rerankOrThrow` lets callers that need to
  detect an outage (the summary triage) see the error instead of an empty
  ranking.
- Runtime, MCP: a configured MCP server whose startup handshake or
  transport recovery failed no longer stays unusable until the periodic
  reconnect (10 min) or a restart. The next tool or discovery call connects on
  demand, single-flight per server with exponential backoff after failures
  (1 s doubling to 30 s), so a burst of calls does not open one handshake each.
  Errors now distinguish `MCP server not found: <name> (not configured)` from
  `MCP server temporarily unavailable: <name> (configured but not connected;
  last connect attempt failed: …; retry in … ms)`. The recovery handshake is
  bounded by the connect timeout instead of the per-request retry timeout, and
  the new optional per-server field `connectTimeoutMs` (500–120000 ms, in
  `MCP_SERVERS`/`mcp.yaml`) overrides the 4 s default. A server that is down at
  startup is registered as `<server>/*`, so flows using its tools still
  compile; the periodic reconnect replaces the marker with the real tool list.
- Runtime, coverage harness with `config.refHandles` on the worker: coverage
  evidence (`get_document` windows, search hits) is recorded on the real
  references instead of the handles the worker saw, and masked windows are
  length-restored, so gap-free coverage still matches `totalChars`. The
  coverage assignment shows the worker the same handles in its `REF:` lines.
  Before, a masking worker could never get an original accepted as covered.
- Runtime, threaded conversations: a repeated request with the same
  `conversation_id` and an unchanged last user message (double submit,
  "regenerate") now regenerates the answer from the start of that turn. The
  engine forks from the turn's input checkpoint, so the new answer replaces the
  old one in the thread. Previously the model saw its old answer plus the fresh
  retrieval context as a separate message, ended the answer early, and the
  thread collected several answers to the same turn. New trace diagnostic
  `history_reconciliation.regenerate.outcome = "duplicate_turn_regenerated"`
  and metric outcome `duplicate_turn_regenerated` on
  `aiperator_thread_history_reconciled_total`. If the base checkpoint cannot be
  found, the turn runs as before and the trace records
  `duplicate_turn_kept` with a reason. Known limitation: a delta client that
  sends only the new message cannot be told apart from a double submit. If it
  sends the same short reply twice in a row as a real new turn (for example
  "ja" after a follow-up question), the runtime now replaces the previous
  answer instead of continuing. Before, the new message was silently dropped.
  Clients that send the full history, such as Open WebUI, are not affected.
- Runtime, LLM providers (`openai`/`ollama`): a tool-loop step whose request
  fails with a connection error before the first response byte (ECONNRESET,
  EPIPE, ECONNREFUSED, "socket hang up") is retried once on a fresh connection
  after 75 ms, also when earlier steps already streamed text. Before, such a
  stale keep-alive socket could end the node with an error after partial
  output. The trace records `llm_step_connect_retry` and, if the retry fails
  too, `llm_step_connect_retry_failed`, both with the provider/model of the
  failing request. LLM requests issued inside tool executions (harness
  delegate/planner, image inspection) get their own retry but are neither
  counted in the outer node's `request_index` nor reported there. A step that
  breaks off in the middle of its own response is still not retried. The
  retry budget is per request: on the last candidate, where the AI SDK
  retries itself (`maxRetries` 2), an unreachable endpoint costs up to 6
  connects per step instead of 3.
- **Control a11y sweep** (`@atf/control`): the routes are read from the dashboard pages
  instead of a hand-kept list, so the removed `/rag` page is no longer scanned and a new page is
  covered automatically.

### Migration

Step-by-step instructions are in [docs/UPGRADE.md](docs/UPGRADE.md) (0.15 → 0.16).

- **Gate monitor (breaking):** `?token=` is rejected on every monitor endpoint. Scripts send
  `Authorization: Bearer <token>`; the dashboard uses `POST /monitor/session`.
- **Search full-text language:** `FTS_LANGUAGE` defaults to `german`. Existing collections keep
  their language; switch each one with `bun run --filter @atf/search fts:language <collection>
  <language>` (needs `POSTGRES_URL`, recomputes the vectors). Deployments with mainly
  non-German content set `FTS_LANGUAGE` explicitly. `german_compound` needs Hunspell files in
  the PostgreSQL image and `FTS_EXTRA_LANGUAGES`.
- **Runtime schema version 47:** nullable `iss` on `executions` and `token_usage_log`
  (additive; run `bun run migrate` or the Helm hooks before rolling out in production).
- **Trusted issuers:** with `JWT_ADDITIONAL_ISSUERS` and tenant isolation, set
  `JWT_ISSUER_TENANTS`; without it production readiness fails and unbound issuer/tenant
  pairs get 401.
- **Self-service erasure:** `DELETE /v1/me/data` is scoped to the user and the token issuer,
  needs `iss` (else 401) and a tenant claim (else 403 `TENANT_REQUIRED`), and uses `email` only
  with `email_verified: true`. Operator DSAR with user identifiers no longer erases the whole
  tenant.
- **Compliance policy:** an invalid `compliance-policy.yaml` no longer disables enforcement; at
  startup without a valid policy chat answers 503 until the file is fixed.
- **Shadow and replay:** sampling defaults to 5 %. Both run without side effects: tools without
  `readOnlyHint` are refused and approvals are denied. Custom MCP servers that should take part
  declare `readOnlyHint` on their lookup tools.
- **Prompt-injection defaults in production:** `RETRIEVAL_CONTEXT_MODE=spotlight`,
  `TOOL_OUTPUT_VALIDATOR_ENABLED` on and `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL` on. After a
  finding, write tools need approval (denied without an approval gate). Set them explicitly to
  opt out; this raises a readiness warning.
- **Search scores:** `RERANK_SCORE_TRANSFORM=auto` no longer squashes scores already in [0, 1];
  re-tune `MIN_RERANK_SCORE` or set `sigmoid` to restore the old mapping. Responses always
  carry `score_scale`, and a threshold on a different scale leaves results unfiltered
  (`skipped: "scale_mismatch"`).
- **Role gating:** `POST /autopilot/trigger` and the red-team run/refresh endpoints now need
  `flows:write` (admin); viewers and operators lose them. Control approvals need the operator
  role.
- **Control:** `mutations.retry` is 0, so a failed mutation is no longer repeated. In BFF mode
  behind a reverse proxy set `CONTROL_PUBLIC_ORIGIN`; there is no silent renewal, users sign in
  again after expiry.
- **Eval stack:** `scripts/eval/compose.eval.yaml` embeds with `BAAI/bge-m3`
  (`EMBED_EXPECTED_DIMENSION=1024`). Re-ingest the eval corpus; production embedding settings
  are unaffected, and the CI floors in `baseline/thresholds.json` are not yet recalibrated.

## [0.15.0] — 2026-10-13

### Added

- Supply-chain evidence for release images (Req 13.1, Task 17.1).
  `release.yml` now builds the service images directly as GHCR tags
  (`ghcr.io/abillify/atf-<service>`), signs them with cosign keyless — the
  workflow's OIDC identity is the signing credential, there is no
  long-lived secret — and attaches an SLSA build-provenance and a CycloneDX
  SBOM attestation to every image (each bound to the digest, not the tag,
  so a retag never invalidates the signature). Permissions are minimal per
  job (`contents: read`, plus `packages: write`, `id-token: write` and
  `attestations: write` only in the image job). The signing step fails
  instead of silently skipping when cosign or the id token is missing.
- CI security scans (Req 13.2, 13.3, Task 17.2). New jobs in `ci.yml`:
  `image-scan` builds each of the five production images and scans it with
  Trivy (fails on critical CVEs; unfixed findings are ignored on purpose
  and handled through the base-image digest bumps), `secrets` runs gitleaks
  over the full history (`.gitleaks.toml` with project-specific allowlist
  rules for test fixtures), and `codeql` analyses TypeScript and Rust with
  dedicated configurations under `.github/codeql/` (pinned CodeQL
  `init`/`analyze` actions, one language per matrix job —
  `javascript-typescript` and `rust` — with `build-mode: none`).
- OpenAPI breaking-change check for all services (Req 11.7, Task 17.3).
  `scripts/check-openapi-compat.ts` exports the OpenAPI documents of
  Runtime, Search, Gate and Extract to `docs/openapi/`
  (`bun run openapi:update`) and compares them in CI against the committed
  references (`bun run openapi:check`): removed paths, removed operations,
  new required parameters, changed response-field types and status codes
  break the check; purely additive changes pass. A negative test keeps the
  check itself sharp.
- Lint baseline with fingerprints (Req 13.4, 13.5, Task 17.4).
  `scripts/check-lint-baseline.ts` compares the Biome findings against the
  committed `.biome-baseline.json`; the key is severity + rule + file +
  hash of the source line, so a new finding in a clean file breaks CI, while
  a fixed finding does not narrow the baseline automatically
  (`bun run lint:baseline -- --update` is explicit). The stock dropped from
  655 to 280 findings (−57 %) and errors to 0; all `noExplicitAny` findings
  are gone (types, narrowing or justified `biome-ignore` suppressions), and
  the remaining 280 are exclusively `noNonNullAssertion` warnings in files
  where removing the assertion would break the typecheck.
- Unified contract versioning (Req 11.5, Task 17.5).
  `@atf/extract-contract` has a single source
  (`EXTRACT_CONTRACT_VERSION` in `src/version.ts`), and
  `scripts/check-product-version.ts` (`verify:version`) now checks for every
  contract package that the `package.json` major.minor is at least the
  major.minor of the exported wire-contract constant — a package lagging
  behind its wire promise, such as the former `@atf/extract-contract` 2.2.0
  vs. 2.3.0, breaks the check. The package may run ahead of the wire value,
  because published package versions are never lowered:
  `@atf/identity-contract` stays 1.2.0 (wire 1.1.0),
  `@atf/transaction-contract` and `@atf/evidence-contract` stay 1.1.0
  (wire 1.0.0).
- Branch-coverage proxy for security modules (Req 13.7, Task 17.6).
  `scripts/check-security-coverage.ts` (`bun run coverage:security`)
  enforces ≥ 90 % line and function coverage from lcov for each of
  `auth.ts`, `audit-log.ts`, `pii-vault.ts`, `tool-authz.ts` and
  `prod-gate.ts` — Bun 1.4 cannot report branch data, so lines plus
  functions are the documented substitute. `knip` (configuration
  `knip.json`) runs in CI and reports unused files, exports and
  dependencies.
- TCO guide `docs/OPERATIONS-TCO.md` (Req 12.8, Task 16.8): minimal and HA
  topology with the actual Helm resource defaults, resource needs per
  service and the cost drivers in order — VLM tokens per page
  (`RENDER_DPI`, `MAX_PAGES`, `PAGE_CONCURRENCY`), embeddings per chunk,
  reranker per query (`RERANK_CANDIDATE_MULTIPLIER`) — each as a formula
  with a clearly marked worked example instead of invented prices, plus a
  sizing worksheet and the cost brakes the product already has. Linked from
  `docs/README.md` and `DEPLOYMENT.md`.
- OTel span export for Search and Extract through a shared implementation
  (Req 11.6, Task 16.7). The new package `@atf/observability` contains the
  tracer that used to live only in the Runtime: W3C trace-context parsing,
  batch flushing and OTLP/HTTP JSON export — now identical for Runtime,
  Search and Extract (the Gate keeps its own optional OpenTelemetry-SDK
  tracer). The Runtime keeps a thin shim that injects its egress guard
  (`egressFetch`) as the shared tracer's transport; Search and Extract use
  the default fetch. Both services get one server span per request
  (parented on an incoming `traceparent`, renamed to the route template to
  bound cardinality, `http.*` attributes) and the configuration
  `TRACING_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME`
  (default `atf-search`/`atf-extract`); without an endpoint the tracer runs
  log-only. New: `Span.updateName` on the tracer interface. The
  AsyncLocalStorage now carries the span context of the server span, so
  downstream clients (embedding, reranker, vision) follow the service's
  trace even when the caller sent no `traceparent`.
- Optional service TLS/mTLS and service-token rotation (Req 11.8, Task 16.6).
  Search and Extract accept `TLS_CERT_FILE`/`TLS_KEY_FILE` (a PEM pair; both
  or a startup error) and switch the listener to HTTPS; with
  `TLS_CLIENT_CA_FILE` a client certificate signed by that CA is
  additionally required (mTLS). SPIFFE-compatible workloads fit without
  protocol work: the SVID and trust bundle are ordinary X.509 certificates
  and PEM bundles, and rotation works by replacing the files plus a
  rollout. On the client side Search trusts a self-signed converter via
  `CONVERTER_CA_CERT_FILE` and Extract a self-signed Search via
  `SEARCH_CA_CERT_FILE` (the CA is appended to the platform trust, not a
  replacement). For token rotation both services accept `API_TOKEN_NEXT`
  in addition to `API_TOKEN` — both tokens are valid at the same time; the
  rotation procedure is in `DEPLOYMENT.md`, and the production gate checks
  the minimum length (32) and that the two differ. The building blocks live
  in `@atf/security-kit` (`createServerWithOptionalTls`,
  `createClientTlsInit`, `createStaticTokenMatcher`). The Helm chart mirrors
  this: `search.config.tls.secretName`/`extract.config.tls.secretName`
  mount an existing `kubernetes.io/tls` Secret at `/etc/atf/tls`, the
  probes switch to `HTTPS`, and `extract.config.searchTls` produces the
  `https` `SEARCH_URL`; a CI render-variant job validates this with
  kubeconform. `docs/CONFIGURATION.md` regenerated.

- Hardened Compose quickstart, with extraction anchored in the CI smoke test
  (Req 12.6, 12.7, Task 16.5). Every service in
  `deploy/examples/compose.yaml` now runs with `no-new-privileges`,
  `cap_drop: [ALL]` and CPU/memory limits; Postgres gets back only the
  capabilities it needs for `gosu` and file ownership (`SETUID`, `SETGID`,
  `CHOWN`, `DAC_OVERRIDE`, `FOWNER`). The CI compose job additionally
  smoke-tests the conversion path: a generated PDF is checked against
  `POST /v1/convert` (Extract) and `POST /ingest-file` (Search), so the
  extraction path — not only the health endpoints — is part of the smoke
  test. The Extract image therefore also appears in the CI artifact
  inventories (quickstart binary upload). `.dockerignore` excludes the Rust
  build target of the desktop app (several GB, consumed by no image
  target).

- Reference Helm chart `deploy/helm/atf` (Req 12.3, Task 16.4). An umbrella
  chart with one subchart per service (Runtime, Gate, Search, Extract,
  Control) plus the library chart `atf-common` for the shared templates.
  Every workload runs with a restrictive `securityContext`
  (`runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities.drop: ALL`,
  seccomp `RuntimeDefault`), requests/limits, liveness and readiness
  probes, a `PodDisruptionBudget` and a default-deny `NetworkPolicy` (only
  the documented service-to-service callers; ingress open for `control`,
  optionally `gate`/`search`/`extract` via `expose`). The chart contains no
  secret values; it references existing Secrets (`global.secrets.<service>`,
  `envFrom`), and the migration hooks read the database URL via
  `secretKeyRef`. Migrations run as `pre-install`/`pre-upgrade` jobs with
  hook weights (Runtime 10, Search 20, Extract 30), and the replicas start
  with `MIGRATE_ON_START=false`. `values.schema.json` validates all values
  (among others the digest format and resource quantities); the CI job
  `helm` runs `helm lint` and `kubeconform -strict` over every rendered
  manifest (both tools pinned by checksum). `check-product-version.ts`
  includes the `appVersion` of all seven chart files in the version sync.
- Separate liveness and readiness endpoints for Search and Extract
  (Req 12.5, Task 16.3). Both services now serve `GET /health/live` (pure
  process liveness; deliberately checks no dependencies — a slow backend
  must not trigger a restart loop) and `GET /health/ready` (the
  load-balancer gate): Search on a PostgreSQL ping, Extract on the Poppler
  binaries and the vision endpoint — the same fatal criteria as `/health`,
  without the LibreOffice and Search reports (missing LibreOffice only
  degrades Office formats, an unreachable Search only `/v1/ingest`;
  `?deep=1` forces a new probe). The composite `GET /health` stays
  unchanged for backward compatibility (Compose health checks, `/ui`).
  Runtime (`/health/live`, `/health/ready`) and Gate (`/healthz`,
  `/readyz`) were already separate. OpenAPI of both services extended;
  overview table in `DEPLOYMENT.md`.
- Standalone `migrate` command per service (`bun run migrate` in Runtime,
  Search and Extract, Req 12.4, Task 16.2). The scripts
  (`apps/<svc>/scripts/migrate.ts`) call the same migrators as the startup
  path, all of which run under a PostgreSQL advisory lock — a migration job
  and booting replicas serialize safely. The scripts read only the
  database variables (Search additionally the DDL knobs
  `VECTOR_HALF_PRECISION`, `HNSW_M`, `HNSW_EF_CONSTRUCTION`), so a job needs
  only the database Secret. Exit 0 = schema at the target version
  (including "already up to date"), exit 1 = error. New:
  `MIGRATE_ON_START` controls whether a service migrates on boot; unset
  means `true` outside production and `false` with
  `APP_ENV`/`NODE_ENV=production` — production replicas no longer run DDL
  on their boot path. An explicit `true`/`false` always wins. Details in
  `DEPLOYMENT.md`.
- Production Dockerfiles per service under `deploy/images/`
  (`Dockerfile.runtime`, `.search`, `.gate`, `.extract`, `.control`,
  Req 12.1/12.2, Task 16.1). Multi-stage with `bun install --frozen-lockfile
  --production --filter @atf/<svc>`, base images pinned by digest, every
  container runs as non-root UID/GID 65532 and starts with a read-only root
  filesystem (tmpfs only where needed). Runtime, Search and Gate use the Bun
  distroless image; because it ships no `libstdc++`/`libgcc_s`, those ABI
  libraries are copied from the deps stage so that `sharp` (Search) and the
  lazily imported NER stack (`@huggingface/transformers`/`onnxruntime-node`,
  Runtime) stay loadable. Extract runs on `debian:bookworm-slim` with
  Poppler and LibreOffice (nogui), including a build-time check of the
  converters; Control builds the Next.js standalone output and starts it
  with `node server.js` (the `next start` equivalent) on `node:26-alpine`.
  The images were smoke-tested over HTTP (`/health/ready`, `/health`,
  `/readyz`).
- The supply-chain inventory now also covers the Rust dependencies of
  Outpost Desktop (Req 10.7, Task 14.4b). With `--include-cargo`,
  `scripts/generate-supply-chain.ts` reads the crate graph from
  `apps/outpost-desktop/src-tauri/Cargo.lock` via `cargo metadata --locked`
  (registry sources only; the local `atf` crate belongs to the project, not
  to the third parties) and adds the crates as `pkg:cargo/` components to the
  notices and the CycloneDX SBOM; the header and the SBOM metadata also
  record the SHA-256 of `Cargo.lock`. License-text resolution follows the
  existing tiered plan (crate-archive texts, NOTICE files, reviewed
  declared-license fallbacks under `licenses/` for the crates.io-typical
  cases in which the archive does not ship a license branch declared in the
  manifest, without invented copyright holders); crates.io license
  expressions (`MIT/Apache-2.0` slashes, `WITH` exceptions, LGPL choice) are
  normalized before the policy check. Strong copyleft licenses (GPL/AGPL,
  SSPL, BUSL and others) stay blocked and now also fail in the Rust graph.
  The committed Linux-x64 workspace reference was regenerated in a Linux
  container with Cargo (1153 package versions: 626 npm + 527 cargo) and is
  byte-for-byte reproducible; image inventories stay npm-only because the
  image build containers have no Cargo. CI (`hygiene`,
  `supply-chain-workspace`) generates and checks the inventories with
  `--include-cargo` after a preceding `cargo fetch --locked`.
- `@atf/security-kit` now covers the complete building-block list of
  Req 11.1: header utilities (`parseBooleanHeader`, `readHeader`,
  `readListHeader`, `decodeIfBase64`, `sanitizeHeaderValue` including
  `base64:` prefix decoding), an HTTP rate-limiter middleware around the GCRA
  core (`createRateLimitMiddleware`, structural request/response types
  without an Express dependency, `trustProxy`, `rejectBody`, `max: 0`
  disables it), a synchronous `takeSync` path in the memory backend, and the
  discovery client's `issuerMatch: "trailing-slash"` option for providers
  such as Authentik whose document issuer carries a trailing slash.
- Search and Extract move their duplicated auth building blocks to
  `@atf/security-kit` (Req 11.2): constant-time comparison runs through
  `safeEqual` (SHA-256 digest, no length oracle), OIDC discovery through the
  kit's single-flight client, JWT verification in both apps through the
  kit's `createJwtVerifier` (JWKS resolution via the discovery document,
  exact issuer check against `document.issuer`), the rate limiters through
  the GCRA middleware core, and the header utilities are thin re-exports of
  the kit. Existing import paths, response formats (including the Extract
  429 body with `code: "RATE_LIMITED"`) and principal mappings are
  unchanged; the related behavior tests (Search 107, Extract 25) stay green.
  Behavior differences compared with the previous local implementations:
  (1) the rate limiter refills smoothly (GCRA) instead of window-edge based,
  so there are no double bursts at window boundaries; (2) discovery now
  rejects a document issuer that does not match (trailing slash tolerated)
  instead of only warning; (3) Extract JWTs now require an `exp` claim;
  (4) after a discovery failure a negative cache with backoff applies (30 s,
  doubling, max. 5 min) instead of an immediate retry. Removed local copies:
  `fetchDiscovery`/`base64Url`/`timingSafeEqualStr` (both OIDC modules),
  `safeCompare` (both auth modules), sliding-window limiters (both rate
  limiters), `fetchJwksUri`/local JWKS verification (both JWT verifiers).
  The kit's test inventory grows to 214 tests (including header, middleware
  and `issuerMatch` contracts).

- Contracts instead of own implementations: Runtime and Gate import the
  identity, transaction and evidence contracts from the contract packages
  (Req 11.3). Runtime: `TransactionBudget`, `TransactionTrace`,
  `DelegationHop` and `TransactionEnvelope` are now type aliases of
  `@atf/transaction-contract` (`TransactionEnvelopeV1` including
  `TRANSACTION_ENVELOPE_PROTOCOL_VERSION`); envelope validation in
  `TransactionTokenValidator` runs through `TransactionEnvelopeV1Schema`
  instead of hand-written field checks. The evidence meta keys,
  `canonicalJson`/`sha256Hex` and contract serialization come from
  `@atf/evidence-contract` (`inspectEvidenceActionContract`); the Runtime
  `EvidenceActionContractMeta` keeps only the deprecated alias `hash`.
  `AuthPrincipal` is now `RuntimePrincipalInput` from
  `@atf/identity-contract`. Gate: `ActorContext` is `Actor`, `AuthContext`
  extends `GatePrincipalInput`, and `actorFromClaim` comes from
  `@atf/identity-contract` instead of a local copy. All existing import
  paths and wire field names stay stable through aliases; pack discovery
  (v1/v2 tool results) stays Runtime-specific.
- Runtime: edge data-flow traces respect PII redaction and tokenization
  (Req 7.12). The classifier `classifyEdgeFlow`
  (`apps/runtime/src/graph/edge-flow.ts`) accepts an optional `redact`
  callback that scrubs every free-text item content (query, answers,
  classification/transcription, tool results, client tool names, sources)
  BEFORE excerpt scoring, so no raw PII lands in the debug trace while output
  redaction is active, and an excerpt cut can no longer split a PII value in
  half. The engine path (`recordEdge` in `graph-engine/handler-factories.ts`)
  passes the same effective output guardrail (including the per-flow
  override) as the SSE stream; without a guardrail the trace is unchanged
  (passthrough). Already tokenized content (PII vault, `[[PII:…]]`) matches
  no detector and stays unchanged, so tokenization is respected instead of
  processed twice. Tests: unit block in `edge-flow.test.ts` (scrubbing of
  all channels, redact-before-excerpt, vault passthrough, off mode) plus the
  integration test `edge-flow-redaction.test.ts` (real engine run with the
  guardrail on/off against `InMemoryDebugTraceStore`).
- Runtime: asymmetric transaction tokens and a JWKS route (Req 7.11).
  `TransactionTokenIssuer`/`-Validator`
  (`apps/runtime/src/transaction/token.ts`) now support
  `TRANSACTION_SIGNING_ALG=HS256|ES256|EdDSA` (default: HS256, fully
  backward compatible); the asymmetric private key comes as a PKCS8 PEM from
  `TRANSACTION_SIGNING_KEY`. Asymmetrically signed tokens carry a `kid`
  header (JWK thumbprint of the public key); verification uses the public
  key derived via node:crypto. New public route
  `GET /.well-known/atf-transaction-jwks.json`
  (`apps/runtime/src/routes/transaction-jwks.ts`): with ES256/EdDSA it
  publishes the public JWK (`kid`, `alg`, `use: "sig"`) with
  `Cache-Control: public, max-age=300`, with HS256 an empty key set
  `{"keys":[]}`; an invalid PEM fails closed with 500
  `transaction_jwks_unavailable`. The Gate needs no code change: it already
  verifies via `MCPGATE_TRANSACTION_JWKS_URI` (remote JWKS). Prod gate:
  warning for HS256 signing in production, fatal for a broken signing
  configuration; `AGENT_TRANSACTION_SECRET` stays configurable as before.
  Note: Bun 1.4.2 returns non-extractable CryptoKeys, so public-JWK/kid
  derivation and the verification import use node:crypto instead of
  `jose.exportJWK`.
- Runtime: central SQL identifier allowlist (Req 7.10). New module
  `apps/runtime/src/db/sql-identifier.ts` with `isSafeSqlIdentifier()` and
  `safeSqlIdentifier()`: a single validation point for all identifiers
  (table, column, index names) interpolated into SQL at runtime (lowercase
  `[_a-z][a-z0-9]*`, max. 63 bytes; quotes, semicolons, whitespace, dots and
  non-ASCII are rejected). Connected call sites: `tenant-manager.ts`
  (dynamic `SET` columns in `updateTenant`), `vector-store.ts` (table name
  of `PgVectorStore`, replaces the previous inline regex),
  `distributed-semaphore.ts` and `postgres-store.ts` (constant table names,
  fail fast at module load) and `skill-canary.ts` (column prefix
  `treatment`/`control` in the outcome UPDATE). Values stay parameterized
  throughout. Tests: `apps/runtime/src/db/__tests__/sql-identifier.test.ts`.
- Runtime: API key hashing with a server pepper (Req 7.9). New environment
  variable `API_KEY_PEPPER` (default: empty; empty means "disabled",
  whitespace counts as unset). When the pepper is set, new API keys are
  stored with HMAC-SHA-256 (`hash_alg='hmac-sha256'`) instead of unsalted
  SHA-256. The `hash_alg` column arrives with migration 45
  (`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS hash_alg TEXT NOT NULL
  DEFAULT 'sha256'`). The lookup checks the HMAC candidate first, then the
  SHA-256 fallback; `hash_alg` is part of the SQL predicate, so a migrated
  row never matches through its old hash. On a SHA-256 hit the lookup
  migrates the hash lazily to HMAC (awaited, but fault tolerant: a migration
  error never affects authentication). Both stores (`InMemoryTenantStore`,
  `PostgresTenantStore`) take the pepper as a constructor option; the value
  comes from `config.apiKeyPepper` via `bootstrap/persistence.ts`. The
  production readiness gate warns when `API_KEY_PEPPER` is not set under
  `APP_ENV=production`. Tests:
  `apps/runtime/src/graph/__tests__/tenant-manager.test.ts`
  (generateApiKey + pepper describe block with a fake DB),
  `apps/runtime/src/config/__tests__/config.test.ts`,
  `apps/runtime/src/config/__tests__/readiness.test.ts`.
- Runtime: `policy_stale` metric/health flag and
  `aiperator_degraded_total{component}` on all fail-open paths (Req 7.7,
  7.8). The tool-authz loader (`apps/runtime/src/graph/tool-authz-loader.ts`)
  sets the `policyStale` flag on every failed reload of `tool-authz.json`
  (parse or read error) and counts `aiperator_policy_stale_total`; a
  successful reload clears the flag again. A merely missing file still means
  "no policy configured" and marks nothing as stale. `/health/ready` reports
  an informational `policy_stale` check (`degraded` with a hint at the
  last-known-good state, never a trigger for 503; the last valid policy
  keeps being enforced). All fail-open degradations now count
  `aiperator_degraded_total{component}`: `rate_limit` (store errors in open
  mode; closed mode rejects and does not count), `semaphore` (Redis and
  Postgres limiters), `thread_lock` (Redis errors, aborted or exhausted wait
  budgets), `rag_compression` (factory/model errors, unparsable model
  output), `history_summarizer` (factory or model-call errors) and
  `memory_extractor` (model errors). The metrics instance is created in
  `index.ts` before `buildCache` and passed through the bootstrap modules
  (`observability`, `cache`) and optional trailing parameters to all
  components. New tests: `tool-authz-loader.test.ts` (8), the
  `policy_stale` describe block in `health.test.ts` (4) and
  degradation-metric assertions in `rate-limit`, `distributed-semaphore`,
  `thread-lock`, `memory-extractor`, `history-summarizer` and
  `rag-compression`.
- Security_Kit/Runtime/Gate: `jwks_uri` validation in OIDC discovery
  (Req 7.3, 11.2). After the exact issuer match, `@atf/security-kit`
  (`src/jwt/discovery.ts`) also checks the `jwks_uri` taken from the
  discovery document: HTTPS is mandatory as soon as discovery itself is
  reachable over HTTPS; the host must match the issuer host, the host of the
  discovery URL itself (for a non-standard `discoveryUrl`) or the allowlist
  `allowedJwksHosts` (exact entries or `.suffix` subdomains); invalid URLs are
  rejected. `allowInsecureJwksUri: true` disables the HTTPS requirement
  locally (development). Four discovery call sites in the Runtime now use the
  kit client instead of their own implementations:
  `middleware/jwt-verifier.ts`, `routes/auth-oidc.ts` (a cache instead of the
  permanent `metadataCache`, now a TTL with a 5-minute floor and negative
  back-off), `routes/rocketchat-connect.ts` and
  `assistants/token-minter.ts`; the Gate wrapper in
  `apps/gate/src/auth/authenticator.ts` was moved onto the kit client. Fixed
  along the way: Rocket.Chat Connect previously verified `id_token` with a
  bare `createRemoteJWKSet` (Egress_Guard bypass) and now uses `customFetch`
  through the guard fetch. 8 new tests in
  `packages/security-kit/test/discovery.test.ts`.
- Runtime: Egress_Guard for outbound HTTP traffic (Req 7.1, 7.2). New core
  `apps/runtime/src/security/egress.ts`: `createRuntimeEgress()` /
  `initRuntimeEgress()` / `egressFetch` with SSRF protection: private,
  loopback, link-local and metadata addresses are blocked unless an exact
  hostname exception is listed in `EGRESS_ALLOW_PRIVATE_HOSTS` (split DNS);
  always-forbidden ranges (metadata, `0.0.0.0`, CGNAT …) stay closed via
  `@atf/security-kit` (`isAlwaysForbiddenAddress`). DNS pinning through a
  connect-time hook (the resolved address set is checked and the first
  allowed address is pinned, so there is no TOCTOU rebinding), IP literals
  are validated eagerly (Bun bypasses the lookup hook for literals),
  redirects are fully revalidated per hop (max. 5 hops), and response sizes
  are capped at `EGRESS_MAX_RESPONSE_BYTES` (default 64 MiB, 0 = unlimited);
  optional `EGRESS_TIMEOUT_MS` and `EGRESS_ALLOWED_HOSTS` (suffix entries
  with `.` are possible). All 22 call sites in the Runtime (JWT
  verifier/JWKS, OIDC discovery, provider testing, Rocket.Chat, MCP
  client/Stateless-2026/token minter, eval, tracing, reranker, remote PII
  detector, SLO, LLM factory, red team) now go through the guard or
  injectable `fetchFn` seams with a guard default; `initRuntimeEgress()` is
  installed in `index.ts` after `loadConfig()`. CI hygiene:
  `scripts/check-raw-fetch.ts` (`bun run check:raw-fetch`) forbids a bare
  `fetch(` outside the guard and tests and runs as its own step in the CI
  pipeline.
- Gate/Runtime: RFC 8693 token exchange for downstream MCP servers
  (Req 6.13). The complete exchange implementation (`TokenExchanger`,
  `ActorTokenProvider`, `createTokenEndpointResolver`) now lives in
  `@atf/security-kit` (`src/auth/token-exchange.ts`, 15 tests), with a
  structural `ExchangeLogger` so both the Runtime and the Gate logger fit;
  `apps/runtime/src/auth/token-exchange.ts` is a thin re-export. New Gate
  config field `server.tokenExchange` on the `mcp-proxy-tool` (mirrors the
  Runtime schema: `tokenEndpoint`/`issuer`, `clientId`, `clientSecretEnv`,
  `audience`, optional `scope`, `requestedTokenType`, `timeoutMs` and `actor`
  for delegation): before every downstream call the executor mints an
  audience-bound token and sends it instead of the login token. Fail closed:
  a failed exchange ends the call (`meta.tokenExchangeFailed`), the
  un-exchanged token is never sent as a fallback; a configured but never
  resolved `clientSecretEnv` also refuses the call. Token endpoint requests
  go through `secureOutboundFetch` with the same allowlist as the downstream
  call (SSRF). The loader resolves `clientSecretEnv` (and
  `actor.clientSecretEnv`) at startup and throws for a missing/empty
  variable; `tokenExchange` and `forwardBearerToken` are mutually exclusive.
- Gate (mcpgate): approval redemptions are now safe across replicas
  (Req 6.1). New interface `ApprovalConsumptionStore`
  (`apps/gate/src/mcp/approval-store.ts`) with a Redis implementation
  (`SET atf:approval:{jti} 1 PXAT exp NX`, i.e. an atomic single-use
  reservation across all replicas) and a memory implementation that, at its
  capacity limit, evicts the entry with the earliest `exp` via a min-heap
  instead of FIFO; expired JTIs are removed lazily. The store is created only
  when approval rules are configured, shared through the app wiring and
  reported in readyz as `approvalConsumption: memory|redis`. New prod gate:
  `MCPGATE_REPLICAS > 1` without Redis (transaction, rate-limit or monitoring
  URL) is fatal in production; single replicas may still fall back to the
  memory map (warning).
- Control: E2E suite for the five operator pages and a contract test against
  the real Runtime (Req 9.10). `apps/control/e2e/ops-pages.spec.ts`
  (Playwright, mock backend) checks Studio (flow picker with a loaded flow
  list), Approvals (pending list, approve POST to `/monitoring/approvals/{id}`
  with `{ approved: true }`, empty state afterwards), Autopilot
  (configuration, run history with promotion), Canary (rollout display with
  traffic percentage, empty state) and Tenants (list, search, detail tabs
  API Keys/Usage/BYOK). `integration/system/control-runtime-contract.test.ts`
  boots the real Runtime router factories (`createFlowsRouter`,
  `createControlRouter` with `createApprovalGate`/`createCanaryManager`,
  `createTenantsRouter` with `InMemoryTenantStore`) and validates every
  response against the exact consumer shapes of the Control UI: if the
  Runtime renames a field, the contract test fails before the Control
  silently renders empty panels.
- Control: coverage thresholds in the Vitest configuration (Req 9.11).
  `vitest.config.ts` now enforces on every `bun run test` (coverage is on by
  default, `@vitest/coverage-v8`) a minimum of 50 % statements, 45 %
  branches, 45 % functions and 50 % lines across `src/**`, just below the
  measured baseline (58/51/52/60 %), so regressions fail immediately.
  `bun run test:coverage` runs the same suite explicitly.
- Documentation consistency gates (Req 14.1–14.3, Tasks 20.2–20.3):
  `check:workspace-counts` compares the workspace counts stated in README
  and ARCHITECTURE against the real workspace lists from `package.json`
  (7 apps, 10 packages, 1 integration) and runs in the hygiene job;
  `route-reference:check` validates the generated Runtime route-group table
  in `ARCHITECTURE.md` against the Runtime's route catalog — which fixed a
  bug in the catalog itself (direct-route detection searched the masked
  instead of the real source text).
- OpenAPI served by Runtime and Gate (Req 14.4, Task 20.5): both services
  now generate complete OpenAPI 3.1 documents from their routes and serve
  them at `/openapi.json` and `/openapi.yaml`; `openapi:check` checks the
  baselines of all four services (Runtime, Gate, Search, Extract) in CI,
  and two new tests enforce that every route carries a tag and every
  documented route exists.
- Operations documentation (Req 14.5–14.6, Task 20.6): four runbooks under
  `docs/runbooks/` — `backup-restore.md` (what to back up, Postgres backup
  and restore, point-in-time recovery, what must never be restored
  blindly), `key-rotation.md` (PII vault, OIDC, BYOK and audit-anchor
  secrets, with recommended rotation frequencies), `incident.md` (roles,
  severity, first 15 minutes, investigation aids, erasure requests during an
  incident, recovery) and `scaling.md` (sizing baseline and horizontal
  scaling per service); `docs/UPGRADE.md` with the upgrade path 0.3 →
  current, including every migration since 0.9; `docs/THREAT-MODEL.md` as a
  STRIDE model across six application surfaces including the Outpost and
  the desktop updater; `docs/DSFA-VORLAGE.md` and `docs/VVT-VORLAGE.md` as
  fillable GDPR templates (Art. 35 DPIA and Art. 30 record of processing
  activities) with product-specific notes.
- Outpost documentation (Req 14.7, Task 20.7): new
  `apps/outpost-desktop/README.md` (architecture WebView → Tauri IPC →
  sidecar, IPC-token handshake, keychain storage, disabled updater) and
  `packages/outpost-core/README.md` (source adapters, sync planner, delete
  brakes, path guard); `SECURITY.md` extended with the Outpost scope
  (credential disclosure, sidecar protocol, path-guard escape, delete
  mirroring) and `docs/CAPABILITIES.md` with the Outpost chapter;
  `docs/README.md` now lists all application and reference documents,
  including the ADR index.
- ADR index and six new ADRs (Tasks 20.6, 20.8): `docs/adr/README.md`
  indexes all 29 decisions (0001–0029) with their status; new are 0024
  (shared security kit), 0025 (cross-service erasure orchestrated by the
  Runtime), 0026 (audit hash chain and signed anchors), 0027 (CSP nonces in
  the operator plane), 0028 (converter isolation as a sidecar) and 0029
  (verifiable execution receipts).
- Markdown link checker (Req 14.9, Task 20.8): `scripts/check-markdown-links.ts`
  (`bun run check:links`, a new hygiene CI step) checks every relative link
  and anchor in the repository's Markdown files — code blocks are masked and
  GitHub slug rules are applied to anchors; it found and fixed three dead
  links in `deploy/examples/flows/README.md`.
- Verifiable execution receipts (Req 15, Tasks 21.1–21.8, ADR 0029). With
  `DECISION_RECEIPTS_ENABLED=true` the Runtime issues one signed receipt per
  chat completion and per tool call, carrying the flow id and version,
  hashes of the prompt template, tool authorization and compliance policy,
  model and provider, the PII tokenization proof, retrieval sources with
  revision ids, the approval chain, cost, timestamps and the response hash
  — without PII in clear text. The signature is a COSE_Sign1 (Ed25519,
  WebCrypto) over deterministic CBOR (RFC 8949, shortest encoding, in
  `@atf/security-kit` with RFC 8949 test vectors); every receipt is
  appended to an append-only transparency log with a Merkle tree and is
  backed by a signed tree head with an inclusion proof. New endpoints:
  `GET /v1/receipts/{id}` and `GET /v1/receipts/{id}/proof` (Merkle proof
  plus signed tree head), `GET /.well-known/atf-receipt-jwks.json` (JWKS)
  and `GET /v1/receipts?execution_id=` (collection for the trace viewer);
  chat responses carry the receipt reference in the `X-ATF-Receipt`
  header. Persistence: migration 46 (`receipt_log`, `receipt_tree_heads`,
  hex TEXT, append-only). At startup the transparency log is rebuilt from
  `receipt_log`, so positions and proofs continue across restarts, and
  `GET /v1/receipts/{id}` and `/proof` fall back to the rebuilt log when
  the bounded in-memory store no longer holds the receipt (same tenant
  check). While audit anchoring is active, tree heads are sealed
  periodically on `AUDIT_ANCHOR_INTERVAL_MS` (only when the log grew) and
  persisted in `receipt_tree_heads`. One receipt-issuing writer per
  database is assumed (ADR 0029). The new CLI `atf-verify` (`scripts/atf-verify.ts`,
  also as a compiled binary via `bun run atf-verify:build`) checks receipt,
  signature and inclusion proof offline against a JWKS — without a
  connection to the Runtime. Control shows receipts in the trace viewer
  ("Receipts" tab), verifies signature and inclusion client-side through
  `@atf/security-kit/browser` and exports single receipts or all receipts
  of an execution as JSON. Cross-consistency: Control tests verify the
  proofs produced by the Runtime transparency log with the mirrored browser
  implementation.
- Policy replay simulator (Req 16, Tasks 22.1–22.3): `POST
  /admin/policy-replay` replays stored executions dry against candidate
  policies (tool authorization and compliance) and reports, per execution,
  the old and new outcome plus every flipped tool call with the deciding
  rule — and a summary (evaluated, changed, newly denied, newly allowed,
  highlight rows) and optional guardrail scans of the stored prompts. The
  simulator (`src/replay/policy-replay.ts`) works exclusively through a
  read-only execution source (`ReplayExecutionSource`); candidate policies
  are validated against the Zod schemas before evaluation, and the live
  engine of the current tool authorization stays the "old" side (no round
  trip through `describe()`). A property test (Property 17, fast-check)
  proves the absence of side effects: the execution store is bit-identical
  after the simulation, the evaluation is idempotent and invalid candidates
  touch nothing. Progress is optionally streamed over SSE
  (`POST /admin/policy-replay/stream`); every run writes a `policy.replay`
  audit entry. Control shows the simulator on the compliance page ("Policy
  Replay Simulator" panel) with JSON fields for the candidate policies, a
  diff table with old→new badges and an invert filter.

### Changed

- The product's seven monoliths are split into modules below 1500 lines
  (Req 13.6, Tasks 18.1–18.5), behaviour-neutral: all public import paths
  stay valid (the entry files re-export where they did before). The Runtime
  handler `graph/handlers/llm.ts` (5081 lines) separates provider
  ingredients, the candidate loop, streaming, tooling and metering into
  eleven `llm-*` modules (now 733); `graph/agent-harness/loop.ts` (3610)
  moves delegation, findings, coverage, verification, stop logic and
  outcome into eight `loop-*` modules (1441); `index.ts` (2651) becomes a
  lean composition root whose bootstrap steps (engine, persistence, cache,
  guardrails, observability, MCP, routes, assistants, Autopilot, red team,
  operator auth) live in `bootstrap/*` (about 1150); `routes/flows.ts`
  (3043) splits into `flows-shared`/`flows-context` plus six
  `flows-routes-*` modules (62); `graph/graph-engine/handler-factories.ts`
  (2888) into run state, tool callbacks, node lifecycle and tool usage
  (1429). In Search, `postgres-client.ts` (6452 lines) splits into
  `pg-types`/`pg-helpers`/`pg-engine-detect` plus five method modules
  behind a narrow `PgFactoryCtx` (342), and `handlers/mcp.ts` (3307) into
  `mcp-tool-ctx` plus one registration module each for transaction,
  search, ingest and catalog tools (859); the existing `mcp-nav` pattern
  (context interface plus register function) was adopted for this. Tool
  registration, the registration boundary (authz enforcement, invocation
  ledger) and all MCP protocol paths behave exactly as before; the Search
  and Runtime suites pass, and the lint baseline keeps its number of
  findings — the findings only moved into the new files.
- Lint cleanup across all workspaces (Req 13.4, 13.5, Task 17.4). 245 `!`
  assertions were removed where their type errors could be solved cleanly
  (narrowing, explicit checks, correct signatures); the rest stay in the
  fingerprint baseline. The `abortSignal` casts to `any` in the Search LLM
  clients were unnecessary (the SDK accepts `AbortSignal`) and are gone;
  `activity-emitter.ts` now types events as `unknown[]` instead of
  `any[]`. The test mocks in `auth.test.ts` and `loader.test.ts` use
  narrowing instead of `any`. Dead code removed:
  `apps/control/src/hooks/useSessionRenew.ts` — silent token renewal lives
  entirely in `AuthProvider` (`renewNow`); the hook was imported nowhere,
  had no tests and was reported by `knip`. The `onResolve` property of
  `ApprovalsPanel` is now typed `void` instead of
  `Promise<boolean | void>` — the hook's `Promise<boolean>` stays
  assignable, and so do callers returning void.
- Supply-chain generator: reviewed declared-license fallback rules for the
  native binary packages `@oxc-parser/binding-*` and
  `@oxc-resolver/binding-*` (optional knip dependencies; darwin-arm64 and
  linux-x64 gnu/musl) — their manifests declare MIT, but the tarballs
  contain only `package.json` and the `.node` binary; the canonical MIT
  text is attached without an invented copyright holder. `sbom.cdx.json`
  and `THIRD_PARTY_NOTICES.md` regenerated as the linux-x64 reference
  (1172 package versions).
- Outpost: the release pipeline `outpost-release.yml` meets the same
  hardening standard as `release.yml` (Req 10.1, 10.2, Task 14.1). All action
  references are pinned to commit SHAs with a version comment; `permissions`
  is set to `{}` globally and granted minimally per job. A new `guard` job
  enforces, before every release, the exact tag SHA, ancestry to `main`, a
  successful CI run on exactly that SHA and version equality of the tag with
  all Outpost packages; the build/sign/release jobs depend on `guard`. A
  signed build aborts while `plugins.updater.pubkey` in `tauri.conf.json` is
  a placeholder or no updater endpoint is effective (neither
  `plugins.updater.endpoints` nor `vars.OUTPOST_UPDATER_REPO`) (Req 10.5,
  Task 14.3): a real Minisign public key and an updater endpoint are
  mandatory before signature artifacts are produced.
- Outpost Desktop: Tauri CSP set (Req 10.3, Task 14.2). Instead of
  `csp: null` a restrictive policy now applies (`default-src 'self'`, scripts
  from self only, `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'self'`); besides `'self'`, `connect-src`
  allows only the IPC endpoint and loopback-addressed Control API ports
  (`http://127.0.0.1:*`), so the desktop client keeps its Control API access.
  The desktop E2E suite (`tests/a11y.spec.ts`, runs against
  `VITE_OUTPOST_CONTROL_URL`) still checks the status/config flow and the
  shell's accessibility.
- Outpost Desktop: `ATF_OUTPOST_EXECUTABLE` is only honored in debug builds
  (Req 10.4, Task 14.3). Sidecar resolution in `lib.rs` ignores the
  environment variable under `#[cfg(not(debug_assertions))]`, so a release
  build only starts the bundled sidecar and no environment-variable attack
  can slip in a foreign process; unit tests cover both branches.
- CI: the Outpost jobs are fully built-out gate jobs (Req 10.6, Task 14.4).
  The `outpost` job in `ci.yml` now runs `cargo fmt --check`, `cargo test`,
  `cargo deny check` (new `apps/outpost-desktop/src-tauri/deny.toml` with
  allowed license lists and a `ring` clarification) and `cargo audit`
  against `Cargo.lock`; the `test` job of `outpost-release.yml` installs the
  Tauri system dependencies so `cargo test` also compiles in the release
  pipeline.
- Control: the production build runs without `--experimental-build-mode
  compile` (Req 9.12). The build script in `apps/control/package.json` now
  calls the regular `next build`; verified with a complete prerender run
  (32/32 pages), working standalone output (`node apps/control/server.js`
  serves Studio/Approvals/Tenants with 200) and the deployment sequence from
  the Dockerfile/CI (`build` + `next build --experimental-build-mode
  generate`), which still passes unchanged. No ADR is needed because the
  first alternative of the requirement is met; the E2E suite was also run
  against the production standalone build (6/6 green).

- Control: consolidated information architecture and a guided first run
  with empty states (Req 9.9, Task 13.8). The provider test bench moves from
  the standalone route `/provider-testing` into a "Test bench" tab on
  `/providers` (Monitoring/Testing as controlled `Tabs`, panels are only
  mounted for the active tab, heavy panels via `next/dynamic` with
  `ssr: false`); the flow version diff moves from `/flow-diff` into a "Diff"
  tab on `/flows` (Registry/Diff). Both old routes stay as server-side
  `redirect()` stubs and forward to the tab deep link
  (`/providers?tab=testing`, `/flows?tab=diff`) so bookmarks keep working;
  each page reads the active tab from `?tab=` via `useEffect` (same
  convention as `?flow=` on `/optimizer`). `NAV_GROUPS` in `src/lib/nav.ts`
  loses both entries (and with that, they leave the ⌘K palette), the i18n
  catalogs `en`/`de` lose their `nav.provider-testing`/`nav.flow-diff` keys;
  the hints of `nav.providers`/`nav.flows` now describe both tabs. New
  `EmptyState` primitive in `src/lib/ui` (dashed card, icon in a muted
  circle, title/description/action slot): wired up as a guided first run on
  `/graph` (links Studio and Providers while no executions exist) and for
  the empty states of Approvals, the flow registry and the provider key
  pool. `docs/UI-STYLE-GUIDE.md` §7/§8/§9 document the consolidated
  navigation, the primitive and the tab-consolidation/first-run pattern.
  Tests: `EmptyState.test.tsx`, `ProvidersPage.consolidation.test.tsx`,
  `FlowsPage.consolidation.test.tsx` (8 new cases; Control suite 110 files /
  937 tests).
- Control: hard-coded colors are fully replaced by design tokens (Req 9.8,
  Task 13.7). `globals.css` defines semantic status families
  (`success`/`warning`/`danger`/`info` plus `copilot`/`subflow`/`accent-2`)
  with six slots each (DEFAULT, `solid`, `solid-hover`, `foreground`, `soft`,
  `border`; `*-solid`/`*-foreground` are deliberately theme-fixed,
  DEFAULT/`soft`/`border` adapt via `.dark`), `--on-solid` for text on solid
  surfaces, node category tokens (`--node-*`, 13 kinds + default), subflow
  slots (`--cat-1..6`), chart tokens (`--chart-*`) and canvas edge tokens
  (`--edge-*`, `--canvas-dots`), all exposed as Tailwind colors in
  `tailwind.config.ts`. Bulk conversion: 806 class replacements in 92 files
  (Tailwind palette shades `*-500` …, `bg-white`, `text-white` and
  `slate`/`gray` tones → semantic tokens); tokenized by hand:
  `graphUtils.ts` (node fills, status dots, approval rings/badges),
  `subflows.ts`, `canvasIds.ts`, `edge-channels.ts`, `LabeledEdge.tsx`,
  `useCanvasGraph.ts`, `GraphVisualizer.tsx`. For non-className contexts:
  React Flow props (`markerEnd.color`, edge `style.stroke`, MiniMap
  `nodeColor`, `<Background color>`) accept `var(--token)` strings (inline
  style based, verified in RF 12.11.2); Recharts `stroke`/`fill` are SVG
  presentation attributes and are mapped to the current theme resolution
  through the new hooks in `src/lib/theme/palette.ts` (`useChartPalette()`,
  `useEdgePalette()`, `useNodePalette()` + `nodeTypeVarColor()`)
  (MutationObserver on `<html>`, hex fallback for SSR/jsdom), applied in
  `MetricsSidebar`, `CostPanel` and `LimitsPanel`. No hex value, no `rgb()`
  and no palette shade remains outside `palette.ts`/tests;
  `docs/UI-STYLE-GUIDE.md` §3 documents the tokens and removes the previous
  raw-palette exception. Visible change: status and edge colors are now
  dark-mode adaptive and consistent; test assertions follow the new class
  names (semantics unchanged).
- Control: new thin i18n layer with the languages `de` and `en` (Req 9.7,
  Task 13.6). Decision against a library (next-intl, react-intl): the need
  is a flat key→string catalog without plurals, interpolation or lazy
  loading, so the in-house layer (`src/lib/i18n/`) stays at a
  provider/hook, `Intl` formatters and a cookie-based locale switch, with no
  new runtime dependency and no bundle bloat. New: `LocaleProvider`/
  `useI18n()` with a type-safe `t(MessageKey)` (the `en` catalog is the
  source of truth, `de` is enforced by a parity test), the `NEXT_LOCALE`
  cookie, a dynamic `<html lang>` from the cookie (root layout, read on the
  server) and `LocaleToggle` in the header. `src/lib/i18n/format.ts`
  provides locale-aware `Intl` formatters (`formatNumber`,
  `formatDateTime`, `formatDate`, `formatTime`, `formatCurrency`, including
  the invalid-date placeholder `—`); ~59 scattered `toLocale*` calls in
  panels, tables and pages were converted. Instead of fixed German texts,
  `src/lib/nav.ts` carries `labelKey`/`hintKey`/`groupKey` (`MessageKey`);
  navigation, breadcrumbs and the command palette render through them.
  Existing semantic formats (`src/lib/formula.ts`, `src/lib/currency.ts`)
  are deliberately left untouched.
- Control: `window.confirm`/`window.prompt` are fully replaced by a
  `Dialog`-based confirm primitive (Req 9.5, Task 13.5). New:
  `ConfirmProvider`/`useConfirm()` (`src/lib/ui/ConfirmDialog.tsx`) with
  `confirm()` (Promise\<boolean\>) and `prompt()` (Promise\<string|null\>),
  mounted in `layout.tsx` and therefore available on every route. All nine
  previous call sites (flow switch and save/publish/discard/overwrite in
  Studio (`useStudioSave`, Studio page), draft create/delete/switch
  (`useStudioDrafts`) and flow delete and import (`FlowsTab`)) now ask
  through the accessible dialog primitive (focus, Escape, form submit)
  instead of the browser dialog. Plus error telemetry (Req 9.6): the new
  client `src/lib/telemetry.ts` reports errors from error boundaries,
  deduplicated (30 s window), to the same-origin route
  `POST /api/telemetry`, which caps event sizes, forwards them with
  `CONTROL_TELEMETRY_URL` to a configurable external endpoint (5 s timeout,
  fail open into the server log) and always answers 204.
  `global-error.tsx`, a root `not-found.tsx` and the missing `loading.tsx`
  for jobs, models, provider-testing, shadow and triggers complete the route
  coverage; `error.tsx` and `global-error.tsx` report through the telemetry
  client. The tests (`StudioBuilder`, `FlowsTab`) mount the
  `ConfirmProvider` and confirm dialogs explicitly instead of mocking
  `window.confirm`.
- Control: the five large Studio components are split into modules and
  custom hooks below 600 lines (Req 9.3/9.4, Task 13.4), without behavior
  change. `StudioBuilder` (2,835 lines) becomes a thin composition layer
  (498 lines); loading, saving, drafts, history, node CRUD, bulk actions,
  subflows, selection, auto layout, copilot, pinned run and the canvas
  overlay live in custom hooks under `src/hooks/` (`useStudioBuilder`,
  `useStudioLoad`, `useStudioSave`, `useStudioDrafts`, `useStudioHistory`,
  `useStudioNodeCrud`, `useStudioBulkActions`, `useStudioSubflows`,
  `useStudioSelection`, `useStudioAutoLayout`, `useStudioCopilot`,
  `useStudioPinnedRun`, `useCanvasGraph`, `useCanvasOverlay`), panels under
  `src/components/studio/`. `FlowCanvas` (522 lines) uses memoized
  `nodeTypes` from `components/graph/CustomNodes.tsx` (Req 9.4);
  `FormulaEditor` becomes a barrel (34 lines) with eleven modules under
  `components/formula/`; `AssistantsPanel` (71 lines) with six modules under
  `components/assistants/`; `NodePropertyPanel` (516 lines) with nine
  sections under `components/nodepanel/`; the graph `NodeDetailPanel`
  (1,906 lines) becomes a panel composition (396 lines) with nine modules
  under `components/graph/nodedetail/` (shared building blocks, Markdown
  renderer, parsers, variable/header tables, error recording, type-specific
  renderers). Existing import paths (`NodePropertyPanel`,
  `FlowSettingsPanel`, `EdgeSelection`, `renameFlowVariable`, `JsonEditor`)
  stay stable through re-exports. The lint baseline drops in the process
  (192 errors / 650 warnings instead of 200 / 655).
- Control: the monitoring stream no longer hands events into React state
  per message (Req 9.1, Task 13.1). `useMonitoringEvents` now writes incoming
  SSE/WebSocket events into a new fixed-capacity ring buffer
  (`src/lib/ring-buffer.ts`) and hands them to React through an external
  store (`src/lib/monitoring-event-store.ts`) at most every 200 ms via
  `useSyncExternalStore`: the first event of a burst starts the flush timer,
  later events of the same window ride along in the pending batch. Between
  flushes the snapshot reference is stable, so a token-by-token stream
  re-renders the dashboard at most five times per second instead of once per
  chunk. The public API (`events`, `isConnected`, `error`, `clearEvents`) is
  unchanged; `events` is always the last `maxEvents` events in arrival
  order.
- Control: property test for the SSE buffer (Property 16, Req 9.1,
  Task 13.2). `src/__tests__/monitoringEventStore.property.test.ts` verifies
  with fast-check (new devDependency in `apps/control`) for arbitrary event
  sequences, capacities and flush times: after every flush the rendered list
  is exactly the last `maxEvents` events in arrival order, including
  modeling of the flush timer for timed flushes, clear rounds and the bound
  of at most one React notification per flush window. Additional unit tests
  for `RingBuffer` and the store (`monitoringEventStore.test.ts`, 13 cases).
- Control: data queries consistently go through TanStack Query and
  `lib/control-api` (Req 9.2, Task 13.3). All direct `fetch` calls in
  components and app pages were migrated: `AutopilotPanel` and
  `FlowDiffPanel` use `useQuery`/`useMutation` with a central `QueryClient`
  (staleTime 30 s), `FlowVersionBar` fetches the version list via
  `useQuery`, and `FlowCopilotPanel`, `FormulaEditor`, `OptimizePanel`,
  `StudioBuilder`, `studio/page.tsx` and `traces/page.tsx` call the backend
  only through `request()`/`json()` from `lib/control-api`, with the
  `Authorization` header only when a token exists. As a permanent rule, a
  Biome override (`noRestrictedGlobals`) in `biome.json` enforces that
  `fetch` is an error in `apps/control/src/components/**` and
  `apps/control/src/app/**` (except the API proxy routes); permitted direct
  calls stay limited to `lib/`. The component tests (QueryClientProvider
  around all affected renders) stay green unchanged: 106 files / 914 tests.
- Control: Playwright coverage of the security hardening (Req 8.1, 8.3,
  Task 12.6). The new spec `e2e/security-csp.spec.ts` checks against the
  real Next server: (1) the CSP header is present in enforce mode and
  carries a nonce in `script-src` that is assigned to a script in the
  delivered HTML; (2) no inline `<script>` in the HTML lacks that nonce (the
  response HTML is checked with `DOMParser` because the browser removes the
  `nonce` attribute from the DOM after execution); (3) the operator token
  never appears in the EventSource URL, the stream only uses the short-lived
  ticket from the exchange. This fixed a real bug in `src/proxy.ts`: the
  nonce branch returned a second `NextResponse.next()`, which dropped all
  previously set security headers (CSP, X-Frame-Options, …). The headers are
  now set on the response that carries the forwarded request headers.
- Control: optional BFF mode keeps access tokens on the server (Req 8.7).
  With `CONTROL_SESSION_MODE=bff`, Control runs two Next.js route handlers:
  `app/api/session` (POST exchanges a token handed over by the backend for an
  AES-256-GCM sealed session, GET returns the auth status and role, DELETE
  ends the session) and `app/api/backend/[...path]` (same-origin proxy to the
  Runtime that reads the token only on the server from the session and sets
  it as the `Authorization` header). The browser only receives an HttpOnly,
  Secure (over HTTPS), SameSite=Strict cookie (`atf_control_session`), never
  the token itself; `CONTROL_SESSION_SECRET` (≥ 32 characters) is mandatory,
  without it the endpoints answer 503 (fail closed). The proxy validates
  every target path against an allowlist (Runtime API prefixes only, OIDC
  dance paths excluded, dot segments normalized) and otherwise rejects with
  404, so there is no SSRF. In the client, `AuthProvider` detects the mode
  through a server-rendered, nonce-carrying flag and then works with a
  placeholder sentinel instead of a real token; all `backendUrl()` calls go
  through the proxy, so the browser only addresses its own origin. The
  default stays `token` (previous behavior unchanged); an invalid mode value
  fails every request.
- Control: `RequireRole mode="disable"` excludes keyboard interaction
  (Req 8.8). The disabling container also carries the HTML attribute `inert`
  (React 19): descendants are removed from the tab order and pointer, click
  and focus events are blocked; `aria-disabled` and `pointer-events: none`
  alone left buttons and inputs reachable by keyboard. The visual
  de-emphasis (reduced opacity) is unchanged.
- Control: hardened logout redirect, shared base64url decoding and the
  legacy hook removed (Req 8.4, 8.5, 8.6). `logout()` only follows an
  `endSessionUrl` provided by the backend when it uses HTTPS and its host
  exactly matches the configured IdP issuer; the Runtime endpoint
  `GET /monitoring/auth/config` now reports that host as `issuerHost` (older
  backends without the field: all end-session URLs are discarded, fail
  closed; a plain local logout is unaffected). The two local ad-hoc JWT
  decoders (`decodeTokenExpSeconds` in `lib/oidc.ts`, `extractRoleFromToken`
  in `AuthProvider`) now use the padding-correct, strict
  `base64UrlDecodeToString` from `@atf/security-kit/browser`, the same
  decoding as the backend and the kit, with no second `atob`/`Buffer` path
  that can drift. The outdated `useToken` hook (localStorage, a duplicate of
  the `AuthProvider` token store) is removed; consumers use `useAuth()`
  only.
- Control: no token-in-URL fallback over HTTPS any more (Req 8.3). When the
  monitoring ticket cannot be obtained (HTTP error, network error or a
  response without a ticket), `useMonitoringEvents` on an HTTPS page refuses
  the fallback to `?token=<AccessToken>` in the EventSource/WebSocket URL;
  the access token would otherwise end up in server logs, proxies and the
  browser history. Instead, the monitoring and history pages show the
  connection error and the reconnect backoff keeps running. Over plain HTTP
  (development only) the fallback stays, with a `console.warn`.
- Control: CSP enforced instead of report-only (Req 8.1, 8.2). **Upgrade
  note:** `CONTROL_CSP_MODE` now defaults to `enforce` instead of `legacy`;
  the old behavior requires an explicit `CONTROL_CSP_MODE=legacy`. The
  headers are now emitted per request by `src/proxy.ts` (Next 16 middleware)
  instead of by `next.config.ts` at build time: `enforce` sends
  `Content-Security-Policy` with a fresh per-request nonce in `script-src`
  (without `'unsafe-inline'`), which Next adopts for its own inline scripts
  and which the theme init script in the root layout carries; `style-src`
  keeps `'unsafe-inline'` (Tailwind/@xyflow inline styles, documented ADR:
  attribute styles cannot carry a nonce). In every mode the base security
  headers are added: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
  (clipboard stays allowed, the variables editor and trace viewer copy with
  it), `X-Frame-Options: DENY` and `Strict-Transport-Security` for HTTPS
  requests only (via `x-forwarded-proto`). An invalid mode value fails every
  request (fail closed, like the build error before).
- Runtime: fail mode and chunking of the model-based input guardrail
  (Req 7.5, 7.6). New `INPUT_GUARDRAIL_MODEL_FAIL_MODE` (`open`/`closed`)
  with an environment-dependent default: `open` in development, `closed` in
  production (resolved in `config/load.ts`, an explicit setting wins). On a
  classifier error, `closed` now returns
  `{ isInjection: true, reason: "classifier_unavailable" }` (block in
  `block` mode), `open` returns score 0 as before; the heuristic stays
  effective in both cases. Every outage (both fail modes) counts
  `aiperator_input_guardrail_model_degraded_total{fail_mode}` and writes
  `inputGuardrailClassifierDegraded`/`inputGuardrailClassifierError` as a
  trace diagnostic into the request params. Inputs longer than
  `INPUT_GUARDRAIL_MAX_CHARS` (default 8000, 0 disables) are classified in
  overlapping sections (200 characters) and combined by maximum score
  instead of risking a timeout; visible through
  `aiperator_input_guardrail_model_chunked_total` and `inputGuardrailChunks`
  in the trace.
- Runtime: `tenantId` is derived only from verified claims (Req 7.4). The
  legacy mode without `AUTHN_MODE` only decodes JWT payloads unchecked
  (Base64); these payloads no longer establish a tenant identity.
  `middleware/auth.ts` only evaluates `resolveTenantClaim` with an active
  verifier (`verifier.enabled`): with `TENANT_ISOLATION_ENABLED=true` an
  unverified token with a tenant claim now leads to 401 instead of a tenant
  takeover; without isolation the deployment default applies. The
  verifier-less mode already failed fatally at production startup through
  the production gate (`Production requires AUTHN_MODE=oidc`); this is now
  pinned by readiness tests. Further seals: `routes/assistant-caller.ts` no
  longer falls back to `X-Tenant-Id`/`X-Mandant-Id` when a principal exists
  but carries no tenant (the header fallback remains only for routers
  without the auth middleware); `buildRequestContext`
  (`routes/chat/handler.ts`) only takes over `client_id`/`tid` claims with
  `identityClaimsVerified=true` (`routes/models.ts` now passes the flag as
  well); `routes/compliance.ts` (DSAR subject) and `routes/memory.ts`
  (memory scope) only decode with `jwtVerifier.enabled`. Behavior change in
  legacy deployments without a verifier: requests with a hand-crafted
  `tenant_id` claim are no longer assigned to the named tenant.

- Gate (mcpgate): transaction envelope and evidence validation import from
  the contract packages instead of own implementations (Req 11.3).
  `apps/gate/src/transaction/fabric.ts` no longer defines
  `TransactionEnvelope` and `TransactionBudget` locally but uses
  `TransactionEnvelopeConsumerV1Schema` and the types from
  `@atf/transaction-contract` (consumer variant: opaque delegation hops and
  `trace.deadlineAt` as a number or ISO string, as the Runtime mints it);
  the hand-written checks (version/iss/aud/iat/exp/scopes/groups/budget/
  trace) are replaced by schema validation, while Gate-specific semantics
  stay: `evidencePackHash` is forbidden as an envelope claim, SHA-256 hashes
  are lowercased, alias conflicts fail closed.
  `apps/gate/src/mcp/evidence-contract.ts` now validates the action-contract
  structure with `EvidenceActionContractV1Schema` from
  `@atf/evidence-contract` (including `canonicalJson`/`sha256Hex` and the
  five meta keys re-exported from there); the Gate checks for action binding
  (tool/argsHash), declared digests, canonical wire form and bundle
  selection stay with unchanged error messages. Mixed-case hash encoding is
  normalized before the schema check, so the mixed upper/lower case that was
  always tolerated on the wire is still accepted.

- Gate (mcpgate): auth, discovery, rate limiting and egress address checks
  now use `@atf/security-kit` instead of duplicated implementations
  (Req 6.9, 6.10, 6.11, 6.14, 11.2). The behavior differences were first
  recorded as characterization tests
  (`apps/gate/test/unit/characterization-910.test.ts`).
  - **Auth/discovery (Req 6.10/6.11):** JWT verification runs through
    `createJwtVerifier`: tokens are mapped to their verifier by the
    (unverified) `iss` claim, algorithms and clock tolerance are configurable
    per issuer; OIDC discovery runs through `createDiscoveryClient`
    (single flight, positive cache ≥ 5 min, negative cache with exponential
    backoff). Verification errors no longer expose internals of the JWT
    library, only the generic message "Token verification failed".
    **Hardening:** tokens without an `exp` claim are now rejected
    (`requireExpiry` is the kit default).
  - **Rate limit (Req 6.9):** the per-identity limiter
    (`identity-rate-limit.ts`) replaces the fixed-window counter with GCRA
    from the security kit; the Redis backend runs the entire check as an
    atomic Lua script (no more INCR/PEXPIRE race between replicas). The
    bucket key is now `Issuer:Tenant:Subject` instead of the subject only.
    New configuration point `server.rateLimit.perIdentity.failMode`
    (`open`|`closed`, default `closed`): on a Redis outage requests are
    rejected (protection first) or let through (availability first).
  - **Egress (Req 6.14):** the IP address check in `tools/outbound.ts`
    delegates to the security kit's address catalog. Additionally forbidden:
    `198.18.0.0/15` (benchmarking), `192.0.0.0/24` (IANA), IPv6 NAT64
    `64:ff9b::/96` and 6to4 `2002::/16`; embedded IPv4 addresses are
    evaluated. The split-DNS exception for explicitly allowed private hosts
    never opens link-local, CGNAT or metadata addresses
    (`isAlwaysForbiddenAddress`). Response sizes stay capped per tool (http
    10 MiB, taiga 1 MiB, mcp-proxy configured).
- Gate (mcpgate): prod gate and edge middleware for egress and Host-header
  hardening (Req 6.8, Req 6.12). An empty `server.outbound.allowedHosts` is
  now fatal without exception under `MCPGATE_ENV=production`, regardless of
  whether http/mcp tools are currently configured, because a tool added
  later would otherwise inherit unrestricted egress. Database-only
  deployments declare "no egress" explicitly via a reserved, never-resolving
  host (e.g. `outbound-disabled.invalid`). `server.trustProxy` is newly
  configurable (default `1`, overridable with
  `TRUST_PROXY=true|false|<hops>`); the Express setting `trust proxy`
  replaces the previous fixed value. The Host-header check always runs:
  empty or missing Host headers are rejected with 400, and with a configured
  `server.allowedHosts` unknown hosts additionally get 403. IPv6 literals are
  parsed bracket-aware (`[::1]:3000` → `::1`); malformed brackets count as
  empty. Own tests: `apps/gate/test/unit/host-header.test.ts`, loader/prod
  gate suites, raw-socket integration tests in `backends.test.ts`.
- Gate (mcpgate): with business authorization disabled
  (`authorization.enabled=false`) privileged conditions now evaluate to
  `false` instead of `true` (Req 6.7, ADR-0002). Previously the fallback in
  `apps/gate/src/tools/database-tool.ts` forced all conditions to `true`, so
  every caller got every `{{if:privileged}}` SQL branch (act for another
  person, unmasked data, admin writes). Structurally, every condition whose
  rules read the `scopes` context is privileged
  (`privilegedConditionNames` in `apps/gate/src/db/conditions.ts`); these
  stay closed with authorization disabled, all other conditions are
  evaluated normally. For redaction guards (`redact[].when`) all guards stay
  active (fail closed: over-redaction instead of a data leak). `explain()`
  uses the same logic. All live configurations run with
  `authorization.enabled: true`, so production behavior does not change.
- Gate (mcpgate): pagination for database tools is validated at load time
  and uses HMAC-signed cursors (Req 6.5/6.6). A tool that sets
  `pagination.enabled` but whose SQL already contains a top-level `LIMIT`,
  `TOP`, `OFFSET` or `FETCH` is rejected while loading the configuration;
  the scanner (`apps/gate/src/db/sql-tokens.ts`) skips comments, strings and
  quoted identifiers, and a `LIMIT` in a subselect stays allowed. Pagination
  is also only permitted with a configured `pagination.orderBy` (otherwise
  rows can be skipped or repeated); `orderBy` entries must be plain column
  references (optionally with `ASC`/`DESC`). `nextCursor` is now an opaque
  token `base64url(JSON{o,fp,sub}).hmac`
  (`apps/gate/src/tools/pagination-cursor.ts`), bound to the tool name, the
  args fingerprint (all args except `cursor`/`pageSize`) and the principal;
  tampered, foreign or with-other-args reused cursors are rejected with
  `Invalid pagination cursor`, and a bare decimal offset as before is no
  longer accepted. New is an optional keyset mode
  (`pagination.keyset: [col…]`): instead of `OFFSET` the wrapper generates a
  dialect-portable seek predicate `WHERE (a > ?) OR (a = ? AND b > ?)` with
  one bound value per placeholder from the last page, seeking with `<` on
  `DESC` columns. The loader only accepts a keyset that lists every
  `orderBy` column as a bare name in the same order (so qualified `orderBy`
  entries such as `t.created_at` cannot use keyset mode), and rejects a
  keyset column that is also listed in `redact` (the signed but unencrypted
  cursor would carry its unredacted value). Property 10
  (`apps/gate/test/integration/pagination-completeness.property.test.ts`)
  checks offset and keyset paging against SQLite and, with
  `TEST_POSTGRES_URL`, PostgreSQL.
  The signing secret comes from `server.pagination.secret`; without
  configuration it falls back to a random in-process secret (cursors then do
  not survive a restart and are not valid across replicas). The `autoLimit`
  pass-through keeps its previous `LIMIT`/`TOP` semantics.
- Gate (mcpgate): governance policies are compiled once per configuration
  version (Req 6.2/6.3/6.4). `compilePolicy(config)` produces precompiled
  RegExp globs, sets for subjects/groups and canonicalized `argumentEquals`
  values; `GovernancePolicy` takes a `CompiledPolicy` and determines the
  matching rule per call in a single pass (`evaluate()` returns the effect,
  rule and evidence requirement together). Groups are read from the
  configured `oauth.groupClaim` (default `groups`; arrays and comma- or
  space-separated strings) instead of being hard-wired to `groups`. The
  compiled policy holder (`GovernancePolicyRef`) is shared across the SSE,
  Streamable and Stateless transports and swapped on hot reload without
  recreating open sessions. Approval fingerprints now sort keys by code unit
  instead of `localeCompare` (`"B" < "a"`); newly issued tokens carry the
  marker `fp: 2` in the payload, older tokens without the marker are verified
  against the legacy fingerprint until they expire. Along the way: the SSE
  and Streamable routers did not pass `approvalStore` to the MCP server and
  therefore used the module-default in-memory map instead of the shared
  (possibly Redis) store; fixed.
- Gate (mcpgate) migrates from zod 3 to zod 4 (4.4.3). The configuration
  schemas (`apps/gate/src/config/schema.ts`) now use the zod 4 API:
  `z.record` with an explicit key schema, `code: "custom"` instead of
  `z.ZodIssueCode.custom`, and `prefault()` instead of `default({})` for
  object schemas with partial defaults; otherwise partially specified
  sections (e.g. `server.cors` without `origins`) would lose their field
  defaults. Validation errors and messages stay identical; prerequisite for
  adopting the security kit (zod 4).

### Deprecated

- Gate (mcpgate): `server.forwardBearerToken` on the `mcp-proxy-tool` is
  deprecated (Req 6.13). The downstream receives the caller's login token
  unchanged, with the gateway's audience (confused deputy). Migration:
  configure `server.tokenExchange` (RFC 8693), which mints an audience-bound
  token. The executor logs the usage once per tool with a warning; the prod
  gate reports it as fatal in production and as a warning otherwise. Setting
  both fields is a configuration error.

### Security

- Control: the unauthenticated error-telemetry route `POST /api/telemetry`
  only accepts same-origin JSON posts: requests whose `Sec-Fetch-Site` or
  `Origin` identify a cross-site sender get 403, non-`application/json`
  bodies get 415, and ASCII control characters (except newlines in `stack`)
  are stripped before the event is logged or forwarded to
  `CONTROL_TELEMETRY_URL`. Same-origin reporting from the Control UI is
  unchanged.
- Control: the BFF session endpoint `/api/session` rejects cross-site POST
  and DELETE requests with 403 (login-CSRF guard) and requires
  `Content-Type: application/json` for POST (415 otherwise). Both routes
  share the helper `src/lib/same-origin.ts`.
- Control: the BFF proxy `app/api/backend/[...path]` now forwards exactly the
  path the allowlist validated. Decoded segments are re-encoded, so encoded
  separators (`%2F`, `%5C`) stay inside their segment, and dot segments
  (including `%2e%2e`) are resolved before the allowlist check
  (`normalizeBffPath` in `src/lib/bff-allowlist.ts`). Previously the
  allowlist checked the normalized path while the upstream request used the
  raw one.
- Outpost: the "Verify updater configuration" release step reads
  `tauri.conf.json` as JSON and fails a signed build when
  `plugins.updater.pubkey` is a placeholder or no updater endpoint is
  effective (empty `plugins.updater.endpoints` and no
  `vars.OUTPOST_UPDATER_REPO` from which the build step injects one),
  completing Req 10.5.

### Fixed

- `bun run verify:spdx` no longer crashes with `ENOENT` on files that are
  still tracked but already deleted in the working tree.
- Test fixtures no longer contain literal PEM private-key headers, so the
  public-tree scanner passes without an allowlist entry.
- Control: the execution picker and the persisted run history read their
  labels from the `de`/`en` catalogs (`executions.*`) and follow the active
  locale. Previously both components showed hard-coded German labels in the
  English UI as well; the German UI is unchanged.
- `@atf/security-kit` loads under Node's TypeScript type stripping again: the
  CBOR codec no longer uses a constructor parameter property, which Node
  rejects. The CI `contracts` job now also runs the package's Node tests
  (`test:node`), so a Bun-only construct can no longer slip through.
- Tests: the pg-gated Search erasure suite creates the stats and legacy
  asset tables it needs, so it also passes on a fresh database, and the Gate
  fingerprint property test (Property 13) no longer generates `-0`, which
  JSON cannot round-trip (intermittent failure).

## [0.14.0] — 2026-10-08
Platform hardening, phase 1 (foundation), phase 3 (audit integrity) and phase 4
(compliance/DSAR). Phase 1 adds two new internal contract/security packages without any
service changing its behavior; the service migrations follow in the next phases. Phase 3
hardens the audit chain against forks, a genesis restart after an outage and later tampering,
and only advances regulated actions after a durable audit success. Phase 4 makes DSAR erasure
complete, idempotent and honest across all stores: Search, Extract and Gate report per-store
partial results through the erasure contract, the Runtime fans out as the orchestrator and
issues a signed Erasure_Receipt; an Outpost MirrorDelete triggers the complete Search
cascade. Phase 5 hardens Extract against hostile documents (ZIP guard, safe XML, parser and
converter isolation, subprocess limits, hardened LibreOffice profile) and bounds cost and
memory (daily budget for vision pages, `MAX_PAGES` default, upload spill to disk); phase 6
makes the tenant scope in Search mandatory and tunes retrieval, backed by a CI quality gate
against real models.
### Added
- **`@atf/security-kit`** (`packages/security-kit`, private). Shared security building
  blocks: `safeEqual`/`safeEqualBytes` (SHA-256 digest comparison, timing safe), strict
  Base64URL (padding and bit checks, also as `@atf/security-kit/browser` for Control),
  `EgressGuard` (block table including 198.18/15, 192.0.0/24, 64:ff9b::/96, 2002::/16,
  IPv4-mapped/compatible, NAT64 and 6to4; DNS pinning via `lookup`, redirect revalidation,
  `maxBytes`, `timeoutMs`, `allowPrivateHosts`), a JWT/OIDC module (fixed algorithms,
  multi-issuer routing via the unverified `iss`, discovery with single flight, positive
  cache from `Cache-Control` with a 5-minute floor, negative cache 30 s exponential up to
  5 min), a rate-limit core (GCRA with a memory backend including eviction and a Redis
  backend via atomic Lua, configurable fail mode) and Prod_Gate rule building blocks with a
  shared reporter (services keep their own `prod-gate.ts`). Tests run under Bun and Node
  (`test:node`).
- **`@atf/erasure-contract`** (`packages/erasure-contract`, private). Normative DSAR
  contract across service boundaries: `ErasureRequestSchema` (idempotent via `requestId`,
  scopes `subject`/`tenant`/`reference` with cross-field checks), `ErasureStoreResultSchema`
  (`ok`/`failed`/`not_configured`, non-negative counters), `ErasureResponseSchema` and the
  signable `ErasureReceiptPayloadSchema` (subject only as `sha256(tenantId|identifier)`,
  canonical JSON with recursively sorted keys as the signature bytes; the signature
  algorithm lives in the envelope, not in the payload).
- **Audit chain integrity** (`@atf/runtime`, Req 1.1–1.3). Tip read, ID allocation
  (`nextval`), hash computation and INSERT run in one transaction under
  `pg_advisory_xact_lock(hashtext('atf:audit_log'))`; the tip cache is gone, the chain is
  advanced only from the persisted state. Genesis is used only for a provably empty table:
  a read or write error is thrown instead of silently restarting the chain at genesis; a
  tip without a hash (corrupted chain) is rejected.
- **`recordRequired` / regulated actions** (`@atf/runtime`, Req 1.4–1.5). The new
  `AuditLog.recordRequired()` resolves only after a durable write and throws on failure.
  `compliance/regulated-actions.ts` lists the regulated actions
  (`flows.publish`/`rollback`/`delete`, `approvals.resolve`, `dsar.self_erasure`,
  `compliance.forget`, `tenant.delete`, `api_key.create`/`revoke`, `byok.set`); their routes
  answer an audit failure with `503 AUDIT_UNAVAILABLE` and do not report success as
  completed.
- **Append-only `audit_log`** (`@atf/runtime`, migrations 42/43, Req 1.1/1.5). The trigger
  `audit_log_immutable` blocks UPDATE/DELETE (retention only through
  `audit_log_purge(before_at)` as a SECURITY DEFINER function with a prior anchor);
  migration 42 creates the `audit_anchors` table, migration 43 revokes UPDATE/DELETE on
  `audit_log` from `aiperator_app` and `aiperator_operator` (also in `rls-onboarding.ts`,
  guarded there by a table-existence check).
- **Anchor, metric and health** (`@atf/runtime`, Req 1.8–1.9). Prod_Gate warns in
  production without `AUDIT_ANCHOR_FILE`; the metric `aiperator_audit_write_failures_total`
  counts failed durable writes (hook in `createAuditLog`); `/health/ready` shows an `audit`
  hint on write errors (never 503); shutdown drains the write queue within a grace window
  and counts unprocessed writes on the metric.
- **DSAR erasure in Search** (`@atf/search`, Req 2.5–2.6, Tasks 4.2–4.5). The erasure path
  across all tables is extracted from `deleteRevisionCascade` (`deleteDocumentCascade`) and
  switched to reference delete, metadata delete and revision abort; cache invalidation
  happens after COMMIT. `POST /v1/erasure` (scopes `subject`/`reference`/`tenant`) deletes
  including statistics and the idempotency ledger (migration
  `GLOBAL_SCHEMA_VERSION = 9`, `vs_search_stats.query_hash`, `STATS_STORE_RAW_QUERY`);
  property tests (Property 3) prove completeness across all Search tables.
- **DSAR erasure in Extract** (`@atf/extract`, Req 2.7, Task 4.6). `POST /v1/erasure`
  (scope `extract.erasure`) for jobs, upload sessions, page images and orphaned source
  blobs with a ledger (`extract.erasure_ledger`, DDL v4); the call triggers the Search
  cascade with the same `requestId` and reports it back as the partial result
  `search.documents`; without a Search target it reports `not_configured`, never success by
  omission. `DELETE /v2/documents` reports the result of the Search cascade.
- **Audit redaction and erasure in the Gate** (`@atf/gate`, Req 2.8, Task 4.7). Audit
  events are redacted via `audit.redact` (paths and extra keys), `POST /v1/erasure` (scope
  `gate.erasure`) deletes idempotently in the persistent sink via the erasure ledger with
  tombstones; fingerprint over canonical JSON from `@atf/erasure-contract`.
- **Erasure orchestrator** (`@atf/runtime`, Req 2.9–2.12, Tasks 4.8–4.13).
  `compliance/erasure-orchestrator.ts` fans DSAR erasures out in parallel to all configured
  stores (local `RetentionService` targets plus `ERASURE_TARGETS` =
  `[{service, url, tokenEnv}]`) with a timeout, three attempts and exponential backoff;
  operations and per-store partial results live in `erasure_requests` (migration 44) and
  are idempotent via `requestId`: a repeated call replays the stored result. Retry
  (`POST /admin/compliance/erasures/:id/retry`) only reruns the failed stores. The DSAR
  response (`DELETE /v1/me/data`) is honest: HTTP 200 only on full success, 207
  `ERASURE_PARTIAL` on a partial result, 502 on total failure; the success text only appears
  on full success (Property 4).
- **Erasure_Receipt** (`@atf/runtime`, Req 2.11, Tasks 4.11–4.12). Every completed erasure
  gets a signed receipt over the canonical JSON of the payload (Ed25519 via
  `ERASURE_RECEIPT_SIGNING_KEY`, fallback HMAC via `AUDIT_ANCHOR_SECRET` with an `alg` hint
  in the envelope); the subject appears only as `sha256(tenantId|identifier)`.
  `GET /v1/me/data/erasures/{id}` returns the receipt only to the affected subject of the
  same tenant. Property 5: `verify(sign(receipt)) = true`, every bit change in payload or
  signature yields `false`.
- **Erasure system test** (`integration/system/erasure.test.ts`, Task 4.13). The real
  orchestrator runs against contract-conformant stub servers for Search, Extract and Gate
  (fan-out, per-store result, idempotency, partial failure→partial→retry, receipt
  verification); live and env-gated (`OUTPOST_IT_*`) it additionally covers Outpost
  MirrorDelete → Extract → Search and the Extract cascade `POST /v1/erasure` with the
  `search.documents` partial result.
- **ZIP guard** (`@atf/extract`). Every ZIP-based container (XLSX, VSDX, DOCX, PPTX and
  OOXML packages embedded in DOCX) is checked from the central directory alone before
  extraction: entry count (`ZIP_MAX_ENTRIES`, 10000), total (`ZIP_MAX_TOTAL_BYTES`,
  512 MiB) and largest uncompressed size (`ZIP_MAX_ENTRY_BYTES`, 200 MiB) as well as the
  compression ratio per entry (`ZIP_MAX_RATIO`, 100). A violation rejects the job with the
  new, non-retryable error code `DOCUMENT_TOO_COMPLEX` (422).
- **Safe XML** (`@atf/extract`). All `fast-xml-parser` instances are created centrally in
  `pipeline/safe-xml.ts` with entity processing disabled (XXE, billion laughs); the five
  predefined XML entities are decoded explicitly, so `&` in cells and headings is preserved.
- **Parser isolation** (`@atf/extract`). The native parsers (BPMN, XLSX, DOCX, VSDX, e-mail)
  run in a worker thread with a heap limit (`PARSE_ISOLATED`, default `true`;
  `PARSE_MEMORY_LIMIT_MB`, default 512, enforced under Node, ignored by Bun). Exceeding it
  ends with `DOCUMENT_TOO_COMPLEX` instead of taking the service down; if the worker does not
  start, `child_process.fork` follows and finally the in-process call with a warning.
  `MAX_EMBED_DEPTH` (default 2) limits the nesting of embedded `.msg` messages; deeper ones
  are skipped with a warning.
- **Isolated converter** (`@atf/extract`). `CONVERTER_MODE=isolated` routes all
  poppler/LibreOffice/Tesseract calls via line-delimited JSON-RPC over a Unix socket
  (`CONVERTER_SOCKET`, default `/run/atf-converter/converter.sock`) to a separate converter
  process (`node dist/converter/server.js`, intended for a container without network, with a
  read-only root file system and without root privileges). Only the command line and output
  cross the socket, never document bytes; input and output directories live on a shared
  volume mounted under the same path. The default stays `local`. The build additionally
  produces `dist/pipeline/isolate-entry.js` and `dist/converter/server.js` for this.
- **Subprocess limits and hardened LibreOffice** (`@atf/extract`). On Linux with `prlimit`,
  `SUBPROCESS_MEMORY_LIMIT_MB` (`--as`, default 0 = off; in containers use the cgroup limit)
  and `SUBPROCESS_CPU_LIMIT_S` (`--cpu`, default 900) bound every converter call. Every
  private LibreOffice profile starts with macros disabled, links from untrusted sources
  blocked and no update of linked content.
- **Tesseract OCR fallback** (`@atf/extract`). With `OCR_FALLBACK=tesseract`
  (`TESSERACT_BIN`, `OCR_LANG`, default `deu`) a scanned page gets OCR text with a warning on
  the page when the vision model fails, instead of failing. Default `off`; the binary and
  traineddata must be present in the image or in the converter.
- **Daily budget for vision pages** (`@atf/extract`, DDL v5). `VISION_BUDGET_PAGES_PER_DAY`
  limits the VLM pages per tenant and UTC day across all jobs (atomic counter in
  `extract.vision_daily_usage`); a job that would exceed the limit fails with the new error
  code `BUDGET_EXCEEDED` (429, non-retryable). Default 0 = off; Prod_Gate then warns.
- **Structured output for vision** (`@atf/extract`). With `VISION_SUPPORTS_JSON_SCHEMA=true`
  the vision client sends `response_format: json_schema` for page and pass-2 requests; if
  the provider rejects the field or the response is not conformant JSON, the previous tag
  parser applies. Default `false`.
- **Upload spill to disk** (`@atf/extract`). Multipart uploads above
  `UPLOAD_MEMORY_THRESHOLD_BYTES` (default 8 MiB, 0 = always) are buffered under
  `TEMP_DIR/uploads` instead of waiting in the heap for a conversion slot; a sweep at startup
  cleans up leftovers after a crash.
- **Retrieval quality gate** (CI, `scripts/eval`). The new CI job `eval` starts
  `scripts/eval/compose.eval.yaml` (Search, Extract, TEI CPU embedding and cross-encoder
  rerank, deterministic HyDE mock), ingests the deterministic golden corpus and fails when
  results drop below `scripts/eval/baseline/thresholds.json`; the baseline and ablations
  (dense, rerank, HyDE, context header) live under `scripts/eval/baseline/`.
### Changed
- The CI job `contracts` now also runs `security-kit` and `erasure-contract`; supply-chain
  inventories (`THIRD_PARTY_NOTICES.md`, `sbom.cdx.json`) regenerated.
- The Runtime audits regulated actions (flows, tenants, approvals, compliance/DSAR) via
  `recordRequired` instead of best-effort `record()`; when the audit is unavailable they
  answer `503 AUDIT_UNAVAILABLE` (`AUDIT_UNAVAILABLE` is a new error code).
- **Mandatory tenant scope and retrieval tuning** (`@atf/search`). Every access SQL requires
  an explicit scope (operator paths via `operatorScope()`); `DOCUMENT_ACL_DEFAULT` (default
  `allow`, Prod_Gate warns) and `ACL_REQUIRE_IDENTITY` with the scope
  `search.assert-identity` for asserted identity headers. HNSW with iterative scan
  (`HNSW_ITERATIVE_SCAN`, default `relaxed_order`) and `ef_search` ≥ candidate limit, sparse
  fusion via FULL OUTER JOIN (`RRF_WEIGHT_SPARSE`, `RRF_MISSING_ZERO`), a shared temporal
  visibility CTE, `FTS_RANKER` (`ts_rank_cd` or `bm25`) and `MIN_RERANK_SCORE` with an
  abstention field. Search statistics only store `query_hash` (HMAC with
  `STATS_QUERY_PEPPER`); raw queries only with `STATS_STORE_RAW_QUERY`.
- **`MAX_PAGES` default 0 → 500** (`@atf/extract`). Without explicit configuration the
  synchronous v1 conversion path rejects documents over 500 pages with `TOO_MANY_PAGES`
  (422).
- **Prod_Gate Extract**: `SUBPROCESS_TIMEOUT_MS=0` now prevents startup in production;
  `VISION_BUDGET_PAGES_PER_DAY=0` produces a warning.
### Migration
- Extract: anyone processing longer documents sets `MAX_PAGES` explicitly (0 = unlimited).
  Production configurations with `SUBPROCESS_TIMEOUT_MS=0` must set a positive value.
- The Extract DDL moves to version 5 (`extract.vision_daily_usage`); the migration runs
  automatically on the first database access (advisory lock, one transaction) and is
  additive.
- For `CONVERTER_MODE=isolated` a converter process from the Extract build must run next to
  Extract with the same `CONVERTER_SOCKET` and the same scratch volume (`TEMP_DIR`); for
  `OCR_FALLBACK=tesseract`, `tesseract` and its language data must be installed. The
  example image `deploy/examples/Dockerfile` does not include Tesseract.

## [0.13.2] — 2026-10-05
Hardens the LLM tool loop for local models: the `maxToolSteps` budget ends with an answer
round, retries continue from the recorded tool results, and tool calls written as plain text
are never delivered as the answer. LLM nodes gain the opt-in configs `turnContext` and
`sourcesCheck`, and the execution debug trace reports `provider_attempts`. Control gains
per-flow run statistics, a flow diff page for any two flows or drafts, the full error recording
from the debug trace in the Live Graph, a user filter and conversation header rows in History,
and flow-local save modes in the prompt editor. Two read-only HTTP endpoints are added
(`GET /monitoring/flow-stats`, `GET /flows/diff/compare`); no environment variable, migration,
contract-package, or example-flow change.
### Added
- **Per-flow run statistics** (`@atf/runtime`, Control). `GET /monitoring/flow-stats?since=<ISO>`
  returns runs, average runtime, average and total cost per flow for executions started at or
  after `since` (400 without a valid timestamp; same read gate as the history endpoints;
  operator-plane across tenants like the other history reads). The flow table shows these as
  columns with a 1h/1d/1w/1m window selector (default 1d); flows without runs show a dash.
- **Flow diff between any two endpoints** (`@atf/runtime`, Control).
  `GET /flows/diff/compare?from=<flowId>&to=<flowId>` (optional `fromDraft`/`toDraft`, scope
  `flows:read`) diffs two arbitrary flows or drafts. Each side resolves to the named draft, else
  the published definition, else the file definition, else the default draft; an unknown flow
  or draft answers 404. The `/flow-diff` page picks both sides in a searchable picker that can
  list each flow's named drafts under it, and `GET /flows` entries carry their `drafts`
  (`draftId`, `label`).
- **Full error recording in the Live Graph** (Control). Failed nodes show the error type,
  structured details, the diagnostics timeline and the failing tool result from
  `GET /monitoring/debug/:executionId`, also as a hover tooltip on the node card. The trace is
  fetched once per execution and again when a running execution finishes; a 404 (trace evicted
  from the bounded in-memory buffer) falls back to the plain event `error_message`. Node status
  stays event-derived.
- **History grouping and user filter** (Control). Requests of one conversation sit under a
  header row with flow, user, summed runtime and cost, status and start. History and the Live
  Graph share a filter popover with flow include/exclude and a searchable user select; the
  Live Graph keyword filter also matches user, flow name and request id.
- **Flow-local save modes in the prompt editor** (Control). Besides saving the prompt file
  (which affects every flow that includes it), "Save as" writes a copy under a new name and
  points only this flow's `#[[file:…]]` reference at it, and "Copy into flow" replaces the
  include with the edited text without writing to disk.
- **`turnContext`** (LLM nodes, `@atf/runtime`). A template appended to the newest user turn
  instead of the system prompt, so per-request context such as a classifier's image
  transcription reaches the responder without system authority and without changing the
  cacheable prefix. Supports `{{context.*}}`, `{{now.*}}`,
  `{{node.<id>.classification.<field>}}` and `{{turn[n]...}}`; the block is omitted when every
  referenced placeholder resolves empty.
- **`provider_attempts` in the execution debug trace** (`@atf/runtime`). LLM nodes report
  `total`, `failed`, `final_attempt` and `final_outcome` of the provider calls made inside one
  node attempt, derived from the `llm_provider_attempt_completed` diagnostics. `attempt` keeps
  counting graph attempts only, so a provider retry no longer looks like a single clean call.
- **Opt-in post-answer sources check `sourcesCheck`** (LLM nodes, `@atf/runtime`). Off by
  default. `completeSection: true` appends every inline-cited `[n]` that the sources section
  (`heading`, default `## Quellen`) lacks, built only from the sources registered in the same
  execution, and creates the section when it is missing; the completion is streamed as a
  trailing chunk and persisted with the answer. Cited numbers without a registered source are
  reported, never invented. `stripRuleMarkers: true` separately removes the pseudo marker
  `[Regel: …]` from answer text that has not been streamed yet (for example with
  `suppressToolPreamble`); other bracketed content is left untouched. Results appear in the
  `answer_sources_check` diagnostic.
### Fixed
- **Tool loop ends with an answer round at the `maxToolSteps` budget** (`@atf/runtime`).
  When the budget is exhausted the node now runs one extra model round without tools and with
  an explicit answer instruction (diagnostic `tool_budget_final_answer_round`) instead of
  stopping right after the last tool result. Flows that exhaust the budget make one more model
  call per attempt. This round and the answer-only retries below keep tool calls out in a
  provider-valid way: OpenAI, Azure, Ollama and OpenAI-compatible endpoints get no tool
  definitions; Google keeps the declarations with function calling mode `NONE`; Anthropic,
  Bedrock and unknown providers get the recorded tool calls and results as plain text
  (tool name, call id, arguments, result) without tool definitions, because their SDKs drop
  the tools under tool choice `none`. Anthropic would otherwise reject the request, and
  Bedrock would silently remove the tool results from it.
- **`post_tool_answer_missing` retry continues from the tool results** (`@atf/runtime`). The
  retry replays the attempt's tool calls and results and offers no tools, instead of
  restarting from the original prompt with a truncated excerpt of the last result. The
  excerpt remains only as a fallback when no tool exchange can be recorded, and that retry
  offers no tools either.
- **Text tool calls are never delivered as the answer** (`@atf/runtime`). Tool calls written
  as plain text (Qwen XML `<function=…>`, Hermes `<tool_call>{…}</tool_call>`) are held back
  from `content` in every step, with or without `suppressToolPreamble`, and rejected
  (`text_tool_call_rejected`). After a tool exchange the retry is an answer-only continuation
  without tools; before any tool use it keeps the tools and asks for a native call (answer-only
  from the second-to-last attempt on). The node fails on the last attempt
  (`text_tool_call_unrecoverable`). Without `suppressToolPreamble`, prose already streamed
  before an inline call in the same step cannot be retracted.
- **Attachment markup no longer leaks into `{{query}}`** (`@atf/runtime`). Open WebUI's
  `<attached_files>…</attached_files>` part is stripped from the last user query before it
  is used in retrieval tool arguments.
- **Reasoning preamble no longer leaks into the persisted answer** (`@atf/runtime`). When the
  final assistant message is the streamed answer plus a prefix (a model echoing its reasoning
  through the LM Studio reasoning shim), the persisted and replayed response keeps only the
  streamed answer; diagnostic `reasoning_prefix_stripped` reports the removed length.
- **Tool node events carry the request identity** (`@atf/runtime`). Tool start and end events
  include `user_name` and `user_prompt`, so a live picker row built only from tool events (for
  example after joining mid-run) shows user and prompt before the parent node completes; the
  Live Graph also backfills these fields from the durable history row.
- **Auth config probe times out** (Control). The OIDC config probe aborts after 5 s and
  resolves to "disabled", so a hung request no longer leaves the dashboard on its loading
  spinner; failed probes are not cached, so a later page load retries.
- **History table row actions are full-size icon buttons** (Control). The per-row actions in
  the persisted history use a new outlined `size="icon"` button variant instead of small ghost
  buttons whose padding squeezed the icons.
## [0.13.1] — 2026-10-04
Keeps an MCP server online when a reconnect attempt fails. No configuration, schema, flow,
migration, HTTP endpoint, or contract-package change.
### Fixed
- **MCP reconnect is make-before-break** (`@atf/runtime`). `reconnect()` closed the shared
  client before opening the replacement, so a failed handshake (for example a connect timeout
  while the peer was busy) took every tool of that server offline until the next successful
  periodic reconnect. The replacement session is now opened first and the old client is only
  closed once the new one is live; a failed reconnect keeps the existing session, and a late
  handshake is closed instead of leaking a transport. A caller-authenticated server
  (`forwardAuthToken` without a static `Authorization` header) still gets no shared session on
  reconnect, and its stale shared client is now closed rather than only dropped.
## [0.13.0] — 2026-10-04
Studio works with named drafts per flow (Runtime schema migration 41), cost displays are
currency-labelled via `CURRENCY` / `NEXT_PUBLIC_CURRENCY` (default EUR, label only, no
conversion), and the graph shows per-edge data channels live during a run. Tool calls stream
the full effective argument JSON instead of key names, LLM and classifier nodes can skip
themselves when the current turn carries no attachments, LLM nodes can work with short
reference handles instead of long paths, and an opt-in guard stops runaway tool loops. No
contract-package or example-flow change.
### Added
- **Named drafts** (`@atf/runtime`, Control Studio). Several working copies per flow:
  `GET /flows/:id/drafts` lists them, `PUT`/`DELETE /flows/:id/drafts/:draftId` save and remove
  one, and publish selects a draft via `?draftId=`; the implicit `PUT /flows/:id/draft` stays
  the `default` draft. Studio switches drafts without a request per draft, shows the draft
  count, and offers a Draft↔Live switch for online flows.
- **Currency labelling** (`@atf/runtime` `CURRENCY`, Control `NEXT_PUBLIC_CURRENCY`).
  All cost displays render in one configured currency (`EUR`, `USD`, `CHF` or `GBP`; default
  `EUR`); values are never converted, only the symbol changes. This includes eval reports,
  explain cards and the daily-budget error message. Wire and config field names (`cost_usd`,
  `maxCostUsd`, …) are unchanged. An unknown value falls back to `EUR` (Runtime logs a
  warning).
- **Edge data channels in the Studio graph** (`@atf/control`, `@atf/runtime`). Each edge
  renders one line per payload actually passed (query, images, tool results, data), refreshed
  live while the run is in progress; clicking a channel opens the edge's property panel. The
  Runtime records them as `edge_flows` in the execution debug trace (content clamped to 1 KB
  per item, at most 16 items per record and 200 records per trace).
- **`toolLoopGuard`** (LLM nodes, opt-in). Detects identical repeats, same-tool argument
  churn, no-progress mutations and A→B cycles; the model gets one warning, then the call is
  refused with `tool_loop_blocked` without reaching MCP. Counted in
  `aiperator_tool_loop_guard_total`.
- **Per-server MCP timeouts and retries** (`MCP_SERVERS` entries). `requestTimeoutMs`
  (ms, 1 000–600 000) replaces the 5 s wrapper default for one call attempt; `retryAttempts`
  (1–10) replaces the annotation-based default (3 for `readOnlyHint`/`idempotentHint` tools,
  otherwise 1) for every tool of that server.
- **`sources` on non-streaming chat completions.** `stream: false` responses carry the
  indexed citation sources the SSE path already emitted, so `[n]` markers resolve.
- **Studio panels** (`@atf/control`). Side panels are resizable (width remembered per
  browser, keyboard-operable separator); the properties panel only appears while something is
  selected, with a Flow settings button for flow-level settings; Copilot and Run & Trace are
  toggled individually and stack vertically. The sub-flow palette lists sub-flow files inline
  and includes one by click, double-click or drop onto the canvas. JSON editors mark the
  documentation entry for the key under the cursor.
- **Run & Trace** (`@atf/control`). Reasoning streams into an open Thinking block that
  collapses when the answer starts, and images attached to a test prompt are sent as
  `image_url` content parts.
- **Execution history** (`@atf/control`). Only requests of one conversation form a
  collapsible group (single requests render as plain rows), and row actions are compact icon
  buttons with accessible names.
- **`inputFilter: current-turn-attachments`** (LLM and classifier nodes). The node is
  skipped without a model call when the current user turn has no attachments; the
  classifier records `classifier_skipped_no_attachments` and continues with its
  `fallback`. Saves a full LLM round-trip per text-only turn.
- **`refHandles: true`** (LLM nodes). Tool results carry short deterministic reference
  handles instead of long paths; the runtime resolves them before the MCP call and maps
  them back in everything the user sees. A guessed handle fails loudly with the list of
  valid handles.
- **Sortable History columns** (`GET /monitoring/history?sortBy=&sortDir=`). Server-side
  sorting (whitelisted columns only, `NULLS LAST` + stable tiebreaker) for started, flow,
  user, nodes, latency, runtime and cost; the History table headers toggle direction.
- **`metadata.hidden: true`** (`@atf/runtime`, flow files). Internal helper flows are
  omitted from `GET /v1/models` and answer `404` on `GET /v1/models/:id`, so clients such
  as Open WebUI do not offer them in the model picker. The flow stays loaded and
  dispatchable; only discovery is affected.
### Changed
- **Full effective tool-argument JSON in the live stream.** Tool-call events carry the
  exact arguments the tool received (post egress-DLP) instead of `{"argument_keys":[…]}`;
  raw model arguments are still never emitted before the effective ones. `tool` and
  `retrieval` nodes and the local tools (`select_tools`, image inspection, media tools) report
  their effective arguments the same way.
- **Debug trace keeps the final answer.** `final_response` has its own 64 KB budget
  (`finalResponseBytes`) instead of the 512-byte per-node excerpt limit.
- **Agent harness coverage.** With a complete server-side rerank, search-driven discovery
  promotes hits by score threshold only; the rank rule remains the fallback when the rerank is
  missing or incomplete. Coverage deduplicates documents by canonical document-unit identity
  (chunk hits collapse onto their unit), and the debug trace reports the exact number of
  documents still owing work.
- **Tool-loop detection** no longer counts failed calls (transport errors, timeouts, `isError`
  results) towards argument churn.
- **Docs and Copilot examples** use the neutral route `RETOURE`; `docs/FLOWS.md` documents the
  node `label` field, tool-node `args`, `toolLoopGuard`, `refHandles` and the extended
  `overrides` matching.
### Fixed
- **Trace lookups by chat id.** ids of the form `chatcmpl-<uuid>` (and
  `chatcmpl-replay-<uuid>`) resolve to the execution again in explain, debug, history and
  optimizer endpoints instead of `404`.
- **Classifier after a result-injecting tool node.** Non-leading system messages are folded
  into an adjacent turn before the classifier prompt, so strict chat templates no longer
  reject the request and silently route to `fallback`.
- **Planning narration between tool steps** no longer leaks into the visible answer when
  narration suppression is on; only the final answer is released.
- **Control with operator auth disabled.** A stale session token without a `role` claim no
  longer greys out the UI; the role is `admin` whenever auth is not required. Server-side
  authorization is unchanged.
- **`cli.ts validate`** skips the shared `constants.yaml`, like the flow loader.
- Extract creates its `TEMP_DIR` scratch root on demand before allocating render and conversion work directories, so a cleaned or missing scratch root no longer fails `/v2/render` and conversions with HTTP 500.
### Migration
- Runtime schema version 41 adds `flow_drafts` (PK `flow_id`/`draft_id`) and backfills each
  flow's current draft as `default`. Applied automatically on start; no manual step.
- Cost figures and pricing (`LLM_PRICING`, built-in table) are now labelled in `CURRENCY`,
  default `EUR`. Deployments that priced in US dollars set `CURRENCY=USD` and
  `NEXT_PUBLIC_CURRENCY=USD` to keep the `$` label.
- Control freezes `NEXT_PUBLIC_CURRENCY` at build time; it should match the runtime's
  `CURRENCY` so Studio and API views label costs identically.
## [0.12.0] — 2026-09-30
Adds the Extract Outpost, a locally operated sync agent that mirrors local folders, S3, Google
Drive and Dropbox into Extract, plus the three Extract extensions it relies on.
`@atf/extract-contract` moves to 2.2.0 (additive). Extract applies schema migration 3 on start.
No flow or configuration-variable change; the new scope `extract.delete` must be granted to
clients that delete documents.
### Added
- **Extract Outpost** (`@atf/outpost-core`, `apps/outpost`, `apps/outpost-desktop`). Sync core
  with change planning, resumable uploads, job polling, retry policy, crash-safe journal state
  and a delete planner with mirror-delete threshold and explicit confirmation. Docker runtime
  with health endpoint, graceful shutdown, `source-login` and `confirm-deletes`; Tauri desktop
  app with a Node SEA sidecar, loopback Control API and OS-keychain credentials. Extract
  authentication via API token, client credentials, device code or PKCE; cloud sources
  authorize read-only via OAuth (or a Google service account). See `apps/outpost/README.md`
  and the Extract Outpost section in `DEPLOYMENT.md`.
- **`GET /v1/whoami`** (`@atf/extract`). Reports principal, scopes, feature flags and
  `limits.maxUploadBytes` for any valid token.
- **`DELETE /v2/documents/{reference}`** (`@atf/extract`). Deletes a document by reference
  under the new scope `extract.delete`: cancels active jobs, removes it from Search, `404` when
  nothing was deleted. New metric `extract_documents_deleted_total`.
- **Own-job reads** (`@atf/extract`). `GET /v2/jobs/{id}` is readable with `extract.ingest` by
  the job's originator; foreign jobs answer like unknown ids. Listing stays `extract.admin`.
- **`@atf/extract-contract` 2.2.0**: `whoamiResponseSchema`, `deleteDocumentResponseSchema`
  and the `NOT_FOUND`/`FORBIDDEN` error shapes.
- **`outpost-release` workflow** for `outpost-v*` tags (test and Docker image jobs); the
  updater repository comes from the repository variable `OUTPOST_UPDATER_REPO`.
### Migration
- Extract schema version 3 adds the nullable columns `created_by_subject` and
  `created_by_tenant` to `extract.jobs`. Existing jobs stay owner-less and admin-only.
## [0.11.1] — 2026-09-30
Fixes a guaranteed `403` on Search MCP calls that pass `requesting_user` while authorization is
disabled. No configuration, schema, flow, migration, HTTP endpoint, or contract-package change.
### Fixed
- **`requesting_user` with `AUTHZ_ENABLED=false`** (`@atf/search`). `requireActingUser` compared
  the requested user with the principal's identity even under the authorization bypass, where no
  identity exists, so `search` MCP calls with `requesting_user` always failed with
  "The requested user does not match the authenticated principal". The bypass now skips the
  match like every other check in the access scope; an empty `requesting_user` is still refused.
  With authorization enabled, behaviour is unchanged.
## [0.11.0] — 2026-09-28
Brings the Extract operator console to full Document Intelligence v2 support, adds HTML as an
input format, and fixes the v2 hand-off from Extract to Search (batch digests, new collections)
as well as transaction envelopes for token-exchange MCP servers. `@atf/extract-contract` moves
to 2.1.0; the `atf-extract/2.0.0` wire contract is unchanged. No configuration, migration or
flow change.
### Added
- **Extract operator console: full Document Intelligence v2 support.** With
  `EXTRACT_DATABASE_URL` set, a new "Neuer Job" tab uploads sources as resumable, per-chunk
  checksummed sessions (or pulls a `source_url`, or takes a stored sha256) and creates jobs with
  every `POST /v2/jobs` option. The ingest tab follows a `202` job to completion, reports
  duplicates, versions and revisions, and sends `X-Dedup` and `X-Source-Modified`. The Jobs tab
  adds reparse, resume with a resume policy, identity and revision details, a status/reference
  filter and an on-demand page preview. Health shows the `-bbox-layout` probe. New cookie BFF
  routes `/ui/uploads` and `/ui/render` mirror `/v2/uploads` and `/v2/render`.
- **`@atf/extract-contract` 2.1.0**: `POST /v2/jobs` accepts an optional `filename` (its
  extension types the source); the `Job` view gains optional `sourceSha256`, `sourceFilename`,
  `collection`, `visibility`, `resumePolicy` and `priority`.
- **Extract: HTML input** (`.html`, `.htm`, XHTML, sniffed from the content). LibreOffice Writer
  lays the page out after every reference it could follow is stripped (embedding elements,
  `<meta http-equiv>`, URL attributes except `<a href>` and inline `data:` images, CSS `url(…)`
  and `@import`), so an uploaded page cannot make Extract fetch internal URLs or read local
  files. External images are not rendered.
- **Extract: `GET /v2/jobs/{id}/figures`** (and `/ui/jobs/{id}/figures`) lists the figure blocks
  of a job's staged page records; crops render on demand through `POST /v2/render`.
- **Extract: `source_url` pulls report `content_type` and a derived `filename`**, so a job
  created from a pulled source is typed.

### Changed
- **`POST /v2/jobs` and the job-backed `POST /v1/ingest` validate the collection name up
  front** (Search's rule: a letter, then letters, digits or underscores) and answer 400,
  instead of a job that failed at emit after every page went through the model. The contract
  schema enforces the same rule, so a client validating with `jobRequestSchema` rejects such
  names too.
- **Extract: a failed job carries its cause as a warning** (at most 500 characters) in the
  status read and the console.
- **Search: an invalid collection name is 400 `INVALID_COLLECTION_NAME`** before the access
  check rather than an access denial, and `POST /v2/search` on a missing collection is 404
  instead of an embedding provenance mismatch.

### Fixed
- **Extract → Search: every v2 batch was refused with `CONTENT_DIGEST_MISMATCH`.** The emitter
  sent the sha-256 as hex inside the RFC 9530 `Content-Digest` structured field; it is now
  base64.
- **Search: the first v2 revision for a new collection failed forever** on the missing table.
  The batch worker now creates the collection with the embedding's vector size and the v1 ingest
  defaults.
- **Extract uploads**: a chunk's `204` is sent only after the session lock is released, so an
  immediately following chunk no longer hits a spurious 409; `complete` compares the declared
  size numerically (Postgres `BIGINT` arrives as a string) and records the stored digest, so a
  retried `complete` answers idempotently.
- **Extract jobs: a non-UUID job id is 404** instead of a 500 from a Postgres cast error.
- **Runtime: transaction envelopes for token-exchange MCP servers bind the exchanged subject.**
  `userId` in the envelope was the caller's login `sub`, while the peer authenticates the
  exchanged token, whose `sub` follows the target provider's subject mode (e.g. Taiga login
  `user_id` vs. `user_email` on the target). Search rejected every call with
  `403 TRANSACTION_IDENTITY_MISMATCH`, so RAG nodes failed. The envelope now uses the subject
  of the cached exchanged token (`McpWrapperService.targetSubject`).
- **Runtime: deterministic tool nodes emit a `tool_execution_failed` diagnostic** with only the
  structural failure class (error name, HTTP status, upper-case peer error code) when a call
  throws; the node result stays anonymized.
## [0.10.2] — 2026-09-28
Fixes an empty answer after a failed tool call and transaction rejections on token-exchange MCP
servers, and makes both failure classes visible in traces and server logs. No configuration,
schema, flow, migration, HTTP endpoint, or contract-package change.
### Changed
- **Diagnostics** (`@atf/runtime`). A step prompt that fails AI SDK message validation is reported
  as `llm_prompt_schema_invalid` with message index, role, and schema path; the rejected prompt
  value is no longer embedded in `llm_provider_error_detail`. An MCP error result records its
  bounded raw cause (at most 300 characters, server-side only) as `tool_result_error`. Warn- and
  error-level node diagnostics are mirrored to the server log with execution, flow, and node ids.
### Fixed
- **Empty answer after a failed tool** (`@atf/runtime`). The tool-result sanitizer replaced an
  error output with a bare `{ isError, error }` object, which is not a valid `ToolResultOutput`;
  the AI SDK rejected the next step with `AI_InvalidPromptError` and the node ended without text.
  The anonymized error is now replayed as `error-json`, so the model can answer the failure.
- **Tool errors shown as successful in the debug trace** (`@atf/runtime`). An error result that
  was already sanitized upstream was recorded as `is_error: false`.
- **Session binding of transaction envelopes** (`@atf/gate`, `@atf/runtime`). Gate compared an
  envelope's `sessionId` with its own MCP request id as well as the token's session claims, so a
  real OIDC `sid` never matched and every call was rejected with "Envelope.sessionId does not match
  the authenticated session". Only `sid`/`session_id` claims count now. Runtime no longer binds
  `sessionId` for `tokenExchange` servers, whose exchanged token carries no caller session.
## [0.10.1] — 2026-09-28
Reliability and diagnostics fixes for LLM provider failover and RFC 8693 token exchange, plus
neutral example data. No configuration, schema, flow, migration, HTTP endpoint, or contract-package
change.
### Changed
- **Diagnostics.** A failed provider attempt records its raw error chain (status, code; bounded,
  server-side only) as the `llm_provider_error_detail` trace diagnostic. Tools whose schema cannot
  be loaded are reported once per server and cause as `tool_schema_unavailable`, and a rejected
  token exchange is logged with its audience and IdP error code, never token material.
- **Examples.** Documentation, the node-type catalog, the Studio hint, and tests use neutral
  example names (`casework`, `cases`) instead of deployment-specific ones.
### Fixed
- **LLM failover on an unreachable provider** (`@atf/runtime`). Bun socket failures ("The socket
  connection was closed unexpectedly", codes such as `ConnectionClosed`) wrapped in an AI SDK
  `RetryError` were not recognised as transport failures, so a dead provider was retried three
  times with backoff and even reset its circuit breaker. Transport detection now follows `lastError` and
  `errors` as well as `cause` and knows Bun's socket codes and wording; a wrapped 4xx stays
  non-transport. While another candidate remains, `llm` and `classifier` nodes disable the provider
  SDK's internal retries, so a dead endpoint costs one fast attempt instead of about 6 s per try.
  Classifier nodes now report transport failures to the flow's provider circuit breaker.
## [0.10.0] — 2026-09-28
Adds OAuth 2.0 Token Exchange (RFC 8693) for caller-authenticated MCP servers and records the
acting party of delegated tokens end to end. Every change is opt-in and additive: without the new
`tokenExchange` (Runtime) or `oauth.actorPolicy` (Gate) settings, behaviour is unchanged. No
executable flow, migration, or HTTP endpoint changes. One independently versioned contract package
changes additively (see **Changed**).
### Added
- **Runtime token exchange** (`@atf/runtime`). A `forwardAuthToken` MCP server can declare
  `tokenExchange`; Runtime then exchanges the caller's verified bearer for a token minted for that
  server's `audience` (optionally scope-reduced) instead of forwarding the raw login token.
  Exchanged tokens are cached per subject, audience, scope, and actor, and concurrent misses are
  coalesced. The token endpoint is configured directly or discovered from `issuer`.
- **Delegation (on-behalf-of).** An optional `tokenExchange.actor` (`client_credentials`) adds an
  `actor_token`, so the issued token carries an RFC 8693 `act` claim that names Runtime as the
  acting party. The flow identity audit classifies such servers as `exchanged-token` or
  `delegated-token`.
- **Gate actor policy** (`@atf/gate`). Gate parses the `act` claim of OAuth tokens and records
  the actor on `tool_call` monitor events. The optional `oauth.actorPolicy` can require delegated
  tokens (`requireActor`) and restrict accepted actor subjects (`allowedActorSubjects`).
### Changed
- **Identity contract** (`@atf/identity-contract`) 1.1.0 → 1.2.0: the identity-principal
  contract version advances to 1.1.0 with an optional `actor`, and `GatePrincipalInput` accepts
  an optional `actor`. Principals with version 1.0.0 and no actor are still accepted.
  `@atf/contract-adapter` and `integration/system` reference the new version exactly.
### Fixed
- **`version:sync`** rewrote a file incorrectly when it held several occurrences and the new
  version had a different length (e.g. `0.9.2` → `0.10.0`), because later match offsets went
  stale. Occurrences are now rewritten back to front.
### Security
- Token exchange fails closed. Runtime exits at startup when `tokenExchange` lacks
  `forwardAuthToken: true`, is combined with `allowAnonymous`, or references an unset secret
  environment variable. At call time, a failed exchange or actor mint fails the tool call and
  never falls back to forwarding the un-exchanged token. A caller session whose exchanged token
  enters the refresh margin, or is rejected with HTTP 401, is rebuilt with a freshly exchanged
  token; the rejected call itself is not replayed. Secrets are configured only by
  environment-variable name (`clientSecretEnv`), and token material is never logged.
- Setup and Authentik requirements are documented in
  [docs/MCP-2026-CONTEXT-LAYER.md](docs/MCP-2026-CONTEXT-LAYER.md).

## [0.9.1] — 2026-09-28

Dependency maintenance plus one build fix for the optional Search Node.js artifact. Every
dependency change is a backward-compatible upgrade of an existing dependency; there is no
source, schema, flow, migration, or independently versioned contract-package change. Version
0.9.0 was never tagged, so this entry's compare link spans from `v0.3.0`, the last published
tag, and the release also carries everything documented under 0.9.0 and earlier untagged
versions. Third-party notices and the SBOM are regenerated to match the upgraded versions.

### Changed

- **Control** (`@atf/control`): `next` 16.3.5 → 16.3.6, `lucide-react` 1.45.0 → 1.48.0.
- **Runtime** (`@atf/runtime`): `@langchain/core` 1.2.11 → 1.2.13, `@langchain/langgraph`
  1.4.16 → 1.4.18 (transitively `@langchain/langgraph-sdk` 1.11.2 → 1.12.0).
- **Search** (`@atf/search`): dev `fast-check` 4.9.0 → 4.10.2, aligned with the other
  workspaces.
- **Workspace override**: transitive `adm-zip` (via `onnxruntime-node`) 0.6.0 → 0.6.1.

### Fixed

- **Search Node.js artifact.** `build:node` now marks `sharp` as external, matching Extract.
  `sharp` is a native module that `bun build --target node` cannot bundle; the Node artifact
  therefore expects `sharp` 0.35.4 to be installed for the target platform next to `dist-node`.
  The Bun target is unchanged.

## [0.9.0] — 2026-09-27

Version 0.8.0 is documented below but was never tagged either, so this entry's compare link
spans from `v0.3.0`, the last published tag, and it carries the work of 0.4.0 through 0.8.0 as
well.

Adds Document Intelligence v2. The HTTP surface is additive — `/search`, `/ingest-file`, and the
v1 Extract endpoints keep working — but the release runs database migrations in Search and
creates a new schema in Extract, makes one breaking contract-package change, and tightens the
conversion-callback SSRF policy in a way that can refuse existing internal receivers (see
**Security**). No executable flow in this repository changes; the research flows that use the new
navigation tools live in the private deployment repository and carry their own
`metadata.version` bumps. The upgrade path, rollback, and corpus re-ingest are described in
[docs/document-intelligence-v2-migration.md](docs/document-intelligence-v2-migration.md).

- **Search migrations.** The global schema advances from version 4 to 8: version 5 adds the v2
  ingest staging tables (`vs_revisions`, `vs_ingest_batches`, `vs_segments`,
  `vs_document_revisions`) and `vs_assets` with a backfill from `vs_document_assets`; version 6
  adds the shared identifier index `vs_identifiers`; version 7 reconciles these system tables
  eagerly at startup. Every collection table advances from version 11 to 14: v2 index-unit
  columns (12), unit relationship columns `parent_unit_id`, `prev_unit_id`, `next_unit_id`,
  `block_ids`, `figure_refs`, and `table_id` (13), and the identifier FTS vector `ts_ident` with its GIN index (14). All added
  columns are nullable, so legacy rows migrate forward untouched and are searched as before.
  Global version 8 adds the document-identity tables `vs_document_sources`, `vs_mail_messages`,
  and `vs_document_groups` and the nullable `vs_revisions.source_id` / `document_info` columns.
- **Extract schema.** With `EXTRACT_DATABASE_URL` set, Extract creates its own `extract` schema
  (tracked in `extract.schema_migrations`, target version 2): `jobs`, `page_stages`,
  `figure_stages`, `tile_stages`, `docpass_state`, `emit_outbox`, `asset_outbox`, and `uploads`.
  Version 2 adds token reservations, the emit generation, auto-resume, and the owning page of an
  outboxed asset. Without the variable no schema is created, and v2 jobs, resumable uploads, and
  `source_url` pulls are unavailable.
- **Contract.** `@atf/extract-contract` advances from 1.1.0 to 2.0.0. This is breaking for
  importers: the package root now exports the v2 NDJSON record stream, and the v1 marker grammar
  is available only under the `@atf/extract-contract/v1` subpath (`./v2` is also exported
  explicitly). Code importing v1 symbols from the root must switch to `/v1`. The wire contract
  is `atf-extract/2.1.0`: `document.begin` gains the optional `version`, `email`, and
  `parentReference`, and the package adds the identify API types and the shared
  `documentKeyOf` / `compareDocumentVersions` rules — additive, so a 2.0 consumer is unaffected.
  Wire contract 2.2 adds the caller's document attributes (`title`, `tags`, `metadata`, `link`,
  `sourceLabel`) to the job request and all but the already present `title` to
  `document.begin`; 2.3 adds `continues`,
  `continuationOf`, and `continuationText` to paragraph and list blocks. Both are additive; the
  producer now reports `atf-extract/2.3.0`.

### Added

- **Document Intelligence v2**, an end-to-end rework of the document ingestion, indexing, and
  retrieval path, delivered across phases 0–5. The v1 `/search` path and the v1 extract HTTP
  path keep working unchanged, and the new Search schema columns are nullable so a legacy row is
  searched exactly as before.
  - **Resumable, contract-versioned ingestion.** A persistent Extract job (lease, epoch, token
    budget, per-unit stage checkpoints) and a Search revision (idempotency key, staged batches,
    TTL) are joined by an at-least-once emitter that reconciles against the receiver, so a
    10 000-page document survives crashes, network faults, and restarts without losing model
    tokens or producing duplicate index units. Both halves speak the single
    `@atf/extract-contract` v2 NDJSON stream; Search refuses an incompatible major via the
    `X-Extract-Contract` header. Resumable uploads (`/v2/uploads`) confirm bytes one chunk at a
    time; sources are content-addressed and full-resolution page images are re-rendered on
    demand.
  - **Deterministic page analysis and transcribed visual content.** Per-word geometry
    (`pdftotext -bbox-layout`), page classification, header/footer detection, and render-hash
    dedup; a streaming document pass builds the outline, merges cross-page tables, resolves
    references, and extracts identifiers; figures get a snapped bounding box and a structured
    transcription per kind (BPMN, masks, drawings, charts, table images); large formats are
    tiled with overlap and stored as `tile:` assets. Native parsers read DOCX heading levels,
    XLSX worksheets as tables, BPMN as a `process` transcription, and VSDX shapes and connectors
    instead of rendering and guessing; PPTX goes through LibreOffice → PDF like before, and
    DOCX and VSDX keep that render for the page image.
  - **Multi-level index and retrieval.** Units at `chunk`, `table`, `figure`, `section`, `page`,
    and `document` level with a relationship graph and a contextual embedding header; German
    stemming plus an identifier vector and a third RRF list for exact codes; rerank with
    context, per-section diversification, small-to-big expansion, and `/v2/search` with
    `section_path`, `pages`, `expanded`, `assets[]`, `navigation`, and `evidence`; on-demand
    region/full zoom (`/v2/render`) cached as an asset variant.
  - **Runtime and flows.** RAG node v2 (`ragProfiles` with `expand`, `granularity`,
    `include_assets`, and `assets: { attach, maxImages, variant }`) attaching images only on
    confirmed `visionInput`, with page/figure citations; `inspect_image` for `asset:<id>[#bbox]`
    references, fail-closed; research flows wired with the MCP navigation tools and a research
    routine.
  - **Scale and finish.** A bounded large-job lane (`LARGE_JOB_PAGE_THRESHOLD`,
    `LARGE_JOB_MAX_CONCURRENCY`), `PAGE_CONCURRENCY` throughput tuning against the vLLM batch,
    tiling knobs (`TILE_TARGET_PIXELS`, `TILE_OVERLAP_FRACTION`, `TILE_MAX_PER_PAGE`), an
    optional model-free outline finalize pass (`FINALIZE_PASS`) with selective re-embedding, and
    a corpus re-ingest CLI that migrates existing corpora in `version` mode ordered by usage
    with proven asset-id stability. See the
    [migration guide](docs/document-intelligence-v2-migration.md) and the v2 tuning knobs in
    [docs/operations-and-retrieval.md](docs/operations-and-retrieval.md).
- **Extract v2 endpoints**: resumable uploads (`POST /v2/uploads`, `PATCH /v2/uploads/{id}`,
  `POST /v2/uploads/{id}/complete`, with `source_url` as an alternative to uploading bytes);
  persistent jobs (`POST`/`GET /v2/jobs`, `GET /v2/jobs/{id}`, and the actions `pause`,
  `resume`, `cancel`, `retry-failed`, and `reparse` under `/v2/jobs/{id}/`); a Jobs tab in the
  Extract UI backed by `/ui/jobs`; and on-demand page or region rendering
  (`POST /v2/render`, own rate limit, `extract.admin` scope). The upload, job, and UI job routes
  are mounted only when `EXTRACT_DATABASE_URL` is set.
- **Search v2 endpoints**: the revision protocol under `/v2/documents/{ref}/revisions` (open;
  status and abort of `{rev}`; `batches/{seq}`, `segments/{n}/commit`, `commit`, and
  `heartbeat`), `PUT`/`GET /v2/assets/{assetId}`, and `POST /v2/search`.
- **Nine MCP navigation tools** in Search: `get_outline`, `get_section`, `get_pages`,
  `get_context`, `list_figures`, `get_asset`, `get_table`, `find_identifier`, and `follow_ref`.
- **Runtime**: `imageInspection.assetSource` (`server`, optional `collection` and `variant`)
  enables `asset:<id>[#bbox]` references in `inspect_image`, fetched through MCP `get_asset`;
  `ragProfiles` v2 adds `expand`, `granularity`, `include_assets`, and
  `assets: { attach, maxImages, variant }`.
- **Evaluation scripts** at the repository root: `eval:fixture` (golden-set fixture),
  `eval:retrieval` (retrieval harness), `eval:test`, and `eval:typecheck`.
- **Configuration.** Notable new variables — Extract: `EXTRACT_DATABASE_URL`,
  `SOURCE_STORE_DIR`, `UPLOAD_TMP_DIR`, `SOURCE_URL_ALLOWED_HOSTS`, `SOURCE_URL_MAX_BYTES`,
  `SOURCE_URL_TIMEOUT_MS`, `JOB_LEASE_SECONDS`, `EMIT_BATCH_PAGES`, `TEXT_FAST_PATH`,
  `FIGURE_PASS2_KINDS`, `RENDER_RATE_LIMIT`, `RENDER_MAX_PIXELS`, plus the large-job, tiling,
  and `FINALIZE_PASS` knobs above; Search: `ASSET_STORE_BACKEND`, `ASSET_STORE_DIR`,
  `BATCH_WORKER`, `REVISION_TTL`, `RRF_WEIGHT_IDENTIFIER`, `CONTEXTUAL_CHUNK_LLM`, and
  `TOKENIZE_URL`. [docs/CONFIGURATION.md](docs/CONFIGURATION.md) lists every variable with its
  default; [docs/document-intelligence-v2-migration.md](docs/document-intelligence-v2-migration.md)
  says which ones an upgrade needs.
- **Duplicate detection on ingest.** Every v2 job identifies its source with Search
  (`POST /v2/sources/identify`) before any work: the same file, the same normalised text, or the
  same e-mail Message-ID anywhere in the collection, and a near-identical text (MinHash) of the
  same document in the same version, are skipped. Whitespace, hyphenation, ligatures, case,
  punctuation, and page numbers do not make two exports differ, so a PDF and the DOCX it was made
  from are recognised as one. A skipped upload completes without extraction or model calls, reports
  `duplicateOf` (`status: skipped` on `/v1/ingest`), and is kept as an additional source of the
  indexed document (`GET /v2/documents/{ref}/sources`). `dedup` / `X-Dedup` (`auto`, `exact`,
  `off`) controls it; `SOURCE_CLAIM_TTL`, `DEDUP_NEAR_THRESHOLD`, and `DEDUP_DUPLICATE_SIMILARITY`
  tune it in Search.
- **Document versions.** A document is identified by its reference without file extension, so
  `handbuch.docx` is ingested as a new revision of an indexed `handbuch.pdf`. Without an explicit
  `version` / `X-Version`, Extract reads the version from the first page (label, then a labelled or
  unambiguous date; the text LLM when configured; a scan's transcribed first page), else takes
  `sourceModifiedAt` / `X-Source-Modified`. Search makes a revision the latest only when its
  version is not older than the current one; an older version arriving late is indexed but stays
  in the history.
- **E-mail ingestion (`.eml`).** Parsed natively (MIME, transfer and header encodings, any WHATWG
  charset, HTML bodies) into one page per message with quoted history and signature removed.
  Messages are threaded in Search by Message-ID, In-Reply-To, References, and the Outlook
  Thread-Index — across independent ingests, in any order, merging threads a message links — with
  a subject and participant fallback. Attachments are ingested as documents of their own, grouped
  with their e-mail's thread. `groupByDocument` / `group_by: document` merge a thread into one
  result, and the new expansion mode `document` (`X-Expand`, `expand`, MCP `expand`) returns a
  whole thread or document in reading order.
- **Outlook `.msg` and mbox.** `.msg` files (CFB/MAPI) are parsed natively — transport headers
  first, MAPI properties as fallback, embedded messages become child `.eml` documents — and are
  recognised by their streams even without a file name. An mbox export with several messages is
  split: every message becomes a child e-mail, the export itself an index page.
- **Quoted history is kept when the quoted message is missing.** A reply's quoted history is only
  dropped when its direct parent (In-Reply-To, else the last References entry) is already in the
  collection or in the same mbox export; otherwise it is indexed under a "Zitierter Verlauf"
  section. Inline replies keep the up to three quoted lines directly above each answer.
- **Embedded objects in DOCX** (`word/embeddings/`: OOXML packages, OLE package objects such as
  `.bpmn` or `.pdf`, OOXML-in-OLE, legacy DOC/XLS storages) are ingested as child documents with
  their native parsers, grouped under the Word document.
- **Paragraphs over a page break.** The document pass marks a paragraph or list that continues on
  the next page; Search indexes and embeds the page's last chunk with the continuation's leading
  sentence (kept out of document reads via `display_len`), and links the chunks of a section
  across the pages of a batch, so `get_context` crosses the break.
- **Headerless table continuations** inherit the header rows and the caption (marked
  "(Fortsetzung)") of the table they continue, so their rows are indexed and read with column
  names.
- **Document attributes on the v2 path.** `/ingest-file` and Extract's `/v1/ingest` wrapper pass
  `X-Title`, `X-Tags`, `X-Metadata`, `X-Link`, and `X-Source` (plus `X-Version`,
  `X-Source-Modified`, `X-Dedup` on `/ingest-file`) through the job; Search stores them on every
  unit, so tag and metadata filters find v2 documents. E-mail attachments inherit tags,
  metadata, and source label.
- **MCP.** New tool `get_thread` (a whole e-mail thread chronologically, paginated with
  `offset`/`next_offset`, optionally restricted by `path_prefix`). Search hits, `get_document`,
  and `get_summaries` name their `document_group`; a grouped hit merged from several e-mails
  carries `group_members` and heads each message with `[Nachricht: <ref>]`. `find_identifier`
  accepts `path_prefix`. The read tools (`get_document`, `get_documents`, `get_summary`,
  `get_summaries`, `get_outline`, `get_section`, `get_pages`, `list_figures`, `get_table`,
  `find_identifier`) accept `valid_at` and read the version valid at that instant.
- **Runtime coverage queue.** Every message of a thread-grouped search hit (`group_members`)
  becomes a candidate of its own instead of riding on the representative message.
- **Studio tool chips.** Every node that offers tools (or whose traced run called tools) shows
  them as chips beside it on the canvas, with run status (running, completed, error, dimmed when
  unused), call counts, pinned static arguments, and tools called but not listed drawn dashed.
  Clicking a chip opens the node's Tools settings at that tool.
- **Static tool arguments in Studio.** The node's Tools section edits `config.toolArgs` per tool
  (JSON or template) and warns about arguments stored for tools the node no longer lists.
- **Studio Start panel shows the run's input.** With a traced or pinned run, Start shows the
  request messages (all roles, tool calls), the values templates and conditions see, token
  claims, and the trace metadata (`flow_version`, session, user, client) from
  `GET /monitoring/debug/:id`, with a switch between the current and the pinned run. The panel
  is only as visible as the monitoring debug trace itself, which already carries these fields.
- Extract `/metrics` exposes the text-fidelity gate as `extract_text_fidelity_checks_total`,
  `extract_text_fidelity_divergences_total`, and `extract_text_fidelity_missing_tokens_total`.
- Extract `/health` probes `pdftotext -bbox-layout` once per process (again on `?deep=1`) and
  reports it as `bbox_layout`. A missing capability is reported, not fatal: the deterministic
  page analysis is skipped and pages fall through to vision.

### Changed

- The figure-kind filter (`list_figures` `kind`, `search`/`/v2/search` `figure_kind`) accepts the
  stored kinds plus aliases (`process` = `bpmn` + `flowchart`, `drawing`, `data`, `mask`,
  `table`, German equivalents) and rejects an unknown value with the vocabulary instead of
  silently matching nothing.
- Search `/ingest-file` rejects an `X-Metadata` header that is not a JSON object with 400.
- MCP `get_section` and `get_pages` (Markdown format) return Extract's section/page/document
  summaries in a separate `summaries` array instead of mixing them into `markdown`; `units`
  counts the body units only.
- **Studio run path.** While a run is traced, the nodes and edges it passed through (including
  Start and the exit that answered) are highlighted and the rest dimmed; untraced editor nodes
  are no longer drawn as pending. Node types show an icon on canvas cards and in the palette
  instead of an emoji. `apps/control` pins the dev dependency `postcss` 8.5.26.
- The final revision switch supersedes only committed revisions of a document; a revision still
  staging finishes and is ordered by its version when it commits, so two formats of one document
  ingested concurrently no longer abort each other. Deleting a document by reference also removes
  its revision pointer, source records, and thread membership.
- New runtime dependencies: `fast-xml-parser` 5.11.1, `fflate` 0.8.3, and `pg` 8.23.0 in
  Extract (native OOXML/BPMN parsing and the `extract` schema), and `sharp` 0.35.4 in Search
  (asset variants). Third-party notices and the supply-chain inventory are regenerated.
- The quickstart Extract image (`deploy/examples/Dockerfile`) additionally installs LibreOffice
  impress and draw for PPTX and VSDX, and the build fails if `pdftotext` lacks `-bbox-layout` or
  a converter is missing. Custom Extract images need the same packages.
- Extract's production-readiness gate flags an empty `SOURCE_URL_ALLOWED_HOSTS` when the v2
  routes are mounted (fatal in production, a warning elsewhere), and warns in production when
  `EXTRACT_DATABASE_URL` is unset, since v2 jobs, resumable uploads, and `source_url` pulls are
  then disabled.

### Fixed

- **Whole-document reads of v2 documents.** `get_document` / `get_documents` read only the body
  units (`chunk`, `table`, `figure`) in reading order (page, block position, ordinal), a table
  once (its grid, not the "Spalte: Wert" lines), a figure marked with its id, kind and asset id;
  evidence spans carry `unit_id` and pages. Extract's section/page/document summaries are no
  longer read back as the original. `get_summary` / `get_summaries` fall back to the v2
  `document` unit's summary and the first non-empty title; the summary backfill lists and writes
  one row per v2 document instead of every unit.
- `valid_at` reads of v2 documents select a whole revision (keyed by `revision_id`) and never a
  revision that is still staging or was aborted.
- Selecting Start or End on the Studio canvas had no effect.

### Security

- **Row ACL on the v2 ingest path.** Documents ingested through Extract's v2 jobs were written
  without row ACL, so every reader of the collection could find them. The job's ACL (narrowed to
  the uploading caller) now travels with the revision (`X-Allowed-Users/-Groups`) and is written
  onto every unit; a service write without one falls back to the collection ACL. Duplicate
  detection and version chains only match sources of the same ACL, and the source listing only
  shows readable sources. Documents ingested through v2 before this change keep their empty row
  ACL until re-ingested.

- **Conversion callbacks without `CALLBACK_ALLOWED_HOSTS` reach public addresses only.** The
  callback host is resolved at delivery, the connection is pinned to the validated address, and
  every resolved address must be public unicast: private, loopback, CGNAT, ULA, multicast, and
  their IPv4-embedded forms are refused, as IP literals already at request time. This is
  breaking for internal orchestrators on cluster DNS names or private addresses, which must now
  be listed in `CALLBACK_ALLOWED_HOSTS`. An allowlisted host may resolve to private space but
  never to a link-local or metadata address.
- **`source_url` pulls** are guarded by the same host rules plus an address check that applies
  with or without `SOURCE_URL_ALLOWED_HOSTS`: every resolved address must be public, the
  connection is pinned against DNS rebinding, and each redirect hop is re-validated. See
  [SECURITY.md](SECURITY.md).

## [0.8.0] — 2026-09-25

Versions 0.4.0 through 0.7.2 are documented below but were never tagged, so this entry's compare
link spans from `v0.3.0`, the last published tag, and it carries the work of those versions as
well.

Reworks the Control Studio into a complete flow builder, extends flow variables with constants,
allowlisted environment values, and calculations, and adds provider monitoring. All changes are
backward compatible: existing flows, variables, and API clients keep working unchanged. The only
schema change is one added index (version 40, `execution_snapshots (flow_id, created_at DESC)`) —
no table, column or data is changed — and there is no independently versioned contract-package
change.

### Added

- **`docs/FLOWS.md`**, a complete flow configuration reference — flow and node fields, the
  `llm` block and its parameters, every node type with its settings, examples and notes, edges and
  the condition grammar, runtime placeholders and where each renders, variables, constants and
  calculations. It is generated by `bun run flow-reference` from the flow schema, the node type
  catalog, and the new `apps/runtime/src/graph/flow-reference-data.ts`, the same sources the
  Studio's settings forms, node docs, and expression builder use. CI checks it is current
  (`flow-reference:check`), and tests pin the reference data to the engine (condition context,
  prompt placeholders, calculation functions).
- The flow schema's fields carry descriptions, so `schemas/flow.schema.json` now gives editors
  hover documentation. `flow-reference` regenerates it together with `docs/FLOWS.md`.
- **Flow variables** can reference other variables (`{{vars.x}}`, evaluated in dependency
  order), global constants from the new `FLOWS_DIR/constants.yaml` (`constants: { name: value }`,
  read as `{{const.name}}`), environment values whose name starts with `FLOW_PUBLIC_`
  (`{{env.FLOW_PUBLIC_NAME}}`), and calculations (`{{= round(vars.max_tokens / 2) }}`: arithmetic,
  comparisons, `&&`/`||`, `a ? b : c`, and a fixed set of functions, using a dedicated parser and
  no code evaluation). A value that is exactly one placeholder keeps its type. Cycles, unknown
  references, non-allowlisted env, and calculation errors are reported by the validator as
  `variables.<name>`. The same references (constants, env, calculations) also work in any node
  or edge value; unresolvable ones are reported with their node/edge path. `constants.yaml` is a reserved file, never loaded as a flow; changing it
  reloads all flows.
- Runtime routes for the Studio: `GET /flows/node-types` (node type catalog with config fields,
  docs and examples, connected tool ids, model shortcuts with a one-line description, preset model
  ids, constants, and `FLOW_PUBLIC_*` values), `POST /flows/variables/evaluate`,
  `POST /flows/expressions/evaluate` (condition check against sample values), and
  `POST /flows/:id/test-run` (runs the canvas state through an ephemeral `<id>@studio-<nonce>`
  registration, max. 50, expiring after 30 minutes, never replacing the live flow).
- **The node panel only offers fields the node type actually reads**, taken from the runtime's node
  type catalog (`topLevel` in `GET /flows/node-types`) instead of a second list maintained in the
  UI, which had drifted from the engine. A field the type ignores is hidden while unset; a field
  that IS set on a type that ignores it stays visible with a warning, so a dead setting can be seen
  and removed rather than sitting unread in the flow file. Without a catalog (offline, or an older
  runtime) the previous defaults apply.
- **`agent-harness` documents its `systemPrompt`**: it is guidance for the PLANNER, prepended to
  the planning instructions — not a prompt for the delegated nodes, which carry their own. A
  plannerless harness (`config.plannerless: true`) never reads it, so leaving it empty there is
  correct and setting it has no effect. The field was offered in the Studio without any of this
  being stated anywhere.
- **Every node type now states its position on `llm`, `systemPrompt` and `tools`**, checked against
  the handlers that do the reading. Previously seven types declared no node fields at all, which
  reads as "not applicable" but is indistinguishable from an undocumented gap. Corrected along the
  way, each with the reason and where the setting belongs instead: `tool` applies `overrides` (the
  only way to vary its tool list) — that was undocumented; `classifier` does NOT apply `overrides`
  (it reads `llm`/`systemPrompt` directly and never calls `resolveNodeConfig`), and it does read
  `priority`; `parallel`'s `parallelNodes` is `recommended`, not `optional`; `retrieval` and
  `memory` ignore `llm` (the embedding model is a deployment setting, not a node field);
  `assistant-context` ignores `systemPrompt` (its prompt is rendered from the assistant's own
  identity). Three new tests pin these claims to the code — the `resolveNodeConfig` callers, the
  queue-priority type filter, and direct field reads per handler — so the catalog cannot drift from
  the engine unnoticed.
- The Studio only offers `priority` on the types whose priority the queue actually reads (`llm`,
  `classifier`), and flags an `overrides` block on a type that never applies it.
- **A flow save keeps its YAML anchors and aliases.** Several flows share a config block between
  nodes via `&anchor` plus `*alias` references, but the definition the editor sends back is the
  expanded form — nothing in it says which sites are the same block. The comment-preserving write
  therefore replaced every alias with a literal copy: content stayed correct, the file grew by
  about a third, the anchors were left with nothing referencing them, and one shared block quietly
  became several independent ones, so a later edit to the anchor no longer reached the nodes that
  used to follow it. An alias is now kept whenever the value at that site is unchanged; a site that
  genuinely diverged is written out on its own, because it is no longer the shared value. The
  result is verified by reading it back, and falls back to the expanding merge unless it parses to
  exactly the submitted definition — which covers the one corrupting case, the anchor's own
  definition being edited while an alias site is not.
- **Prompt files are editable**: `GET /flows/prompts/content?path=prompts/x.md` and
  `POST /flows/prompts/write` read and write the Markdown file behind a
  `#[[file:prompts/x.md]]` system-prompt reference. Reading needs `flows:read`, writing
  `flows:write`; both paths are pinned to the flow directory's `prompts/` subtree (traversal and
  non-Markdown paths are rejected), the write is atomic and takes a `baseHash` for the same
  409-on-conflict protection `/flows/write` has, and it is recorded as `flows.prompts.write` in the
  audit log. In the Studio the node panel now shows an editor for each referenced prompt file
  below the system prompt field: previously the field held only the reference, so the prompt text
  of nearly every flow could not be changed from the UI. Saving the prompt file does not touch the
  flow, and saving the flow leaves the reference intact.
- **The eval judge runs against a real model.** `createLlmJudge` takes either an AI SDK model (what
  `createLlmProvider` returns) or the previous `{ invoke }` shape, prompts it for a JSON verdict,
  and reads the score from that JSON — a `<think>` block is stripped first, so a number inside the
  reasoning can't be mistaken for the grade. A missing model or a reply without a score now throws
  instead of scoring 0, because a fabricated failing grade is indistinguishable from a bad answer
  and silently poisons every comparison built on it.
- **The optimizer can optimize a flow that exists only as a file** in `FLOWS_DIR`: it reads the
  source form the Studio edits when the flow has no online version. Promoting a variant publishes
  an online version, which then takes precedence over the file, exactly as publishing from the
  Studio does. Its synthetic definitions (`<flowId>@variant/<label>`, a scoped sub-flow) are
  registered as ephemeral flows for the duration of the eval instead of being parked as drafts in
  the flow store, which the runtime's executor never resolved — so a variant used to be evaluated
  against the unchanged flow.
- A finished Autopilot run links to the optimizer run holding its variants, scores and the promote
  action.
- A Studio "Canvas" run of a canvas with no unsaved edits runs the live flow under its real id, so
  it counts as that flow's traffic (Autopilot and optimizer snapshots) instead of being recorded as
  a throwaway `<id>@studio-…` test run. An edited canvas still runs ephemerally.
- `GET /flows/:id` returns a file flow's source form (`sourceDefinition`: shortcuts,
  `{{vars.*}}`, prompt includes, and sub-flow origins kept), its file, and a content hash;
  `GET /flows` reports whether the flows directory is writable (`fileWriting`).
- **Studio** (Control): flow picker with deep link (`/studio?flow=<id>`), collapsible side
  panels and a focus mode, a settings form per node type generated from the catalog with the full
  node type reference beside it, a variables table (typed values, usage counts, rename that
  rewrites references, delete confirmation, live result of formulas), an expression builder
  behind every ƒx button (variable browser, operators, live result or condition check),
  drafts/publish/write-back to the flow file, diff of the draft against the live version or file,
  undo/redo, rename and delete of nodes with reference rewriting, auto-layout ("Tidy up"), dashed
  reference links for parallel children and harness verifier/delegates, and a Run & Trace panel
  that tests the canvas or the live flow with per-node tokens and cost.
- The Studio Copilot can edit node settings (`configPatch`, shortcut, parallel children,
  classifier schema, priority) restricted to catalog-documented keys; its proposal is shown as an
  overlay on the canvas and must be accepted. Schema failures are reported per field, and an
  invalid proposal gets one repair round.
- The Studio canvas separates the run's flow from tool connections: flow edges keep docking
  bottom → top, while the links from a node to the nodes it calls (parallel children, harness
  workers and verifier) dock at a handle on the caller's right edge and the called node's left
  edge, drawn dashed and right-angled. The canvas toggle is now called "Tool links".
- Sub-flows in the Studio: the nodes of each sub-flow file (`metadata.$include`) are drawn in a
  coloured box labelled with the file name, and auto-layout keeps them together. The palette has a
  Subflows section — "New subflow" (moves the selected nodes into `subflows/<name>.yaml`, or
  starts it with one node) and "Include…" (lists `subflows/` with description, nodes and the flows
  using each file, and places a file's nodes and edges on the canvas). Nodes dropped onto a box
  join that sub-flow, and a node's settings show and change the file it is saved in. Saving writes
  new files and updates `$include`. Backed by `GET /flows/subflows` and
  `GET /flows/subflows/content?path=`.
- A copilot in the Studio's expression builder writes or changes the field from an instruction
  (`POST /flows/expressions/copilot`). It is given exactly what the builder offers for the field —
  variables, constants, public env, node results, request and user data, run state, with pinned
  run values and the reason where an entry does not work — plus the field's grammar (operators,
  functions, rules). The proposal is checked with the engine's own condition parser, calculation
  evaluator and placeholder rules (one repair round), shown as a diff against the current value,
  and applied only when accepted.
- Pinned run data in the Studio's expression builder: pick a recorded run of the flow (live or a
  Studio test run) — or pin a test run right after it finished — and its query, user context and
  node results fill the tree (📌) and the previews of prompts, tool arguments and conditions. The
  pin is remembered per flow in the browser. Backed by `GET /monitoring/debug?flowId=` (runs of a
  flow, including its Studio test runs, with the triggering message) and
  `GET /monitoring/debug/:executionId/sample` (a run as sample values shaped like the run-time
  roots).
- Start and End on the Studio canvas: neither is a node of the flow definition, they make the
  compiler's implicit rules visible — the run starts at the flow's first node, and it ends after a
  node with no outgoing edge or one whose outgoing edges are all conditional and none matches.
  Selecting them shows what a request brings in (query, user context, variables) and what the flow
  returns, from the pinned run and from the run currently traced in Run & Trace.
- An **Optimize** panel in the Studio shows cheaper candidate models for the nodes that declare
  `config.routing.candidates`, with the expected cost saving, quality loss and where the quality
  figure comes from. It reads either the definition on the canvas — unsaved edits and drafts
  included — through the new `POST /optimizer/routing-advice`, which resolves shortcuts,
  `{{vars.*}}` and `$include` like a flow file and saves nothing, or the flows the runtime has
  loaded through `GET /optimizer/routing-advice`.
- A request in the Live Graph opens in the Studio (`/studio?flow=…&execution=…`): Run & Trace
  attaches to that execution — running or finished — and shows it as if it had been started there,
  with the trace on the canvas, the prompt, the answer and the option to pin it as sample data.
  Durable events are merged with live ones, so a late `running` event cannot regress a node that
  has already finished.
- Eval cases can be saved from a Studio test run with an expected answer and removed again from
  the Eval page (with confirmation) or right after saving in the Run & Trace panel.
- Provider monitoring: `GET /monitoring/providers` reports per provider the protocol, seen models,
  capabilities (now including `reasoning` and `toolCalling`), reachability from an engine-wide
  circuit-breaker observer, and call/error/token counters, plus the model-shortcut pools.
  `GET /monitoring/providers/:name/models` and `POST /monitoring/providers/test/{prompt,
  capabilities,performance}` drive live tests (`monitoring:write`). Control shows them on
  `/providers` and a new `/provider-testing` bench.

### Changed

- The Studio replaces the former flow editor and playground: `/flows` is the registry, and
  editing and inspecting a flow open it in Studio. Writing a file flow keeps its authoring form —
  shortcuts, `{{vars.*}}`, prompt includes, sub-flow files with their `$include` block, and
  comments — and a value-only edit changes just those lines.
- Flow validation names the node and field of a schema failure (e.g.
  `nodes[4](answer-fast).llm.provider`) instead of a bare "Schema validation failed".
- The circuit breaker stays per execution; reachability is additionally observed engine-wide for
  monitoring without letting one flow's failures skip a provider for other flows.
- The Studio's expression builder takes placeholders, condition fields and operators, and
  calculation operators and functions from the runtime (`reference` in `GET /flows/node-types`)
  instead of its own copies. It shows the whole data context in every field as a tree — flow
  variables, constants, public env, node results per node, the latest classification, request
  and user data, run state, date and time, calculation functions — and keeps entries that do not
  work in the field visible but disabled, with the reason. Operators are grouped and
  colour-coded, with a Clear action, clickable examples, a guide to conditions or calculations,
  and for load-time references the value the field resolves to when the flow loads.
- Studio canvas nodes are more compact, and the empty "not run yet" status dot is no longer shown
  on them (it read like an unconnected port).
- Every place that picks a flow — Optimizer, Autopilot, Security, the metrics filter — uses the
  Studio's searchable picker instead of a native `<select>` of two dozen long German names, and the
  multi-selects of Live Graph, History and Eval list flows by name with a search box. All of them
  sort alphabetically by name with numbers in order ("Flow 9" before "Flow 10") and match on name
  or id.
- A running node is marked by an arc travelling around its border rather than a pulsing dot, on the
  canvas, the Start/End cards and in the legend; the status colour moved from amber to sky, so
  "running" is no longer the colour of a warning. `prefers-reduced-motion` gets a static ring.
- Snapshots are queried per flow in the database (`list(limit, { flowId })`) instead of filtering a
  global window afterwards, where busy flows crowded a quiet flow out of the window and made the
  optimizer skip it for lack of samples. Backed by the new index.
- An edge label is now part of the line: the text runs along the path inside a capsule outlined in
  the edge's colour, instead of a separate box that cuts the line. It is dropped when it does not
  fit on the edge, and it never renders upside down.
- The optimizer routes are always mounted. Routing advice and trace analysis do not need the
  self-optimizing loop, so the Studio's Optimize panel works without `OPTIMIZER_ENABLED`; the
  loop's own endpoints answer `501` with the setting that enables them instead of returning
  404 for the whole namespace.

### Removed

- The standalone flow editor, flow versions panel, and Studio playground components in Control,
  superseded by the Studio builder.

### Fixed

- Control pages and panels now load with operator auth disabled (`AUTHN_MODE=disabled`): queries
  are gated on `isAuthenticated` instead of on a token being present, and the Authorization
  header is sent only with a real token.
- Saving an eval case from Studio posted to a non-existent route and without the required
  expected answer; it now posts to `/eval/cases` and reports failures instead of claiming success.
- The canvas Fit control is visible in dark mode.
- An optimizer run whose baseline could not be scored, or whose every variant failed, reported
  `done` with nothing to compare; it now ends in `error` naming the reason (typically a judge
  failure), and a judge error on a case is carried into that case's `error` instead of being
  hidden in its assertions. The "too few snapshots" message says that Studio canvas test runs
  deliberately don't count.
- The Studio's Start/End links disappeared on any re-render — a click, an incoming run status —
  because React Flow forgets the handle positions of a node handed back without its measured size,
  and the measurement changes for those two cards were dropped. Links to the tool handle were
  likewise lost when the handle appeared, since handles are only re-measured on a size change.
- Edge labels on the canvas: two edges between the same pair of nodes share one curve and put both
  labels in the same spot, now they sit at their own points along it; a label longer than the edge
  is cut at the end with "…" and carries the full text as its tooltip instead of vanishing; a step
  edge between close handles no longer zigzags right where its label sits; and identical delegation
  labels fanning out from one harness are drawn once, on the link with the most room.
- A node that only an `agent-harness` calls no longer floats unconnected on the canvas: its
  delegation link stays drawn even while the harness is not selected, since it has no other link
  that would explain it.
- The expression builder inserted flow variables into conditions as `vars.x`, which conditions
  cannot read; it now inserts `{{vars.x}}`, which is replaced when the flow loads.
- The Studio's expression builder offered `{{context.tenantId}}`, which the request context does
  not have (it always rendered empty), and offered `{{classification.*}}` and `{{classLabel}}`
  for system prompts, where the runtime does not render them. It now lists only real fields and
  marks placeholders that work only in tool arguments or only in prompts.
- `deploy/examples/flows/README.md` linked to the documentation with paths that pointed outside
  the repository.
- `schemas/flow.schema.json` rejected valid flow files: it described only the expanded runtime
  form, so an editor using it flagged every `llm: { shortcut: … }`, every `_comment` key, and every
  flow whose nodes and edges come from `metadata.$include`. It now describes the file form: `llm`
  is either `{ shortcut, parameters? }` or `{ provider, model, … }` (on nodes and overrides),
  `_`-prefixed annotation keys are allowed, and `nodes`/`edges` are optional when
  `metadata.$include` is set. Other unknown keys are still errors.

### Security

- Runtime's CSRF check now applies to `POST` only. It rejected every body-less `DELETE` from the
  allowlisted dashboard origin (a missing Content-Type counts as form data), so deleting an eval
  case failed with 403. HTML forms can send only GET and POST; cross-origin PUT/PATCH/DELETE need
  a CORS preflight, which the `CORS_ORIGINS` allowlist already governs. Cross-origin form POSTs
  are still rejected.
- A `POST` that carries an `Authorization` header is no longer CSRF-checked. A page cannot set that
  header cross-origin without a CORS preflight, which the `CORS_ORIGINS` allowlist governs, and the
  credential is not one a browser attaches by itself, so the header itself rules out the
  form-POST vector the check exists for. Without this, the dashboard's own body-less actions — for
  example publishing a flow, where a missing Content-Type counts as form data — were refused with a
  bare `Forbidden` whenever `Origin`/`Sec-Fetch-Site` were not exactly same-origin. A `POST`
  without an `Authorization` header stays checked.
- Flows can read environment values only through the `FLOW_PUBLIC_` prefix; no other variable,
  such as API keys, is readable by a flow. Variables supplied with a request are literals and are
  never evaluated as references or calculations.

## [0.7.2] — 2026-09-23

Dependency maintenance only. Every change is a backward-compatible upgrade of an existing
dependency to a newer release; there is no source, schema, flow, migration, or
independently versioned contract-package change. Third-party notices are regenerated to
match the upgraded versions.

### Changed

- **Runtime** (`@atf/runtime`): AI SDK providers and core bumped — `ai` 7.0.93 → 7.0.107,
  `@ai-sdk/amazon-bedrock` 5.0.76 → 5.0.88, `@ai-sdk/anthropic` 4.0.49 → 4.0.58,
  `@ai-sdk/azure` 4.0.63 → 4.0.75, `@ai-sdk/google` 4.0.64 → 4.0.76,
  `@ai-sdk/openai` 4.0.60 → 4.0.71, `@ai-sdk/provider` 4.0.10 → 4.0.17;
  `@langchain/core` 1.2.9 → 1.2.11, `@langchain/langgraph` 1.4.14 → 1.4.16;
  `@aws-sdk/client-bedrock-agent-runtime` 3.1127.0 → 3.1136.0; `jose` 6.2.4 → 6.2.12;
  dev `fast-check` 4.9.0 → 4.10.2.
- **Control** (`@atf/control`): `next` 16.3.4 → 16.3.5, `react`/`react-dom` 19.2.8 → 19.3.0,
  `lucide-react` 1.35.0 → 1.45.0; dev `@types/react`/`@types/react-dom` → 19.3.0,
  `@types/node` 26.4.1 → 26.6.2.
- **Gate** (`@atf/gate`): `@aws-sdk/client-bedrock-runtime` 3.1127.0 → 3.1136.0,
  `express-rate-limit` 8.5.2 → 8.7.0, `jose` 5.10.0 → 6.2.12, `mysql2` 3.24.2 → 3.24.4;
  dev `@types/node` 26.4.1 → 26.6.2.
- **Search** (`@atf/search`): `@aws-sdk/client-bedrock-runtime` 3.1127.0 → 3.1136.0,
  `jose` 6.2.4 → 6.2.12; dev `@types/node` 26.4.1 → 26.6.2.
- **Extract** (`@atf/extract`): `jose` 6.2.4 → 6.2.12; dev `fast-check` 4.9.0 → 4.10.2,
  `@types/node` 26.4.1 → 26.6.2.
- **Extract contract** (`@atf/extract-contract`): dev `fast-check` 4.9.0 → 4.10.2.
- **Quickstart image** (`deploy/examples/Dockerfile`): base `oven/bun` 1.4.0 → 1.4.2.

## [0.7.1] — 2026-09-23

Fixes pool failover for schema-enforced `llm` nodes. Backward compatible: a single-model
(non-pool) structured node keeps its previous behaviour, and no schema, migration, or
independently versioned contract-package change is included.

### Fixed

- A structured-output `llm` node (one declaring `config.outputSchema`) now fails over across its
  pool candidates and any deployment-level fallback model, exactly like the streaming `llm` and
  `classifier` paths. Previously the structured-output path received only the pool's primary
  candidate and retried that one provider, so an unreachable primary (e.g. an offline local
  endpoint) failed the node with `Cannot connect to API` instead of rotating to a reachable
  fallback. Each candidate keeps its own bounded empty-output retry budget; the run's deadline
  firing still fails immediately (no failover past the budget), and only exhausting every
  candidate fails the node. Emits `structured_output_candidate_failed`/`fallback` diagnostics on
  each hand-off.

## [0.7.0] — 2026-09-22

Adds model pools to shortcuts and a priority-aware execution queue, and relaxes the flow
schema's `llm.provider` from a fixed enum to any operator-configured provider name. All three
are backward compatible: existing single-model shortcuts, unprioritized flows, and the
previously enumerated provider names keep working unchanged. No database migration or
independently versioned contract-package change is included.

### Added

- Model shortcuts in `flows/model-shortcuts.yaml` can now resolve to a **pool** instead of a
  single engine/model pair. A pool is an ordered list of members — each a concrete engine/model
  pair (with optional extra parameters and a relative `weight`) or a reference to another shortcut
  (nested pools are flattened) — carrying a selection `strategy`: `fallback` (configured order is
  the priority order), `round-robin`, `weighted-round-robin`, `random`, `weighted-random`, or
  `least-used`. The flow parser writes the first candidate into the node's `provider`/`model`/
  `parameters` and attaches a concrete `pool` to the `LlmConfig`, so every consumer that only
  understands a plain config (admission, compliance, cost, capability collection) keeps working off
  the primary while the streaming `llm` and `classifier` handlers select among the candidates per
  strategy. All pool members are counted for compliance data-flow mapping, capability collection,
  and token-limit accounting — a rotated-to or failed-over member is never invisible to those
  checks. A malformed pool (unknown member, cyclic reference, empty member list) leaves the
  `shortcut` key in place so the node fails validation loudly rather than running on a wrong model.
- Flows and individual `llm`/`classifier` nodes accept an optional `priority` (integer 0–100).
  The execution concurrency semaphore now admits waiting requests highest-priority-first, with
  FIFO order preserved among equal priorities. A flow's effective queue priority is the maximum of
  its own `priority` (default 50) and the `priority` of its LLM/classifier nodes, so a latency-
  sensitive flow can jump the queue ahead of bulk work under a concurrency cap.

- The `classifier` handler, when its node resolves to a pool, now tries the pool candidates in
  the strategy's order and falls through to the next candidate on a generation error or an
  unparseable classification before resorting to the node's configured `fallback` class. A
  single-model (non-pool) classifier keeps its previous behaviour.

### Changed

- The flow schema no longer restricts an `llm.provider` to a fixed enum (`openai`, `google`,
  `ollama`, `azure`, `bedrock`, `anthropic`). A provider is now any operator-configured `PROVIDERS`
  name (1–64 chars) or a `{{vars.*}}` reference, matching how deployments already alias several
  endpoints of the same wire protocol under distinct names.
- The streaming `llm` handler now fails over immediately when a provider is unreachable. A
  transport failure (connection refused, DNS failure, connect timeout, 5xx/408) on a candidate
  that still has another candidate behind it (a pool member or a deployment-level fallback) skips
  the remaining retries against the dead endpoint and moves to the next candidate at once, emitting
  an `llm_provider_unreachable_failover` diagnostic. The failure still counts toward the provider's
  circuit breaker, and the last candidate keeps the full retry path so a lone endpoint can still
  recover from a transient hiccup.

### Removed

- The Control app's `/rag` collection-management page (and its loading skeleton) has been removed
  along with its navigation entry; the RAG index is no longer managed from this UI.

### Fixed

- Removed a stray double semicolon at the end of the `llm` node handler that Biome flagged as
  unreachable code (`lint/correctness/noUnreachable`), which broke the lint baseline.
- The Studio builder's Copilot panel now uses a distinct React `key`, so it no longer shares a key
  with the canvas and remounts correctly when the canvas is reset.

## [0.6.1] — 2026-09-18

Hardens the staged coverage queue against a cross-source identity gap and makes a failed
delegated tool call diagnosable. Both changes are backward compatible: the queue's public
behavior is unchanged for references that already matched, and the tool-error handling adds
a server-side diagnostic without altering the anonymized result the model sees. No database
migration, independently versioned contract-package change, or executable flow change is
included in this repository. Downstream research flows that consume this runtime bump their own
`metadata.version` in their respective deployment repositories.

### Fixed

- The staged coverage queue now deduplicates documents across the two retrieval paths by a
  canonical document identity instead of a raw reference string. Summary triage seeds the
  ledger with a document-level reference, while a discovery search hit can carry a deeper
  chunk/section reference when the store omits `base_ref`; the raw-string compare then failed
  to recognize the two as the same physical document, so a search hit's promotion was silently
  lost and — where two reference forms for one document coexisted — the same original could be
  read twice. Seeding and search-hit promotion now key on a normalized document identity
  (NFC, trimmed, trailing-slash- and case-insensitive, truncated to the parent document file).
  The reference handed to `get_document` is unchanged. Ledger seeding still fails closed when
  summary pages are genuinely missing.

### Added

- A delegated tool call that throws before returning a result now emits a server-side
  `tool_execution_failed` diagnostic carrying the raw error class (name and message) into the
  execution debug trace. The model-facing result stays the anonymized `Tool execution failed.`
  envelope, and tool arguments are deliberately excluded so a reference or query payload is
  never written to diagnostics. Previously the raw cause was discarded, making an adapter or
  transport failure indistinguishable from a budget, identity, or evidence guard.

## [0.6.0] — 2026-09-17

Makes structured output survive the three ways a local OpenAI-compatible server breaks it: the
document delivered in the reasoning channel, a near-miss response the strict schema parse rejects,
and a schema-enforced call whose prompt ends on an assistant turn. The plannerless coverage-report
extraction is the flow that hit all three; it now also names the refs it must decide and gets an
output ceiling that covers the largest supported batch. Every change is backward compatible: the
recoveries only engage on a response that would otherwise have failed, and the thinking-channel
toggle is scoped to a single verified model. No database migration, independently versioned
contract-package change, or executable flow change is included in this repository.

### Fixed

- Structured-output `llm` nodes no longer fail when an OpenAI-compatible server delivers the
  generated document in the reasoning channel with an empty `message.content`. Verified against the
  LM Studio build serving `qwen/qwen3.6-35b-a3b`: a `response_format: json_schema` request whose
  thinking channel is active returns the complete object in `reasoning_content`, which the AI SDK
  saw as empty text and reported as `No object generated: could not parse the response.` — failing
  every attempt and discarding a usable document. The response is now repaired at the fetch layer,
  scoped to non-streaming responses of requests that asked for `json_schema` / `json_object`, so no
  chain-of-thought can reach a free-form answer.
- A structured-output response that the strict schema parse rejects but that still contains a valid
  JSON object (code fence, trailing prose) is recovered from the error's raw text and emitted
  canonically, instead of consuming all three attempts and failing the node. Provider token usage
  attached to the error is accounted rather than reported as zero.
- The schema-enforced coverage-report extraction no longer sends a prompt that ends on an assistant
  turn. llama.cpp reads a trailing assistant message as a prefill to continue and then has to seed
  the `json_schema` grammar with that free text, which aborts sampler setup with HTTP 400
  `Failed to initialize samplers` before a token is produced — so every coverage report of a run was
  refused as `structured_output_failed` and the queue never advanced. A short user turn is appended
  where the shape requires it; a reply already ending on a user or tool turn is left untouched.
- The extraction prompt now enumerates the assigned refs, ordered and counted, with an explicit
  "each exactly once". The schema's ref `enum` is a decoding constraint, not information: with the
  refs absent from the prompt a constrained model repeated the first legal enum value for every
  array element, and the report was rejected as a duplicate ref.
- The extraction output ceiling rose from 12288 to 16384 tokens. A report costs roughly 120 output
  tokens per document, so a 100-document assignment stopped on `length` with truncated JSON and was
  refused as `invalid_json`, silently capping the queue.

### Added

- A `structured_output_salvaged` diagnostic and the `aiperator_llm_structured_salvaged_total`
  counter record when a node succeeded on a tolerant parse of the raw text rather than on enforced
  output, so a recovered near-miss is visible in the trace instead of looking like a clean success.
- Model capabilities carry `suppressThinkingKwargs`, the `chat_template_kwargs` that switch off a
  hybrid-reasoning model's thinking channel for engine-internal calls that are pure format
  conversion. It fails closed per model — a hosted OpenAI endpoint rejects unrecognized request
  arguments — and is currently declared only for the verified local `Qwen3.8-Flash-Next` build,
  which is also now recognized as accepting image input.

### Changed

- The `structured_output_failed` and `structured_output_empty_retry` diagnostics carry the
  provider's `finish_reason`, response length and output-token count when the SDK supplies them, so
  a truncated document (`finish_reason` `length` → raise `maxTokens`) is distinguishable from an
  empty one.
- The coverage-report extraction call switches the thinking channel off where the model declares the
  toggle. The reasoning is already done by the worker and the thinking tokens are billed against the
  same output ceiling as the report. Measured against a live llama.cpp endpoint on a 25-document
  batch: 11–15s and a stable 2.8k output tokens with the channel off versus 34–73s and 4.5k–7.1k
  with it on, at identical validity. An operator's own `chatTemplateKwargs` are preserved and only
  the toggle is forced.

## [0.5.0] — 2026-09-16

Adds a deterministic hard cap that shrinks an oversized prompt before the output-token allowance
would collapse to one token, and teaches the offline flow validator to resolve named providers.
Both changes are backward compatible: truncation only engages when a known context window would
otherwise be exceeded, and provider resolution during validation is opt-in via the existing
`PROVIDERS` environment variable. No database migration, independently versioned contract-package
change, or executable flow change is included in this repository.

### Added

- Deterministic prompt truncation for `llm` nodes: when an assembled prompt would exceed the
  model's usable input budget, the runtime shortens the largest earlier string message (never the
  final task turn), preserving head and tail around an explicit elision marker, instead of letting
  the output-token allowance be floored at one token. The current-task message is always kept
  intact, image and tool-call content are left untouched, and the operation is a pure function of
  its inputs so provider prompt-cache reuse is preserved.
- The event is recorded in the execution debug trace as a `context_truncated` diagnostic carrying
  the removed character count, the number of shortened messages, and the estimated prompt tokens
  before and after.
- The offline flow validator (`scripts/cli.ts validate`) resolves named `llm.provider` references
  by reading provider instances from the `PROVIDERS` environment variable, so deployment flows that
  target a named local endpoint validate without a running server. Malformed or schema-invalid
  `PROVIDERS` input is ignored with a warning rather than aborting validation, and an unset variable
  preserves the prior protocol-only behaviour.

### Fixed

- Removed an unused import in the agent-harness loop.

## [0.4.0] — 2026-09-15

Adds on-demand image inspection for text-only Runtime nodes and hardens plannerless coverage
report diagnostics. Existing flows remain compatible because image inspection is opt-in and the
stagnation limit remains opt-in. No database migration, independently versioned contract-package
change, or executable flow change is included in this repository.

### Added

- `llm` nodes can declare `config.imageInspection` with a dedicated vision-capable model. Inline
  image bytes are replaced by deterministic run-scoped `img-N` references, and the hosting model
  can call the collision-safe `inspect_image` tool only when visual evidence is needed.
- Image references cover initial attachments and same-loop tool-result images, deduplicate by
  canonical MIME type plus bytes, and retain active bytes independently of transient publication
  store eviction.
- Inspection calls report separate model usage, cost, success/error metrics and synthetic
  tool-node trace attribution. Static model-policy and capability discovery include the secondary
  inspection model.
- Invalid coverage reports now identify the violated report rule and expose a rejection streak
  scoped to the logical assignment.

### Fixed

- Productive coverage work in one parallel assignment resets global stagnation even when a sibling
  report is rejected, preventing valid progress from being terminated by an unrelated worker.
- Repeated invalid coverage reports consume the optional plannerless stagnation budget instead of
  silently retrying until the global iteration limit.
- Inspection-tool names are reserved after configured, media and caller tools are merged, so a
  caller-supplied `inspect_image` cannot replace the internal server-executed tool.
- Remote, undecodable, malformed-base64 and oversized image inputs fail closed rather than being
  forwarded to a text-only host or deferred to a paid vision failure.
- Run-owned image copies are bounded to 32 live references, 128 MiB per execution and 25 MiB per
  image. Transient media storage rejects empty or oversized items without evicting valid entries.
- Coverage rejection diagnostics no longer retain excerpts of worker output, avoiding duplication
  of source content into debug-trace details.

### Security

- Image-inspection documentation now states the direct vision-provider egress boundary, the
  default-off multimodal PII behavior, the distinction from MCP tool-egress controls, and the
  operator responsibility to verify no-plaintext image handling when required.
- Strict base64 canonicalization rejects invalid alphabets, padding and impossible lengths before
  image bytes enter Runtime's media or inspection stores.

### Compatibility

- Existing nodes without `config.imageInspection` keep their previous multimodal behavior. The
  new block requires a known vision-capable model or explicit `parameters.visionInput: true`.
- Evicted `img-N` references become unavailable and are never rebound to another image. Operators
  should size image-heavy flows within the documented fixed per-run bounds.
- No flow YAML is tracked in this repository. External flows opting into image inspection require
  their own semantic `metadata.version` bump and post-deployment `flow_version` verification.

## [0.3.0] — 2026-09-14

Adds deterministic worker routing for plannerless coverage queues. Existing flows remain
compatible: every assignment mode without an override continues to use the first valid
allowlist target. No database migration, independently versioned contract-package change, or
executable flow change is included in this repository.

### Added

- Agent-harness coverage queues accept optional
  `config.coverageQueue.targets.{summary,discovery,original}` entries, allowing summary triage,
  targeted discovery, and original-document review to run on different worker nodes.
- Flow validation trims configured targets and requires every target to be non-empty and present
  in the harness allowlist. Runtime validation also fails closed before delegation when a
  configured non-empty target does not resolve to an allowlisted node, even if schema validation
  was bypassed.

### Compatibility

- Omitting `coverageQueue.targets`, or omitting an individual mode, preserves the previous
  behavior by selecting the first valid allowlist target.
- Deployments may opt into mode-specific workers without migrating stored data. Any external
  executable flow changed to use the new configuration still requires its own semantic
  `metadata.version` bump and post-deployment `flow_version` verification in the execution
  debug trace.

### Security

- Mode-specific routing does not expand worker authority: configured targets must remain in the
  harness allowlist and resolve to valid, non-cyclic nodes before any task is delegated.

## [0.2.1] — 2026-09-11

Repairs multimodal LLM requests in Runtime. Image attachments now reach providers as AI SDK
file parts, local multimodal Qwen3 checkpoints are recognised as vision-capable, and an
optional vision step can be scoped to the current turn. No database migration, no contract
change and no executable flow change.

### Added

- LLM nodes accept `config.inputFilter: "current-turn-attachments"`, which skips the node
  unless the most recent user message itself carries an image or file part. The existing
  `"attachments"` filter keeps its behaviour of matching attachments anywhere in the
  checkpointed history.
- Model capabilities mark local vLLM Qwen3 NVFP4 checkpoints served over the OpenAI protocol
  as vision-capable. Local model ids match no cloud pattern and previously failed closed on
  vision; the rule is scoped to the multimodal build so text-only Qwen deployments stay closed.

### Fixed

- Image content is mapped to AI SDK `file` parts with the validated MIME type instead of the
  legacy `image` part, so providers receive the declared media type. Image detection, context
  window estimation and text rendering all recognise the file-part shape, including checkpoints
  written before this release.
- A vision preprocessing step filtered on attachments no longer runs for a later text-only
  request because an earlier checkpointed turn contained an image.
- The PII image describer passes the attachment MIME type through to the description request
  rather than sending an untyped image part.

## [0.2.0] — 2026-09-11

Expands Extract's document surface and progress contract. This release does not run a database
migration and does not change an executable flow. The independently versioned
`@atf/extract-contract` advances from 1.0.0 to 1.1.0 with additive fields.

### Added

- Extract and Search accept legacy DOC/XLS plus TIFF, BMP and WebP. LibreOffice handles both
  legacy and OOXML Office files; raster formats share the bounded image pipeline, with a dedicated
  decoded-pixel ceiling for BMP.
- Conversion responses expose aggregate token usage and pipeline timings in JSON and through
  `X-Token-Usage`, `X-Model` and the compatible `X-Vision-Model` header.
- SSE conversion now reports `queued`, `converting`, `progress` and `heartbeat` in addition to
  acceptance, completion and error events. Progress carries ordered page Markdown, cumulative
  tokens, ETA, elapsed time and per-page timing.
- `X-Callback-Events: extract|progress|all` opts asynchronous callers into equivalent ordered,
  best-effort progress callback POSTs before the terminal callback.

### Changed

- `@atf/extract-contract` 1.1.0 adds optional timing and progress telemetry. Consumers continue to
  gate on major version 1; the canonical Markdown grammar is unchanged.
- Search's `/ingest-file` proxy accepts every format supported by Extract and preserves the
  `atf-extract/1.1.0` provenance.
- Health output reports DOC, DOCX, XLS and XLSX as degraded when LibreOffice is unavailable.

### Fixed

- Legacy Office admission follows the complete CFB FAT and directory chains instead of assuming
  the primary Word or Excel stream is in the first directory sector.
- Slow progress callback receivers no longer delay page conversion or create an unbounded
  completion backlog. Intermediate delivery keeps one in-flight and the latest pending event,
  remains ordered and timeout-bounded, and the terminal callback retains its retry budget.
- Queue hook failures now restore active/waiting state instead of leaking capacity.

### Security

- DOC/XLS are admitted only after their OLE container contains the expected Word or Excel primary
  stream; unrelated compound formats are rejected before LibreOffice sees them.
- The supported parser surface grows to legacy OLE and an explicit BMP decoder. Existing upload,
  decoded-pixel, page and queue limits remain the resource boundaries; deployments should retain
  corpus and fuzz testing for untrusted documents.

### Compatibility

- SSE clients must ignore unknown event names for forward compatibility. Existing terminal `done`
  and error handling remains available, but the observable event sequence now includes queue and
  conversion state.
- DOC/XLS conversion requires LibreOffice. A deployment without it stays healthy but advertises
  those formats as degraded.
- No flow YAML is tracked in this repository, so no `metadata.version` changes here. A later flow
  deployment still requires checking `flow_version` in the execution debug trace.

## [0.1.4] — 2026-09-11

Corrects version metadata that 0.1.2 and 0.1.3 left behind, and adds the check that should have
caught it.

### Fixed

- **Service identities announced the wrong version.** Search's OpenAPI document
  (`GET /openapi.json`) and Gate's MCP server identity — the `serverInfo` in a discovery
  response, and the client identity Gate presents when proxying or importing another MCP server —
  still reported `0.1.1` after both preceding releases. A client reading either to record which
  version produced a result recorded a wrong answer. The README release badge, the project-status
  line, and the supported-versions table in [SECURITY.md](SECURITY.md) were stale for the same
  reason.
- README and DEVELOPMENT.md still described four applications and four Quickstart image targets.
  Both have been five since 0.1.2.

### Added

- `bun run verify:version` compares every hardcoded product-version occurrence against the root
  `package.json` and fails when they disagree; `bun run version:sync` rewrites them. CI runs the
  check in the Hygiene job. The declared occurrences live in
  `scripts/check-product-version.ts` — a new one belongs in that list, and the script fails
  loudly when a file it knows about changes shape.

  The duplication itself stays: a badge URL, a Zod schema default and an MCP client identity
  cannot import a version at the point they are written. Verifying the copies is the smaller
  mechanism than removing them.

## [0.1.3] — 2026-09-11

Security patch for the upload path introduced in 0.1.2. No contract-package or executable flow
version changed, and no migration runs.

### Security

- **`multer` 2.1.1 → 2.3.0** in Extract, closing five advisories against the multipart upload
  parser, three of them high severity: denial of service via crafted multipart field names, via
  an oversized array index in a field name, and via deeply nested field names, plus a file-size
  limit bypass through an async `fileFilter` race and incomplete cleanup on abort. Extract
  reaches this parser from four routes — `POST /v1/convert` and `POST /v1/ingest`, plus the
  browser equivalents under `/ui` — whenever the request is `multipart/form-data`, so the fix
  matters for any deployment an untrusted client can reach. The upgrade
  is API-compatible: `multer` 2.3.0 carries the same dependencies, and Extract uses only
  `memoryStorage`, `limits`, `single()` and the documented `LIMIT_*` error codes.

### Changed

- `bun.lock` now records the workspace versions that `package.json` declares. They had drifted
  because Bun only rewrites them when dependency resolution itself changes.

Adds a fifth application and an as-of dimension to retrieval. Read the migration notes: one
collection migration runs automatically, and evidence-pack hashes change for unchanged content.

### Added

- **Extract (`apps/extract`)**, a fifth application: document-to-Markdown extraction for PDF,
  DOCX, XLSX, PNG, JPEG and GIF. Every format funnels through one PDF page loop, so page
  numbers, page images and text offsets agree across formats. Each page is rendered and sent to
  a vision model together with its text layer, which stays authoritative for wording while the
  rendered page is authoritative for structure. Sync, SSE and async-callback response modes are
  selected by request header. It is the one application needing external binaries
  (`poppler-utils`, LibreOffice), which is why it is a separate service rather than part of
  Search. See [`apps/extract/README.md`](apps/extract/README.md).
- **`@atf/extract-contract` 1.0.0**, the canonical extracted-document grammar shared by Extract
  and Search: `## Seite N` page markers, `<figure>` entries with normalised geometry, per-page
  `<summary>` blocks, merged-cell HTML tables, figure asset identity, and the ingest headers.
- **`POST /ingest-file` in Search**: binary document ingest by proxying to Extract and then
  running the unchanged ingest path. Mounted only when `CONVERTER_URL` is set, otherwise 404.
  It forwards Markdown only, so figure descriptions are indexed but the images are not
  (`X-Figure-Assets: not-stored`). Use Extract's own `POST /v1/ingest` when crops should be
  viewable. New Search variables: `CONVERTER_URL`, `CONVERTER_TOKEN`, `CONVERTER_TIMEOUT_MS`
  (default 15 min, because conversion runs one vision call per page), `CONVERTER_UPLOAD_LIMIT`.
- **Temporal document validity in Search.** Retrieval already distinguished current from
  historical versions; this adds the *business* validity dimension, so a query can ask what a
  document set said at a given instant rather than only what is newest. `X-Valid-From` on
  ingest records when a revision takes effect, `X-Valid-At` on search and `valid_at` on
  `POST /evaluations/retrieval` and the MCP read tools select as of an instant, and every hit
  now carries `valid_from` (nullable) and `effective_valid_from`
  (`COALESCE(valid_from, created)`). Timestamps without a UTC offset are rejected rather than
  guessed. Omitting the headers leaves the previous behaviour unchanged.
- `ragProfiles` sources in Runtime accept `includeAllVersions` and `validAt`, forwarded to
  Search as `include_all_versions` and `valid_at`, so a flow can pin retrieval to an instant.
- `ingest_document` over MCP accepts `version_mode` and `valid_from`. The default stays
  `replace`, which is what the tool did implicitly before.

### Changed

- **Evidence-pack `snapshotHash` and `evidenceId` change for identical content.** The hash input
  is now a canonical JSON object and includes `versionSource`, `validFrom` and
  `effectiveValidFrom`; `retrieve_evidence` additionally binds `effective_valid_from`. The
  schema version stays `v2` because the pack's *shape* is unchanged, so a stored hash compared
  against a freshly computed one will mismatch without any schema signal. Recompute persisted
  evidence identifiers, or keep them alongside the pack that produced them.
- `temporalScope` in the evidence pack gained `as_of_latest` and `as_of_all`, and a `validAt`
  field. Existing values keep their meaning; an exhaustive consumer-side switch needs the two
  new arms.
- **`is_latest` is now decided per ingest revision rather than per row.** Every chunk of one
  revision shares a private version-group id (`metadata._atf_version_group`), so an as-of
  selection can no longer return half a version. For multi-chunk documents ingested in version
  mode this changes which rows the default search returns — previously one row per `base_ref`
  won. The group id is written into `metadata` and is therefore visible to anything reading
  metadata raw.
- The Quickstart image inventory now covers all five image targets. The Extract image installs
  Debian packages (`poppler-utils`, LibreOffice, metric-compatible fonts) whose licenses are not
  covered by the generated JavaScript inventories; see [DEPLOYMENT.md](DEPLOYMENT.md).
- Artifact size budgets now cover `apps/search/dist` and `apps/extract/dist`, so a bundle
  regression in either service fails CI instead of going unnoticed.

### Fixed

- `deploy/examples/.env.example` was missing `ATF_EXTRACT_PORT`, which `compose.yaml` reads.

### Migration notes

- **Collection schema 10 → 11**, applied automatically at Search startup under the existing
  advisory lock. It adds a nullable `valid_from TIMESTAMPTZ` column and one index, both with
  `IF NOT EXISTS`: no rename, no type change, no backfill, no `NOT NULL`. Existing rows stay
  valid and their effective validity is their `created` timestamp. Rolling back to 0.1.1 is
  data-safe — the older binary ignores the column — but the stored `schema_version` remains 11.
- Rebuilding the index is not blocking, but on a large collection it is not instant either.
  Plan the first start after the upgrade accordingly.
- If you persist `evidencePackHash`, `snapshotHash` or `evidenceId`, recompute them; see the
  first entry under Changed.

## [0.1.1] — 2026-09-02

Public-release hardening patch. No contract-package or executable flow version changed.

### Added

- Contributor Copyright Assignment Agreement 1.0 with individual and corporate execution,
  assignment/exclusive-rights fallback, commercial and alternative-licensing rights, patent
  terms, and a versioned acceptance trailer.
- A synthetic, non-auto-loaded compliance-policy example with documented activation and
  fail-open loading boundary.
- Canonical CC0-1.0 license text for the narrowly reviewed `type-fest@0.13.1` expression.

### Changed

- Contribution templates, CI trailer validation, copyright, licensing, and ownership
  documentation now use one assignment model in favor of Abillify Technology GmbH.
- Control documentation now matches the implementation: relative same-origin Runtime URLs are
  the production default, `NEXT_PUBLIC_BACKEND_URL` is an explicit build-time override, and CSP
  modes are `legacy` or report-only rather than enforcement.
- Architecture, security, compliance, PII, RLS, Gate-driver, image-generation, Quickstart, and
  Playwright claims now state their configuration, deployment, and verification boundaries.
- Product metadata for Runtime, Control, Search, Gate, system integration, Search OpenAPI, and
  Gate MCP identities is `0.1.1`.

### Fixed

- Third-party licensing is now an exact fail-closed SPDX-expression allowlist that requires
  complete text for every AND/OR branch; the Apache-2.0 copy is canonical rather than
  vendor-specific.
- SPDX header application preserves additional third-party copyright holders.
- Generated configuration documentation records Search `NODE_ENV` correctly and no longer
  emits a phantom `T`; volatile hand-maintained variable counts were removed.
- Tenant RLS documentation now uses the implemented, reviewable `rls-status` and
  `rls-setup --confirm` CLI instead of a nonexistent SQL file.

## [0.1.0] — 2026-09-01

Initial public release of the Aiperator Trust Fabric monorepo: Runtime, Control, Search, and
Gate, with the versioned contract packages that connect them.

The four applications, their request path, and the design rules are described in
[ARCHITECTURE.md](ARCHITECTURE.md). The capability surface is enumerated in
[docs/CAPABILITIES.md](docs/CAPABILITIES.md), and every environment variable in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md). Architecture decisions carried over from the
predecessor repositories are in [docs/adr/](docs/adr/); a version statement inside a migrated
ADR describes that document's point in time, not this release.

### What `0.1.0` commits to

ATF is pre-1.0, and this release does not promise a stable public surface. Concretely:

- The **contract packages** under `packages/` are the surfaces that already carry a stability
  promise, because a break there breaks a running deployment across services. They version
  independently of this file.
- Environment variables, flow YAML fields, and HTTP routes **may change without a major bump**
  before 1.0. Breaking changes will be listed here with the migration.
- Two names are already deprecated aliases kept for compatibility and will be removed in a
  future major: the `X-Mandant-Id` request header (use `X-Tenant-Id`) and the implicit
  `clientClientdocs` default for `ragProfiles.authoritativeTagField` (declare the field
  explicitly).
- A small number of environment variables are read outside Runtime's startup schema and are
  marked **read directly — not validated at startup** in
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Migrating them into the schema is tracked
  work, not settled design.

See [SECURITY.md](SECURITY.md) for which versions receive security fixes.

[Unreleased]: https://github.com/Abillify/atf/compare/v0.23.0...HEAD
[0.23.0]: https://github.com/Abillify/atf/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/Abillify/atf/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Abillify/atf/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/Abillify/atf/compare/v0.19.3...v0.20.0
[0.19.3]: https://github.com/Abillify/atf/compare/v0.19.2...v0.19.3
[0.19.2]: https://github.com/Abillify/atf/compare/v0.19.0...v0.19.2
[0.19.0]: https://github.com/Abillify/atf/compare/v0.18.1...v0.19.0
[0.18.1]: https://github.com/abillify/atf/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/abillify/atf/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/abillify/atf/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/abillify/atf/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/abillify/atf/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/abillify/atf/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/abillify/atf/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/abillify/atf/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/abillify/atf/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/abillify/atf/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/abillify/atf/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/abillify/atf/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/abillify/atf/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/abillify/atf/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/abillify/atf/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/abillify/atf/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/abillify/atf/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/abillify/atf/compare/v0.3.0...v0.9.1
[0.9.0]: https://github.com/abillify/atf/compare/v0.3.0...v0.9.0
[0.8.0]: https://github.com/abillify/atf/compare/v0.3.0...v0.8.0
[0.7.2]: https://github.com/abillify/atf/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/abillify/atf/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/abillify/atf/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/abillify/atf/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/abillify/atf/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/abillify/atf/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/abillify/atf/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/abillify/atf/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/abillify/atf/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/abillify/atf/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/abillify/atf/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/abillify/atf/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/abillify/atf/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/abillify/atf/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/abillify/atf/releases/tag/v0.1.0
