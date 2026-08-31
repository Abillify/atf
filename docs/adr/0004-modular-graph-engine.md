# 4. Keep the graph engine lean by extracting cohesive helpers

Date: 2026-06-14

## Status

Accepted

## Context

`graph/graph-engine.ts` had grown past 2,700 lines, mixing orchestration with
two self-contained concerns: message conversion between the three message
representations (OpenAI `ChatMessage` ↔ LangChain `BaseMessage` ↔ AI SDK
`CoreMessage`) and the MCP→AI-SDK tool building used by the agent loop. The size
hurt readability and made the security-sensitive tool boundary harder to find
and test in isolation.

## Decision

Extract the stateless, individually-testable pieces into focused modules,
leaving `graph-engine.ts` responsible for orchestration only:

- `graph/message-mapping.ts` — `chatMessageToBaseMessage`,
  `baseMessagesToCoreMessages`, `aiResponseMessagesToBaseMessages`,
  `applyAnthropicPromptCache`, `coreMessagesToText`.
- `graph/agent-tools.ts` — `buildAiTools` (+ `uniqueToolKey`), which now owns the
  approval-gate and egress-DLP wrapping of every model-invoked tool call.

The engine imports these; tests target the new modules directly.

## Consequences

- The engine shrank by ~360 lines and the tool boundary lives in one place.
- New cross-cutting tool controls (approval, egress DLP, future quota checks) are
  added in `agent-tools.ts` without touching the orchestration core.
- Further extraction (per-node handlers) is possible later but was deferred:
  handlers close over the shared `ExecRuntime`, so moving them needs that context
  threaded explicitly — a larger change tracked for when the engine grows again.
  This has since happened; see the addendum below.

## Per-node handler addendum

Date: 2026-08-27

The extraction deferred above was carried out. `ExecRuntime` was made an explicit
parameter rather than a closed-over binding, which was the blocker named in the
original consequences, and dispatch moved behind a registry.

The current shape:

- `graph/exec-runtime.ts` — the `ExecRuntime` context itself, passed explicitly
  into every handler instead of captured.
- `graph/handlers/` — one module per node type, each exporting a
  `nodeType: NodeHandlerRegistration` and independently testable. The twelve
  built-ins are `llm`, `classifier`, `tool`, `retrieval`, `memory`, `parallel`,
  `router`, `agent-harness`, `transform`, `trigger`, `assistant-context`, and
  `assistant-learn`; `handlers/llm-structured.ts` supports the `llm` handler and
  is not a node type of its own.
- `graph/node-handler-registry.ts` — maps a node `type` to its handler, replacing
  an if/else chain that had been duplicated at two dispatch sites (top-level
  compilation and inline `parallel` children). Adding a node type is now a
  registry entry rather than a four-touchpoint change.
- `graph/graph-engine/` — the remaining orchestration split into `state.ts`,
  `compile.ts`, `handler-factories.ts`, `spans.ts`, and `error-strategy.ts`.
- `graph/graph-engine.ts` — now a re-export facade of about 80 lines, kept so
  that existing imports of `./graph-engine.js` continue to resolve unchanged.

Consequences worth recording:

- The file named `graph-engine.ts` is no longer where the engine lives. Read
  `graph-engine/compile.ts` for control flow and `handlers/` for node behaviour.
- Built-ins register at module load via `registerBuiltins`, so an engine
  constructed directly in a unit test is self-sufficient and needs no startup
  loader. External plugins use the same `NodeHandlerRegistration` contract but are
  discovered from a directory by the handler loader, and registration throws on a
  duplicate type — a plugin cannot silently shadow a built-in.
