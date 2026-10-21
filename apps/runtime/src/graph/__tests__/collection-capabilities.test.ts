// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  CollectionCapabilityCache,
  NAVIGATION_TOOL_CAPABILITY,
  parseCollectionStats,
  shouldHideTool,
} from "../collection-capabilities.js";

/** Realistic `collection_stats` answer shape from apps/search. */
const STATS_JSON = JSON.stringify({
  collection: "vertragsakte",
  totalDocs: 120,
  totalChunks: 4310,
  pathPrefix: "",
  capabilities: {
    unitRows: true,
    unitGraph: false,
    outline: true,
    pages: false,
  },
});

describe("parseCollectionStats", () => {
  test("reads capabilities from the JSON root", () => {
    expect(parseCollectionStats(STATS_JSON)).toEqual({
      unitGraph: false,
      outline: true,
      pages: false,
    });
  });

  test("reads capabilities nested under result", () => {
    expect(
      parseCollectionStats(
        JSON.stringify({
          result: {
            capabilities: { unitGraph: true, outline: true, pages: true },
          },
        }),
      ),
    ).toEqual({ unitGraph: true, outline: true, pages: true });
  });

  test("returns undefined for non-JSON, missing or malformed capabilities", () => {
    expect(parseCollectionStats("not json")).toBeUndefined();
    expect(
      parseCollectionStats(JSON.stringify({ collection: "x" })),
    ).toBeUndefined();
    expect(
      parseCollectionStats(
        JSON.stringify({
          capabilities: { unitGraph: "yes", outline: true, pages: true },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("CollectionCapabilityCache", () => {
  test("serves a hit within the TTL without refetching", async () => {
    let nowMs = 1_000;
    const cache = new CollectionCapabilityCache({
      ttlMs: 300_000,
      now: () => nowMs,
    });
    let calls = 0;
    const fetchStats = async () => {
      calls++;
      return STATS_JSON;
    };
    const first = await cache.get("search", "a", fetchStats);
    nowMs += 299_000;
    const second = await cache.get("search", "a", fetchStats);
    expect(first).toEqual({ unitGraph: false, outline: true, pages: false });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test("refetches after the TTL expires", async () => {
    let nowMs = 1_000;
    const cache = new CollectionCapabilityCache({
      ttlMs: 1_000,
      now: () => nowMs,
    });
    let calls = 0;
    const fetchStats = async () => {
      calls++;
      return STATS_JSON;
    };
    await cache.get("search", "a", fetchStats);
    nowMs += 1_001;
    await cache.get("search", "a", fetchStats);
    expect(calls).toBe(2);
  });

  test("caches failures negatively and does not refetch within the negative TTL", async () => {
    let nowMs = 1_000;
    const cache = new CollectionCapabilityCache({
      ttlMs: 300_000,
      negativeTtlMs: 30_000,
      now: () => nowMs,
    });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("search unreachable");
    };
    expect(await cache.get("search", "a", failing)).toBeUndefined();
    nowMs += 29_000;
    expect(await cache.get("search", "a", failing)).toBeUndefined();
    expect(calls).toBe(1);
    nowMs += 2_000;
    expect(await cache.get("search", "a", failing)).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("caches unparseable answers negatively", async () => {
    const cache = new CollectionCapabilityCache({ ttlMs: 300_000 });
    let calls = 0;
    const garbage = async () => {
      calls++;
      return "<html>502 bad gateway</html>";
    };
    expect(await cache.get("search", "a", garbage)).toBeUndefined();
    expect(await cache.get("search", "a", garbage)).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("deduplicates concurrent fetches for the same key", async () => {
    const cache = new CollectionCapabilityCache({ ttlMs: 300_000 });
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return STATS_JSON;
    };
    const [one, two] = await Promise.all([
      cache.get("search", "a", slow),
      cache.get("search", "a", slow),
    ]);
    expect(one).toEqual(two);
    expect(calls).toBe(1);
  });

  test("keys are per server and collection", async () => {
    const cache = new CollectionCapabilityCache({ ttlMs: 300_000 });
    let calls = 0;
    const fetchStats = async () => {
      calls++;
      return STATS_JSON;
    };
    await cache.get("search", "a", fetchStats);
    await cache.get("search", "b", fetchStats);
    await cache.get("other", "a", fetchStats);
    expect(calls).toBe(3);
  });
});

describe("shouldHideTool", () => {
  const caps = { unitGraph: true, outline: true, pages: false };

  test("hides a tool whose capability the collection lacks", () => {
    expect(shouldHideTool("get_pages", caps)).toBe("pages");
    expect(
      shouldHideTool("get_outline", {
        unitGraph: true,
        outline: false,
        pages: true,
      }),
    ).toBe("outline");
    expect(
      shouldHideTool("follow_ref", {
        unitGraph: false,
        outline: true,
        pages: true,
      }),
    ).toBe("unitGraph");
  });

  test("keeps tools the collection can serve", () => {
    expect(
      shouldHideTool("get_pages", {
        unitGraph: true,
        outline: true,
        pages: true,
      }),
    ).toBeUndefined();
  });

  test("fail-open for unmapped tools and missing capabilities", () => {
    expect(shouldHideTool("search", caps)).toBeUndefined();
    expect(shouldHideTool("get_pages", undefined)).toBeUndefined();
  });

  test("mapping matches the fixed table", () => {
    expect(NAVIGATION_TOOL_CAPABILITY).toEqual({
      get_outline: "outline",
      get_section: "outline",
      get_pages: "pages",
      get_context: "unitGraph",
      follow_ref: "unitGraph",
    });
  });
});
