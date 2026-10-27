// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the ref-handle indirection in `buildAiTools` (agent-tools.ts) —
 * `opts.refHandles` resolves the model's short handles back to real document
 * references before the MCP call, and masks references in the tool result the
 * model reads.
 *
 * Regression coverage for trace 55c5b138: a small model cannot copy a long
 * path-like `reference` verbatim into the follow-up `get_document` call (it
 * truncated it to the bare `.pdf`), so every read failed. The handle gives the
 * model something it CAN copy; the runtime owns the real value.
 */

import { describe, it, expect } from "bun:test";
import { buildAiTools, suggestedPathPrefix } from "../agent-tools.js";
import { HashRefHandleRegistry } from "../ref-handles.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ToolSet } from "ai";

const REF_A =
  "prod/richtlinien/verwaltung/antragseingang_pruefung_v3.pdf#kapitel-4.2";

async function executeOnlyTool(
  tools: ToolSet,
  args: unknown,
): Promise<unknown> {
  const [key] = Object.keys(tools);
  if (key === undefined) throw new Error("expected exactly one tool");
  const tool = tools[key];
  if (tool?.execute === undefined)
    throw new Error("expected the tool to have an execute function");
  return tool.execute(args, { toolCallId: "tool-call-1" } as never);
}

function fakeMcp(
  result: unknown,
  onCall: (serverName: string, toolName: string, args: unknown) => void,
): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["search", "get_document"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (serverName: string, toolName: string, args: unknown) => {
      onCall(serverName, toolName, args);
      return { content: result };
    },
    getInstructions: () => undefined,
  };
}

const CTX: RequestContext = { ssoToken: "a.b.c", executionId: "exec-1" };

const NODE: FlowNode = {
  id: "n1",
  type: "llm",
  tools: ["vectorsearch/get_document"],
  config: { refHandles: true },
};

describe("buildAiTools — ref-handle resolution (config.refHandles)", () => {
  it("resolves a handle-valued reference to the real path before the MCP call", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ title: "Dok", content: "text" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry();
    const handle = registry.register(REF_A);
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = await executeOnlyTool(tools, { reference: handle });
    expect(seenArgs).toEqual({ reference: REF_A });
    expect(result).toEqual({ title: "Dok", content: "text" });
  });

  it("forwards a real (non-handle) reference a tool returned in this run unchanged", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ title: "Dok", content: "text" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry();
    registry.registerFromPayload({ results: [{ base_ref: REF_A }] });
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    await executeOnlyTool(tools, { reference: REF_A });
    expect(seenArgs).toEqual({ reference: REF_A });
  });

  it("rejects a hallucinated handle-shaped argument without calling the tool", async () => {
    let called = false;
    const mcp = fakeMcp({}, () => {
      called = true;
    });
    const registry = new HashRefHandleRegistry();
    const valid = registry.register(REF_A);
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = (await executeOnlyTool(tools, {
      reference: "QQQQ",
    })) as Record<string, unknown>;
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toBe("unknown_ref_handle");
    // The model gets the valid handles so it can self-correct.
    expect(String(result.message)).toContain(valid);
  });

  it("masks references in the tool result the model reads", async () => {
    const payload = {
      results: [
        { base_ref: REF_A, title: "Antragseingang", content: "Ablauf" },
      ],
    };
    const mcp = fakeMcp(payload, () => {});
    const registry = new HashRefHandleRegistry();
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = await executeOnlyTool(tools, { query: "antragseingang" });
    const json = JSON.stringify(result);
    // The model must NOT see the long path anymore…
    expect(json).not.toContain(REF_A);
    // …but the registry knows it, and the handle round-trips.
    const info = registry.list().find((i) => i.ref === REF_A);
    expect(info).toBeDefined();
    expect(json).toContain(info?.handle ?? "???");
  });

  it("leaves tool results untouched when no registry is wired", async () => {
    const payload = { results: [{ base_ref: REF_A, title: "T" }] };
    const mcp = fakeMcp(payload, () => {});
    const { tools } = await buildAiTools(NODE, mcp, CTX);
    const result = await executeOnlyTool(tools, { query: "x" });
    expect(JSON.stringify(result)).toContain(REF_A);
  });
});

