// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for flow-parser.ts — Zod schemas and validateFlowDefinition
 *
 * Tests Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
 */

import { describe, test, expect } from "bun:test";
import {
  FlowNodeSchema,
  FlowEdgeSchema,
  LlmConfigSchema,
  LlmParametersSchema,
  FlowDefinitionSchema,
  validateFlowDefinition,
  logValidationError,
  type ValidationError,
} from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalValidFlow(overrides?: Partial<FlowDefinition>): unknown {
  return {
    id: "flow-1",
    name: "Test Flow",
    nodes: [{ id: "node-1", type: "llm" }],
    edges: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LlmParametersSchema
// ---------------------------------------------------------------------------

describe("LlmParametersSchema", () => {
  test("accepts empty object", () => {
    expect(LlmParametersSchema.safeParse({}).success).toBe(true);
  });

  test("accepts valid temperature and maxTokens", () => {
    expect(
      LlmParametersSchema.safeParse({ temperature: 0.7, maxTokens: 1024 })
        .success,
    ).toBe(true);
  });

  test("accepts boundary temperature 0.0", () => {
    expect(LlmParametersSchema.safeParse({ temperature: 0.0 }).success).toBe(
      true,
    );
  });

  test("accepts boundary temperature 2.0", () => {
    expect(LlmParametersSchema.safeParse({ temperature: 2.0 }).success).toBe(
      true,
    );
  });

  test("rejects temperature below 0.0", () => {
    expect(LlmParametersSchema.safeParse({ temperature: -0.1 }).success).toBe(
      false,
    );
  });

  test("rejects temperature above 2.0", () => {
    expect(LlmParametersSchema.safeParse({ temperature: 2.1 }).success).toBe(
      false,
    );
  });

  test("accepts boundary maxTokens 1", () => {
    expect(LlmParametersSchema.safeParse({ maxTokens: 1 }).success).toBe(true);
  });

  test("accepts boundary maxTokens 32768", () => {
    expect(LlmParametersSchema.safeParse({ maxTokens: 32768 }).success).toBe(
      true,
    );
  });

  test("accepts maxTokens 40576 (large local model budget)", () => {
    expect(LlmParametersSchema.safeParse({ maxTokens: 40576 }).success).toBe(
      true,
    );
  });

  test("accepts boundary maxTokens 65536", () => {
    expect(LlmParametersSchema.safeParse({ maxTokens: 65536 }).success).toBe(
      true,
    );
  });

  test("rejects maxTokens 0", () => {
    expect(LlmParametersSchema.safeParse({ maxTokens: 0 }).success).toBe(false);
  });

  test("rejects maxTokens 65537", () => {
    expect(LlmParametersSchema.safeParse({ maxTokens: 65537 }).success).toBe(
      false,
    );
  });

  test("rejects more than 20 keys", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 21; i++) obj[`key${i}`] = i;
    expect(LlmParametersSchema.safeParse(obj).success).toBe(false);
  });

  test("accepts exactly 20 keys", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) obj[`key${i}`] = i;
    expect(LlmParametersSchema.safeParse(obj).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LlmConfigSchema
// ---------------------------------------------------------------------------

describe("LlmConfigSchema", () => {
  test("accepts valid openai config", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "openai", model: "gpt-4o" })
        .success,
    ).toBe(true);
  });

  test("accepts valid google config", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "google", model: "gemini-1.5-pro" })
        .success,
    ).toBe(true);
  });

  test("accepts valid ollama config", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "ollama", model: "llama3" })
        .success,
    ).toBe(true);
  });

  test("rejects unknown provider", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "cohere", model: "command-r" })
        .success,
    ).toBe(false);
  });

  test("rejects model longer than 256 chars", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "openai", model: "a".repeat(257) })
        .success,
    ).toBe(false);
  });

  test("accepts model exactly 256 chars", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "openai", model: "a".repeat(256) })
        .success,
    ).toBe(true);
  });

  test("rejects empty model string", () => {
    expect(
      LlmConfigSchema.safeParse({ provider: "openai", model: "" }).success,
    ).toBe(false);
  });

  test("accepts config with parameters", () => {
    expect(
      LlmConfigSchema.safeParse({
        provider: "openai",
        model: "gpt-4o",
        parameters: { temperature: 0.5, maxTokens: 512 },
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FlowNodeSchema
// ---------------------------------------------------------------------------

describe("FlowNodeSchema", () => {
  test("accepts minimal node", () => {
    expect(FlowNodeSchema.safeParse({ id: "n1", type: "llm" }).success).toBe(
      true,
    );
  });

  test("accepts tool node with tools array", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "tool",
        tools: ["tool-one", "tool-two"],
      }).success,
    ).toBe(true);
  });

  test("rejects node with empty id", () => {
    expect(FlowNodeSchema.safeParse({ id: "", type: "llm" }).success).toBe(
      false,
    );
  });

  test("rejects unknown node type", () => {
    expect(FlowNodeSchema.safeParse({ id: "n1", type: "agent" }).success).toBe(
      false,
    );
  });

  test("rejects tools array with more than 50 items", () => {
    const tools = Array.from({ length: 51 }, (_, i) => `tool-${i}`);
    expect(
      FlowNodeSchema.safeParse({ id: "n1", type: "tool", tools }).success,
    ).toBe(false);
  });

  test("accepts tools array with exactly 50 items", () => {
    const tools = Array.from({ length: 50 }, (_, i) => `tool-${i}`);
    expect(
      FlowNodeSchema.safeParse({ id: "n1", type: "tool", tools }).success,
    ).toBe(true);
  });

  test("rejects tool name longer than 128 chars", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "tool",
        tools: ["a".repeat(129)],
      }).success,
    ).toBe(false);
  });

  test("accepts tool name exactly 128 chars", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "tool",
        tools: ["a".repeat(128)],
      }).success,
    ).toBe(true);
  });

  test("accepts a valid LLM final-answer contract", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          finalAnswerContract: {
            startMarker: "<<<FINAL_ANSWER>>>",
            endMarker: "<<<END_FINAL_ANSWER>>>",
            streamAfterStartMarker: true,
          },
        },
      }).success,
    ).toBe(true);
  });

  test("rejects short or identical final-answer markers", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          finalAnswerContract: {
            startMarker: "short",
            endMarker: "also-short",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          finalAnswerContract: {
            startMarker: "<<<SAME_MARKER>>>",
            endMarker: "<<<SAME_MARKER>>>",
          },
        },
      }).success,
    ).toBe(false);
  });

  test("rejects a non-boolean live-stream option", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          finalAnswerContract: {
            startMarker: "<<<FINAL_ANSWER>>>",
            endMarker: "<<<END_FINAL_ANSWER>>>",
            streamAfterStartMarker: "yes",
          },
        },
      }).success,
    ).toBe(false);
  });

  test("rejects final-answer contracts with outputSchema or tools", () => {
    const contract = {
      startMarker: "<<<FINAL_ANSWER>>>",
      endMarker: "<<<END_FINAL_ANSWER>>>",
    };
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          finalAnswerContract: contract,
          outputSchema: { schema: { type: "object" } },
        },
      }).success,
    ).toBe(false);
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        tools: ["base/datetime"],
        config: { finalAnswerContract: contract },
      }).success,
    ).toBe(false);
  });

  test("accepts a config.imageInspection block with a vision model", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          imageInspection: {
            llm: { provider: "openai", model: "gpt-4o" },
            maxAnswerChars: 6_000,
          },
        },
      }).success,
    ).toBe(true);
  });

  test("rejects text-only or unknown imageInspection models unless explicitly attested", () => {
    const base = { id: "n1", type: "llm", config: { imageInspection: { llm: { provider: "openai", model: "text-only-unknown" } } } };
    expect(FlowNodeSchema.safeParse(base).success).toBe(false);
    expect(
      FlowNodeSchema.safeParse({
        ...base,
        config: { imageInspection: { llm: { provider: "openai", model: "local-vision", parameters: { visionInput: true } } } },
      }).success,
    ).toBe(true);
  });

  test("rejects config.imageInspection without a vision model", () => {
    // Without `llm` there is no way back to the pixels once the image was
    // parked as a reference — the flow would silently stop reading attachments.
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: { imageInspection: { maxAnswerChars: 5_000 } },
      }).success,
    ).toBe(false);
  });

  test("rejects a malformed imageInspection answer cap", () => {
    const vision = { provider: "openai", model: "gpt-4o" };
    // Too small to answer anything useful, too large for a hosting prompt,
    // and a fraction is not a character count.
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: { imageInspection: { llm: vision, maxAnswerChars: 10 } },
      }).success,
    ).toBe(false);
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: { imageInspection: { llm: vision, maxAnswerChars: 5_000_000 } },
      }).success,
    ).toBe(false);
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: { imageInspection: { llm: vision, maxAnswerChars: 1.5 } },
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown provider in config.imageInspection.llm", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        config: {
          imageInspection: { llm: { provider: "nonsense", model: "x" } },
        },
      }).success,
    ).toBe(false);
  });

  test("accepts router type", () => {
    expect(FlowNodeSchema.safeParse({ id: "n1", type: "router" }).success).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// FlowNodeSchema — dynamic overrides (Fix #1: schema must match NodeOverride
// type + engine so documented context-based overrides survive parsing)
// ---------------------------------------------------------------------------

describe("FlowNodeSchema — overrides", () => {
  test("accepts a classLabel-based override (legacy shape)", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        overrides: [
          {
            whenClass: "technical",
            llm: { provider: "openai", model: "gpt-4o" },
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("accepts a whenClaim override with systemPrompt (previously stripped)", () => {
    const result = FlowNodeSchema.safeParse({
      id: "n1",
      type: "llm",
      overrides: [{ whenClaim: "tier == 'gold'", systemPrompt: "Be concise." }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const ov = result.data.overrides?.[0];
      // The fields must NOT be stripped out of the parsed result
      expect(ov?.whenClaim).toBe("tier == 'gold'");
      expect(ov?.systemPrompt).toBe("Be concise.");
    }
  });

  test("accepts whenPlan / whenGroup / whenLanguage / whenParam overrides", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        overrides: [
          {
            whenPlan: "enterprise",
            llm: { provider: "openai", model: "gpt-4o" },
          },
          { whenGroup: "beta", systemPrompt: "Beta assistant." },
          { whenLanguage: "de", systemPrompt: "Antworte auf Deutsch." },
          { whenParam: "channel == 'mobile'", tools: ["my-mcp/x"] },
        ],
      }).success,
    ).toBe(true);
  });

  test("rejects an override with no 'when…' condition", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        overrides: [{ llm: { provider: "openai", model: "gpt-4o" } }],
      }).success,
    ).toBe(false);
  });

  test("rejects an override with a condition but no action (llm/tools/systemPrompt)", () => {
    expect(
      FlowNodeSchema.safeParse({
        id: "n1",
        type: "llm",
        overrides: [{ whenClass: "technical" }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FlowEdgeSchema
// ---------------------------------------------------------------------------

describe("FlowEdgeSchema", () => {
  test("accepts minimal edge", () => {
    expect(
      FlowEdgeSchema.safeParse({ source: "n1", target: "n2" }).success,
    ).toBe(true);
  });

  test("accepts edge with conditions", () => {
    expect(
      FlowEdgeSchema.safeParse({
        source: "n1",
        target: "n2",
        conditions: "x > 0",
      }).success,
    ).toBe(true);
  });

  test("rejects conditions longer than 1024 chars", () => {
    expect(
      FlowEdgeSchema.safeParse({
        source: "n1",
        target: "n2",
        conditions: "x".repeat(1025),
      }).success,
    ).toBe(false);
  });

  test("accepts conditions exactly 1024 chars", () => {
    expect(
      FlowEdgeSchema.safeParse({
        source: "n1",
        target: "n2",
        conditions: "x".repeat(1024),
      }).success,
    ).toBe(true);
  });

  test("rejects empty source", () => {
    expect(FlowEdgeSchema.safeParse({ source: "", target: "n2" }).success).toBe(
      false,
    );
  });

  test("rejects empty target", () => {
    expect(FlowEdgeSchema.safeParse({ source: "n1", target: "" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// FlowDefinitionSchema
// ---------------------------------------------------------------------------

describe("FlowDefinitionSchema", () => {
  test("accepts minimal valid flow", () => {
    const result = FlowDefinitionSchema.safeParse(minimalValidFlow());
    expect(result.success).toBe(true);
  });

  test("rejects flow with empty id", () => {
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ id: "" })).success,
    ).toBe(false);
  });

  test("rejects flow with empty name", () => {
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ name: "" })).success,
    ).toBe(false);
  });

  test("rejects flow with 0 nodes", () => {
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ nodes: [] })).success,
    ).toBe(false);
  });

  test("rejects flow with 101 nodes", () => {
    const nodes = Array.from({ length: 101 }, (_, i) => ({
      id: `n${i}`,
      type: "llm" as const,
    }));
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ nodes })).success,
    ).toBe(false);
  });

  test("accepts flow with exactly 100 nodes", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `n${i}`,
      type: "llm" as const,
    }));
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ nodes })).success,
    ).toBe(true);
  });

  test("rejects flow with 501 edges", () => {
    const nodes = [
      { id: "n1", type: "llm" as const },
      { id: "n2", type: "llm" as const },
    ];
    const edges = Array.from({ length: 501 }, () => ({
      source: "n1",
      target: "n2",
    }));
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ nodes, edges }))
        .success,
    ).toBe(false);
  });

  test("accepts flow with exactly 500 edges", () => {
    const nodes = [
      { id: "n1", type: "llm" as const },
      { id: "n2", type: "llm" as const },
    ];
    const edges = Array.from({ length: 500 }, () => ({
      source: "n1",
      target: "n2",
    }));
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ nodes, edges }))
        .success,
    ).toBe(true);
  });

  test("accepts flow with 0 edges", () => {
    expect(
      FlowDefinitionSchema.safeParse(minimalValidFlow({ edges: [] })).success,
    ).toBe(true);
  });

  test("accepts a flow declaring dataClasses (ADR-0009)", () => {
    const result = FlowDefinitionSchema.safeParse(
      minimalValidFlow({ dataClasses: ["personal", "financial"] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataClasses).toEqual(["personal", "financial"]);
    }
  });

  test("omitting dataClasses is valid (backward compatible)", () => {
    expect(FlowDefinitionSchema.safeParse(minimalValidFlow()).success).toBe(
      true,
    );
  });

  test("rejects a dataClasses entry outside the known enum", () => {
    const invalid = {
      ...(minimalValidFlow() as Record<string, unknown>),
      dataClasses: ["not-a-real-class"],
    };
    expect(FlowDefinitionSchema.safeParse(invalid).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateFlowDefinition — semantic checks
// ---------------------------------------------------------------------------

describe("validateFlowDefinition", () => {
  test("returns success for valid minimal flow", () => {
    const result = validateFlowDefinition(minimalValidFlow());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("flow-1");
    }
  });

  test("returns failure for non-object input", () => {
    const result = validateFlowDefinition("not an object");
    expect(result.success).toBe(false);
  });

  test("returns failure for null", () => {
    expect(validateFlowDefinition(null).success).toBe(false);
  });

  test("returns failure when id is missing", () => {
    const raw = { name: "X", nodes: [{ id: "n1", type: "llm" }], edges: [] };
    expect(validateFlowDefinition(raw).success).toBe(false);
  });

  test("returns failure reason string", () => {
    const result = validateFlowDefinition({
      id: "",
      name: "X",
      nodes: [{ id: "n1", type: "llm" }],
      edges: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error.reason).toBe("string");
      expect(result.error.reason.length).toBeGreaterThan(0);
    }
  });

  // Requirement 3.4 / 3.5: duplicate node ID
  test("rejects flow with duplicate node IDs", () => {
    const raw = minimalValidFlow({
      nodes: [
        { id: "dup", type: "llm" as const },
        { id: "dup", type: "tool" as const },
      ],
    });
    const result = validateFlowDefinition(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toContain("dup");
    }
  });

  test("accepts flow with distinct node IDs", () => {
    const raw = minimalValidFlow({
      nodes: [
        { id: "a", type: "llm" as const },
        { id: "b", type: "llm" as const },
      ],
      edges: [{ source: "a", target: "b" }],
    });
    expect(validateFlowDefinition(raw).success).toBe(true);
  });

  // Requirement 4.3: edge references unknown node ID
  test("rejects edge referencing unknown source node", () => {
    const raw = minimalValidFlow({
      nodes: [{ id: "n1", type: "llm" as const }],
      edges: [{ source: "unknown", target: "n1" }],
    });
    const result = validateFlowDefinition(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toContain("unknown");
    }
  });

  test("rejects edge referencing unknown target node", () => {
    const raw = minimalValidFlow({
      nodes: [{ id: "n1", type: "llm" as const }],
      edges: [{ source: "n1", target: "ghost" }],
    });
    const result = validateFlowDefinition(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toContain("ghost");
    }
  });

  // Requirement 3.9: conditions syntax — empty string should fail
  test("rejects edge with empty conditions string", () => {
    const raw = minimalValidFlow({
      nodes: [
        { id: "a", type: "llm" as const },
        { id: "b", type: "llm" as const },
      ],
      edges: [{ source: "a", target: "b", conditions: "   " }],
    });
    const result = validateFlowDefinition(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.reason).toContain("empty conditions");
    }
  });

  test("accepts edge with non-empty conditions string", () => {
    const raw = minimalValidFlow({
      nodes: [
        { id: "a", type: "llm" as const },
        { id: "b", type: "llm" as const },
      ],
      edges: [{ source: "a", target: "b", conditions: "state.route === 'B'" }],
    });
    expect(validateFlowDefinition(raw).success).toBe(true);
  });

  // Returned data shape
  test("returned data includes all required fields", () => {
    const result = validateFlowDefinition(
      minimalValidFlow({ description: "desc", metadata: { v: 1 } }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("flow-1");
      expect(result.data.name).toBe("Test Flow");
      expect(result.data.description).toBe("desc");
      expect(result.data.metadata).toEqual({ v: 1 });
    }
  });

  // ValidationError has fileName field
  test("ValidationError type includes optional fileName", () => {
    const err: ValidationError = { fileName: "test.json", reason: "bad" };
    expect(err.fileName).toBe("test.json");
  });
});

// ---------------------------------------------------------------------------
// logValidationError
// ---------------------------------------------------------------------------

describe("logValidationError", () => {
  test("writes structured JSON to stderr", () => {
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    };

    logValidationError("my-flow.json", "bad schema", { foo: 1 });

    process.stderr.write = original;

    expect(captured.length).toBeGreaterThan(0);
    const parsed = JSON.parse(captured[0] ?? "{}");
    expect(parsed.fileName).toBe("my-flow.json");
    expect(parsed.reason).toBe("bad schema");
    expect(parsed.details).toEqual({ foo: 1 });
    expect(parsed.component).toBe("flow-parser");
  });

  test("omits details field when not provided", () => {
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    };

    logValidationError("flow.json", "missing id");

    process.stderr.write = original;

    const parsed = JSON.parse(captured[0] ?? "{}");
    expect("details" in parsed).toBe(false);
  });
});
