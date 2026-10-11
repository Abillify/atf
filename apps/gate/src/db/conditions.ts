// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { resolveContextPath, type AuthContext } from "../auth/context.ts";
import type { Condition, ConditionRule } from "../config/schema.ts";

/**
 * Evaluates declarative, author-defined conditions against the auth context.
 * Conditions never contain SQL and never see caller input - they only gate
 * which author-controlled SQL fragment a template emits.
 */
function evalRule(rule: ConditionRule, ctx: AuthContext): boolean {
  const value = resolveContextPath(ctx, rule.context);
  let ok = true;

  if (rule.in !== undefined) {
    const set = rule.in.map((v) => String(v));
    ok = ok && value !== undefined && set.includes(String(value));
  }
  if (rule.equals !== undefined) {
    ok = ok && String(value) === String(rule.equals);
  }
  if (rule.exists !== undefined) {
    ok = ok && (value !== undefined && value !== null) === rule.exists;
  }
  if (rule.containsAny !== undefined || rule.containsAll !== undefined) {
    const values =
      Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
        ? value
        : undefined;
    if (rule.containsAny !== undefined)
      ok = ok && values !== undefined && rule.containsAny.some((entry) => values.includes(entry));
    if (rule.containsAll !== undefined)
      ok = ok && values !== undefined && rule.containsAll.every((entry) => values.includes(entry));
  }
  return ok;
}

function evalCondition(cond: Condition, ctx: AuthContext): boolean {
  const anyOk = cond.any === undefined ? true : cond.any.some((r) => evalRule(r, ctx));
  const allOk = cond.all === undefined ? true : cond.all.every((r) => evalRule(r, ctx));
  return anyOk && allOk;
}

/** Evaluate every named condition to a boolean for the current request. */
export function evaluateConditions(
  conditions: Record<string, Condition>,
  ctx: AuthContext,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, cond] of Object.entries(conditions)) {
    out[name] = evalCondition(cond, ctx);
  }
  return out;
}

/**
 * Req 6.7 / ADR-0002: A condition is *privileged* when any of its rules reads
 * the caller's verified `scopes` context (e.g. `context: scopes` with
 * `containsAny: ["timesheets:admin"]`). Such conditions guard privileged SQL
 * branches (act-for-other-person, unmasked data, admin writes). When business
 * authorization is disabled there is no verified scope set, so these names
 * must fail closed (`false`) instead of inheriting a blanket `true` —
 * detection is structural (which context a rule reads), not name-based.
 */
export function privilegedConditionNames(
  conditions: Record<string, Condition>,
): ReadonlySet<string> {
  const readsScopes = (rule: ConditionRule): boolean =>
    rule.context === "scopes" || rule.context.startsWith("scopes.");
  const names = new Set<string>();
  for (const [name, cond] of Object.entries(conditions)) {
    const rules = [...(cond.any ?? []), ...(cond.all ?? [])];
    if (rules.some(readsScopes)) names.add(name);
  }
  return names;
}
