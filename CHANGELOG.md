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

## [0.26.0] - 2026-11-12

### Security

- **Runtime** (PII vault): a vault token id could contain a run of digits that
  the phone-number detector recognises, so a second detection pass over already
  tokenized text cut the placeholder in half and left it unresolvable. Token ids
  with four or more consecutive digits are now redrawn.
- **Runtime** (approvals): a single `GET` on the in-chat approval link used to
  resolve the approval, so a link preview, prefetcher or security scanner in a
  chat or mail client could approve a consequential tool call without anyone
  clicking (`rel="nofollow"` does not prevent such a fetch). Approval links are
  now two-step by default: the first click renders a script-free confirmation
  page, and only a second click carrying a signed `confirm` value — an HMAC over
  the approval id, the decision and the link expiry, valid 120 seconds —
  resolves the request. This applies to every `GET` caller, an authenticated
  operator included; the Control dashboard keeps its one-step `POST` route. It
  also applies without a configured link secret (the confirmation is then signed
  with a random per-process key), and a link to an approval that is already
  resolved shows the outcome instead of a question. Set
  `APPROVAL_LINK_CONFIRM=false` to restore the one-click links.
- **Runtime** (approvals): the capability token carried by the in-chat approval
  widget and decision links was minted with a fixed one-hour expiry, so it outlived
  a short approval by up to an hour while remaining a live credential in chat
  history, access logs and the widget's `Referer`. It now expires with the approval
  it authorizes — the gate's own `APPROVAL_TIMEOUT_MS`, or a compliance-policy
  `approvalRules[].timeoutMs` override (ADR-0009) — plus a 60 second grace. Because
  a chat keeps the widget open past that point, an expired-but-genuine token still
  renders the approval's final state (no buttons, no request details) instead of a
  401; deciding continues to require a valid token.

### Added

- **Runtime** (trust-proxy mode, experimental): ATF can sit in front of AI clients
  that already exist (ADR 0038, [docs/TRUST-PROXY.md](docs/TRUST-PROXY.md)).
  `PROXY_MODELS` maps model names a client sends (`claude-*`, `gpt-4.1`) to a
  provider instance and model; such a request runs a built-in pass-through flow
  (`__proxy__.<n>`) under every engine control — guardrails, PII vault, budgets,
  admission, receipts — with the client's tools passed through. Real flows always
  win over a mapping; exact names are listed in `GET /v1/models`.
  `POST /v1/messages` serves the Anthropic Messages API (JSON and SSE) by
  translating onto the unchanged chat pipeline, accepts `x-api-key` on that route,
  and refuses fields it cannot honour (`thinking`, `cache_control`, `top_k`,
  `metadata`, server tools, …) with a 400 that names the field. New preset
  `ATF_PRESET=trust-proxy`.
- **Gate**: imported MCP tools (`mcpServers`) keep the downstream server's
  annotations, can require scopes (`mcpServers[].requiredScopes`, per tool
  `overrides[].requiredScopes`), and a downstream MCP server inside the network
  can be reached with `mcpServers[].server.allowPrivateAddress` (RFC 1918 /
  unique-local for that exact host; loopback and metadata stay refused). New
  blueprint `deploy/blueprints/gate-mcp-proxy/`: an existing MCP server behind the
  Gate for agent clients.
- **Runtime** (PII vault): `PII_VAULT_SCOPE=messages+context` also tokenizes tool
  results and retrieved chunks before they enter the model context, after the
  injection scan and citation registration (ADR 0036, step 4). Citations streamed
  to the caller keep the real text; a detector failure under
  `PII_DETECTOR_FAIL_MODE=closed` fails the tool call or retrieval instead of
  sending plaintext. Default `messages`, unchanged.
- **Runtime** (decision receipts): with `DATABASE_URL` the transparency log is
  shared by all replicas (ADR 0039). Appends run under an advisory lock, leaf
  order comes from `receipt_log`, and every replica proves against the same tree,
  so the `REPLICAS > 1` warning for receipts is gone. Formats are unchanged;
  receipts and proofs issued before stay valid with `atf-verify`. Upgrade
  receipt-issuing replicas together, and note that receipt issuance now depends on
  the database being reachable.
- **Runtime** (PII vault): placeholders now carry the type of the value they
  replace (`[[PII:EMAIL:…]]`), and a value that occurs several times in one
  execution keeps one placeholder, so the model can tell an address from a name
  and two mentions of one person from two people (ADR 0036, steps 1–2). Both are
  on by default and switch off with `PII_VAULT_TYPED_TOKENS=false` and
  `PII_VAULT_CONSISTENT_TOKENS=false`; the untyped form is still restored in
  responses. Reuse never crosses executions, and the in-process value map is
  cleared with the execution.
