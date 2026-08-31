// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { FlowDefinition, LlmConfig } from "../types/flow.js";
import { getModelCapabilities, type ModelCapabilities } from "./model-capabilities.js";

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
    if (llm) byKey.set(`${llm.provider}/${llm.model}`, llm);
  };
  for (const node of flow.nodes) {
    add(node.llm);
    for (const override of node.overrides ?? []) add(override.llm);
    const mediaTools = (node.config as { mediaTools?: Array<{ llm?: LlmConfig }> } | undefined)?.mediaTools ?? [];
    for (const mediaTool of mediaTools) add(mediaTool.llm);
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
