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
 * POOL shortcuts: besides a plain `engine` + `model` pair, a shortcut may be a
 * pool — an ordered list of members, each either a concrete `engine` + `model`
 * pair (optionally with extra `parameters`) or a reference to ANOTHER shortcut.
 * A referenced shortcut that is itself a pool is kept as a NESTED sub-pool
 * (a candidate carrying its own `pool`) rather than flattened, so the inner
 * strategy survives: an outer `"fallback"` pool can hold an inner
 * `"round-robin"` sub-pool as its primary member and only fall through to the
 * next outer member when the whole sub-pool is unavailable. A pool carries a
 * `strategy` (`"fallback"`, `"round-robin"`, `"weighted-round-robin"`,
 * `"random"`, `"weighted-random"`, `"least-used"`). Expansion writes the FIRST
 * LEAF into the node's `provider`/`model`/`parameters` and attaches a
 * `pool: { strategy, candidates }` (candidates may themselves carry a nested
 * `pool`) that the `llm` / `classifier` handlers use for selection at runtime.
 *
 * Failure handling mirrors unknown-variable handling: an unknown shortcut /
 * engine / preset is logged to stderr and the `shortcut` key is left in place,
 * so the node fails Zod validation loudly (flow skipped) rather than silently
 * running on a wrong model. The same applies to malformed pools (unknown
 * member, cyclic reference, empty member list).
 *
 * No `any` at module boundaries.
 */

import * as fs from "node:fs";
import type {
  LlmConfig,
  LlmPoolStickiness,
  LlmPoolStrategy,
} from "../../types/flow.js";
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
  /** Characters-per-token estimate intrinsic to this model family. */
  charsPerToken?: number;
}

/**
 * A plain shortcut: one engine + one model preset (+ optional extra params).
 * Structurally distinguished from {@link PoolShortcutDef} by the presence of
 * `engine`/`model` (single) versus `members` (pool) — no discriminant tag, so
 * callers and tests construct the natural shape directly.
 */
interface SingleShortcutDef {
  /** Engine name (key into `engines`). */
  engine: string;
  /** Model-preset name (key into `modelPresets`). */
  model: string;
  /** Optional extra parameters layered on top of the preset's. */
  parameters?: Record<string, unknown>;
  /** Overrides the preset's characters-per-token estimate. */
  charsPerToken?: number;
}

/** One member of a pool shortcut: a concrete pair or a reference to another shortcut. */
interface PoolMemberDef {
  /** Reference to another shortcut (single or pool; pools are flattened). */
  shortcut?: string;
  /** Concrete engine name (key into `engines`). Set together with `model`. */
  engine?: string;
  /** Concrete model-preset name (key into `modelPresets`). */
  model?: string;
  /** Optional extra parameters layered on top of the preset's. */
  parameters?: Record<string, unknown>;
  /** Overrides the preset's/pool's characters-per-token estimate. */
  charsPerToken?: number;
  /** Optional relative selection weight. */
  weight?: number;
}

/** A pool shortcut: ordered members + a selection strategy. */
interface PoolShortcutDef {
  /** Selection strategy; `"fallback"` when omitted. */
  strategy: LlmPoolStrategy;
  /** Prefix-cache stickiness; omitted = `"none"`. */
  sticky?: LlmPoolStickiness;
  /** Ordered members (>= 1 after parsing). */
  members: PoolMemberDef[];
  /**
   * Pool-level parameters, layered onto EVERY leaf of this pool (including the
   * leaves of nested sub-pool members). Precedence, later wins:
   *   preset < THIS pool's params < nested/inner pool params < member params <
   *   node-level params.
   * So an outer pool can set e.g. `extraBody.repeat_penalty` once for all its
   * members, an inner pool can override it, and a node can still override both.
   */
  parameters?: Record<string, unknown>;
  /**
   * Pool-level characters-per-token estimate layered onto every leaf; a
   * member's or the node's own value wins over it.
   */
  charsPerToken?: number;
}

type ShortcutDef = SingleShortcutDef | PoolShortcutDef;

