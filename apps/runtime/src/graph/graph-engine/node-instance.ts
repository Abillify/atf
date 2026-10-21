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
