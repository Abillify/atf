// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Evaluates a flow's `variables` map before its values are substituted into
 * nodes and edges. A variable value may contain:
 *
 *   {{vars.other}}            another variable (dependency order, cycles are errors)
 *   {{const.name}}            a global constant from flows/constants.yaml
 *   {{env.FLOW_PUBLIC_NAME}}  an allowlisted environment value
 *   {{= vars.a * 2 }}         a calculation (variable-expressions.ts)
 *
 * A value that is exactly one placeholder keeps the referenced value's type
 * (`{{const.max_tokens}}` stays a number); placeholders inside longer text are
 * stringified. Anything else in `{{ }}` (runtime templates such as
 * `{{classification.x}}`) is left untouched.
 *
 * Request overrides are LITERALS: they replace a variable's value but are never
 * evaluated themselves — a caller must not be able to run calculations or read
 * env through `variables` in a chat request. Declared variables that reference
 * an overridden one do see the override.
 *
 * An unresolvable reference leaves its placeholder in place and is reported in
 * `errors` (the validator turns those into flow errors).
 */

import { publicEnv, currentFlowConstants, PUBLIC_ENV_PREFIX } from "./flow-constants.js";
import { ExpressionError, evaluateExpression } from "./variable-expressions.js";

export interface VariableContext {
  constants: Record<string, unknown>;
  env: Record<string, string>;
}

export interface VariableError {
  /** Variable whose value failed to evaluate. */
  name: string;
  message: string;
}

export interface EvaluatedVariables {
  values: Record<string, unknown>;
  errors: VariableError[];
}

/** Context of the active flows directory and process env. */
export function currentVariableContext(): VariableContext {
  return { constants: currentFlowConstants(), env: publicEnv() };
}

const EXPR_EXACT_RE = /^\{\{=([\s\S]*?)\}\}$/;
const REF_EXACT_RE = /^\{\{\s*(vars|const|env)\.([\w.-]+)\s*\}\}$/;
const ANY_RE = /\{\{=([\s\S]*?)\}\}|\{\{\s*(vars|const|env)\.([\w.-]+)\s*\}\}/g;

/** Cheap pre-check: does any value need evaluation at all? */
function needsEvaluation(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some(needsEvaluation);
  if (value !== null && typeof value === "object") return Object.values(value).some(needsEvaluation);
  return false;
}

