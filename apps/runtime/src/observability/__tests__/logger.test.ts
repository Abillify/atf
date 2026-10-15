// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the structured logger.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { createLogger } from "../logger.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// Capture stdout/stderr writes
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

let restoreFns: Array<() => void> = [];
afterEach(() => {
  for (const fn of restoreFns) fn();
  restoreFns = [];
});

describe("createLogger", () => {
  test("writes structured JSON with timestamp, level, message", () => {
    const out = captureStdout();
    restoreFns.push(out.restore);

    const logger = createLogger("info");
    logger.info("hello", { foo: "bar" });
    out.restore();

    expect(out.lines.length).toBe(1);
    const parsed = JSON.parse(at(out.lines, 0)) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("hello");
    expect(parsed.foo).toBe("bar");
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("filters out levels below the minimum", () => {
    const out = captureStdout();
    restoreFns.push(out.restore);

    const logger = createLogger("warn");
    logger.debug("debug-msg");
    logger.info("info-msg");
    out.restore();

    expect(out.lines.length).toBe(0); // both below warn
  });

  test("warn and error go to stderr", () => {
    const err = captureStderr();
    restoreFns.push(err.restore);

    const logger = createLogger("debug");
    logger.error("boom", { code: 500 });
    err.restore();

    expect(err.lines.length).toBe(1);
    const parsed = JSON.parse(at(err.lines, 0)) as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.code).toBe(500);
  });

  test("child logger includes base fields on every entry", () => {
    const out = captureStdout();
    restoreFns.push(out.restore);

    const logger = createLogger("info").child({ requestId: "req-1" });
    logger.info("a");
    logger.info("b");
    out.restore();

    expect(out.lines.length).toBe(2);
    for (const line of out.lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.requestId).toBe("req-1");
    }
  });
});

describe("createLogger — redaction", () => {
  test("never writes credential fields or credential-shaped values", () => {
    const out = captureStdout();
    restoreFns.push(out.restore);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJlX2J5dGVz";
    createLogger("info")
      .child({ access_token: jwt })
      .info(`calling upstream with Bearer ${jwt}`, {
        headers: { authorization: `Bearer ${jwt}` },
        prompt_tokens: 42,
      });
    out.restore();
    const line = at(out.lines, 0);
    expect(line).not.toContain(jwt);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.access_token).toBe("[redacted]");
    expect(parsed.prompt_tokens).toBe(42);
  });
});
