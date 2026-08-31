// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the per-flow guardrail resolver. Verifies the inherit/disable/
 * override semantics for both the output and egress sections, that an override
 * actually redacts/blocks, and that compiled instances are cached and
 * invalidated when the policy generation bumps (hot-reload).
 */

import { describe, expect, it } from "bun:test";
import {
  createFlowGuardrailResolver,
  type GlobalGuardrailDefaults,
} from "../flow-guardrail-resolver.js";
import type {
  GuardrailOverride,
  GuardrailPolicyService,
} from "../guardrail-policy.js";

/** Mutable stub policy service so tests can drive resolve()/generation(). */
class StubPolicy implements GuardrailPolicyService {
  private gen = 0;
  constructor(private overrides: Map<string, GuardrailOverride>) {}
  resolve(flowId: string): GuardrailOverride | undefined {
    return this.overrides.get(flowId);
  }
  reload(): void {
    this.gen++;
  }
  generation(): number {
    return this.gen;
  }
  listRules() {
    return [];
  }
  hasPolicy(): boolean {
    return true;
  }
  set(flowId: string, o: GuardrailOverride): void {
    this.overrides.set(flowId, o);
  }
}

const DEFAULTS: GlobalGuardrailDefaults = {
  output: { enabled: false, redactPii: true, mode: "redact" },
  egress: { enabled: false, redactPii: true, mode: "redact" },
};

describe("FlowGuardrailResolver", () => {
  it("returns undefined when the flow has no policy override (inherit global)", () => {
    const policy = new StubPolicy(new Map());
    const resolver = createFlowGuardrailResolver(policy, DEFAULTS);
    expect(resolver.resolve("any-flow")).toBeUndefined();
  });

  it("builds an output guardrail that redacts when the flow overrides output", () => {
    const policy = new StubPolicy(
      new Map([["regulated", { output: { enabled: true, mode: "redact" } }]]),
    );
    const resolver = createFlowGuardrailResolver(policy, DEFAULTS);
    const res = resolver.resolve("regulated");
    expect(res).toBeDefined();
    if (res === undefined) throw new Error("expected a resolved override");
    expect(res.output).not.toBeNull();
    if (res.output === null || res.output === undefined)
      throw new Error("expected an output guardrail");
    const result = res.output.redact("Contact me at john@example.com please");
    expect(result.text).not.toContain("john@example.com");
  });

  it("disables the output guardrail when enabled:false even if global is on", () => {
    const policy = new StubPolicy(
      new Map([["trusted", { output: { enabled: false } }]]),
    );
    const resolver = createFlowGuardrailResolver(policy, {
      ...DEFAULTS,
      output: { enabled: true, redactPii: true, mode: "redact" },
    });
    const res = resolver.resolve("trusted");
    expect(res).toBeDefined();
    if (res === undefined) throw new Error("expected a resolved override");
    expect("output" in res).toBe(true);
    expect(res.output).toBeNull(); // explicitly disabled for this flow
  });

  it("builds an egress guardrail in block mode that flags PII in tool args", () => {
    const policy = new StubPolicy(
      new Map([
        [
          "collections",
          { egress: { enabled: true, mode: "block", piiTypes: ["email"] } },
        ],
      ]),
    );
    const resolver = createFlowGuardrailResolver(policy, DEFAULTS);
    const res = resolver.resolve("collections");
    if (res === undefined) throw new Error("expected a resolved override");
    expect(res.egress).not.toBeNull();
    if (res.egress === null || res.egress === undefined)
      throw new Error("expected an egress guardrail");
    const scrub = res.egress.scrub({ q: "mail debtor@example.com" });
    expect(Object.values(scrub.findings).some((n) => n > 0)).toBe(true);
  });

  it("resolves output and egress independently in one rule", () => {
    const policy = new StubPolicy(
      new Map([
        [
          "both",
          {
            output: { enabled: true, mode: "redact" },
            egress: { enabled: true, mode: "block" },
          },
        ],
      ]),
    );
    const resolver = createFlowGuardrailResolver(policy, DEFAULTS);
    const res = resolver.resolve("both");
    if (res === undefined) throw new Error("expected a resolved override");
    expect(res.output).not.toBeNull();
    expect(res.egress).not.toBeNull();
  });

  it("caches the compiled instance and invalidates on a generation bump", () => {
    const policy = new StubPolicy(
      new Map([["f", { output: { enabled: true, mode: "redact" } }]]),
    );
    const resolver = createFlowGuardrailResolver(policy, DEFAULTS);
    const first = resolver.resolve("f");
    const second = resolver.resolve("f");
    expect(first).toBe(second); // memoised within a generation

    policy.reload(); // bump generation → cache invalidated
    const third = resolver.resolve("f");
    expect(third).not.toBe(first);
    if (third === undefined) throw new Error("expected a resolved override");
    expect(third.output).not.toBeNull();
  });
});
