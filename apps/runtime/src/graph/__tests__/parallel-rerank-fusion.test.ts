// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test for the rag-context rerank FUSION in the parallel node
 * handler (`createParallelNodeHandler`).
 *
 * Drives the handler directly with a mock runtime (mock MCP wrapper returning a
 * vectorsearch payload + a mock reranker) to prove that, when
 * `config.ragProfiles.rerank` is set and a reranker is wired:
 *   - the per-source chunks are fused into ONE reranked context SystemMessage
 *     (numbered [1..k], in rerank order), not one block per source;
 *   - citations are streamed exactly once (the per-source emission is
 *     suppressed);
 *   - on an empty/failed rerank call it falls back to retrieval-score order
 *     while still producing a single fused block.
 */

import { describe, test, expect } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createParallelNodeHandler } from "../node-handlers.js";
import type { FlowNode } from "../../types/flow.js";
import type { Citation } from "../../types/openai.js";
import type { Reranker, RerankHit } from "../reranker.js";
import type { AgentState } from "../graph-engine.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

/** vectorsearch payload (MCP text-content wrapper) with two documents. */
function searchPayload(): { content: unknown } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            {
              id: "1",
              title: "Doc A",
              link: "https://k/a",
              content: "Alpha passage.",
              score: 0.2,
            },
            {
              id: "2",
              title: "Doc B",
              link: "https://k/b",
              content: "Beta passage.",
              score: 0.1,
            },
          ],
          count: 2,
        }),
      },
    ],
  };
}

const parallelNode: FlowNode = {
  id: "rag-context",
  type: "parallel",
  config: {
    ragProfiles: {
      default: "p",
      profiles: { p: [{ collection: "clientdocs", limit: 5 }] },
      rerank: { topN: 8 },
    },
  },
};

function makeRuntime(
  reranker: Reranker,
  citationCalls: Citation[][],
): import("../exec-runtime.js").ExecRuntime {
  return {
    appConfig: {},
    ctx: { ssoToken: "t", executionId: "e1" },
    onNodeStart: () => {},
    onNodeEnd: async () => {},
    onToolCall: async () => {},
    onToolResult: async () => {},
    onToolError: async () => {},
    onCitations: async (sources: Citation[]) => {
      citationCalls.push(sources);
    },
    metrics: { recordCounter: () => {} },
    mcpWrapper: {
      callTool: async () => searchPayload(),
    },
    reranker,
  } as unknown as import("../exec-runtime.js").ExecRuntime;
}

function runConfig(
  runtime: import("../exec-runtime.js").ExecRuntime,
): Parameters<ReturnType<typeof createParallelNodeHandler>>[1] {
  return { configurable: { runtime } } as unknown as Parameters<
    ReturnType<typeof createParallelNodeHandler>
  >[1];
}

const state = {
  messages: [new HumanMessage("wer kann bei ExampleCorp einen CR freigeben")],
  classification: {},
  classLabel: "CLIENTS",
  context: {},
  errors: [],
  toolResults: [],
  citations: [],
} as unknown as AgentState;

