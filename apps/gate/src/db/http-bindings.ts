// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { resolveContextPath, type AuthContext } from "../auth/context.ts";

/**
 * String-interpolation of :param.* / :ctx.* tokens for HTTP tools.
 *
 * Unlike the SQL bind-compiler (which replaces tokens with positional `?`
 * placeholders), HTTP tools need the resolved values inline — URL-encoded for
 * URL segments, raw strings for headers, and type-preserving for JSON bodies.
 *
 * The same namespace/path rules apply: :param.<path> resolves against the
 * MCP call arguments; :ctx.<path> resolves against the auth context.
 */

const TOKEN_RE = /:((param|ctx)\.[A-Za-z0-9_.[\]-]+)/g;

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current !== null && current !== undefined && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveToken(
  token: string,
  params: Record<string, unknown>,
  ctx: AuthContext,
): unknown {
  const dot = token.indexOf(".");
  const ns = token.slice(0, dot);
  const path = token.slice(dot + 1);
  return ns === "param" ? getPath(params, path) : resolveContextPath(ctx, path);
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Replace :param.* / :ctx.* tokens in a URL template.
 * Each resolved value is percent-encoded so it is safe inside a URL path or
 * query string segment (e.g. :param.id → "hello%20world").
 */
export function interpolateUrl(
  template: string,
  params: Record<string, unknown>,
  ctx: AuthContext,
): string {
  return template.replace(TOKEN_RE, (_, token) => {
    const value = resolveToken(token, params, ctx);
    if (value === undefined || value === null) return "";
    return encodeURIComponent(stringify(value));
  });
}

/**
 * Replace :param.* / :ctx.* tokens in a string without any encoding.
 * Used for header values where the raw resolved string is appropriate.
 */
export function interpolateRaw(
  template: string,
  params: Record<string, unknown>,
  ctx: AuthContext,
): string {
  return template.replace(TOKEN_RE, (_, token) => {
    const value = resolveToken(token, params, ctx);
    return stringify(value);
  });
}

/**
 * Recursively replace :param.* / :ctx.* tokens in a JSON-serialisable value.
 *
 * - If a string's entire content is a single token (e.g. ":param.userId"),
 *   the resolved value is returned as-is (preserving its original type).
 * - Strings containing a token among other text are string-interpolated.
 * - Arrays and objects are traversed recursively.
 * - Primitives other than strings pass through unchanged.
 */
export function interpolateBody(
  value: unknown,
  params: Record<string, unknown>,
  ctx: AuthContext,
): unknown {
  if (typeof value === "string") {
    // Whole-string token: preserve the original type (number, boolean, etc.)
    const full = value.match(/^:((param|ctx)\.[A-Za-z0-9_.[\]-]+)$/);
    if (full) {
      const resolved = resolveToken(full[1]!, params, ctx);
      return resolved ?? null;
    }
    return interpolateRaw(value, params, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateBody(v, params, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateBody(v, params, ctx);
    }
    return out;
  }
  return value;
}