- **Runtime** (PII vault): `PII_VAULT_DETOKENIZE_TOOLS` lists tools (same
  patterns as `APPROVAL_REQUIRE_TOOLS`) whose arguments get the real values back
  immediately before the call — after egress DLP, taint and approval checks —
  so a lookup by e-mail address works with the vault on (ADR 0036, step 3).
  Approval prompts, audit records, debug traces, the tool journal and receipts
  keep the placeholder form. The list is empty by default; every listed tool and
  its backend receive personal data. New counter
  `aiperator_pii_vault_tool_detokenized_total{tool}`.
- **Runtime**: the audit trail can be pushed to an external SIEM. With
  `AUDIT_FORWARD_URL` (HTTPS webhook, `AUDIT_FORWARD_TOKEN` as bearer,
  `AUDIT_FORWARD_BATCH_SIZE`, `AUDIT_FORWARD_INTERVAL_MS`) a background loop
  ships `audit_log` entries as NDJSON batches through the Egress_Guard. The
  send position persists in the new `audit_forward_state` table (migration 53)
  and advances only after the target answered HTTP 2xx, so delivery is
  at-least-once with no gap across restarts; with several replicas exactly one
  sends (advisory lock `atf:audit_forward`). A rejected or unreachable target
  becomes retrying backoff and the `aiperator_audit_forward_lag` gauge instead
  of data loss. Forwarding needs the durable (Postgres) audit log; private
  addresses stay blocked without `EGRESS_ALLOW_PRIVATE_HOSTS`. A request is
  abandoned after 30 seconds, failures are counted in
  `aiperator_audit_forward_failures_total{reason}`, and only the operator
  database role may write the position.
- **Runtime, Gate, Search, Extract, Control**: every service secret can be
  supplied through a file instead of the environment variable itself (ADR 0040).
  Setting `<NAME>_FILE` to the path of a mounted secret — a Kubernetes projected
  volume, a Swarm secret under `/run/secrets/` — replaces `<NAME>`; the value is
  read once at startup, one trailing line ending is stripped, and an unreadable
  or empty file fails startup with the path in the message rather than falling
  back to an empty credential. Setting both `<NAME>` and `<NAME>_FILE` is a
  startup error naming both. The Helm chart needs no new keys: pass the mount
  through each service's `extraEnv`, `extraVolumes` and the new
  `extraVolumeMounts` pass-through. Rotation remains a restart, so the existing
  runbook applies unchanged. The file form also covers the connection URLs that
  carry a password (`DATABASE_URL`, `DATABASE_OPERATOR_URL`, `REDIS_URL`,
  `POSTGRES_URL`, `EXTRACT_DATABASE_URL`, `RATE_LIMIT_REDIS_URL`,
  `MCPGATE_TRANSACTION_REDIS_URL`), `AUDIT_ANCHOR_SECRET`, `API_KEY_PEPPER`,
  `OPERATOR_TOKENS` and `STATS_QUERY_PEPPER`, and in the Gate every `${VAR}`
  reference in the YAML configuration and every `clientSecretEnv`, so an
  operator-named database password can be mounted as well.
- **Control**: the dashboard opens on an overview page. `/` and the brand link
  now lead to `/overview`, which aggregates seven read-only tiles — readiness,
  open approvals, governance posture, flow health, providers, MCP servers and
  usage — each read from an existing Runtime endpoint (no new backend route) and
  each linking to the page that owns it. Every tile degrades alone: a slow
  endpoint shows a skeleton, an unauthorized one says so, and a service that was
  never deployed — `/mcp/servers`, the posture report — renders an empty state
  naming that cause instead of an error, because an optional service being absent
  is not an outage. The overview is the first group in the sidebar, the ⌘K
  palette and the breadcrumbs, and every string ships in both catalogues.
- **Runtime, Control**: a services page for operator-facing service UIs. The
  Runtime accepts a `SERVICE_LINKS` JSON array (`name`, `kind` of
  search/extract/gate/other, absolute `url`) and serves it — alongside the MCP
  servers and their live connection status, without headers or tokens — on
  `GET /monitoring/services` behind `monitoring:read`. A link with an active
  scheme (`javascript:`, `data:`) or with credentials in the URL is rejected at
  startup, and `APP_ENV=production` additionally requires `https://`. Control renders both in a new `/services`
  page: each link opens in a new tab with `rel="noopener noreferrer"` after a
  second client-side scheme check, and each MCP server shows connected or
  unreachable.

