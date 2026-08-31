// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Parser — Model-Shortcut Resolution
 *
 * Expands a node's `llm: { shortcut: "<name>" }` reference into a concrete
 * `{ provider, model, parameters }` LlmConfig at load time, using the bundle
 * declared in `flows/model-shortcuts.yaml` (credentials + engines + model
 * presets + shortcuts). See that file's header for the layering rationale.
 *
 * Pipeline position: runs INSIDE the flow-parser's variable-resolution step,
 * AFTER `resolveRawFlowVariables` (so a shortcut name supplied via a flow
 * variable — e.g. `model_dispatcher: qwen-local`, referenced as
 * `llm: { shortcut: "{{vars.model_dispatcher}}" }` — is already a literal name)
 * and BEFORE Zod validation (so the expanded, `shortcut`-free LlmConfig is what
 * gets validated and registered).
 *
 * Parameter precedence when expanding (later wins): model-preset params <
 * shortcut params < node-level `parameters`. So a node can still override
 * temperature/maxTokens while inheriting the model's tuning (e.g. qwen's
 * thinking-off params) from the preset.
 *
 * Failure handling mirrors unknown-variable handling: an unknown shortcut /
 * engine / preset is logged to stderr and the `shortcut` key is left in place,
 * so the node fails Zod validation loudly (flow skipped) rather than silently
 * running on a wrong model.
 *
 * No `any` at module boundaries.
 */

import * as fs from "node:fs";
import { parseFlowFile, resolveConfigFile } from "../../util/parse-flow-file.js";

// ---------------------------------------------------------------------------
// Shape of flows/model-shortcuts.yaml (only the fields the resolver needs)
// ---------------------------------------------------------------------------

interface EngineDef {
  /** LLM provider this engine maps to (openai | bedrock | google | …). */
  provider: string;
  /** Declarative credential handle name (documentation only; not used here). */
  credential?: string;
}

interface ModelPrice {
  /** Price per 1,000,000 input tokens. */
  prompt: number;
  /** Price per 1,000,000 output tokens. */
  completion: number;
}

interface ModelPresetDef {
  /** Concrete model id passed to the provider. */
  model: string;
  /** Tuning parameters intrinsic to this model family. */
  parameters?: Record<string, unknown>;
}

interface ShortcutDef {
  /** Engine name (key into `engines`). */
  engine: string;
  /** Model-preset name (key into `modelPresets`). */
  model: string;
  /** Optional extra parameters layered on top of the preset's. */
  parameters?: Record<string, unknown>;
}

export interface ModelShortcutsData {
  engines: Record<string, EngineDef>;
  modelPresets: Record<string, ModelPresetDef>;
  shortcuts: Record<string, ShortcutDef>;
  /** Central prices keyed like FlowDefinition.pricing; flow-local entries win. */
  pricing?: Record<string, ModelPrice>;
}

// ---------------------------------------------------------------------------
// Loading + caching
// ---------------------------------------------------------------------------

/** The reserved base name of the shortcuts file inside the flows directory. */
export const MODEL_SHORTCUTS_BASE = "model-shortcuts";

interface CacheEntry {
  mtimeMs: number;
  data: ModelShortcutsData | null;
}

/** Cache keyed by absolute file path; invalidated automatically on mtime change. */
const cache = new Map<string, CacheEntry>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerces a parsed section into a typed record, tolerating malformed entries. */
function coerceSection<T>(
  section: unknown,
  pick: (entry: Record<string, unknown>) => T | null,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(section)) return out;
  for (const [key, value] of Object.entries(section)) {
    if (!isRecord(value)) continue;
    const picked = pick(value);
    if (picked !== null) out[key] = picked;
  }
  return out;
}

function parseShortcutsData(raw: unknown): ModelShortcutsData {
  const root = isRecord(raw) ? raw : {};
  const engines = coerceSection<EngineDef>(root.engines, (e) =>
    typeof e.provider === "string"
      ? {
          provider: e.provider,
          ...(typeof e.credential === "string"
            ? { credential: e.credential }
            : {}),
        }
      : null,
  );
  const modelPresets = coerceSection<ModelPresetDef>(
    root.modelPresets,
    (p) =>
      typeof p.model === "string"
        ? {
            model: p.model,
            ...(isRecord(p.parameters)
              ? { parameters: p.parameters }
              : {}),
          }
        : null,
  );
  const shortcuts = coerceSection<ShortcutDef>(root.shortcuts, (s) =>
    typeof s.engine === "string" && typeof s.model === "string"
      ? {
          engine: s.engine,
          model: s.model,
          ...(isRecord(s.parameters) ? { parameters: s.parameters } : {}),
        }
      : null,
  );
  const pricing = coerceSection<ModelPrice>(root.pricing, (p) =>
    typeof p.prompt === "number" &&
    Number.isFinite(p.prompt) &&
    p.prompt >= 0 &&
    typeof p.completion === "number" &&
    Number.isFinite(p.completion) &&
    p.completion >= 0
      ? { prompt: p.prompt, completion: p.completion }
      : null,
  );
  return {
    engines,
    modelPresets,
    shortcuts,
    ...(Object.keys(pricing).length > 0 ? { pricing } : {}),
  };
}

