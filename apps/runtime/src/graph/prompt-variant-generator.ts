// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Prompt variant generator (`src/graph/prompt-variant-generator.ts`)
 *
 * Given a flow definition and a target LLM-node id, asks an LLM to propose N
 * improved system-prompt variants. Each variant is returned as a complete
 * {@link FlowDefinition} clone where only the target node's `systemPrompt`
 * (and optionally `llm.parameters.temperature`) is changed.
 *
 * Why this matters: the system prompt is the single highest-leverage
 * configuration knob for most flow nodes — model, tools and edges are
 * structural and harder to auto-optimize. A small set of LLM-generated
 * paraphrases / rewrites of the system prompt, evaluated by judge-score, is
 * cheap to try and often yields measurable quality gains without any human
 * authoring.
 *
 * The generator is deliberately simple and pure at its boundary (the only I/O
 * is the LLM call), so it is unit-testable with a fake model.
 *
 * No `any` at module boundaries.
 */

import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { FlowDefinition, FlowNode, FlowEdge } from "../types/flow.js";
import { validateFlow } from "./flow-validator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptVariant {
  /** Stable label for this variant, used in reports + canary policy. */
  label: string;
  /** The modified flow definition (only the target node's systemPrompt changes). */
  definition: FlowDefinition;
  /** The new system prompt text. */
  systemPrompt: string;
  /** Optionally adjusted temperature (when the generator suggests one). */
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Structural edits (beyond system-prompt + temperature)
// ---------------------------------------------------------------------------

/**
 * A machine-actionable change to a single node. Every field is optional; only
 * the ones present are applied. This is deliberately a small, safe, node-scoped
 * set of knobs the optimizer/analyzer can propose AND automatically apply:
 * the system prompt, sampling temperature, output-token budget, the model
 * itself (provider/model swap), and the node's tool list. Bigger structural
 * moves (adding/removing nodes) are intentionally out of scope — they can't be
 * auto-validated against production inputs the way an edit to an existing node
 * can, and are better made by a human in the editor.
 */
export interface NodeEdit {
  /** ID of the node this edit targets (must exist in the flow). */
  nodeId: string;
  /** Replacement system prompt (llm/classifier nodes). */
  systemPrompt?: string;
  /** New sampling temperature (0–2). Applied to `llm.parameters.temperature`. */
  temperature?: number;
  /** New max output-token budget. Applied to `llm.parameters.maxTokens`. */
  maxTokens?: number;
  /** Swap the node's model (provider + model). Preserves existing parameters. */
  model?: { provider: string; model: string };
  /** Tool refs to add to the node's `tools` list (deduped). */
  addTools?: string[];
  /** Tool refs to remove from the node's `tools` list. */
  removeTools?: string[];
}

/**
 * A routing/logic change: add or remove an edge between two existing nodes.
 * `conditions` is a routing expression (same grammar as `FlowEdge.conditions`).
 * Edge edits are validated (grammar + reachability + no unconditional cycles)
 * via {@link validateFlow} before a variant built from them is ever evaluated,
 * so a malformed logic change is dropped rather than executed.
 */
export interface EdgeEdit {
  op: "add" | "remove";
  source: string;
  target: string;
  /** Routing condition (only meaningful for `op: "add"`). */
  conditions?: string;
}

/**
 * A structured, self-describing change set over a flow: any mix of node edits
 * and edge (routing) edits. Produced by the trace analyzer and the structural
 * variant generator; consumed by {@link applyStructuralEdit} and the optimizer
 * (both for evaluation and for promotion of a winning variant).
 */
export interface StructuralEdit {
  /** Human-readable summary of what this change set does and why. */
  summary?: string;
  /** Per-node edits. */
  nodes?: NodeEdit[];
  /** Routing/logic edits. */
  edges?: EdgeEdit[];
}

export interface StructuralVariant {
  /** Stable label for this variant, used in reports + canary policy. */
  label: string;
  /** The modified flow definition with the edit applied + `@variant/<label>` id. */
  definition: FlowDefinition;
  /** The structured change set this variant represents (for promotion + display). */
  edit: StructuralEdit;
  /** One-line human summary of the change. */
  summary: string;
}

