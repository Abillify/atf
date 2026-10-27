// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Guardrail Policy-as-Code (`src/graph/guardrail-policy.ts`)
 *
 * Loads per-flow guardrail overrides from `guardrails.json` in `flowsDir`,
 * hot-reloaded on change (same pattern as `access.json` / `dispatch.json`).
 *
 * A policy file lets operators declaratively configure input and output
 * guardrails per flow without touching environment variables or redeploying.
 * This is the Compliance-as-Code angle: each rule is explicit, auditable, and
 * in version control alongside the flow definitions.
 *
 * guardrails.json example:
 * {
 *   "rules": [
 *     {
 *       "flow": "*",
 *       "input":  { "enabled": true, "mode": "flag", "threshold": 0.8 },
 *       "output": { "enabled": true, "redactPii": true, "mode": "redact" }
 *     },
 *     {
 *       "flow": "admin-power-flow",
 *       "input":  { "enabled": true, "mode": "block", "threshold": 0.6 },
 *       "output": {
 *         "enabled": true,
 *         "redactPii": true,
 *         "piiTypes": ["email", "creditCard"],
 *         "blockedPatterns": ["INTERNAL-\\d+"],
 *         "mode": "redact"
 *       }
 *     }
 *   ]
 * }
 *
 * Semantics:
 *   - Rules are evaluated top-to-bottom; the FIRST matching rule wins.
 *   - `flow: "*"` is a catch-all (matched last in specificity order: exact
 *     flow ID wins over wildcard, but first-match-wins within each group).
 *   - A rule with `enabled: false` for a section explicitly DISABLES that
 *     guardrail for the flow, even when the global env-flag is on. This lets
 *     operators carve out trusted internal flows.
 *   - When no rule matches, the global env-based config is used as-is.
 *
 * Fail-closed: parse errors disable nothing — the global env config applies.
 *
 * No `any` at module boundaries.
 */

import { z } from "zod";
import type { Logger } from "../observability/logger.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const InputGuardrailRuleSchema = z.object({
  enabled: z.boolean().optional(),
  /** "flag" annotates; "block" rejects with HTTP 422. */
  mode: z.enum(["flag", "block"]).optional(),
  /** Risk score threshold (0–1). */
  threshold: z.number().min(0).max(1).optional(),
});

const OutputGuardrailRuleSchema = z.object({
  enabled: z.boolean().optional(),
  redactPii: z.boolean().optional(),
  /** Restrict PII redaction to these types. */
  piiTypes: z.array(z.string()).max(20).optional(),
  /** Additional regex patterns to block (compiled at load time). */
  blockedPatterns: z.array(z.string()).max(100).optional(),
  mode: z.enum(["redact", "block"]).optional(),
});

const GuardrailRuleSchema = z.object({
  /** Flow ID this rule applies to, or "*" for all flows. */
  flow: z.string().min(1).max(256),
  input: InputGuardrailRuleSchema.optional(),
  output: OutputGuardrailRuleSchema.optional(),
  /**
   * Egress DLP override — scrubs/blocks PII & secrets in OUTBOUND tool-call
   * arguments (what the model sends to an external MCP tool), distinct from
   * `output` (what reaches the client). Same shape as `output`.
   */
  egress: OutputGuardrailRuleSchema.optional(),
  /**
   * Per-flow PII detector selection (ADR-0015). Overrides the global
   * PII_DETECTORS setting for this flow's vault ingress tokenization.
   * Array of detector names: "regex", "ner", "remote".
   * When absent, the global config applies. When set to an empty array,
   * vault tokenization is effectively disabled for this flow.
   */
  detectors: z.array(z.string()).max(10).optional(),
  /**
   * Per-flow PII TYPE subset for the vault ingress (ADR-0015). Restricts which
   * PII types this flow tokenizes (e.g. ["location","iban"]), overriding the
   * global PII_VAULT_TYPES. Pairs with `detectors` (which detectors run) — this
   * is which types they tokenize. Unknown names are ignored. Absent → inherit
   * the global PII_VAULT_TYPES. Distinct from `output.piiTypes` / `egress.piiTypes`
   * which scope the output / egress guardrails, not the vault.
   */
  piiTypes: z.array(z.string()).max(20).optional(),
});

