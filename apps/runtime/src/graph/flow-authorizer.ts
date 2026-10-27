// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Authorizer (`src/graph/flow-authorizer.ts`)
 *
 * Enforces per-tenant / per-identity access control over which flows a request
 * may execute. The flow dispatcher decides which flow to *route* to, but a
 * client can still name any flow ID directly in the `model` field — without an
 * authorization layer any tenant who knows a flow ID could run it. This module
 * closes that gap.
 *
 * Access rules live in a reserved `access.json` file inside `flowsDir`,
 * hot-reloaded on change (like `dispatch.json`). When the file is ABSENT the
 * authorizer allows everything — fully backward compatible with deployments
 * that have no access policy.
 *
 * access.json example:
 * {
 *   "defaultEffect": "deny",
 *   "rules": [
 *     { "flow": "public-flow" },                                  // open to all
 *     { "flow": "admin-flow", "allowRoles": ["admin"] },
 *     { "flow": "de-enterprise-flow",
 *       "allowGroups": ["enterprise"], "allowLanguages": ["de"] },
 *     { "flow": "tenant-a-flow", "allowTenants": ["tenant-a"] },
 *     { "flow": "*", "allowClaim": "tier == 'gold'" }             // catch-all
 *   ]
 * }
 *
 * Semantics:
 *   - A rule APPLIES to a flow when `rule.flow` equals the flow ID or is "*".
 *   - Within a rule, every declared allow-constraint must be satisfied (AND
 *     across constraint *types*, OR within a list). A rule with no constraints
 *     is an unconditional allow for its flow.
 *   - A request is ALLOWED when at least one applicable rule matches the
 *     request context.
 *   - When applicable rules exist but none match → DENY.
 *   - When NO rule applies to the flow → fall back to `defaultEffect`
 *     (default "allow").
 *
 * Trust note: role/group/plan/claim attributes are only trustworthy when
 * cryptographic JWT verification is enabled. The production-readiness gate
 * already makes format-only JWT fatal under APP_ENV=production, so policy
 * decisions are safe there.
 */

import { z } from "zod";
import type { FlowDefinition } from "../types/flow.js";
import type { RequestContext } from "../types/monitoring.js";
import { evaluateConditionExpression } from "./condition-evaluator.js";
import type { Logger } from "../observability/logger.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AccessRuleSchema = z.object({
  /** Flow ID this rule applies to, or "*" for all flows. */
  flow: z.string().min(1),
  /** Allowed roles (matches ctx.role). */
  allowRoles: z.array(z.string().min(1)).max(100).optional(),
  /** Allowed groups (matches if ctx.groups intersects). */
  allowGroups: z.array(z.string().min(1)).max(100).optional(),
  /** Allowed plans (matches ctx.plan). */
  allowPlans: z.array(z.string().min(1)).max(100).optional(),
  /** Allowed tenant IDs (matches ctx.clientId). */
  allowTenants: z.array(z.string().min(1)).max(1000).optional(),
  /** Allowed language prefixes (matches ctx.language, prefix). */
  allowLanguages: z.array(z.string().min(1)).max(100).optional(),
  /** Safe expression against JWT claims, e.g. "tier == 'gold'". */
  allowClaim: z.string().min(1).max(1024).optional(),
});

export type AccessRule = z.infer<typeof AccessRuleSchema>;

const AccessTableSchema = z.object({
  defaultEffect: z.enum(["allow", "deny"]).default("allow"),
  rules: z.array(AccessRuleSchema).max(1000).default([]),
});