function dig(value: unknown, segments: string[]): unknown {
  let cur = value;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function asText(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

export function evaluateFlowVariables(
  declared: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> | undefined,
  context: VariableContext = currentVariableContext(),
): EvaluatedVariables {
  const decl = declared ?? {};
  const over = overrides ?? {};
  const merged = { ...decl, ...over };
  if (!Object.values(decl).some(needsEvaluation)) return { values: merged, errors: [] };

  const values: Record<string, unknown> = { ...over };
  const done = new Set(Object.keys(over));
  const stack: string[] = [];
  const errors: VariableError[] = [];

  const lookup = (root: string, dotted: string): unknown => {
    const [head = "", ...rest] = dotted.split(".");
    if (root === "vars") {
      if (!(head in merged)) throw new ExpressionError(`Unknown variable "vars.${head}".`);
      return dig(variable(head), rest);
    }
    if (root === "const") {
      if (!(head in context.constants)) {
        throw new ExpressionError(`Unknown constant "const.${head}" (flows/constants.yaml).`);
      }
      return dig(context.constants[head], rest);
    }
    if (!head.startsWith(PUBLIC_ENV_PREFIX)) {
      throw new ExpressionError(
        `env.${head} is not readable — only variables named ${PUBLIC_ENV_PREFIX}* are exposed to flows.`,
      );
    }
    const v = context.env[head];
    if (v === undefined) throw new ExpressionError(`Environment variable ${head} is not set.`);
    return v;
  };

  const evalString = (s: string): unknown => {
    const expr = EXPR_EXACT_RE.exec(s);
    if (expr !== null) {
      return evaluateExpression(expr[1] ?? "", (path) => {
        const dot = path.indexOf(".");
        return lookup(path.slice(0, dot), path.slice(dot + 1));
      });
    }
    const ref = REF_EXACT_RE.exec(s);
    if (ref !== null) return lookup(ref[1] ?? "", ref[2] ?? "");
    return s.replace(ANY_RE, (_m, calc: string | undefined, root: string | undefined, dotted: string | undefined) =>
      asText(
        calc !== undefined
          ? evaluateExpression(calc, (path) => {
              const dot = path.indexOf(".");
              return lookup(path.slice(0, dot), path.slice(dot + 1));
            })
          : lookup(root ?? "", dotted ?? ""),
      ),
    );
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.includes("{{") ? evalString(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };

  function variable(name: string): unknown {
    if (done.has(name)) return values[name];
    if (stack.includes(name)) {
      throw new ExpressionError(`Circular reference: ${[...stack.slice(stack.indexOf(name)), name].join(" → ")}.`);
    }
    stack.push(name);
    try {
      values[name] = walk(decl[name]);
    } finally {
      stack.pop();
    }
    done.add(name);
    return values[name];
  }

  for (const name of Object.keys(decl)) {
    if (done.has(name)) continue;
    try {
      variable(name);
    } catch (err) {
      // Only the variable being evaluated at top level records the error; the
      // raw value stays so the placeholder remains visible.
      if (!(err instanceof ExpressionError)) throw err;
      errors.push({ name, message: err.message });
      values[name] = decl[name];
      done.add(name);
    }
  }
  return { values, errors };
}

// ---------------------------------------------------------------------------
// Load-time placeholders in node and edge values
// ---------------------------------------------------------------------------

/** Any load-time placeholder: a variable, constant, public env value or calculation. */
const LOAD_TIME_RE = /\{\{=([\s\S]*?)\}\}|\{\{\s*(vars|const|env)\.([\w.-]+)\s*\}\}/g;

/**
 * Cheap check whether a value contains anything the load-time resolver would
 * touch. `withVars: false` ignores `{{vars.*}}` — without variables those can
 * only stay unresolved, so a flow without variables needs work only for
 * constants, env and calculations.
 */
export function hasLoadTimePlaceholders(value: unknown, withVars = true): boolean {
  if (typeof value === "string") {
    return (withVars ? /\{\{\s*(=|vars\.|const\.|env\.)/ : /\{\{\s*(=|const\.|env\.)/).test(value);
  }
  if (Array.isArray(value)) return value.some((v) => hasLoadTimePlaceholders(v, withVars));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => hasLoadTimePlaceholders(v, withVars));
  }
  return false;
}

/**
 * Resolves load-time placeholders in node and edge values against the
 * EVALUATED variables: `{{vars.x}}`, `{{const.x}}`, `{{env.FLOW_PUBLIC_X}}` and
 * `{{= … }}`. A value that is exactly one placeholder keeps the referenced
 * value's type. A placeholder that cannot be resolved stays as written and is
 * reported through `onError` (the flow still loads — the validator turns these
 * into errors, see {@link checkLoadTimePlaceholders}). Runtime placeholders
 * (`{{context.*}}`, `{{classification.*}}`, …) are left for the run.
 *
 * Returns a walker that mutates objects/arrays in place and returns the
 * (possibly replaced) value.
 */
export function createLoadTimeResolver(
  values: Record<string, unknown>,
  context: VariableContext,
  onError: (placeholder: string, message: string) => void,
): (value: unknown) => unknown {
  const lookup = (root: string, dotted: string): unknown => {
    const [head = "", ...rest] = dotted.split(".");
    if (root === "vars") {
      const v = dig(values, [head, ...rest]);
      if (v === undefined) throw new ExpressionError(`Unknown variable "vars.${dotted}".`);
      return v;
    }
    if (root === "const") {
      if (!(head in context.constants)) {
        throw new ExpressionError(`Unknown constant "const.${head}" (flows/constants.yaml).`);
      }
      return dig(context.constants[head], rest);
    }
    if (!head.startsWith(PUBLIC_ENV_PREFIX)) {
      throw new ExpressionError(
        `env.${head} is not readable — only variables named ${PUBLIC_ENV_PREFIX}* are exposed to flows.`,
      );
    }
    const v = context.env[head];
    if (v === undefined) throw new ExpressionError(`Environment variable ${head} is not set.`);
    return v;
  };
  const byPath = (path: string): unknown => {
    const dot = path.indexOf(".");
    return lookup(path.slice(0, dot), path.slice(dot + 1));
  };
  const resolveOne = (
    _placeholder: string,
    calc: string | undefined,
    root?: string,
    dotted?: string,
  ): unknown =>
    calc !== undefined
      ? evaluateExpression(calc, byPath)
      : lookup(root ?? "", dotted ?? "");

  const resolveString = (s: string): unknown => {
    if (!s.includes("{{")) return s;
    const matches = [...s.matchAll(LOAD_TIME_RE)];
    if (matches.length === 0) return s;
    const only = matches[0];
    if (matches.length === 1 && only !== undefined && only[0] === s) {
      try {
        return resolveOne(s, only[1], only[2], only[3]);
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err;
        onError(s, err.message);
        return s;
      }
    }
    return s.replace(LOAD_TIME_RE, (match, calc: string | undefined, root: string | undefined, dotted: string | undefined) => {
      try {
        return asText(resolveOne(match, calc, root, dotted));
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err;
        onError(match, err.message);
        return match;
      }
    });
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return resolveString(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i]);
      return value;
    }
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) obj[key] = walk(obj[key]);
      return obj;
    }
    return value;
  };
  return walk;
}

export interface PlaceholderIssue {
  /** e.g. `nodes[2](answer).llm.parameters.maxTokens` */
  path: string;
  message: string;
  /** Unknown `{{vars.*}}` are warnings: a caller may supply them per request. */
  severity: "error" | "warning";
}

/**
 * Finds load-time placeholders in a flow's nodes and edges that do not
 * resolve (unknown variable/constant, env outside the allowlist, calculation
 * error). Used by the validator; does not modify the flow.
 */
export function checkLoadTimePlaceholders(
  flow: { variables?: Record<string, unknown>; nodes?: unknown[]; edges?: unknown[] },
  context: VariableContext = currentVariableContext(),
): PlaceholderIssue[] {
  const { values } = evaluateFlowVariables(flow.variables, undefined, context);
  const issues: PlaceholderIssue[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (!hasLoadTimePlaceholders(value)) return;
      createLoadTimeResolver(values, context, (placeholder, message) => {
        issues.push({
          path,
          message: `${placeholder}: ${message}`,
          severity: /^\{\{\s*vars\./.test(placeholder) && message.startsWith("Unknown variable") ? "warning" : "error",
        });
      })(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        visit(v, `${path}[${i}]`);
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
    }
  };
  (flow.nodes ?? []).forEach((n, i) => {
    const id = (n as { id?: unknown } | null)?.id;
    visit(n, `nodes[${i}]${typeof id === "string" ? `(${id})` : ""}`);
  });
  (flow.edges ?? []).forEach((e, i) => {
    visit(e, `edges[${i}]`);
  });
  return issues;
}
