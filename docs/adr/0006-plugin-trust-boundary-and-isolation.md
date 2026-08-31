# 6. Plugin trust boundary and isolation strategy

Date: 2026-07-10

## Status

Accepted

## Context

aiperator supports operator-provided node-type handler plugins loaded from a
`PLUGINS_DIR` at startup (see `src/graph/handler-loader.ts`). The current
implementation loads plugin modules **in-process** via a dynamic `import()`,
giving them full access to:

- All secrets in the process environment (`process.env`)
- The in-memory token, tenant context, and session state
- The LLM provider API keys (loaded into `AppConfig`)
- The database connection pool and Redis client
- Any other module in the process

This is the correct behaviour for **first-party or highly-trusted** plugins
that need deep engine integration. It is documented as a trust boundary in the
startup log and in the warning emitted by the production-readiness gate.

The risk is that a misconfigured `PLUGINS_DIR` (e.g. pointing at a
user-writable directory, a CI artifact cache, or a package registry install)
could silently give an attacker in-process code execution.

## Decision

We add an **opt-in sandbox mode** (`PLUGINS_SANDBOX=true`) that runs each
plugin module in an isolated Bun Worker thread. The Worker receives only an
explicit, narrow capability surface; it cannot access `process.env`, the
database pool, or any shared application state.

### Communication model

The Worker interface (`src/graph/plugin-sandbox-worker.ts`) exposes only:

- **Node handler calls**: the engine serialises the `AgentState` snapshot and
  `NodeHandlerContext` (minus live objects) into a message, sends it to the
  Worker, and awaits the returned partial-state update with a configurable
  timeout.
- **Structured response** — the Worker replies with a `{ ok, patch }` or
  `{ ok: false, error }` message. No callbacks, no shared references.

### What the sandbox does NOT provide

- `process.env` access: the Worker is started without inheriting `env`.
- Database / Redis / MCP connections: not forwarded.
- Cross-plugin or cross-request shared state: each Worker is stateless between
  calls (state is in the engine, not the plugin).

### Trust levels

| Mode | When to use | `PLUGINS_SANDBOX` |
|---|---|---|
| **In-process** (default) | First-party plugins, full engine integration needed | `false` (default) |
| **Sandboxed** | Third-party plugins, untrusted directory, operator caution | `true` |

### Wiring

- `loadHandlerPlugins` checks `verifierOptions.sandbox`. When true it creates a
  `SandboxedNodeHandler` wrapper that serialises calls through a Bun Worker
  instead of calling the factory directly.
- The production-readiness gate emits a **warning** (not fatal) when
  `PLUGINS_DIR` is set without `PLUGINS_SANDBOX=true`, to encourage operators
  to evaluate the risk explicitly.
- A `PLUGINS_SANDBOX_TIMEOUT_MS` config controls how long the engine waits for
  a sandboxed handler before considering it failed (default: 30 000 ms).

### Accepted limitations

- Sandboxed plugins cannot register new node types that close over engine-level
  singletons (checkpointer, vector store, monitoring). They get a read-only
  snapshot of `AgentState` and return a partial update.
- Performance cost: one Worker per plugin file (created once at startup, reused
  across requests). Message-passing adds ~0.5–2 ms per call depending on state
  size.
- `register(registry)` export shape is NOT supported in sandbox mode (requires
  live registry reference). Plugins using it must run in-process.

## Consequences

- Operators can now run third-party plugins with a clear, documented trust
  degradation. An operator who sets `PLUGINS_SANDBOX=true` gets defence-in-
  depth: a compromised plugin cannot read API keys or tenant data.
- In-process plugins retain full power; nothing changes for first-party use.
- The production-readiness gate now explicitly surfaces the plugin risk, so
  operators cannot accidentally deploy with `PLUGINS_DIR` set without seeing a
  warning that asks them to evaluate the trust boundary.
- The sandbox design is intentionally conservative: we accept the performance
  and capability trade-off because the goal is to make the risk auditable, not
  to make plugins maximally capable.