describe("parallel rag-context rerank fusion", () => {
  test("fuses all chunks into ONE reranked context block + a single citations emission", async () => {
    const citationCalls: Citation[][] = [];
    // Reranker flips the order: Doc B (index 1) first, then Doc A (index 0).
    const reranker: Reranker = {
      async rerank(_q, _docs, _topN): Promise<RerankHit[]> {
        return [
          { index: 1, score: 0.95 },
          { index: 0, score: 0.55 },
        ];
      },
    };
    const handler = createParallelNodeHandler(parallelNode, new Map());
    const out = await handler(
      state,
      runConfig(makeRuntime(reranker, citationCalls)),
    );

    const systemMsgs = (out.messages ?? []).filter(
      (m): m is SystemMessage => m instanceof SystemMessage,
    );
    // Exactly ONE fused context block (not one per source).
    expect(systemMsgs).toHaveLength(1);
    const text = String(at(systemMsgs, 0).content);
    // Reranked order: Doc B numbered [1], Doc A numbered [2].
    expect(text).toContain("[1] Doc B");
    expect(text).toContain("[2] Doc A");
    expect(text.indexOf("[1] Doc B")).toBeLessThan(text.indexOf("[2] Doc A"));

    // Citations streamed exactly once, in reranked order, with rerank scores.
    expect(citationCalls).toHaveLength(1);
    const firstCitationCall = at(citationCalls, 0);
    expect(firstCitationCall.map((c) => c.title)).toEqual(["Doc B", "Doc A"]);
    expect(at(firstCitationCall, 0).similarity_score).toBeCloseTo(0.95, 5);

    // The raw chunks still flow through as toolResults (for groundedness).
    expect((out.toolResults ?? []).length).toBeGreaterThan(0);
  });

  test("falls back to retrieval-score order when the reranker returns no hits", async () => {
    const citationCalls: Citation[][] = [];
    const reranker: Reranker = {
      async rerank(): Promise<RerankHit[]> {
        return []; // simulate API failure / empty result
      },
    };
    const handler = createParallelNodeHandler(parallelNode, new Map());
    const out = await handler(
      state,
      runConfig(makeRuntime(reranker, citationCalls)),
    );

    const systemMsgs = (out.messages ?? []).filter(
      (m): m is SystemMessage => m instanceof SystemMessage,
    );
    expect(systemMsgs).toHaveLength(1);
    const text = String(at(systemMsgs, 0).content);
    // Retrieval-score order: Doc A (0.2) ranks above Doc B (0.1).
    expect(text.indexOf("[1] Doc A")).toBeLessThan(text.indexOf("[2] Doc B"));
    expect(citationCalls).toHaveLength(1);
  });

  test("labels provenance and names the asked client so own vs cross-client stays distinguishable", async () => {
    const citationCalls: Citation[][] = [];
    // Two tagged docs: one for the asked client, one cross-client.
    const taggedPayload = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              {
                id: "1",
                title: "Doc Own",
                link: "https://k/own",
                content: "Own.",
                score: 0.2,
                tags: ["ExampleCorp B2B"],
              },
              {
                id: "2",
                title: "Doc Other",
                link: "https://k/other",
                content: "Other.",
                score: 0.9,
                tags: ["ExampleCorp B2C"],
              },
            ],
            count: 2,
          }),
        },
      ],
    };
    const reranker: Reranker = {
      async rerank(): Promise<RerankHit[]> {
        // Cross-client doc (index 1) is most query-relevant → ranks first.
        return [
          { index: 1, score: 0.95 },
          { index: 0, score: 0.5 },
        ];
      },
    };
    const runtime = makeRuntime(reranker, citationCalls);
    // Override callTool to return the tagged payload + set the asked client.
    (
      runtime as unknown as { mcpWrapper: { callTool: () => unknown } }
    ).mcpWrapper.callTool = async () => taggedPayload;
    const clientState = {
      ...state,
      classification: { clientClientdocs: "ExampleCorp B2B" },
    };
    const handler = createParallelNodeHandler(parallelNode, new Map());
    const out = await handler(clientState, runConfig(runtime));

    const systemMsg = (out.messages ?? []).find(
      (m) => m instanceof SystemMessage,
    );
    if (systemMsg === undefined) throw new Error("expected a SystemMessage");
    const text = String(systemMsg.content);
    // The authoritative tag is named in the header...
    expect(text).toContain(
      "Authoritative source tag for this question: ExampleCorp B2B",
    );
    // ...the matching source is flagged authoritative...
    expect(text).toContain("[source: ExampleCorp B2B — authoritative]");
    // ...and the cross-tag source carries its own tag, not the asked one.
    expect(text).toContain("[source tags: ExampleCorp B2C]");
  });

  test("reads the authoritative tag from the configured classification field", async () => {
    const citationCalls: Citation[][] = [];
    const taggedPayload = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              {
                id: "1",
                title: "Doc Own",
                link: "https://k/own",
                content: "Own.",
                score: 0.2,
                tags: ["ExampleCorp B2B"],
              },
            ],
            count: 1,
          }),
        },
      ],
    };
    const reranker: Reranker = {
      async rerank(): Promise<RerankHit[]> {
        return [{ index: 0, score: 0.9 }];
      },
    };
    const runtime = makeRuntime(reranker, citationCalls);
    (
      runtime as unknown as { mcpWrapper: { callTool: () => unknown } }
    ).mcpWrapper.callTool = async () => taggedPayload;

    // A flow that names its own field instead of relying on the legacy default.
    const node = {
      ...parallelNode,
      config: {
        ...(parallelNode.config as Record<string, unknown>),
        ragProfiles: {
          ...((parallelNode.config as Record<string, unknown>)
            .ragProfiles as Record<string, unknown>),
          authoritativeTagField: "businessUnit",
        },
      },
    };
    const handler = createParallelNodeHandler(node, new Map());
    const out = await handler(
      { ...state, classification: { businessUnit: "ExampleCorp B2B" } },
      runConfig(runtime),
    );

    const systemMsg = (out.messages ?? []).find((m) => m instanceof SystemMessage);
    if (systemMsg === undefined) throw new Error("expected a SystemMessage");
    const text = String(systemMsg.content);
    expect(text).toContain(
      "Authoritative source tag for this question: ExampleCorp B2B",
    );
    expect(text).toContain("[source: ExampleCorp B2B — authoritative]");
  });
});
