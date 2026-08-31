// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for GuardrailPolicyService
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createGuardrailPolicy } from "../guardrail-policy.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrail-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePolicy(obj: unknown): void {
  fs.writeFileSync(
    path.join(tmpDir, "guardrails.json"),
    JSON.stringify(obj),
    "utf-8",
  );
}

describe("createGuardrailPolicy", () => {
  it("returns hasPolicy=false when no guardrails.json exists", () => {
    const policy = createGuardrailPolicy(tmpDir);
    expect(policy.hasPolicy()).toBe(false);
  });

  it("resolves undefined when no policy file is present", () => {
    const policy = createGuardrailPolicy(tmpDir);
    expect(policy.resolve("any-flow")).toBeUndefined();
  });

  it("resolves undefined when no rule matches the flow", () => {
    writePolicy({ rules: [{ flow: "other-flow", input: { enabled: true } }] });
    const policy = createGuardrailPolicy(tmpDir);
    expect(policy.resolve("my-flow")).toBeUndefined();
  });

  it("returns exact-match rule over wildcard", () => {
    writePolicy({
      rules: [
        { flow: "special-flow", input: { enabled: true, mode: "block" } },
        { flow: "*", input: { enabled: true, mode: "flag" } },
      ],
    });
    const policy = createGuardrailPolicy(tmpDir);
    const override = policy.resolve("special-flow");
    expect(override?.input?.mode).toBe("block");
  });

  it("falls back to wildcard when no exact match", () => {
    writePolicy({
      rules: [
        { flow: "*", input: { enabled: true, mode: "flag", threshold: 0.75 } },
      ],
    });
    const policy = createGuardrailPolicy(tmpDir);
    const override = policy.resolve("any-flow");
    expect(override?.input?.mode).toBe("flag");
    expect(override?.input?.threshold).toBe(0.75);
  });

  it("supports enabled:false to explicitly disable a guardrail", () => {
    writePolicy({
      rules: [
        {
          flow: "trusted-flow",
          input: { enabled: false },
          output: { enabled: false },
        },
      ],
    });
    const policy = createGuardrailPolicy(tmpDir);
    const override = policy.resolve("trusted-flow");
    expect(override?.input?.enabled).toBe(false);
    expect(override?.output?.enabled).toBe(false);
  });

  it("returns output override with piiTypes and blockedPatterns", () => {
    writePolicy({
      rules: [
        {
          flow: "sensitive-flow",
          output: {
            enabled: true,
            redactPii: true,
            piiTypes: ["email", "creditCard"],
            blockedPatterns: ["INTERNAL-\\d+"],
            mode: "redact",
          },
        },
      ],
    });
    const policy = createGuardrailPolicy(tmpDir);
    const override = policy.resolve("sensitive-flow");
    expect(override?.output?.piiTypes).toEqual(["email", "creditCard"]);
    expect(override?.output?.blockedPatterns).toEqual(["INTERNAL-\\d+"]);
    expect(override?.output?.mode).toBe("redact");
  });

  it("fails open on invalid JSON — returns undefined (global config applies)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "guardrails.json"),
      "{ invalid json }",
      "utf-8",
    );
    const policy = createGuardrailPolicy(tmpDir);
    expect(policy.hasPolicy()).toBe(false);
    expect(policy.resolve("any-flow")).toBeUndefined();
  });

  it("fails open on schema validation errors", () => {
    writePolicy({ rules: [{ flow: 123, input: { mode: "unknown" } }] });
    const policy = createGuardrailPolicy(tmpDir);
    expect(policy.hasPolicy()).toBe(false);
  });

  it("reloads on demand", () => {
    const policy = createGuardrailPolicy(tmpDir);
    expect(policy.hasPolicy()).toBe(false);

    // Write a policy after creation
    writePolicy({
      rules: [{ flow: "new-flow", input: { enabled: true, mode: "block" } }],
    });
    policy.reload();

    expect(policy.hasPolicy()).toBe(true);
    expect(policy.resolve("new-flow")?.input?.mode).toBe("block");
  });

  it("parses a per-flow egress DLP override", () => {
    writePolicy({
      rules: [
        {
          flow: "collections",
          egress: {
            enabled: true,
            mode: "block",
            piiTypes: ["email", "creditCard"],
          },
        },
      ],
    });
    const policy = createGuardrailPolicy(tmpDir);
    const egress = policy.resolve("collections")?.egress;
    expect(egress?.enabled).toBe(true);
    expect(egress?.mode).toBe("block");
    expect(egress?.piiTypes).toEqual(["email", "creditCard"]);
  });

  it("bumps the generation counter on each reload", () => {
    const policy = createGuardrailPolicy(tmpDir);
    const g0 = policy.generation();
    policy.reload();
    expect(policy.generation()).toBe(g0 + 1);
    policy.reload();
    expect(policy.generation()).toBe(g0 + 2);
  });
});