// Shapes from a production trace: `link` is the bare PDF path, chapter refs
// hang below it. The folder name keeps the date prefix, commas and spaces.
const PDF =
  "/20250101_Spezifikation Alpha_Prozesse_A, B, C/20250101_Spezifikation Alpha_Prozesse_A, B, C.pdf";
const CHAPTER_73 = `${PDF}/73. 9.5 Akteneinheit prüfen`;
const CONSTRUCTED_77 = `${PDF}/77. SPEZIFIKATION ALPHA - Prozesse`;

describe("buildAiTools — unregistered (model-assembled) references", () => {
  it("rejects a constructed neighbouring-chapter reference before the MCP call", async () => {
    let called = false;
    const mcp = fakeMcp({}, () => {
      called = true;
    });
    const registry = new HashRefHandleRegistry();
    registry.registerFromPayload({ results: [{ base_ref: CHAPTER_73, link: PDF }] });
    const valid = registry.list()[0]?.handle ?? "???";
    const rejections: Array<{ kind: string; values: string[]; toolCallId: string; toolRef: string }> = [];
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, {
      refHandles: registry,
      onRefHandleRejected: (info) => rejections.push(info),
    });
    const result = (await executeOnlyTool(tools, {
      reference: CONSTRUCTED_77,
    })) as Record<string, unknown>;
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toBe("unregistered_ref");
    expect(result.unregistered_refs).toEqual([CONSTRUCTED_77]);
    expect(String(result.message)).toContain(valid);
    expect(String(result.message)).toContain("list_documents");
    expect(rejections).toEqual([
      { toolCallId: "tool-call-1", toolRef: "vectorsearch/get_document", kind: "unregistered_ref", values: [CONSTRUCTED_77] },
    ]);
  });

  it("rejects a bare `link` path used as reference", async () => {
    let called = false;
    const mcp = fakeMcp({}, () => {
      called = true;
    });
    const registry = new HashRefHandleRegistry();
    registry.registerFromPayload({ results: [{ base_ref: CHAPTER_73, link: PDF }] });
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = (await executeOnlyTool(tools, { reference: PDF })) as Record<string, unknown>;
    expect(called).toBe(false);
    expect(result.error).toBe("unregistered_ref");
  });

  it("does not block list_documents with a folder path_prefix", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ documents: [] }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry();
    registry.register(CHAPTER_73);
    const node: FlowNode = { ...NODE, tools: ["vectorsearch/list_documents"] };
    const { tools } = await buildAiTools(node, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const prefix = "/20250101_Spezifikation Alpha_Prozesse_A, B, C";
    const result = (await executeOnlyTool(tools, { path_prefix: prefix })) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect(seenArgs).toEqual({ path_prefix: prefix });
  });

  it("does not block a reference forced via config.toolArgs", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ content: "x" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry();
    const node: FlowNode = {
      ...NODE,
      config: {
        refHandles: true,
        toolArgs: { "vectorsearch/get_document": { reference: CONSTRUCTED_77 } },
      },
    };
    const { tools } = await buildAiTools(node, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    await executeOnlyTool(tools, { offset: 0 });
    expect(seenArgs).toEqual({ offset: 0, reference: CONSTRUCTED_77 });
  });

  it("accepts a real reference from an earlier tool result beyond the handle budget", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ content: "x" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry({ maxRefs: 1 });
    registry.register(REF_A);
    // Over budget: shown to the model as the real path, not as a handle.
    registry.registerFromPayload({ results: [{ base_ref: CHAPTER_73 }] });
    expect(registry.list().some((i) => i.ref === CHAPTER_73)).toBe(false);
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    await executeOnlyTool(tools, { reference: CHAPTER_73 });
    expect(seenArgs).toEqual({ reference: CHAPTER_73 });
  });

  it("accepts a real reference that a non-masking node of the run observed", async () => {
    const registry = new HashRefHandleRegistry();
    const plainNode: FlowNode = { ...NODE, id: "plain", config: {} };
    const observed = fakeMcp({ results: [{ base_ref: CHAPTER_73 }] }, () => {});
    const plain = await buildAiTools(plainNode, observed, CTX, undefined, undefined, undefined, undefined, undefined, { refObserver: registry });
    const plainResult = await executeOnlyTool(plain.tools, { query: "x" });
    // Observation never masks.
    expect(JSON.stringify(plainResult)).toContain("73. 9.5 Akteneinheit");
    expect(registry.list()).toHaveLength(0);

    let seenArgs: unknown;
    const mcp = fakeMcp({ content: "x" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    await executeOnlyTool(tools, { reference: CHAPTER_73 });
    expect(seenArgs).toEqual({ reference: CHAPTER_73 });
  });

  it("keeps `link` unmasked when only chapter references are registered", async () => {
    const payload = { results: [{ base_ref: CHAPTER_73, link: PDF, title: "9.5" }] };
    const mcp = fakeMcp(payload, () => {});
    const registry = new HashRefHandleRegistry();
    const node: FlowNode = { ...NODE, tools: ["vectorsearch/search"] };
    const { tools } = await buildAiTools(node, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = (await executeOnlyTool(tools, { query: "x" })) as {
      results: Array<{ base_ref: string; link: string }>;
    };
    expect(result.results[0]?.link).toBe(PDF);
    expect(result.results[0]?.base_ref).toBe(registry.list()[0]?.handle ?? "???");
  });
});

describe("unregistered_ref names a concrete way out (list_documents path_prefix)", () => {
  it("suggests the PDF path for a model-built chapter reference", async () => {
    const mcp = fakeMcp({}, () => {});
    const registry = new HashRefHandleRegistry();
    registry.registerFromPayload({ results: [{ base_ref: CHAPTER_73, link: PDF }] });
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = (await executeOnlyTool(tools, { reference: CONSTRUCTED_77 })) as Record<string, unknown>;
    expect(result.error).toBe("unregistered_ref");
    expect(result.suggested_path_prefixes).toEqual([PDF]);
    const message = String(result.message);
    expect(message).toContain(`list_documents with path_prefix "${PDF}"`);
    expect(message).toContain("Never build a reference yourself.");
  });

  it("derives the prefix from the first file segment, else the parent folder", () => {
    expect(suggestedPathPrefix("x/y/Datei Alpha, A.pdf/72. Titel")).toBe("x/y/Datei Alpha, A.pdf");
    expect(suggestedPathPrefix(PDF)).toBe(PDF);
    expect(suggestedPathPrefix("/Ordner/Unterordner/Kapitel 4.12")).toBe("/Ordner/Unterordner");
    expect(suggestedPathPrefix("Kapitel ohne Pfad")).toBeUndefined();
  });

  it("falls back to the generic sentence without a derivable prefix", async () => {
    const mcp = fakeMcp({}, () => {});
    const registry = new HashRefHandleRegistry();
    registry.registerFromPayload({ results: [{ base_ref: CHAPTER_73 }] });
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = (await executeOnlyTool(tools, { reference: "/Kapitel 77 Prozesse" })) as Record<string, unknown>;
    expect(result.error).toBe("unregistered_ref");
    expect(result.suggested_path_prefixes).toEqual([]);
    expect(String(result.message)).toContain("path_prefix set to its folder");
  });

  it("an observed/replayed rejection result never registers the rejected value as seen", async () => {
    const mcp = fakeMcp({}, () => {});
    const registry = new HashRefHandleRegistry();
    registry.registerFromPayload({ results: [{ base_ref: CHAPTER_73, link: PDF }] });
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const first = (await executeOnlyTool(tools, { reference: CONSTRUCTED_77 })) as Record<string, unknown>;
    expect(first.error).toBe("unregistered_ref");
    // History replay observes tool messages (llm-message-build): feed the
    // rejection back in both raw and JSON-string form.
    registry.observeFromPayload(first);
    registry.observeFromPayload(JSON.stringify(first));
    expect(registry.isKnownRef(CONSTRUCTED_77)).toBe(false);
    expect(registry.isKnownRef(PDF)).toBe(false);
    const second = (await executeOnlyTool(tools, { reference: CONSTRUCTED_77 })) as Record<string, unknown>;
    expect(second.error).toBe("unregistered_ref");
  });
});
