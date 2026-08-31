// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AI Copilot for the Studio flow builder (`src/graph/flow-copilot.ts`)
 *
 * Turns a natural-language instruction ("add a guardrail node before the LLM
 * node") into a small, reviewable set of graph edits. Deliberately asks the
 * model for a *patch* (which nodes/edges to add/update/remove) rather than a
 * full replacement `FlowDefinition` — patches stay small and legible even for
 * large flows, and a model that only needs to describe a delta is far less
 * likely to accidentally drop unrelated nodes than one asked to reproduce the
 * whole graph.
 *
 * Safety property this module exists to uphold: **never auto-apply**. The
 * proposed flow is validated with the same {@link validateFlow} the editor's
 * inline validation and `POST /flows/validate` use, and diffed against the
 * original with the same {@link diffFlows} the version-history UI uses. The
 * route layer returns `{ proposed, diff, explanation }` for the operator to
 * review and explicitly accept — this module never writes anything.
 *
 * No `any` at module boundaries.
 */

import { generateObject, jsonSchema } from "ai";
import type { LanguageModel, JSONSchema7 } from "ai";
import type { FlowDefinition, FlowNode, FlowEdge, LlmConfig } from "../types/flow.js";
import { isKnownProviderName } from "../config/providers.js";
import { validateFlow, type FlowValidationReport } from "./flow-validator.js";
import { diffFlows, type FlowDiff } from "./flow-diff.js";

// ---------------------------------------------------------------------------
// Patch shape (flat — no discriminated unions, for broad provider/schema
// compatibility; matches the flat-schema style already used by
// ClassifierOutputSchema / input-guardrail-model.ts / memory-extractor.ts).
// ---------------------------------------------------------------------------

/** A node add/update entry. Blank string / empty array fields mean "no change" on update, or "use the default" on add. */
interface FlowPatchNode {
  id: string;
  type: string;
  label: string;
  provider: string;
  model: string;
  systemPrompt: string;
  tools: string[];
}

interface FlowPatchEdge {
  source: string;
  target: string;
  conditions: string;
  label: string;
}

interface FlowPatchEdgeRef {
  source: string;
  target: string;
}

export interface FlowPatch {
  explanation: string;
  addNodes: FlowPatchNode[];
  updateNodes: FlowPatchNode[];
  removeNodeIds: string[];
  addEdges: FlowPatchEdge[];
  removeEdges: FlowPatchEdgeRef[];
}

const NODE_ITEM_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    id: { type: "string", description: "Node id (existing id for updates, new unique id for additions)." },
    type: {
      type: "string",
      description:
        "Node type: llm, tool, router, classifier, parallel, retrieval, or memory. Leave unchanged (repeat the existing value) on update.",
    },
    label: { type: "string", description: "Display label, or empty string for no change / none." },
    provider: {
      type: "string",
      description:
        "LLM provider (openai, google, ollama, azure, bedrock, anthropic) — only for llm/classifier nodes. Empty string if not applicable / no change.",
    },
    model: { type: "string", description: "LLM model id — only for llm/classifier nodes. Empty string if not applicable / no change." },
    systemPrompt: { type: "string", description: "System prompt override, or empty string for no change / none." },
    tools: { type: "array", items: { type: "string" }, description: "MCP tool ids this node may call, or empty array for no change / none." },
  },
  required: ["id", "type", "label", "provider", "model", "systemPrompt", "tools"],
  additionalProperties: false,
};

const EDGE_ITEM_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    source: { type: "string" },
    target: { type: "string" },
    conditions: { type: "string", description: "Routing condition expression, or empty string for none/unconditional." },
    label: { type: "string", description: "Human-readable edge label, or empty string for none." },
  },
  required: ["source", "target", "conditions", "label"],
  additionalProperties: false,
};

