# 38. Trust-proxy mode: ATF as a drop-in gateway in front of existing AI clients

Date: 2026-11-11

## Status

Accepted (2026-11-12). Implemented as described; deviations are listed under
"Implementation notes" at the end.

## Context

Every capability ATF offers — PII tokenization, budgets and limits, audit,
decision receipts, governed tools — is reached through a flow today. That is
the right shape for orchestrated scenarios, but it locks out the largest
practical deployment: an organization whose people already work in a coding
agent, a desktop assistant, or a chat frontend, and whose compliance team wants
that traffic governed too. The pitch of the trust-proxy mode is that the client
changes nothing but its base URL and gets the controls for free, with no flow
file authored per use case.

Reading the current code against that pitch shows exactly what is missing —
and that most of the pipeline is already where it needs to be:

- `POST /v1/chat/completions` treats the OpenAI `model` field as a flow id.
  `resolveFlowRouting` (`apps/runtime/src/routes/chat/metering.ts`) runs
  dispatch → canary → A/B over it, and an unmatched model ends in
  `Flow '<id>' not found.` with status 404 (`apps/runtime/src/routes/chat.ts`).
  There is no path from "a model name the client already sends" to "run the
  standard governed pipeline without a flow".
- Client-supplied tools already pass through: when `CLIENT_TOOLS_ENABLED` is
  on, `request.tools` lands in `requestCtx.clientTools` (with
  `request.tool_choice`), and the agent harness offers them to the model. This
  is the mechanism a proxy mode needs, and it exists.
- A second API shape over the same pipeline is a proven pattern here:
  `apps/runtime/src/routes/responses.ts` plus `routes/responses/translate.ts`
  translate the OpenAI Responses API to and from the internal Chat Completions
  shapes "so the existing chat pipeline (guardrails, routing, budget, graph
  execution, finalize) can be reused verbatim". An Anthropic-shaped entry
  point is the same trick with a different wire format.
- Authentication accepts `Authorization: Bearer <token>` (and API keys through
  the `ApiKeyResolver` behind that header). Anthropic clients send
  `x-api-key` — currently not read anywhere in `middleware/auth.ts`.
- The gate's MCP proxy (`apps/gate/src/tools/mcp-proxy-tool.ts`) already
  exposes governed downstream tools as a single MCP server; a proxy-mode client
  pointed at `/mcp` gets tool governance without ATF calling tools on its own.
- Configuration presets exist (`apps/runtime/src/config/profiles.ts`:
  explicit env var > profile default > schema default, profiles never carry
  secrets), so a `trust-proxy` preset is a natural fit for the surrounding
  switches.

What is missing, precisely: (1) an Anthropic-compatible
`POST /v1/messages`, (2) a model-name → provider/model mapping that needs no
flow file, (3) a built-in pass-through flow to execute that mapping, and
(4) the preset plus the operator documentation.

## Decision

Proposed. The design has four parts; each is independently reviewable, and the
ordering below is the order they would ship.

### 1. Model mapping: `PROXY_MODELS`

A JSON list of `{ match, provider, model }` entries, validated at startup with
the existing provider-existence check (an entry naming a provider absent from
`PROVIDERS` fails startup, same as flow `llm.provider` does today). `match` is
either an exact model name or a prefix pattern with a trailing `*`
(`claude-*` matches `claude-sonnet-4-5`). Resolution happens at exactly one
place: inside `resolveFlowRouting`, after `flowDispatcher.resolveFlow` and
before the flow-not-found 404 — a request whose model resolves to a real flow
runs that flow, always. **Flows win over proxy entries; there is no override
flag.** That precedence rule is what makes the feature additive: an operator
can adopt proxy mode next to existing flows without any name colliding.

A matched request runs a built-in pass-through flow (§3), not a file-loaded
one. `PROXY_MODELS` unset or empty — the default — means the feature is off and
today's 404 behavior is unchanged.

### 2. Anthropic Messages API translation

`POST /v1/messages` is added as a third entry point following the
`responses.ts` pattern: a `routes/anthropic/translate.ts` converts the
Anthropic request to the internal Chat Completions shape, reuses the whole
chat pipeline (guardrails, budget/admission, graph execution, metering,
finalize) verbatim, and converts the response back — including the SSE event
sequence (`message_start`, `content_block_start/delta/stop`, `message_delta`,
`message_stop`) built from the pipeline's existing chunk stream.

Field mapping (request): `system` (string or text-block list) → leading
`system` message; `messages[].content` blocks — `text` → text part, `image`
(base64 or URL source) → the internal image content part, `tool_use` →
`assistant.tool_calls`, `tool_result` → `role: "tool"` message; `tools` →
`request.tools` (client tools, so they enter `requestCtx.clientTools` under
the same `CLIENT_TOOLS_ENABLED` gate as today); `max_tokens` → the internal
max-tokens parameter; `stream` → the existing streaming path.

Explicitly **not** supported in v1, each answered with a 400 naming the field
rather than being silently ignored — a client that believes it sent a
`cache_control` directive and was silently stripped of it is a worse audit
story than a hard error: `cache_control` / prompt caching, `thinking` blocks,
`service_tier`, `container`, top-level `metadata.user_id` passthrough (the
internal metadata contract has no equivalent slot yet), and the
`anthropic-beta` header values that change request semantics. Read-only beta
headers that do not change semantics (e.g. nothing required for basic
messages) are accepted and ignored with a logged note.