- **Docs**: `docs/BENCHMARKS.md` publishes the measured evaluation numbers with
  their raw report files, committed under `docs/benchmarks/` in dated snapshot
  directories. Retrieval (eight configurations of the golden set and the German
  variant set, bge-m3 on CPU), the gate margins of the three threshold files, and
  the two scorer self-checks are each reported next to the file they were read
  from, with the CI run that produced them. What was never measured is listed as
  unmeasured instead of estimated: extraction quality on real documents,
  table-cell and BPMN metrics, groundedness of real model answers, abstention
  with a score gate, and any throughput or capacity figure. The reranker's
  per-query cost is reported in full — about 15 s p50 on a shared CPU runner,
  stable across three runs — together with the open question of why an older
  configuration measured three orders of magnitude faster.

- **Docs**: `docs/compliance/` maps ATF controls onto four frameworks an operator is
  likely to be asked about — ISO/IEC 42001, NIS2, DORA and BSI C5 — in the same shape
  for each: the topic, the ATF control that serves it, the settings that make it
  binding, and the endpoint, artefact or metric to hand an assessor. Every row links
  the control to the section of `docs/CAPABILITIES.md` that documents it, so the middle
  column is checkable rather than assertive. Clause and article references are
  deliberately `TODO(human)` throughout: the mapping is a draft, not legal advice, and
  the standard texts are not reproduced here. Management-system duties a product cannot
  own (scope statements, training, notification to an authority) are recorded as not
  covered, which is where an operator's own documentation starts.

- **Docs**: `docs/FLOW-COOKBOOK.md` is the pattern half of the flow documentation — twelve
  recipes (classifier routing, model pools and sticky conversations, cheap-to-strong cascade,
  RAG with a runtime source check, bounded tool loops, sub-flows and prompt files, variables and
  calculations, parallel fan-out, an approval-guarded write, image inspection, small local model
  switches, node failure policy), each stating the failure mode it prevents and what silently
  does nothing when its precondition is missing. Every excerpt is taken from a complete flow
  under `deploy/examples/flows/cookbook/`, all twelve validate (`12 valid, 0 invalid,
  0 warning(s)`) and are wired into the CI flow step. The directory is deliberately invisible to
  a running stack — the flow collector does not recurse — so patterns can be validated without
  twelve more entries in `GET /v1/models`, and it carries its own `model-shortcuts.yaml` so a
  recipe never depends on a shortcut the examples above happen to define.
- **Docs**: `docs/tutorials/first-assistant.md` builds one assistant end to end on the
  quickstart — a document ingested, retrieved and cited, a tool call parked until a
  named person approves it, and the signed receipt verified offline — and names the
  boundaries honestly: the mock proves the governance path, not answer quality. Every
  command on the page was executed against the stack and the output shown is that run's.
  It comes with `deploy/examples/compose.rag.yaml`, a two-line overlay that switches
  retrieval on (without it a `retrieval` node is a silent no-op), and
  `deploy/examples/flows/08-first-assistant.yaml`, the retrieval → answer →
  approval-guarded tool flow the tutorial reads line by line.
- **Deploy** (`deploy/examples`): the quickstart can run on the published images
  instead of building them. `compose.images.yaml` is an overlay that `!reset`s
  every `build:` section and points each service at
  `ghcr.io/abillify/atf-<service>:${ATF_VERSION}`, so both paths share the same
  service definitions, flow files, mock model and health checks — and editing a
  flow still hot-reloads, because that is a Runtime property rather than a
  dev-server one. The released Control bakes no backend URL into its bundle and
  calls relative paths on its own origin, so the overlay also adds a
  digest-pinned Caddy router that puts the UI and the Runtime behind one origin
  the way the production deployments do and leaves the Control itself
  unpublished. `ATF_VERSION` in `.env.example` is a new `verify:version`
  occurrence, which keeps a checkout from pulling images for a different release
  than the code it is reading.
- **Deploy** (`deploy/examples`): the quickstart now demonstrates governed tool
  use rather than describing it. Gate arrives with two tools over a preloaded
  demo table — `gate/ticket_lookup` (read) and `gate/ticket_create` (write) —
  registered through the new `flows/mcp.yaml`, and the model mock answers the
  first turn with a real tool call instead of prose only. The tools read the
  caller's name from the token (`:ctx.username`), never from the model, so
  changing the prompt cannot widen the query. `flows/04-tool-use-with-approval.yaml`
  shows both shapes side by side: a lookup the model may take by itself inside an
  `llm` node, and the write declared as a `tool` node, which is the shape
  `APPROVAL_REQUIRE_TOOLS` binds. Because Runtime consults that gate inside
  authorisation, the runtime service runs with `AUTHZ_ENABLED=true` and no policy
  file behind it — every flow is still admitted, only the approval rule pauses a
  call — and `APPROVAL_TIMEOUT_MS` is raised, since the 30 second default expires
  before a person has read the request in Control. A denied call writes nothing,
  and a timeout rejects. `README.md` walks the round trip through
  `GET /monitoring/approvals` and the widget, and names the limit plainly: every
  caller of this stack presents the same static token, so everyone here is one
  identity until `AUTHN_MODE=oidc` replaces it.
