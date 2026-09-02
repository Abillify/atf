# Gate capability record

This historical change record was migrated from `mcpgate`, Gate's predecessor
repository, and describes the capabilities Gate carries into this monorepo.
Current source paths use the monorepo layout under `apps/gate`.

Two things to read with care:

- **Names.** "mcpgate" is the predecessor's name for what is now `apps/gate`
  (Gate). The `MCPGATE_` environment prefix and the `MCPGATE_CONFIG_DIR` YAML
  layout kept that spelling for compatibility, so the prefix is current even
  though the product name is not.
- **Pipeline statements are not current.** Everything this document said about CI
  described the predecessor's GitLab pipeline. This repository uses GitHub
  Actions with a different set of gates; see `.github/workflows/ci.yml` and
  [../CONTRIBUTING.md](../CONTRIBUTING.md) for what actually runs. The
  corrections are noted inline below.

For the capability surface as it stands today, prefer
[CAPABILITIES.md](CAPABILITIES.md) and [CONFIGURATION.md](CONFIGURATION.md) over
this file.

## Capabilities

These are present on the pre-1.0 development line. They do not constitute a
stable `1.0.0` release until package metadata, release notes, artifacts, and
compatibility commitments are updated together.

### Added

- **MCP-native tool interface**: every tool now advertises `outputSchema`
  and `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/
  `openWorldHint`) in `tools/list`, and returns `structuredContent` alongside
  `content` in `tools/call`. Annotations default to sensible values derived
  from each tool's `access: read|write` field when not set explicitly, and
  can always be overridden per tool. Database tools get a generated
  `outputSchema` (`rowCount`/`truncated`/`rows`/`nextCursor`/`page`) unless one is
  configured.
- **Per-tool `requiredScopes`**: tools can require the caller's token to
  carry specific scopes, enforced before execution (in addition to any
  auth-level `requiredScopes`). This is now a real authorization boundary,
  distinct from the router's read/write split (which remains organisational
  only).
- **Field-level redaction** (`redact` on database tools): mask, hash, or omit
  columns in the returned rows, optionally gated by an existing `condition`,
  so the same query can serve different callers differently without
  duplicating tools.
- **Cursor-based pagination** (`pagination.enabled` on database tools): an
  opt-in alternative to plain `rowLimit` truncation. Advertises `cursor` and
  `pageSize` input parameters, enforces the configurable `maxPageSize`, and
  returns `structuredContent.nextCursor` plus explicit `page` metadata.
  Stateless 2026 `tools/list`, `resources/list`, `prompts/list`,
  `io.modelcontextprotocol/skills/list`, and `io.modelcontextprotocol/apps/list`
  support the same `cursor`/`pageSize` request pattern and return `nextCursor`
  while another page exists.
- **Response size caps** (`maxResponseBytes` on `http` and `mcp` tools):
  aborts reading a backend/downstream response once it exceeds a configured
  byte limit, instead of buffering an unbounded body into memory.
- **Composite tools v2**: steps support a `condition` (skip a step when a
  token resolves falsy), a `parallelGroup` (consecutive steps sharing a group
  run concurrently), and per-step `timeoutMs` / `retries` / `retryDelayMs`.
- **Per-identity rate limiting** (`server.rateLimit.perIdentity`): an
  additional limit keyed on the caller's auth subject rather than IP, useful
  when many callers share one egress IP in a multi-tenant deployment.
  In-memory by default; optionally backed by Redis for multi-instance
  deployments (`store.type: redis`, reusing the same optional `redis`
  package as the existing IP-based limiter).
- **Optional cluster-wide monitoring** (`monitoring.cluster.redisUrl`): a
  Redis pub/sub bridge that shares `MonitorBus` events (dashboard/SSE
  feed/audit log) across instances. Does **not** migrate MCP sessions —
  sticky routing per instance remains required for horizontal scaling of the
  MCP transports themselves; this only keeps observability cluster-wide.
- **Optional OpenTelemetry tracing** (`tracing.enabled`): spans around MCP
  tool calls, database queries, and outbound HTTP/MCP-proxy calls. A complete
  no-op with zero overhead unless enabled AND the optional
  `@opentelemetry/*` packages are present; falls back gracefully (with a
  warning) otherwise. No hard dependency added to the default install.

### Changed

- Dependencies are pinned to exact versions for a reproducible, auditable supply chain. `redis` is a normal dependency in the current manifest. Features that dynamically import packages not declared by `apps/gate/package.json` must not be enabled until the deployment explicitly supplies and validates those packages; the changelog does not imply their installation.

### Corrected: CI claims

The predecessor's entry here described a coverage gate (`MIN_COVERAGE_PCT`), a
blocking Trivy image scan (`scan:image`, previously `allow_failure: true`), and a
smoke load-test stage on `main` and tags.

**None of that exists in this repository.** There is no Trivy step, no
`scan:image` script in any workspace manifest, no load-test stage, and no
coverage gate for Gate. `allow_failure` is GitLab syntax and appears nowhere in
the GitHub Actions workflow. The gates this repository actually enforces are the
release guard, SPDX headers, supply-chain freshness, the configuration reference,
a lint baseline ratchet, typecheck, tests, contract tests, build, and a Compose
smoke run of the quickstart — see `.github/workflows/ci.yml`.

### Notes on scope

Gate intentionally does not grow into orchestration territory — that is Runtime's
job: no multi-step LLM agents, no RAG or vector store, no multi-provider LLM
routing beyond the existing optional single-hop router. The capabilities above
stay on the "tool gateway" side of that line: identity, authorization, data
shaping, and transport-level resilience for the tools Gate exposes.

---

## Router result interpretation

Gate's optional `router.interpretResults` pass was introduced as a second model call after a
successful routed tool invocation. It converts the structured result to prose while preserving
the raw result in metadata. The setting defaults to `false`; interpretation failures fall back
to the raw result and do not turn a successful tool call into a failure.

The pass is implemented for the OpenAI-compatible and Bedrock clients and applies to both read
and write router paths. It adds latency and token cost, so machine-to-machine consumers should
normally keep it disabled. Current configuration and validation guidance live in
[router-result-interpretation.md](router-result-interpretation.md).

---

## Related records

Earlier predecessor history is not part of this repository.
