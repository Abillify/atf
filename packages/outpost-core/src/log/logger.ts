// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structured JSON logging on stdout (requirements 4.6, 11.2) with the
 * redaction from `redact.ts` applied on two levels: pino removes values under
 * known secret key paths, and the {@link SecretRedactor} removes registered
 * secret values from the serialized line regardless of key name.
 */

import pino, { type Logger } from "pino";
import { REDACT_PATHS, REDACTION_MARKER, SecretRedactor } from "./redact.js";

export interface OutpostLogger {
  readonly logger: Logger;
  readonly redactor: SecretRedactor;
}

/**
 * Create the outpost logger.
 *
 * @param level - pino level, default `info`.
 * @param destination - writable stream, defaults to `process.stdout`. Tests
 *   pass an in-memory stream.
 * @param redactor - optional shared redactor so callers can register secrets
 *   loaded elsewhere; one is created when omitted.
 */
export function createLogger(
  level: string = "info",
  destination?: NodeJS.WritableStream,
  redactor: SecretRedactor = new SecretRedactor(),
): OutpostLogger {
  const target: NodeJS.WritableStream = destination ?? process.stdout;
  const base = pino(
    {
      level,
      redact: { paths: [...REDACT_PATHS], censor: REDACTION_MARKER },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // The custom destination applies value-based redaction to every line
    // after pino's path-based redaction has run — including stdout, so a
    // registered secret can never escape regardless of its key name.
    {
      write: (chunk: string) => {
        target.write(redactor.redact(chunk));
      },
    },
  );
  return { logger: base, redactor };
}

/** Register every value of a resolved secret list with the redactor. */
export function registerSecrets(redactor: SecretRedactor, values: Iterable<string>): void {
  for (const value of values) redactor.register(value);
}
