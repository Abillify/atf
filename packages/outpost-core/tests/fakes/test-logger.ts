// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Silent pino logger for tests, plus an in-memory JSON line collector for
 * assertions on log events.
 */

import pino, { type Logger } from "pino";

export function testLogger(): Logger {
  return pino({ level: "silent" });
}

/** Logger that records serialized lines so tests can assert on events. */
export function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  );
  return { logger, lines };
}

/** Parse recorded lines into objects (invalid lines are skipped). */
export function parseLines(lines: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ignore non-JSON chunks
    }
  }
  return out;
}
