// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Compliance Policy Evaluator (`src/compliance/policy-evaluator.ts`)
 *
 * Per-request evaluation of the declarative compliance policy. Wired into
 * `POST /v1/chat/completions` (via `checkCompliancePolicy` in
 * `routes/chat/metering.ts`, calling `evaluatePolicyForModels` below) as an
 * admission check that runs before `GraphEngineService.executeFlow` — a
 * `deny` verdict rejects the request with 403 before any node runs.
 *
 * Other entry points into the graph engine (webhook triggers
 * `routes/triggers.ts`, replay, the flow-as-MCP-server, shadow mode) do NOT
 * yet call it — see the "Current scope" note in ADR-0009 and the README's
 * Compliance Policy-as-Code section.
 *
 * The evaluator is:
 *   - Pure (no I/O) for the core decision logic — testable without stubs.
 *   - Fail-closed by default: a malformed/missing rule throws rather than
 *     silently allowing traffic.
 *   - Lightweight: all decisions are O(rules) with no network calls.
 *
 * No `any` at module boundaries.
 */

import type {
  ApprovalRule,
  CompliancePolicy,
  DataClass,
} from "./policy-schema.js";
import type { LlmConfig } from "../types/flow.js";

// ---------------------------------------------------------------------------
// Request context passed to the evaluator
// ---------------------------------------------------------------------------

export interface EvalRequestContext {
  /** Resolved tenant id (from JWT claim or request metadata). */
  tenantId?: string;
  /** Authenticated role (from JWT claim or RBAC config). */
  role?: string;
  /** Data classifications inferred or declared for this request. */
  dataClasses?: DataClass[];
  /** LLM config resolved for the current flow node. */
  llmConfig?: LlmConfig;
  /** Tool ids the agent has selected to call. */
  toolIds?: string[];
  /** Flow id being executed. */
  flowId?: string;
  /**
   * Cloud region the LLM request will be sent to, when known.
   * Required for data-residency enforcement in data rules with `allowedRegions`.
   * Provider-specific format (e.g. "eu-central-1" for Bedrock, "germanywestcentral" for Azure).
   * When absent, region-scoped data rules emit a warning violation but do not block.
   */
  region?: string;
}

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

export type PolicyDecision = "allow" | "deny" | "require-approval";

export interface PolicyViolation {
  rule: "data" | "model" | "approval" | "retention" | "audit";
  message: string;
  /** Details for the audit report. */
  detail?: Record<string, unknown>;
  /**
   * Whether this violation, on its own, should deny the request. Defaults to
   * `true` when omitted. Set to `false` for advisory-only findings (e.g. a
   * data-residency rule that cannot be checked because the request carries no
   * region context) — these still surface in `violations` for audit/reporting
   * but must not flip the final decision to "deny".
   */
  blocking?: boolean;
}

export interface PolicyEvalResult {
  decision: PolicyDecision;
  violations: PolicyViolation[];
  /** True when the policy was not loaded (no policy file configured). */
  policyAbsent: boolean;
}

// ---------------------------------------------------------------------------
// Glob matching (supports trailing "*" only — sufficient for tool patterns)
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith("*")) {
    return value.endsWith(pattern.slice(1));
  }
  return pattern === value;
}

/**
 * Returns the first `approvalRules` entry that applies to this context (flow
 * scope + role exemption + tool pattern), or undefined when none matches.
 * Shared by `evaluatePolicy`'s `requiresApproval` check and
 * `policyRequiresToolApproval` — extracted so the latter can also read the
 * matched rule's `timeoutMs` instead of just a boolean.
 */
