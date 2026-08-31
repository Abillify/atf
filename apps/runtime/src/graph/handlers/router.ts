// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `router` node type handler.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004). The
 * router evaluates its outgoing edge conditions to record a routing decision
 * for monitoring, but does not mutate state beyond setting `currentNodeId`.
 */
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode, FlowEdge } from "../../types/flow.js";
import type {
  RoutingDecision,
  RoutingCandidate,
} from "../../types/monitoring.js";
import { evaluateConditionExpression } from "../condition-evaluator.js";
import { getRuntime } from "../exec-runtime.js";
import { buildConditionContext } from "../graph-engine/node-config.js";
import type { AgentState } from "../graph-engine.js";

export function createRouterNodeHandler(
  node: FlowNode,
  edges?: FlowEdge[],
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Partial<AgentState> {
  // Pre-compute this node's outgoing edges once at compile time, split into
  // conditional (carry a non-empty expression) and unconditional (always-go).
  // This mirrors the engine's own edge classification in compileFlow so the
  // recorded decision matches the branch LangGraph actually takes.
  const outgoing = (edges ?? []).filter((e) => e.source === node.id);
  const conditional = outgoing.filter(
    (e): e is FlowEdge & { conditions: string } =>
      e.conditions !== undefined && e.conditions.trim().length > 0,
  );
  const unconditional = outgoing.filter(
    (e) => e.conditions === undefined || e.conditions.trim().length === 0,
  );

  return (state, config) => {
    const runtime = getRuntime(config);
    runtime?.onNodeStart(node.id);

    // Surface the routing decision (which outgoing edge was taken and why) so
    // the live graph shows more than just timing for a router. Evaluating the
    // conditions here — in the same top-to-bottom order, with the same
    // evaluator + context the engine uses — yields the branch LangGraph picks
    // next, because the router's own update never touches the routing
    // variables (classLabel/classification/message state) those conditions
    // read. Recording it now (before onNodeEnd fires for this node) lands the
    // detail on the router's "completed" event.
    if (runtime?.onNodeRouting !== undefined && outgoing.length > 0) {
      const condCtx = buildConditionContext(state);
      const candidates: RoutingCandidate[] = [];
      let chosen:
        | { target: string; condition?: string; label?: string }
        | undefined;

      for (const e of conditional) {
        const matched =
          chosen === undefined &&
          evaluateConditionExpression(e.conditions, condCtx);
        candidates.push({
          target: e.target,
          condition: e.conditions,
          ...(e.label !== undefined ? { label: e.label } : {}),
          matched,
        });
        if (matched) {
          chosen = {
            target: e.target,
            condition: e.conditions,
            ...(e.label !== undefined ? { label: e.label } : {}),
          };
        }
      }

      // No conditional edge matched → fall to the first unconditional edge
      // (LangGraph's always-go edge), when one exists.
      const firstUnconditional = unconditional[0];
      if (chosen === undefined && firstUnconditional !== undefined) {
        const e = firstUnconditional;
        candidates.push({
          target: e.target,
          ...(e.label !== undefined ? { label: e.label } : {}),
          matched: true,
        });
        chosen = {
          target: e.target,
          ...(e.label !== undefined ? { label: e.label } : {}),
        };
      }

      const decision: RoutingDecision = {
        target: chosen?.target ?? "__end__",
        ...(chosen?.condition !== undefined
          ? { matched_condition: chosen.condition }
          : {}),
        ...(chosen?.label !== undefined ? { matched_label: chosen.label } : {}),
        candidates,
      };
      runtime.onNodeRouting(node.id, decision);
    }

    return { currentNodeId: node.id };
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "router",
  emitsLifecycle: false,
  factory: (node, ctx) => createRouterNodeHandler(node, ctx.edges),
};
