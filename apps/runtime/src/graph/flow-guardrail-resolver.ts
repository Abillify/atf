// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-flow guardrail resolver (`src/graph/flow-guardrail-resolver.ts`)
 *
 * Turns a per-flow {@link GuardrailOverride} (from `guardrails.json`) into the
 * concrete `OutputGuardrail` / `ToolEgressGuardrail` instances a single flow
 * run should use, so a regulated flow (e.g. a debt-collections router) can enforce
 * STRICTER output redaction and outbound DLP than the global default — or a
 * trusted internal pipeline can switch them off — declaratively, without an
 * env change or redeploy.
 *
 * Resolution per section (`output`, `egress`):
 *   - no override for the flow            → inherit the engine's global default.
 *   - override with `enabled: false`      → disabled for this flow.
 *   - override with settings              → build a fresh guardrail, each field
 *                                           falling back to the global config.
 *
 * Compiled instances are memoised per flow and invalidated when the policy file
 * is hot-reloaded (tracked via {@link GuardrailPolicyService.generation}), so a
 * hot request path never recompiles blocklist regexes.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import {
  createOutputGuardrail,
  createToolEgressGuardrail,
  type OutputGuardrail,
  type OutputGuardrailConfig,
  type ToolEgressGuardrail,
} from "./output-guardrails.js";
import type {
  GuardrailPolicyService,
  OutputGuardrailOverride,
} from "./guardrail-policy.js";

/**
 * A resolved per-flow guardrail override. A section is present only when the
 * flow's policy overrides it; `null` means the section is explicitly disabled
 * for the flow, an instance means "use this", and an absent key means "inherit
 * the engine default".
 */
export interface FlowGuardrailOverride {
  output?: OutputGuardrail | null;
  egress?: ToolEgressGuardrail | null;
}

export interface FlowGuardrailResolver {
  /**
   * Returns the per-flow guardrail override, or undefined when the flow has no
   * output/egress policy (caller uses the engine's global guardrails).
   */
  resolve(flowId: string): FlowGuardrailOverride | undefined;
}

/** The global (env-based) guardrail config the per-flow override falls back to. */
export interface GlobalGuardrailDefaults {
  output: OutputGuardrailConfig;
  egress: OutputGuardrailConfig;
}

function mergeConfig(
  override: OutputGuardrailOverride,
  base: OutputGuardrailConfig,
): OutputGuardrailConfig {
  return {
    enabled: true,
    redactPii: override.redactPii ?? base.redactPii ?? true,
    piiTypes: override.piiTypes ?? base.piiTypes,
    blockedPatterns: override.blockedPatterns ?? base.blockedPatterns,
    mode: override.mode ?? base.mode ?? "redact",
  };
}

class FlowGuardrailResolverImpl implements FlowGuardrailResolver {
  private cache = new Map<string, FlowGuardrailOverride | undefined>();
  private cachedGen = -1;

  constructor(
    private readonly policy: GuardrailPolicyService,
    private readonly defaults: GlobalGuardrailDefaults,
    private readonly logger?: Logger,
  ) {}

  resolve(flowId: string): FlowGuardrailOverride | undefined {
    const gen = this.policy.generation();
    if (gen !== this.cachedGen) {
      this.cache.clear();
      this.cachedGen = gen;
    }
    if (this.cache.has(flowId)) return this.cache.get(flowId);

    const resolved = this.compile(flowId);
    this.cache.set(flowId, resolved);
    return resolved;
  }

  private compile(flowId: string): FlowGuardrailOverride | undefined {
    const policyOverride = this.policy.resolve(flowId);
    if (policyOverride === undefined) return undefined;

    const result: FlowGuardrailOverride = {};
    let touched = false;

    if (policyOverride.output !== undefined) {
      touched = true;
      result.output =
        policyOverride.output.enabled === false
          ? null
          : (createOutputGuardrail(
              mergeConfig(policyOverride.output, this.defaults.output),
              this.logger,
            ) ?? null);
    }

    if (policyOverride.egress !== undefined) {
      touched = true;
      result.egress =
        policyOverride.egress.enabled === false
          ? null
          : (createToolEgressGuardrail(
              mergeConfig(policyOverride.egress, this.defaults.egress),
              this.logger,
            ) ?? null);
    }

    return touched ? result : undefined;
  }
}

export function createFlowGuardrailResolver(
  policy: GuardrailPolicyService,
  defaults: GlobalGuardrailDefaults,
  logger?: Logger,
): FlowGuardrailResolver {
  return new FlowGuardrailResolverImpl(policy, defaults, logger);
}
