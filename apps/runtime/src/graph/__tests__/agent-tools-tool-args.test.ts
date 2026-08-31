// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `config.toolArgs`-driven forced arguments in `buildAiTools`
 * (agent-tools.ts) — the `llm` node's agent-loop counterpart to
 * `handlers/tool.ts`'s `resolveArgs` for deterministic `type: tool` nodes.
 *
 * Regression coverage for trace 52e73443: a researcher/synthesizer `llm`
 * node had no way to force `collection` server-side on its vectorsearch tool
 * calls (unlike a `type: tool` node), so a local model omitting/mis-setting
 * it caused the MCP server to silently fall back to its own default
 * collection and every read to fail against the wrong store — with the node
 * still reporting "completed".
 */

import { describe, it, expect } from "bun:test";
import { buildAiTools } from "../agent-tools.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ToolSet } from "ai";

/** Executes the single tool `buildAiTools` produced for a one-tool node. */
async function executeOnlyTool(tools: ToolSet, args: unknown): Promise<unknown> {
  const [key] = Object.keys(tools);
  if (key === undefined) throw new Error("expected exactly one tool");
  const tool = tools[key];
  if (tool?.execute === undefined) throw new Error("expected the tool to have an execute function");
  return tool.execute(args, { toolCallId: "tool-call-1" } as never);
}

function fakeMcp(
  onCall: (serverName: string, toolName: string, args: unknown) => void,
): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["search"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (serverName: string, toolName: string, args: unknown) => {
      onCall(serverName, toolName, args);
      return { content: "ok" };
    },
    getInstructions: () => undefined,
  };
}

const CTX: RequestContext = { ssoToken: "a.b.c", executionId: "exec-1" };

describe("buildAiTools — config.toolArgs forced arguments", () => {
  it("overrides a model-supplied argument with the configured value", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp((_s, _t, args) => {
      seenArgs = args;
    });
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["vectorsearch/search"],
      config: {
        toolArgs: {
          "vectorsearch/search": { collection: "example-records" },
        },
      },
    };
    const { tools } = await buildAiTools(node, mcp, CTX);
    // Model hallucinates the wrong collection — exactly the observed trace.
    await executeOnlyTool(tools, { query: "was ist passiert?", collection: "doca" });
    expect(seenArgs).toEqual({
      query: "was ist passiert?",
      collection: "example-records",
    });
  });

  it("injects the configured value when the model omits the argument entirely", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp((_s, _t, args) => {
      seenArgs = args;
    });
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["vectorsearch/search"],
      config: {
        toolArgs: {
          "vectorsearch/search": { collection: "example-records" },
        },
      },
    };
    const { tools } = await buildAiTools(node, mcp, CTX);
    await executeOnlyTool(tools, { query: "was ist passiert?" });
    expect(seenArgs).toEqual({
      query: "was ist passiert?",
      collection: "example-records",
    });
  });

  it("reports the effective args after forced defaults are merged", async () => {
    const effective: Array<{
      toolCallId: string;
      toolRef: string;
      args: Record<string, unknown>;
    }> = [];
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["vectorsearch/search"],
      config: {
        toolArgs: {
          "vectorsearch/search": {
            collection: "example-records",
            hybrid: true,
            group_by_document: true,
          },
        },
      },
    };
    const { tools } = await buildAiTools(
      node,
      fakeMcp(() => {}),
      CTX,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        onEffectiveToolArgs: (toolCallId, toolRef, args) => {
          effective.push({ toolCallId, toolRef, args });
        },
      },
    );

    await executeOnlyTool(tools, {
      query: "juristischer Fristbeginn",
      hyde: true,
    });

    expect(effective).toEqual([
      {
        toolCallId: "tool-call-1",
        toolRef: "vectorsearch/search",
        args: {
          query: "juristischer Fristbeginn",
          hyde: true,
          collection: "example-records",
          hybrid: true,
          group_by_document: true,
        },
      },
    ]);
  });

  it("does not force args for a tool ref not listed in toolArgs", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp((_s, _t, args) => {
      seenArgs = args;
    });
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["vectorsearch/get_document"],
      config: {
        toolArgs: {
          "vectorsearch/search": { collection: "example-records" },
        },
      },
    };
    const { tools } = await buildAiTools(node, mcp, CTX);
    await executeOnlyTool(tools, { reference: "doc" });
    expect(seenArgs).toEqual({ reference: "doc" });
  });

  it("leaves model-supplied args completely unchanged when no toolArgs is configured (no regression)", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp((_s, _t, args) => {
      seenArgs = args;
    });
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["vectorsearch/search"],
    };
    const { tools } = await buildAiTools(node, mcp, CTX);
    await executeOnlyTool(tools, { query: "x", collection: "whatever-the-model-picked" });
    expect(seenArgs).toEqual({
      query: "x",
      collection: "whatever-the-model-picked",
    });
  });

  it("a forced arg satisfies the required-parameter guard even when the model omits it", async () => {
    let called = false;
    const mcp: McpWrapperService = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["search"],
      getFilteredToolSchema: async (_s, t) => ({
        name: t,
        inputSchema: {
          type: "object",
          properties: { collection: { type: "string" } },
          required: ["collection"],
        },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async () => {
        called = true;
        return { content: "ok" };
      },
      getInstructions: () => undefined,
    };
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["vectorsearch/search"],
      config: {
        toolArgs: {
          "vectorsearch/search": { collection: "example-records" },
        },
      },
    };
    const { tools } = await buildAiTools(node, mcp, CTX);
    const result = await executeOnlyTool(tools, { query: "x" });
    expect(called).toBe(true);
    expect(JSON.stringify(result)).not.toContain("missing_required_params");
  });
});


