// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Wrapper — Tool Forwarding & Parameter Injection
 *
 * Handles tool call proxying (including Protected Parameter stripping/injection),
 * retry logic, and injectedParams template resolution.
 *
 * Requirements: 7.4, 7.5, 7.6
 */

import type { RequestContext } from "../../types/monitoring.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Result returned by a tool call.
 */
export interface McpApprovalField {
  name: string;
  label: string;
  value: unknown;
}

export interface McpApprovalInputRequest {
  type: "approval";
  /** Opaque state supplied by the MCP server and returned unchanged on resolve. */
  requestState: string;
  title: string;
  message: string;
  fields?: McpApprovalField[];
  expiresAt?: string;
}

export interface McpApprovalResolution {
  decision: "approved" | "denied";
  approver?: string;
}

export interface ToolResult {
  content: unknown;
  isError?: boolean;
  /** Transport attempts used for this logical call; present when a retry occurred. */
  retry?: {
    attempts: number;
    failures: Array<{ attempt: number; message: string }>;
  };
  /** Additive MCP 2026 fields; legacy callers may ignore them. */
  resultType?: "complete" | "input_required" | "task";
  structuredContent?: unknown;
  task?: import("./stateless-2026-client.js").McpTaskHandle;
  inputRequests?: McpApprovalInputRequest[];
  /**
   * MCP-2026 continuation bound to the original canonical call, auth session,
   * transaction metadata and AbortSignal. Absent for 2025 and complete results.
   */
  resolveApproval?: (
    request: McpApprovalInputRequest,
    resolution: McpApprovalResolution,
  ) => Promise<ToolResult | undefined>;
}

// ---------------------------------------------------------------------------
// withRetry utility
// ---------------------------------------------------------------------------

/**
 * Retries an async function up to `maxAttempts` times.
 *
 * Each attempt is raced against a `timeoutMs` deadline. On failure the utility
 * waits `delayMs` before the next attempt. After all attempts are exhausted it
 * throws an Error whose message includes the server name and attempt count.
 *
 * Requirements: 7.6
 */