- **Deploy** (`deploy/examples`): retrieval now answers and cites out of the box.
  A one-shot `seed` service posts the new `demo/handbook.md` — invented
  field-service policy for an invented company — into Search's `handbook`
  collection once Search is healthy, and the Runtime starts only after it, so the
  retrieval flow has a document to find on its very first request. The seed is
  idempotent: re-posting the same file replaces the document rather than
  duplicating it. Reaching Search was the missing piece — a `ragProfiles` plan
  compiles into `vectorsearch/search` tool calls, so `flows/mcp.yaml` registers
  Search's own MCP endpoint under exactly that name and
  `EGRESS_ALLOW_PRIVATE_HOSTS` names `search` beside the model mock and the Gate.
  The mock model answers a grounded prompt with one sentence copied out of the
  seeded document, cited as `[1]`, which shows the citation path without a real
  model and nothing beyond it: the passage is invented and the embedding is the
  three-dimensional test vector, so the scores still say nothing about relevance.
  `README.md` walks the request, and the Quickstart stack job in CI fails if the
  answer stops citing the seeded document.
- **Deploy** (`deploy/examples`): `tour.sh` shows the three claims ATF's pitch
  rests on in one five minute run against the quickstart, and prints the evidence
  instead of asserting it. It reads `GET /monitoring/posture` first and refuses to
  continue unless `pii_vault`, `approval_gate` and `receipts` are `ok`, then (1)
  sends a message containing an e-mail address and an IBAN to the new
  `flows/07-model-echo.yaml` — whose `echo` model in `model-mock.py` replies with
  the messages it was handed — and shows the sealed Debug_Trace holding
  `[[PII:…]]` where the address was while the caller's answer holds the cleartext
  again; (2) parks one `gate/ticket_create` call and approves it, then parks a
  second and waits, so the same run contains both a decision and an unanswered
  request recorded as `approved: false, timedOut: true`; (3) fetches the
  execution's receipt and JWKS and runs the shipped `scripts/atf-verify.ts` twice,
  expecting exit 0 on the genuine receipt and exit 1 on a copy with one byte of
  the COSE payload flipped — tampering with `cose_base64` rather than the display
  `payload`, because the verifier reads the signed bytes. Exit codes are 0 for
  every claim shown, 1 for a step that did not behave as documented and 2 for a
  wrong invocation or an unreachable stack. `TOUR.md` explains what each step
  proves and what the stack deliberately does not show. Supporting it: the stack
  now enables `PII_VAULT_ENABLED` and `DECISION_RECEIPTS_ENABLED`, and a one-shot
  `receipt-key` service writes a throwaway Ed25519 seed into a volume on first
  start — unprotected, never rotated, deleted by `down --volumes`, which is why
  the docs name it a demo key and point at the rotation runbook instead of
  imitating a production key source. `ATF_APPROVAL_TIMEOUT_MS` in `.env.example`
  lets a demonstration shorten the ten minute default without editing the
  compose file, and the CI flow-validation step now passes the `quickstart`
  provider instance that `07-model-echo.yaml` is the first example flow to name.
  The Quickstart stack job runs the tour itself: documentation that executes is
  gated like documentation that does not, so a vault, approval or receipt
  regression fails CI rather than a demo.
- **Docs** (ADRs 0036–0044): nine architecture decisions, all `Accepted`.
  Implemented: the PII vault beyond the model boundary (0036), trust-proxy mode
  (0038), the shared receipt transparency log (0039) and secrets from files
  (0040, layer 1). Decided, with an implementation plan in the record: the
  knowledge base in Control through a read-only Runtime proxy with a
  `knowledge:read` permission and `purpose: "operator-read"` transaction tokens
  (0037); external key management through a `KeyProvider` seam, evidence keys
  first (0040, layer 2); a channel interface extracted from Rocket.Chat with
  generalised channel tables, then Slack, then Teams (0041); OIDC claims for
  entitlements plus a deprovisioning endpoint instead of a SCIM server (0042);
  flows as A2A agents over JSON-RPC, checked against A2A 1.0.0, with flow skills
  only on the authenticated extended card (0043); and MCP elicitation as an
  optional surface for Gate approvals that never bypasses separation of duties
  (0044).
