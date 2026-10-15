// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Taint rule in the LLM tool loop (`buildAiTools`): after an injection finding
 * a write tool needs approval; a read-only tool and a clean run are unchanged.
 */
import { describe, it, expect } from "bun:test";
import { buildAiTools } from "../agent-tools.js";
import { createApprovalGate } from "../approval-gate.js";
import { createExecutionTaint, taintGuardForNode } from "../execution-taint.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ToolSet } from "ai";

async function executeOnlyTool(tools: ToolSet, args: unknown): Promise<unknown> {
  const [key] = Object.keys(tools);
  const tool = key === undefined ? undefined : tools[key];
  if (tool?.execute === undefined) throw new Error("expected one executable tool");
  return tool.execute(args, { toolCallId: "tc-1" } as never);
}

function fakeMcp(
  calls: string[],
  annotations?: { readOnlyHint?: boolean },
): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["act"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      ...(annotations !== undefined ? { annotations } : {}),
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (_s: string, toolName: string) => {
      calls.push(toolName);
      return { content: "ok" };
    },
    getInstructions: () => undefined,
  };
}

const CTX: RequestContext = { ssoToken: "a.b.c", executionId: "exec-taint-llm" };
const node: FlowNode = { id: "n1", type: "llm", tools: ["fake/act"] };

function guard(tainted: boolean, timeoutMs = 30) {
  const gate = createApprovalGate({ enabled: true, timeoutMs });
  if (gate === undefined) throw new Error("gate expected");
  const taint = createExecutionTaint();
  if (tainted) taint.mark("retrieval/kb");
  const g = taintGuardForNode(
    { taint, approvalGate: gate, onNodeDiagnostic: undefined, metrics: undefined as never },
    "n1",
  );
  if (g === undefined) throw new Error("guard expected");
  return { g, gate };
}

describe("buildAiTools — injection taint", () => {
  it("denies a write tool after a finding when nobody approves, and never calls it", async () => {
    const calls: string[] = [];
    const { g } = guard(true);
    const { tools } = await buildAiTools(node, fakeMcp(calls), CTX, undefined, undefined, undefined, undefined, undefined, { taint: g });
    const result = (await executeOnlyTool(tools, {})) as { isError?: boolean; error?: string };
    expect(result.isError).toBe(true);
    expect(result.error).toBe("approval_denied");
    expect(calls).toEqual([]);
  });

  it("runs the write tool once a reviewer approves", async () => {
    const calls: string[] = [];
    const { g, gate } = guard(true, 5000);
    const { tools } = await buildAiTools(node, fakeMcp(calls), CTX, undefined, undefined, undefined, undefined, undefined, { taint: g });
    const pending = executeOnlyTool(tools, {});
    for (let i = 0; i < 100 && (await gate.listPending()).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = (await gate.listPending())[0];
    expect(first?.tool).toBe("fake/act");
    await gate.resolve(first?.id ?? "", { approved: true, by: "tester" });
    await pending;
    expect(calls).toEqual(["act"]);
  });

  it("does not touch a read-only tool", async () => {
    const calls: string[] = [];
    const { g, gate } = guard(true);
    const { tools } = await buildAiTools(node, fakeMcp(calls, { readOnlyHint: true }), CTX, undefined, undefined, undefined, undefined, undefined, { taint: g });
    await executeOnlyTool(tools, {});
    expect(calls).toEqual(["act"]);
    expect(await gate.listPending()).toEqual([]);
  });

  it("does not touch a clean run", async () => {
    const calls: string[] = [];
    const { g } = guard(false);
    const { tools } = await buildAiTools(node, fakeMcp(calls), CTX, undefined, undefined, undefined, undefined, undefined, { taint: g });
    await executeOnlyTool(tools, {});
    expect(calls).toEqual(["act"]);
  });
});
