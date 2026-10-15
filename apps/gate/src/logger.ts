// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Minimal structured logger for mcpgate.
 *
 * Level is controlled by MCPGATE_LOG_LEVEL (error | warn | info | debug).
 * Default: "info".  Set to "debug" to get per-request SQL, payload sizes
 * and transport round-trip timings.
 *
 * Set MCPGATE_LOG_JSON=1 for newline-delimited JSON (ideal for log shippers).
 * All output goes to stderr so stdout stays clean for any pipe consumers.
 */

import { hashIdentifier, redactLogFields, redactLogString } from "@atf/security-kit";
import { DEFAULT_REDACT_OPTIONS, redact } from "./observability/redact.ts";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel(): number {
  const raw = (process.env.MCPGATE_LOG_LEVEL ?? "info").trim().toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

let currentLevel = resolveLevel();
const useJson = process.env.MCPGATE_LOG_JSON === "1";

export function setLogLevel(level: LogLevel): void {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}

export function isDebugEnabled(): boolean {
  return currentLevel >= LEVELS.debug;
}

/** True when log lines are newline-delimited JSON (MCPGATE_LOG_JSON=1) rather than plain text. */
export function isJsonEnabled(): boolean {
  return useJson;
}

/**
 * Short digest for logging that a value (query bindings, a system prompt)
 * changed or repeated without writing the value itself.
 */
export function digestForLog(value: string): string {
  return hashIdentifier(value) ?? "-";
}

function ts(): string {
  return new Date().toISOString();
}

/**
 * Structural redaction of every log context.
 *
 * Applied unconditionally rather than at each call site: log statements are
 * added constantly and by many hands, so relying on each author to remember
 * which field is sensitive is the failure mode this closes. Set
 * MCPGATE_LOG_REDACT=0 to disable (for local debugging only).
 *
 * Two layers: the gate's own key denylist (tool-argument style names such as
 * `iban` or `tax_id`), then the shared security-kit redaction, which also
 * scrubs JWT, Bearer and API-key shaped values inside any string. The `msg`
 * text goes through the shared string scrub too, because several call sites
 * interpolate event messages into it.
 */
const redactEnabled = process.env.MCPGATE_LOG_REDACT !== "0";

function safeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (context === undefined) return undefined;
  if (!redactEnabled) return context;
  return redactLogFields(redact(context, DEFAULT_REDACT_OPTIONS) as Record<string, unknown>);
}

function safeMessage(msg: string): string {
  return redactEnabled ? redactLogString(msg) : msg;
}

function emit(level: string, rawMsg: string, context?: Record<string, unknown>): void {
  const msg = safeMessage(rawMsg);
  const safe = safeContext(context);
  if (useJson) {
    const line = JSON.stringify({ ts: ts(), level, msg, ...safe });
    process.stderr.write(line + "\n");
  } else {
    const pad = level === "error" ? "ERROR" : level === "warn" ? "WARN " : level === "info" ? "INFO " : "DEBUG";
    const ctx = safe && Object.keys(safe).length > 0 ? " " + JSON.stringify(safe) : "";
    process.stderr.write(`${ts()} [mcpgate] ${pad} ${msg}${ctx}\n`);
  }
}

export const logger = {
  error(msg: string, context?: Record<string, unknown>): void {
    if (currentLevel >= 0) emit("error", msg, context);
  },
  warn(msg: string, context?: Record<string, unknown>): void {
    if (currentLevel >= 1) emit("warn", msg, context);
  },
  info(msg: string, context?: Record<string, unknown>): void {
    if (currentLevel >= 2) emit("info", msg, context);
  },
  debug(msg: string, context?: Record<string, unknown>): void {
    if (currentLevel >= 3) emit("debug", msg, context);
  },
};
