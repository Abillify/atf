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
import {
  catalogPromptReference,
  relevantNodeTypes,
  nodeTypeDoc,
  COMMON_CONFIG_FIELDS,
} from "./node-type-catalog.js";

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
  /** Model shortcut (flows/model-shortcuts.yaml) or "" for no change. */
  shortcut: string;
  /**
   * Object deep-merged into `node.config` (a null value deletes a key); empty
   * object = no change. A real nested object in the schema, NOT JSON in a
   * string: small models asked to escape JSON inside JSON leak brackets across
   * the boundary (observed: `"{\"maxToolSteps\": 10}]}], "`). Strings are still
   * accepted and repaired for models/providers without schema support.
   */
  configPatch: Record<string, unknown> | string;
  /** Other top-level node fields to set (parallelNodes, …); empty object = none. */
  fields: Record<string, unknown> | string;
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
        "Node type: llm, tool, router, classifier, parallel, retrieval, memory, agent-harness, transform, trigger, assistant-context or assistant-learn. Leave unchanged (repeat the existing value) on update.",
    },
    label: { type: "string", description: "Display label, or empty string for no change / none." },
    provider: {
      type: "string",
      description:
        "Configured provider name — only when no shortcut fits and the user named one. Empty string otherwise (the node then uses the platform default model).",
    },
    model: { type: "string", description: "LLM model id — only for llm/classifier nodes. Empty string if not applicable / no change." },
    systemPrompt: { type: "string", description: "System prompt override, or empty string for no change / none." },
    tools: { type: "array", items: { type: "string" }, description: "MCP tool ids this node may call, or empty array for no change / none. Use exact ids from the tool list." },
    shortcut: {
      type: "string",
      description: "Model shortcut name from the shortcut list (preferred over provider/model), or empty string for no change / default model.",
    },
    configPatch: {
      type: "object",
      additionalProperties: true,
      description:
        "Settings merged into the node's `config` (nested objects merge, a null value removes that key), using ONLY keys documented for this node type, e.g. {\"maxToolSteps\": 10}. Empty object {} for no config change.",
    },
    fields: {
      type: "object",
      additionalProperties: true,
      description:
        "Other node fields to set: parallelNodes, classifierSchema, priority, overrides. Empty object {} for none.",
    },
  },
  required: ["id", "type", "label", "provider", "model", "systemPrompt", "tools", "shortcut", "configPatch", "fields"],
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
never a full copy of the flow. Prefer the smallest patch that satisfies the instruction.

Nodes are configured through their \`config\` object: to change settings of a node, put it \
in updateNodes with configPatch (an object merged into the existing config; a null \
value removes a key). Use ONLY the config keys documented below for that node type, with the \
documented value shapes. Tool ids must come from the tool list; model choices should use a \
shortcut from the shortcut list — never invent provider or model names. Leave provider/model \
empty unless the user explicitly asked for one. Only include config keys you actually change; \
do not repeat keys with empty values.

A \`tool\` node calls exactly the tools in its \`tools\` list with the arguments in \
config.toolArgs — when you configure a tool for it, put the tool id in \`tools\` AND its \
arguments in toolArgs. For an \`llm\` node, toolArgs only pins arguments of tools it already \
lists. Example values in the reference are illustrations, not defaults: never copy them. \
When a required value is unknown (for instance which collection to search), choose the most \
plausible one from the flow and the instruction and name the assumption in the explanation.

If the instruction is vague (e.g. "make it better", "optimise"), propose at most ONE small, \
clearly justified change and list further ideas only in the explanation. Never remove tools, \
nodes or edges, and never rewrite prompts, unless the user asked for exactly that.

Edge "conditions" are expressions like classification.route == 'INKASSO' evaluated against \
the run state. Every node id you reference must either already exist in the current flow or \
be one you are adding in this same patch. Use empty string / empty array to mean "no change" \
(update) or "use the platform default" (add). If the instruction is ambiguous about a value \
(e.g. a collection name), use the most plausible value from the context and say so in the \
explanation instead of returning an empty patch.`;

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/**
 * The model change a patch asks for, or undefined for "leave as is". Nothing
 * is invented: a node the patch doesn't give a model keeps its own — or none,
 * which means the runtime's DEFAULT_LLM.
 */
function llmFromPatch(
  p: FlowPatchNode,
  existing: LlmConfig | undefined,
): LlmConfig | undefined {
  const params = existing?.parameters !== undefined ? { parameters: existing.parameters } : {};
  const shortcut = (p.shortcut ?? "").trim();
  if (shortcut !== "") {
    return { shortcut, ...params } as unknown as LlmConfig;
  }
  const provider = !isBlank(p.provider) && isKnownProviderName(p.provider) ? p.provider : undefined;
  const model = !isBlank(p.model) ? p.model : undefined;
  if (provider === undefined && model === undefined) return undefined;
  const base = existing as (LlmConfig & { shortcut?: string }) | undefined;
  return {
    provider: provider ?? base?.provider ?? "",
    model: model ?? base?.model ?? "",
    ...params,
  } as LlmConfig;
}