/** Type guard: a shortcut is a pool when it carries a member list. */
function isPoolShortcut(s: ShortcutDef): s is PoolShortcutDef {
  return "members" in s;
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

/** Reads an optional chars-per-token value (1.0–8.0); malformed values drop. */
function readCharsPerToken(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 8
    ? value
    : undefined;
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
            ...(readCharsPerToken(p.charsPerToken) !== undefined
              ? { charsPerToken: readCharsPerToken(p.charsPerToken) }
              : {}),
          }
        : null,
  );
  const shortcuts = coerceSection<ShortcutDef>(root.shortcuts, (s) => {
    // Pool form: `pool:` is either a bare member list or `{ strategy, members }`.
    if (s.pool !== undefined) {
      const poolSource = isRecord(s.pool) ? s.pool : undefined;
      const rawMembers = Array.isArray(s.pool)
        ? s.pool
        : Array.isArray(poolSource?.members)
          ? poolSource.members
          : null;
      if (rawMembers === null) return null;
      const validStrategies: LlmPoolStrategy[] = [
        "fallback",
        "round-robin",
        "weighted-round-robin",
        "random",
        "weighted-random",
        "least-used",
      ];
      const strategy = validStrategies.includes(
        poolSource?.strategy as LlmPoolStrategy,
      )
        ? (poolSource?.strategy as LlmPoolStrategy)
        : "fallback";
      const validStickies: LlmPoolStickiness[] = [
        "none",
        "execution",
        "conversation",
      ];
      const sticky = validStickies.includes(
        poolSource?.sticky as LlmPoolStickiness,
      )
        ? (poolSource?.sticky as LlmPoolStickiness)
        : undefined;
      const members: PoolMemberDef[] = [];
      for (const rawMember of rawMembers) {
        if (!isRecord(rawMember)) continue;
        if (typeof rawMember.shortcut === "string") {
          members.push({
            shortcut: rawMember.shortcut,
            ...(typeof rawMember.weight === "number" &&
            Number.isFinite(rawMember.weight) &&
            rawMember.weight > 0
              ? { weight: rawMember.weight }
              : {}),
          });
          continue;
        }
        if (
          typeof rawMember.engine === "string" &&
          typeof rawMember.model === "string"
        ) {
          members.push({
            engine: rawMember.engine,
            model: rawMember.model,
            ...(isRecord(rawMember.parameters)
              ? { parameters: rawMember.parameters }
              : {}),
            ...(readCharsPerToken(rawMember.charsPerToken) !== undefined
              ? { charsPerToken: readCharsPerToken(rawMember.charsPerToken) }
              : {}),
            ...(typeof rawMember.weight === "number" &&
            Number.isFinite(rawMember.weight) &&
            rawMember.weight > 0
              ? { weight: rawMember.weight }
              : {}),
          });
        }
      }
      if (members.length === 0) return null;
      return {
        strategy,
        ...(sticky !== undefined ? { sticky } : {}),
        members,
        ...(isRecord(poolSource?.parameters)
          ? { parameters: poolSource.parameters }
          : {}),
        ...(readCharsPerToken(poolSource?.charsPerToken) !== undefined
          ? { charsPerToken: readCharsPerToken(poolSource?.charsPerToken) }
          : {}),
      };
    }
    // Plain form: engine + model (+ optional params).
    if (typeof s.engine === "string" && typeof s.model === "string") {
      return {
        engine: s.engine,
        model: s.model,
        ...(isRecord(s.parameters) ? { parameters: s.parameters } : {}),
        ...(readCharsPerToken(s.charsPerToken) !== undefined
          ? { charsPerToken: readCharsPerToken(s.charsPerToken) }
          : {}),
      };
    }
    return null;
  });
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

/**
 * One-line, human-readable summary of a shortcut for editors: `provider · model`
 * for a single shortcut, `pool (strategy): a, b, …` for a pool. Unknown names
 * yield `undefined`.
 */
