// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Model capability registry (`src/graph/model-capabilities.ts`)
 *
 * Declarative, data-driven description of engine×model peculiarities that the
 * engine must branch on — replacing the hardcoded `provider === "openai"` style
 * checks that were previously scattered across the classifier, llm-factory and
 * message-mapping. Adding a model or fixing a quirk is now a table row, not an
 * engine edit.
 *
 * Motivation from real incidents this caught/prevents:
 *   - `generateObject` (native structured output) works on Bedrock **Haiku**
 *     but is REJECTED by **claude-sonnet-5** ("output_config.format: Extra
 *     inputs are not permitted") → that model needs the `prompt_validate`
 *     strategy instead of silently failing.
 *   - `generateText` + `output` (json_schema) is the reliable enforced path for
 *     OpenAI-compatible local servers (LM Studio / Ollama / vLLM).
 *
 * Lookup is by (provider, model): the provider-level rule applies first, then
 * any matching model-glob rule overrides it (more specific wins). A provider
 * reference is first resolved to its wire PROTOCOL (see `config/providers.ts`),
 * so every named instance of a protocol shares its rules. Unknown
 * providers/models fall back to the safest universal strategy (`prompt_validate`
 * — a schema hint in the prompt + tolerant JSON parse, which never throws).
 *
 * No `any` at module boundaries.
 */

import {
  isLocalProviderName,
  resolveProviderProtocol,
} from "../config/providers.js";

/**
 * How a `classifier` node should obtain schema-conforming JSON from a model:
 *   - `response_format`  — `generateText` with an `output` spec (json_schema).
 *                          Enforced by OpenAI-compatible servers; parsed from
 *                          the response text (mock-friendly).
 *   - `generateObject`   — the AI SDK's native structured output (tool-use for
 *                          Claude/Bedrock, responseSchema for Google).
 *   - `prompt_validate`  — plain `generateText` with a JSON-schema HINT in the
 *                          prompt + a tolerant parse. No provider enforcement;
 *                          the universal fallback and the path for models whose
 *                          native structured output is broken (e.g. sonnet-5).
 */
export type StructuredOutputMode =
  | "response_format"
  | "generateObject"
  | "prompt_validate";

/** Which prompt-cache breakpoint scheme (if any) applies for this model. */
export type PromptCacheMode = "anthropic" | "bedrock" | "none";

export interface ModelCapabilities {
  /** Structured-output strategy for classifier nodes. */
  structuredOutput: StructuredOutputMode;
  /** Prompt-cache breakpoint scheme (classifier + llm system prompt caching). */
  promptCache: PromptCacheMode;
  /**
   * Whether a system message may travel inside the `messages` array (carrying a
   * cache breakpoint) rather than the separate `instructions` option. Needed
   * `true` for our classifier path (system-in-messages + cache markers). Some
   * providers/APIs reject it — `false` would force the `instructions` option.
   */
  allowSystemInMessages: boolean;
  /**
   * Inference parameter names this model rejects and that must be stripped
   * before the call (otherwise the provider errors). E.g. Claude Sonnet 4.5+
   * (`sonnet-5`) deprecated `temperature`. Empty for models with no such quirk.
   */
  unsupportedParameters: string[];
  /** Whether the model accepts image/file inputs. Unknown models fail closed. */
  visionInput: boolean;
  /**
   * Total context window in tokens (input + output share it), or `undefined`
   * when it cannot be known from the provider/model id alone.
   *
   * `undefined` is a first-class value, not a gap to be filled with a guess:
   * consumers that scale a budget to the window (tool-result truncation,
   * compression triggers) must fall back to absolute defaults rather than
   * inventing a number, because guessing too HIGH is what produces oversized
   * requests the provider rejects.
   *
   * Notably left undefined for local models: the `openai` provider is also how
   * this codebase talks to LM Studio / vLLM / llama.cpp, where the window is a
   * property of how the operator LOADED the model, not of its id. Those set it
   * explicitly via `llm.parameters.contextLength` in the flow YAML.
   */
  contextLength?: number;
}

/** One capability rule, applied by provider and (optionally) a model glob. */
interface CapabilityRule {
  provider: string;
  /** Case-insensitive glob (`*` wildcard) matched against the model id. */
  modelPattern?: string;
  caps: Partial<ModelCapabilities>;
}

/** Universal safe default for any unknown provider/model. */
const GLOBAL_DEFAULT: ModelCapabilities = {
  structuredOutput: "prompt_validate",
  promptCache: "none",
  allowSystemInMessages: true,
  unsupportedParameters: [],
  visionInput: false,
};

/**
 * Built-in capability rules. Provider-level rules first (no `modelPattern`),
 * then model-specific overrides. Order within the array is the tie-break for
 * multiple matching patterns (later wins), so put more-specific rules LAST.
 */
const RULES: readonly CapabilityRule[] = [
  // OpenAI-compatible local/hosted servers — enforced json_schema via `output`.
  //
  // Deliberately NO provider-level `contextLength`: this provider serves both
  // OpenAI cloud and local servers (LM Studio / vLLM / llama.cpp), so only the
  // known-cloud model globs below carry a window. A local model id matches none
  // of them and resolves to `undefined`, which is correct — its window depends
  // on how it was loaded, not on its name.
  {
    provider: "openai",
    caps: { structuredOutput: "response_format", allowSystemInMessages: true },
  },
  {
    provider: "ollama",
    caps: { structuredOutput: "response_format", allowSystemInMessages: true },
  },
  {
    provider: "azure",
    caps: { structuredOutput: "response_format", allowSystemInMessages: true },
  },
  // Google — native structured output via responseSchema (generateObject).
  { provider: "google", caps: { structuredOutput: "generateObject", visionInput: true } },
  // Bedrock (Claude) — native tool-use structured output + Bedrock cache points.
  {
    provider: "bedrock",
    caps: {
      structuredOutput: "generateObject",
      promptCache: "bedrock",
      allowSystemInMessages: true,
      visionInput: true,
      // Every Claude generation on Bedrock so far is a 200K window.
      contextLength: 200_000,
    },
  },
  // Bedrock claude-sonnet-5 REJECTS generateObject's output_config.format
  // (verified against a live endpoint) — must use the prompt-hint path instead.
  // It also deprecated `temperature`, so that parameter is stripped before the
  // call (previously the hardcoded MODELS_WITHOUT_TEMPERATURE list).
  {
    provider: "bedrock",
    modelPattern: "*sonnet-5*",
    caps: {
      structuredOutput: "prompt_validate",
      unsupportedParameters: ["temperature"],
    },
  },
  // Anthropic direct — native structured output + Anthropic cache control.
  {
    provider: "anthropic",
    caps: {
      structuredOutput: "generateObject",
      promptCache: "anthropic",
      allowSystemInMessages: true,
      visionInput: true,
      contextLength: 200_000,
    },
  },
  // Anthropic-direct sonnet-5 also deprecated `temperature` (model-level quirk,
  // independent of the Bedrock gateway). Structured output via the native
  // Anthropic path is kept (the output_config.format issue was Bedrock-only).
  {
    provider: "anthropic",
    modelPattern: "*sonnet-5*",
    caps: { unsupportedParameters: ["temperature"] },
  },

  // -------------------------------------------------------------------------
  // Context windows for known CLOUD models on the `openai` provider.
  //
  // Scoped to explicit model globs rather than the provider, because the same
  // provider is how we reach LM Studio / vLLM / llama.cpp (see the note on the
  // provider-level `openai` rule). An unmatched model id keeps
  // `contextLength: undefined`, and callers fall back to absolute budgets.
  //
  // These are ceilings advertised by the vendor; a deployment may be configured
  // lower. Anything that must not overshoot should set
  // `llm.parameters.contextLength` explicitly — it always wins.
  // -------------------------------------------------------------------------
  { provider: "openai", modelPattern: "gpt-4o*", caps: { contextLength: 128_000, visionInput: true } },
  {
    provider: "openai",
    modelPattern: "gpt-4-turbo*",
    caps: { contextLength: 128_000 },
  },
  // Local vLLM (openai protocol) Qwen3 multimodal checkpoints. Verified against
  // a live gpuvllm endpoint: the NVFP4 build accepts image inputs, but a local
  // model id matches no cloud glob and would otherwise fail closed on vision.
  // Scoped to the multimodal build so text-only Qwen deployments stay closed.
  {
    provider: "openai",
    modelPattern: "*Qwen3*NVFP4*",
    caps: { visionInput: true },
  },
  // o-series reasoning models.
  { provider: "openai", modelPattern: "o1*", caps: { contextLength: 200_000 } },
  { provider: "openai", modelPattern: "o3*", caps: { contextLength: 200_000 } },
  { provider: "openai", modelPattern: "o4*", caps: { contextLength: 200_000 } },
  // Google Gemini — 1M-token class across the 1.5/2.x/3.x Pro and Flash lines.
  {
    provider: "google",
    modelPattern: "gemini-*",
    caps: { contextLength: 1_048_576 },
  },
];

// ---------------------------------------------------------------------------
// Provider traits (per-provider, independent of a specific model)
// ---------------------------------------------------------------------------

/**
 * Providers whose inference runs on local / on-prem infrastructure, so request
 * payloads (including raw images) never leave the operator's environment.
 *
 * Used e.g. by the PII vault's "describe" multimodal mode to decide whether the
 * describer model would expose raw images to a third party. Kept as data here
 * (rather than a hardcoded `provider !== "ollama"` check at the call site) so
 * the locality assumption lives with the other engine×provider peculiarities.
 *
 * NOTE: only providers that are ALWAYS local belong here. `openai` is
 * intentionally excluded even though it can point at a local server (LM Studio)
 * via a base URL — locality then depends on runtime config, not the provider
 * alone, so it cannot be asserted from the provider id.
 */
/**
 * Returns `true` when the provider's inference is guaranteed to run locally /
 * on-prem (payloads never leave the operator's infrastructure).
 *
 * Delegates to the provider registry: a named instance qualifies when it
 * declares `local: true`, and the always-local `ollama` protocol qualifies
 * implicitly. A bare `openai` reference does NOT, because that protocol reaches
 * both local servers and hosted APIs (see the note above).
 */
export function isLocalInferenceProvider(provider: string | undefined): boolean {
  return isLocalProviderName(provider);
}

/** Compiles a `*`-glob to a case-insensitive full-match RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Resolves the effective capabilities for a (provider, model) pair by merging
 * the global default, the provider-level rule, and any matching model-glob
 * rules (in declaration order, later overrides earlier).
 */
export function getModelCapabilities(
  provider: string,
  model: string,
): ModelCapabilities {
  // Rules are keyed by wire PROTOCOL: capabilities are a property of the API a
  // server speaks, not of the operator's name for that server. So every named
  // instance of e.g. the openai protocol inherits the same rules.
  const protocol = resolveProviderProtocol(provider) ?? provider;
  let caps: ModelCapabilities = { ...GLOBAL_DEFAULT };
  for (const rule of RULES) {
    if (rule.provider !== protocol) continue;
    if (rule.modelPattern !== undefined && !globToRegExp(rule.modelPattern).test(model))
      continue;
    caps = { ...caps, ...rule.caps };
  }
  return caps;
}
