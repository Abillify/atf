// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the long-term memory fact extractor. The model call is stubbed via
 * a fake LanguageModel so the test is deterministic and offline. Verifies:
 * fact normalisation (trim/dedupe/caps), empty-text and empty-list handling,
 * the assistant-context shortcut, and fail-open on model error.
 */

import { describe, test, expect } from "bun:test";
import { createMemoryExtractor } from "../memory-extractor.js";
import { createMetrics } from "../../observability/metrics.js";
import type { LanguageModel } from "ai";

/**
 * Builds a fake AI SDK v3 LanguageModel whose `doGenerate` returns a JSON object
 * (generateObject reads `text`). When `obj` is "throw" it rejects, exercising
 * the fail-open path. `onGenerate` lets a test capture the prompt the model saw.
 */
function fakeModel(
  obj: { facts: unknown } | "throw",
  onGenerate?: (opts: unknown) => void,
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-extractor",
    doGenerate: async (opts: unknown) => {
      onGenerate?.(opts);
      if (obj === "throw") throw new Error("provider down");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(obj) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

describe("createMemoryExtractor", () => {
  test("returns the durable facts the model extracted", async () => {
    const extract = createMemoryExtractor(
      fakeModel({
        facts: [
          "The user works on the collections team.",
          "Prefers replies in German.",
        ],
      }),
    );
    const facts = await extract({
      userMessage: "I work on the collections team.",
    });
    expect(facts).toEqual([
      "The user works on the collections team.",
      "Prefers replies in German.",
    ]);
  });

  test("returns an empty list when the turn has no durable facts", async () => {
    const extract = createMemoryExtractor(fakeModel({ facts: [] }));
    const facts = await extract({ userMessage: "Wie spät ist es?" });
    expect(facts).toEqual([]);
  });

  test("trims, drops empties, and deduplicates case-insensitively", async () => {
    const extract = createMemoryExtractor(
      fakeModel({
        facts: [
          "  Mag knappe Antworten.  ",
          "",
          "   ",
          "Mag knappe Antworten.",
          "MAG KNAPPE ANTWORTEN.",
          42,
          null,
        ],
      }),
    );
    const facts = await extract({ userMessage: "Fass dich kurz." });
    expect(facts).toEqual(["Mag knappe Antworten."]);
  });

  test("caps the number of facts (maxFacts)", async () => {
    const extract = createMemoryExtractor(
      fakeModel({ facts: ["a", "b", "c", "d", "e", "f", "g"] }),
      undefined,
    );
    const facts = await extract({ userMessage: "x" });
    expect(facts.length).toBe(5);
    expect(facts).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("caps the length of each fact (maxFactChars)", async () => {
    const long = "x".repeat(500);
    const extract = createMemoryExtractor(fakeModel({ facts: [long] }), {
      maxFactChars: 240,
    });
    const facts = await extract({ userMessage: "y" });
    expect(facts[0]?.length).toBe(240);
  });

  test("respects custom maxFacts", async () => {
    const extract = createMemoryExtractor(
      fakeModel({ facts: ["a", "b", "c"] }),
      { maxFacts: 2 },
    );
    const facts = await extract({ userMessage: "x" });
    expect(facts).toEqual(["a", "b"]);
  });

  test("short-circuits empty user text without a model call", async () => {
    let called = false;
    const model = fakeModel({ facts: ["should not appear"] }, () => {
      called = true;
    });
    const extract = createMemoryExtractor(model);
    const facts = await extract({ userMessage: "   " });
    expect(facts).toEqual([]);
    expect(called).toBe(false);
  });

  test("includes the assistant reply as context when provided", async () => {
    let prompt: string | undefined;
    const model = fakeModel({ facts: [] }, (opts) => {
      const o = opts as { prompt?: Array<{ role: string; content: unknown }> };
      const userTurn = o.prompt?.find((m) => m.role === "user");
      const content = userTurn?.content;
      prompt = Array.isArray(content)
        ? content.map((p) => (p as { text?: string }).text ?? "").join("")
        : typeof content === "string"
          ? content
          : undefined;
    });
    const extract = createMemoryExtractor(model);
    await extract({
      userMessage: "Ich heiße Alex.",
      assistantMessage: "Hallo Alex!",
    });
    expect(prompt).toContain("Ich heiße Alex.");
    expect(prompt).toContain("Hallo Alex!");
    expect(prompt).toContain("ASSISTANT");
  });

  test("fails open (empty list) when the model errors", async () => {
    const extract = createMemoryExtractor(fakeModel("throw"));
    const facts = await extract({ userMessage: "Ich bin Teamleiter." });
    expect(facts).toEqual([]);
  });

  test("fail-open on a model error counts aiperator_degraded_total (Req 7.8)", async () => {
    const m = createMetrics(true);
    const extract = createMemoryExtractor(fakeModel("throw"), { metrics: m });
    const facts = await extract({ userMessage: "Ich bin Teamleiter." });
    expect(facts).toEqual([]);
    expect(m.render()).toContain(
      'aiperator_degraded_total{component="memory_extractor"} 1',
    );
  });
});
