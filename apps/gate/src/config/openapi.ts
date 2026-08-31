// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { OpenApiImport } from "./schema.ts";
import { parse as parseYaml } from "yaml";

/**
 * Expand OpenAPI 3.x imports into `http` tool definitions (raw objects, before
 * Zod validation). Each operation becomes one tool: path parameters are
 * substituted into the URL as `:param.<name>`, query/header parameters and the
 * JSON request body are surfaced in the tool's `inputSchema`.
 *
 * The raw spec text is supplied by `specTextFor` so the (sync) file-based loader
 * and the (async) URL-fetching loader can share the same expansion logic. Specs
 * may be JSON or YAML; the format is auto-detected.
 *
 * Generated tools are a starting point — operators can refine names, headers
 * and pipelines afterwards.
 */
export function expandOpenApiImports(
  imports: OpenApiImport[],
  specTextFor: (imp: OpenApiImport) => string,
): unknown[] {
  const tools: unknown[] = [];
  for (const imp of imports) {
    tools.push(...expandOne(imp, specTextFor(imp)));
  }
  return tools;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head"] as const;
type Method = (typeof HTTP_METHODS)[number];

interface OpenApiDoc {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
}

function expandOne(imp: OpenApiImport, specText: string): unknown[] {
  const doc = parseSpecText(specText, imp.spec);

  const baseUrl = (imp.baseUrl ?? doc.servers?.[0]?.url ?? "").replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error(`openapi import '${imp.spec}': no baseUrl and the spec declares no servers[].url`);
  }

  const include = imp.include ? new Set(imp.include) : undefined;
  const exclude = imp.exclude ? new Set(imp.exclude) : undefined;

  const tools: unknown[] = [];
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const sharedParams = asArray(deref(doc, pathItem.parameters));
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const operation = op as Record<string, unknown>;

      const operationId =
        typeof operation.operationId === "string" && operation.operationId
          ? operation.operationId
          : defaultOperationId(method, path);

      if (include && !include.has(operationId)) continue;
      if (exclude && exclude.has(operationId)) continue;

      tools.push(
        buildTool(doc, imp, baseUrl, method, path, operation, operationId, sharedParams),
      );
    }
  }
  return tools;
}

function buildTool(
  doc: OpenApiDoc,
  imp: OpenApiImport,
  baseUrl: string,
  method: Method,
  path: string,
  operation: Record<string, unknown>,
  operationId: string,
  sharedParams: unknown[],
): unknown {
  const params = [...sharedParams, ...asArray(deref(doc, operation.parameters))]
    .map((p) => deref(doc, p) as Record<string, unknown>)
    .filter((p) => p && typeof p === "object");

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const headers: Record<string, string> = { ...imp.headers };

  // Path parameters → URL token; always required.
  let url = baseUrl + path.replace(/\{([^}]+)\}/g, (_m, name: string) => `:param.${name}`);

  const queryTokens: string[] = [];
  for (const p of params) {
    const name = String(p.name ?? "");
    if (!name) continue;
    const where = String(p.in ?? "");
    const schema = (deref(doc, p.schema) as Record<string, unknown>) ?? { type: "string" };
    if (where === "path" || where === "query") {
      properties[name] = withDescription(schema, p.description);
      if (where === "path" || p.required === true) required.push(name);
      if (where === "query") queryTokens.push(`${encodeURIComponent(name)}=:param.${name}`);
    } else if (where === "header") {
      headers[name] = `:param.${name}`;
      properties[name] = withDescription(schema, p.description);
      if (p.required === true) required.push(name);
    }
  }
  if (queryTokens.length > 0) {
    url += (url.includes("?") ? "&" : "?") + queryTokens.join("&");
  }

  // JSON request body → `:param.body`.
  const request: Record<string, unknown> = {
    method: method.toUpperCase(),
    url,
    headers,
    timeoutMs: imp.timeoutMs,
  };
  const requestBody = deref(doc, operation.requestBody) as Record<string, unknown> | undefined;
  const jsonSchema = requestBody
    ? ((deref(doc, (requestBody.content as Record<string, unknown>)?.["application/json"]) as
        | Record<string, unknown>
        | undefined)?.schema)
    : undefined;
  if (jsonSchema) {
    request.body = ":param.body";
    properties.body = deref(doc, jsonSchema);
    if (requestBody?.required === true) required.push("body");
  }

  const access =
    imp.access ?? (method === "get" || method === "head" || method === "options" ? "read" : "write");

  const description =
    (typeof operation.summary === "string" && operation.summary) ||
    (typeof operation.description === "string" && operation.description) ||
    `${method.toUpperCase()} ${path}`;

  return {
    name: imp.prefix + sanitizeName(operationId),
    description,
    type: "http",
    access,
    ...(imp.expose !== undefined ? { expose: imp.expose } : {}),
    request,
    inputSchema: { type: "object", properties, required },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseSpecText(text: string, source: string): OpenApiDoc {
  let parsed: unknown;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = parseYaml(text);
    }
  } else {
    parsed = parseYaml(text);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`openapi spec is not a valid document: ${source}`);
  }
  return parsed as OpenApiDoc;
}

/** Resolve a single local `$ref` (`#/components/...`) one level deep. */
function deref(doc: OpenApiDoc, node: unknown): unknown {
  if (node && typeof node === "object" && typeof (node as { $ref?: unknown }).$ref === "string") {
    const ref = (node as { $ref: string }).$ref;
    if (ref.startsWith("#/")) {
      const segments = ref.slice(2).split("/");
      let current: unknown = doc;
      for (const seg of segments) {
        const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
        if (current && typeof current === "object") {
          current = (current as Record<string, unknown>)[key];
        } else {
          return node;
        }
      }
      return current ?? node;
    }
  }
  return node;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function withDescription(schema: Record<string, unknown>, description: unknown): Record<string, unknown> {
  if (typeof description === "string" && description && schema.description === undefined) {
    return { ...schema, description };
  }
  return schema;
}

function defaultOperationId(method: Method, path: string): string {
  return `${method}_${path}`;
}

function sanitizeName(id: string): string {
  return id
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
