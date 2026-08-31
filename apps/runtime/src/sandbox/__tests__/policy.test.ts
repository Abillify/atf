// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sandbox execution policy.
 *
 * The load-bearing assertions: `supervised` always needs approval (so enabling code
 * execution does not silently also grant unattended execution), refusal order puts
 * capability before shape (so an operator-level problem is not reported as a file
 * extension problem), and every refusal states an alternative.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_INTERPRETERS,
  boundSandboxOutput,
  decideSandboxExecution,
  executionRequiresApproval,
  isSandboxInterpreter,
  type SandboxCapability,
  type SandboxExecutionRequest,
} from "../policy.js";

function capability(overrides: Partial<SandboxCapability> = {}): SandboxCapability {
  return {
    runtimeAvailable: true,
    enabledForDeployment: true,
    enabledForAssistant: true,
    autonomy: "supervised",
    assistantActive: true,
    ...overrides,
  };
}

function request(overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest {
  return {
    interpreter: "python",
    scriptPath: "scripts/report.py",
    ...overrides,
  };
}

describe("capability gating", () => {
  test.each([
    [{ runtimeAvailable: false }, "no-runtime"],
    [{ enabledForDeployment: false }, "disabled-for-deployment"],
    [{ enabledForAssistant: false }, "disabled-for-assistant"],
    [{ assistantActive: false }, "assistant-inactive"],
  ] as const)("%p refuses with %s", (overrides, reason) => {
    const decision = decideSandboxExecution({
      request: request(),
      capability: capability(overrides),
    });
    expect(decision).toMatchObject({ allow: false, reason });
  });

  test("capability is checked before shape", () => {
    // A deployment with no runtime must say so, not complain about a file
    // extension the user cannot act on anyway.
    const decision = decideSandboxExecution({
      request: request({ scriptPath: "notes.txt" }),
      capability: capability({ runtimeAvailable: false }),
    });
    expect(decision).toMatchObject({ allow: false, reason: "no-runtime" });
  });

  test("every refusal offers an alternative", () => {
    for (const overrides of [
      { runtimeAvailable: false },
      { enabledForDeployment: false },
      { enabledForAssistant: false },
    ] as const) {
      const decision = decideSandboxExecution({
        request: request(),
        capability: capability(overrides),
      });
      if (decision.allow) throw new Error("expected refusal");
      // A bare refusal produces a retry; a stated alternative produces progress.
      expect(decision.detail.length).toBeGreaterThan(40);
    }
  });
});

describe("approval by autonomy", () => {
  test("supervised always needs approval", () => {
    for (const interpreter of SANDBOX_INTERPRETERS) {
      expect(executionRequiresApproval("supervised", interpreter)).toBe(true);
    }
  });

  test("autonomous never needs approval", () => {
    for (const interpreter of SANDBOX_INTERPRETERS) {
      expect(executionRequiresApproval("autonomous", interpreter)).toBe(false);
    }
  });

  test("assisted allows python unattended but not bash or node", () => {
    expect(executionRequiresApproval("assisted", "python")).toBe(false);
    expect(executionRequiresApproval("assisted", "bash")).toBe(true);
    expect(executionRequiresApproval("assisted", "node")).toBe(true);
  });

  test("an approval prompt is rendered when approval is needed", () => {
    const decision = decideSandboxExecution({
      request: request({ purpose: "summarise the quarterly numbers" }),
      capability: capability({ autonomy: "supervised" }),
    });
    if (!decision.allow) throw new Error("expected allow");
    expect(decision.requiresApproval).toBe(true);
    expect(decision.approvalPrompt).toContain("scripts/report.py");
    expect(decision.approvalPrompt).toContain("summarise the quarterly numbers");
    // The prompt must NOT carry the script body: a prompt with a hundred lines of
    // generated code is one nobody reads.
    expect(decision.approvalPrompt?.length ?? 0).toBeLessThan(600);
  });

  test("no prompt is rendered when approval is not needed", () => {
    const decision = decideSandboxExecution({
      request: request(),
      capability: capability({ autonomy: "autonomous" }),
    });
    if (!decision.allow) throw new Error("expected allow");
    expect(decision.requiresApproval).toBe(false);
    expect(decision.approvalPrompt).toBeUndefined();
  });
});

describe("shape validation", () => {
  test("an unknown interpreter is refused", () => {
    const decision = decideSandboxExecution({
      // Cast: the point is to exercise the runtime guard against a value that
      // arrived from model output and therefore is not type-checked.
      request: request({ interpreter: "ruby" as never }),
      capability: capability(),
    });
    expect(decision).toMatchObject({
      allow: false,
      reason: "unsupported-interpreter",
    });
  });

  test.each(["/etc/passwd", "C:\\Windows\\system32\\x.py", "../../../etc/shadow.py", "", "   "])(
    "path %p is refused",
    (scriptPath) => {
      const decision = decideSandboxExecution({
        request: request({ scriptPath }),
        capability: capability(),
      });
      expect(decision).toMatchObject({
        allow: false,
        reason: "invalid-script-path",
      });
    },
  );

  test("an absolute path is refused rather than silently re-rooted", () => {
    const decision = decideSandboxExecution({
      request: request({ scriptPath: "/etc/passwd.py" }),
      capability: capability(),
    });
    if (decision.allow) throw new Error("expected refusal");
    // Quietly turning it into <workspace>/etc/passwd.py would hide the mistake
    // instead of correcting the model.
    expect(decision.detail).toContain("absolute path");
  });

  test("the extension must match the interpreter", () => {
    const decision = decideSandboxExecution({
      request: request({ interpreter: "python", scriptPath: "scripts/run.sh" }),
      capability: capability(),
    });
    expect(decision).toMatchObject({
      allow: false,
      reason: "invalid-script-path",
    });
  });

  test.each([
    ["python", "scripts/a.py"],
    ["bash", "scripts/a.sh"],
    ["bash", "scripts/a.bash"],
    ["node", "scripts/a.js"],
    ["node", "scripts/a.mjs"],
  ] as const)("%s accepts %s", (interpreter, scriptPath) => {
    const decision = decideSandboxExecution({
      request: request({ interpreter, scriptPath }),
      capability: capability({ autonomy: "autonomous" }),
    });
    expect(decision.allow).toBe(true);
  });
});

describe("argument bounds", () => {
  test("too many arguments are refused with a workaround", () => {
    const decision = decideSandboxExecution({
      request: request({ args: Array.from({ length: 40 }, (_, i) => `a${i}`) }),
      capability: capability(),
    });
    if (decision.allow) throw new Error("expected refusal");
    expect(decision.reason).toBe("too-many-arguments");
    expect(decision.detail).toContain("file in your workspace");
  });

  test("an oversized argument is refused", () => {
    const decision = decideSandboxExecution({
      request: request({ args: ["x".repeat(5_000)] }),
      capability: capability(),
    });
    expect(decision).toMatchObject({
      allow: false,
      reason: "argument-too-long",
    });
  });
});

describe("limits and network", () => {
  test("defaults are applied", () => {
    const decision = decideSandboxExecution({
      request: request(),
      capability: capability({ autonomy: "autonomous" }),
    });
    if (!decision.allow) throw new Error("expected allow");
    expect(decision.limits).toEqual(DEFAULT_SANDBOX_LIMITS);
    // Network off unless an operator says otherwise: a script with network access
    // can exfiltrate the workspace it was given to analyse.
    expect(decision.network).toBe("none");
  });

  test("operator overrides are merged, not replaced wholesale", () => {
    const decision = decideSandboxExecution({
      request: request(),
      capability: capability({ autonomy: "autonomous" }),
      limits: { timeoutMs: 5_000 },
      network: "egress",
    });
    if (!decision.allow) throw new Error("expected allow");
    expect(decision.limits.timeoutMs).toBe(5_000);
    expect(decision.limits.memoryMb).toBe(DEFAULT_SANDBOX_LIMITS.memoryMb);
    expect(decision.network).toBe("egress");
  });

  test("the interpreter guard is a runtime check, not just a type", () => {
    expect(isSandboxInterpreter("python")).toBe(true);
    expect(isSandboxInterpreter("perl")).toBe(false);
  });
});

describe("output bounding", () => {
  test("short output passes through unchanged", () => {
    const bounded = boundSandboxOutput({
      stdout: "ok",
      stderr: "",
      maxChars: 1_000,
    });
    expect(bounded).toEqual({ stdout: "ok", stderr: "", truncated: false });
  });

  test("long output keeps head and tail", () => {
    const stdout = `START${"x".repeat(10_000)}END`;
    const bounded = boundSandboxOutput({
      stdout,
      stderr: "",
      maxChars: 1_000,
    });
    expect(bounded.truncated).toBe(true);
    // The first failure is usually at the head and the result at the tail, so
    // keeping only the tail would lose the explanation.
    expect(bounded.stdout.startsWith("START")).toBe(true);
    expect(bounded.stdout.endsWith("END")).toBe(true);
    expect(bounded.stdout.length).toBeLessThanOrEqual(1_000);
  });

  test("stderr gets the larger share when both are long", () => {
    const bounded = boundSandboxOutput({
      stdout: "o".repeat(10_000),
      stderr: "e".repeat(10_000),
      maxChars: 1_000,
    });
    // A run that produced a lot of both is usually failing, and the diagnosis is
    // in stderr.
    expect(bounded.stderr.length).toBeGreaterThan(bounded.stdout.length);
    expect(bounded.stdout.length + bounded.stderr.length).toBeLessThanOrEqual(1_100);
  });

  test("a tiny budget still yields something rather than nothing", () => {
    const bounded = boundSandboxOutput({
      stdout: "x".repeat(1_000),
      stderr: "y".repeat(1_000),
      maxChars: 1,
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.stdout.length + bounded.stderr.length).toBeGreaterThan(0);
  });
});
