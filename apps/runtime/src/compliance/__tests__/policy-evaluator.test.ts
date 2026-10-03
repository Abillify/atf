// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the compliance policy evaluator (`policy-evaluator.ts`).
 *
 * Pure-function tests — no I/O, no server. Covers data rules, model rules,
 * approval rules, fail-open/fail-closed, and the multi-model aggregator
 * (`evaluatePolicyForModels`) that `checkCompliancePolicy` (chat/metering.ts)
 * uses to enforce policy before the graph engine executes (ADR-0009).
 */

import { describe, it, expect } from "bun:test";
import {
  evaluatePolicy,
  evaluatePolicyForModels,
  policyRequiresToolApproval,
  getRetentionMaxAgeDays,
  getAuditVerbosity,
} from "../policy-evaluator.js";
import type { CompliancePolicy } from "../policy-schema.js";
import type { LlmConfig } from "../../types/flow.js";

function llm(provider: LlmConfig["provider"], model: string): LlmConfig {
  return { provider, model };
}

describe("evaluatePolicy", () => {
  it("allows when no policy is loaded", () => {
    const result = evaluatePolicy(undefined, { flowId: "f1" });
    expect(result.decision).toBe("allow");
    expect(result.policyAbsent).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("allows when a policy has no rules relevant to the context", () => {
    const policy: CompliancePolicy = { version: "1", failClosed: true };
    const result = evaluatePolicy(policy, {
      flowId: "f1",
      llmConfig: llm("openai", "gpt-4o"),
    });
    expect(result.decision).toBe("allow");
    expect(result.policyAbsent).toBe(false);
  });

  describe("data rules", () => {
    const policy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      dataRules: [
        {
          dataClass: "personal",
          allowedProviders: [
            { provider: "azure", allowedRegions: ["germanywestcentral"] },
            { provider: "ollama" },
          ],
        },
        { dataClass: "health", allowedProviders: [] },
      ],
    };

    it("denies a provider not on the allowed list for the data class", () => {
      const result = evaluatePolicy(policy, {
        dataClasses: ["personal"],
        llmConfig: llm("openai", "gpt-4o"),
      });
      expect(result.decision).toBe("deny");
      expect(result.violations[0]?.rule).toBe("data");
    });

    it("allows a provider on the allowed list with no region restriction", () => {
      const result = evaluatePolicy(policy, {
        dataClasses: ["personal"],
        llmConfig: llm("ollama", "llama3"),
      });
      expect(result.decision).toBe("allow");
    });

    it("warns (does not block) when region is required but unknown", () => {
      const result = evaluatePolicy(policy, {
        dataClasses: ["personal"],
        llmConfig: llm("azure", "gpt-4o"),
      });
      // The provider itself is allowed; we just can't verify the region.
      // This must surface as a non-blocking (advisory) violation, not a deny
      // — see PolicyViolation.blocking.
      expect(result.decision).toBe("allow");
      expect(result.violations[0]?.message).toContain("region");
      expect(result.violations[0]?.blocking).toBe(false);
    });

    it("allows when region matches an allowed region", () => {
      const result = evaluatePolicy(policy, {
        dataClasses: ["personal"],
        llmConfig: llm("azure", "gpt-4o"),
        region: "germanywestcentral",
      });
      expect(result.decision).toBe("allow");
    });

    it("denies any provider for a data class with an empty allow-list", () => {
      const result = evaluatePolicy(policy, {
        dataClasses: ["health"],
        llmConfig: llm("ollama", "llama3"),
      });
      expect(result.decision).toBe("deny");
      expect(result.violations[0]?.message).toContain("not permitted");
    });

    it("skips data rules entirely when dataClasses is not provided", () => {
      const result = evaluatePolicy(policy, {
        llmConfig: llm("openai", "gpt-4o"),
      });
      expect(result.decision).toBe("allow");
    });
  });

  describe("model rules", () => {
    const policy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      modelRules: [
        {
          tenant: "*",
          blockedModels: [{ provider: "openai", model: "gpt-3*" }],
        },
        {
          tenant: "retoure",
          allowedModels: [{ provider: "openai", model: "gpt-4o" }],
        },
      ],
    };

    it("denies a globally blocked model (wildcard match)", () => {
      const result = evaluatePolicy(policy, {
        llmConfig: llm("openai", "gpt-3.5-turbo"),
      });
      expect(result.decision).toBe("deny");
      expect(result.violations[0]?.rule).toBe("model");
    });

    it("denies a tenant-scoped model not on the allow-list", () => {
      const result = evaluatePolicy(policy, {
        tenantId: "retoure",
        llmConfig: llm("anthropic", "claude-3-5-sonnet-latest"),
      });
      expect(result.decision).toBe("deny");
    });

    it("allows a tenant-scoped model on the allow-list", () => {
      const result = evaluatePolicy(policy, {
        tenantId: "retoure",
        llmConfig: llm("openai", "gpt-4o"),
      });
      expect(result.decision).toBe("allow");
    });

    it("does not apply tenant-scoped rules to a different tenant", () => {
      const result = evaluatePolicy(policy, {
        tenantId: "other-tenant",
        llmConfig: llm("anthropic", "claude-3-5-sonnet-latest"),
      });
      expect(result.decision).toBe("allow");
    });
  });

  describe("approval rules", () => {
    const policy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      approvalRules: [
        {
          toolPatterns: ["retoure-*"],
          exemptRoles: ["admin"],
        },
      ],
    };

    it("requires approval when a tool id matches the pattern", () => {
      const result = evaluatePolicy(policy, {
        toolIds: ["retoure-delete"],
      });
      expect(result.decision).toBe("require-approval");
    });

    it("does not require approval for an exempt role", () => {
      const result = evaluatePolicy(policy, {
        toolIds: ["retoure-delete"],
        role: "admin",
      });
      expect(result.decision).toBe("allow");
    });

    it("does not require approval when no tool ids are present", () => {
      const result = evaluatePolicy(policy, {});
      expect(result.decision).toBe("allow");
    });
  });

  it("deny (data/model) takes precedence over require-approval", () => {
    const policy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      modelRules: [{ tenant: "*", blockedModels: [{ provider: "openai", model: "gpt-4o" }] }],
      approvalRules: [{ toolPatterns: ["*"] }],
    };
    const result = evaluatePolicy(policy, {
      llmConfig: llm("openai", "gpt-4o"),
      toolIds: ["any-tool"],
    });
    expect(result.decision).toBe("deny");
  });

  describe("fail-closed / fail-open", () => {
    it("fails closed on an evaluator error by default", () => {
      const policy = {
        version: "1",
        failClosed: true,
        // Malformed on purpose to force the try/catch path.
        modelRules: null,
      } as unknown as CompliancePolicy;
      const result = evaluatePolicy(policy, { llmConfig: llm("openai", "gpt-4o") });
      expect(result.decision).toBe("deny");
      expect(result.violations[0]?.message).toContain("fail-closed");
    });

    it("fails open when failClosed is explicitly false", () => {
      const policy = {
        version: "1",
        failClosed: false,
        modelRules: null,
      } as unknown as CompliancePolicy;
      const result = evaluatePolicy(policy, { llmConfig: llm("openai", "gpt-4o") });
      expect(result.decision).toBe("allow");
      expect(result.violations[0]?.message).toContain("fail-open");
    });
  });
});

