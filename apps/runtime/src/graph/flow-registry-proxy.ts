// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Trust-proxy mode: built-in pass-through flows (ADR 0038, §1 and §3).
 *
 * `PROXY_MODELS` maps model names a client already sends (`claude-*`,
 * `gpt-4.1`) to a configured provider instance and upstream model. A request
 * whose model is not a flow but matches an entry runs a flow built here in
 * code: one `llm` node, the client's tools passed through, no system prompt
 * of its own. Because it is a real flow, the engine applies every control it
 * applies to file flows — guardrails, the PII vault, budgets, admission,
 * audit, decision receipts.
 *
 * Precedence is fixed: a real flow with the requested id ALWAYS wins. An
 * operator can therefore add proxy entries next to existing flows without a
 * name ever changing meaning.
 *
 * The pass-through flows carry the id `__proxy__.<n>` (n = position in
 * `PROXY_MODELS`) and version `1`, so traces, metering and receipts tell
 * gateway traffic from orchestrated traffic at a glance.
 */

import type { FlowDefinition } from "../types/flow.js";
import type { FlowRegistry } from "./flow-parser.js";

/** Prefix of every built-in pass-through flow id. */
export const PROXY_FLOW_PREFIX = "__proxy__";

/** Version reported for the pass-through flows. */
export const PROXY_FLOW_VERSION = "1";

export interface ProxyModelEntry {
  /** Exact model name, or a prefix with a trailing `*` (`claude-*`). */
  match: string;
  /** Name of a `PROVIDERS` instance. */
  provider: string;
  /** Upstream model id sent to that provider. */
  model: string;
}

/** Whether `entry.match` accepts the client model name `name`. */
export function proxyEntryMatches(entry: ProxyModelEntry, name: string): boolean {
  if (entry.match.endsWith("*")) {
    return name.startsWith(entry.match.slice(0, -1));
  }
  return name === entry.match;
}

/** The pass-through flow for entry `index`. */
export function buildProxyFlow(entry: ProxyModelEntry, index: number): FlowDefinition {
  return {
    id: `${PROXY_FLOW_PREFIX}.${index}`,
    name: `Trust proxy: ${entry.match} → ${entry.provider}/${entry.model}`,
    description:
      "Built-in pass-through flow (PROXY_MODELS, ADR 0038): the client's " +
      "conversation and tools go to the mapped model under every control the " +
      "engine applies.",
    metadata: { version: PROXY_FLOW_VERSION, hidden: true },
    nodes: [
      {
        id: "proxy",
        type: "llm",
        label: "Pass-through",
        llm: { provider: entry.provider, model: entry.model },
        config: { clientTools: true },
      },
    ],
    edges: [],
  } as FlowDefinition;
}

export interface ProxyRegistry extends FlowRegistry {
  /**
   * The pass-through flow id for a client model name, or `undefined` when a
   * real flow has that id (flows win) or no entry matches. The first
   * matching entry in `PROXY_MODELS` order wins.
   */
  proxyFlowFor(model: string): string | undefined;
  /** The configured entries, for `GET /v1/models`. */
  proxyEntries(): readonly ProxyModelEntry[];
}

/**
 * Wraps `base` so the pass-through flows resolve by id. `list()` stays the
 * base list: the pass-through flows are not authored flows, and every
 * consumer that walks the flow set (validation, metrics, the Studio) would
 * otherwise have to learn to skip them.
 */
export function createProxyRegistry(
  base: FlowRegistry,
  entries: readonly ProxyModelEntry[],
): ProxyRegistry {
  const flows = new Map<string, FlowDefinition>();
  entries.forEach((entry, index) => {
    const flow = buildProxyFlow(entry, index);
    flows.set(flow.id, flow);
  });
  const registry: ProxyRegistry = {
    ...base,
    get(flowId: string): FlowDefinition | undefined {
      return base.get(flowId) ?? flows.get(flowId);
    },
    list(): FlowDefinition[] {
      return base.list();
    },
    proxyFlowFor(model: string): string | undefined {
      if (base.get(model) !== undefined) return undefined;
      const index = entries.findIndex((entry) => proxyEntryMatches(entry, model));
      return index === -1 ? undefined : `${PROXY_FLOW_PREFIX}.${index}`;
    },
    proxyEntries(): readonly ProxyModelEntry[] {
      return entries;
    },
  };
  return registry;
}

/** True for a registry built by {@link createProxyRegistry}. */
export function isProxyRegistry(registry: FlowRegistry): registry is ProxyRegistry {
  return typeof (registry as Partial<ProxyRegistry>).proxyFlowFor === "function";
}
