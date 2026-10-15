// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structured Logger (`src/observability/logger.ts`)
 *
 * Minimal dependency-free structured JSON logger with level filtering and
 * optional per-request correlation IDs. Writes one JSON object per line to
 * stdout (info/debug) or stderr (warn/error) for easy ingestion by log
 * aggregators (Loki, CloudWatch, ELK, etc.).
 *
 * No `any` at module boundaries.
 */

import { redactLogFields, redactLogString } from "@atf/security-kit";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a child logger that includes the given fields on every entry. */
  child(fields: LogFields): Logger;
}

class JsonLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel,
    private readonly baseFields: LogFields = {},
  ) {}

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    // Structural redaction on every entry (credential-named fields, JWT /
    // Bearer / API-key values in any string) — see @atf/security-kit log-redact.
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: redactLogString(message),
      ...redactLogFields({ ...this.baseFields, ...(fields ?? {}) }),
    };

    const line = `${JSON.stringify(entry)}\n`;
    if (level === "warn" || level === "error") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(this.minLevel, { ...this.baseFields, ...fields });
  }
}

/**
 * Creates a root logger with the given minimum level.
 */
export function createLogger(minLevel: LogLevel = "info"): Logger {
  return new JsonLogger(minLevel);
}
