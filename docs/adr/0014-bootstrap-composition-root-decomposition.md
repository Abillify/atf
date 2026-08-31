# 14. Split `index.ts`'s wiring into focused `src/bootstrap/*.ts` builders

Date: 2026-07-13

## Status

Accepted

## Context

`src/index.ts` is the process entry point and composition root — it loads
config, then wires every subsystem into the Hono app and starts the HTTP
server. As the platform grew (guardrails, caching, MCP, the graph engine, the
autopilot loop, OIDC), the entry point accumulated every construction step
inline. A single ~200-line block wiring the autopilot loop sitting next to an
equally long block wiring the semantic cache made the file hard to read top to
bottom, hard to review incrementally (a PR touching only caching still showed
a diff against a huge file), and made it easy to lose track of which local
variable was "the real" instance when the same concept (e.g. an embedder) was
constructed in more than one place — the `cache.ts` module header calls this
out explicitly: "Centralising embedding-model creation here avoids the 'which
of the three Embedder instances is the real one?' ambiguity that existed in
`index.ts`."

This is a distinct problem from the one ADR-0004 addressed. ADR-0004 extracted
stateless helper *logic* (message-format conversion, MCP-tool building) out of
`graph-engine.ts` to keep the graph engine's orchestration core lean.  This
decision is about the *composition root* itself — `index.ts`'s sequential
construct-and-wire steps — which has no equivalent in ADR-0004's scope.

## Decision

Extract each cohesive group of construction steps into its own `buildX()`
function under `src/bootstrap/`, each taking `(config, logger, ...upstream
results)` and returning the objects downstream builders or `index.ts` need.
`index.ts`'s own header comment now enumerates the startup sequence as a
numbered list of these builders, doubling as the file's table of contents:

```
4.  buildPersistence()   — DB + migrations + all durable stores
5.  buildObservability() — metrics, budgets, token limits, audit log
6.  buildCache()         — embedder, semantic/response cache, RAG, memory
8.  buildMcp()           — connect MCP servers + periodic reconnect
9.  buildGuardrails()    — input/output guardrails + approval gate
10. buildEngine()        — graph engine + replay + optimizer
```

plus `buildAutopilot()` (`src/bootstrap/autopilot.ts`, wired later in the
sequence once the graph engine, red-team engine, and optimizer all exist).
Each module groups by **shared dependency or shared failure mode**, not by
file-size quota:

- `persistence.ts` — everything that depends on the same `Database` instance
  (execution store, tenant store, BYOK key store, idempotency store, job
  store, flow store), so there is one place answering "did I pass the right
  database instance?" instead of hunting through `index.ts` for each
  construction site.
- `observability.ts` — metrics, budgets, token limits, audit log, retention —
  grouped because they all read from the same `Database` and share the same
  webhook sink.
- `cache.ts` — the embedder plus every cache/store built on top of it
  (semantic cache, response cache, RAG vector store, memory store,
  reranker) — grouped specifically to eliminate the multi-embedder ambiguity
  described above.
- `mcp.ts` — the MCP connection lifecycle (connect → collect tool ids →
  summarize → periodic reconnect) as one self-contained, testable unit.
- `guardrails.ts` — every safety gate (input/output guardrail, tool-egress
  DLP, approval gate, groundedness gate) in one file specifically so the
  fail-open/fail-closed semantics established in ADR-0002 are auditable in a
  single place rather than scattered per-gate through the entry point.
- `engine.ts` — everything that touches `graphEngine.executeFlow` or needs the
  compiled graph (provider-key pool, checkpointer, concurrency limiter, model
  quality registry, the `GraphEngine` itself, replay, the flow optimizer). The
  module header is explicit about the boundary: "Everything that touches
  `graphEngine.executeFlow` ... lives here. The HTTP layer (Hono app +
  routes) stays in `index.ts`."
- `autopilot.ts` — the Continuous Safety & Quality Autopilot's wiring
  (canary registrar, judge-model resolution, the red-team-run hook, the
  `/autopilot/*` router, the health-signal poller), extracted last and
  explicitly labeled "ADR-0004 style split" in its own header, i.e. this
  decision's pattern was already being self-referentially applied before this
  ADR existed to name it.

Each builder returns a plain result object (e.g. `AutopilotBuildResult`,
`McpResult`) rather than mutating shared state, and activation gating lives
inside the builder, not in `index.ts` — `buildAutopilot()` checks whether
`redTeamEngine`, `flowOptimizer`, and `flowStore` are all defined and mounts a
503 stub router itself when they are not, so `index.ts` does not need an
`if` around the call site.

## Consequences

- `index.ts` reads as an ordered list of "what gets built," each step a single
  function call, with the *how* delegated to a module whose name states its
  scope. The numbered header comment and the actual call sequence are kept in
  sync by convention (there is no automated check that they match).
- A change scoped to one subsystem (e.g. the semantic cache) now produces a
  diff confined to `bootstrap/cache.ts` plus its call site, instead of a diff
  against a single very large `index.ts`.
- The split is by shared dependency/failure-mode, not strict layering — some
  builders depend on earlier builders' results (`buildEngine` needs
  `buildCache`'s vector store; `buildAutopilot` needs `buildEngine`'s
  optimizer). `index.ts` still owns the overall ordering and must call
  builders in an order that satisfies these dependencies; nothing enforces
  that ordering except the type signatures failing to compile if a required
  argument is missing.
- Not every subsystem has been extracted — OIDC auth (`auth-oidc.ts`,
  `oidc-session-store.ts`, ADR-0013) is still wired directly inline in
  `index.ts` rather than through a `buildX()` module, and `index.ts` remains
  a substantial file (just under 1,400 lines) even with the seven builder
  modules — `persistence.ts`, `observability.ts`, `cache.ts`, `mcp.ts`,
  `guardrails.ts`, `engine.ts`, `autopilot.ts` — now totaling roughly 1,900
  lines outside it. Further extraction (OIDC wiring, the Hono route-mounting
  block) is possible but was not part of this pass.
