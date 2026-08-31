// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Declarative Tool Authorization Policy Engine (`src/graph/tool-authz.ts`)
 *
 * Provides per-tenant, per-role rules that gate tool calls BEFORE they reach
 * the MCP wrapper. This is distinct from the human-in-the-loop approval gate
 * (which pauses the run and waits for a human reviewer) — tool authz enforces
 * machine-level access-control rules synchronously with no human in the loop.
 *
 * Policy format (loaded from `tool-authz.json` in the flows directory, or
 * supplied programmatically):
 *
 * ```json
 * {
 *   "rules": [
 *     {
 *       "id": "block-refund-above-100",
 *       "tool": "billing/refund",
 *       "match": {
 *         "tenantId": "acme",
 *         "role": "operator"
 *       },
 *       "constraints": {
 *         "amount": { "max": 100 }
 *       },
 *       "action": "deny"
 *     },
 *     {
 *       "id": "allow-search-all",
 *       "tool": "search/*",
 *       "action": "allow"
 *     }
 *   ],
 *   "defaultAction": "allow"
 * }
 * ```
 *
 * Rule evaluation:
 *   1. Rules are evaluated in order; the FIRST match wins.
 *   2. A rule matches when ALL specified `match` fields equal the request
 *      context AND all `constraints` pass.
 *   3. `tool` supports `*` as a glob suffix (e.g. `"search/*"`) or an exact
 *      `"server/toolName"` id.
 *   4. `constraints` maps argument names to `{ min?, max?, allowedValues? }`.
 *      A numeric argument outside `[min, max]` causes the rule to match.
 *      An argument not in `allowedValues` causes the rule to match.
 *   5. If no rule matches, `defaultAction` applies (default: "allow").
 *
 * No `any` at module boundaries.
 */

import { z } from "zod";
import type { RequestContext } from "../types/monitoring.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConstraintSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  allowedValues: z.array(z.unknown()).optional(),
});

const MatchSchema = z.object({
  tenantId: z.string().optional(),
  role: z.string().optional(),
  userId: z.string().optional(),
  clientId: z.string().optional(),
});

const RuleSchema = z.object({
  id: z.string(),
  /** Exact `server/tool` id or glob suffix like `server/*` or `*`. */
  tool: z.string(),
  /** Subset of request-context fields that must match for this rule to apply. */
  match: MatchSchema.optional(),
  /**
   * Per-argument constraints. A constraint "fires" when the argument VALUE
   * breaches the bound, so "deny if amount > 100" is `{ "amount": { "max": 100 } }`.
   *
   * Whether the rule applies is governed by {@link constraintMode}:
   *   - `"all"` (default, backward compatible): the rule applies only when
   *     EVERY listed constraint is breached.
   *   - `"any"`: the rule applies when AT LEAST ONE constraint is breached —
   *     the intuitive "deny if any limit is exceeded" semantic.
   */
  constraints: z.record(z.string(), ConstraintSchema).optional(),
  /**
   * How multiple `constraints` combine. Default `"all"` preserves the original
   * (AND) behaviour; `"any"` fires the rule as soon as one constraint is
   * breached (OR). Ignored when there are no constraints.
   */
  constraintMode: z.enum(["all", "any"]).optional(),
  action: z.enum(["allow", "deny"]),
  /** Human-readable explanation included in the denial error. */
  reason: z.string().optional(),
});

export const ToolAuthzPolicySchema = z.object({
  rules: z.array(RuleSchema).default([]),
  defaultAction: z.enum(["allow", "deny"]).default("allow"),
});

export type ToolAuthzRule = z.infer<typeof RuleSchema>;
export type ToolAuthzPolicy = z.infer<typeof ToolAuthzPolicySchema>;
export type ConstraintSpec = z.infer<typeof ConstraintSchema>;

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface AuthzDecision {
  allowed: boolean;
  /** ID of the rule that triggered this decision, or "default". */
  ruleId: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function toolMatches(pattern: string, toolId: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return toolId === prefix || toolId.startsWith(`${prefix}/`);
  }
  return pattern === toolId;
}