- **Docs** (`ROADMAP.md`, `SUPPORT.md`, `GOVERNANCE.md`): a reader who decides
  whether to adopt ATF could see what it does today but not where it is going,
  who answers questions, or how a decision gets made. `ROADMAP.md` states the
  direction with each item marked shipped, in progress, proposed or explicitly
  out of scope, and names what is *not* planned so an evaluation does not have to
  ask; `SUPPORT.md` says where to ask for help and what response a community
  issue, a bug and a security report can expect; `GOVERNANCE.md` records who
  maintains the project, how a change is accepted and how conflicts are resolved.
  All three are linked from `README.md` and `docs/README.md` next to the existing
  governance documents.
- **Deploy** (`deploy/blueprints`): three worked configurations show how the
  example flows and the reference configurations fit together for a real
  deployment, which neither covers because both stay deliberately generic.
  `research-assistant/` is a multi-stage flow — a planner narrows a question, a
  tool loop researches it, a verifier rejects unsourced claims, an answer stage
  writes the reply — with the prompts as separate files and a harness bounded by
  `maxIterations`, `maxTimeMs` and `maxStagnantIterations`; `gate-sql-profile/` is
  a Gate configuration for a read-mostly SQL profile, where the one write tool is
  the only one behind an approval card that quotes the arguments rather than a
  description of them, with the rate limit, host allowlist and proxy settings a
  public endpoint needs; `dms-mirror/` is an Outpost that mirrors a document
  store into a collection and deletes nothing without an operator's confirmation.
  Every value was verified against a loader in this checkout, not from
  documentation: the flow validates with and without a model provider configured,
  the Gate configuration was run through `scripts/atf-doctor.ts`, and the Outpost
  file through `loadConfig()`. The measured doctor output — clean in development,
  refused in production until `auth.mode`, `tenantIsolation` and the host
  allowlist are set — is printed in the blueprint, because a configuration that
  admits what it is not ready for is more useful than one that looks finished.
  Each README names the field to change, the secret to supply, and the check to
  run before a rollout; CI validates the blueprint flows alongside the examples.

### Fixed

- **Tooling**: the route reference and the OpenAPI catalog only recognised a
  router created inline in `app.route(...)`; a router held in a variable lost its
  routes from `ARCHITECTURE.md` and `docs/openapi/runtime.json`.
- **Control** (accessibility): status labels failed WCAG AA contrast in the
  light theme. The token DEFAULTs for `success`, `info`, `subflow` and
  `accent-2` sat at 4.0–4.3:1 against a card, and badge labels compounded it —
  their surface was a 20 % wash of the theme-*fixed* `*-solid`, which pulled
  `text-success` down to 3.62:1 — while dark `--copilot` reached only 4.06:1 on
  its own `--copilot-soft`. Badge labels and the boundary-panel role badges now
  use the documented `*-soft` surface, and the four light DEFAULTs plus dark
  `--copilot` moved to the lightness that clears 4.5:1 on both the card and
  their own soft tint; the visible hue is unchanged. The promise in
  `docs/UI-STYLE-GUIDE.md` that the tokens guarantee body-text contrast is now
  enforced: `apps/control/src/__tests__/token-contrast.test.ts` recomputes
  every family against both themes from `globals.css` itself, and
  `e2e/a11y-sweep.spec.ts` is clean on all 30 routes (it had flagged the
  overview and, through the shared badge, the posture page).

- **Runtime** (tests): the check that validates every example flow validated
  every YAML file in `deploy/examples/flows` — including the reserved non-flow
  config a flows directory may legitimately hold, which is where the MCP server
  list lives. It now skips exactly the base names the flow loader skips, through
  a new exported `isReservedFlowBase`, so the two cannot drift apart again.

- **Runtime** (approvals): the in-chat approval link
  `GET /monitoring/approvals/:id/decide` accepted a `?by=` query parameter even
  when the caller was an authenticated operator, so the resolved decision and
  the audit entry could carry a freely chosen reviewer name. An authenticated
  identity is now authoritative — `?by=` is ignored and the audit entry records
  the real one in `details.authenticatedAs`. On the open plane (no RBAC) the
  previous precedence is unchanged.

### Changed

- **Runtime, Extract** (internal): three oversized modules are split by topic
  without code changes — `graph/agent-tools.ts` into hooks, citations, client
  tools, media and image inspection; `mcp/wrapper/client.ts` into the service
  contract, error classification and pure helpers; `jobs/job-runner.ts` into its
  config types and page helpers. The original modules re-export everything that
  was public, so imports elsewhere are unchanged.

- **Runtime** (approvals): the approval text rendered into the chat and the pages
  of the in-chat widget are no longer hard-coded German. Both read from one message
  catalogue (`apps/runtime/src/graph/approval-messages.ts`), which ships `en` and
  `de`. **The default language of the in-chat approval message is now English**;
  set `APPROVAL_MESSAGE_LOCALE=de` to keep the German message. The widget inherits
  the setting, so a single approval interaction never mixes languages, and the
  rendered HTML declares the matching `lang`.