/** Opaque abort read — see the call site in `withRetry` for why it is a function. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function abortError(serverName: string, attempts: number): Error {
  return new Error(
    `MCP server ${serverName} call aborted (execution deadline) after ${attempts} attempt(s).`,
  );
}

/** Waits between attempts without leaving an abort listener behind. */
async function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
  serverName: string,
  attempts: number,
): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted === true) throw abortError(serverName, attempts);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(serverName, attempts));
    };
    function cleanup(): void {
      signal?.removeEventListener("abort", onAbort);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: {
    maxAttempts?: number;
    timeoutMs?: number;
    delayMs?: number;
    serverName?: string;
    /**
     * Runs after a failed attempt and before the retry delay. Used by transport
     * clients to replace a connection whose request timed out or disconnected.
     */
    onAttemptFailure?: (
      error: Error,
      attempt: number,
      signal?: AbortSignal,
    ) => Promise<void> | void;
    /**
     * Flow-level execution deadline. Retrying after it fires spends time (and a
     * provider's rate budget) on a run whose result nobody will read, so the
     * retry loop stops as soon as it is signalled.
     */
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 5000;
  const delayMs = options.delayMs ?? 1000;
  const serverName = options.serverName ?? "unknown";
  const signal = options.signal;

  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted === true) {
      throw abortError(serverName, attempt - 1);
    }
    const attemptController = new AbortController();
    let rejectAttempt: ((reason: Error) => void) | undefined;
    const onParentAbort = (): void => {
      attemptController.abort(signal?.reason);
      rejectAttempt?.(abortError(serverName, attempt));
    };
    signal?.addEventListener("abort", onParentAbort, { once: true });
    const attemptPromise = new Promise<T>((resolve, reject) => {
      rejectAttempt = reject;
      // Attach both handlers directly. If timeout/parent abort wins, a later
      // rejection from fn is still observed and cannot become unhandled.
      fn(attemptController.signal).then(resolve, reject);
    });
    const timer = setTimeout(() => {
      const timeoutError = new Error(
        `Attempt ${attempt} timed out after ${timeoutMs}ms`,
      );
      attemptController.abort(timeoutError);
      rejectAttempt?.(timeoutError);
    }, timeoutMs);
    try {
      return await attemptPromise;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isAborted(signal)) throw abortError(serverName, attempt);

      if (attempt < maxAttempts && !isAborted(signal)) {
        await options.onAttemptFailure?.(lastError, attempt, signal);
        await abortableDelay(delayMs, signal, serverName, attempt);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  throw new Error(
    `MCP server ${serverName} failed after ${maxAttempts} attempts: ${lastError.message}`,
  );
}

// ---------------------------------------------------------------------------
// Protected Parameter Stripping
// ---------------------------------------------------------------------------

/**
 * Strips protected (tenant-/identity-related) parameters from tool call arguments.
 * This is a security hardening measure: even if the LLM injects protected param
 * keys into args, they are removed before forwarding. Only system-injected values
 * (from RequestContext) should be used.
 *
 * Pure function — does not mutate the input args object.
 *
 * Requirements: 4.3
 */
export function stripProtectedParams(
  args: Record<string, unknown>,
  protectedParams: readonly string[],
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!protectedParams.includes(key)) {
      stripped[key] = value;
    }
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Protected Parameter Injection
// ---------------------------------------------------------------------------

/**
 * Injects Protected Parameters from a RequestContext into tool call arguments.
 * Mapping: ssoToken → user_token, userEmail → user_email, clientId → client_id
 * Pure function — does not mutate args.
 *
 * Requirements: 7.4, 7.5 (Property 19)
 */
export function injectProtectedParams(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Record<string, unknown> {
  const injected: Record<string, unknown> = { ...args };
  injected.user_token = ctx.ssoToken;
  if (ctx.userEmail !== undefined) {
    injected.user_email = ctx.userEmail;
  }
  if (ctx.clientId !== undefined) {
    injected.client_id = ctx.clientId;
  }
  return injected;
}

// ---------------------------------------------------------------------------
// Injected Params Template Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves `{{...}}` placeholders inside a server's `injectedParams` template
 * against the per-request {@link RequestContext} and the current clock, and
 * returns the concrete values to inject on a tool call. Pure function — does
 * not mutate the input template.
 *
 * Supported tokens:
 *   {{ctx.userId}} {{ctx.userName}} {{ctx.userEmail}} {{ctx.clientId}}
 *   {{ctx.role}}   {{ctx.language}} {{ctx.plan}}      {{ctx.executionId}}
 *   {{ctx.chatId}} {{ctx.sessionId}} {{ctx.messageId}}
 *   {{now.date}}   {{now.timestamp}} {{now.weekday}}
 *
 * Resolution rules:
 *   - A string that is exactly one placeholder (`"{{ctx.userId}}"`) is replaced
 *     by the resolved value, preserving `null` when the value is absent so the
 *     field keeps its shape rather than becoming an empty string.
 *   - A placeholder embedded in a larger string resolves to "" when absent.
 *   - Objects and arrays are walked recursively; other values pass through.
 */
export function resolveInjectedParams(
  template: Record<string, unknown>,
  ctx: RequestContext,
  now: Date = new Date(),
): Record<string, unknown> {
  const tokens: Record<string, string | undefined> = {
    "ctx.userId": ctx.userId,
    "ctx.userName": ctx.userName,
    "ctx.userEmail": ctx.userEmail,
    "ctx.clientId": ctx.clientId,
    "ctx.role": ctx.role,
    "ctx.language": ctx.language,
    "ctx.plan": ctx.plan,
    "ctx.executionId": ctx.executionId,
    "ctx.chatId": ctx.chatId,
    "ctx.sessionId": ctx.sessionId,
    "ctx.messageId": ctx.messageId,
    "now.date": formatLocalDate(now),
    "now.timestamp": formatLocalTimestamp(now),
    "now.weekday": WEEKDAYS_EN[now.getDay()],
  };

  const single = /^\{\{\s*([\w.]+)\s*\}\}$/;
  const embedded = /\{\{\s*([\w.]+)\s*\}\}/g;

  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const exact = single.exec(value);
      if (exact) {
        const v = tokens[exact[1] ?? ""];
        return v === undefined || v === "" ? null : v;
      }
      return value.replace(embedded, (_m, t: string) => tokens[t] ?? "");
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = resolve(v);
      }
      return out;
    }
    return value;
  };

  return resolve(template) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Date formatting helpers (internal)
// ---------------------------------------------------------------------------

const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local calendar date as `YYYY-MM-DD`. */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO-8601 timestamp with millisecond precision and the local UTC offset. */
function formatLocalTimestamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
