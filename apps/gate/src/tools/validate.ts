// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Minimal JSON-Schema validator for tool input.
 *
 * Validates MCP call arguments against a tool's `inputSchema` BEFORE the tool
 * runs, so malformed calls (missing required params, wrong types, out-of-enum
 * values) are rejected with a clear message instead of producing a confusing
 * downstream error or a NULL bind. It intentionally supports only the common
 * subset of JSON Schema used by tool definitions; anything it does not
 * understand is treated as "no constraint" (fail-open per keyword), so a more
 * elaborate schema never causes false rejections.
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  if (t === "boolean") return "boolean";
  if (t === "object") return "object";
  return "string";
}

/** True when `value` satisfies the JSON-Schema `type` (string or array of). */
function matchesType(value: unknown, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  for (const t of types) {
    if (typeof t !== "string") return true; // unknown type spec → don't constrain
    if (t === actual) return true;
    // integers are valid numbers; a whole-valued number satisfies "integer".
    if (t === "number" && (actual === "integer" || actual === "number")) return true;
    if (t === "integer" && actual === "integer") return true;
  }
  return false;
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join("|") : String(schema.type);
    errors.push(`${path || "value"}: expected ${want}, got ${typeOf(value)}`);
    return; // further checks would be noise once the type is wrong
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path || "value"}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }

  // Object: required + per-property recursion.
  if (typeOf(value) === "object" && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && (obj[key] === undefined || obj[key] === null)) {
          errors.push(`${path ? path + "." : ""}${key}: required`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      const props = schema.properties as Record<string, unknown>;
      for (const [key, sub] of Object.entries(props)) {
        if (obj[key] !== undefined && sub && typeof sub === "object") {
          validateValue(obj[key], sub as Record<string, unknown>, path ? `${path}.${key}` : key, errors);
        }
      }
    }
  }

  // Array: validate each item against `items` (single schema only).
  if (typeOf(value) === "array" && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    (value as unknown[]).forEach((item, i) => {
      validateValue(item, schema.items as Record<string, unknown>, `${path}[${i}]`, errors);
    });
  }
}

/**
 * Validate `args` against `inputSchema`. Returns `{ ok: true }` when the schema
 * is empty/unconstrained or the args satisfy it.
 */
export function validateArgs(inputSchema: unknown, args: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  if (inputSchema && typeof inputSchema === "object") {
    validateValue(args ?? {}, inputSchema as Record<string, unknown>, "", errors);
  }
  return { ok: errors.length === 0, errors };
}