- **Docs** (`docs/CAPABILITIES.md`): the capability overview advertised an
  OpenAI-compatible embeddings endpoint that the Runtime does not serve — the
  generated route table in `ARCHITECTURE.md` has never listed `POST
  /v1/embeddings`. Both places that made the claim now name only the endpoints
  that exist and state that embeddings are computed internally for retrieval and
  caches (`EMBEDDING_MODEL`) rather than offered as an API.
- **Docs** (`docs/CAPABILITIES.md`, `ARCHITECTURE.md`): the compliance section
  stated there was "no mandatory-policy mode yet". There is: with
  `COMPLIANCE_POLICY_REQUIRED=true` the Runtime refuses to start without a loaded
  `compliance-policy.yaml` in the production profile (a warning elsewhere) and
  readiness reports `compliance_policy: missing`. The text now says that, and
  states the limit the old sentence was reaching for: the flag gates startup and
  readiness only, so deleting the policy file from a running instance still
  disables the policy until readiness or a restart reports it.
- **Docs** (`docs/OPERATIONS-TCO.md`): the TCO guide told operators that Extract
  sends **every page** to the vision model. On the v2 path the deterministic text
  fast-path (`TEXT_FAST_PATH`, on by default) builds a `text` page's blocks from
  the PDF text layer with no model call, and BPMN, e-mail and chart-free XLSX
  are parsed natively without ever reaching it. §4.1 now describes which pages
  reach the model and which do not, the ingest formula carries a
  `fast_path_share` factor, the existing-controls list names the fast path and
  the native parsers, and the previously unnumbered "Cost levers in the Runtime"
  section is §7 with "Operating effort" following as §8.
- **Runtime** (config): the header comment in `config/profiles.ts` claimed the
  platform exposes ~130 environment variables; the generated reference lists
  several hundred. The comment no longer carries a number that goes stale on
  every release and points at `docs/CONFIGURATION.md` instead.
- **Repo tooling** (`preflight`): `release-preflight.ts` gains `--quick`, which
  runs the fast gates only — `verify:spdx`, `verify:version`, the three
  generated-reference checks, `check:links`, `lint:baseline`, `typecheck`,
  `test` — and skips the build, budgets, contracts, and the release-facing
  tree and secret scans. `bun run preflight` is that mode, and CONTRIBUTING.md
  now opens with it: the checklist asked for 21 commands where CI runs one
  script, so contributors either ran a subset they remembered or paid for the
  full release gate on a docs change. `--skip` works in both modes.
- **Docs** (README, CAPABILITIES): "sandboxed plugins" described more isolation
  than ADR 0006 grants. Plugin isolation is opt-in (`PLUGINS_SANDBOX`, off by
  default, so in-process plugins keep full privileges), it is a Bun Worker
  thread rather than a process or container, and the name allowlist is a
  separate control from the sandbox. Both texts now say what is there and what
  is not, and link the ADR.
- **Runtime** (PII vault): `PostgresPiiVaultStore.put` issued one `INSERT` per
  entry, so a message that tokenized 1 200 spans cost 1 200 sequential queries
  on the request path before the first provider call. Entries now go out as one
  multi-row `INSERT … ON CONFLICT (token) DO NOTHING` per 500 entries — three
  statements for the same message. Column order, the per-entry AAD binding
  `(executionId, token)`, and the durability contract are unchanged: the first
  failing statement stops the loop rather than retrying a down database 1 200
  times, a warning is logged, and the in-memory mirror still resolves every
  entry for the execution.
- **Docs** (CAPABILITIES, ADR-0036): the PII vault section claimed the vault
  keeps PII out of provider calls without saying which paths it covers. A new
  "Boundaries" list states the current reach exactly: inbound message text and
  therefore tool arguments are tokenized, tool results and retrieved content are
  not — a tool return value re-enters the model context as a `role: "tool"`
  message and retrieval chunks come from the index, neither of which references
  the vault. It also records that every occurrence gets its own token, that the
  mapping is cleared in the `finally` of each execution while the value-free
  action summary survives in a bounded ring, and that an unresolvable placeholder
  is left visible rather than dropped. ADR 0036 records the design for
  closing the gap — typed placeholders, one token per value per execution,
  allowlisted detokenization at the tool boundary, and a `PII_VAULT_SCOPE` for
  context — with no implementation behind it yet.
