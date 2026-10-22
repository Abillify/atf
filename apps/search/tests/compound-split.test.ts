// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Query-side compound splitting (FTS_COMPOUND_SPLIT): the pure split
 * function, the lexicon cache lifecycle, and the query-builder wiring that
 * adds split parts to the lexical OR list only (never the AND list).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../src/query-builder.js";
import {
  compoundPartsForQuery,
  splitCompound,
} from "../src/compound-split.js";
import {
  createFtsLexiconCache,
  LEXICON_FAILURE_COOLDOWN_MS,
  LEXICON_TTL_MS,
  loadLexicon,
} from "../src/fts-lexicon-cache.js";
import { buildFtsQuery, buildHybridQuery } from "../src/query-builder.js";

const serviceScope: AccessScope = {
  principal: {
    userId: undefined,
    userGroups: undefined,
    tenantId: "tenant-a",
    source: "service",
  },
  userId: undefined,
  userGroups: [],
  tenantId: "tenant-a",
  scopes: [],
  service: true,
};

describe("splitCompound", () => {
  const lexicon = new Set(["arbeitsplatz", "kommission", "lager"]);

  it("splits a long compound into its lexicon parts", () => {
    expect(splitCompound("kommissionierarbeitsplatz", lexicon)).toEqual([
      "kommission",
      "arbeitsplatz",
    ]);
  });

  it("accepts a short Flexionsendung on a part", () => {
    // "arbeit" + trailing-s shortening of "arbeits"; "platz" exact.
    expect(splitCompound("arbeitsplatz", new Set(["arbeit", "platz"]))).toEqual(
      ["arbeit", "platz"],
    );
  });

  it("does not split when a side would be shorter than four characters", () => {
    // The only plausible cut leaves "kommissionier" / "arbeitsplat" — the
    // right side matches no lexeme within three chars of suffix.
    expect(splitCompound("kommissionierarbeitsplat", lexicon)).toEqual([]);
  });

  it("does not split umlaut forms below the minimum part length", () => {
    expect(splitCompound("lagerplätze", lexicon)).toEqual([]);
  });

  it("returns no parts for a token with no lexicon anchor", () => {
    expect(splitCompound("xyzlagerplatz", new Set(["lager", "platz"]))).toEqual(
      [],
    );
  });

  it("prefers the smallest valid cut point", () => {
    // A spurious shorter anchor must not win over the real compound boundary.
    const noisy = new Set([
      "kommission",
      "arbeitsplatz",
      "arbeit",
      "splatz",
    ]);
    expect(splitCompound("kommissionierarbeitsplatz", noisy)).toEqual([
      "kommission",
      "arbeitsplatz",
    ]);
  });

  it("ignores tokens shorter than the minimum length", () => {
    expect(splitCompound("arbeitspl", new Set(["arbeit", "platz"]))).toEqual(
      [],
    );
  });
});

describe("compoundPartsForQuery", () => {
  const lexicon = new Set(["arbeitsplatz", "kommission", "lager"]);

  it("splits every long token and de-duplicates the parts", () => {
    expect(
      compoundPartsForQuery(
        "Kommissionierarbeitsplatz kommissionierarbeitsplatz",
        lexicon,
      ),
    ).toEqual(["kommission", "arbeitsplatz"]);
  });

  it("does not repeat parts already present as query tokens", () => {
    expect(
      compoundPartsForQuery("Kommissionierarbeitsplatz Kommission", lexicon),
    ).toEqual(["kommission", "arbeitsplatz"]);
  });

  it("returns an empty list when no token is long enough", () => {
    expect(compoundPartsForQuery("lager platz", lexicon)).toEqual([]);
  });
});

describe("loadLexicon", () => {
  it("queries ts_stat and collects the words", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ word: "arbeitsplatz" }, { word: "kommission" }],
      })),
    };
    const words = await loadLexicon(
      pool as unknown as Parameters<typeof loadLexicon>[0],
      "vc_docs",
    );
    expect(words).toEqual(new Set(["arbeitsplatz", "kommission"]));
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('ts_stat(\'SELECT ts_search FROM "vc_docs"\')');
    expect(sql).toContain("ndoc >= 2");
  });
});

