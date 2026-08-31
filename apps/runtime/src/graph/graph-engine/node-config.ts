// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — Condition context + node config resolution (leaf module).
 *
 * These pure helpers were extracted from `compile.ts` so they can be imported
 * WITHOUT pulling in `compile.ts`'s module-load side effect
 * (`registerBuiltins(defaultNodeHandlerRegistry)`). Node handlers
 * (`handlers/llm.ts`, `handlers/tool.ts`, `handlers/parallel.ts`,
 * `handlers/router.ts`) import from here directly, which breaks the circular
 * import `handlers/index → llm → graph-engine barrel → compile → handlers/index`
 * that otherwise caused an ESM temporal-dead-zone crash
 * ("Cannot access 'llm' before initialization") depending on module load order.
 *
 * This module has NO load-time side effects and imports only leaf modules.
 */

import type {
  FlowNode,
  LlmConfig,
  NodeOverride,
} from "../../types/flow.js";
import { evaluateConditionExpression } from "../condition-evaluator.js";
import { buildClassificationNamespaces } from "../classification-access.js";
import type { AgentState } from "./state.js";

/**
 * Builds the context object exposed to condition expressions and override
 * matching. Includes both LangGraph state and request-context attributes
 * so routing expressions can reference user roles, plans, languages etc.
 */
export function buildConditionContext(
  state: AgentState,
): Record<string, unknown> {
  const lastMsg = state.messages[state.messages.length - 1];
  const ctx = state.context;
  // Non-destructive classifier accessors: `node.<id>.classification.<field>`
  // (this run) and `turn[<n>].<id>.classification.<field>` (n runs ago, 0 =
  // current). NB: the safe condition evaluator does not accept hyphens in
  // identifiers, so referencing a hyphenated node id (e.g. `refine-client`) in
  // an edge/when expression is not supported — templates (tool args, prompts)
  // do support hyphens. Alphanumeric/underscore node ids (e.g. `triage`) work
  // everywhere.
  const { node, turn } = buildClassificationNamespaces(state.turns);
  return {
    // Graph state
    currentNodeId: state.currentNodeId ?? null,
    messageCount: state.messages.length,
    hasErrors: state.errors.length > 0,
    errorCount: state.errors.length,
    toolResultCount: state.toolResults.length,
    lastMessageType: lastMsg ? lastMsg._getType() : null,
    lastMessageText:
      lastMsg && typeof lastMsg.content === "string" ? lastMsg.content : "",
    // Classification
    classLabel: state.classLabel,
    classification: state.classification,
    // Non-destructive per-node / per-turn classifier output
    node,
    turn,
    // User / request attributes
    role: ctx.role ?? null,
    groups: ctx.groups ?? [],
    plan: ctx.plan ?? null,
    language: ctx.language ?? null,
    claims: ctx.claims ?? {},
    params: ctx.requestParams ?? {},
    // User identity
    userEmail: ctx.userEmail ?? null,
    clientId: ctx.clientId ?? null,
  };
}

/**
 * Tests whether a NodeOverride matches the current state + request context.
 * ALL supplied conditions must match (AND semantics).
 */
function matchesOverride(override: NodeOverride, state: AgentState): boolean {
  const ctx = state.context;

  // whenClass
  if (override.whenClass !== undefined && override.whenClass !== "*") {
    if (state.classLabel !== override.whenClass) return false;
  }
  // whenClaim — expression against ctx.claims
  if (override.whenClaim !== undefined) {
    if (!evaluateConditionExpression(override.whenClaim, ctx.claims ?? {}))
      return false;
  }
  // whenParam — expression against ctx.requestParams
  if (override.whenParam !== undefined) {
    if (
      !evaluateConditionExpression(override.whenParam, ctx.requestParams ?? {})
    )
      return false;
  }
  // whenPlan
  if (override.whenPlan !== undefined) {
    if (ctx.plan !== override.whenPlan) return false;
  }
  // whenGroup
  if (override.whenGroup !== undefined) {
    if (!ctx.groups?.includes(override.whenGroup)) return false;
  }
  // whenLanguage — prefix match
  if (override.whenLanguage !== undefined) {
    const lang = ctx.language ?? "";
    if (!lang.startsWith(override.whenLanguage)) return false;
  }

  return true;
}

/**
 * Resolves the effective LLM config, tools, and system prompt for a node,
 * applying dynamic overrides based on classLabel AND request context.
 */
export function resolveNodeConfig(
  node: FlowNode,
  state: AgentState,
): { llm?: LlmConfig; tools: string[]; systemPrompt?: string } {
  const baseTools = node.tools ?? [];

  if (!node.overrides?.length) {
    return { llm: node.llm, tools: baseTools, systemPrompt: node.systemPrompt };
  }

  for (const override of node.overrides) {
    if (matchesOverride(override, state)) {
      return {
        llm: override.llm ?? node.llm,
        tools: override.tools ?? baseTools,
        systemPrompt: override.systemPrompt ?? node.systemPrompt,
      };
    }
  }

  return { llm: node.llm, tools: baseTools, systemPrompt: node.systemPrompt };
}