function contextMatches(
  match: z.infer<typeof MatchSchema> | undefined,
  ctx: RequestContext,
): boolean {
  if (match === undefined) return true;
  if (match.tenantId !== undefined && match.tenantId !== ctx.clientId)
    return false;
  if (match.userId !== undefined && match.userId !== ctx.userId) return false;
  if (match.clientId !== undefined && match.clientId !== ctx.clientId)
    return false;
  if (match.role !== undefined && match.role !== ctx.role) return false;
  return true;
}

/**
 * Returns true when the constraint is violated (i.e. the value is out of policy).
 * A missing argument is treated as a pass (not a violation) — the constraint
 * only applies when the arg is present in the call.
 */
function constraintViolated(
  argName: string,
  spec: ConstraintSpec,
  args: Record<string, unknown>,
): boolean {
  if (!(argName in args)) return false;
  const val = args[argName];
  if (typeof val === "number") {
    if (spec.min !== undefined && val < spec.min) return true;
    if (spec.max !== undefined && val > spec.max) return true;
  }
  if (spec.allowedValues !== undefined) {
    const allowed = spec.allowedValues;
    // JSON comparison for primitives and simple values.
    const valStr = JSON.stringify(val);
    if (!allowed.some((a) => JSON.stringify(a) === valStr)) return true;
  }
  return false;
}

/**
 * Decides whether the constraint set is breached for a matching tool call.
 *   - `mode === "all"` (default): breached only when EVERY constraint fires (AND).
 *   - `mode === "any"`: breached when AT LEAST ONE constraint fires (OR).
 * With no constraints the rule fires on context match alone.
 */