- **Docs** (`CHANGELOG.md`): the file had grown past 5 000 lines, and a release
  section was hard to find in it. Every entry older than `0.19.0` — `0.1.0`
  through `0.18.1`, 34 releases — moved verbatim to
  [`docs/changelog/0.x-archive.md`](docs/changelog/0.x-archive.md), which carries
  its own copy of their compare links; the main file keeps a pointer and remains
  the place current entries and all version links live. No consumer reads the
  archived sections: `.github/workflows/release.yml` extracts only the section of
  the version being released, and the published GitHub release notes are
  immutable, so the move changes no release behaviour. Relative links inside the
  moved text were rewritten for the new location, and the three
  `docs/UPGRADE.md` pointers to archived sections now link the archive directly.

## [0.25.6] - 2026-11-10

### Fixed

- **Search** (`apps/search`): embedding, rerank, sparse and tokenize requests
  sent no `Authorization` header and therefore failed with HTTP 401 against
  backends that require authentication (such as a LiteLLM proxy). The new
  optional configuration `EMBED_API_KEY`, `EMBED_FALLBACK_API_KEY`,
  `RERANK_API_KEY`, `RERANK_FALLBACK_API_KEY`, `SPARSE_API_KEY` and
  `TOKENIZE_API_KEY` pass a bearer token to the respective upstream; when unset
  the behavior is unchanged (no header). `EMBED_API_KEY` is ignored on the
  Bedrock path, where AWS credentials apply.

### Changed

- **Dependencies**: workspace-wide dependency updates across all apps and
  packages — AI SDK packages, `@langchain/*`, TypeScript, testing and
  tooling dependencies — and refreshed SHA pins for the pinned GitHub Actions
  in `ci.yml`, `release.yml` and `outpost-release.yml`.

- **Supply chain**: `@tailwindcss/oxide-wasm32-wasi` 4.3.5 dropped its
  wasm32-only `cpu` marker and now appears in the linux-x64 inventory without
  a shipped license file; a reviewed repository-root reuse rule sources its
  MIT license from `@tailwindcss/oxide`. Notices and SBOM regenerated.

## [0.25.5] - 2026-11-06

### Changed

- **Dependencies**: workspace-wide dependency updates across all apps and
  packages — AI SDK providers (`ai`, `@ai-sdk/*`), AWS SDK clients,
  `@langchain/*`, `@huggingface/transformers`, `jose`, `express-rate-limit`,
  `@babel/parser`, `@types/node`, and the Biome/knip toolchain. Container
  base images (`node:26.13.0-alpine`, refreshed `debian:bookworm-slim` digest)
  and the Tauri `Cargo.lock` were updated accordingly.

## [0.25.4] - 2026-11-05

0.25.3 was not released.

### Fixed

- **Runtime** (media tools): an image generated in an earlier turn could not be
  edited in a later one. Image references (`img-1`, `img-2`, …) live in a
  per-execution registry, while conversation history only carries the published
  `/v1/media/<id>` URL, so the next turn had nothing to resolve and the edit
  tool was never offered a usable target — the model answered with a
  fabricated media URL that looked like a completed edit. History messages are
  now rehydrated: media URLs that still resolve in the media store are turned
  back into image references before the prompt is built, and the reference
  placeholder tells the model which edit tool to call.
- **Runtime** (media tools): `edit_image` accepts the published
  `/v1/media/<id>` URL directly in its `image` argument, so a model quoting the
  URL from history edits the right image even when the reference handle was
  lost. Unknown or expired media still fails closed with `unknown_image`.

## [0.25.2] - 2026-11-01

### Fixed

- **Runtime** (media): `/v1/media/*` responses carried
  `Cross-Origin-Resource-Policy: same-origin` from the global
  `secureHeaders()` middleware, so a browser refused to render a media URL
  embedded as an `<img>` from another origin — an Open WebUI chat answer with
  `![](https://<atf-host>/v1/media/<id>.png)` showed only
  "Bild nicht verfügbar" while the same URL opened fine when navigated to
  directly (CORP does not apply to navigations). A `mediaEmbeddingMiddleware`
  registered before `secureHeaders()` now sets
  `Cross-Origin-Resource-Policy: cross-origin` on `GET /v1/media/*`; the route
  stays auth-exempt by design (capability URLs with unguessable UUIDs and a
  short TTL), and all other routes keep `same-origin`.

## [0.25.1] - 2026-11-01

### Fixed

- **Runtime** (egress): the guard rejected every request body it could not use as
  it stood, so the multipart `FormData` an image edit needs failed with
  `egress transport only accepts buffered request bodies` before a socket was
  opened — `edit_image` could not reach any server at all. `FormData`, `Blob` and
  stream bodies are now serialised through a throwaway `Request`, which also
  supplies the `multipart/form-data; boundary=…` content type a caller cannot know.
  Buffering happens before the socket opens and after the URL policy check, so a
  rejected request still never sends a byte or consumes a one-shot body.

