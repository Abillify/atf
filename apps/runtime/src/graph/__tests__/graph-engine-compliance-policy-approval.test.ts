// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test: compliance-policy-driven approval (ADR-0009) for the
 * deterministic `tool` node, wired end-to-end through the real GraphEngine —
 * `engine.setCompliancePolicy(policy)` (the same hook `src/index.ts` calls at
 * bootstrap and on every `compliance-policy.yaml` hot-reload).
 *
 * Mirrors the fixtures in `graph-engine-features.test.ts`'s
 * "approval gate (deterministic tool node)" block, but the node itself does
 * NOT statically declare `requiresApproval` — only the compliance policy
 * does, proving the policy's `approvalRules` reach the runtime tool-approval
 * gate without any per-node config change.
 */

import { describe, test, expect } from "bun:test";
import { createGraphEngine } from "../graph-engine.js";
import { createApprovalGate, type ApprovalGateConfig } from "../approval-gate.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { CompliancePolicy } from "../../compliance/policy-schema.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

/** `createApprovalGate` for a config known to enable the gate (never undefined). */
function mustCreateApprovalGate(config: ApprovalGateConfig) {
  const gate = createApprovalGate(config);
  if (gate === undefined) throw new Error("expected the approval gate to be enabled");
  return gate;
}

/** `engine.setCompliancePolicy`, asserting the real engine implements it. */
function mustSetCompliancePolicy(
  engine: ReturnType<typeof createGraphEngine>,
  policy: CompliancePolicy | undefined,
): void {
  if (engine.setCompliancePolicy === undefined) {
    throw new Error("expected engine.setCompliancePolicy to be implemented");
  }
  engine.setCompliancePolicy(policy);
}

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function fakeMcp(onCall: () => void): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["lookup"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async () => {
      onCall();
      return { content: "ok" };
    },
    getInstructions: () => undefined,
  };
}

const ctx = { ssoToken: "a.b.c", executionId: "exec-1" };

// Deliberately NOT declaring `requiresApproval` on the node — only the
// compliance policy will.
const flow: FlowDefinition = {
  id: "policy-approval-flow",
  name: "Policy Approval Flow",
  nodes: [{ id: "act", type: "tool", tools: ["fake/lookup"] }],
  edges: [],
};

const POLICY: CompliancePolicy = {
  version: "1",
  failClosed: true,
  approvalRules: [{ toolPatterns: ["fake/*"] }],
};

describe("compliance-policy-driven approval (deterministic tool node, engine-wired)", () => {
  test("no policy set → tool runs without pausing (node itself requires no approval)", async () => {
    let called = false;
    const mcp = fakeMcp(() => {
      called = true;
    });
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    mcpWrapper: mcp,
    llmProviderFactory: () => {
        throw new Error("no LLM node in this flow");
      },
    approvalGate: gate,
  });
    // setCompliancePolicy deliberately NOT called.

    await engine.executeFlow(
      "policy-approval-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async () => {},
      async () => {},
    );
    expect(called).toBe(true);
  });

  test("policy set with a matching approvalRule → pauses, auto-denies on timeout", async () => {
    let called = false;
    const mcp = fakeMcp(() => {
      called = true;
    });
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 30 });
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    mcpWrapper: mcp,
    llmProviderFactory: () => {
        throw new Error("no LLM node in this flow");
      },
    approvalGate: gate,
  });
    mustSetCompliancePolicy(engine, POLICY);

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "policy-approval-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );

    expect(called).toBe(false);
    const errs = chunks.filter((c) => c.choices[0]?.finish_reason === "error");
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  test("policy set + reviewer approves → tool runs", async () => {
    let called = false;
    const mcp = fakeMcp(() => {
      called = true;
    });
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    mcpWrapper: mcp,
    llmProviderFactory: () => {
        throw new Error("no LLM node in this flow");
      },
    approvalGate: gate,
  });
    mustSetCompliancePolicy(engine, POLICY);

    const approver = (async () => {
      for (let i = 0; i < 100; i++) {
        const pending = await gate.listPending();
        const first = pending[0];
        if (first !== undefined) {
          await gate.resolve(first.id, { approved: true, by: "tester" });
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await engine.executeFlow(
      "policy-approval-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async () => {},
      async () => {},
    );
    await approver;
    expect(called).toBe(true);
  });

  test("setCompliancePolicy(undefined) clears a previously-set policy", async () => {
    let called = false;
    const mcp = fakeMcp(() => {
      called = true;
    });
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 30 });
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    mcpWrapper: mcp,
    llmProviderFactory: () => {
        throw new Error("no LLM node in this flow");
      },
    approvalGate: gate,
  });
    mustSetCompliancePolicy(engine, POLICY);
    mustSetCompliancePolicy(engine, undefined);

    await engine.executeFlow(
      "policy-approval-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async () => {},
      async () => {},
    );
    expect(called).toBe(true);
  });

  test("a rule-level timeoutMs (ADR-0009) overrides the gate's global timeout end-to-end", async () => {
    let called = false;
    const mcp = fakeMcp(() => {
      called = true;
    });
    // Gate's own global timeout is long (5s) — the policy rule declares a
    // much shorter one (25ms). The run must auto-deny on the SHORT timeout,
    // not wait out the gate's default.
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    mcpWrapper: mcp,
    llmProviderFactory: () => {
        throw new Error("no LLM node in this flow");
      },
    approvalGate: gate,
  });
    mustSetCompliancePolicy(engine, {
      version: "1",
      failClosed: true,
      approvalRules: [{ toolPatterns: ["fake/*"], timeoutMs: 25 }],
    });

    const start = Date.now();
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "policy-approval-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );
    const elapsedMs = Date.now() - start;

    expect(called).toBe(false);
    const errs = chunks.filter((c) => c.choices[0]?.finish_reason === "error");
    expect(errs.length).toBeGreaterThanOrEqual(1);
    // Nowhere near the gate's 5000ms global timeout — proves the policy's
    // 25ms rule-level override actually reached ApprovalRegistry.request().
    expect(elapsedMs).toBeLessThan(2000);
  });
});
