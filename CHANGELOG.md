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

Nothing yet.

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

[Unreleased]: https://github.com/abillify/atf/compare/v0.5.0...HEAD
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