export interface GenerateStructuralVariantsOptions {
  /** Number of variants to generate. Default 3. */
  count?: number;
  /** Steers what "better" means (same role as the prompt generator's goal). */
  optimizationGoal?: string;
  /**
   * Extra context appended to the prompt — typically a rendered trace analysis
   * (root cause + findings) so the generator proposes fixes grounded in a real
   * failing/slow run rather than guessing.
   */
  analysisContext?: string;
  /**
   * Whitelist of models the generator may swap TO. When empty/omitted, the
   * generator is instructed NOT to change any model (a hallucinated model id
   * would fail at runtime), so model swaps only happen against a vetted list.
   */
  modelCandidates?: Array<{ provider: string; model: string }>;
  /** Allow routing/edge edits. Default false (node-scoped edits only). */
  allowEdgeEdits?: boolean;
  /** Known MCP tool ids — enables tool-reference validation of proposed edits. */
  knownToolIds?: ReadonlySet<string>;
}

export interface GenerateVariantsOptions {
  /** Number of variants to generate. Default 3. */
  count?: number;
  /**
   * Extra context given to the generator LLM to steer what "better" means,
   * e.g. "Improve factual precision for legal German text" or
   * "Make responses shorter and more direct."
   */
  optimizationGoal?: string;
  /**
   * When true the generator may also suggest a temperature change alongside the
   * prompt rewrite (e.g. lower temperature for fact-heavy nodes). Default false.
   */
  suggestTemperature?: boolean;
}

// ---------------------------------------------------------------------------
// Schema for the structured LLM response
// ---------------------------------------------------------------------------

const VariantObjectSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Short, unique label for this variant (e.g. 'more-direct', 'formal-de', 'concise').",
    ),
  systemPrompt: z
    .string()
    .min(10)
    .max(65_536)
    .describe(
      "The complete revised system prompt. Must be a full, self-contained instruction.",
    ),
  reasoning: z
    .string()
    .describe(
      "Brief explanation of what was changed and why this should improve quality.",
    ),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe(
      "Optional temperature suggestion if you believe changing it would help. Omit to keep the current value.",
    ),
});