describe("buildAiTools — MCP 2026 server approvals", () => {
  it("renders through the existing gate, resolves, and returns the resumed result", async () => {
    const resolutions: unknown[] = [];
    const mcp = fakeMcp(() => {});
    mcp.callTool = async () => ({
      content: [],
      resultType: "input_required",
      inputRequests: [{
        type: "approval",
        requestState: "opaque",
        title: "Überweisung freigeben",
        message: "Bitte Betrag und Empfänger prüfen.",
        fields: [
          { name: "amount", label: "Betrag", value: "10.00 EUR" },
          { name: "recipient", label: "Empfänger", value: "Ada" },
        ],
      }],
      resolveApproval: async (request, resolution) => {
        resolutions.push({ request, resolution });
        return { content: [{ type: "text", text: "done" }], resultType: "complete" };
      },
    });
    const pendingSeen: Array<Record<string, unknown>> = [];
    const approval = {
      gate: {
        enabled: true,
        globalPatterns: [],
        timeoutMs: 5000,
        requires: () => false,
        request: async (request: Record<string, unknown>, notify?: (pending: never) => void) => {
          const pending = { ...request, id: "p1", requestedAt: new Date().toISOString() };
          pendingSeen.push(pending);
          notify?.(pending as never);
          return { approved: true, by: "alice" };
        },
        resolve: () => false,
        listPending: () => [],
        listResolved: () => [],
        getResolved: () => undefined,
      },
      notify: () => {},
    } as never;
    const node: FlowNode = { id: "n1", type: "llm", tools: ["bank/pay"] };
    const { tools } = await buildAiTools(node, mcp, CTX, approval);
    const output = await executeOnlyTool(tools, { amount: 10 });
    expect(output).toEqual([{ type: "text", text: "done" }]);
    expect(pendingSeen[0]).toMatchObject({
      title: "Überweisung freigeben",
      message: "Bitte Betrag und Empfänger prüfen.",
      fields: [
        { name: "amount", label: "Betrag", value: "10.00 EUR" },
        { name: "recipient", label: "Empfänger", value: "Ada" },
      ],
    });
    expect(resolutions).toEqual([
      expect.objectContaining({ resolution: { decision: "approved", approver: "alice" } }),
    ]);
  });

  it("returns structured approval_denied without retrying after denial", async () => {
    let resumed = 0;
    const mcp = fakeMcp(() => {});
    mcp.callTool = async () => ({
      content: [],
      resultType: "input_required",
      inputRequests: [{ type: "approval", requestState: "s", title: "Confirm", message: "Check" }],
      resolveApproval: async () => { resumed++; return undefined; },
    });
    const approval = {
      gate: {
        enabled: true, globalPatterns: [], timeoutMs: 5000, requires: () => false,
        request: async () => ({ approved: false, reason: "operator denied" }),
        resolve: () => false, listPending: () => [], listResolved: () => [], getResolved: () => undefined,
      },
    } as never;
    const node: FlowNode = { id: "n1", type: "llm", tools: ["bank/pay"] };
    const { tools } = await buildAiTools(node, mcp, CTX, approval);
    expect(await executeOnlyTool(tools, {})).toEqual({
      error: "approval_denied",
      message: "operator denied",
    });
    expect(resumed).toBe(1);
  });
});


describe("buildAiTools — token-bound MCP schema discovery", () => {
  it("fetches every LLM-visible tool schema with the caller bearer", async () => {
    let receivedAuthToken: string | undefined;
    const mcp = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["status"],
      getFilteredToolSchema: async (
        _server: string,
        tool: string,
        opts?: { authToken?: string },
      ) => {
        receivedAuthToken = opts?.authToken;
        return {
          name: tool,
          inputSchema: { type: "object", properties: {} },
        };
      },
      refreshSchemaIfChanged: async () => false,
      callTool: async () => ({ content: "ok" }),
      getInstructions: () => undefined,
    } as unknown as McpWrapperService;
    const node: FlowNode = {
      id: "n1",
      type: "llm",
      tools: ["parking/status"],
    };

    const { tools } = await buildAiTools(node, mcp, CTX);

    expect(Object.keys(tools)).toEqual(["parking__status"]);
    expect(receivedAuthToken).toBe(CTX.ssoToken);
  });
});