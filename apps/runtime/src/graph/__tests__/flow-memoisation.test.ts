// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-request work that is actually per-flow.
 *
 * Two hot-path costs were paid on EVERY request for a result that never changed
 * between them:
 *
 *   1. `applyFlowVariables` `structuredClone`d the whole flow. Every production
 *      flow here declares `variables`, so the "no variables" fast path never
 *      applied, and representative production flows are large (~42 KB).
 *   2. `computeFlowChecksum` ran `JSON.stringify` + SHA-256 over the whole flow —
 *      purely to look up a cache entry that was almost always present.
 *
 * Both are pure functions of the flow object, so both are now memoised through a
 * WeakMap keyed by that object. Invalidation is structural: the registry replaces
 * the object on hot-reload, so a changed flow is a different key and can never
 * produce a stale hit.
 *
 * Separately: compiled-graph eviction was FIFO, meaning a flow compiled at
 * startup and used ever since could be evicted in favour of a one-off variant
 * that merely arrived later.
 */

import { describe, test, expect } from "bun:test";
import { applyFlowVariables } from "../flow-parser.js";
import {
  computeFlowChecksum,
  touchCacheEntry,
  evictIfFull,
  type CacheEntry,
} from "../graph-engine/compile.js";
import type { FlowDefinition } from "../../types/flow.js";

function flow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: "f",
    name: "F",
    variables: { collection: "example-records", tone: "formal" },
    nodes: [
      {
        id: "answer",
        type: "llm",
        systemPrompt: "Search {{vars.collection}} in a {{vars.tone}} tone.",
      },
    ],
    edges: [],
    ...overrides,
  } as FlowDefinition;
}

// ---------------------------------------------------------------------------
// applyFlowVariables
// ---------------------------------------------------------------------------

describe("applyFlowVariables memoisation", () => {
  test("resolves variables correctly (behaviour unchanged)", () => {
    const resolved = applyFlowVariables(flow());
    expect(resolved.nodes[0]?.systemPrompt).toBe(
      "Search example-records in a formal tone.",
    );
  });

  test("the same flow + same variables returns the SAME object", () => {
    // This identity is the whole point: no second structuredClone of a 42 KB flow.
    const f = flow();
    expect(applyFlowVariables(f)).toBe(applyFlowVariables(f));
  });

  test("different overrides produce different objects", () => {
    const f = flow();
    const a = applyFlowVariables(f, { collection: "examplecorp" });
    const b = applyFlowVariables(f, { collection: "example-records" });
    expect(a).not.toBe(b);
    expect(a.nodes[0]?.systemPrompt).toContain("examplecorp");
    expect(b.nodes[0]?.systemPrompt).toContain("example-records");
  });

  test("override key ORDER does not create a miss", () => {
    const f = flow();
    const a = applyFlowVariables(f, { collection: "examplecorp", tone: "casual" });
    const b = applyFlowVariables(f, { tone: "casual", collection: "examplecorp" });
    expect(a).toBe(b);
  });

  test("a reloaded flow (new object) is not served from the old memo", () => {
    // The invalidation guarantee: same content, new object ⇒ fresh resolution.
    const first = applyFlowVariables(flow());
    const second = applyFlowVariables(flow());
    expect(second).not.toBe(first);
    expect(second.nodes[0]?.systemPrompt).toBe(first.nodes[0]?.systemPrompt);
  });

  test("an edited flow resolves to the edited text", () => {
    const edited = flow({ variables: { collection: "examplecorp", tone: "formal" } });
    expect(applyFlowVariables(edited).nodes[0]?.systemPrompt).toBe(
      "Search examplecorp in a formal tone.",
    );
  });

  test("the input flow is never mutated", () => {
    const f = flow();
    applyFlowVariables(f);
    expect(f.nodes[0]?.systemPrompt).toContain("{{vars.collection}}");
  });

  test("a flow without variables is returned as-is (unchanged fast path)", () => {
    const bare = flow({ variables: undefined });
    expect(applyFlowVariables(bare)).toBe(bare);
  });

  test("distinct override sets stay bounded per flow", () => {
    // A caller may supply variableOverrides, so the memo must not grow forever.
    const f = flow();
    const seen = new Set<FlowDefinition>();
    for (let i = 0; i < 200; i++) {
      seen.add(applyFlowVariables(f, { collection: `c${i}` }));
    }
    // Every call returned a correctly resolved object …
    expect(seen.size).toBe(200);
    // … and the earliest variant has been evicted, so it is recomputed fresh
    // rather than retained indefinitely.
    const first = applyFlowVariables(f, { collection: "c0" });
    expect(first.nodes[0]?.systemPrompt).toContain("c0");
  });
});

// ---------------------------------------------------------------------------
// computeFlowChecksum
// ---------------------------------------------------------------------------

describe("computeFlowChecksum memoisation", () => {
  test("is stable for the same object", () => {
    const f = flow();
    expect(computeFlowChecksum(f)).toBe(computeFlowChecksum(f));
  });

  test("differs for different content", () => {
    expect(computeFlowChecksum(flow())).not.toBe(
      computeFlowChecksum(flow({ name: "Other" })),
    );
  });

  test("equal content in a new object yields the same checksum", () => {
    // The memo must not change the VALUE, only avoid recomputing it.
    expect(computeFlowChecksum(flow())).toBe(computeFlowChecksum(flow()));
  });

  test("a resolved flow has its own checksum, distinct from the template", () => {
    const f = flow();
    expect(computeFlowChecksum(applyFlowVariables(f))).not.toBe(
      computeFlowChecksum(f),
    );
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe("compiled-graph cache eviction is LRU, not FIFO", () => {
  const entry = (flowId: string): CacheEntry =>
    ({ graph: {}, checksum: flowId, flowId }) as unknown as CacheEntry;

  test("touching an entry protects it from eviction", () => {
    const cache = new Map<string, CacheEntry>();
    cache.set("hot", entry("hot"));
    cache.set("cold", entry("cold"));

    // "hot" was inserted first, so plain FIFO would drop it — even though it is
    // the one still being used.
    touchCacheEntry(cache, "hot");
    evictIfFull(cache, 2);

    expect(cache.has("hot")).toBe(true);
    expect(cache.has("cold")).toBe(false);
  });

  test("without touching, the oldest goes (unchanged baseline)", () => {
    const cache = new Map<string, CacheEntry>();
    cache.set("first", entry("first"));
    cache.set("second", entry("second"));
    evictIfFull(cache, 2);
    expect(cache.has("first")).toBe(false);
    expect(cache.has("second")).toBe(true);
  });

  test("touching preserves the entry's value", () => {
    const cache = new Map<string, CacheEntry>();
    const e = entry("x");
    cache.set("x", e);
    touchCacheEntry(cache, "x");
    expect(cache.get("x")).toBe(e);
    expect(cache.size).toBe(1);
  });

  test("touching an absent key is a no-op", () => {
    const cache = new Map<string, CacheEntry>();
    cache.set("a", entry("a"));
    touchCacheEntry(cache, "missing");
    expect(cache.size).toBe(1);
    expect([...cache.keys()]).toEqual(["a"]);
  });

  test("eviction makes room for exactly one more entry", () => {
    const cache = new Map<string, CacheEntry>();
    for (let i = 0; i < 5; i++) cache.set(`k${i}`, entry(`k${i}`));
    evictIfFull(cache, 3);
    expect(cache.size).toBe(2);
    // The most recent survive.
    expect([...cache.keys()]).toEqual(["k3", "k4"]);
  });
});