const GuardrailPolicySchema = z.object({
  rules: z.array(GuardrailRuleSchema).max(500).default([]),
});

export type InputGuardrailOverride = z.infer<typeof InputGuardrailRuleSchema>;
export type OutputGuardrailOverride = z.infer<typeof OutputGuardrailRuleSchema>;

export interface GuardrailOverride {
  input?: InputGuardrailOverride;
  output?: OutputGuardrailOverride;
  /** Per-flow egress DLP override (outbound tool-call arguments). */
  egress?: OutputGuardrailOverride;
  /** Per-flow PII detector selection (ADR-0015). Overrides global PII_DETECTORS. */
  detectors?: string[];
  /** Per-flow vault PII type subset (ADR-0015). Overrides global PII_VAULT_TYPES. */
  piiTypes?: string[];
}

type GuardrailPolicy = z.infer<typeof GuardrailPolicySchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function loadPolicy(
  flowsDir: string,
  logger?: Logger,
): GuardrailPolicy | undefined {
  const filePath = resolveConfigFile(flowsDir, "guardrails");
  if (filePath === null) return undefined;

  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    logger?.warn(
      "Failed to read/parse guardrails config — global env config applies",
      {
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }

  const result = GuardrailPolicySchema.safeParse(raw);
  if (!result.success) {
    logger?.warn(
      "guardrails config failed schema validation — global env config applies",
      {
        file: filePath,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    );
    return undefined;
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GuardrailPolicyService {
  /**
   * Returns the guardrail override for a flow ID, or undefined when no rule
   * applies (caller uses the global env config).
   */
  resolve(flowId: string): GuardrailOverride | undefined;
  /** Reloads guardrails.json from disk (called by the file watcher). */
  reload(): void;
  /**
   * Monotonic counter bumped on each reload. Lets a downstream resolver cache
   * compiled guardrail instances per flow and invalidate them on a policy edit.
   */
  generation(): number;
  /** True when a policy file is currently loaded. */
  hasPolicy(): boolean;
  /** All configured rules, in evaluation order — for a read-only management UI. */
  listRules(): ReadonlyArray<z.infer<typeof GuardrailRuleSchema>>;
}

class GuardrailPolicyServiceImpl implements GuardrailPolicyService {
  private policy: GuardrailPolicy | undefined;
  private gen = 0;

  constructor(
    private readonly flowsDir: string,
    private readonly logger?: Logger,
  ) {
    this.policy = loadPolicy(flowsDir, logger);
  }

  resolve(flowId: string): GuardrailOverride | undefined {
    if (this.policy === undefined) return undefined;
    // Specificity order: exact match first, then wildcard.
    const exact = this.policy.rules.find((r) => r.flow === flowId);
    if (exact !== undefined)
      return {
        input: exact.input,
        output: exact.output,
        egress: exact.egress,
        detectors: exact.detectors,
        piiTypes: exact.piiTypes,
      };
    const wildcard = this.policy.rules.find((r) => r.flow === "*");
    if (wildcard !== undefined)
      return {
        input: wildcard.input,
        output: wildcard.output,
        egress: wildcard.egress,
        detectors: wildcard.detectors,
        piiTypes: wildcard.piiTypes,
      };
    return undefined;
  }

  generation(): number {
    return this.gen;
  }

  reload(): void {
    this.policy = loadPolicy(this.flowsDir, this.logger);
    this.gen++;
    this.logger?.info("Guardrail policy reloaded", {
      hasPolicy: this.policy !== undefined,
      ruleCount: this.policy?.rules.length ?? 0,
    });
  }

  hasPolicy(): boolean {
    return this.policy !== undefined;
  }

  listRules(): ReadonlyArray<z.infer<typeof GuardrailRuleSchema>> {
    return this.policy?.rules ?? [];
  }
}

export function createGuardrailPolicy(
  flowsDir: string,
  logger?: Logger,
): GuardrailPolicyService {
  return new GuardrailPolicyServiceImpl(flowsDir, logger);
}
