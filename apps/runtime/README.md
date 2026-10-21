# @atf/runtime

The orchestration engine and the only public entry point for AI traffic. Bun + Hono.

Runtime executes flow graphs, resolves models through named provider instances, applies enabled
guardrails, compliance policy, approvals, and PII controls, and records configured cost, trace,
and audit data. It exposes OpenAI-compatible chat, Responses, model-listing, and embedding
endpoints; compatibility is scoped to the documented routes and fields rather than the complete
OpenAI API. Administrative and monitoring APIs are consumed by
[`@atf/control`](../control).

## Run it

From the repository root:

```bash
cp apps/runtime/.env.example apps/runtime/.env
# Set PROVIDERS and DEFAULT_LLM in apps/runtime/.env.
bun run --filter @atf/runtime dev
```

The example environment loads the checked-in example flows. Verify Runtime with
`curl --fail http://127.0.0.1:3000/health/ready`. Alternatively, use the full
five-service stack (Runtime, Control, Search, Extract, Gate) in
[`deploy/examples/`](../../deploy/examples/), which brings its own PostgreSQL and a deterministic
mock model.

```bash
bun run --filter @atf/runtime test
bun run --filter @atf/runtime typecheck
bun run --filter @atf/runtime build
```

## API surface

| Group | Purpose |
| --- | --- |
| `/v1/chat/completions` | OpenAI-compatible chat, streaming over SSE. Flows appear as models |
| `/v1/responses` | Responses API surface |
| `/v1/models` | Model listing (flows appear as models; `metadata.hidden` omits one) |
| `/v1/jobs/:id` | Result of an asynchronous execution |
| `/v1/media/:id` | Generated media |
| `/v1/rag/*`, `/v1/memory/*` | Retrieval and memory stores, when a vector or memory store is configured |
| `/v1/assistants/*`, `/v1/org-skills/*` | Per-user assistants, when the assistants subsystem is enabled |
| `/v1/receipts/*`, `/.well-known/atf-receipt-jwks.json` | Signed Decision Receipts and their public keys, when receipts are enabled |
| `/.well-known/atf-evidence-jwks.json` | Public keys for the evidence-chain signature, so third parties can verify evidence bundles offline |
| `/.well-known/atf-transaction-jwks.json` | Public keys for agent transaction tokens, so a Gate verifies them without a shared secret |
| `/v1/analysis-artifacts/*` | Stored analysis artifacts |
| `/v1/me/*` | Self-service data access and erasure (DSAR) for the calling identity |
| `/flows/*` | Flow listing, validation, versions, and Studio operations: source-form read and write-back, named drafts (`/flows/:id/drafts`), sub-flow files, test runs, node type catalog, variable and expression evaluation, Copilots |
| `/triggers/*`, `/webhooks/git` | Scheduled and event-based starts; GitOps webhook (off unless GitOps is enabled) |
| `/integrations/rocketchat/events` | Rocket.Chat outgoing-integration receiver (off by default) |
| `/connect/rocketchat/*` | End-user OIDC linking for Rocket.Chat, separate from the operator session |
| `/mcp`, `/mcp/servers`, `/mcp/:server` | Exposes flows as MCP tools; management of the MCP servers Runtime talks to |
| `/admin/*` | Tenants, provider keys, guardrails, PII vault, finops and budgets, compliance (retention, DSAR, dossier, RoPA, audit anchors, compliance policy), policy replay, memory, assistants administration, evaluation runs |
| `/security/*` | Red team, tool authorization, MCP server posture |
| `/eval/*` | Evaluation cases (run history and datasets live under `/admin/eval/*`) |
| `/monitoring/*` | Execution event stream, history, debug traces, explain cards, audit log, approvals, canary and shadow state, replay, limits, SLOs, provider and pool health, provider testing, usage |
| `/optimizer/*` | Routing advice (cheaper candidate models) for loaded flows and for a posted definition, trace analysis, and the self-optimizing loop when `OPTIMIZER_ENABLED` |
| `/autopilot/*` | Autopilot configuration and runs |
| `/health`, `/health/live`, `/health/ready` | Health, liveness and readiness (`/health/ready` also reports `flow_load`: how many flow files failed to load (count only; names are in the log), and `"auth": "disabled"` when `AUTHN_MODE=disabled`) |
| `/metrics` | Prometheus metrics |
The complete, generated list of routes with their mount conditions is the router table in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md); the OpenAPI document is served at `/openapi.json`.
A quick check against a running instance:

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Hello"}]}'
```

The two Rocket.Chat groups are documented in
[`docs/CAPABILITIES.md`](../../docs/CAPABILITIES.md#rocketchat). Both are off unless
`ROCKETCHAT_ENABLED` is set, and both require PostgreSQL.

### Streaming progress events

While an agent-harness node works, the streaming chat response carries structured progress
alongside the ordinary OpenAI chunks as a dedicated SSE event:

```text
event: atf.progress
data: {"phase":"research","tasksDone":3,"tasksTotal":7,"coverage":{"covered":2,"total":7,"open":5},"elapsedMs":12400,"etaMs":16533,"message":"Task t3 → completed"}
```

| Field | Meaning |
| --- | --- |
| `phase` | `planning`, `research`, `verification` or `synthesis` — where in the loop the harness is |
| `tasksDone` / `tasksTotal` | Tasks in a terminal state (`completed`/`failed`) over all known tasks |
| `coverage` | Optional coverage counters (`covered`, `total`, `open`) when a coverage queue is configured |
| `elapsedMs` | Wall-clock time since the harness started |
| `etaMs` | Linear ETA `(elapsedMs / tasksDone) * (tasksTotal - tasksDone)`; only present once at least two tasks are done |
| `message` | The free-text status line that triggered the event, unchanged |

OpenAI-compatible clients ignore unknown SSE event names, so this is safe to consume
optionally. The last event per node is also stored on the debug trace
(`DebugNodeTrace.progress`).

## Configuration

Every setting is an environment variable, parsed and validated as a whole at startup: Runtime
exits with the full list of problems rather than failing at the first request that touches a
bad value. Provider references are resolved at boot too, so a typo in any model setting is a
startup error.

- [`.env.example`](.env.example) — annotated starting point
- [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) — the current generated reference;
  avoid copying variable counts into hand-written documents because the schema evolves
- `ATF_PRESET` applies a bundle of defaults (`dev`, `secure`, `regulated`,
  `regulated-multitenant`, `performance`); explicit variables always win.
  `PROFILE` is a deprecated alias of it

Settings that changed with the 0.18.x hardening, worth knowing early:

- `EVIDENCE_SIGNING_KEY` — HMAC secret for the evidence-chain signature;
  `scripts/cli.ts verify-bundle <bundle.json>` verifies an exported evidence
  bundle against it (or against the public keys from
  `/.well-known/atf-evidence-jwks.json`)
- `COMPLIANCE_POLICY_REQUIRED` — with it set, production refuses to start
  without a loaded compliance policy; without it the Runtime only logs at startup
- `TRANSACTION_SIGNING_ALG` — algorithm for agent transaction tokens; the
  public key is published at `/.well-known/atf-transaction-jwks.json`
- `AGENT_TRANSACTION_AUDIENCES` — JSON object mapping MCP server names to the
  audience their transaction tokens carry (per-server audience, ADR-0035)
- `REPLICAS` — expected replica count; feeds the shared-backend warnings of
  the production gate (ADR-0031)
- `REDIS_URL` — shared backend for rate limits and the circuit breaker;
  without it these stores are per-process
- `AUDIT_PSEUDONYM_PEPPER` — pepper for audit-log pseudonyms; rotate with care
  (existing pseudonyms stop matching after a rotation)
- Shadowed flows: `flows/shadow.json` maps a production flow to a shadow
  counterpart; shadow runs execute asynchronously and never affect the user
  answer — state and stats are under `/monitoring/*`
- With the production profile (`ATF_PROFILE=production`; without it `APP_ENV=production`) a
  readiness gate refuses to start under unsafe settings such as
  open CORS or unverified JWTs (`src/config/prod-gate.ts`)

Three settings shape what the platform does with untrusted content and what it tells clients:

- `TAINT_MODE` (`on-finding`, the default, or `on-untrusted-source`) decides what taints an
  execution for `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`: an injection finding by the scanner, or
  additionally any result the Gate labels untrusted (`_meta["io.atf/content-trust"]`) and any
  retrieval result. With `TAINT_MODE=on-untrusted-source`, results of MCP servers without
  `contentTrust: trusted` now taint the execution (previously only results labelled untrusted
  by Search or the Gate). Mark internal, curated servers with `contentTrust: trusted`.
  The stricter mode asks for approval on every write after a read of outside
  content, not only after a detected attack.
- `AI_DISCLOSURE` (`off`, `header`, `field`) marks successful completions as AI-generated for
  downstream systems: `X-AI-Generated: true` on `/v1/chat/completions` and `/v1/responses`, or
  `metadata.ai_generated: "true"` in a non-streaming JSON body (a stream gets the header). See
  [`docs/EU-AI-ACT.md`](../../docs/EU-AI-ACT.md).
- `AUTHN_MODE=disabled` is a development setting: the Runtime warns at start, `/health` and
  `/health/ready` report `"auth": "disabled"`, and the production gate refuses it.

Evaluation cases and matrix tasks accept structured checks next to the reference answer
(`expected` with `contains`, `regex`, `jsonPath`, `toolCalled`, `maxTokens`, `finishReason`
(`equals`/`notEquals`), `noDiagnostic`; matrix tasks use `assert`). A case passes when its
reference score and all checks do; `jsonPath` is the restricted `$.a.b[0]` syntax, and a
`toolCalled` check fails closed when the executor reports no tool calls. `finishReason` and
`noDiagnostic` read the execution trace and likewise fail closed when the executor reports no
finish reason or no trace diagnostics.

Models are configured through **named provider instances** in `PROVIDERS`. Every model setting
references an instance by `name`, never by protocol, which is what allows two vLLM servers or
vLLM alongside LM Studio to coexist.

Navigation tools of a Search collection (get_outline, get_section, get_pages, get_context, follow_ref) are hidden from the model when the pinned collection reports in collection_stats that it cannot serve them (COLLECTION_CAPABILITY_TTL_MS).

## Flows

Flows are YAML documents in `FLOWS_DIR`, validated against
[`schemas/flow.schema.json`](schemas/flow.schema.json) and reloaded without a restart.

Next to the flows, `FLOWS_DIR` holds shared files that are not flows: `model-shortcuts.yaml`
(named engine/model presets and pools, referenced as `llm.shortcut`) and `constants.yaml`
(values for `{{const.<name>}}` in flow variables). Flow `variables` can also reference each
other, read `FLOW_PUBLIC_*` environment values, and calculate (`{{= … }}`); see
[`docs/CAPABILITIES.md`](../../docs/CAPABILITIES.md). A change to either file reloads all flows.

Node types: `llm`, `tool`, `router`, `classifier`, `parallel`, `retrieval`, `memory`,
`agent-harness`, `transform`, `trigger`, `assistant-context`, and `assistant-learn`. Any other
type string resolves through the plugin node-handler registry. Edges carry conditions evaluated
by a safe expression evaluator against run state and classifier output.

Complete reference (generated): [`docs/FLOWS.md`](../../docs/FLOWS.md). Examples:
[`deploy/examples/flows/`](../../deploy/examples/flows/).

## Layout

```text
src/
  bootstrap/     composition root, split by concern (ADR 0014)
  config/        Zod env schema, profiles, provider registry, production gate
  graph/         graph engine, node handlers, agent harness, guardrails
  routes/        HTTP routers, one module per API group
  mcp/           MCP client, wrapper, and flow-as-MCP-server
  compliance/    policy as code, dossier, retention, erasure
  security/      red team, PII detection, egress control
  eval/          datasets, judge scoring, matrix runs
  autopilot/     canary promotion, drift guard
  observability/ cost, FinOps, explainability, tracing
  transaction/   transaction envelopes and ledger
  sandbox/       container-isolated code execution
  db/            schema, migrations, row-level security
  middleware/    auth, rate limiting, tenancy, idempotency
```

State is optional by design. Without PostgreSQL, cost, audit, jobs, and approvals stay
in-memory per replica; without Redis, cluster-wide coordination degrades to per-replica scope.
Both trade-offs are deliberate — see ADR 0002 — and both need to be closed for a real
multi-replica deployment.

## Further reading

- [`docs/CAPABILITIES.md`](../../docs/CAPABILITIES.md) — what each subsystem does
- [`docs/adr/`](../../docs/adr/) — the decisions and their trade-offs
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — how Runtime relates to the other applications
