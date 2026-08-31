// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Plugin Sandbox Worker (`src/graph/plugin-sandbox-worker.ts`)
 *
 * Runs inside a Bun Worker thread. Loads a single plugin module and exposes
 * its NodeHandlerFactory over a structured message protocol.
 *
 * Security guarantees when spawned with `env: {}`:
 *   - No process.env access (no API keys, no DATABASE_URL, no secrets).
 *   - No shared memory with the host process.
 *   - No access to the database pool, Redis, or any live application singleton.
 *
 * Protocol:
 *   Host → Worker: SandboxRequest
 *   Worker → Host: SandboxResponse
 *
 * The Worker loads the plugin once at startup (INIT message) and then handles
 * CALL messages for the lifetime of the worker. It never imports the main
 * application bundle.
 *
 * No `any` at module boundaries.
 */

// ---------------------------------------------------------------------------
// Message shapes (shared between host and worker, imported as types only)
// ---------------------------------------------------------------------------

export interface SandboxInitMessage {
  type: "INIT";
  /** Absolute path to the plugin module file. */
  pluginPath: string;
  /** Node type this worker handles (used to select the right factory). */
  nodeType: string;
}

export interface SandboxCallMessage {
  type: "CALL";
  /** Correlation id so the host can match async responses. */
  id: string;
  /**
   * The concrete flow node this handler was compiled for (JSON-serialised).
   * The worker passes it to the plugin's factory to build the handler.
   */
  node: { id: string; type: string; label?: string; config?: Record<string, unknown>; tools?: string[] };
  /** JSON-serialisable snapshot of AgentState passed to the handler. */
  state: Record<string, unknown>;
}

export type SandboxRequest = SandboxInitMessage | SandboxCallMessage;

export interface SandboxOkResponse {
  type: "OK";
  id: string;
  /** Partial AgentState update returned by the handler. */
  patch: Record<string, unknown>;
}

export interface SandboxErrorResponse {
  type: "ERROR";
  id?: string;
  message: string;
}

export type SandboxResponse = SandboxOkResponse | SandboxErrorResponse;

// ---------------------------------------------------------------------------
// Worker entry point (runs only inside the Worker thread)
// ---------------------------------------------------------------------------

// Bun exposes `self` as the Worker global scope.
declare const self: {
  postMessage(msg: SandboxResponse): void;
  onmessage: ((ev: { data: SandboxRequest }) => void) | null;
};

// Only activate when running as a Worker (not when this file is imported as a
// module for its types).
if (
  typeof self !== "undefined" &&
  typeof self.onmessage !== "undefined" &&
  typeof process !== "undefined" &&
  process.env.BUN_WORKER !== undefined
) {
  let factory: ((node: unknown, ctx: unknown) => (state: unknown) => unknown) | undefined;

  self.onmessage = async (ev) => {
    const msg = ev.data;

    if (msg.type === "INIT") {
      try {
        // Dynamic import — Bun resolves file:// URLs
        const mod = await import(/* @vite-ignore */ `file://${msg.pluginPath}`);

        // Try to find the matching registration
        const registrations: unknown[] = [];
        if (Array.isArray(mod.nodeTypes)) registrations.push(...mod.nodeTypes);
        if (mod.nodeType !== undefined) registrations.push(mod.nodeType);
        if (Array.isArray(mod.default)) registrations.push(...mod.default);
        else if (mod.default !== undefined) registrations.push(mod.default);

        const reg = registrations.find(
          (r): r is { type: string; factory: typeof factory } =>
            typeof r === "object" &&
            r !== null &&
            (r as { type?: unknown }).type === msg.nodeType &&
            typeof (r as { factory?: unknown }).factory === "function",
        );

        if (reg === undefined) {
          self.postMessage({
            type: "ERROR",
            message: `Plugin does not export a registration for node type "${msg.nodeType}"`,
          });
          return;
        }

        factory = reg.factory;
        self.postMessage({ type: "OK", id: "", patch: {} });
      } catch (err) {
        self.postMessage({
          type: "ERROR",
          message: `Plugin init failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    if (msg.type === "CALL") {
      if (factory === undefined) {
        self.postMessage({ type: "ERROR", id: msg.id, message: "Worker not initialised" });
        return;
      }
      try {
        // Build the handler from the plugin's factory using the concrete node
        // the graph engine compiled for. The nodeMap context is limited to this
        // single node — sandboxed plugins cannot reach other nodes' state.
        const nodeMap = new Map<string, unknown>([[msg.node.id, msg.node]]);
        const handler = factory(msg.node, { nodeMap });
        const patch = await handler(msg.state);
        const safePatch =
          patch !== null && typeof patch === "object"
            ? (patch as Record<string, unknown>)
            : {};
        self.postMessage({ type: "OK", id: msg.id, patch: safePatch });
      } catch (err) {
        self.postMessage({
          type: "ERROR",
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
