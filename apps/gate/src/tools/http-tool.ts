// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { HttpTool } from "../config/schema.ts";
import { interpolateUrl, interpolateRaw, interpolateBody } from "../db/http-bindings.ts";
import { checkOutboundHost, secureOutboundFetch, validateOutboundUrl } from "./outbound.ts";
import { logger } from "../logger.ts";
import { withSpan } from "../observability/tracing.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

/**
 * Header names whose values are credentials. Matched case-insensitively and as
 * a substring, so `X-Api-Key`, `X-Auth-Token`, `Proxy-Authorization` and
 * custom `X-Service-Secret` style names are all covered.
 */
const SENSITIVE_HEADER_NAME =
  /authori[sz]ation|cookie|token|secret|password|passwd|api[-_]?key|credential|signature/i;

/**
 * Backend HTTP tool.
 *
 * Issues an HTTP request defined in config, substituting `:param.*` / `:ctx.*`
 * tokens into the URL (percent-encoded), headers (raw) and body (type-aware),
 * then runs the parsed response through an optional post-processing `pipeline`.
 */
export class HttpToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly allowedHosts: string[];
  private readonly outboundFetch?: typeof fetch;

  constructor(
    private readonly cfg: HttpTool,
    runtime: ToolRuntime,
  ) {
    this.allowedHosts = runtime.outboundAllowedHosts ?? [];
    this.outboundFetch = runtime.outboundFetch;
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };
  }

  async execute(args: Record<string, unknown>, ctx: AuthContext, signal?: AbortSignal): Promise<ToolResult> {
    const req = this.cfg.request;
    const params = args ?? {};

    const url = interpolateUrl(req.url, params, ctx);

    const blocked = await validateOutboundUrl(url, this.allowedHosts);
    if (blocked) {
      logger.warn("http tool blocked by outbound policy", { tool: this.cfg.name, reason: blocked });
      return {
        content: [{ type: "text", text: `HTTP request refused: ${blocked}` }],
        isError: true,
        meta: { url, blocked: true },
      };
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      headers[k] = interpolateRaw(v, params, ctx);
    }

    let body: string | undefined;
    const method = req.method;
    if (req.body !== undefined && method !== "GET" && method !== "DELETE") {
      const resolved = interpolateBody(req.body, params, ctx);
      body = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
      // Default to JSON unless the author already set a content type.
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${req.timeoutMs}ms`)), req.timeoutMs);
    timer.unref?.();
    const started = Date.now();

    try {
      logger.debug("http request", { tool: this.cfg.name, method, url });
      const res = await withSpan(
        `http.request ${this.cfg.name}`,
        { "mcpgate.tool": this.cfg.name, "http.method": method, "http.url": url },
        () => safeFetch(url, { method, headers, body, signal: controller.signal }, this.allowedHosts, this.outboundFetch),
      );

      const rawText = await readBodyCapped(res, this.cfg.maxResponseBytes);
      const contentType = res.headers.get("content-type") ?? "";
      let parsed: unknown = rawText;
      if (contentType.includes("application/json") || looksLikeJson(rawText)) {
        try { parsed = JSON.parse(rawText); } catch { /* keep raw text */ }
      }

      logger.debug("http response", {
        tool: this.cfg.name,
        status: res.status,
        ms: Date.now() - started,
        bytes: Buffer.byteLength(rawText, "utf8"),
      });

      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `HTTP ${res.status} ${res.statusText}`,
                body: typeof parsed === "string" ? parsed.slice(0, 2000) : parsed,
              }),
            },
          ],
          isError: true,
          meta: { status: res.status, url },
        };
      }

      const piped = runPipeline(parsed, this.cfg.pipeline ?? []);
      const text = typeof piped === "string" ? piped : JSON.stringify(piped);
      const structuredContent = toStructuredContent(piped);

      return {
        content: [{ type: "text", text }],
        ...(structuredContent !== undefined ? { structuredContent } : {}),
        meta: { status: res.status, url, contentType },
      };
    } catch (err) {
      const message =
        (err as Error).name === "AbortError"
          ? `HTTP request timed out after ${req.timeoutMs}ms`
          : (err as Error).message;
      logger.debug("http error", { tool: this.cfg.name, error: message });
      return {
        content: [{ type: "text", text: `HTTP request failed: ${message}` }],
        isError: true,
        meta: { url },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** Dry-run: build the request (URL, headers, body) without sending it. */
  async explain(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> {
    const req = this.cfg.request;
    const params = args ?? {};
    const url = interpolateUrl(req.url, params, ctx);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      // A dry-run shows the SHAPE of the request. Credential-bearing headers
      // (static API keys, env-substituted tokens) are never echoed back to
      // whoever is allowed to dry-run the tool.
      headers[k] = SENSITIVE_HEADER_NAME.test(k)
        ? "[redacted]"
        : interpolateRaw(v, params, ctx);
    }

    let body: unknown;
    const method = req.method;
    if (req.body !== undefined && method !== "GET" && method !== "DELETE") {
      body = interpolateBody(req.body, params, ctx);
    }

    const blocked = checkOutboundHost(url, this.allowedHosts);
    const text = JSON.stringify(
      { method, url, headers, body, ...(blocked ? { blocked } : {}) },
      null,
      2,
    );
    return { content: [{ type: "text", text }], meta: { dryRun: true, url, method } };
  }
}

// ---------------------------------------------------------------------------
// SSRF-safe fetch with explicit redirect handling
// ---------------------------------------------------------------------------

async function safeFetch(
  initialUrl: string,
  request: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
  allowedHosts: string[],
  testFetch?: typeof fetch,
): Promise<Response> {
  let url = initialUrl;
  let method = request.method;
  let body = request.body;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const blocked = await validateOutboundUrl(url, allowedHosts);
    if (blocked) throw new Error(blocked);
    const response = testFetch
      ? await testFetch(url, {
          method,
          headers: request.headers,
          ...(body !== undefined ? { body } : {}),
          signal: request.signal,
          redirect: "manual",
        })
      : await secureOutboundFetch(url, {
          method,
          headers: request.headers,
          ...(body !== undefined ? { body } : {}),
          signal: request.signal,
          redirect: "manual",
        }, allowedHosts, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === 5) throw new Error("too many outbound redirects");
    const location = response.headers.get("location");
    if (!location) return response;
    url = new URL(location, url).toString();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("too many outbound redirects");
}

// ---------------------------------------------------------------------------
// Response pipeline
// ---------------------------------------------------------------------------

/**
 * Apply post-processing steps to the parsed response body. Supported steps:
 *   { type: "jsonPath", expression: "$.data.items" }
 *   { type: "field",    path: "data.items" }
 * Both use simple dot-notation traversal (with [n] index support). Unknown step
 * types are ignored so a config can declare future steps without breaking.
 */
function runPipeline(value: unknown, pipeline: Array<Record<string, unknown>>): unknown {
  let current = value;
  for (const step of pipeline) {
    const type = String(step.type ?? "");
    if (type === "jsonPath") {
      const expr = String(step.expression ?? "").replace(/^\$\.?/, "");
      current = pickPath(current, expr);
    } else if (type === "field") {
      current = pickPath(current, String(step.path ?? ""));
    }
    // Unknown steps: no-op.
  }
  return current;
}

/** Traverse a dotted path with optional [index] segments, e.g. "data.items[0].id". */
function pickPath(value: unknown, path: string): unknown {
  if (!path) return value;
  const parts = path.split(".").flatMap((seg) => {
    const out: Array<string | number> = [];
    const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return [seg];
    if (m[1]) out.push(m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
    return out;
  });
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * Wrap an object/array result as MCP `structuredContent` (which must be a
 * JSON object). A bare array is wrapped under `items` so it still satisfies
 * the object-shaped `structuredContent` contract; primitives/strings have no
 * natural structured form and are omitted (the `content` text is authoritative).
 */
function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}

/**
 * Read a fetch Response body while enforcing a byte cap, aborting the read
 * (and closing the underlying connection) as soon as the cap is exceeded
 * instead of buffering an unbounded response into memory.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`response body exceeded maxResponseBytes (${maxBytes})`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.cancel?.().catch(() => { /* best-effort */ });
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