/** Thrown for a patch whose JSON fields don't parse — reported to the user. */
class PatchJsonError extends Error {}

/**
 * Extracts the first balanced `{…}` from `text` (string-aware), for models that
 * leak trailing structure into a JSON string value.
 */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

function parsePatchObject(
  raw: Record<string, unknown> | string | undefined,
  what: string,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object") {
    if (Array.isArray(raw)) throw new PatchJsonError(`${what} must be an object`);
    return Object.keys(raw).length > 0 ? raw : undefined;
  }
  const text = raw.trim();
  if (text === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const candidate = firstJsonObject(text);
    try {
      parsed = candidate !== undefined ? JSON.parse(candidate) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      throw new PatchJsonError(`${what} is not valid JSON: ${text.slice(0, 120)}`);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PatchJsonError(`${what} must be a JSON object`);
  }
  return Object.keys(parsed).length > 0 ? (parsed as Record<string, unknown>) : undefined;
}

/** Deep merge for config patches: objects merge, null deletes, arrays/scalars replace. */
function mergeConfig(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    // Models tend to echo every documented key with an empty value; only an
    // explicit null removes a key, empties mean "leave as is".
    if (
      v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
    ) {
      continue;
    }
    if (v === null) {
      delete out[k];
    } else if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = mergeConfig(out[k] as Record<string, unknown>, v as Record<string, unknown>) ?? {};
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const SETTABLE_FIELDS = new Set(["parallelNodes", "classifierSchema", "priority", "overrides"]);

function applyExtras(node: FlowNode, p: FlowPatchNode): FlowNode {
  let out = node;
  let configPatch = parsePatchObject(p.configPatch, `configPatch of "${p.id}"`);
  // Only documented keys: a model tends to mirror other patch fields into the
  // config (e.g. `shortcut`), which the runtime would silently ignore. Plugin
  // types without a catalog entry keep whatever the model sets.
  const doc = nodeTypeDoc(String(node.type));
  if (configPatch !== undefined && doc !== undefined) {
    const allowed = new Set([...doc.config, ...COMMON_CONFIG_FIELDS].map((f) => f.key));
    const kept = Object.fromEntries(Object.entries(configPatch).filter(([k]) => allowed.has(k)));
    configPatch = Object.keys(kept).length > 0 ? kept : undefined;
  }
  if (configPatch !== undefined) {
    const config = mergeConfig(node.config, configPatch);
    const { config: _old, ...rest } = out;
    void _old;
    out = (config !== undefined ? { ...rest, config } : rest) as FlowNode;
  }
  const fields = parsePatchObject(p.fields, `fields of "${p.id}"`);
  if (fields !== undefined) {
    for (const [k, v] of Object.entries(fields)) {
      if (SETTABLE_FIELDS.has(k)) out = { ...out, [k]: v } as FlowNode;
    }
  }
  return out;
}

function buildNode(p: FlowPatchNode): FlowNode {
  const node: FlowNode = { id: p.id, type: p.type as FlowNode["type"] };
  if (!isBlank(p.label)) node.label = p.label;
  if (!isBlank(p.systemPrompt)) node.systemPrompt = p.systemPrompt;
  if (p.tools.length > 0) node.tools = p.tools;
  const llm = llmFromPatch(p, undefined);
  if (llm !== undefined) node.llm = llm;
  return applyExtras(node, p);
}

function applyNodeUpdate(existing: FlowNode, p: FlowPatchNode): FlowNode {
  const updated: FlowNode = { ...existing };
  if (!isBlank(p.type)) updated.type = p.type as FlowNode["type"];
  if (!isBlank(p.label)) updated.label = p.label;
  if (!isBlank(p.systemPrompt)) updated.systemPrompt = p.systemPrompt;
  if (p.tools.length > 0) updated.tools = p.tools;
  const llm = llmFromPatch(p, existing.llm);
  if (llm !== undefined) updated.llm = llm;
  return applyExtras(updated, p);
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
  /**
   * Expands a source-form definition (model shortcuts, `{{vars.*}}`, prompt
   * includes) before validation. The proposal itself stays in source form so
   * accepting it doesn't bake the expansion into the flow.
   */
  expand?: (definition: FlowDefinition) => unknown;
  /** Model shortcut names the flow may reference (flows/model-shortcuts.yaml). */
  shortcuts?: readonly string[];
}

/**
 * JSON for the prompt that keeps EVERY key visible and shortens only long
 * leaves (strings, arrays) — cutting the serialized text instead hid whole
 * settings, and the model then "enabled" options that were already on.
 */
function compactJson(value: unknown): string {
  const shorten = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return v.length > 160 ? `${v.slice(0, 160)}…` : v;
    if (Array.isArray(v)) {
      const items = v.slice(0, 12).map((x) => shorten(x, depth + 1));
      return v.length > 12 ? [...items, `…(+${v.length - 12} more)`] : items;
    }
    if (v !== null && typeof v === "object") {
      if (depth > 5) return "{…}";
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shorten(x, depth + 1)]),
      );
    }
    return v;
  };
  return JSON.stringify(shorten(value, 0));
}

