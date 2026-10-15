// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { logger, setLogLevel, isDebugEnabled, digestForLog } from "../../src/logger.ts";

/** Capture everything written to process.stderr during `fn`. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return out;
}

afterEach(() => setLogLevel("info"));

describe("logger", () => {
  it("emits info messages at the default level", () => {
    setLogLevel("info");
    const out = captureStderr(() => logger.info("hello"));
    expect(out).toContain("hello");
    expect(out).toContain("INFO");
  });

  it("suppresses debug messages at info level", () => {
    setLogLevel("info");
    const out = captureStderr(() => logger.debug("noisy"));
    expect(out).toBe("");
  });

  it("emits debug messages at debug level", () => {
    setLogLevel("debug");
    const out = captureStderr(() => logger.debug("trace-me"));
    expect(out).toContain("trace-me");
    expect(isDebugEnabled()).toBe(true);
  });

  it("suppresses info+warn when level is error", () => {
    setLogLevel("error");
    expect(captureStderr(() => logger.info("i"))).toBe("");
    expect(captureStderr(() => logger.warn("w"))).toBe("");
    expect(captureStderr(() => logger.error("e"))).toContain("e");
  });

  it("appends structured context as JSON", () => {
    setLogLevel("info");
    const out = captureStderr(() => logger.info("msg", { tool: "x", n: 3 }));
    expect(out).toContain('"tool":"x"');
    expect(out).toContain('"n":3');
  });
});

describe("logger redaction", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJyb2xlIjoiYWRtaW4ifQ.c2lnbmF0dXJlX2J5dGVz";

  it("scrubs credential-shaped values from the msg text", () => {
    setLogLevel("info");
    const out = captureStderr(() =>
      logger.info(`router user=u status=ok Authorization: Bearer abcdefghijklmnop jwt=${JWT}`),
    );
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain(JWT);
    expect(out).toContain("[redacted]");
  });

  it("scrubs credential-shaped values nested in the context", () => {
    setLogLevel("info");
    const out = captureStderr(() =>
      logger.info("ctx", { note: `Bearer abcdefghijklmnop`, count: 12, password: "hunter2" }),
    );
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"count":12');
  });

  it("digestForLog is a short stable handle that hides the value", () => {
    const d = digestForLog("SELECT secret-ish binding");
    expect(d).toMatch(/^[0-9a-f]{12}$/);
    expect(d).toBe(digestForLog("SELECT secret-ish binding"));
    expect(d).not.toContain("SELECT");
  });
});
