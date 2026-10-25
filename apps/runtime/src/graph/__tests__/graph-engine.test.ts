// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property-based tests for graph-engine.ts
 *
 * Properties 11–13: Graph Cache Idempotency, LLM Fallback Logic, Invalid LLM Provider → Error
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { createGraphEngine, computeFlowChecksum } from "../graph-engine.js";
import { validateFlowDefinition } from "../flow-parser.js";
import type {
  FlowDefinition,
  FlowNode,
  FlowEdge,
  LlmConfig,
} from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// Minimal AppConfig for tests that don't need a real LLM provider
// ---------------------------------------------------------------------------

const minimalAppConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
};

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a valid LlmConfig with a known provider.
 */
function arbitraryLlmConfig(): fc.Arbitrary<LlmConfig> {
  return fc.record({
    provider: fc.constantFrom(
      "openai" as const,
      "google" as const,
      "ollama" as const,
    ),
    model: fc.stringMatching(/^[a-z0-9-]{1,40}$/).filter((s) => s.length > 0),
    parameters: fc.option(
      fc.record({
        temperature: fc.option(fc.float({ min: 0.0, max: 2.0, noNaN: true }), {
          nil: undefined,
        }),
        maxTokens: fc.option(fc.integer({ min: 1, max: 32768 }), {
          nil: undefined,
        }),
      }),
      { nil: undefined },
    ),
  });
}

/**
 * Generates a valid FlowNode — optionally with an llm field.
 */
function arbitraryFlowNode(
  id: string,
  withLlm = false,
): fc.Arbitrary<FlowNode> {
  return fc.record({
    id: fc.constant(id),
    type: fc.constantFrom("llm" as const, "tool" as const, "router" as const),
    label: fc.option(fc.string({ minLength: 1, maxLength: 20 }), {
      nil: undefined,
    }),
    llm: withLlm ? arbitraryLlmConfig() : fc.constant(undefined),
  });
}

/**
 * Generates a valid FlowDefinition with 1–5 nodes.
 *
 * LangGraph requires every registered node to be reachable from START.
 * To satisfy this constraint the arbitrary always produces a fully-connected
 * linear chain: node-0 → node-1 → … → node-(n-1).
 * A single-node flow has no edges (node-0 is auto-wired to START by graph-engine).
 */
