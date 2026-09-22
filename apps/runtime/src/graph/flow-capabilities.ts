// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { FlowDefinition, LlmConfig } from "../types/flow.js";
import { getModelCapabilities, type ModelCapabilities } from "./model-capabilities.js";
import { poolLeafConfigs } from "./model-pool.js";

export interface FlowModelCapability extends ModelCapabilities {
  provider: string;
  model: string;
}
export interface FlowCapabilityDescriptor {
  schemaVersion: "1";
  flowId: string;
  requirements: {
    requiredScopes: string[];
    dataClasses: string[];
    recovery?: { retry: boolean };
  };
  graph: { nodeTypes: string[]; tools: string[] };
  models: FlowModelCapability[];
}

export function collectFlowLlmConfigs(flow: FlowDefinition): LlmConfig[] {
  const byKey = new Map<string, LlmConfig>();
  const add = (llm: LlmConfig | undefined): void => {
    if (!llm) return;
    byKey.set(`${llm.provider}/${llm.model}`, llm);
    // A POOL shortcut expands to a primary config plus its remaining members
    // (see LlmPoolConfig). Every member can serve a request, so every member
    // must appear in the flow's model/capability set — otherwise a fallback or
    // rotated-to member would be invisible to capability checks. poolLeafConfigs
    // walks nested sub-pools, so every leaf model is covered.
    for (const leaf of poolLeafConfigs(llm)) {
      byKey.set(`${leaf.provider}/${leaf.model}`, leaf);
    }
  };
  for (const node of flow.nodes) {
    add(node.llm);
    for (const override of node.overrides ?? []) add(override.llm);
    const config = node.config as
      | {
          mediaTools?: Array<{ llm?: LlmConfig }>;
          imageInspection?: { llm?: LlmConfig };
        }
      | undefined;
    const mediaTools = config?.mediaTools ?? [];
    for (const mediaTool of mediaTools) add(mediaTool.llm);
    add(config?.imageInspection?.llm);
  }
  return [...byKey.values()];
}

export function describeFlowCapabilities(flow: FlowDefinition): FlowCapabilityDescriptor {
  const tools = new Set<string>();
  const nodeTypes = new Set<string>();
  for (const node of flow.nodes) {
    nodeTypes.add(node.type);
    for (const tool of node.tools ?? []) tools.add(tool);
    for (const override of node.overrides ?? []) for (const tool of override.tools ?? []) tools.add(tool);
  }
  return {
    schemaVersion: "1",
    flowId: flow.id,
    requirements: {
      requiredScopes: [...(flow.requiredScopes ?? [])].sort(),
      dataClasses: [...(flow.dataClasses ?? [])].sort(),
      ...(flow.recovery !== undefined ? { recovery: { retry: flow.recovery.retry } } : {}),
    },
    graph: { nodeTypes: [...nodeTypes].sort(), tools: [...tools].sort() },
    models: collectFlowLlmConfigs(flow).map((llm) => ({
      provider: llm.provider,
      model: llm.model,
      ...getModelCapabilities(llm.provider, llm.model),
      ...(typeof llm.parameters?.contextLength === "number"
        ? { contextLength: llm.parameters.contextLength }
        : {}),
    })),
  };
}