Response shape: an Anthropic `message` object with `id`, `model` (echoing the
client's requested name, not the upstream model — the client's view of the
world is its own model names), `content` blocks (`text`, `tool_use`), `stop_reason`
mapped from the internal finish reason (`end_turn`/`tool_use`/`max_tokens`),
and `usage` with `input_tokens`/`output_tokens`.

### 3. The built-in pass-through flow

Constructed in code as a `FlowDefinition`, not loaded from YAML: a single `llm`
node, `clientTools: true`, no system prompt of its own (the client's `system`
is the system prompt), provider/model from the matched `PROXY_MODELS` entry.
It gets a stable id (e.g. `__proxy__`) and version so the debug trace,
metering, and receipts show it like any flow — an auditor reading a trace sees
`flow_id: "__proxy__", flow_version: "1"` and can tell proxy traffic from
orchestrated traffic at a glance.

Because it is a real flow through a real pipeline, the controls that apply are
**all the controls the engine already applies**: input/output guardrails, the
PII vault (subject to ADR 0036's scope flags — with the default `messages`
scope, tool results and retrieved context are out of vault scope, and the
proxy-mode documentation must say so because proxy clients use tools heavily),
budgets and rate limits, admission control, audit, decision receipts, and the
tool-authorization policy for anything the client tools reach through the
gate.

Controls that deliberately do **not** apply, because they require a flow to
define them: retrieval (no knowledge-base node exists in a pass-through flow),
server-side tool calls (the proxy calls no tools of its own; client tools are
the client's, governed but not initiated), and flow-level compliance rules
that key off flow metadata beyond the pass-through's own.

### 4. Authentication and the preset

`x-api-key` is accepted wherever `Authorization: Bearer` is accepted for
`/v1/messages` — one line in the auth middleware's extraction order, with the
same `ApiKeyResolver` behind it, and mutual exclusion (both headers present
with different values → 401, never "first one wins"). No new credential type.

A `trust-proxy` profile in `profiles.ts` sets the surrounding defaults a
gateway deployment wants (receipts on, audit on, guardrails on, client tools
on) without carrying any secret, following the existing profile rules: an
explicit env var always beats the profile.

## Consequences

- **For operators:** adopting proxy mode is `PROXY_MODELS` + the preset +
  pointing clients at the ATF base URL. The blast radius is bounded by the
  mapping list: only model names an operator enumerated are served; everything
  else still 404s.
- **For the audit story:** proxy traffic is metered, audited, and receipted
  like flow traffic because it *is* flow traffic. The `__proxy__` flow id is
  the join key for "everything that came in through the gateway".
- **Risk — the model echo:** answering with the client's model name while a
  different upstream model served the request is what a drop-in gateway must
  do, but it hides substitutions from the client. The debug trace and receipts
  carry the real provider/model; the response does not lie to the client about
  capabilities it cannot express.
- **Risk — Anthropic API drift:** the Messages API grows (the beta-header
  mechanism exists precisely for that). The 400-on-unsupported-field rule
  converts silent drift into loud failures, which is the safe direction but
  means an API update can break clients until ATF catches up. The translation
  layer must stay small and test-pinned to one documented API revision.
- **Deviation from the task brief, recorded honestly:** the brief assumed
  `x-api-key` handling might already exist; it does not (auth reads only
  `Authorization: Bearer`), so §4 is new middleware behavior, not a reuse.
  The brief also assumed client-tool passthrough needed building; it exists
  (`requestCtx.clientTools`), so §3 only reuses it. Both deviations favor less
  work than planned, but they change which files a reviewer should read.
- **Not decided here:** whether `/v1/messages` also serves flow-addressed
  requests (a client naming a real flow id through the Anthropic API) or is
  proxy-only; whether `count_tokens` gets an endpoint; and how prompt caching
  is revisited once upstream providers expose usable cache breakpoints.

## Implementation notes

- **Flow ids.** One pass-through flow per `PROXY_MODELS` entry, id `__proxy__.<n>` (n = position
  in the list), version `1`, `metadata.hidden: true`. A single `__proxy__` id cannot carry a
  different provider/model per entry. The pass-through flows resolve by id but are not part of
  `FlowRegistry.list()`, so validation, metrics and the Studio never see them.
- **Routing.** `resolveFlowRouting` asks the proxy registry after dispatch; canary and A/B do not
  apply to pass-through flows.
- **`/v1/messages`** does not duplicate the chat pipeline: it translates the request and calls
  the mounted chat router in-process, handing over the verified identity the outer middleware
  established. Every control of `/v1/chat/completions` therefore applies unchanged. `top_k` is
  refused too — the internal pipeline has no equivalent parameter.
- **`x-api-key`** is read only on `/v1/messages`; both headers with different values are a 401.
- **Model list.** Exact `match` names appear in `GET /v1/models`; prefix patterns do not.
- **Gate side.** The blueprint `deploy/blueprints/gate-mcp-proxy/` needed two Gate additions:
  `mcpServers[].requiredScopes` (imported tools could not require a scope) and
  `mcpServers[].server.allowPrivateAddress` (an MCP server inside the network was unreachable).
  Imported tools now also keep the downstream annotations.