const FLOW_PATCH_SCHEMA = jsonSchema<FlowPatch>({
  type: "object",
  properties: {
    explanation: {
      type: "string",
      description: "One or two plain-language sentences describing what this patch does and why.",
    },
    addNodes: { type: "array", items: NODE_ITEM_SCHEMA },
    updateNodes: { type: "array", items: NODE_ITEM_SCHEMA },
    removeNodeIds: { type: "array", items: { type: "string" } },
    addEdges: { type: "array", items: EDGE_ITEM_SCHEMA },
    removeEdges: {
      type: "array",
      items: {
        type: "object",
        properties: { source: { type: "string" }, target: { type: "string" } },
        required: ["source", "target"],
        additionalProperties: false,
      },
    },
  },
  required: ["explanation", "addNodes", "updateNodes", "removeNodeIds", "addEdges", "removeEdges"],
  additionalProperties: false,
});

const SYSTEM_PROMPT = `You are a copilot embedded in a visual flow-graph editor for an LLM \
agent orchestration platform. The user describes an edit to make to their flow in plain \
language; you respond with a minimal PATCH (only the nodes/edges that actually change) — \
never a full copy of the flow. Prefer the smallest patch that satisfies the instruction. \
Node types: llm (streaming model call), tool (deterministic MCP tool call), router \
(routing only, no model call), classifier (structured output, sets a classification label \
used by edge conditions), parallel (fan-out to concurrent child nodes), retrieval (RAG), \
memory (long-term recall). Edge "conditions" are expressions like \
classLabel == 'urgent' evaluated against the run state. Every node id you reference must \
either already exist in the current flow or be one you are adding in this same patch. Use \
empty string / empty array to mean "no change" (update) or "use the platform default" (add).`;

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

function llmConfigFromPatch(
  p: FlowPatchNode,
  existing: LlmConfig | undefined,
): LlmConfig {
  // Accepts any provider the deployment can resolve — a configured PROVIDERS
  // name or a built-in protocol — so a copilot patch can target a named endpoint.
  const provider = !isBlank(p.provider) && isKnownProviderName(p.provider)
    ? p.provider
    : (existing?.provider ?? "openai");
  const model = !isBlank(p.model) ? p.model : (existing?.model ?? "gpt-4o-mini");
  return {
    provider,
    model,
    ...(existing?.parameters !== undefined ? { parameters: existing.parameters } : {}),
  };
}

function buildNode(p: FlowPatchNode): FlowNode {
  const node: FlowNode = { id: p.id, type: p.type as FlowNode["type"] };
  if (!isBlank(p.label)) node.label = p.label;
  if (!isBlank(p.systemPrompt)) node.systemPrompt = p.systemPrompt;
  if (p.tools.length > 0) node.tools = p.tools;
  if (node.type === "llm" || node.type === "classifier") {
    node.llm = llmConfigFromPatch(p, undefined);
  }
  return node;
}

function applyNodeUpdate(existing: FlowNode, p: FlowPatchNode): FlowNode {
  const updated: FlowNode = { ...existing };
  if (!isBlank(p.type)) updated.type = p.type as FlowNode["type"];
  if (!isBlank(p.label)) updated.label = p.label;
  if (!isBlank(p.systemPrompt)) updated.systemPrompt = p.systemPrompt;
  if (p.tools.length > 0) updated.tools = p.tools;
  if (
    (updated.type === "llm" || updated.type === "classifier") &&
    (!isBlank(p.provider) || !isBlank(p.model) || existing.llm !== undefined)
  ) {
    updated.llm = llmConfigFromPatch(p, existing.llm);
  }
  return updated;
}

/** Applies a `FlowPatch` to a copy of `base`, returning the proposed definition. Pure. */
export function applyFlowPatch(base: FlowDefinition, patch: FlowPatch): FlowDefinition {
  let nodes = [...base.nodes];
  let edges = [...base.edges];

  const updateById = new Map(patch.updateNodes.map((n) => [n.id, n]));
  nodes = nodes.map((n) => {
    const u = updateById.get(n.id);
    return u ? applyNodeUpdate(n, u) : n;
  });

  const removeIds = new Set(patch.removeNodeIds);
  if (removeIds.size > 0) {
    nodes = nodes.filter((n) => !removeIds.has(n.id));
    edges = edges.filter((e) => !removeIds.has(e.source) && !removeIds.has(e.target));
  }

  for (const a of patch.addNodes) nodes.push(buildNode(a));

  if (patch.removeEdges.length > 0) {
    const removeKeys = new Set(patch.removeEdges.map((e) => `${e.source}->${e.target}`));
    edges = edges.filter((e) => !removeKeys.has(`${e.source}->${e.target}`));
  }

  for (const e of patch.addEdges) {
    const edge: FlowEdge = { source: e.source, target: e.target };
    if (!isBlank(e.conditions)) edge.conditions = e.conditions;
    if (!isBlank(e.label)) edge.label = e.label;
    edges.push(edge);
  }

  return { ...base, nodes, edges };
}

