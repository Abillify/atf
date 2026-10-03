// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — Compilation, condition evaluation and node config resolution.
 *
 * Contains the graph compilation logic (compileFlow), condition context
 * building, override matching, node config resolution, cache utilities,
 * and tool reference validation.
 */

import crypto from "node:crypto";
import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { FlowDefinition, FlowNode } from "../../types/flow.js";
import { parallelChildId } from "../../types/flow.js";
import { evaluateConditionExpression } from "../condition-evaluator.js";
import { defaultNodeHandlerRegistry } from "../node-handler-registry.js";
import { registerBuiltins } from "../handlers/index.js";
import {
  AgentStateAnnotation,
  type AgentState,
  type CompiledAgentGraph,
} from "./state.js";
// Condition context + node config resolution live in a side-effect-free leaf
// module so node handlers can import them WITHOUT loading this module (whose
// top-level `registerBuiltins` call closes a circular import). Re-exported here
// for backward compatibility with existing `graph-engine` barrel consumers.
import { buildConditionContext } from "./node-config.js";
export { buildConditionContext, resolveNodeConfig } from "./node-config.js";
import { resolveNodeErrorConfig } from "./error-strategy.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ExecRuntime } from "../exec-runtime.js";
import type { ToolAuthzEngine } from "../tool-authz.js";

// ---------------------------------------------------------------------------
// Register built-in node types
// ---------------------------------------------------------------------------

/**
 * Built-in node-type registry. Each flow node `type` maps to the factory that
 * builds its handler. The two dispatch sites (top-level graph compilation and
 * inline `parallel` children) resolve handlers exclusively through this
 * registry. Built-in types live in ./handlers (one module each) and are
 * registered here at module load; plugins register into the same instance via
 * the dynamic handler loader. Adding a built-in type is a new module under
 * ./handlers plus an entry in handlers/index.ts — the dispatch logic and the
 * flow parser (which validates `type`/`config` against the registry) stay
 * untouched.
 */
registerBuiltins(defaultNodeHandlerRegistry);

// ---------------------------------------------------------------------------
// Node error strategy (Req. 5.2)
// ---------------------------------------------------------------------------

/**
 * Wraps a node handler so a THROWN error is handled per
 * `node.config.errorStrategy` instead of always aborting the run.
 *
 * ## Why a wrapper, and what it does not change
 *
 * Handlers signal *expected* failures by returning `{ errors: [...] }`, and the
 * engine already turns those into an error chunk and carries on. This wrapper is
 * only about an *unexpected throw*, which previously always propagated out of
 * `graph.stream()` and failed the whole request — so `errorStrategy` (declared,
 * documented and unit-tested in `error-strategy.ts`) had no effect on execution
 * at all. `fail-fast` remains the default, so the existing behaviour is
 * unchanged unless a flow opts in.
 *
 * ## Why `fallback` executes the node rather than rerouting to it
 *
 * Rerouting would mean synthesising conditional edges around every node that
 * declares a fallback, fighting the flow's own edge topology and changing what
 * the monitoring graph shows. Executing the fallback handler in place — the same
 * mechanism `parallel` children and agent-harness delegation already use —
 * keeps the graph shape honest: the failing node produced a recovery result.
 *
 * The strategy is read at COMPILE time (it lives in `node.config`, which is part
 * of the graph checksum, so a change recompiles), while the handler that records
 * and decides comes from the per-execution runtime.
 */