export type AccessTable = z.infer<typeof AccessTableSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadAccessTable(
  flowsDir: string,
  logger?: Logger,
): AccessTable | undefined {
  const filePath = resolveConfigFile(flowsDir, "access");
  if (filePath === null) {
    // No policy file → authorizer is a no-op (allow everything).
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    logger?.warn(
      "Failed to read/parse access config — failing CLOSED (deny all)",
      {
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    // A malformed policy must not silently open access — deny everything.
    return { defaultEffect: "deny", rules: [] };
  }
  const result = AccessTableSchema.safeParse(raw);
  if (!result.success) {
    logger?.warn(
      "access config failed schema validation — failing CLOSED (deny all)",
      {
        file: filePath,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    );
    return { defaultEffect: "deny", rules: [] };
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function ruleApplies(rule: AccessRule, flowId: string): boolean {
  return rule.flow === "*" || rule.flow === flowId;
}

/** True when the request context satisfies every declared constraint in the rule. */
function ruleMatchesContext(rule: AccessRule, ctx: RequestContext): boolean {
  if (rule.allowRoles !== undefined) {
    if (ctx.role === undefined || !rule.allowRoles.includes(ctx.role))
      return false;
  }
  if (rule.allowGroups !== undefined) {
    const groups = ctx.groups ?? [];
    if (!rule.allowGroups.some((g) => groups.includes(g))) return false;
  }
  if (rule.allowPlans !== undefined) {
    if (ctx.plan === undefined || !rule.allowPlans.includes(ctx.plan))
      return false;
  }
  if (rule.allowTenants !== undefined) {
    if (
      ctx.clientId === undefined ||
      !rule.allowTenants.includes(ctx.clientId)
    )
      return false;
  }
  if (rule.allowLanguages !== undefined) {
    const lang = ctx.language ?? "";
    if (!rule.allowLanguages.some((l) => lang.startsWith(l))) return false;
  }
  if (rule.allowClaim !== undefined) {
    if (!evaluateConditionExpression(rule.allowClaim, ctx.claims ?? {}))
      return false;
  }
  return true;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Pure decision function — exported for unit testing. Evaluates a request
 * against an access table. `undefined` table means "no policy" → always allow.
 */
export function decideAccess(
  table: AccessTable | undefined,
  flowId: string,
  ctx: RequestContext,
): AccessDecision {
  if (table === undefined) return { allowed: true };

  const applicable = table.rules.filter((r) => ruleApplies(r, flowId));

  if (applicable.length === 0) {
    return table.defaultEffect === "allow"
      ? { allowed: true }
      : {
          allowed: false,
          reason: `No access rule permits flow "${flowId}" (default deny).`,
        };
  }

  for (const rule of applicable) {
    if (ruleMatchesContext(rule, ctx)) return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Access to flow "${flowId}" is not permitted for this identity.`,
  };
}

// ---------------------------------------------------------------------------
// Declarative flow scopes
// ---------------------------------------------------------------------------

/** Default JWT claims checked for declarative flow scopes. */
export const DEFAULT_FLOW_SCOPE_CLAIMS = ["scope", "scp"] as const;

function scopeValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope !== "");
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => scopeValues(item));
  }
  return [];
}

/** Extracts the distinct OAuth/OIDC scopes from configured, verified JWT claims. */
export function scopesFromClaims(
  claims: RequestContext["claims"],
  claimSources: readonly string[] = DEFAULT_FLOW_SCOPE_CLAIMS,
): string[] {
  const sources = claimSources
    .map((source) => source.trim())
    .filter((source) => source !== "");
  const effectiveSources =
    sources.length > 0 ? sources : [...DEFAULT_FLOW_SCOPE_CLAIMS];
  return [
    ...new Set(
      effectiveSources.flatMap((source) => scopeValues(claims?.[source])),
    ),
  ];
}

/**
 * Evaluates a flow's declarative scope requirement with AND semantics. Missing
 * or unusable claims deliberately grant no scopes, so protected flows fail
 * closed for API keys, webhooks, and other non-JWT callers.
 */
export function decideRequiredScopes(
  requiredScopes: readonly string[] | undefined,
  ctx: RequestContext,
  claimSources: readonly string[] = DEFAULT_FLOW_SCOPE_CLAIMS,
): AccessDecision {
  if (requiredScopes === undefined || requiredScopes.length === 0) {
    return { allowed: true };
  }
  const granted = new Set(scopesFromClaims(ctx.claims, claimSources));
  return requiredScopes.every((scope) => granted.has(scope))
    ? { allowed: true }
    : {
        allowed: false,
        reason: "Required flow scopes are not granted.",
      };
}

/** Combines legacy access.json policies with FlowDefinition.requiredScopes. */
export function decideFlowAccess(
  flow: FlowDefinition,
  ctx: RequestContext,
  authorizer: FlowAuthorizer | undefined,
  claimSources: readonly string[] = DEFAULT_FLOW_SCOPE_CLAIMS,
  authorizationEnabled = true,
): AccessDecision {
  if (!authorizationEnabled) return { allowed: true };
  const policyDecision = authorizer?.authorize(flow.id, ctx) ?? { allowed: true };
  if (!policyDecision.allowed) return policyDecision;
  return decideRequiredScopes(flow.requiredScopes, ctx, claimSources);
}

// ---------------------------------------------------------------------------
// Authorizer
// ---------------------------------------------------------------------------

export interface FlowAuthorizer {
  /** Decides whether `ctx` may execute `flowId`. */
  authorize(flowId: string, ctx: RequestContext): AccessDecision;
  /** Reloads access.json from disk (hot-reload on change). */
  reload(): void;
  /** True when an access policy file is currently loaded. */
  hasPolicy(): boolean;
}

class FlowAuthorizerImpl implements FlowAuthorizer {
  private table: AccessTable | undefined;

  constructor(
    private readonly flowsDir: string,
    private readonly logger?: Logger,
  ) {
    this.table = loadAccessTable(flowsDir, logger);
  }

  authorize(flowId: string, ctx: RequestContext): AccessDecision {
    const decision = decideAccess(this.table, flowId, ctx);
    if (!decision.allowed) {
      this.logger?.warn("Flow access denied", {
        flowId,
        role: ctx.role,
        plan: ctx.plan,
        clientId: ctx.clientId,
        reason: decision.reason,
      });
    }
    return decision;
  }

  reload(): void {
    this.table = loadAccessTable(this.flowsDir, this.logger);
    this.logger?.info("Access policy reloaded", {
      hasPolicy: this.table !== undefined,
      defaultEffect: this.table?.defaultEffect,
      ruleCount: this.table?.rules.length ?? 0,
    });
  }

  hasPolicy(): boolean {
    return this.table !== undefined;
  }
}

export function createFlowAuthorizer(
  flowsDir: string,
  logger?: Logger,
): FlowAuthorizer {
  return new FlowAuthorizerImpl(flowsDir, logger);
}