function findMatchingApprovalRule(
  policy: CompliancePolicy,
  ctx: Pick<EvalRequestContext, "toolIds" | "flowId" | "role">,
): ApprovalRule | undefined {
  if (
    policy.approvalRules === undefined ||
    ctx.toolIds === undefined ||
    ctx.toolIds.length === 0
  ) {
    return undefined;
  }
  const toolIds = ctx.toolIds;
  return policy.approvalRules.find((rule) => {
    // Flow filter: if a rule scopes to specific flows and we have no flowId,
    // the rule cannot apply — fail-safe: skip rather than over-trigger.
    if (rule.flows !== undefined && rule.flows.length > 0) {
      if (ctx.flowId === undefined) return false;
      if (!rule.flows.includes(ctx.flowId)) return false;
    }
    // Role exemption.
    if (rule.exemptRoles !== undefined && ctx.role !== undefined) {
      if (rule.exemptRoles.includes(ctx.role)) return false;
    }
    // Tool pattern match.
    return toolIds.some((tid) =>
      rule.toolPatterns.some((pat) => matchesGlob(pat, tid)),
    );
  });
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates the compliance policy for a single request. Returns a result
 * describing whether the request should be allowed, denied, or require human
 * approval — and the list of policy violations that led to the decision.
 *
 * Pure function: no I/O, no side effects.
 */
export function evaluatePolicy(
  policy: CompliancePolicy | undefined,
  ctx: EvalRequestContext,
): PolicyEvalResult {
  if (policy === undefined) {
    return { decision: "allow", violations: [], policyAbsent: true };
  }

  const violations: PolicyViolation[] = [];

  try {
    // ── 1. Data rules ─────────────────────────────────────────────────────
    if (policy.dataRules !== undefined && policy.dataRules.length > 0 && ctx.dataClasses !== undefined) {
      const provider = ctx.llmConfig?.provider;
      for (const dataClass of ctx.dataClasses) {
        const rule = policy.dataRules.find((r) => r.dataClass === dataClass);
        if (rule === undefined) continue;
        if (rule.allowedProviders.length === 0) {
          violations.push({
            rule: "data",
            message: `Data class "${dataClass}" is not permitted to be processed by any LLM provider.`,
            detail: { dataClass, flowId: ctx.flowId },
          });
          continue;
        }
        if (provider !== undefined) {
          // Find a matching allowed-provider entry for this provider.
          const matchingEntry = rule.allowedProviders.find(
            (ap) => ap.provider === provider,
          );
          if (matchingEntry === undefined) {
            // Provider not in allowed list at all.
            violations.push({
              rule: "data",
              message: `Data class "${dataClass}" is not permitted to be processed by provider "${provider}". Allowed: ${rule.allowedProviders.map((ap) => ap.provider).join(", ")}.`,
              detail: { dataClass, provider, flowId: ctx.flowId },
            });
          } else if (
            matchingEntry.allowedRegions !== undefined &&
            matchingEntry.allowedRegions.length > 0
          ) {
            // Provider is allowed but must be in a specific region.
            // The LlmConfig does not carry a region field directly; it is
            // passed via ctx.region. We warn when it is absent (cannot enforce
            // without it). Operators should ensure flows pass region context.
            const region = ctx.region;
            if (region === undefined) {
              // Region unknown — add a warning-level violation (logged but not
              // blocking, since we cannot determine the region at call-time for
              // all providers). Operators should ensure the flow is configured
              // with a region-constrained deployment.
              violations.push({
                rule: "data",
                message: `Data class "${dataClass}" requires provider "${provider}" in regions [${matchingEntry.allowedRegions.join(", ")}] but the request carries no region context. Configure the flow's LLM region to enforce data-residency.`,
                detail: { dataClass, provider, allowedRegions: matchingEntry.allowedRegions, flowId: ctx.flowId },
                // Advisory only: we cannot verify data-residency without a
                // region, but the provider itself IS on the allow-list, so
                // this must not deny the request outright (see doc comment
                // on PolicyViolation.blocking).
                blocking: false,
              });
            } else if (!matchingEntry.allowedRegions.includes(region)) {
              violations.push({
                rule: "data",
                message: `Data class "${dataClass}" is not permitted in region "${region}" for provider "${provider}". Allowed regions: ${matchingEntry.allowedRegions.join(", ")}.`,
                detail: { dataClass, provider, region, allowedRegions: matchingEntry.allowedRegions, flowId: ctx.flowId },
              });
            }
          }
          // else: provider allowed, no region restriction — OK.
        }
      }
    }

    // ── 2. Model rules ────────────────────────────────────────────────────
    if (policy.modelRules !== undefined && policy.modelRules.length > 0 && ctx.llmConfig !== undefined) {
      const { provider, model } = ctx.llmConfig;
      const tenant = ctx.tenantId ?? "default";
      const applicableRules = policy.modelRules.filter(
        (r) => r.tenant === "*" || r.tenant === tenant,
      );
      for (const rule of applicableRules) {
        // Check blocked models first (takes precedence).
        if (rule.blockedModels !== undefined) {
          const blocked = rule.blockedModels.some(
            (bm) => bm.provider === provider && matchesGlob(bm.model, model),
          );
          if (blocked) {
            violations.push({
              rule: "model",
              message: `Model "${provider}/${model}" is blocked for tenant "${tenant}".`,
              detail: { provider, model, tenant, flowId: ctx.flowId },
            });
            continue;
          }
        }
        // Check allowlist (when defined, anything not listed is blocked).
        if (rule.allowedModels !== undefined && rule.allowedModels.length > 0) {
          const allowed = rule.allowedModels.some(
            (am) => am.provider === provider && matchesGlob(am.model, model),
          );
          if (!allowed) {
            violations.push({
              rule: "model",
              message: `Model "${provider}/${model}" is not on the allowed-model list for tenant "${tenant}".`,
              detail: { provider, model, tenant, flowId: ctx.flowId },
            });
          }
        }
      }
    }

    // ── 3. Approval rules ─────────────────────────────────────────────────
    const requiresApproval = findMatchingApprovalRule(policy, ctx) !== undefined;

    // ── 4. Final decision ─────────────────────────────────────────────────
    const denyViolations = violations.filter(
      (v) => (v.rule === "data" || v.rule === "model") && v.blocking !== false,
    );

    let decision: PolicyDecision;
    if (denyViolations.length > 0) {
      decision = "deny";
    } else if (requiresApproval) {
      decision = "require-approval";
    } else {
      decision = "allow";
    }

    return { decision, violations, policyAbsent: false };
  } catch (err) {
    // Fail-closed: any evaluation error → deny.
    if (policy.failClosed !== false) {
      return {
        decision: "deny",
        violations: [
          {
            rule: "data",
            message: `Policy evaluation error (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        policyAbsent: false,
      };
    }
    // Fail-open (development mode only): allow through but record the error.
    return {
      decision: "allow",
      violations: [
        {
          rule: "data",
          message: `Policy evaluation error (fail-open): ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      policyAbsent: false,
    };
  }
}

/**
 * Evaluates the policy across every distinct LLM config a flow statically
 * declares (see `collectFlowLlmConfigs` in `routes/chat/handler.ts`). A flow
 * can route to different models per node, so it is denied if ANY declared
 * model/data-class combination violates a data or model rule — evaluating
 * only the first node's config would miss violations further down the graph.
 *
 * Static tool approval rules are evaluated when callers provide `toolIds`.
 * This is appropriate for release/readiness analysis, where the declared tool
 * surface is known even though the tools selected by an individual run are not.
 * Runtime request admission continues to omit `toolIds`, so its behavior is
 * unchanged pending the execution-time approval gate (see ADR-0009).
 */
export function evaluatePolicyForModels(
  policy: CompliancePolicy | undefined,
  llmConfigs: readonly LlmConfig[],
  ctx: Omit<EvalRequestContext, "llmConfig">,
): PolicyEvalResult {
  if (policy === undefined || llmConfigs.length === 0) {
    return evaluatePolicy(policy, ctx);
  }

  const violations: PolicyViolation[] = [];
  let decision: PolicyDecision = "allow";
  for (const llmConfig of llmConfigs) {
    const result = evaluatePolicy(policy, { ...ctx, llmConfig });
    violations.push(...result.violations);
    if (result.decision === "deny") decision = "deny";
    else if (result.decision === "require-approval" && decision === "allow") {
      decision = "require-approval";
    }
  }
  return { decision, violations, policyAbsent: false };
}

export interface ToolApprovalRequirement {
  required: boolean;
  /**
   * The matched rule's `timeoutMs`, when it set one — pass through to
   * `ApprovalRegistry.request()`'s per-request override so a policy-declared
   * timeout actually takes effect instead of silently falling back to the
   * gate's global `APPROVAL_TIMEOUT_MS` (see ADR-0009).
   */
  timeoutMs?: number;
}

/**
 * Decides whether a single tool call requires human approval under the
 * compliance policy's `approvalRules` (ADR-0009), and with what timeout.
 * Shared by both runtime call sites that gate tool calls — the `llm` node's
 * agent loop (`agent-tools.ts`'s `buildAiTools`) and the deterministic `tool`
 * node (`handlers/tool.ts`) — so the two node types stay consistent with each
 * other rather than each re-implementing the same matching logic.
 *
 * Data/model rules are irrelevant to a single tool call and are not
 * evaluated here — this can only ever report `required: true` because of an
 * `approvalRules` match.
 */
export function policyRequiresToolApproval(
  policy: CompliancePolicy | undefined,
  toolRef: string,
  ctx: { role?: string; tenantId?: string; flowId?: string },
): ToolApprovalRequirement {
  if (policy === undefined) return { required: false };
  const rule = findMatchingApprovalRule(policy, { toolIds: [toolRef], ...ctx });
  if (rule === undefined) return { required: false };
  return {
    required: true,
    ...(rule.timeoutMs !== undefined ? { timeoutMs: rule.timeoutMs } : {}),
  };
}

/**
 * Returns only the retention rule for a data class, if one is configured.
 * Used by the retention sweep to respect policy-level retention overrides.
 */
export function getRetentionMaxAgeDays(
  policy: CompliancePolicy | undefined,
  dataClass: DataClass,
): number | undefined {
  return policy?.retentionRules?.find((r) => r.dataClass === dataClass)?.maxAgeDays;
}

/**
 * Returns the required audit verbosity for an action, or "minimal" if none
 * is configured.
 */
export function getAuditVerbosity(
  policy: CompliancePolicy | undefined,
  action: string,
): "minimal" | "full" {
  if (policy?.auditRules === undefined) return "minimal";
  const rule = policy.auditRules.find((r) => action.startsWith(r.actionPrefix));
  return rule?.verbosity ?? "minimal";
}