export function withNodeErrorStrategy(
  node: FlowNode,
  handler: (
    state: AgentState,
    config?: LangGraphRunnableConfig,
  ) => Promise<Partial<AgentState>> | Partial<AgentState>,
  factoryCtx: {
    nodeMap: Map<string, FlowNode>;
    edges?: FlowDefinition["edges"];
    toolAuthzEngine?: ToolAuthzEngine;
  },
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  const errorConfig = resolveNodeErrorConfig(node.config);

  // Read the per-execution runtime from LangGraph's configurable bag. The
  // edge data-flow capture (`onNodeEntry`) fires here rather than in the
  // handlers: this wrapper is the ONE place every standalone graph node passes
  // through, and at entry the state is exactly what crossed the incoming edge
  // (`state.currentNodeId` names the node on the other end of it).
  const readRuntime = (
    config?: LangGraphRunnableConfig,
  ): ExecRuntime | undefined =>
    (config?.configurable as { runtime?: ExecRuntime } | undefined)?.runtime;

  // Nothing to do for the default strategy: let the throw propagate exactly as
  // before, with no wrapper cost on the hot path beyond the entry capture.
  if (errorConfig.strategy === "fail-fast") {
    return async (state, config) => {
      readRuntime(config)?.onNodeEntry?.(node.id, state);
      return handler(state, config);
    };
  }

  return async (state, config) => {
    readRuntime(config)?.onNodeEntry?.(node.id, state);
    try {
      return await handler(state, config);
    } catch (err) {
      const runtime = (
        config?.configurable as { runtime?: ExecRuntime } | undefined
      )?.runtime;
      const result = runtime?.nodeErrorHandler?.handle(
        node.id,
        err,
        errorConfig,
      ) ?? { action: "propagate" as const };

      if (result.action === "propagate") throw err;

      const message =
        err instanceof Error ? err.message : String(err);
      runtime?.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: `error_strategy_${errorConfig.strategy}`,
        message: `Node "${node.id}" threw and was handled by errorStrategy "${errorConfig.strategy}": ${message}`,
        details: {
          strategy: errorConfig.strategy,
          ...(errorConfig.fallbackNodeId !== undefined
            ? { fallback_node_id: errorConfig.fallbackNodeId }
            : {}),
        },
      });

      const capturedError = {
        message: `Node "${node.id}" failed (${errorConfig.strategy}): ${message}`,
        type: "execution_error" as const,
        details: { node_id: node.id, strategy: errorConfig.strategy },
      };

      if (result.action === "fallback") {
        const fallbackNode = factoryCtx.nodeMap.get(result.fallbackNodeId);
        const fallbackReg =
          fallbackNode !== undefined
            ? defaultNodeHandlerRegistry.get(fallbackNode.type)
            : undefined;
        if (fallbackNode === undefined || fallbackReg === undefined) {
          // A fallback that cannot be resolved degrades to `continue` rather
          // than replacing the node's real failure with a config error — the
          // original error is what the operator needs to see.
          return { currentNodeId: node.id, errors: [capturedError] };
        }
        try {
          const fallbackHandler = fallbackReg.factory(fallbackNode, {
            nodeMap: factoryCtx.nodeMap,
            ...(factoryCtx.edges !== undefined
              ? { edges: factoryCtx.edges }
              : {}),
            ...(factoryCtx.toolAuthzEngine !== undefined
              ? { toolAuthzEngine: factoryCtx.toolAuthzEngine }
              : {}),
          });
          const update = await fallbackHandler(state, config);
          // Keep the original error visible: the run recovered, but it did not
          // succeed, and hiding that turns a degraded answer into a silent one.
          return {
            ...update,
            errors: [capturedError, ...(update.errors ?? [])],
          };
        } catch (fallbackErr) {
          return {
            currentNodeId: node.id,
            errors: [
              capturedError,
              {
                message: `Fallback node "${result.fallbackNodeId}" also failed: ${
                  fallbackErr instanceof Error
                    ? fallbackErr.message
                    : String(fallbackErr)
                }`,
                type: "execution_error",
                details: { node_id: result.fallbackNodeId },
              },
            ],
          };
        }
      }

      // "continue": record the failure and let the graph proceed.
      return { currentNodeId: node.id, errors: [capturedError] };
    }
  };
}

// ---------------------------------------------------------------------------
// Cache utilities
// ---------------------------------------------------------------------------

export interface CacheEntry {
  graph: CompiledAgentGraph;
  checksum: string;
  /** Flow ID this entry belongs to — enables invalidating all variants of a flow. */
  flowId: string;
}

/**
 * Upper bound on compiled-graph cache entries (per cache). Each unique
 * (flow id + resolved-variable set) combination produces one entry; the bound
 * caps memory if many distinct per-request variable overrides are used. Oldest
 * entries are evicted first (insertion-order Map).
 */
export const MAX_GRAPH_CACHE_ENTRIES = 256;

/**
 * Memo for {@link computeFlowChecksum}.
 *
 * The checksum is a SHA-256 over `JSON.stringify(flow)` and was recomputed on
 * every request — for a 42 KB flow that is a full serialise plus hash purely to
 * look up a cache entry that is almost always present.
 *
 * A WeakMap on the flow object is safe here because the value is a pure function
 * of that object's content and nothing mutates a flow definition: the registry
 * replaces the object on hot-reload, and `applyFlowVariables` memoises its
 * resolved variants (so those also have stable identity). A changed flow is
 * therefore a different key, never a stale hit.
 */