function arbitraryValidFlowDefinition(): fc.Arbitrary<FlowDefinition> {
  return fc.integer({ min: 1, max: 5 }).chain((nodeCount) => {
    const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node-${i}`);
    const nodeArbs = nodeIds.map((id) => arbitraryFlowNode(id));

    return fc
      .tuple(
        ...(nodeArbs as [fc.Arbitrary<FlowNode>, ...fc.Arbitrary<FlowNode>[]]),
      )
      .chain((nodes) => {
        // Build a complete linear chain so every node is reachable from START.
        // node-0 is auto-connected to START by the graph engine (no __start__ edge needed).
        const edges: FlowEdge[] = [];
        for (let i = 0; i < nodeIds.length - 1; i++) {
          edges.push({ source: at(nodeIds, i), target: at(nodeIds, i + 1) });
        }

        return fc.record({
          id: fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/),
          name: fc.string({ minLength: 1, maxLength: 30 }),
          nodes: fc.constant(nodes as unknown as FlowNode[]),
          edges: fc.constant(edges),
        });
      });
  });
}

/**
 * Generates a modified version of a FlowDefinition that produces a different checksum.
 * Appends a suffix to the flow name, which changes the serialised JSON.
 */
function modifiedFlow(original: FlowDefinition): FlowDefinition {
  return {
    ...original,
    name: `${original.name}-modified`,
  };
}

/**
 * Generates strings that are NOT in the allowed LLM provider enum.
 */
function arbitraryInvalidProvider(): fc.Arbitrary<string> {
  const allowed = new Set([
    "openai",
    "google",
    "ollama",
    "azure",
    "bedrock",
    "anthropic",
  ]);
  return fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => !allowed.has(s));
}

// ---------------------------------------------------------------------------
// Property 11: Graph Cache Idempotency
// ---------------------------------------------------------------------------
// Feature: ai-agent-orchestration-platform, Property 11: Graph Cache Idempotency

describe("Property 11: Graph Cache Idempotency", () => {
  test("buildGraph twice for same flow returns same object (cache hit)", () => {
    // Feature: ai-agent-orchestration-platform, Property 11: Graph Cache Idempotency
    fc.assert(
      fc.property(arbitraryValidFlowDefinition(), (flow) => {
        const engine = createGraphEngine(minimalAppConfig);
        const graph1 = engine.buildGraph(flow);
        const graph2 = engine.buildGraph(flow);
        // Same object reference from cache
        expect(graph1).toBe(graph2);
      }),
      { numRuns: 100 },
    );
  });

  test("computeFlowChecksum is deterministic for same input", () => {
    // Feature: ai-agent-orchestration-platform, Property 11: Graph Cache Idempotency
    fc.assert(
      fc.property(arbitraryValidFlowDefinition(), (flow) => {
        const cs1 = computeFlowChecksum(flow);
        const cs2 = computeFlowChecksum(flow);
        expect(cs1).toBe(cs2);
      }),
      { numRuns: 100 },
    );
  });

  test("after invalidateCache, buildGraph returns a freshly compiled graph", () => {
    // Feature: ai-agent-orchestration-platform, Property 11: Graph Cache Idempotency
    fc.assert(
      fc.property(arbitraryValidFlowDefinition(), (flow) => {
        const engine = createGraphEngine(minimalAppConfig);
        const graph1 = engine.buildGraph(flow);
        engine.invalidateCache(flow.id);
        const graph2 = engine.buildGraph(flow);
        // After invalidation a new object must be returned
        expect(graph1).not.toBe(graph2);
      }),
      { numRuns: 100 },
    );
  });

  test("modified flow produces a different checksum → triggers recompilation", () => {
    // Feature: ai-agent-orchestration-platform, Property 11: Graph Cache Idempotency
    fc.assert(
      fc.property(arbitraryValidFlowDefinition(), (flow) => {
        const engine = createGraphEngine(minimalAppConfig);
        const graph1 = engine.buildGraph(flow);

        // Modify the flow (different checksum because name changed)
        const changed = modifiedFlow(flow);
        // Both flows share the same id, so the engine must detect the checksum change
        const graph2 = engine.buildGraph(changed);

        // Different checksums
        expect(computeFlowChecksum(flow)).not.toBe(
          computeFlowChecksum(changed),
        );
        // A new object must have been compiled
        expect(graph1).not.toBe(graph2);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: LLM Fallback Logic
// ---------------------------------------------------------------------------
// Feature: ai-agent-orchestration-platform, Property 12: LLM Fallback Logic

describe("Property 12: LLM Fallback Logic", () => {
  test("buildGraph succeeds for a node WITHOUT an llm field (no throw)", () => {
    // Feature: ai-agent-orchestration-platform, Property 12: LLM Fallback Logic
    // The llm fallback logic is handled at execution time, not build time.
    // buildGraph must not throw when a node has no llm field.
    fc.assert(
      fc.property(
        arbitraryValidFlowDefinition().map((flow) => ({
          ...flow,
          // Ensure all nodes have no llm field
          nodes: flow.nodes.map(({ llm: _llm, ...rest }) => rest as FlowNode),
        })),
        (flow) => {
          const engine = createGraphEngine(minimalAppConfig);
          expect(() => engine.buildGraph(flow)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("buildGraph succeeds for a node WITH a valid llm field (no throw)", () => {
    // Feature: ai-agent-orchestration-platform, Property 12: LLM Fallback Logic
    fc.assert(
      fc.property(
        fc.tuple(arbitraryValidFlowDefinition(), arbitraryLlmConfig()),
        ([flow, llm]) => {
          const engine = createGraphEngine(minimalAppConfig);
          const flowWithLlm: FlowDefinition = {
            ...flow,
            nodes: flow.nodes.map((n) => ({ ...n, llm })),
          };
          expect(() => engine.buildGraph(flowWithLlm)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("(task 7.2) executeFlow with no llm and no global default writes error chunk and ends flow", async () => {
    // Feature: ai-agent-orchestration-platform, Property 12: LLM Fallback Logic
    // When a node has no llm field AND no global defaultLlm is configured,
    // executeFlow must write an error chunk into the stream and call onDone.
    const flowNoLlm: FlowDefinition = {
      id: "no-llm-flow",
      name: "No LLM Flow",
      nodes: [{ id: "node-1", type: "llm" }],
      edges: [],
    };

    // Config without defaultLlm
    const configNoDefault: AppConfig = {
      port: 3000,
      flowsDir: "./flows",
      monitoringTransport: "sse",
      mcpServers: [],
      corsOrigins: ["*"],
      monitoringAuthRequired: false,
      logLevel: "error",
      maxToolSteps: 5,
      maxConcurrentExecutions: 50,
      // defaultLlm intentionally omitted
    };

    // Minimal FlowRegistry stub that returns our flow
    const registry = {
      get: (id: string) => (id === "no-llm-flow" ? flowNoLlm : undefined),
      list: () => [flowNoLlm],
    };

    const engine = createGraphEngine(configNoDefault, { flowRegistry: registry });

    const chunks: import("../../types/openai.js").ChatCompletionChunk[] = [];
    let doneCalled = false;

    await engine.executeFlow(
      "no-llm-flow",
      [{ role: "user", content: "Hello" }],
      { ssoToken: "tok", executionId: "exec-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {
        doneCalled = true;
      },
    );

    // onDone must have been called
    expect(doneCalled).toBe(true);

    // At least one error chunk with finish_reason: "error" must have been emitted
    const errorChunks = chunks.filter(
      (c) => c.choices[0]?.finish_reason === "error",
    );
    expect(errorChunks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Property 13: Invalid LLM Provider → Error
// ---------------------------------------------------------------------------
// Feature: ai-agent-orchestration-platform, Property 13: Invalid LLM Provider → Error

describe("Property 13: Invalid LLM Provider → Error", () => {
  test("validateFlowDefinition rejects a FlowDefinition with an invalid provider", () => {
    // Feature: ai-agent-orchestration-platform, Property 13: Invalid LLM Provider → Error
    // The Zod schema in flow-parser.ts rejects unknown providers at parse time.
    fc.assert(
      fc.property(arbitraryInvalidProvider(), (invalidProvider) => {
        const raw = {
          id: "flow-1",
          name: "Test Flow",
          nodes: [
            {
              id: "node-1",
              type: "llm",
              llm: {
                provider: invalidProvider,
                model: "some-model",
              },
            },
          ],
          edges: [],
        };
        const result = validateFlowDefinition(raw);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("validateFlowDefinition accepts all valid providers", () => {
    // Feature: ai-agent-orchestration-platform, Property 13: Invalid LLM Provider → Error
    const validProviders = ["openai", "google", "ollama"] as const;
    for (const provider of validProviders) {
      const raw = {
        id: "flow-1",
        name: "Test Flow",
        nodes: [
          {
            id: "node-1",
            type: "llm",
            llm: { provider, model: "some-model" },
          },
        ],
        edges: [],
      };
      const result = validateFlowDefinition(raw);
      expect(result.success).toBe(true);
    }
  });

  test("buildGraph does not itself validate provider (provider validation is in llm-factory)", () => {
    // Feature: ai-agent-orchestration-platform, Property 13: Invalid LLM Provider → Error
    // buildGraph only compiles the graph structure; provider validation happens
    // in createLlmProvider, not in buildGraph.
    // A flow with an unknown provider value in the llm field should still compile
    // without throwing — the error surfaces at execution time.
    const flow: FlowDefinition = {
      id: "flow-invalid-provider",
      name: "Invalid Provider Flow",
      nodes: [
        {
          id: "node-1",
          type: "llm",
          // Cast to bypass TypeScript type check — testing runtime behaviour
          llm: { provider: "anthropic" as "openai", model: "claude-3" },
        },
      ],
      edges: [],
    };

    const engine = createGraphEngine(minimalAppConfig);
    expect(() => engine.buildGraph(flow)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Property 22: Invalid Content Blocks are handled in isolation
// ---------------------------------------------------------------------------
// Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation

import { processContentBlocks } from "../content-processor.js";
import type { ContentBlock } from "../../types/openai.js";

// ---------------------------------------------------------------------------
// Arbitraries for Property 22
// ---------------------------------------------------------------------------

/** Valid image data URL (small PNG, 1×1 pixel) */
const validImageDataUrl = fc.constant(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
);

/** Invalid image data URL — wrong format, unsupported MIME, etc. */
const invalidImageDataUrl = fc.oneof(
  // Not a URL at all → isValidUrl() returns false → "invalid_url" error
  fc.constant("not-a-url"),
  // data: URL but unsupported audio MIME — matches DATA_URL_RE but not IMAGE_DATA_URL_RE
  fc.constant("data:audio/mp3;base64,abc"),
  // data: URL with unsupported image MIME subtype (bmp) — matches DATA_URL_RE but not IMAGE_DATA_URL_RE
  fc.constant("data:image/bmp;base64,abc"),
);

/** Valid file data URL (valid MIME with slash + valid base64) */
const validFileDataUrl = fc.constant(
  "data:application/pdf;base64,JVBERi0xLjMK",
);

/** Text block — always valid */
const arbitraryTextBlock: fc.Arbitrary<ContentBlock> = fc.record({
  type: fc.constant("text" as const),
  text: fc.string({ minLength: 0, maxLength: 64 }),
});

/** Valid image block */
const arbitraryValidImageBlock: fc.Arbitrary<ContentBlock> =
  validImageDataUrl.map((url) => ({
    type: "image" as const,
    image_url: { url },
  }));

/** Valid file block */
const arbitraryValidFileBlock: fc.Arbitrary<ContentBlock> =
  validFileDataUrl.map((url) => ({ type: "file" as const, file_url: { url } }));

/** Invalid image block (bad data URL) */
const arbitraryInvalidImageBlock: fc.Arbitrary<ContentBlock> =
  invalidImageDataUrl.map((url) => ({
    type: "image" as const,
    image_url: { url },
  }));

/**
 * Invalid file block.
 * Uses a data: URL where MIME type has no slash (e.g. "application" without subtype).
 * DATA_URL_RE matches, but `mimeType.includes("/")` is false → processFileBlock returns an error.
 */
const arbitraryInvalidFileBlock: fc.Arbitrary<ContentBlock> = fc
  // MIME has no slash → "Invalid MIME type in file block" error
  .constant("data:application;base64,JVBERi0xLjMK")
  .map((url) => ({ type: "file" as const, file_url: { url } }));

/** Unsupported block type — audio or video — cast to ContentBlock for runtime testing */
const arbitraryUnsupportedBlock: fc.Arbitrary<ContentBlock> = fc
  .constantFrom("audio", "video")
  .map((type) => ({ type }) as unknown as ContentBlock);

/** A single valid ContentBlock (text, valid image, or valid file) */
function arbitraryValidBlock(): fc.Arbitrary<ContentBlock> {
  return fc.oneof(
    arbitraryTextBlock,
    arbitraryValidImageBlock,
    arbitraryValidFileBlock,
  );
}

/** A single invalid ContentBlock (bad image URL, bad file URL, or unsupported type) */
function arbitraryInvalidBlock(): fc.Arbitrary<ContentBlock> {
  return fc.oneof(
    arbitraryInvalidImageBlock,
    arbitraryInvalidFileBlock,
    arbitraryUnsupportedBlock,
  );
}

/**
 * Array with a mix of valid and invalid blocks (at least one of each).
 * Returns the array plus counts of how many invalid blocks were generated.
 */
function arbitraryMixedBlocks(): fc.Arbitrary<{
  blocks: ContentBlock[];
  invalidCount: number;
  validCount: number;
}> {
  return fc
    .tuple(
      fc.array(arbitraryInvalidBlock(), { minLength: 1, maxLength: 5 }),
      fc.array(arbitraryValidBlock(), { minLength: 1, maxLength: 5 }),
    )
    .chain(([invalids, valids]) => {
      // Interleave them so order varies
      const combined = fc.shuffledSubarray(
        [
          ...invalids.map((b, i) => ({ b, invalid: true, i })),
          ...valids.map((b, i) => ({ b, invalid: false, i })),
        ],
        { minLength: invalids.length + valids.length },
      );
      return combined.map((items) => ({
        blocks: items.map(({ b }) => b),
        invalidCount: invalids.length,
        validCount: valids.length,
      }));
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 22: Invalid Content Blocks are handled in isolation", () => {
  // ------------------------------------------------------------------
  // 22-A: Valid text blocks always produce 0 errors
  // ------------------------------------------------------------------
  test("22-A: all-text array → 0 errors, all blocks processed", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    fc.assert(
      fc.property(
        fc.array(arbitraryTextBlock, { minLength: 0, maxLength: 10 }),
        (blocks) => {
          const result = processContentBlocks(blocks);
          expect(result.errors).toHaveLength(0);
          expect(result.processed).toHaveLength(blocks.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ------------------------------------------------------------------
  // 22-B: Unsupported type (audio/video) produces exactly one error
  //        containing the type name
  // ------------------------------------------------------------------
  test("22-B: single unsupported-type block → 1 error mentioning the type name", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    fc.assert(
      fc.property(fc.constantFrom("audio", "video"), (unsupportedType) => {
        const block = { type: unsupportedType } as unknown as ContentBlock;
        const result = processContentBlocks([block]);
        expect(result.errors).toHaveLength(1);
        expect(result.processed).toHaveLength(0);
        expect(result.errors[0]?.message).toContain(unsupportedType);
      }),
      { numRuns: 100 },
    );
  });

  // ------------------------------------------------------------------
  // 22-C: Mixed array — each invalid block produces exactly one error,
  //        valid blocks appear in processed, no cross-block interference
  // ------------------------------------------------------------------
  test("22-C: mixed array → errors.length === invalidCount, processed.length >= 0", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    fc.assert(
      fc.property(arbitraryMixedBlocks(), ({ blocks, invalidCount }) => {
        const result = processContentBlocks(blocks);

        // Every invalid block must produce exactly one error
        expect(result.errors.length).toBe(invalidCount);

        // No error must be undefined
        for (const err of result.errors) {
          expect(err).toBeDefined();
          expect(typeof err.message).toBe("string");
          expect(err.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  // ------------------------------------------------------------------
  // 22-D: Isolation — at least one valid AND one invalid block both
  //        produce their respective outcomes
  // ------------------------------------------------------------------
  test("22-D: isolation — presence of invalid block does not prevent valid blocks from being processed", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    fc.assert(
      fc.property(arbitraryMixedBlocks(), ({ blocks }) => {
        const result = processContentBlocks(blocks);

        // The mixed array has at least 1 valid and 1 invalid block
        // → both errors AND processed must be non-empty
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.processed.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  // ------------------------------------------------------------------
  // 22-E: All-invalid array produces one error per block, processed is empty
  // ------------------------------------------------------------------
  test("22-E: array of only invalid blocks → errors.length === blocks.length, processed empty", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    fc.assert(
      fc.property(
        fc.array(arbitraryInvalidBlock(), { minLength: 1, maxLength: 8 }),
        (blocks) => {
          const result = processContentBlocks(blocks);
          expect(result.errors.length).toBe(blocks.length);
          expect(result.processed.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ------------------------------------------------------------------
  // 22-F: Valid-only array (no text) → 0 errors, all processed
  // ------------------------------------------------------------------
  test("22-F: array of only valid image/file blocks → 0 errors", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    fc.assert(
      fc.property(
        fc.array(fc.oneof(arbitraryValidImageBlock, arbitraryValidFileBlock), {
          minLength: 1,
          maxLength: 8,
        }),
        (blocks) => {
          const result = processContentBlocks(blocks);
          expect(result.errors.length).toBe(0);
          expect(result.processed.length).toBe(blocks.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ------------------------------------------------------------------
  // 22-G: Empty array → no errors, no processed blocks
  // ------------------------------------------------------------------
  test("22-G: empty array → 0 errors, 0 processed", () => {
    // Feature: ai-agent-orchestration-platform, Property 22: Invalid Content Blocks are handled in isolation
    const result = processContentBlocks([]);
    expect(result.errors).toHaveLength(0);
    expect(result.processed).toHaveLength(0);
  });
});