function constraintsViolated(
  constraints: Record<string, ConstraintSpec> | undefined,
  args: Record<string, unknown>,
  mode: "all" | "any" = "all",
): boolean {
  if (constraints === undefined) return true; // no constraints → rule fires on context match alone
  const entries = Object.entries(constraints);
  if (entries.length === 0) return true;
  const fired = (e: [string, ConstraintSpec]) =>
    constraintViolated(e[0], e[1], args);
  return mode === "any" ? entries.some(fired) : entries.every(fired);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ToolAuthzPolicyDescription {
  active: boolean;
  ruleCount: number;
  defaultAction: "allow" | "deny";
  rules: Array<{
    id: string;
    tool: string;
    action: "allow" | "deny";
    match?: Record<string, string>;
    constraints?: Record<string, ConstraintSpec>;
    constraintMode?: "all" | "any";
    reason?: string;
  }>;
}

export interface ToolAuthzEngine {
  /**
   * Evaluate whether the tool call is permitted.
   * Fast path (no policy / empty rules): returns `{ allowed: true, ruleId: "default" }`.
   */
  evaluate(
    toolId: string,
    args: Record<string, unknown>,
    ctx: RequestContext,
  ): AuthzDecision;

  /** True when at least one rule is configured. */
  readonly active: boolean;

  /** Returns a read-only description of the loaded policy (for the dashboard). */
  describe(): ToolAuthzPolicyDescription;
}

class ToolAuthzEngineImpl implements ToolAuthzEngine {
  constructor(private readonly policy: ToolAuthzPolicy) {}

  get active(): boolean {
    return this.policy.rules.length > 0;
  }

  describe(): ToolAuthzPolicyDescription {
    return {
      active: this.active,
      ruleCount: this.policy.rules.length,
      defaultAction: this.policy.defaultAction,
      rules: this.policy.rules.map((r) => ({
        id: r.id,
        tool: r.tool,
        action: r.action,
        ...(r.match !== undefined
          ? { match: r.match as Record<string, string> }
          : {}),
        ...(r.constraints !== undefined ? { constraints: r.constraints } : {}),
        ...(r.constraintMode !== undefined
          ? { constraintMode: r.constraintMode }
          : {}),
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      })),
    };
  }

  evaluate(
    toolId: string,
    args: Record<string, unknown>,
    ctx: RequestContext,
  ): AuthzDecision {
    for (const rule of this.policy.rules) {
      if (!toolMatches(rule.tool, toolId)) continue;
      if (!contextMatches(rule.match, ctx)) continue;
      if (
        !constraintsViolated(
          rule.constraints,
          args,
          rule.constraintMode ?? "all",
        )
      )
        continue;
      // Rule matches.
      return {
        allowed: rule.action === "allow",
        ruleId: rule.id,
        reason: rule.reason,
      };
    }
    // No rule matched → use the policy default.
    return {
      allowed: this.policy.defaultAction === "allow",
      ruleId: "default",
    };
  }
}

class NoopToolAuthzEngine implements ToolAuthzEngine {
  readonly active = false;
  evaluate(): AuthzDecision {
    return { allowed: true, ruleId: "default" };
  }
  describe(): ToolAuthzPolicyDescription {
    return { active: false, ruleCount: 0, defaultAction: "allow", rules: [] };
  }
}

/**
 * Fail-closed engine used when a policy file is present but could not be parsed
 * and the operator opted into fail-closed mode. Denies EVERY tool call so a
 * broken/corrupt policy degrades to "no tools" rather than "all tools allowed"
 * (which is what a Noop engine would do). It reports `active: true` so the
 * dispatch site actually consults it.
 */
class DenyAllToolAuthzEngine implements ToolAuthzEngine {
  readonly active = true;
  constructor(private readonly denyReason: string) {}
  evaluate(): AuthzDecision {
    return { allowed: false, ruleId: "fail-closed", reason: this.denyReason };
  }
  describe(): ToolAuthzPolicyDescription {
    return { active: true, ruleCount: 0, defaultAction: "deny", rules: [] };
  }
}

const FAIL_CLOSED_REASON =
  "tool authorization policy failed to load — denying all tool calls (fail-closed)";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Options controlling how a policy-load failure is handled. */
export interface ToolAuthzFactoryOptions {
  /**
   * When true (the default), a malformed/unparseable policy yields a
   * {@link DenyAllToolAuthzEngine} (every tool call denied) instead of a
   * permissive no-op. This aligns tool authorization with the "security fails
   * closed" principle: a broken policy must not silently grant access. Set to
   * `false` only to consciously opt into the legacy fail-open behaviour.
   */
  failClosed?: boolean;
}

/** Public entry point to build the fail-closed engine (e.g. from the loader). */
export function createDenyAllToolAuthzEngine(reason?: string): ToolAuthzEngine {
  return new DenyAllToolAuthzEngine(reason ?? FAIL_CLOSED_REASON);
}

/**
 * Build a ToolAuthzEngine from a raw policy object (already parsed from JSON).
 * Returns a no-op engine when `policy` is undefined or has no rules. When the
 * object fails schema validation, returns a fail-closed deny-all engine by
 * default (secure default); pass `opts.failClosed: false` for a permissive no-op.
 */
export function createToolAuthzEngine(
  policy: unknown,
  opts: ToolAuthzFactoryOptions = {},
): ToolAuthzEngine {
  if (policy === null || policy === undefined) return new NoopToolAuthzEngine();
  const parsed = ToolAuthzPolicySchema.safeParse(policy);
  if (!parsed.success) {
    // Malformed policy: fail closed (deny all) by default; only fail open when
    // the caller explicitly opted out (failClosed === false).
    return opts.failClosed === false
      ? new NoopToolAuthzEngine()
      : new DenyAllToolAuthzEngine(FAIL_CLOSED_REASON);
  }
  if (parsed.data.rules.length === 0) return new NoopToolAuthzEngine();
  return new ToolAuthzEngineImpl(parsed.data);
}

/**
 * Build a ToolAuthzEngine from a raw JSON string.
 * Returns `{ engine, error }` — `error` is set when parsing failed. On failure
 * the engine denies all calls by default (secure default); pass
 * `opts.failClosed: false` for a permissive no-op.
 */
export function createToolAuthzEngineFromJson(
  json: string,
  opts: ToolAuthzFactoryOptions = {},
): { engine: ToolAuthzEngine; error?: string } {
  const failEngine = (): ToolAuthzEngine =>
    opts.failClosed === false
      ? new NoopToolAuthzEngine()
      : new DenyAllToolAuthzEngine(FAIL_CLOSED_REASON);
  try {
    const raw: unknown = JSON.parse(json);
    const parsed = ToolAuthzPolicySchema.safeParse(raw);
    if (!parsed.success) {
      return {
        engine: failEngine(),
        error: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      };
    }
    return { engine: new ToolAuthzEngineImpl(parsed.data) };
  } catch (err) {
    return {
      engine: failEngine(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