/**
 * Loads (and caches by mtime) the model-shortcuts definition from `flowsDir`.
 * Returns `null` when no `model-shortcuts.{yaml,yml,json}` file exists — callers
 * then treat shortcut resolution as a no-op. A parse error is logged and also
 * yields `null` so a broken shortcuts file degrades to "no shortcuts" rather
 * than crashing flow loading.
 */
export function loadModelShortcuts(flowsDir: string): ModelShortcutsData | null {
  const filePath = resolveConfigFile(flowsDir, MODEL_SHORTCUTS_BASE);
  if (filePath === null) return null;

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const cached = cache.get(filePath);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.data;

  let data: ModelShortcutsData | null;
  try {
    data = parseShortcutsData(parseFlowFile(filePath));
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        reason: "Failed to parse model-shortcuts file — ignoring shortcuts",
        file: filePath,
        details: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
    data = null;
  }
  cache.set(filePath, { mtimeMs, data });
  return data;
}

/** Clears the in-memory shortcuts cache (used by tests). */
export function clearModelShortcutsCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function warn(fileName: string, reason: string): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      component: "flow-parser",
      fileName,
      reason,
    })}\n`,
  );
}

/**
 * Expands a single llm-ish object carrying a string `shortcut` in place.
 * On any lookup failure it leaves `shortcut` intact (so Zod rejects the node)
 * and logs a warning. On success it deletes `shortcut` and sets `provider`,
 * `model` and the merged `parameters`.
 */
function expandShortcutObject(
  obj: Record<string, unknown>,
  data: ModelShortcutsData,
  fileName: string,
): void {
  const name = obj.shortcut;
  if (typeof name !== "string") return;

  const shortcut = data.shortcuts[name];
  if (shortcut === undefined) {
    warn(fileName, `Unknown model shortcut "${name}" — leaving unresolved`);
    return;
  }
  const engine = data.engines[shortcut.engine];
  if (engine === undefined) {
    warn(
      fileName,
      `Model shortcut "${name}" references unknown engine "${shortcut.engine}"`,
    );
    return;
  }
  const preset = data.modelPresets[shortcut.model];
  if (preset === undefined) {
    warn(
      fileName,
      `Model shortcut "${name}" references unknown model preset "${shortcut.model}"`,
    );
    return;
  }

  const nodeParams = isRecord(obj.parameters) ? obj.parameters : {};
  // Precedence (later wins): preset < shortcut < node-level parameters.
  const mergedParams: Record<string, unknown> = {
    ...(preset.parameters ?? {}),
    ...(shortcut.parameters ?? {}),
    ...nodeParams,
  };

  delete obj.shortcut;
  obj.provider = engine.provider;
  obj.model = preset.model;
  if (Object.keys(mergedParams).length > 0) {
    obj.parameters = mergedParams;
  }
}

/**
 * Recursively walks a value and expands every object that carries a string
 * `shortcut` key. Deep walk (rather than targeting `llm` explicitly) so all
 * LlmConfig locations are covered uniformly: `node.llm`, `node.overrides[].llm`,
 * `config.plannerLlm` (agent-harness) and `config.mediaTools[].llm`.
 */
function walkAndExpand(
  value: unknown,
  data: ModelShortcutsData,
  fileName: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAndExpand(item, data, fileName);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.shortcut === "string") {
    expandShortcutObject(value, data, fileName);
  }
  for (const key of Object.keys(value)) {
    walkAndExpand(value[key], data, fileName);
  }
}

/**
 * Expands all `llm.shortcut` references in a raw (pre-validation) flow object
 * in place, using the supplied shortcuts data. Only touches `nodes` — edges
 * carry no LlmConfig. A no-op when there are no shortcut references.
 */
export function resolveModelShortcuts(
  raw: Record<string, unknown>,
  data: ModelShortcutsData,
  fileName: string,
): void {
  if (data.pricing !== undefined) {
    raw.pricing = {
      ...data.pricing,
      ...(isRecord(raw.pricing) ? raw.pricing : {}),
    };
  }

  const nodes = raw.nodes;
  if (!Array.isArray(nodes)) return;
  walkAndExpand(nodes, data, fileName);
}