describe("evaluatePolicyForModels", () => {
  const policy: CompliancePolicy = {
    version: "1",
    failClosed: true,
    modelRules: [
      { tenant: "*", blockedModels: [{ provider: "openai", model: "gpt-3*" }] },
    ],
  };

  it("allows when no policy is loaded", () => {
    const result = evaluatePolicyForModels(undefined, [llm("openai", "gpt-3.5")], {
      flowId: "f1",
    });
    expect(result.decision).toBe("allow");
  });

  it("allows a flow with no declared models (falls back to evaluatePolicy)", () => {
    const result = evaluatePolicyForModels(policy, [], { flowId: "f1" });
    expect(result.decision).toBe("allow");
  });

  it("denies when ANY node's model violates a rule, not just the first", () => {
    const result = evaluatePolicyForModels(
      policy,
      [llm("anthropic", "claude-3-5-sonnet-latest"), llm("openai", "gpt-3.5-turbo")],
      { flowId: "multi-model-flow" },
    );
    expect(result.decision).toBe("deny");
    expect(result.violations.some((v) => v.message.includes("gpt-3.5-turbo"))).toBe(
      true,
    );
  });

  it("allows when every node's model is compliant", () => {
    const result = evaluatePolicyForModels(
      policy,
      [llm("anthropic", "claude-3-5-sonnet-latest"), llm("openai", "gpt-4o")],
      { flowId: "multi-model-flow" },
    );
    expect(result.decision).toBe("allow");
    expect(result.violations).toHaveLength(0);
  });

  it("propagates static tool approval requirements while preserving deny precedence", () => {
    const approvalPolicy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      approvalRules: [{ toolPatterns: ["server/delete"] }],
    };
    const approval = evaluatePolicyForModels(
      approvalPolicy,
      [llm("openai", "gpt-4o")],
      { flowId: "f1", toolIds: ["server/delete"] },
    );
    expect(approval.decision).toBe("require-approval");

    const combinedPolicy: CompliancePolicy = {
      ...approvalPolicy,
      modelRules: [{ tenant: "*", blockedModels: [{ provider: "openai", model: "gpt-4o" }] }],
    };
    const denied = evaluatePolicyForModels(
      combinedPolicy,
      [llm("openai", "gpt-4o")],
      { flowId: "f1", toolIds: ["server/delete"] },
    );
    expect(denied.decision).toBe("deny");
  });
});

