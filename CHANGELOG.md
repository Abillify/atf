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

## [0.1.2] — 2026-09-11

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

[Unreleased]: https://github.com/abillify/atf/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/abillify/atf/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/abillify/atf/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/abillify/atf/releases/tag/v0.1.0
