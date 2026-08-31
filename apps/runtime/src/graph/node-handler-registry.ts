// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Node Handler Registry — the dispatch seam for flow node types.
 *
 * The graph engine used to map a flow node's `type` to its executable handler
 * via a hardcoded if/else chain duplicated in two places (top-level graph
 * compilation and inline `parallel` children). That made adding a node type a
 * four-touchpoint change and left no place for an extension (e.g. an agent
 * harness) to register a new type.
 *
 * This registry extracts that mapping behind a single, registrable contract:
 * built-in node types register at module load (see `handlers/index.ts`), and
 * plugins register the same way. The dispatch sites just look a node type up.
 *
 * Each handler factory lives in its own module under `handlers/`, and receives
 * the engine context explicitly as `ExecRuntime` rather than closing over it.
 * This module owns only the registry abstraction. See ADR 0004.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ZodTypeAny } from "zod";
import type { FlowNode, FlowEdge } from "../types/flow.js";
import type { ToolAuthzEngine } from "./tool-authz.js";
// Type-only import — erased at compile time, so this does not create a runtime
// import cycle with graph-engine.ts (which imports the registry as a value).
import type { AgentState } from "./graph-engine.js";

/**
 * A compiled node handler: given the current run state (and the per-request
 * runtime injected via `config.configurable`), produces a partial state update.
 *
 * May be synchronous or async — LangGraph accepts both, and a few built-in
 * handlers (e.g. `router`) are sync. Callers that need the value await it,
 * which is a no-op for the sync case.
 */
export type NodeHandler = (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Partial<AgentState> | Promise<Partial<AgentState>>;

/**
 * Build-time context handed to a handler factory. Carries the full node map of
 * the flow being compiled so composite handlers (notably `parallel`) can
 * resolve and run their child nodes.
 */
export interface NodeHandlerContext {
  /** Every node in the flow being compiled, keyed by node id. */
  nodeMap: Map<string, FlowNode>;
  /**
   * Every edge in the flow being compiled. Used by handlers that need to reason
   * about their own outgoing edges — notably `router`, which evaluates its
   * outgoing conditions to surface the routing decision to monitoring. Optional:
   * inline dispatch sites (parallel children, harness delegation) that do not
   * carry the flow's edge list simply omit it, and a router used there records
   * no routing detail.
   */
  edges?: FlowEdge[];
  /**
   * Optional declarative tool authorization engine. When present, handlers must
   * call `toolAuthzEngine.evaluate(toolId, args, requestCtx)` before dispatching
   * a tool call and throw / reject when the decision is `{ allowed: false }`.
   * The no-op engine (when authz is unconfigured) always returns `allowed: true`
   * so handlers can treat this as unconditionally present.
   */
  toolAuthzEngine?: ToolAuthzEngine;
}

/** Produces a {@link NodeHandler} for a concrete node at graph-compile time. */
export type NodeHandlerFactory = (
  node: FlowNode,
  ctx: NodeHandlerContext,
) => NodeHandler;

/** A single node-type registration. */
export interface NodeHandlerRegistration {
  /** The `node.type` discriminator this registration handles. */
  type: string;
  /**
   * Whether a node of this type opens a monitoring lifecycle
   * (`onNodeStart`/`onNodeEnd`) when it runs inline as a `parallel` child.
   *
   * Pass-through types (`router`, and a `parallel` nested under a parallel) are
   * `false`: as children they emit no standalone lifecycle events. The flag is
   * consulted only on the parallel-child path, where the parallel handler — not
   * the graph loop — is responsible for emitting the terminal event.
   */
  emitsLifecycle: boolean;
  /** Builds the executable handler for a node of this type. */
  factory: NodeHandlerFactory;
  /**
   * Optional Zod schema validating this node type's `config` object at
   * flow-parse time. When present, the flow parser runs it against `node.config`
   * and surfaces issues under the `config` path. This is the seam a plugin uses
   * to validate its own configuration — built-in types (e.g. `agent-harness`)
   * use the same mechanism, so there is no special-casing in the parser.
   */
  configSchema?: ZodTypeAny;
}

/**
 * Maps a flow node `type` to the code that executes it. Built-in types are
 * registered by the graph engine at module load; the engine's two dispatch
 * sites resolve handlers exclusively through {@link get}.
 */
export class NodeHandlerRegistry {
  private readonly handlers = new Map<string, NodeHandlerRegistration>();

  /**
   * Registers a node-type handler. Throws on a duplicate type so a conflicting
   * registration fails loudly at startup instead of silently shadowing an
   * existing one. Returns `this` for fluent chaining.
   */
  register(registration: NodeHandlerRegistration): this {
    if (this.handlers.has(registration.type)) {
      throw new Error(
        `NodeHandlerRegistry: duplicate registration for node type "${registration.type}".`,
      );
    }
    this.handlers.set(registration.type, registration);
    return this;
  }

  /** Returns the registration for a node type, or `undefined` when none exists. */
  get(type: string): NodeHandlerRegistration | undefined {
    return this.handlers.get(type);
  }

  /** True when a handler is registered for the given node type. */
  has(type: string): boolean {
    return this.handlers.has(type);
  }

  /** The set of registered node types (useful for diagnostics/tests). */
  registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }
}

/**
 * The process-wide registry every dispatch site resolves through. It lives here
 * (not in graph-engine) so dependency-light consumers — notably the flow parser,
 * which validates a node's `type`/`config` against the registered set — can read
 * it without importing the engine. Built-in node types are registered into it at
 * graph-engine module load (`registerBuiltins`); plugins register into the same
 * instance via the dynamic handler loader.
 */
export const defaultNodeHandlerRegistry = new NodeHandlerRegistry();
