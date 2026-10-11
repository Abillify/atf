// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the extensible PII detector pipeline (`src/graph/pii-detector.ts`)
 * and its detector adapters (regex, remote) plus the per-flow resolver.
 *
 * NER's deterministic token→span logic (`nerTokensToMatches`: BIO aggregation +
 * offset reconstruction) IS unit-tested here without a model. Real-model
 * inference is validated separately by `scripts/ner-smoke.ts` (the native
 * `@huggingface/transformers` backend crashes Bun's test runner).
 */

import { describe, it, expect } from "bun:test";
import {
  PiiDetectorRegistry,
  PiiDetectionError,
  FlowPiiDetectorResolver,
  mergeDetectorMatches,
  type PiiDetector,
} from "../pii-detector.js";
import { RegexPiiDetector } from "../pii-detector-regex.js";
import { RemotePiiDetector } from "../pii-detector-remote.js";
import { nerTokensToMatches } from "../pii-detector-ner.js";
import type { PiiMatch, PiiType } from "../output-guardrails.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A detector that returns a fixed span list, or throws when `fail` is set. */
class FakeDetector implements PiiDetector {
  constructor(
    readonly name: string,
    readonly priority: number,
    private readonly behavior:
      | { matches: PiiMatch[] }
      | { throws: string }
      | { hangMs: number },
  ) {}

  async detect(): Promise<PiiMatch[]> {
    if ("throws" in this.behavior) {
      throw new Error(this.behavior.throws);
    }
    if ("hangMs" in this.behavior) {
      const ms = this.behavior.hangMs;
      await new Promise((r) => setTimeout(r, ms));
      return [];
    }
    return this.behavior.matches;
  }
}

const span = (
  type: PiiType,
  value: string,
  start: number,
  end: number,
): PiiMatch => ({ type, value, start, end });

// ---------------------------------------------------------------------------
// RegexPiiDetector
// ---------------------------------------------------------------------------

describe("RegexPiiDetector", () => {
  it("detects structured PII via the shared regex engine", async () => {
    const d = new RegexPiiDetector();
    const matches = await d.detect("mail jane@example.com now");
    expect(matches).toHaveLength(1);
    const firstMatch = matches[0];
    if (firstMatch === undefined) throw new Error("expected a first match");
    expect(firstMatch.type).toBe("email");
    expect(firstMatch.value).toBe("jane@example.com");
  });

  it("has the highest trust priority (10)", () => {
    expect(new RegexPiiDetector().priority).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// mergeDetectorMatches — priority-based overlap resolution
// ---------------------------------------------------------------------------

describe("mergeDetectorMatches", () => {
  it("keeps non-overlapping spans from all detectors, sorted by start", () => {
    const merged = mergeDetectorMatches([
      { detector: "ner", priority: 20, matches: [span("person", "Anna", 0, 4)] },
      { detector: "regex", priority: 10, matches: [span("email", "a@b.com", 10, 17)] },
    ]);
    expect(merged.map((m) => m.value)).toEqual(["Anna", "a@b.com"]);
    const [first, second] = merged;
    if (first === undefined || second === undefined) {
      throw new Error("expected two merged matches");
    }
    expect(first.detector).toBe("ner");
    expect(second.detector).toBe("regex");
  });

  it("resolves overlaps in favor of the lower-priority-number (higher-trust) detector", () => {
    // Regex (10) and NER (20) both claim overlapping spans → regex wins.
    const merged = mergeDetectorMatches([
      { detector: "ner", priority: 20, matches: [span("person", "Jane Doe", 0, 8)] },
      { detector: "regex", priority: 10, matches: [span("email", "jane@doe", 3, 11)] },
    ]);
    expect(merged).toHaveLength(1);
    const firstMerged = merged[0];
    if (firstMerged === undefined) throw new Error("expected a first merged match");
    expect(firstMerged.detector).toBe("regex");
  });
});

// ---------------------------------------------------------------------------
// PiiDetectorRegistry
// ---------------------------------------------------------------------------

describe("PiiDetectorRegistry", () => {
  it("returns [] for an empty registry (no detectors → no tokenization)", async () => {
    const reg = new PiiDetectorRegistry();
    expect(reg.size()).toBe(0);
    expect(await reg.detect("jane@example.com")).toEqual([]);
  });

  it("merges results from multiple detectors with provenance", async () => {
    const reg = new PiiDetectorRegistry()
      .add(new FakeDetector("regex", 10, { matches: [span("email", "a@b.com", 5, 12)] }))
      .add(new FakeDetector("ner", 20, { matches: [span("person", "Bob", 0, 3)] }));
    const matches = await reg.detect("Bob: a@b.com");
    expect(matches.map((m) => m.detector)).toEqual(["ner", "regex"]);
  });

  it("fail-open (default): skips a throwing detector and returns the rest", async () => {
    const reg = new PiiDetectorRegistry({ failMode: "open" })
      .add(new FakeDetector("regex", 10, { matches: [span("email", "a@b.com", 0, 7)] }))
      .add(new FakeDetector("ner", 20, { throws: "model down" }));
    const matches = await reg.detect("a@b.com");
    expect(matches).toHaveLength(1);
    const firstMatch = matches[0];
    if (firstMatch === undefined) throw new Error("expected a first match");
    expect(firstMatch.detector).toBe("regex");
  });

  it("fail-closed: throws PiiDetectionError when a detector fails", async () => {
    const reg = new PiiDetectorRegistry({ failMode: "closed" })
      .add(new FakeDetector("regex", 10, { matches: [] }))
      .add(new FakeDetector("ner", 20, { throws: "model down" }));
    await expect(reg.detect("anything")).rejects.toBeInstanceOf(PiiDetectionError);
  });

  it("fail-closed lists the failed detector names on the error", async () => {
    const reg = new PiiDetectorRegistry({ failMode: "closed" }).add(
      new FakeDetector("remote:presidio", 30, { throws: "503" }),
    );
    try {
      await reg.detect("x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PiiDetectionError);
      expect((err as PiiDetectionError).failedDetectors).toContain("remote:presidio");
    }
  });

  it("enforces the per-detector timeout (fail-open skips the slow detector)", async () => {
    const reg = new PiiDetectorRegistry({ failMode: "open", timeoutMs: 20 })
      .add(new FakeDetector("regex", 10, { matches: [span("email", "a@b.com", 0, 7)] }))
      .add(new FakeDetector("slow", 20, { hangMs: 1000 }));
    const matches = await reg.detect("a@b.com");
    expect(matches).toHaveLength(1);
    const firstMatch = matches[0];
    if (firstMatch === undefined) throw new Error("expected a first match");
    expect(firstMatch.detector).toBe("regex");
  });
});

// ---------------------------------------------------------------------------
// BertNerDetector — token aggregation + offset reconstruction (pure, no model)
// ---------------------------------------------------------------------------

/** Builds a transformers.js-shaped token (start/end are null in reality). */
const tok = (entity: string, word: string, score = 0.99) => ({
  entity,
  word,
  score,
  index: 0,
  start: null as number | null,
  end: null as number | null,
});

describe("nerTokensToMatches (BIO aggregation + offset reconstruction)", () => {
  it("aggregates B-/I- tokens of the same type into one span with correct offsets", () => {
    const text = "My name is Sarah Connor and I live in Berlin";
    const tokens = [
      tok("B-PER", "Sarah"),
      tok("I-PER", "Connor"),
      tok("B-LOC", "Berlin"),
    ];
    const matches = nerTokensToMatches(tokens, text, 0.5);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ type: "person", value: "Sarah Connor" });
    const firstMatch = matches[0];
    if (firstMatch === undefined) throw new Error("expected a first match");
    expect(text.slice(firstMatch.start, firstMatch.end)).toBe("Sarah Connor");
    expect(matches[1]).toMatchObject({ type: "location", value: "Berlin" });
  });

  it("merges '##' subword continuations into a single word span", () => {
    const text = "Kontakt Zing hilft";
    // Synthetic token "Zing" tokenized as "Z" + "##ing"
    const tokens = [tok("B-ORG", "Z"), tok("I-ORG", "##ing")];
    const matches = nerTokensToMatches(tokens, text, 0.5);
    expect(matches).toHaveLength(1);
    const firstMatch = matches[0];
    if (firstMatch === undefined) throw new Error("expected a first match");
    expect(firstMatch.value).toBe("Zing");
    expect(text.slice(firstMatch.start, firstMatch.end)).toBe("Zing");
  });

  it("drops tokens below the confidence threshold", () => {
    const text = "Herr Müller ruft an";
    const tokens = [tok("B-PER", "Müller", 0.4)];
    expect(nerTokensToMatches(tokens, text, 0.75)).toHaveLength(0);
  });

  it("respects a PII type subset (locations only)", () => {
    const text = "Sarah wohnt in Berlin";
    const tokens = [tok("B-PER", "Sarah"), tok("B-LOC", "Berlin")];
    const matches = nerTokensToMatches(tokens, text, 0.5, ["location"]);
    expect(matches).toHaveLength(1);
    const firstMatch = matches[0];
    if (firstMatch === undefined) throw new Error("expected a first match");
    expect(firstMatch.type).toBe("location");
  });

  it("ignores non-PII entity types (e.g. MISC)", () => {
    const text = "Das Modell ist ein BERT";
    const tokens = [tok("B-MISC", "BERT")];
    expect(nerTokensToMatches(tokens, text, 0.5)).toHaveLength(0);
  });

  it("drops an entity whose word cannot be located in the text (no bogus span)", () => {
    const text = "nothing matching here";
    const tokens = [tok("B-PER", "Zaphod")];
    expect(nerTokensToMatches(tokens, text, 0.5)).toHaveLength(0);
  });

  it("locates repeated entities left-to-right via a forward cursor", () => {
    const text = "Berlin and Berlin again";
    const tokens = [tok("B-LOC", "Berlin"), tok("B-LOC", "Berlin")];
    const matches = nerTokensToMatches(tokens, text, 0.5);
    expect(matches).toHaveLength(2);
    const [first, second] = matches;
    if (first === undefined || second === undefined) {
      throw new Error("expected two matches");
    }
    expect(first.start).toBe(0);
    expect(second.start).toBe(11); // the SECOND "Berlin", not the first again
  });
});

// ---------------------------------------------------------------------------
// FlowPiiDetectorResolver
// ---------------------------------------------------------------------------

describe("FlowPiiDetectorResolver", () => {
  const factory = (names: readonly string[]): PiiDetectorRegistry => {
    const reg = new PiiDetectorRegistry();
    for (const n of names) reg.add(new FakeDetector(n, 10, { matches: [] }));
    return reg;
  };

  it("returns undefined when neither a per-flow nor a global set is configured", () => {
    const resolver = new FlowPiiDetectorResolver({
      factory,
      flowLookup: () => undefined,
    });
    expect(resolver.resolve("any-flow")).toBeUndefined();
  });

  it("falls back to the global detector set when a flow has no override", () => {
    const resolver = new FlowPiiDetectorResolver({
      factory,
      globalNames: ["regex", "ner"],
      flowLookup: () => undefined,
    });
    const plan = resolver.resolve("some-flow");
    expect(plan?.registry.listDetectors()).toEqual(["regex", "ner"]);
    expect(plan?.piiTypes).toBeUndefined(); // no per-flow type override
  });

  it("uses the per-flow override in preference to the global set", () => {
    const resolver = new FlowPiiDetectorResolver({
      factory,
      globalNames: ["regex"],
      flowLookup: (id) => (id === "support" ? ["regex", "ner", "remote"] : undefined),
    });
    expect(resolver.resolve("support")?.registry.listDetectors()).toEqual([
      "regex",
      "ner",
      "remote",
    ]);
    expect(resolver.resolve("other")?.registry.listDetectors()).toEqual(["regex"]);
  });

  it("treats an explicit empty per-flow list as 'disable tokenization' (empty registry)", () => {
    const resolver = new FlowPiiDetectorResolver({
      factory,
      globalNames: ["regex", "ner"],
      flowLookup: (id) => (id === "internal" ? [] : undefined),
    });
    const plan = resolver.resolve("internal");
    expect(plan).toBeDefined();
    if (plan === undefined) throw new Error("expected a plan");
    expect(plan.registry.size()).toBe(0); // no detectors → tokenizes nothing
  });

  it("carries a per-flow PII type subset in the plan, dropping unknown type names", () => {
    const resolver = new FlowPiiDetectorResolver({
      factory,
      globalNames: ["regex", "ner"],
      flowLookup: () => undefined,
      flowTypesLookup: (id) =>
        id === "support" ? ["location", "iban", "bogus-type"] : undefined,
    });
    const plan = resolver.resolve("support");
    expect(plan?.piiTypes).toEqual(["location", "iban"]); // "bogus-type" dropped
    // A flow without a type override inherits the vault global (undefined here).
    expect(resolver.resolve("other")?.piiTypes).toBeUndefined();
  });

  it("memoises a registry per detector-set within a generation, and rebuilds after a bump", () => {
    let gen = 0;
    const resolver = new FlowPiiDetectorResolver({
      factory,
      flowLookup: () => ["regex"],
      generation: () => gen,
    });
    const first = resolver.resolve("f");
    if (first === undefined) throw new Error("expected a first plan");
    // Same generation + same detector-set → the same cached REGISTRY instance
    // (the plan wrapper itself is built fresh each call).
    const again = resolver.resolve("f");
    if (again === undefined) throw new Error("expected a plan on re-resolve");
    expect(again.registry).toBe(first.registry);
    // Bumping the generation clears the cache → a fresh registry is built.
    gen = 1;
    const afterBump = resolver.resolve("f");
    if (afterBump === undefined) throw new Error("expected a plan after bump");
    expect(afterBump.registry).not.toBe(first.registry);
    expect(afterBump.registry.listDetectors()).toEqual(["regex"]);
  });
});

// ---------------------------------------------------------------------------
// RemotePiiDetector (mocked fetch)
// ---------------------------------------------------------------------------

describe("RemotePiiDetector", () => {
  const withMockedFetch = async (
    impl: typeof fetch,
    fn: (d: RemotePiiDetector) => Promise<void>,
    detectorOpts?: Partial<{ circuitBreakerThreshold: number }>,
  ): Promise<void> => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const d = new RemotePiiDetector({
        endpoint: "http://pii.internal/detect",
        circuitBreakerThreshold: detectorOpts?.circuitBreakerThreshold ?? 5,
        // Req 7.2: the detector now goes through an injectable fetch seam —
        // the stub is wired directly instead of via globalThis.
        fetchFn: impl,
      });
      await fn(d);
    } finally {
      globalThis.fetch = original;
    }
  };

  it("maps a successful response into PiiMatch spans", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          matches: [{ type: "person", value: "Anna", start: 0, end: 4 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await withMockedFetch(mockFetch, async (d) => {
      const matches = await d.detect("Anna went home");
      expect(matches).toHaveLength(1);
      const firstMatch = matches[0];
      if (firstMatch === undefined) throw new Error("expected a first match");
      expect(firstMatch.type).toBe("person");
      expect(firstMatch.value).toBe("Anna");
    });
  });

  it("drops spans with out-of-range or inverted offsets (untrusted response)", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          matches: [
            { type: "person", value: "ok", start: 0, end: 4 }, // valid → "Anna"
            { type: "person", value: "bad", start: 10, end: 4 }, // inverted → drop
            { type: "person", value: "oob", start: 0, end: 9999 }, // out of range → drop
            { type: "person", value: "neg", start: -1, end: 3 }, // negative → drop
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await withMockedFetch(mockFetch, async (d) => {
      const matches = await d.detect("Anna went home");
      expect(matches).toHaveLength(1);
      const firstMatch = matches[0];
      if (firstMatch === undefined) throw new Error("expected a first match");
      expect(firstMatch.start).toBe(0);
      expect(firstMatch.end).toBe(4);
    });
  });

  it("stores the actual sliced text as the value (ignores a mismatched reported value)", async () => {
    // Service reports value="ANNA" (normalized), but the real text is "Anna".
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          matches: [{ type: "person", value: "ANNA", start: 0, end: 4 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await withMockedFetch(mockFetch, async (d) => {
      const matches = await d.detect("Anna went home");
      const firstMatch = matches[0];
      if (firstMatch === undefined) throw new Error("expected a first match");
      expect(firstMatch.value).toBe("Anna"); // sliced from text, not the reported "ANNA"
    });
  });

  it("throws on a non-2xx response (so the registry fail-mode governs it)", async () => {
    const mockFetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await withMockedFetch(mockFetch, async (d) => {
      await expect(d.detect("x")).rejects.toThrow();
    });
  });

  it("opens the circuit after repeated failures and then throws fast", async () => {
    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await withMockedFetch(
      mockFetch,
      async (d) => {
        // Threshold is 2 → two real attempts open the circuit.
        await expect(d.detect("a")).rejects.toThrow();
        await expect(d.detect("b")).rejects.toThrow();
        const callsBeforeOpen = calls;
        // Circuit now open → throws without another network call.
        await expect(d.detect("c")).rejects.toThrow(/circuit open/i);
        expect(calls).toBe(callsBeforeOpen);
      },
      { circuitBreakerThreshold: 2 },
    );
  });
});
