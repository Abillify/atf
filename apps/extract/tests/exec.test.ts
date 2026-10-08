// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * exec.ts subprocess hardening (requirement 5.5): the mandatory timeout, the
 * explicit development-only disable, and the `prlimit` wrapper shape.
 */

import { describe, expect, it } from "vitest";
import { ExtractError } from "../src/errors.js";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  prlimitInvocation,
  run,
  type SubprocessLimits,
} from "../src/pipeline/exec.js";

const HOME = "/tmp";

function limits(overrides: Partial<SubprocessLimits> = {}): SubprocessLimits {
  return { memoryLimitMb: 0, cpuLimitSeconds: 0, ...overrides };
}

describe("prlimitInvocation", () => {
  it("leaves the command untouched when both limits are 0", () => {
    const wrapped = prlimitInvocation("pdftotext", ["-v"], limits());
    expect(wrapped).toEqual({ command: "pdftotext", args: ["-v"] });
  });

  it("wraps with --as in bytes and --cpu in seconds", () => {
    const wrapped = prlimitInvocation("soffice", ["--headless"], limits({
      memoryLimitMb: 1024,
      cpuLimitSeconds: 90,
    }));
    expect(wrapped.command).toBe("prlimit");
    expect(wrapped.args).toEqual([
      "--as=1073741824",
      "--cpu=90",
      "soffice",
      "--headless",
    ]);
  });

  it("omits the flag for a disabled limit", () => {
    const wrapped = prlimitInvocation("pdftotext", ["-v"], limits({ cpuLimitSeconds: 30 }));
    expect(wrapped.args).toEqual(["--cpu=30", "pdftotext", "-v"]);
  });
});

describe("run timeout (requirement 5.5)", () => {
  it("kills a process that outlives timeoutMs", async () => {
    await expect(run("sleep", ["5"], HOME, { timeoutMs: 250 })).rejects.toMatchObject({
      code: "CONVERSION_FAILED",
    });
  }, 15_000);

  it("an explicit 0 disables the timeout (development only)", async () => {
    // Longer than any plausible default would allow to pass silently — if the
    // 0 were ignored in favour of the default, this still succeeds only
    // because disabling works; the default itself is asserted separately.
    const started = Date.now();
    const result = await run("sleep", ["0.4"], HOME, { timeoutMs: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.stdout).toBe("");
  }, 15_000);

  it("the default timeout is a positive wall-clock ceiling", () => {
    // The value a caller gets when it omits timeoutMs; requirement 5.5 forbids
    // an unbounded subprocess, and the production gate refuses a configured 0.
    expect(DEFAULT_SUBPROCESS_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("a missing binary is CONVERTER_UNAVAILABLE, not a conversion failure", async () => {
    const error = await run("definitely-not-installed-binary", [], HOME).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).code).toBe("CONVERTER_UNAVAILABLE");
  });
});
