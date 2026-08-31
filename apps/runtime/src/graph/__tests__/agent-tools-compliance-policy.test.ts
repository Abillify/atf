// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { buildAiTools } from "../agent-tools.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { ToolSet } from "ai";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { CompliancePolicy } from "../../compliance/policy-schema.js";

async function executeOnlyTool(tools: ToolSet): Promise<unknown> {
  const [key] = Object.keys(tools);
  if (key === undefined) throw new Error("expected exactly one tool");
  const agentTool = tools[key];
  if (agentTool?.execute === undefined) throw new Error("expected executable tool");
  return agentTool.execute({}, {} as never);
}

const NODE: FlowNode = { id: "n1", type: "llm", tools: ["fake/lookup"] };
const CTX: RequestContext = { ssoToken: "a.b.c", executionId: "exec-1" };
const POLICY: CompliancePolicy = {
  version: "1",
  failClosed: true,
  approvalRules: [{ toolPatterns: ["fake/*"] }],
};

describe("buildAiTools — mcpgate approval authority", () => {
  it("does not perform a local static or compliance-policy approval before an MCP call", async () => {
    let calls = 0;
    const mcp: McpWrapperService = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["lookup"],
      getFilteredToolSchema: async (_server, tool) => ({
        name: tool,
        inputSchema: { type: "object", properties: {} },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async () => {
        calls++;
        return { content: "ok" };
      },
      getInstructions: () => undefined,
    };
    const approval = {
      gate: {
        enabled: true,
        globalPatterns: ["*"],
        timeoutMs: 1,
        requires: () => true,
        request: async () => {
          throw new Error("local approval must not be requested");
        },
        resolve: () => false,
        listPending: () => [],
        listResolved: () => [],
        getResolved: () => undefined,
      },
    } as never;

    const { tools } = await buildAiTools(
      NODE,
      mcp,
      CTX,
      approval,
      undefined,
      undefined,
      { policy: POLICY, flowId: "f1" },
    );

    expect(await executeOnlyTool(tools)).toBe("ok");
    expect(calls).toBe(1);
  });
});
