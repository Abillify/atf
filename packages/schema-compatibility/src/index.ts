// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export type SchemaDirection = "input" | "output";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolSchemas {
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
}

export interface SchemaCompatibilityFinding {
  readonly direction: SchemaDirection;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface SchemaCompatibilityDiff {
  readonly breaking: SchemaCompatibilityFinding[];
  readonly nonBreaking: SchemaCompatibilityFinding[];
  readonly unknown: SchemaCompatibilityFinding[];
}

type Bucket = keyof SchemaCompatibilityDiff;
type MutableDiff = {
  [K in Bucket]: SchemaCompatibilityFinding[];
};

const UNSUPPORTED_KEYWORDS = [
  "$ref",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "patternProperties",
  "dependencies",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "prefixItems",
  "propertyNames",
] as const;

const MINIMUM_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"] as const;
const MAXIMUM_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"] as const;

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

function add(
  result: MutableDiff,
  bucket: Bucket,
  direction: SchemaDirection,
  path: string,
  code: string,
  message: string,
): void {
  result[bucket].push({ direction, path, code, message });
}

function objectAt(schema: JsonSchema, key: string): Readonly<Record<string, unknown>> | undefined {
  const value = schema[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringSet(value: unknown): ReadonlySet<string> | undefined {
  if (typeof value === "string") return new Set([value]);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return new Set(value);
  return undefined;
}

function primitiveSet(value: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(value) || !value.every((entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry))) return undefined;
  return new Set(value.map((entry) => stableValue(entry)));
}

function isSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].every((value) => right.has(value));
}

function classifyTightening(
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
  code: string,
  message: string,
  tightening: boolean,
): void {
  const breaking = direction === "input" ? tightening : !tightening;
  add(result, breaking ? "breaking" : "nonBreaking", direction, path, code, message);
}

function compareSetConstraint(
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string> | undefined,
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
  code: string,
): void {
  if ((!previous && !next) || (previous && next && isSubset(previous, next) && isSubset(next, previous))) return;
  const tightened = !!next && (!previous || isSubset(next, previous));
  const loosened = !!previous && (!next || isSubset(previous, next));
  if (!tightened && !loosened) {
    add(result, "unknown", direction, path, `${code}-changed`, `${code} changed incompatibly and cannot be ordered safely`);
    return;
  }
  classifyTightening(result, direction, path, tightened ? `${code}-narrowed` : `${code}-widened`, `${code} was ${tightened ? "narrowed" : "widened"}`, tightened);
}

function compareBound(
  keyword: string,
  previousValue: unknown,
  nextValue: unknown,
  minimum: boolean,
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
): void {
  if (sameValue(previousValue, nextValue)) return;
  if ((previousValue !== undefined && typeof previousValue !== "number") || (nextValue !== undefined && typeof nextValue !== "number")) {
    add(result, "unknown", direction, path, `${keyword}-changed`, `${keyword} changed but is not a numeric bound`);
    return;
  }
  const previousNumber = previousValue as number | undefined;
  const nextNumber = nextValue as number | undefined;
  const tightened = nextNumber !== undefined && (previousNumber === undefined || (minimum ? nextNumber > previousNumber : nextNumber < previousNumber));
  const loosened = previousNumber !== undefined && (nextNumber === undefined || (minimum ? nextNumber < previousNumber : nextNumber > previousNumber));
  if (!tightened && !loosened) return;
  classifyTightening(result, direction, path, `${keyword}-${tightened ? "narrowed" : "widened"}`, `${keyword} was ${tightened ? "narrowed" : "widened"}`, tightened);
}

function variants(schema: JsonSchema, keyword: "oneOf" | "anyOf"): readonly unknown[] | undefined {
  const value = schema[keyword];
  return Array.isArray(value) ? value : undefined;
}

function compareVariants(
  previousSchema: JsonSchema,
  nextSchema: JsonSchema,
  keyword: "oneOf" | "anyOf",
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
): void {
  const previous = variants(previousSchema, keyword);
  const next = variants(nextSchema, keyword);
  if (!previous && !next) return;
  if (!previous || !next) {
    add(result, "unknown", direction, path, `${keyword}-changed`, `${keyword} was added or removed and cannot be compared safely`);
    return;
  }
  const previousSet = new Set(previous.map(stableValue));
  const nextSet = new Set(next.map(stableValue));
  const removed = [...previousSet].filter((value) => !nextSet.has(value)).length;
  const added = [...nextSet].filter((value) => !previousSet.has(value)).length;
  if (removed > 0) classifyTightening(result, direction, path, `${keyword}-variant-removed`, `${removed} ${keyword} variant(s) removed`, true);
  if (added > 0) classifyTightening(result, direction, path, `${keyword}-variant-added`, `${added} ${keyword} variant(s) added`, false);
}

function requiredSet(schema: JsonSchema): ReadonlySet<string> | undefined {
  const value = schema.required;
  return value === undefined ? new Set() : stringSet(value);
}

