// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the groundedness / citation gate.
 */

import { describe, test, expect } from "bun:test";
import {
  tokenize,
  contentTokens,
  splitSentences,
  checkGroundedness,
  createGroundednessGate,
  checkGroundednessSemantic,
  checkGroundednessLlm,
} from "../groundedness.js";

/** `createGroundednessGate` for a config known to enable the gate. */
function mustCreateGroundednessGate(
  ...args: Parameters<typeof createGroundednessGate>
): NonNullable<ReturnType<typeof createGroundednessGate>> {
  const gate = createGroundednessGate(...args);
  if (gate === undefined)
    throw new Error("expected the groundedness gate to be enabled");
  return gate;
}

describe("tokenize / contentTokens", () => {
  test("lowercases and strips punctuation", () => {
    expect(tokenize("Hello, World! 42")).toEqual(["hello", "world", "42"]);
  });

  test("handles unicode (German umlauts)", () => {
    expect(tokenize("Schuldner über Mahnbescheid")).toEqual([
      "schuldner",
      "über",
      "mahnbescheid",
    ]);
  });

  test("contentTokens drops stopwords and 1-char tokens", () => {
    expect(contentTokens("the case is about a debtor")).toEqual([
      "case",
      "debtor",
    ]);
  });
});

describe("splitSentences", () => {
  test("splits on terminal punctuation and newlines", () => {
    const s = splitSentences("First sentence. Second one!\nThird line");
    expect(s).toEqual(["First sentence.", "Second one!", "Third line"]);
  });
});

describe("checkGroundedness", () => {
  const sources = [
    "Akte A-123 betrifft den Schuldner Max Mustermann. Der Mahnbescheid wurde am 1. Januar zugestellt. Der offene Betrag liegt bei 500 Euro.",
  ];

  test("fully grounded answer scores high and passes", () => {
    const answer =
      "Der Schuldner Max Mustermann hat einen offenen Betrag von 500 Euro. Der Mahnbescheid wurde am 1. Januar zugestellt.";
    const r = checkGroundedness(answer, sources);
    expect(r.noSources).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(r.passed).toBe(true);
    expect(r.unsupported).toHaveLength(0);
  });

  test("hallucinated claim is flagged as unsupported", () => {
    const answer =
      "Der Schuldner Max Mustermann hat einen offenen Betrag von 500 Euro. Das Gericht hat bereits einen Haftbefehl gegen den Geschäftsführer erlassen und das Konto in der Schweiz gepfändet.";
    const r = checkGroundedness(answer, sources);
    expect(r.unsupported.length).toBeGreaterThanOrEqual(1);
    expect(r.unsupported.some((u) => u.sentence.includes("Haftbefehl"))).toBe(
      true,
    );
    expect(r.score).toBeLessThan(1);
  });

  test("no sources → noSources flag, treated as pass", () => {
    const r = checkGroundedness("Anything goes here, totally made up.", []);
    expect(r.noSources).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("trivial sentences are skipped (below minContentTokens)", () => {
    const r = checkGroundedness("Sure, here you go.", sources);
    expect(r.checkedSentences).toBe(0);
    expect(r.passed).toBe(true);
  });

  test("threshold is configurable", () => {
    const answer =
      "Der Schuldner Max Mustermann hat einen offenen Betrag von 500 Euro.";
    const strict = checkGroundedness(answer, sources, { passThreshold: 1 });
    // With a single fully-grounded sentence the score should still be 1.
    expect(strict.score).toBe(1);
  });

  test("score equals grounded/checked ratio", () => {
    const answer =
      "Der Schuldner Max Mustermann schuldet 500 Euro. Der Mond besteht vollständig aus grünem Käse und Schokolade.";
    const r = checkGroundedness(answer, sources);
    expect(r.checkedSentences).toBe(2);
    expect(r.groundedSentences).toBe(1);
    expect(r.score).toBe(0.5);
  });
});

describe("createGroundednessGate", () => {
  const sources = ["The capital of France is Paris, a city on the Seine."];

  test("returns undefined when disabled", () => {
    expect(createGroundednessGate({ enabled: false })).toBeUndefined();
    expect(createGroundednessGate({})).toBeUndefined();
  });

  test("annotate mode reports without a footer", async () => {
    const gate = mustCreateGroundednessGate({
      enabled: true,
      mode: "annotate",
    });
    const report = await gate.evaluate(
      "The capital of France is Paris located on the Seine river.",
      sources,
    );
    expect(report.warningFooter).toBeUndefined();
    expect(report.passed).toBe(true);
  });

  test("block mode appends a warning footer on failure", async () => {
    const gate = mustCreateGroundednessGate({
      enabled: true,
      mode: "block",
      passThreshold: 0.9,
    });
    const report = await gate.evaluate(
      "The capital of France is Paris. Quantum entanglement powers the municipal trams through wormholes.",
      sources,
    );
    expect(report.passed).toBe(false);
    expect(report.warningFooter).toBeDefined();
    expect(report.warningFooter).toContain("Note");
  });

  test("block mode does not annotate a passing answer", async () => {
    const gate = mustCreateGroundednessGate({ enabled: true, mode: "block" });
    const report = await gate.evaluate(
      "Paris is the capital of France and sits on the Seine.",
      sources,
    );
    expect(report.passed).toBe(true);
    expect(report.warningFooter).toBeUndefined();
  });

  test("createGroundednessGate maps semantic options and executes check", async () => {
    const embedder = { embed: async () => [1, 0, 0] };
    const gate = mustCreateGroundednessGate({
      enabled: true,
      groundednessType: "semantic",
      embedder,
      minContentTokens: 2,
    });
    const report = await gate.evaluate("Paris is the capital of France.", [
      "Paris is capital",
    ]);
    expect(report.passed).toBe(true);
  });

  test("semantic gate falls back to lexical when embedder is missing", async () => {
    // No embedder injected — gate should warn and fall back to lexical scoring,
    // which is fully deterministic (no model calls).
    const gate = mustCreateGroundednessGate({
      enabled: true,
      groundednessType: "semantic",
      // embedder intentionally omitted
      minContentTokens: 2,
    });
    const report = await gate.evaluate("The capital of France is Paris.", [
      "Paris is the capital of France located on the Seine.",
    ]);
    // Lexical fallback: "capital France Paris" tokens appear in source → pass.
    expect(report.passed).toBe(true);
    expect(report.warningFooter).toBeUndefined();
  });

  test("llm gate falls back to lexical when llmModel is missing", async () => {
    const gate = mustCreateGroundednessGate({
      enabled: true,
      groundednessType: "llm",
      // llmModel intentionally omitted
      minContentTokens: 2,
    });
    const report = await gate.evaluate("The capital of France is Paris.", [
      "Paris is the capital of France.",
    ]);
    // Lexical fallback.
    expect(report.passed).toBe(true);
  });

  test("maxSourceChunks is forwarded from gate config", async () => {
    let embeddedCount = 0;
    const trackingEmbedder = {
      embed: async (_text: string) => {
        embeddedCount++;
        return [1, 0, 0];
      },
    };
    // Source has 5 sentences; maxSourceChunks=2 should only embed 2 chunks.
    const source =
      "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const gate = mustCreateGroundednessGate({
      enabled: true,
      groundednessType: "semantic",
      embedder: trackingEmbedder,
      maxSourceChunks: 2,
      minContentTokens: 1,
    });
    await gate.evaluate("Any answer.", [source]);
    // 2 source chunks + 1 answer sentence = 3 embeds.
    expect(embeddedCount).toBe(3);
  });
});

