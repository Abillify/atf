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
| `/v1/models`, `/v1/embeddings` | Model listing and embeddings |
| `/flows/*` | Flow listing, validation, versions, and Studio operations: source-form read and write-back, named drafts (`/flows/:id/drafts`), sub-flow files, test runs, node type catalog, variable and expression evaluation, Copilots |
| `/runs/*`, `/:flowId/run` | Direct flow execution and run inspection |
| `/triggers/*`, `/webhooks/*` | HMAC-signed webhook and scheduled starts |
| `/integrations/rocketchat/events` | Rocket.Chat outgoing-integration receiver (off by default) |
| `/connect/rocketchat/*` | End-user OIDC linking for Rocket.Chat, separate from the operator session |
| `/mcp` | Exposes flows as MCP tools |
| `/admin/*` | Tenants, keys, budgets, limits, policy, retention, GitOps |
| `/security/*` | Guardrails, red team, PII vault |
| `/eval/*` | Evaluation runs and cases, shadow comparisons, canary state |
| `/monitoring/*` | Execution event stream, debug traces, provider and pool health, provider testing |
| `/optimizer/*` | Routing advice (cheaper candidate models) for loaded flows and for a posted definition, trace analysis, and the self-optimizing loop when `OPTIMIZER_ENABLED` |
| `/health/live`, `/health/ready` | Liveness and readiness |
| `/metrics` | Prometheus metrics |

A quick check against a running instance:

```bash
curl --fail-with-body http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Hello"}]}'
```

The two Rocket.Chat groups are documented in
[`docs/CAPABILITIES.md`](../../docs/CAPABILITIES.md#rocketchat). Both are off unless
`ROCKETCHAT_ENABLED` is set, and both require PostgreSQL.

## Configuration

Every setting is an environment variable, parsed and validated as a whole at startup: Runtime
exits with the full list of problems rather than failing at the first request that touches a
bad value. Provider references are resolved at boot too, so a typo in any model setting is a
startup error.

- [`.env.example`](.env.example) — annotated starting point
- [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) — the current generated reference;
  avoid copying variable counts into hand-written documents because the schema evolves
- `PROFILE` applies a bundle of defaults (`dev`, `secure`, `regulated`,
  `regulated-multitenant`, `performance`); explicit variables always win
- With `APP_ENV=production` a readiness gate refuses to start under unsafe settings such as
  open CORS or unverified JWTs (`src/config/prod-gate.ts`)

Models are configured through **named provider instances** in `PROVIDERS`. Every model setting
references an instance by `name`, never by protocol, which is what allows two vLLM servers or
vLLM alongside LM Studio to coexist.

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
