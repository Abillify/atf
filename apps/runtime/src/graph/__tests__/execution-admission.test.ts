// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { ExecutionAdmissionService, ExecutionAdmissionError, requireExecutionAdmission } from "../execution-admission.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { GraphEngineService } from "../graph-engine.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ByokResolver } from "../tenant-provider-keys.js";

const flow = {
  id: "protected",
  name: "Protected",
  nodes: [
    { id: "llm", type: "llm", llm: { provider: "openai", model: "gpt-test" } },
  ],
  edges: [],
} as never;
const registry: FlowRegistry = {
  get: (id: string) => (id === "protected" ? flow : undefined),
  list: () => [flow],
} as unknown as FlowRegistry;
const requestCtx: RequestContext = { ssoToken: "token", executionId: "run", clientId: "tenant-a" };

function service(overrides: Partial<ConstructorParameters<typeof ExecutionAdmissionService>[0]> = {}) {
  return new ExecutionAdmissionService({
    flowRegistry: registry,
    graphEngine: { hasCapacity: () => true } as unknown as GraphEngineService,
    ...overrides,
  });
}

describe("ExecutionAdmissionService", () => {
  it("denies every run while the compliance policy file is invalid", async () => {
    const result = await service({
      compliancePolicyLoader: { policy: undefined, enforcementBlocked: true },
    }).admit("protected", requestCtx);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.failure.status).toBe(503);
      expect(result.failure.code).toBe("compliance");
    }
    const open = await service({
      authorizationEnabled: false,
      compliancePolicyLoader: { policy: undefined, enforcementBlocked: true },
    }).admit("protected", requestCtx);
    expect(open.allowed).toBe(true);
  });

  it("denies unknown flows before engine execution", async () => {
    const result = await service().admit("missing", requestCtx);
    expect(result).toEqual({
      allowed: false,
      failure: { status: 404, code: "not_found", message: "Flow 'missing' not found." },
    });
  });

  it("fails closed when mandatory BYOK has no resolver", async () => {
    const result = await service({ byokMode: "required" }).admit("protected", requestCtx);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.failure.code).toBe("byok");

    const fallbackResult = await service({
      byokMode: "required",
      fallbackLlm: { provider: "google", model: "gemini-test" },
      byokResolver: { resolve: async () => ({ openai: "tenant-openai-key" }) } as unknown as ByokResolver,
    }).admit("protected", { ...requestCtx });
    expect(fallbackResult.allowed).toBe(false);
    if (!fallbackResult.allowed) expect(fallbackResult.failure.message).toContain("google");

    const inheritedFlow = {
      id: "protected",
      name: "Protected",
      nodes: [{ id: "llm", type: "llm", overrides: [{ whenPlan: "pro", llm: { provider: "bedrock", model: "model-x" } }] }],
      edges: [],
    } as never;
    const inheritedRegistry = {
      get: (id: string) => (id === "protected" ? inheritedFlow : undefined),
      list: () => [inheritedFlow],
    } as unknown as FlowRegistry;
    const inheritedResult = await service({
      flowRegistry: inheritedRegistry,
      byokMode: "required",
      defaultLlm: { provider: "anthropic", model: "claude-test" },
      byokResolver: { resolve: async () => ({ bedrock: "not-used", openai: "not-used" }) } as unknown as ByokResolver,
    }).admit("protected", { ...requestCtx });
    expect(inheritedResult.allowed).toBe(false);
    if (!inheritedResult.allowed) {
      expect(inheritedResult.failure.message).toContain("anthropic");
      expect(inheritedResult.failure.message).toContain("bedrock");
    }
  });

  it("rejects before execution when the engine has no capacity", async () => {
    const unknownRegion = await service({ failClosedUnknownRegion: true }).admit(
      "protected",
      { ...requestCtx },
    );
    expect(unknownRegion.allowed).toBe(false);
    if (!unknownRegion.allowed) expect(unknownRegion.failure.code).toBe("compliance");

    const result = await service({
      graphEngine: { hasCapacity: () => false } as unknown as GraphEngineService,
    }).admit("protected", requestCtx);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.failure.code).toBe("capacity");
  });

  it("prevents a denied non-HTTP execution from reaching its engine callback", async () => {
    const denied = {
      admit: async () => ({
        allowed: false as const,
        failure: { status: 403 as const, code: "forbidden" as const, message: "denied" },
      }),
    };
    await expect(requireExecutionAdmission(denied, "protected", requestCtx)).rejects.toBeInstanceOf(
      ExecutionAdmissionError,
    );
  });
});
