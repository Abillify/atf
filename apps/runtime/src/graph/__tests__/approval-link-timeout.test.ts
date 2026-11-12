// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The in-chat approval capability token travels inside a URL, so it lands in
 * chat history, access logs and the Referer of the widget iframe. It must
 * therefore expire with the approval it authorizes — the gate's auto-deny
 * timeout (`APPROVAL_TIMEOUT_MS`, or the per-request `approvalRules[].timeoutMs`
 * override from a compliance policy, ADR-0009) plus a short grace — and not
 * with a fixed hour that outlives a 30-second approval by 59 minutes.
 *
 * Wired end-to-end through the real GraphEngine so the expiry observed here is
 * the one the chat actually receives.
 */

import { describe, test, expect } from "bun:test";
import { createGraphEngine } from "../graph-engine.js";
import {
  createApprovalGate,
  type ApprovalGateConfig,
  type ApprovalRegistry,
} from "../approval-gate.js";
import { APPROVAL_LINK_GRACE_MS } from "../approval-link.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { CompliancePolicy } from "../../compliance/policy-schema.js";

const LINK_SECRET = "approval-link-test-secret-at-least-32-chars";

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
  approvalBaseUrl: "https://runtime.example.test",
  oidcSessionSecret: LINK_SECRET,
};

/** `createApprovalGate` for a config known to enable the gate (never undefined). */
function mustCreateApprovalGate(config: ApprovalGateConfig): ApprovalRegistry {
  const gate = createApprovalGate(config);
  if (gate === undefined)
    throw new Error("expected the approval gate to be enabled");
  return gate;
}

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function fakeMcp(): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["lookup"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async () => ({ content: "ok" }),
    getInstructions: () => undefined,
  };
}

const ctx = { ssoToken: "a.b.c", executionId: "exec-1" };

const flow: FlowDefinition = {
  id: "link-ttl-flow",
  name: "Link TTL Flow",
  nodes: [
    {
      id: "act",
      type: "tool",
      tools: ["fake/lookup"],
      config: { requiresApproval: ["fake/lookup"] },
    },
  ],
  edges: [],
};

/** Resolve the first pending approval as soon as it shows up, so the run ends. */
function approveFirst(gate: ApprovalRegistry): Promise<void> {
  return (async () => {
    for (let i = 0; i < 200; i++) {
      const pending = await gate.listPending();
      const first = pending[0];
      if (first !== undefined) {
        await gate.resolve(first.id, { approved: true, by: "tester" });
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("the approval was never requested");
  })();
}

/** Run the flow and return everything the chat was streamed. */
async function runAndGetChatText(
  gate: ApprovalRegistry,
  policy?: CompliancePolicy,
  configOverrides: Partial<AppConfig> = {},
): Promise<string> {
  const engine = createGraphEngine({ ...baseConfig, ...configOverrides }, {
    flowRegistry: registry(flow),
    mcpWrapper: fakeMcp(),
    llmProviderFactory: () => {
      throw new Error("no LLM node in this flow");
    },
    approvalGate: gate,
  });
  if (policy !== undefined) {
    if (engine.setCompliancePolicy === undefined) {
      throw new Error("expected engine.setCompliancePolicy to be implemented");
    }
    engine.setCompliancePolicy(policy);
  }

  const chunks: ChatCompletionChunk[] = [];
  const approval = approveFirst(gate);
  await engine.executeFlow(
    "link-ttl-flow",
    [{ role: "user", content: "do it" }],
    ctx,
    async (c) => {
      chunks.push(c);
    },
    async () => {},
  );
  await approval;

  return chunks
    .map((c) => c.choices[0]?.delta?.content ?? "")
    .join("");
}

/** The capability token the chat message carries, asserted to exist. */
function tokenFromChat(text: string): { id: string; exp: number } {
  const widget = /\/monitoring\/approvals\/([^/]+)\/widget\?token=([^"&]+)/.exec(
    text,
  );
  const raw = widget?.[2];
  const id = widget?.[1];
  if (raw === undefined || id === undefined) {
    throw new Error(`expected a capability token in the approval message: ${text}`);
  }
  const payload = JSON.parse(
    Buffer.from(raw.split(".")[0], "base64url").toString("utf8"),
  ) as { id: string; exp: number };
  expect(payload.id).toBe(id);
  return payload;
}

describe("approval link token lifetime", () => {
  test("the token expires with the gate timeout, not with a fixed hour", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 300_000 });
    const before = Date.now();
    const text = await runAndGetChatText(gate);
    const after = Date.now();

    const { exp } = tokenFromChat(text);
    // Lower bound: never shorter than the approval's own lifetime.
    expect(exp).toBeGreaterThanOrEqual(before + 300_000);
    // Upper bound: the timeout plus the grace — 420 s — and definitely not the
    // hour the token used to be minted with.
    expect(exp).toBeLessThanOrEqual(after + 300_000 + APPROVAL_LINK_GRACE_MS);
    expect(exp).toBeLessThan(after + 3_600_000);
  });

  test("a compliance-policy timeoutMs override sizes the token too (ADR-0009)", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 30_000 });
    const policy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      approvalRules: [{ toolPatterns: ["fake/*"], timeoutMs: 600_000 }],
    };
    const before = Date.now();
    const text = await runAndGetChatText(gate, policy);
    const after = Date.now();

    const { exp } = tokenFromChat(text);
    // The per-request override wins over the registry default, so the token
    // must NOT expire after the 30 s global timeout either.
    expect(exp).toBeGreaterThanOrEqual(before + 600_000);
    expect(exp).toBeLessThanOrEqual(after + 600_000 + APPROVAL_LINK_GRACE_MS);
  });

  test("without a signing secret the links carry no capability token", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 30_000 });
    const engine = createGraphEngine(
      { ...baseConfig, oidcSessionSecret: undefined },
      {
        flowRegistry: registry(flow),
        mcpWrapper: fakeMcp(),
        llmProviderFactory: () => {
          throw new Error("no LLM node in this flow");
        },
        approvalGate: gate,
      },
    );

    const chunks: ChatCompletionChunk[] = [];
    const approval = approveFirst(gate);
    await engine.executeFlow(
      "link-ttl-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );
    await approval;

    const text = chunks
      .map((c) => c.choices[0]?.delta?.content ?? "")
      .join("");
    expect(text).not.toContain("token=");
  });

  test("APPROVAL_MESSAGE_LOCALE switches the language of the chat message", async () => {
    // English became the default so a flow log reads in one language end to
    // end; German remains available per deployment (APPROVAL_MESSAGE_LOCALE=de).
    const enGate = mustCreateApprovalGate({ enabled: true, timeoutMs: 300_000 });
    const en = await runAndGetChatText(enGate);
    expect(en).toContain("Approval required");
    expect(en).not.toContain("Freigabe erforderlich");

    const deGate = mustCreateApprovalGate({ enabled: true, timeoutMs: 300_000 });
    const de = await runAndGetChatText(deGate, undefined, {
      approvalMessageLocale: "de",
    });
    expect(de).toContain("Freigabe erforderlich");
    expect(de).not.toContain("Approval required");
  });
});