/** Compact, token-frugal textual summary of the current flow for the prompt. */
function describeFlow(def: FlowDefinition): string {
  const nodeLines = def.nodes.map((n) => {
    const bits = [`id=${n.id}`, `type=${n.type}`];
    if (n.label) bits.push(`label=${JSON.stringify(n.label)}`);
    const shortcut = (n.llm as { shortcut?: string } | undefined)?.shortcut;
    if (shortcut) bits.push(`llm.shortcut=${shortcut}`);
    else if (n.llm) bits.push(`llm=${n.llm.provider}/${n.llm.model}`);
    if (n.tools && n.tools.length > 0) bits.push(`tools=[${n.tools.join(",")}]`);
    if (n.systemPrompt) bits.push(`systemPrompt=${JSON.stringify(n.systemPrompt.slice(0, 200))}`);
    if (n.parallelNodes && n.parallelNodes.length > 0) bits.push(`parallelNodes=${JSON.stringify(n.parallelNodes)}`);
    if (n.config && Object.keys(n.config).length > 0) {
      bits.push(`config=${compactJson(n.config)}`);
    }
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
  // Local models need longer for a patch over a large flow + catalog.
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const userPrompt = [
    describeFlow(definition),
    "",
    "Node type reference (config keys per type):",
    catalogPromptReference(
      relevantNodeTypes(
        definition.nodes.map((n) => n.type),
        instruction,
      ),
    ),
    "",
    `Available tools: ${
      options.knownToolIds && options.knownToolIds.size > 0
        ? [...options.knownToolIds].sort().join(", ")
        : "(unknown — keep tool ids the flow already uses)"
    }`,
    `Available model shortcuts: ${
      options.shortcuts && options.shortcuts.length > 0
        ? options.shortcuts.join(", ")
        : "(none)"
    }`,
    "",
    `Instruction: ${instruction.trim().slice(0, 2000)}`,
  ].join("\n");

  type Message = { role: "user" | "assistant"; content: string };
  const messages: Message[] = [{ role: "user", content: userPrompt }];

  /** One model call; a failure is returned as a result, not thrown. */
  const ask = async (): Promise<FlowPatch | FlowCopilotFailure> => {
    try {
      const { object } = await generateObject({
        model,
        schema: FLOW_PATCH_SCHEMA,
        system: SYSTEM_PROMPT,
        messages,
        abortSignal: controller.signal,
        temperature: 0.2,
      });
      return object;
    } catch (err) {
      return {
        ok: false,
        message: `Copilot request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  /** Applies + validates a patch: the proposal, or what went wrong. */
  const check = (
    patch: FlowPatch,
  ): { proposed: FlowDefinition } | { problem: string; validation?: FlowValidationReport } => {
    let proposed: FlowDefinition;
    try {
      proposed = applyFlowPatch(definition, patch);
    } catch (err) {
      if (err instanceof PatchJsonError) return { problem: err.message };
      throw err;
    }
    const report = validateFlow(
      options.expand ? options.expand(proposed) : proposed,
      options.knownToolIds,
    );
    return report.valid ? { proposed } : { problem: "validation failed", validation: report };
  };

  // At most one repair round: the model sees exactly why its patch was
  // rejected and gets a chance to fix it before the operator sees an error.
  let patch: FlowPatch | undefined;
  let outcome: ReturnType<typeof check> | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await ask();
      if ("ok" in answer) return answer;
      patch = answer;
      outcome = check(answer);
      if ("proposed" in outcome) break;
      const reasons =
        outcome.validation?.errors.map((e) => `- ${e.path}: ${e.message}`).join("\n") ??
        `- ${outcome.problem}`;
      messages.push(
        { role: "assistant", content: JSON.stringify(answer) },
        {
          role: "user",
          content: `That patch was rejected:\n${reasons}\nReturn a corrected patch. Change only what is needed to fix these problems (use documented config keys and value shapes; drop a change you can't make valid).`,
        },
      );
    }
  } finally {
    clearTimeout(timer);
  }

  if (patch === undefined || outcome === undefined || !("proposed" in outcome)) {
    const failed = outcome as { problem: string; validation?: FlowValidationReport } | undefined;
    return {
      ok: false,
      message: failed?.validation
        ? "The proposed edit would make the flow invalid — nothing was changed (also after one automatic correction). See details below."
        : `The copilot produced an unusable patch: ${failed?.problem ?? "no answer"}`,
      ...(failed?.validation ? { validation: failed.validation } : {}),
    };
  }
  const proposed = outcome.proposed;
  const diff = diffFlows(definition, proposed);
  if (!diff.changed) {
    // An empty proposal with a confident explanation ("I enabled X") is
    // misleading — usually X was already set. Say so instead of offering an
    // Accept that does nothing.
    return {
      ok: false,
      message: `No change: the proposal leaves the flow exactly as it is (the setting may already be like that). The copilot said: ${patch.explanation.slice(0, 400)}`,
    };
  }

  return {
    ok: true,
    proposed,
    diff,
    explanation: patch.explanation,
  };
}