// ---------------------------------------------------------------------------
// Orchestration: propose → validate → diff. Never writes anything.
// ---------------------------------------------------------------------------

export interface FlowCopilotSuccess {
  ok: true;
  proposed: FlowDefinition;
  diff: FlowDiff;
  explanation: string;
}

export interface FlowCopilotFailure {
  ok: false;
  /** Human-readable reason (model error, or the proposed patch failed validation). */
  message: string;
  /** Present when the model DID produce a patch but it failed validation. */
  validation?: FlowValidationReport;
}

export type FlowCopilotResult = FlowCopilotSuccess | FlowCopilotFailure;

export interface FlowCopilotOptions {
  /** Abort the model call after this many ms. Default 20000 — patch generation reasons over the whole flow, unlike the guardrail's single-shot classification. */
  timeoutMs?: number;
  knownToolIds?: ReadonlySet<string>;
}

/** Compact, token-frugal textual summary of the current flow for the prompt. */
function describeFlow(def: FlowDefinition): string {
  const nodeLines = def.nodes.map((n) => {
    const bits = [`id=${n.id}`, `type=${n.type}`];
    if (n.label) bits.push(`label=${JSON.stringify(n.label)}`);
    if (n.llm) bits.push(`llm=${n.llm.provider}/${n.llm.model}`);
    if (n.tools && n.tools.length > 0) bits.push(`tools=[${n.tools.join(",")}]`);
    if (n.systemPrompt) bits.push(`systemPrompt=${JSON.stringify(n.systemPrompt.slice(0, 200))}`);
    return `- ${bits.join(", ")}`;
  });
  const edgeLines = def.edges.map((e) => {
    const bits = [`${e.source} -> ${e.target}`];
    if (e.conditions) bits.push(`when ${e.conditions}`);
    return `- ${bits.join(" ")}`;
  });
  return [
    `Flow "${def.id}" (${def.name}):`,
    "Nodes:",
    ...(nodeLines.length > 0 ? nodeLines : ["(none)"]),
    "Edges:",
    ...(edgeLines.length > 0 ? edgeLines : ["(none)"]),
  ].join("\n");
}

/**
 * Generates and validates a flow patch for `instruction`. Bound to a specific
 * {@link LanguageModel} so callers control provider/model selection and tests
 * can inject a fake model — see `flow-copilot.test.ts`.
 */
export async function proposeFlowEdit(
  definition: FlowDefinition,
  instruction: string,
  model: LanguageModel,
  options: FlowCopilotOptions = {},
): Promise<FlowCopilotResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let patch: FlowPatch;
  try {
    const { object } = await generateObject({
      model,
      schema: FLOW_PATCH_SCHEMA,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${describeFlow(definition)}\n\nInstruction: ${instruction.trim().slice(0, 2000)}`,
        },
      ],
      abortSignal: controller.signal,
      temperature: 0.2,
    });
    patch = object;
  } catch (err) {
    return {
      ok: false,
      message: `Copilot request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const proposed = applyFlowPatch(definition, patch);
  const report = validateFlow(proposed, options.knownToolIds);
  if (!report.valid) {
    return {
      ok: false,
      message:
        "The proposed edit would make the flow invalid — nothing was changed. See details below.",
      validation: report,
    };
  }

  return {
    ok: true,
    proposed,
    diff: diffFlows(definition, proposed),
    explanation: patch.explanation,
  };
}
