// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { buildAiTools } from "../agent-tools.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ToolSet } from "ai";

const hash = (character: string) => character.repeat(64);
const ctx: RequestContext = { ssoToken: "a.b.c", executionId: "execution-1" };

const pack = {
  schemaVersion: "v1",
  packId: hash("a"),
  retrievedAt: "2026-08-05T12:00:00.000Z",
  safety: { contentTrust: "untrusted" },
  evidence: [{
    evidenceId: hash("e"),
    provenance: {
      snapshotHash: hash("b"),
      contentHash: hash("c"),
      version: "7",
      modifiedAt: "2026-08-05T11:00:00.000Z",
    },
    safety: { contentTrust: "untrusted" },
    content: "Untrusted evidence text must not enter the action contract.",
  }],
};

const node: FlowNode = {
  id: "writer",
  type: "llm",
  tools: ["mcpgate/write_order"],
  config: {
    toolContext: {
      server: "vectorsearch",
      tool: "verified_evidence_pack",
      pre: {
        match: ["mcpgate/write_order"],
        queryTemplate: "{{tool}} {{args}}",
        arguments: { collection: "orders" },
        required: true,
      },
      evidenceContract: {
        match: ["mcpgate/write_order"],
        required: true,
      },
    },
  },
};

async function executeOnlyTool(tools: ToolSet): Promise<unknown> {
  const [key] = Object.keys(tools);
  if (key === undefined || tools[key]?.execute === undefined) throw new Error("missing tool");
  return tools[key].execute({ id: "42" }, {} as never);
}

function mcp(
  retrieve: () => unknown,
  onAction: (opts: Parameters<McpWrapperService["callTool"]>[4]) => void,
): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["write_order"],
    getFilteredToolSchema: async (_server, tool) => ({
      name: tool,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (server, tool, _args, _ctx, opts) => {
      if (server === "vectorsearch" && tool === "verified_evidence_pack") {
        return { content: JSON.stringify(retrieve()) };
      }
      onAction(opts);
      return { content: "completed" };
    },
    getInstructions: () => undefined,
  };
}

describe("buildAiTools — Evidence-Bound Action Contracts", () => {
  test("forwards a canonical provenance-only contract with the action", async () => {
    const evidence = pack.evidence[0];
    if (evidence === undefined) throw new Error("missing evidence fixture");
    let options: Parameters<McpWrapperService["callTool"]>[4];
    const { tools } = await buildAiTools(node, mcp(() => pack, (opts) => { options = opts; }), ctx);

    expect(await executeOnlyTool(tools)).toBe("completed");
    expect(options?.evidenceContract).toMatchObject({
      contract: {
        action: { tool: "write_order" },
        evidence: { packId: pack.packId, items: [{ evidenceId: evidence.evidenceId }] },
      },
    });
    expect(options?.evidenceContract?.serialized).not.toContain(evidence.content);
  });

  test("does not send an action when its configured verified evidence is missing", async () => {
    let actionCalls = 0;
    const { tools } = await buildAiTools(
      node,
      mcp(() => ({ evidence: [] }), () => { actionCalls++; }),
      ctx,
    );

    await expect(executeOnlyTool(tools)).rejects.toThrow("Verified evidence is required");
    expect(actionCalls).toBe(0);
  });
});


test("uses the wrapper's wire-level contract for the outgoing call", async () => {
  let options: Parameters<McpWrapperService["callTool"]>[4];
  const wrapper = mcp(() => pack, (opts) => { options = opts; });
  wrapper.prepareEvidenceActionContract = async (_server, _tool, wireArgs, _ctx, contract) => ({
    preparedCallId: "prepared-call",
    args: wireArgs,
    evidenceContract: {
      ...contract,
      hash: hash("d"),
    },
  });
  const { tools } = await buildAiTools(node, wrapper, ctx);

  await executeOnlyTool(tools);
  expect(options?.evidenceContract?.hash).toBe(hash("d"));
});