describe("checkGroundednessSemantic", () => {
  const makeFakeEmbedder = (embeddingsMap: Record<string, number[]>) => ({
    embed: async (text: string) => {
      for (const [key, vec] of Object.entries(embeddingsMap)) {
        if (text.includes(key)) return vec;
      }
      return [0, 0, 0];
    },
  });

  test("semantic check passes when cosine similarity is above threshold", async () => {
    // Vectors aligned (similarity 1.0)
    const embedder = makeFakeEmbedder({
      "Paris is the capital of France.": [1, 0, 0],
      "France capital Seine Paris": [1, 0, 0],
    });
    const r = await checkGroundednessSemantic(
      "Paris is the capital of France.",
      ["France capital Seine Paris"],
      embedder,
      { semanticThreshold: 0.8, minContentTokens: 2 },
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.unsupported).toHaveLength(0);
  });

  test("semantic check fails when cosine similarity is below threshold", async () => {
    // Vectors orthogonal (similarity 0.0)
    const embedder = makeFakeEmbedder({
      "Paris is the capital of France.": [1, 0, 0],
      "Quantum entanglement trams wormholes": [0, 1, 0],
    });
    const r = await checkGroundednessSemantic(
      "Paris is the capital of France.",
      ["Quantum entanglement trams wormholes"],
      embedder,
      { semanticThreshold: 0.8, minContentTokens: 2 },
    );
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.unsupported).toHaveLength(1);
  });

  test("source chunking: claim grounded by one sentence in a multi-sentence source", async () => {
    // Source is two sentences: one relevant, one irrelevant.
    // Without chunking, the whole-source embedding would be the centroid →
    // potentially misses the relevant sentence.
    // With chunking, each sentence is embedded independently and the best match wins.
    const embedder = makeFakeEmbedder({
      // answer sentence and matching source chunk share the same vector → sim 1.0
      Paris: [1, 0, 0],
      // irrelevant chunk
      Seine: [0, 1, 0],
    });
    const multiSentenceSource =
      "Paris is the capital of France. The Seine river flows through the city.";
    const r = await checkGroundednessSemantic(
      "Paris is the capital of France.",
      [multiSentenceSource],
      embedder,
      { semanticThreshold: 0.8, minContentTokens: 2 },
    );
    // Should pass: the relevant chunk has sim 1.0 with the answer sentence.
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  test("source chunking: claim not grounded when no chunk is similar", async () => {
    // Source has two orthogonal sentences; neither supports the answer sentence.
    const embedder = makeFakeEmbedder({
      "Berlin is the capital of Germany.": [1, 0, 0],
      "London is in the UK.": [0, 0, 1],
      "Rome is the capital of Italy.": [0, 0, 1],
    });
    const r = await checkGroundednessSemantic(
      "Berlin is the capital of Germany.",
      ["London is in the UK. Rome is the capital of Italy."],
      embedder,
      { semanticThreshold: 0.9, minContentTokens: 2 },
    );
    expect(r.passed).toBe(false);
    expect(r.unsupported).toHaveLength(1);
  });

  test("maxSourceChunks caps the number of embedded source sentences", async () => {
    const embeddedTexts: string[] = [];
    const trackingEmbedder = {
      embed: async (text: string) => {
        embeddedTexts.push(text);
        return [1, 0, 0];
      },
    };
    // Source with 10 distinct sentences.
    const source = Array.from(
      { length: 10 },
      (_, i) => `Sentence number ${i} in the source.`,
    ).join(" ");
    await checkGroundednessSemantic(
      "Answer sentence here.",
      [source],
      trackingEmbedder,
      { maxSourceChunks: 3, minContentTokens: 2 },
    );
    // Only 3 source chunks + 1 answer sentence should have been embedded.
    expect(embeddedTexts.length).toBe(4); // 3 source chunks + 1 answer sentence
  });

  test("falls back to whole source when it has no sentence breaks", async () => {
    const embeddedTexts: string[] = [];
    const trackingEmbedder = {
      embed: async (text: string) => {
        embeddedTexts.push(text);
        return [1, 0, 0];
      },
    };
    const singleChunkSource = "no terminal punctuation no sentence break";
    await checkGroundednessSemantic(
      "Answer here.",
      [singleChunkSource],
      trackingEmbedder,
      { minContentTokens: 1 },
    );
    // The whole source string should be embedded as one chunk.
    expect(embeddedTexts).toContain(singleChunkSource);
  });

  test("deduplicates identical source chunks across multiple sources", async () => {
    const embeddedTexts: string[] = [];
    const trackingEmbedder = {
      embed: async (text: string) => {
        embeddedTexts.push(text);
        return [1, 0, 0];
      },
    };
    const duplicateChunk = "Paris is the capital of France.";
    await checkGroundednessSemantic(
      "Answer here.",
      [duplicateChunk, duplicateChunk, duplicateChunk],
      trackingEmbedder,
      { minContentTokens: 1 },
    );
    // The same chunk should only be embedded once.
    const sourceEmbeds = embeddedTexts.filter((t) => t === duplicateChunk);
    expect(sourceEmbeds).toHaveLength(1);
  });
});

describe("checkGroundednessLlm", () => {
  function fakeJudgeModel(obj: {
    score: number;
    unsupportedClaims: string[];
    reasoning: string;
  }): import("ai").LanguageModel {
    return {
      specificationVersion: "v3",
      provider: "fake",
      modelId: "fake-judge",
      doGenerate: async () => {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(obj) }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        };
      },
      doStream: async () => {
        throw new Error("not used");
      },
    } as unknown as import("ai").LanguageModel;
  }

  test("llm check passes when judge score is above threshold", async () => {
    const model = fakeJudgeModel({
      score: 0.95,
      unsupportedClaims: [],
      reasoning: "Answer is fully grounded.",
    });
    const r = await checkGroundednessLlm(
      "Paris is the capital of France.",
      ["Paris is the capital of France."],
      model,
      { passThreshold: 0.7 },
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBe(0.95);
    expect(r.unsupported).toHaveLength(0);
  });

  test("llm check fails and reports unsupported claims when judge score is below threshold", async () => {
    const model = fakeJudgeModel({
      score: 0.2,
      unsupportedClaims: ["Quantum entanglement trams"],
      reasoning: "Quantum claim is not in source.",
    });
    const r = await checkGroundednessLlm(
      "Quantum entanglement trams.",
      ["Paris is capital of France."],
      model,
      { passThreshold: 0.7 },
    );
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.2);
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]?.sentence).toBe("Quantum entanglement trams");
  });

  test("propagates the caller's AbortSignal to the judge call (deadline binding regression)", async () => {
    let capturedOptions: { abortSignal?: AbortSignal } | undefined;
    const model = {
      specificationVersion: "v3",
      provider: "fake",
      modelId: "fake-judge",
      doGenerate: async (options: { abortSignal?: AbortSignal }) => {
        capturedOptions = options;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                score: 0.9,
                unsupportedClaims: [],
                reasoning: "ok",
              }),
            },
          ],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
      doStream: async () => {
        throw new Error("not used");
      },
    } as unknown as import("ai").LanguageModel;

    const controller = new AbortController();
    await checkGroundednessLlm(
      "Paris is the capital of France.",
      ["Paris is the capital of France."],
      model,
      { passThreshold: 0.7 },
      controller.signal,
    );
    expect(capturedOptions?.abortSignal).toBe(controller.signal);
  });
});
