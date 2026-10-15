// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structural redaction for log entries.
 *
 * Applied by every service logger to every entry rather than at call sites:
 * log statements are added constantly and by many hands, and relying on each
 * author to remember which field is sensitive is the failure mode this closes.
 *
 * Two layers:
 *   - **Keys.** A field whose canonical name (lower-case, alphanumerics only)
 *     contains a credential fragment (`password`, `secret`, `apikey`,
 *     `accesstoken`, …) or equals a short credential name (`token`, `jwt`, …)
 *     is replaced. The list is deliberately narrower than "contains token": log
 *     entries are full of `prompt_tokens`/`max_tokens` counters that must stay.
 *   - **Values.** Any string — including free-text messages and error text —
 *     has JWT-shaped values, `Bearer …` credentials and `aip-…` API keys
 *     replaced, and is truncated to a bounded length.
 *
 * This reduces incidental exposure; it is not a PII policy. A field whose
 * innocuous name holds personal data still has to be kept out of logs at the
 * call site (see docs/operations-and-retrieval.md, "Data minimisation").
 */

import { createHash } from "node:crypto";

export const LOG_REDACTED = "[redacted]";

/** Canonical substrings that mark a field as a credential. */
const SENSITIVE_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "ssotoken",
  "usertoken",
  "authtoken",
  "sessiontoken",
  "iban",
  "creditcard",
  "cardnumber",
  "cvv",
  "pincode",
];

/** Canonical names that are credentials only when they are the whole key. */
const SENSITIVE_EXACT = new Set(["token", "jwt", "otp", "ssn", "pin", "bearer"]);

const MAX_STRING = 4096;
const MAX_DEPTH = 8;
const MAX_ARRAY = 200;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY_RE = /\baip-[A-Za-z0-9_-]{16,}\b/g;

function canonical(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a field of this name must never be logged verbatim. */
export function isSensitiveLogKey(key: string): boolean {
  const k = canonical(key);
  return SENSITIVE_EXACT.has(k) || SENSITIVE_FRAGMENTS.some((f) => k.includes(f));
}

/**
 * Stable, non-reversible log handle for a personal identifier (an email, a
 * user name): the first 12 hex characters of its SHA-256, computed over the
 * trimmed, lower-cased value so the same address always yields the same handle.
 * Lets operators correlate log lines without the clear value. Returns
 * `undefined` for a missing or blank input so it can be spread into a log
 * entry as-is. The handle is a pseudonym, not anonymous data: keep the clear
 * value out of the log entry as well.
 *
 * `email` is deliberately not a sensitive log key (it would blank audit-relevant
 * operator logs everywhere); call sites that log one hash it with this helper.
 */
export function hashIdentifier(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** Replaces credential-shaped substrings and bounds the length. */
export function redactLogString(value: string): string {
  const scrubbed = value
    .replace(JWT_RE, LOG_REDACTED)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${LOG_REDACTED}`)
    .replace(API_KEY_RE, LOG_REDACTED);
  return scrubbed.length > MAX_STRING
    ? `${scrubbed.slice(0, MAX_STRING)}…[+${scrubbed.length - MAX_STRING} chars]`
    : scrubbed;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth limit]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogString(value.message),
      ...(value.stack !== undefined ? { stack: redactLogString(value.stack) } : {}),
    };
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((v) => walk(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) kept.push(`…[+${value.length - MAX_ARRAY} more]`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSensitiveLogKey(key) && v !== undefined && v !== null ? LOG_REDACTED : walk(v, depth + 1, seen);
  }
  return out;
}

/** Redacts a log entry's structured fields (never mutates the input). */
export function redactLogFields<T extends Record<string, unknown>>(fields: T): T {
  return walk(fields, 0, new WeakSet()) as T;
}

/**
 * pino options that apply the same redaction to every entry of a pino logger
 * and its children (pino-http's `req.log` included): structured fields via
 * `formatters.log`, root bindings via `formatters.bindings`, message strings
 * via `hooks.logMethod`. Wrap the logger with {@link withMaskedChildBindings}
 * as well: pino serialises `.child({...})` bindings without any formatter. Spread into the
 * pino options: `pino({ level, ...pinoLogRedaction() })`.
 */
export function pinoLogRedaction(): {
  formatters: {
    log: (object: Record<string, unknown>) => Record<string, unknown>;
    bindings: (bindings: Record<string, unknown>) => Record<string, unknown>;
  };
  hooks: {
    logMethod: (
      this: unknown,
      args: unknown[],
      method: (...args: unknown[]) => void,
    ) => void;
  };
} {
  return {
    formatters: {
      log: (object) => redactLogFields(object),
      // Root bindings only: pino resets this formatter for children, so child
      // bindings are covered by {@link withMaskedChildBindings}.
      bindings: (bindings) => redactLogFields(bindings),
    },
    hooks: {
      logMethod(args, method) {
        method.apply(
          this,
          args.map((arg) => (typeof arg === "string" ? redactLogString(arg) : arg)),
        );
      },
    },
  };
}

/**
 * Redacts the bindings of every `.child()` created from `logger` or any of its
 * descendants (pino children inherit from their parent's prototype chain, so
 * the wrapped method is found on all of them). Returns the same logger.
 */
export function withMaskedChildBindings<
  L extends { child: (bindings: Record<string, unknown>, ...rest: never[]) => unknown },
>(logger: L): L {
  const child = logger.child;
  logger.child = function (this: L, bindings: Record<string, unknown>, ...rest: never[]) {
    return child.call(this, redactLogFields(bindings), ...rest);
  } as L["child"];
  return logger;
}
