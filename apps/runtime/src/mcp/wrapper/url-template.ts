// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Request-time resolution of MCP server `urlTemplate` configs.
 *
 * A `urlTemplate` is exactly one `{{requestParams.<dot.path>}}` placeholder
 * embedded in literal text (validated at config load), e.g.
 * `{{requestParams.deployment.url}}/mcp`. At request time the placeholder is
 * substituted from the execution context's `requestParams` (the `metadata`
 * object of the incoming request body), and the result must be a plain
 * absolute `http(s)` URL without embedded credentials.
 *
 * Fail-closed contract: a missing, non-string, empty, or non-URL value throws
 * — the request is rejected rather than falling back to a default endpoint,
 * because the template author has no way to know which peer was intended.
 */

const TEMPLATE_TOKEN = /\{\{\s*requestParams\.([A-Za-z0-9_.]+)\s*\}\}/u;

/** True when the config's endpoint is resolved per request rather than statically. */
export function hasUrlTemplate(config: {
  url?: string;
  urlTemplate?: string;
}): boolean {
  return config.urlTemplate !== undefined;
}

/**
 * Extract the `requestParams.<dot.path>` path from a validated template.
 * Returns undefined for a static (non-templated) config.
 */
export function urlTemplatePath(config: {
  url?: string;
  urlTemplate?: string;
}): string | undefined {
  if (config.urlTemplate === undefined) return undefined;
  const match = TEMPLATE_TOKEN.exec(config.urlTemplate);
  return match?.[1];
}

/**
 * Read a dotted path out of `requestParams`. Returns undefined when any
 * segment is missing or an intermediate value is not an object.
 */
function readDotPath(
  requestParams: Record<string, unknown> | undefined,
  path: string,
): unknown {
  let current: unknown = requestParams;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolve a server config's endpoint for one request.
 *
 * - Static configs return `config.url` unchanged.
 * - Templated configs substitute the placeholder from `requestParams` and
 *   validate the result: non-empty string, absolute `http(s)` URL, no
 *   embedded credentials.
 *
 * @throws Error with a `urlTemplate`-mentioning message when resolution or
 * validation fails (fail closed — callers must not retry a different URL).
 */
export function resolveServerUrl(
  config: { name: string; url?: string; urlTemplate?: string },
  requestParams: Record<string, unknown> | undefined,
): string {
  if (config.urlTemplate === undefined) {
    if (config.url === undefined) {
      throw new Error(
        `MCP server "${config.name}" has neither url nor urlTemplate configured`,
      );
    }
    return config.url;
  }
  const path = urlTemplatePath(config);
  if (path === undefined) {
    throw new Error(
      `MCP server "${config.name}" urlTemplate "${config.urlTemplate}" contains no {{requestParams.<dot.path>}} placeholder`,
    );
  }
  const value = readDotPath(requestParams, path);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `MCP server "${config.name}" urlTemplate resolved requestParams.${path} to a missing or empty value; ` +
        `the request metadata must carry a string at "${path}"`,
    );
  }
  const resolved = config.urlTemplate.replace(TEMPLATE_TOKEN, () => value);
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(
      `MCP server "${config.name}" urlTemplate resolved to an invalid URL: "${resolved}"`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP server "${config.name}" urlTemplate resolved to unsupported scheme "${parsed.protocol}" (http/https only): "${resolved}"`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `MCP server "${config.name}" urlTemplate resolved to a URL with embedded credentials, which is not allowed`,
    );
  }
  // Return the parsed-and-serialised URL so session identity is stable across
  // cosmetic variants (case, default port, trailing slash of an empty path).
  return parsed.toString();
}