describe("createFtsLexiconCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakePool(words: string[]) {
    return {
      query: vi.fn(async () => ({ rows: words.map((word) => ({ word })) })),
    };
  }

  function fakeLogger() {
    return { warn: vi.fn() } as unknown as Parameters<
      typeof createFtsLexiconCache
    >[1];
  }

  it("returns undefined on a miss and builds in the background", async () => {
    vi.useFakeTimers();
    const pool = fakePool(["arbeitsplatz"]);
    const cache = createFtsLexiconCache(
      pool as unknown as Parameters<typeof createFtsLexiconCache>[0],
      fakeLogger(),
    );
    expect(cache.get("vc_docs")).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(cache.get("vc_docs")).toBeDefined());
    expect(cache.get("vc_docs")).toEqual(new Set(["arbeitsplatz"]));
    // A second get() is a cache hit and must not re-query.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent builds for the same table", async () => {
    vi.useFakeTimers();
    const pool = fakePool(["arbeitsplatz"]);
    const cache = createFtsLexiconCache(
      pool as unknown as Parameters<typeof createFtsLexiconCache>[0],
      fakeLogger(),
    );
    expect(cache.get("vc_docs")).toBeUndefined();
    expect(cache.get("vc_docs")).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("disables a table for the cooldown after a failed build", async () => {
    vi.useFakeTimers();
    const logger = fakeLogger();
    const pool = {
      query: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const cache = createFtsLexiconCache(
      pool as unknown as Parameters<typeof createFtsLexiconCache>[0],
      logger,
    );
    expect(cache.get("vc_docs")).toBeUndefined();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    // During the cooldown no new build starts.
    expect(cache.get("vc_docs")).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
    // After the cooldown the build is retried.
    vi.advanceTimersByTime(LEXICON_FAILURE_COOLDOWN_MS + 1);
    expect(cache.get("vc_docs")).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("expires an entry after the TTL", async () => {
    vi.useFakeTimers();
    const pool = fakePool(["arbeitsplatz"]);
    const cache = createFtsLexiconCache(
      pool as unknown as Parameters<typeof createFtsLexiconCache>[0],
      fakeLogger(),
    );
    cache.get("vc_docs");
    await vi.waitFor(() => expect(cache.get("vc_docs")).toBeDefined());
    expect(pool.query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LEXICON_TTL_MS + 1);
    expect(cache.get("vc_docs")).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe("query-builder wiring (compoundTerms → OR list only)", () => {
  const compoundTerms = ["kommission", "arbeitsplatz"];

  it("adds split parts to the FTS OR list but not the AND list", () => {
    const built = buildFtsQuery(
      "documents",
      "german",
      10,
      undefined,
      false,
      0,
      "Kommissionierarbeitsplatz prüfen",
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      compoundTerms,
    );
    const orParam = built.params[0] as string;
    const andParam = built.params[1] as string;
    expect(orParam).toContain("'kommission'");
    expect(orParam).toContain("'arbeitsplatz'");
    // The AND list keeps the raw query tokens only.
    expect(andParam).toContain("'Kommissionierarbeitsplatz'");
    expect(andParam).not.toContain("'arbeitsplatz'");
    expect(andParam).not.toContain("'kommission'");
  });

  it("adds split parts to the hybrid lexical OR list", () => {
    const built = buildHybridQuery(
      "documents",
      "vector(768)",
      60,
      "german",
      10,
      undefined,
      false,
      4,
      0,
      false,
      0,
      "[0.1,0.2]",
      "Kommissionierarbeitsplatz prüfen",
      undefined,
      undefined,
      2,
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      compoundTerms,
    );
    const orParam = built.params[1] as string;
    const andParam = built.params[2] as string;
    expect(orParam).toContain("'kommission'");
    expect(orParam).toContain("'arbeitsplatz'");
    expect(andParam).toContain("'Kommissionierarbeitsplatz'");
    expect(andParam).not.toContain("'arbeitsplatz'");
  });

  it("de-duplicates a split part already present in the query", () => {
    const built = buildFtsQuery(
      "documents",
      "german",
      10,
      undefined,
      false,
      0,
      "arbeitsplatz",
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ["arbeitsplatz"],
    );
    const orParam = built.params[0] as string;
    // The token appears once, not twice.
    expect(orParam.match(/'arbeitsplatz'/g)?.length).toBe(1);
  });
});
