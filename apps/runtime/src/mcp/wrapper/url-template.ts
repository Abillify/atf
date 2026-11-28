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
 *
 * The resolved endpoint is caller-supplied data and receives the caller's
 * bearer (`forwardAuthToken`), so it must also match one of the server's
 * `urlTemplateAllowedOrigins`. Without that list any authenticated caller
 * could name an arbitrary public host and have the Runtime send it the
 * caller's token and load that host's tool descriptions into the prompt.
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
  config: {
    name: string;
    url?: string;
    urlTemplate?: string;
    urlTemplateAllowedOrigins?: readonly string[];
  },
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
  const allowed = config.urlTemplateAllowedOrigins ?? [];
  if (allowed.length === 0) {
    throw new Error(
      `MCP server "${config.name}" urlTemplate has no urlTemplateAllowedOrigins; ` +
        "refusing to call a request-supplied endpoint without an origin allowlist",
    );
  }
  if (!allowed.some((pattern) => originMatches(pattern, parsed))) {
    throw new Error(
      `MCP server "${config.name}" urlTemplate resolved to origin "${parsed.origin}", ` +
        "which is not listed in urlTemplateAllowedOrigins",
    );
  }
  // Return the parsed-and-serialised URL so session identity is stable across
  // cosmetic variants (case, default port, trailing slash of an empty path).
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

/** Parsed form of one `urlTemplateAllowedOrigins` entry. */
export interface OriginPattern {
  protocol: "http:" | "https:";
  /** Exact hostname, or the suffix after `*.` for a wildcard pattern. */
  host: string;
  /** True for `*.example.com`: one or more labels before `host`, never `host` itself. */
  wildcard: boolean;
  /** Port as `URL.port` reports it ("" for the scheme's default port). */
  port: string;
}

const WILDCARD_PLACEHOLDER = "atf-origin-wildcard";

/**
 * Parses an origin pattern: `scheme://host[:port]` or `scheme://*.host[:port]`.
 * No path, query, fragment or credentials. Returns an error string for an
 * invalid pattern so the config schema can report it at load time.
 */
export function parseOriginPattern(raw: string): OriginPattern | string {
  const value = raw.trim();
  const match = /^(https?):\/\/(\*\.)?([^/?#]+)$/iu.exec(value.replace(/\/$/u, ""));
  if (match === null) {
    return `"${raw}" is not an origin pattern (expected scheme://host[:port] or scheme://*.host[:port], no path)`;
  }
  const wildcard = match[2] !== undefined;
  let parsed: URL;
  try {
    parsed = new URL(
      `${match[1]}://${wildcard ? `${WILDCARD_PLACEHOLDER}.` : ""}${match[3]}`,
    );
  } catch {
    return `"${raw}" is not a valid origin`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return `"${raw}" must not contain credentials`;
  }
  let host = parsed.hostname.toLowerCase();
  if (wildcard) {
    host = host.slice(WILDCARD_PLACEHOLDER.length + 1);
    // `*.com` would allow every host of a public suffix; require at least two labels.
    if (!host.includes(".")) {
      return `"${raw}" wildcard must be followed by at least two labels (e.g. *.example.com)`;
    }
  }
  if (host.includes("*")) {
    return `"${raw}" may contain "*" only as the leading label`;
  }
  return {
    protocol: parsed.protocol as "http:" | "https:",
    host,
    wildcard,
    port: parsed.port,
  };
}

/** True when `url`'s origin is covered by `pattern` (scheme, host, port). */
export function originMatches(pattern: string, url: URL): boolean {
  const parsed = parseOriginPattern(pattern);
  if (typeof parsed === "string") return false;
  if (url.protocol !== parsed.protocol) return false;
  if (url.port !== parsed.port) return false;
  const host = url.hostname.toLowerCase();
  return parsed.wildcard
    ? host.endsWith(`.${parsed.host}`) && host.length > parsed.host.length + 1
    : host === parsed.host;
}
