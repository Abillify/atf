// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Plugin Sandbox Host (`src/graph/plugin-sandbox.ts`)
 *
 * Creates a sandboxed node-handler that runs a plugin module inside a Bun
 * Worker thread. The Worker receives no process.env and no shared application
 * state. Calls are serialised as JSON messages with a configurable timeout.
 *
 * Usage: called by `loadHandlerPlugins` when `PLUGINS_SANDBOX=true`.
 *
 * No `any` at module boundaries.
 */

import * as path from "node:path";
import crypto from "node:crypto";
import type { FlowNode } from "../types/flow.js";
import type { NodeHandler, NodeHandlerRegistration } from "./node-handler-registry.js";
import type { AgentState } from "./graph-engine.js";
import type { Logger } from "../observability/logger.js";
import type { SandboxRequest, SandboxResponse } from "./plugin-sandbox-worker.js";

// ---------------------------------------------------------------------------
// Bun Worker type (minimal surface we use)
// ---------------------------------------------------------------------------

interface BunWorker {
  postMessage(msg: SandboxRequest): void;
  terminate(): void;
  // Bun Workers use addEventListener for "message" / "error"
  addEventListener(
    event: "message",
    handler: (ev: { data: SandboxResponse }) => void,
  ): void;
  addEventListener(event: "error", handler: (ev: { message: string }) => void): void;
}

// ---------------------------------------------------------------------------
// Sandboxed handler wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a plugin module in a Bun Worker. Returns a NodeHandlerRegistration
 * whose factory produces handlers that forward calls to the Worker.
 *
 * Returns undefined when sandboxing is not supported (no Bun Worker API).
 */
export async function createSandboxedRegistration(
  pluginPath: string,
  nodeType: string,
  timeoutMs: number,
  logger?: Logger,
): Promise<NodeHandlerRegistration | undefined> {
  // Bun Worker is only available in Bun runtime
  const BunWorkerClass = (globalThis as Record<string, unknown>).Worker as
    | (new (path: string, opts?: Record<string, unknown>) => BunWorker)
    | undefined;

  if (BunWorkerClass === undefined) {
    logger?.warn("Plugin sandbox requested but Bun Worker API not available; falling back to in-process", {
      plugin: pluginPath,
    });
    return undefined;
  }

  const workerPath = new URL("./plugin-sandbox-worker.js", import.meta.url).pathname;

  // Spawn the worker with an empty env so it cannot read secrets
  const worker = new BunWorkerClass(workerPath, {
    env: { BUN_WORKER: "1" },
    smol: true,
  });

  // Pending call map: id → { resolve, reject, timer }
  const pending = new Map<
    string,
    { resolve: (patch: Record<string, unknown>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  worker.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "ERROR" && msg.id === undefined) {
      // Init error — log and poison all pending calls
      logger?.error("Sandboxed plugin worker error", { plugin: pluginPath, message: msg.message });
      for (const [, { reject, timer }] of pending) {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
      pending.clear();
      return;
    }
    if (msg.id === undefined) return;
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.type === "OK") {
      entry.resolve(msg.patch);
    } else {
      entry.reject(new Error(msg.message));
    }
  });

  worker.addEventListener("error", (ev) => {
    logger?.error("Sandboxed plugin worker uncaught error", { plugin: pluginPath, message: ev.message });
  });

  // Initialise the worker (load plugin + select factory for nodeType). The INIT
  // response is the first message with an empty id; a dedicated one-shot flag
  // avoids leaving a permanent listener that would re-fire on every CALL reply.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Sandbox init timed out"));
    }, timeoutMs);
    const onInit = (ev: { data: SandboxResponse }): void => {
      if (settled) return;
      // Only the INIT reply carries an empty id; ignore any other traffic.
      if (ev.data.type === "OK" && ev.data.id !== "") return;
      settled = true;
      clearTimeout(timer);
      if (ev.data.type === "ERROR") reject(new Error(ev.data.message));
      else resolve();
    };
    worker.addEventListener("message", onInit);
    worker.postMessage({ type: "INIT", pluginPath, nodeType } satisfies SandboxRequest);
  });

  logger?.info("Sandboxed plugin worker ready", { plugin: path.basename(pluginPath), nodeType });

  // The graph engine calls this factory once per compiled node with the real
  // FlowNode. We capture that node and forward it (serialised) on every CALL so
  // the plugin's own factory can build its handler inside the worker.
  const factory = (node: FlowNode): NodeHandler => {
    const serialisedNode = {
      id: node.id,
      type: node.type,
      ...(node.label !== undefined ? { label: node.label } : {}),
      ...(node.config !== undefined ? { config: node.config } : {}),
      ...(node.tools !== undefined ? { tools: node.tools } : {}),
    };
    return async (state: AgentState): Promise<Partial<AgentState>> => {
      return new Promise<Partial<AgentState>>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Sandboxed plugin handler timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pending.set(id, {
          resolve: (patch) => resolve(patch as Partial<AgentState>),
          reject,
          timer,
        });

        // Serialise state — only JSON-safe fields survive the structured clone.
        const stateSnapshot = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;

        worker.postMessage({
          type: "CALL",
          id,
          node: serialisedNode,
          state: stateSnapshot,
        } satisfies SandboxRequest);
      });
    };
  };

  return {
    type: nodeType,
    emitsLifecycle: true,
    factory,
  };
}