const VariantsResponseSchema = z.object({
  variants: z
    .array(VariantObjectSchema)
    .min(1)
    .max(10)
    .describe("Array of distinct system-prompt variants."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTargetNode(
  flow: FlowDefinition,
  nodeId: string,
): FlowNode | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

/**
 * Returns a deep clone of `flow` with `targetNodeId`'s `systemPrompt` (and
 * optionally `temperature`) replaced. The flow `id` gets a `@variant/<label>`
 * suffix so it is keyed distinctly in graph/monitoring caches.
 */
export function applyVariant(
  flow: FlowDefinition,
  targetNodeId: string,
  systemPrompt: string,
  label: string,
  temperature?: number,
): FlowDefinition {
  const nodes = flow.nodes.map((node) => {
    if (node.id !== targetNodeId) return node;
    return {
      ...node,
      systemPrompt,
      ...(temperature !== undefined && node.llm !== undefined
        ? {
            llm: {
              ...node.llm,
              parameters: {
                ...(node.llm.parameters ?? {}),
                temperature,
              },
            },
          }
        : {}),
    };
  });
  return {
    ...flow,
    id: `${flow.id}@variant/${label}`,
    nodes,
  };
}

// ---------------------------------------------------------------------------
// Structural edit application (pure)
// ---------------------------------------------------------------------------

/** Applies one {@link NodeEdit} to a node, returning a new node (pure). */
function applyNodeEdit(node: FlowNode, edit: NodeEdit): FlowNode {
  let next: FlowNode = { ...node };

  if (edit.systemPrompt !== undefined) {
    next = { ...next, systemPrompt: edit.systemPrompt };
  }

  // Model swap and parameter tweaks both touch `llm`. Build the llm object
  // once so a variant that changes model AND temperature keeps both.
  const wantsLlmChange =
    edit.model !== undefined ||
    edit.temperature !== undefined ||
    edit.maxTokens !== undefined;
  if (wantsLlmChange) {
    const baseLlm = next.llm;
    const provider = edit.model?.provider ?? baseLlm?.provider;
    const model = edit.model?.model ?? baseLlm?.model;
    // A parameter-only edit on a node with no llm config has nowhere to live —
    // skip it rather than fabricate an invalid (provider/model-less) llm block.
    if (provider !== undefined && model !== undefined) {
      const parameters = { ...(baseLlm?.parameters ?? {}) };
      if (edit.temperature !== undefined)
        parameters.temperature = edit.temperature;
      if (edit.maxTokens !== undefined) parameters.maxTokens = edit.maxTokens;
      // `provider` is validated as a configured provider name by validateFlow before
      // the resulting variant is ever executed, so the cast here is safe: an
      // invalid provider produces a variant that is dropped at validation time.
      const nextLlm = {
        ...(baseLlm ?? {}),
        provider,
        model,
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      } as NonNullable<FlowNode["llm"]>;
      next = { ...next, llm: nextLlm };
    }
  }

  if (edit.addTools !== undefined || edit.removeTools !== undefined) {
    const remove = new Set(edit.removeTools ?? []);
    const merged = [
      ...(next.tools ?? []).filter((t) => !remove.has(t)),
      ...(edit.addTools ?? []),
    ];
    // Dedupe while preserving order.
    next = { ...next, tools: [...new Set(merged)] };
  }

  return next;
}

/**
 * Applies a {@link StructuralEdit} to a flow, returning a new definition (pure).
 * Node edits are matched by id (unknown ids are ignored); edge edits add/remove
 * edges by (source, target). The flow `id` is unchanged — use
 * {@link applyStructuralVariant} when you need a distinctly-keyed variant.
 */
export function applyStructuralEdit(
  flow: FlowDefinition,
  edit: StructuralEdit,
): FlowDefinition {
  const nodeEditsById = new Map<string, NodeEdit>();
  for (const ne of edit.nodes ?? []) nodeEditsById.set(ne.nodeId, ne);

  const nodes = flow.nodes.map((node) => {
    const ne = nodeEditsById.get(node.id);
    return ne === undefined ? node : applyNodeEdit(node, ne);
  });

  let edges: FlowEdge[] = [...flow.edges];
  for (const ee of edit.edges ?? []) {
    if (ee.op === "remove") {
      edges = edges.filter(
        (e) => !(e.source === ee.source && e.target === ee.target),
      );
    } else {
      // add — replace any existing edge with the same endpoints so re-adding
      // with a new condition is an update rather than a duplicate.
      edges = edges.filter(
        (e) => !(e.source === ee.source && e.target === ee.target),
      );
      edges.push({
        source: ee.source,
        target: ee.target,
        ...(ee.conditions !== undefined && ee.conditions.trim().length > 0
          ? { conditions: ee.conditions }
          : {}),
      });
    }
  }

  return { ...flow, nodes, edges };
}

/**
 * Like {@link applyStructuralEdit} but also suffixes the flow id with
 * `@variant/<label>` so the variant is keyed distinctly in graph/monitoring
 * caches — the structural analogue of {@link applyVariant}.
 */
export function applyStructuralVariant(
  flow: FlowDefinition,
  edit: StructuralEdit,
  label: string,
): FlowDefinition {
  const applied = applyStructuralEdit(flow, edit);
  return { ...applied, id: `${flow.id}@variant/${label}` };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert prompt engineer for LLM-based agent flows.
Your task: given the current system prompt of an agent node, generate improved variants.
Each variant must be a COMPLETE, SELF-CONTAINED system prompt (not a diff or comment).
Focus on clarity, precision, and the stated optimization goal.
Make each variant meaningfully different from the others — no superficial rephrasing.`;

/**
 * Generates N improved system-prompt variants for `targetNodeId` in `flow`
 * using the given `model`. Returns a list of complete {@link PromptVariant}s,
 * each ready to be evaluated or promoted.
 *
 * Fails gracefully: if the LLM returns fewer variants than requested, those
 * that were returned are used. If the call errors, the error propagates so the
 * optimizer can log it and skip this cycle.
 */
export async function generatePromptVariants(
  flow: FlowDefinition,
  targetNodeId: string,
  model: LanguageModel,
  options: GenerateVariantsOptions = {},
): Promise<PromptVariant[]> {
  const count = Math.min(10, Math.max(1, options.count ?? 3));
  const targetNode = findTargetNode(flow, targetNodeId);

  const currentPrompt = targetNode?.systemPrompt ?? "(no system prompt set)";
  const nodeInfo = targetNode
    ? `Node type: ${targetNode.type}, label: ${targetNode.label ?? targetNode.id}`
    : `Node "${targetNodeId}" (not found in flow — variants will be applied to a new node)`;

  const goal = options.optimizationGoal
    ? `\n\nOptimization goal: ${options.optimizationGoal}`
    : "";
  const tempNote = options.suggestTemperature
    ? "\nYou may also suggest a temperature adjustment if appropriate."
    : "";

  const prompt =
    `Flow: "${flow.name}" (id: ${flow.id})\n` +
    `${nodeInfo}\n\n` +
    `Current system prompt:\n"""\n${currentPrompt}\n"""\n` +
    goal +
    tempNote +
    `\n\nGenerate exactly ${count} distinct improved variants.`;

  const { object } = await generateObject({
    model,
    schema: VariantsResponseSchema,
    system: SYSTEM_PROMPT,
    prompt,
    temperature: 0.7, // A bit of creativity is appropriate here.
  });

  return object.variants.map((v) => ({
    label: v.label,
    systemPrompt: v.systemPrompt,
    ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
    definition: applyVariant(
      flow,
      targetNodeId,
      v.systemPrompt,
      v.label,
      v.temperature,
    ),
  }));
}

// ---------------------------------------------------------------------------
// Structural variant generator
// ---------------------------------------------------------------------------

const NodeEditSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .describe("ID of an EXISTING node in the flow to modify."),
  systemPrompt: z
    .string()
    .min(1)
    .max(65_536)
    .optional()
    .describe("Complete replacement system prompt (llm/classifier nodes)."),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("New sampling temperature (0–2)."),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .max(65_536)
    .optional()
    .describe("New max output-token budget."),
  model: z
    .object({ provider: z.string().min(1), model: z.string().min(1) })
    .optional()
    .describe(
      "Swap the node's model. ONLY use a provider/model from the allowed list.",
    ),
  addTools: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Tool refs to add to the node."),
  removeTools: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Tool refs to remove from the node."),
});

const EdgeEditSchema = z.object({
  op: z.enum(["add", "remove"]),
  source: z.string().min(1).describe("Source node id (must exist)."),
  target: z.string().min(1).describe("Target node id (must exist)."),
  conditions: z
    .string()
    .max(1024)
    .optional()
    .describe("Routing condition expression (for op:add)."),
});

const StructuralVariantObjectSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(64)
    .describe("Short, unique label (e.g. 'cheaper-model', 'add-rerank')."),
  summary: z
    .string()
    .min(1)
    .describe("One line: what this variant changes and why it should help."),
  nodeEdits: z
    .array(NodeEditSchema)
    .max(20)
    .optional()
    .describe("Per-node changes."),
  edgeEdits: z
    .array(EdgeEditSchema)
    .max(20)
    .optional()
    .describe("Routing/logic changes (only if allowed)."),
});

const StructuralVariantsResponseSchema = z.object({
  variants: z.array(StructuralVariantObjectSchema).min(1).max(10),
});

const STRUCTURAL_SYSTEM_PROMPT = `You are an expert optimizer for LLM-based agent flows.
Given a flow's structure (its nodes, models, prompts, tools and edges) and — when provided — an analysis of a real execution trace, propose distinct improved variants.
Each variant is a set of EDITS to EXISTING nodes and/or edges. Do NOT invent new node ids.
You may change: system prompts, temperature, maxTokens, the model (ONLY from the allowed list), and the tool list. If edge edits are allowed you may also add/remove routing edges.
Prefer the smallest change that plausibly fixes the observed problem or improves the stated goal. Make variants meaningfully different from each other.`;

/** Compact, token-bounded textual description of a flow's structure. */
function describeFlowStructure(flow: FlowDefinition): string {
  const nodeLines = flow.nodes.map((n) => {
    const model =
      n.llm !== undefined ? `${n.llm.provider}/${n.llm.model}` : "(inherited)";
    const temp = n.llm?.parameters?.temperature;
    const tools =
      n.tools !== undefined && n.tools.length > 0
        ? ` tools=[${n.tools.join(", ")}]`
        : "";
    const prompt =
      n.systemPrompt !== undefined
        ? ` prompt="${n.systemPrompt.slice(0, 200).replace(/\s+/g, " ")}${n.systemPrompt.length > 200 ? "…" : ""}"`
        : "";
    return `  - ${n.id} [${n.type}] model=${model}${temp !== undefined ? ` temp=${temp}` : ""}${tools}${prompt}`;
  });
  const edgeLines =
    flow.edges.length > 0
      ? flow.edges.map(
          (e) =>
            `  - ${e.source} → ${e.target}${e.conditions !== undefined ? ` when(${e.conditions})` : ""}`,
        )
      : ["  (no edges — single entry node)"];
  return `Nodes:\n${nodeLines.join("\n")}\n\nEdges:\n${edgeLines.join("\n")}`;
}

/**
 * Generates N structural variants of `flow` using `model`. Each variant is a
 * validated {@link StructuralVariant} (invalid ones — bad provider, unknown
 * node id, routing that breaks reachability or introduces an unconditional
 * cycle — are dropped rather than returned). The error propagates only when the
 * underlying LLM call itself fails, so the optimizer can log and skip a cycle.
 */
export async function generateStructuralVariants(
  flow: FlowDefinition,
  model: LanguageModel,
  options: GenerateStructuralVariantsOptions = {},
): Promise<StructuralVariant[]> {
  const count = Math.min(10, Math.max(1, options.count ?? 3));
  const allowEdges = options.allowEdgeEdits ?? false;

  const modelList =
    options.modelCandidates !== undefined &&
    options.modelCandidates.length > 0
      ? `\n\nAllowed models (provider/model) you may swap TO:\n${options.modelCandidates
          .map((m) => `  - ${m.provider}/${m.model}`)
          .join("\n")}`
      : "\n\nDo NOT change any node's model (no model list was provided).";

  const goal = options.optimizationGoal
    ? `\n\nOptimization goal: ${options.optimizationGoal}`
    : "";
  const analysis = options.analysisContext
    ? `\n\nExecution-trace analysis:\n${options.analysisContext}`
    : "";
  const edgeNote = allowEdges
    ? "\n\nYou MAY propose edge edits (routing/logic changes)."
    : "\n\nDo NOT propose edge edits — only node-level changes.";

  const prompt =
    `Flow: "${flow.name}" (id: ${flow.id})\n\n` +
    `${describeFlowStructure(flow)}` +
    modelList +
    goal +
    analysis +
    edgeNote +
    `\n\nGenerate exactly ${count} distinct improved variants.`;

  const { object } = await generateObject({
    model,
    schema: StructuralVariantsResponseSchema,
    system: STRUCTURAL_SYSTEM_PROMPT,
    prompt,
    temperature: 0.7,
  });

  const allowedModels = new Set(
    (options.modelCandidates ?? []).map((m) => `${m.provider}/${m.model}`),
  );

  const out: StructuralVariant[] = [];
  const seenLabels = new Set<string>();
  for (const v of object.variants) {
    // Enforce the model whitelist defensively (the LLM may ignore the prompt).
    const nodeEdits = (v.nodeEdits ?? []).map((ne) => {
      if (
        ne.model !== undefined &&
        !allowedModels.has(`${ne.model.provider}/${ne.model.model}`)
      ) {
        const { model: _dropped, ...rest } = ne;
        return rest;
      }
      return ne;
    });
    const edgeEdits = allowEdges ? (v.edgeEdits ?? []) : [];

    const edit: StructuralEdit = {
      summary: v.summary,
      ...(nodeEdits.length > 0 ? { nodes: nodeEdits } : {}),
      ...(edgeEdits.length > 0 ? { edges: edgeEdits } : {}),
    };

    // A no-op variant (all edits stripped) is useless — skip it.
    if (
      (edit.nodes === undefined || edit.nodes.length === 0) &&
      (edit.edges === undefined || edit.edges.length === 0)
    ) {
      continue;
    }

    // Ensure a unique, non-colliding label.
    let label = v.label;
    let n = 2;
    while (seenLabels.has(label)) label = `${v.label}-${n++}`;

    const definition = applyStructuralVariant(flow, edit, label);

    // Validate the produced definition; drop structurally-invalid variants.
    const report = validateFlow(definition, options.knownToolIds);
    if (!report.valid) continue;

    seenLabels.add(label);
    out.push({ label, definition, edit, summary: v.summary });
  }

  return out;
}
