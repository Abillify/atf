// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Delegation instance keys for the graph engine.
 *
 * The engine keeps its per-node execution state keyed by node id. When an
 * agent-harness task delegates to a node, the same node can run several times
 * concurrently, so those attempts would overwrite each other's state. A
 * delegation therefore stamps `config.configurable.atfNodeInstance` with its
 * task key and every per-node map is addressed by
 * {@link nodeStateKey} — `nodeId#instance` when an instance is present, the
 * plain `nodeId` otherwise. Runs without an instance keep exactly today's
 * keys.
 */

import type { ExecRuntime } from "../exec-runtime.js";
/** Configurable key carrying the delegation instance (agent-harness task key). */
export const NODE_INSTANCE_KEY = "atfNodeInstance";

/**
 * Reads the delegation instance from a LangGraph runnable config. Only
 * non-empty strings count as an instance; anything else yields `undefined`.
 */
export function nodeInstanceOf(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const configurable = (config as { configurable?: unknown }).configurable;
  if (typeof configurable !== "object" || configurable === null) {
    return undefined;
  }
  const value = (configurable as Record<string, unknown>)[NODE_INSTANCE_KEY];
  if (typeof value !== "string") return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * Key addressing one node's execution state: `nodeId#instance` for a
 * delegation instance, the plain `nodeId` when there is none.
 */
export function nodeStateKey(
  nodeId: string,
  instance: string | undefined,
): string {
  return instance !== undefined && instance.length > 0
    ? `${nodeId}#${instance}`
    : nodeId;
}
/**
 * The node id a state key belongs to: the part before the instance separator,
 * or the key itself when it carries no instance (see {@link nodeStateKey}).
 */
export function nodeIdOfStateKey(stateKey: string): string {
  const separator = stateKey.indexOf("#");
  return separator > 0 ? stateKey.slice(0, separator) : stateKey;
}
/**
 * A view of `runtime` for one delegation instance of `nodeId`: the per-node
 * callbacks the target's handler makes about itself (lifecycle, I/O, tokens
 * and model, routing, diagnostics, tool calls, groundedness, progress) are
 * addressed to `nodeId#instance`, so concurrent delegations to the same node
 * keep separate state and each gets its own trace entry with `instance_id`.
 * Callbacks about other node ids pass through unchanged. Everything else is
 * read from `runtime` itself (prototype delegation, no copy).
 */
export function bindRuntimeToInstance(
  runtime: ExecRuntime,
  nodeId: string,
  instance: string,
): ExecRuntime {
  const stateKey = nodeStateKey(nodeId, instance);
  const keyOf = (id: string): string => (id === nodeId ? stateKey : id);
  const bound = Object.create(runtime) as ExecRuntime;
  bound.onNodeStart = (id, context) =>
    id === nodeId
      ? runtime.onNodeStart(id, context, instance)
      : runtime.onNodeStart(id, context);
  if (runtime.onNodeEnd !== undefined) {
    const end = runtime.onNodeEnd;
    bound.onNodeEnd = (id, errorMessage) =>
      id === nodeId ? end(id, errorMessage, instance) : end(id, errorMessage);
  }
  bound.onToolCall = (toolCallId, toolName, argsJson, ownerNodeId) =>
    (ownerNodeId ?? nodeId) === nodeId
      ? runtime.onToolCall(toolCallId, toolName, argsJson, nodeId, instance)
      : runtime.onToolCall(toolCallId, toolName, argsJson, ownerNodeId);
  if (runtime.onNodeIo !== undefined) {
    const io = runtime.onNodeIo;
    bound.onNodeIo = (id, value) => io(keyOf(id), value);
  }
  if (runtime.onNodeRouting !== undefined) {
    const routing = runtime.onNodeRouting;
    bound.onNodeRouting = (id, decision) => routing(keyOf(id), decision);
  }
  if (runtime.onDebugToolSelection !== undefined) {
    const selection = runtime.onDebugToolSelection;
    bound.onDebugToolSelection = (id, value) => selection(keyOf(id), value);
  }
  if (runtime.onDebugClassification !== undefined) {
    const classification = runtime.onDebugClassification;
    bound.onDebugClassification = (id, value) => classification(keyOf(id), value);
  }
  if (runtime.onNodeDiagnostic !== undefined) {
    const diagnostic = runtime.onNodeDiagnostic;
    bound.onNodeDiagnostic = (id, value) => diagnostic(keyOf(id), value);
  }
  if (runtime.setGenAiAttributes !== undefined) {
    const genAi = runtime.setGenAiAttributes;
    bound.setGenAiAttributes = (id, req, res) => genAi(keyOf(id), req, res);
  }
  if (runtime.onProgress !== undefined) {
    const progress = runtime.onProgress;
    bound.onProgress = (id, value) => progress(keyOf(id), value);
  }
  if (runtime.onGroundedness !== undefined) {
    const groundedness = runtime.onGroundedness;
    bound.onGroundedness = (id, report) =>
      id === nodeId ? groundedness(id, report, instance) : groundedness(id, report);
  }
  return bound;
}