## [0.25.0] - 2026-11-01

### Added

- **Runtime** (media tools): a `mediaTools` entry declares the wire protocol its model speaks with `mode: chat` (default, unchanged) | `image-generation` | `image-edit`. The two image modes build an image model with `createImageProvider()` (`openai`/`ollama` only, with keep-alive, endpoint load tracking and the egress fetch) and call `/images/generations` or `/images/edits`, so a dedicated image server that exposes no chat route (mflux behind LiteLLM, DALL·E, gpt-image) can serve a media tool at all — previously every media tool went through `generateText()`, which only ever produced a picture because the Google provider honours `responseModalities`.
- **Runtime** (media tools): `defaultSize` (`WxH`) pins the output size at the operator instead of the model — a ratio the model invents is rejected by every strict server — and `maxInputImages` caps an edit call at 1..4 pictures. `imageDescription` overrides the tool description shown to the hosting model.
- **Runtime** (media tools): `img-N` references now resolve to images already present in the conversation even without `imageInspection`. `registerInlineImages()` parks the bytes without rewriting the messages, so a vision-capable responder still sees the picture while the edit tool resolves the reference. The `image` argument is optional: omitted, the newest image in the conversation is edited, which is what "mache es heller" means.

### Fixed

- **Runtime** (media tools): a server that answers with zero images raised `NoImageGeneratedError`, which was reported as `media_generation_failed` and invited the hosting model to retry the same prompt forever. It is now the terminal status `no_media`.
- **Runtime** (metrics): `recordLlmCall()` sat inside the usage guard, so every image call — image servers send no usage at all — was invisible in Prometheus while costing real compute. The call count now records unconditionally; spend stays gated on `cost > 0`.

## [0.24.1] - 2026-10-31

### Fixed

- **Runtime** (model pools): `sticky` declared on a nested sub-pool now takes effect. The `llm` and `classifier` handlers only read the outer pool's `sticky`, so the common shape `fallback[ sticky round-robin(a, b, c), d ]` never pinned: every call of a conversation rotated to the next member and lost the prefix cache. The effective mode is now the outer pool's `sticky` or, if it declares none, the first one found in its sub-pools (`sticky: none` on the outer pool still disables it), and stickiness and load are applied once to the final chain.

## [0.24.0] - 2026-10-31

### Added

- **Runtime** (model pools): busy-aware member selection for single-slot servers. A `PROVIDERS` entry can set `maxConcurrent` (requests the endpoint serves at once, e.g. `1` for llama.cpp with one slot) and `loadProbe: "llama-slots"`. A pool then only sends a call to such a member while it has capacity: a busy member moves behind the free ones (it stays a failover), and a sticky pool (`sticky: execution | conversation`) whose pinned member is busy uses the free member and moves the pin there. The load is the requests this Runtime process has in flight to the endpoint (counted at the HTTP transport for the `openai`/`ollama` protocols), pools' pending selections, and with `loadProbe` llama.cpp's live `GET /slots` state, which also sees other clients (cached 0.5 s, 400 ms timeout; a failed probe falls back to the local count). If every limited member is busy, the order stays unchanged. Providers without `maxConcurrent` behave as before.

### Changed

- **CI/release**: the macOS jobs (`Workspace inventory (darwin-arm64)` in CI and release, the Outpost macOS bundles) run on `macos-15`. GitHub retires the `macos-14` image on 2026-11-02, and its scheduled brownouts cancelled release runs before that.

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

## Older releases

Entries for `0.18.1` and older live in
[docs/changelog/0.x-archive.md](docs/changelog/0.x-archive.md) — every release from
`0.1.0` (2026-09-01) to `0.18.1` (2026-10-18), moved verbatim; only their relative
link paths were adjusted for the new location. The published GitHub releases
remain the release notes for those versions, and the version links at the bottom
of this file still resolve for them.

[Unreleased]: https://github.com/Abillify/atf/compare/v0.26.0...HEAD
[0.26.0]: https://github.com/Abillify/atf/compare/v0.25.6...v0.26.0
[0.25.6]: https://github.com/Abillify/atf/compare/v0.25.5...v0.25.6
[0.25.5]: https://github.com/Abillify/atf/compare/v0.25.4...v0.25.5
[0.25.4]: https://github.com/Abillify/atf/compare/v0.25.2...v0.25.4
[0.25.2]: https://github.com/Abillify/atf/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/Abillify/atf/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/Abillify/atf/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/Abillify/atf/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/Abillify/atf/compare/v0.23.0...v0.24.0
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