describe("policyRequiresToolApproval", () => {
  const policy: CompliancePolicy = {
    version: "1",
    failClosed: true,
    approvalRules: [{ toolPatterns: ["retoure-*"], exemptRoles: ["admin"] }],
  };

  it("returns required:false when no policy is loaded", () => {
    expect(
      policyRequiresToolApproval(undefined, "retoure-delete", {}),
    ).toEqual({ required: false });
  });

  it("returns required:true for a matching tool pattern", () => {
    expect(
      policyRequiresToolApproval(policy, "retoure-delete", {}),
    ).toEqual({ required: true });
  });

  it("returns required:false for a non-matching tool", () => {
    expect(
      policyRequiresToolApproval(policy, "read-only-lookup", {}),
    ).toEqual({ required: false });
  });

  it("returns required:false for an exempt role", () => {
    expect(
      policyRequiresToolApproval(policy, "retoure-delete", { role: "admin" }),
    ).toEqual({ required: false });
  });

  it("returns required:false when the policy only has data/model rules (no approvalRules)", () => {
    const modelOnlyPolicy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      modelRules: [{ tenant: "*", blockedModels: [{ provider: "openai", model: "gpt-3*" }] }],
    };
    expect(
      policyRequiresToolApproval(modelOnlyPolicy, "any-tool", {}),
    ).toEqual({ required: false });
  });

  it("passes through the matched rule's timeoutMs", () => {
    const policyWithTimeout: CompliancePolicy = {
      version: "1",
      failClosed: true,
      approvalRules: [{ toolPatterns: ["retoure-*"], timeoutMs: 120_000 }],
    };
    expect(
      policyRequiresToolApproval(policyWithTimeout, "retoure-delete", {}),
    ).toEqual({ required: true, timeoutMs: 120_000 });
  });

  it("omits timeoutMs when the matched rule does not set one (falls back to the gate's global default)", () => {
    expect(
      policyRequiresToolApproval(policy, "retoure-delete", {}),
    ).toEqual({ required: true });
  });

  it("uses the FIRST matching rule's timeoutMs when multiple rules could match", () => {
    const multiRulePolicy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      approvalRules: [
        { toolPatterns: ["retoure-*"], timeoutMs: 60_000 },
        { toolPatterns: ["*"], timeoutMs: 5_000 },
      ],
    };
    expect(
      policyRequiresToolApproval(multiRulePolicy, "retoure-delete", {}),
    ).toEqual({ required: true, timeoutMs: 60_000 });
  });
});

describe("getRetentionMaxAgeDays / getAuditVerbosity", () => {
  const policy: CompliancePolicy = {
    version: "1",
    failClosed: true,
    retentionRules: [{ dataClass: "personal", maxAgeDays: 30 }],
    auditRules: [{ actionPrefix: "flows.", verbosity: "full" }],
  };

  it("returns the configured retention override", () => {
    expect(getRetentionMaxAgeDays(policy, "personal")).toBe(30);
    expect(getRetentionMaxAgeDays(policy, "financial")).toBeUndefined();
  });

  it("returns the configured audit verbosity, defaulting to minimal", () => {
    expect(getAuditVerbosity(policy, "flows.publish")).toBe("full");
    expect(getAuditVerbosity(policy, "approvals.resolve")).toBe("minimal");
    expect(getAuditVerbosity(undefined, "flows.publish")).toBe("minimal");
  });
});