function compareProperties(
  previousSchema: JsonSchema,
  nextSchema: JsonSchema,
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
): void {
  const previousProperties = objectAt(previousSchema, "properties") ?? {};
  const nextProperties = objectAt(nextSchema, "properties") ?? {};
  const previousRequired = requiredSet(previousSchema);
  const nextRequired = requiredSet(nextSchema);
  if (!previousRequired || !nextRequired) {
    add(result, "unknown", direction, path, "required-invalid", "required is not an array of property names");
    return;
  }

  const names = [...new Set([...Object.keys(previousProperties), ...Object.keys(nextProperties)])].sort();
  for (const name of names) {
    const propertyPath = `${path}.properties.${name}`;
    const previousProperty = previousProperties[name];
    const nextProperty = nextProperties[name];
    if (previousProperty === undefined && nextProperty !== undefined) {
      const required = nextRequired.has(name);
      if (direction === "input" && required) add(result, "breaking", direction, propertyPath, "required-property-added", `Required property ${name} was added`);
      else add(result, "nonBreaking", direction, propertyPath, "property-added", `Property ${name} was added`);
      continue;
    }
    if (previousProperty !== undefined && nextProperty === undefined) {
      add(result, "breaking", direction, propertyPath, "property-removed", `Property ${name} was removed`);
      continue;
    }
    if (!previousProperty || typeof previousProperty !== "object" || Array.isArray(previousProperty) || !nextProperty || typeof nextProperty !== "object" || Array.isArray(nextProperty)) {
      if (!sameValue(previousProperty, nextProperty)) add(result, "unknown", direction, propertyPath, "property-schema-invalid", `Property ${name} does not use comparable object schemas`);
      continue;
    }

    const wasRequired = previousRequired.has(name);
    const isRequired = nextRequired.has(name);
    if (wasRequired !== isRequired) {
      const tightening = !wasRequired && isRequired;
      classifyTightening(result, direction, propertyPath, tightening ? "property-made-required" : "property-made-optional", `Property ${name} was made ${tightening ? "required" : "optional"}`, tightening);
    }
    compareSchema(previousProperty as JsonSchema, nextProperty as JsonSchema, result, direction, propertyPath);
  }
}

function compareAdditionalProperties(
  previousSchema: JsonSchema,
  nextSchema: JsonSchema,
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
): void {
  const previous = previousSchema.additionalProperties;
  const next = nextSchema.additionalProperties;
  if (sameValue(previous, next)) return;
  if ((previous !== undefined && typeof previous !== "boolean") || (next !== undefined && typeof next !== "boolean")) {
    add(result, "unknown", direction, path, "additional-properties-schema", "Schema-valued additionalProperties cannot be compared safely");
    return;
  }
  const previousAllowed = previous !== false;
  const nextAllowed = next !== false;
  if (previousAllowed === nextAllowed) return;
  classifyTightening(result, direction, path, nextAllowed ? "additional-properties-enabled" : "additional-properties-disabled", `additionalProperties was ${nextAllowed ? "enabled" : "disabled"}`, !nextAllowed);
}

function compareSchema(
  previousSchema: JsonSchema,
  nextSchema: JsonSchema,
  result: MutableDiff,
  direction: SchemaDirection,
  path: string,
): void {
  let hasUnsupportedChange = false;
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (!sameValue(previousSchema[keyword], nextSchema[keyword])) {
      hasUnsupportedChange = true;
      add(result, "unknown", direction, path, "unsupported-keyword", `${keyword} changed and is not interpreted`);
    }
  }
  if (hasUnsupportedChange) return;

  const previousTypes = stringSet(previousSchema.type);
  const nextTypes = stringSet(nextSchema.type);
  if ((!previousTypes && previousSchema.type !== undefined) || (!nextTypes && nextSchema.type !== undefined)) {
    if (!sameValue(previousSchema.type, nextSchema.type)) add(result, "unknown", direction, path, "type-invalid", "type changed but is not a string or string array");
  } else {
    compareSetConstraint(previousTypes, nextTypes, result, direction, path, "type");
  }

  const previousEnum = primitiveSet(previousSchema.enum);
  const nextEnum = primitiveSet(nextSchema.enum);
  if ((!previousEnum && previousSchema.enum !== undefined) || (!nextEnum && nextSchema.enum !== undefined)) {
    if (!sameValue(previousSchema.enum, nextSchema.enum)) add(result, "unknown", direction, path, "enum-complex", "enum changed and contains non-primitive values");
  } else {
    compareSetConstraint(previousEnum, nextEnum, result, direction, path, "enum");
  }
  for (const keyword of MINIMUM_BOUNDS) compareBound(keyword, previousSchema[keyword], nextSchema[keyword], true, result, direction, path);
  for (const keyword of MAXIMUM_BOUNDS) compareBound(keyword, previousSchema[keyword], nextSchema[keyword], false, result, direction, path);

  for (const keyword of ["multipleOf", "pattern", "format", "const", "items"] as const) {
    if (!sameValue(previousSchema[keyword], nextSchema[keyword])) add(result, "unknown", direction, path, `${keyword}-changed`, `${keyword} changed and cannot be ordered safely`);
  }

  compareAdditionalProperties(previousSchema, nextSchema, result, direction, path);
  compareVariants(previousSchema, nextSchema, "oneOf", result, direction, path);
  compareVariants(previousSchema, nextSchema, "anyOf", result, direction, path);
  compareProperties(previousSchema, nextSchema, result, direction, path);
}

function compareOptionalOutput(previous: JsonSchema | undefined, next: JsonSchema | undefined, result: MutableDiff): void {
  if (!previous && !next) return;
  if (previous && !next) {
    add(result, "breaking", "output", "$", "output-schema-removed", "outputSchema was removed");
    return;
  }
  if (!previous && next) {
    add(result, "nonBreaking", "output", "$", "output-schema-added", "outputSchema was added");
    return;
  }
  compareSchema(previous as JsonSchema, next as JsonSchema, result, "output", "$");
}

/** Compares two tool schema contracts without mutating either input. */
export function diffToolSchemas(previous: ToolSchemas, next: ToolSchemas): SchemaCompatibilityDiff {
  const result: MutableDiff = { breaking: [], nonBreaking: [], unknown: [] };
  compareSchema(previous.inputSchema, next.inputSchema, result, "input", "$");
  compareOptionalOutput(previous.outputSchema, next.outputSchema, result);
  return result;
}