const checksumMemo = new WeakMap<FlowDefinition, string>();

export function computeFlowChecksum(flow: FlowDefinition): string {
  const memoised = checksumMemo.get(flow);
  if (memoised !== undefined) return memoised;
  const checksum = crypto
    .createHash("sha256")
    .update(JSON.stringify(flow))
    .digest("hex");
  checksumMemo.set(flow, checksum);
  return checksum;
}

/**
 * Marks `key` as most-recently-used, so {@link evictIfFull} behaves as an LRU.
 *
 * Maps iterate in insertion order, so re-inserting an existing key moves it to
 * the end. Without this, eviction was FIFO: a flow compiled once at startup and
 * used on every request since could be evicted in favour of a one-off variant
 * that had merely arrived later, forcing a recompile of the hot flow.
 */
export function touchCacheEntry(
  cache: Map<string, CacheEntry>,
  key: string,
): void {
  const entry = cache.get(key);
  if (entry === undefined) return;
  cache.delete(key);
  cache.set(key, entry);
}

/**
 * Evicts the least-recently-USED entries from a compiled-graph cache until it
 * has room for one more (bounded by `max`). Recency is maintained by
 * {@link touchCacheEntry} on every hit.
 */
export function evictIfFull(cache: Map<string, CacheEntry>, max: number): void {
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Deletes every cached variant (all resolved-variable sets) of a given flow ID.
 * Used on hot-reload so a changed flow file drops all its compiled graphs.
 */
export function deleteFlowEntries(
  cache: Map<string, CacheEntry>,
  flowId: string,
): void {
  for (const [key, entry] of cache) {
    if (entry.flowId === flowId) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Tool reference validation (Req 4.6)
// ---------------------------------------------------------------------------

export function validateToolReferences(
  flow: FlowDefinition,
  knownToolIds: Set<string>,
): void {
  for (const node of flow.nodes) {
    if (!node.tools?.length) continue;
    for (const toolId of node.tools) {
      const server = toolId.includes("/") ? toolId.split("/")[0] : undefined;
      const runtimeResolved =
        server !== undefined && knownToolIds.has(`${server}/*`);
      if (!knownToolIds.has(toolId) && !runtimeResolved) {
        throw new Error(
          `Flow "${flow.id}": node "${node.id}" references unknown MCP tool ID "${toolId}". ` +
            `Known tool IDs: [${[...knownToolIds].join(", ")}]`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Condition context + override matching
// ---------------------------------------------------------------------------

// `buildConditionContext`, `matchesOverride` and `resolveNodeConfig` now live
// in ./node-config.ts (side-effect-free leaf) — see the import/re-export above.

// ---------------------------------------------------------------------------
// Graph builder (compile-once; callbacks come from RunnableConfig at runtime)
// ---------------------------------------------------------------------------

export function compileFlow(
  flow: FlowDefinition,
  checkpointer?: BaseCheckpointSaver,
  toolAuthzEngine?: import("../tool-authz.js").ToolAuthzEngine,
): CompiledAgentGraph {
  type DynGraph = StateGraph<
    typeof AgentStateAnnotation,
    AgentState,
    typeof AgentStateAnnotation.Update,
    string
  >;

  const graph = new StateGraph(AgentStateAnnotation) as unknown as DynGraph;

  // Build a lookup map for parallel child node resolution
  const nodeMap = new Map<string, FlowNode>(flow.nodes.map((n) => [n.id, n]));

  // Nodes that are children of a parallel node are executed inline (not as
  // standalone LangGraph nodes) — exclude them from direct graph registration
  const parallelChildIds = new Set<string>();
  for (const node of flow.nodes) {
    if (node.type === "parallel" && node.parallelNodes) {
      for (const entry of node.parallelNodes) {
        parallelChildIds.add(parallelChildId(entry));
      }
    }
  }

  // Nodes that are exclusively allowlist targets of an agent-harness node are
  // delegated to inline (same pattern as parallel children). Collect their IDs
  // so they can be excluded from standalone graph registration when they have
  // no incoming edges (otherwise LangGraph raises UnreachableNodeError).
  const harnessOnlyTargets = new Set<string>();
  const edgeTargets = new Set(flow.edges.map((e) => e.target));
  for (const node of flow.nodes) {
    if (node.type === "agent-harness" && node.config) {
      const cfg = node.config as Record<string, unknown>;
      const allowlist = cfg.allowlist;
      if (Array.isArray(allowlist)) {
        for (const target of allowlist) {
          if (typeof target === "string" && !edgeTargets.has(target)) {
            harnessOnlyTargets.add(target);
          }
        }
      }
      // The verification target is delegated to exactly like an allowlist entry,
      // but is deliberately NOT in the allowlist (so the planner cannot schedule
      // the reviewer as ordinary work). It therefore needs the same exclusion —
      // without it a verifier with no incoming edge is registered as a standalone
      // graph node and LangGraph refuses to compile the whole flow with
      // UnreachableNodeError.
      const verification = cfg.verification;
      if (verification !== null && typeof verification === "object") {
        const target = (verification as Record<string, unknown>).target;
        if (typeof target === "string" && !edgeTargets.has(target)) {
          harnessOnlyTargets.add(target);
        }
      }
    }
  }

  for (const node of flow.nodes) {
    // Skip parallel children — they run inside the parallel handler, not as
    // standalone LangGraph nodes (avoids UnreachableNodeError)
    if (parallelChildIds.has(node.id)) continue;

    // Skip harness-only delegation targets — they run inline via the harness
    // handler (same reasoning as parallel children)
    if (harnessOnlyTargets.has(node.id)) continue;

    const registration = defaultNodeHandlerRegistry.get(node.type);
    if (registration === undefined) {
      // Unreachable in practice: the Zod node-type enum is validated before a
      // flow ever reaches compilation. Fail loud rather than silently drop.
      throw new Error(
        `compileFlow: no handler registered for node type "${node.type}" (node "${node.id}").`,
      );
    }
    graph.addNode(
      node.id,
      withNodeErrorStrategy(
        node,
        registration.factory(node, {
          nodeMap,
          edges: flow.edges,
          toolAuthzEngine,
        }),
        { nodeMap, edges: flow.edges, toolAuthzEngine },
      ),
    );
  }

  const nodeIds = new Set(flow.nodes.map((n) => n.id));

  const conditionalEdges = new Map<
    string,
    Array<{ target: string; conditions: string }>
  >();
  const unconditionalEdges: Array<{ source: string; target: string }> = [];

  for (const edge of flow.edges) {
    if (edge.conditions !== undefined && edge.conditions.trim().length > 0) {
      const list = conditionalEdges.get(edge.source) ?? [];
      list.push({ target: edge.target, conditions: edge.conditions });
      conditionalEdges.set(edge.source, list);
    } else {
      unconditionalEdges.push({ source: edge.source, target: edge.target });
    }
  }

  for (const [src, targets] of conditionalEdges.entries()) {
    const resolvedSrc = src === "__start__" || !nodeIds.has(src) ? START : src;
    const pathMap: Record<string, string> = { __end__: END };
    for (const { target } of targets) {
      pathMap[target] =
        target === "__end__" || !nodeIds.has(target) ? END : target;
    }
    const capturedTargets = [...targets];

    graph.addConditionalEdges(
      resolvedSrc,
      (state: AgentState): string => {
        const condCtx = buildConditionContext(state);
        for (const { target, conditions } of capturedTargets) {
          if (evaluateConditionExpression(conditions, condCtx)) {
            return target;
          }
        }
        return "__end__";
      },
      pathMap,
    );
  }

  for (const { source, target } of unconditionalEdges) {
    const resolvedSrc =
      source === "__start__" || !nodeIds.has(source) ? START : source;
    const resolvedTgt =
      target === "__end__" || !nodeIds.has(target) ? END : target;
    graph.addEdge(resolvedSrc, resolvedTgt);
  }

  const hasStartEdge = flow.edges.some(
    (e) => e.source === "__start__" || !nodeIds.has(e.source),
  );
  if (!hasStartEdge && flow.nodes.length > 0) {
    const firstNode = flow.nodes[0];
    if (firstNode !== undefined) graph.addEdge(START, firstNode.id);
  }

  return graph.compile(
    checkpointer !== undefined ? { checkpointer } : undefined,
  ) as unknown as CompiledAgentGraph;
}