export function describeShortcut(data: ModelShortcutsData, name: string): string | undefined {
  const def = data.shortcuts[name];
  if (def === undefined) return undefined;
  const pair = (engine: string | undefined, model: string | undefined): string => {
    const provider = engine !== undefined ? (data.engines[engine]?.provider ?? engine) : "?";
    const id = model !== undefined ? (data.modelPresets[model]?.model ?? model) : "?";
    return `${provider} · ${id}`;
  };
  if (!isPoolShortcut(def)) return pair(def.engine, def.model);
  const members = def.members.map((m) => (m.shortcut !== undefined ? m.shortcut : pair(m.engine, m.model)));
  return `pool (${def.strategy ?? "fallback"}): ${members.join(", ")}`;
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
 * Expands a concrete engine/model pair (a single shortcut or a pool member)
 * into a concrete {@link LlmConfig}. `extraParams` are layered above the
 * preset's (member/shortcut params), `nodeParams` last (node-level wins).
 * Returns `null` — after logging — when the engine or preset is unknown, so
 * the caller can leave the `shortcut` key in place and fail validation loudly.
 */
function expandConcrete(
  name: string,
  engineName: string,
  modelName: string,
  extraParams: Record<string, unknown> | undefined,
  weight: number | undefined,
  inheritedParams: Record<string, unknown>,
  nodeParams: Record<string, unknown>,
  data: ModelShortcutsData,
  fileName: string,
  shortcutCharsPerToken?: number,
): LlmConfig | null {
  const engine = data.engines[engineName];
  if (engine === undefined) {
    warn(
      fileName,
      `Model shortcut "${name}" references unknown engine "${engineName}"`,
    );
    return null;
  }
  const preset = data.modelPresets[modelName];
  if (preset === undefined) {
    warn(
      fileName,
      `Model shortcut "${name}" references unknown model preset "${modelName}"`,
    );
    return null;
  }
  // Precedence (later wins): preset < inherited pool params < shortcut/member <
  // node-level parameters. `inheritedParams` are the accumulated pool-level
  // parameters from every enclosing pool (outer first, inner overriding).
  const mergedParams: Record<string, unknown> = {
    ...(preset.parameters ?? {}),
    ...inheritedParams,
    ...(extraParams ?? {}),
    ...nodeParams,
  };
  const config: LlmConfig = { provider: engine.provider, model: preset.model };
  if (weight !== undefined && Number.isFinite(weight) && weight > 0) {
    config.weight = weight;
  }
  if (Object.keys(mergedParams).length > 0) {
    config.parameters = mergedParams;
  }
  // Shortcut/member-level chars-per-token overrides the preset's.
  const charsPerToken = shortcutCharsPerToken ?? preset.charsPerToken;
  if (charsPerToken !== undefined) {
    config.charsPerToken = charsPerToken;
  }
  return config;
}

/**
 * The first concrete LEAF of a (possibly nested) candidate config — the value
 * that fills a host node's `provider`/`model`/`parameters`. Walks into a nested
 * sub-pool's first candidate so a pool-of-pools still resolves to a real model.
 */
function firstLeaf(config: LlmConfig): LlmConfig {
  let leaf = config;
  while (leaf.pool !== undefined && leaf.pool.candidates[0] !== undefined) {
    leaf = leaf.pool.candidates[0];
  }
  return leaf;
}

/**
 * Expands a shortcut into a SINGLE {@link LlmConfig}.
 *
 * - A plain shortcut → a concrete provider/model config.
 * - A pool shortcut → a config whose `provider`/`model`/`parameters` come from
 *   the first leaf candidate and which carries a `pool: { strategy, candidates }`.
 *   A pool member that references ANOTHER pool shortcut is kept as a NESTED
 *   candidate (a candidate carrying its own `pool`) rather than flattened, so
 *   the inner strategy survives — this is what lets an outer `fallback` pool
 *   hold an inner `round-robin` sub-pool as its primary member. Member weights
 *   (including on a referenced sub-pool) are preserved for weighted strategies.
 *
 * `visiting` guards against reference cycles. Node-level `nodeParams` are
 * request-level overrides (temperature, maxTokens, …) layered onto every leaf,
 * so each member keeps its own preset tuning but inherits the requesting node's
 * overrides. `inheritedParams` accumulates the pool-level `parameters` of every
 * enclosing pool (outer first, inner overriding) and is layered onto every leaf
 * below preset tuning but above nothing else except member/node params — this
 * is how a pool's `parameters` reach its members and nested sub-pool leaves.
 * Returns `null` on any lookup failure (already logged) so the caller leaves the
 * `shortcut` key in place and the node fails validation loudly.
 */
function expandShortcutToConfig(
  name: string,
  nodeParams: Record<string, unknown>,
  data: ModelShortcutsData,
  fileName: string,
  visiting: ReadonlySet<string>,
  inheritedParams: Record<string, unknown> = {},
  inheritedCharsPerToken?: number,
): LlmConfig | null {
  if (visiting.has(name)) {
    warn(fileName, `Model shortcut "${name}" has a cyclic reference`);
    return null;
  }
  const shortcut = data.shortcuts[name];
  if (shortcut === undefined) {
    warn(fileName, `Unknown model shortcut "${name}" — leaving unresolved`);
    return null;
  }

  if (!isPoolShortcut(shortcut)) {
    return expandConcrete(
      name,
      shortcut.engine,
      shortcut.model,
      shortcut.parameters,
      undefined,
      inheritedParams,
      nodeParams,
      data,
      fileName,
      shortcut.charsPerToken ?? inheritedCharsPerToken,
    );
  }

  // This pool's own parameters override any inherited from an enclosing pool
  // (outer < inner), and are inherited further down into members/sub-pools.
  const poolInherited: Record<string, unknown> = {
    ...inheritedParams,
    ...(shortcut.parameters ?? {}),
  };
  // This pool's chars-per-token overrides any inherited from an enclosing pool.
  const poolCharsPerToken =
    shortcut.charsPerToken ?? inheritedCharsPerToken;

  const candidates: LlmConfig[] = [];
  for (const member of shortcut.members) {
    if (member.shortcut !== undefined) {
      // Referenced member: expanded to a SINGLE config (which itself keeps a
      // nested `pool` when the referenced shortcut is a pool), so the inner
      // strategy is preserved instead of flattened into this pool's order.
      const nested = expandShortcutToConfig(
        member.shortcut,
        nodeParams,
        data,
        fileName,
        new Set([...visiting, name]),
        poolInherited,
        poolCharsPerToken,
      );
      if (nested === null) return null;
      // An explicit member weight applies to the nested candidate as a whole.
      if (
        member.weight !== undefined &&
        Number.isFinite(member.weight) &&
        member.weight > 0
      ) {
        nested.weight = member.weight;
      }
      candidates.push(nested);
      continue;
    }
    const concrete = expandConcrete(
      name,
      member.engine as string,
      member.model as string,
      member.parameters,
      member.weight,
      poolInherited,
      nodeParams,
      data,
      fileName,
      member.charsPerToken ?? poolCharsPerToken,
    );
    if (concrete === null) return null;
    candidates.push(concrete);
  }
  if (candidates.length === 0) {
    warn(fileName, `Model shortcut "${name}" pool has no usable members`);
    return null;
  }

  const first = firstLeaf(candidates[0] as LlmConfig);
  const config: LlmConfig = { provider: first.provider, model: first.model };
  if (
    first.parameters !== undefined &&
    Object.keys(first.parameters).length > 0
  ) {
    config.parameters = first.parameters;
  }
  if (first.charsPerToken !== undefined) {
    config.charsPerToken = first.charsPerToken;
  }
  config.pool = {
    strategy: shortcut.strategy,
    candidates,
    ...(shortcut.sticky !== undefined ? { sticky: shortcut.sticky } : {}),
  };
  return config;
}

/**
 * Expands a single llm-ish object carrying a string `shortcut` in place.
 * On any lookup failure it leaves `shortcut` intact (so Zod rejects the node)
 * and logs a warning. On success it deletes `shortcut` and sets `provider`,
 * `model` and the merged `parameters`. When the shortcut is a POOL, the first
 * leaf candidate fills those keys and a concrete `pool: { strategy, candidates }`
 * (possibly with nested sub-pools) is attached for the runtime handlers (see
 * `LlmPoolConfig`).
 */
function expandShortcutObject(
  obj: Record<string, unknown>,
  data: ModelShortcutsData,
  fileName: string,
): void {
  const name = obj.shortcut;
  if (typeof name !== "string") return;

  const nodeParams = isRecord(obj.parameters) ? obj.parameters : {};
  const resolved = expandShortcutToConfig(
    name,
    nodeParams,
    data,
    fileName,
    new Set<string>(),
  );
  if (resolved === null) return;

  delete obj.shortcut;
  obj.provider = resolved.provider;
  obj.model = resolved.model;
  if (
    resolved.parameters !== undefined &&
    Object.keys(resolved.parameters).length > 0
  ) {
    obj.parameters = resolved.parameters;
  }
  if (resolved.pool !== undefined) {
    obj.pool = resolved.pool;
  }
  // A node-level `charsPerToken` next to `shortcut` wins over the shortcut's.
  if (
    resolved.charsPerToken !== undefined &&
    obj.charsPerToken === undefined
  ) {
    obj.charsPerToken = resolved.charsPerToken;
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
