// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for `POST /v2/citations/check` (task T-301): the five statuses,
 * input-order preservation, the bounded query plan (no N+1 over chunks), and
 * request validation. The PostgresClient is faked; the real SQL is covered by
 * `citations-check.integration.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import type { PostgresClient } from "../src/postgres-client.js";
import type { CitationChunkRow, CurrentRevisionRow } from "../src/pg-types.js";
import {
  buildCitationsCheck,
  CITATIONS_CHECK_MAX_ITEMS,
  parseCitationsCheckRequest,
  type CitationCheckItem,
} from "../src/handlers/citations-check-v2.js";
import { contentHash } from "../src/traceability.js";

const scope = { tenantId: "t1", service: true } as unknown as AccessScope;
const NOW = new Date("2026-03-01T12:00:00Z");

function chunkRow(
  id: string,
  baseRef: string,
  revisionId: string | null,
  content: string,
): CitationChunkRow {
  return {
    id,
    base_ref: baseRef,
    revision_id: revisionId,
    content,
    valid_from: null,
    created: "2025-01-01T00:00:00.000Z",
  };
}

interface Fakes {
  chunks: CitationChunkRow[];
  current: CurrentRevisionRow[];
  contents: Record<string, string[]>;
}
const norm = (text: string): string => text.replace(/\s+/g, " ").trim();

function fakePg(fakes: Fakes) {
  const getChunksByIds = vi.fn(async (_c: string, _s: AccessScope, ids: string[]) => ({
    ok: true as const,
    result: fakes.chunks.filter((row) => ids.includes(row.id)),
  }));
  const getCurrentRevisionsAt = vi.fn(
    async (_c: string, _s: AccessScope, baseRefs: string[]) => ({
      ok: true as const,
      result: fakes.current.filter((row) => baseRefs.includes(row.base_ref)),
    }),
  );
  // Mirrors the SQL: whitespace runs collapsed on both sides.
  const findCarriedContents = vi.fn(
    async (_c: string, _s: AccessScope, baseRef: string, _v: string, candidates: string[]) => ({
      ok: true as const,
      result: candidates.map((c) => (fakes.contents[baseRef] ?? []).some((x) => norm(x) === norm(c))),
    }),
  );
  const pg = {
    getChunksByIds,
    getCurrentRevisionsAt,
    findCarriedContents,
  } as unknown as PostgresClient;
  return { pg, getChunksByIds, getCurrentRevisionsAt, findCarriedContents };
}

describe("parseCitationsCheckRequest", () => {
  it("accepts 1..500 well-formed items", () => {
    const items: unknown[] = Array.from({ length: CITATIONS_CHECK_MAX_ITEMS }, (_, i) => ({
      base_ref: `doc/${String(i)}.pdf`,
      chunk_id: `c${String(i)}`,
    }));
    const parsed = parseCitationsCheckRequest({ items });
    expect("items" in parsed).toBe(true);
    if ("items" in parsed) expect(parsed.items).toHaveLength(CITATIONS_CHECK_MAX_ITEMS);
  });

  it("rejects an empty list, more than 500 items, and malformed entries", () => {
    expect("error" in parseCitationsCheckRequest({ items: [] })).toBe(true);
    const tooMany = Array.from({ length: CITATIONS_CHECK_MAX_ITEMS + 1 }, (_, i) => ({
      base_ref: "a.pdf",
      chunk_id: `c${String(i)}`,
    }));
    expect("error" in parseCitationsCheckRequest({ items: tooMany })).toBe(true);
    expect("error" in parseCitationsCheckRequest({})).toBe(true);
    expect("error" in parseCitationsCheckRequest({ items: "x" })).toBe(true);
    expect(
      "error" in parseCitationsCheckRequest({ items: [{ base_ref: "", chunk_id: "c" }] }),
    ).toBe(true);
    expect(
      "error" in parseCitationsCheckRequest({ items: [{ base_ref: "a.pdf" }] }),
    ).toBe(true);
    expect("error" in parseCitationsCheckRequest(null)).toBe(true);
    expect("error" in parseCitationsCheckRequest([])).toBe(true);
  });
});

describe("buildCitationsCheck", () => {
  it("classifies current, carried, changed, removed and unknown", async () => {
    const kept = "Unveränderter Text des übernommenen Chunks.";
    const gone = "Alter Text, in der aktuellen Fassung so nicht mehr vorhanden.";
    const { pg } = fakePg({
      chunks: [
        chunkRow("c-current", "d/a.pdf", "rev2", "Aktueller Chunktext."),
        chunkRow("c-carried", "d/a.pdf", "rev1", kept),
        chunkRow("c-changed", "d/a.pdf", "rev1", gone),
        chunkRow("c-removed", "d/gone.pdf", "rev1", "Entferntes Dokument."),
        // "c-unknown" is deliberately absent — invisible or never existed.
      ],
      current: [
        { base_ref: "d/a.pdf", revision_id: "rev2" },
        // d/gone.pdf has NO visible revision today → removed.
      ],
      contents: { "d/a.pdf": ["Aktueller Chunktext.", kept] },
    });
    const items: CitationCheckItem[] = [
      { base_ref: "d/a.pdf", chunk_id: "c-current" },
      { base_ref: "d/a.pdf", chunk_id: "c-carried" },
      { base_ref: "d/a.pdf", chunk_id: "c-changed" },
      { base_ref: "d/gone.pdf", chunk_id: "c-removed" },
      { base_ref: "d/a.pdf", chunk_id: "c-unknown" },
    ];
    const payload = await buildCitationsCheck(pg, "documents", scope, items, NOW);
    expect(payload.checked_at).toBe("2026-03-01T12:00:00.000Z");
    expect(payload.results.map((r) => r.status)).toEqual([
      "current",
      "carried",
      "changed",
      "removed",
      "unknown",
    ]);
    expect(payload.results[0].current_revision).toBe("rev2");
    expect(payload.results[3].current_revision).toBeUndefined();
    expect(payload.results[4].current_revision).toBeUndefined();
  });

  it("keeps the caller's input order and repeats per item", async () => {
    const { pg } = fakePg({
      chunks: [chunkRow("c1", "a.pdf", "rev2", "Eins."), chunkRow("c2", "b.pdf", "rev9", "Zwei.")],
      current: [
        { base_ref: "a.pdf", revision_id: "rev2" },
        { base_ref: "b.pdf", revision_id: "rev9" },
      ],
      contents: {},
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [
        { base_ref: "b.pdf", chunk_id: "c2" },
        { base_ref: "a.pdf", chunk_id: "c1" },
        { base_ref: "b.pdf", chunk_id: "c2" },
      ],
      NOW,
    );
    expect(payload.results).toEqual([
      { base_ref: "b.pdf", chunk_id: "c2", status: "current", current_revision: "rev9" },
      { base_ref: "a.pdf", chunk_id: "c1", status: "current", current_revision: "rev2" },
      { base_ref: "b.pdf", chunk_id: "c2", status: "current", current_revision: "rev9" },
    ]);
  });

  it("bounds the load: one chunk query, one revision query, one content query per document", async () => {
    const old = "Überholter Text.";
    const { pg, getChunksByIds, getCurrentRevisionsAt, findCarriedContents } = fakePg({
      chunks: [
        chunkRow("c1", "a.pdf", "rev1", old),
        chunkRow("c2", "a.pdf", "rev1", "Auch alt."),
        chunkRow("c3", "b.pdf", "rev1", "Alt in B."),
      ],
      current: [
        { base_ref: "a.pdf", revision_id: "rev2" },
        { base_ref: "b.pdf", revision_id: "rev2" },
      ],
      contents: { "a.pdf": ["Neuer Text."], "b.pdf": ["Neuer B-Text."] },
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [
        { base_ref: "a.pdf", chunk_id: "c1" },
        { base_ref: "a.pdf", chunk_id: "c2" },
        { base_ref: "b.pdf", chunk_id: "c3" },
      ],
      NOW,
    );
    expect(payload.results.map((r) => r.status)).toEqual(["changed", "changed", "changed"]);
    expect(getChunksByIds).toHaveBeenCalledTimes(1);
    expect(getCurrentRevisionsAt).toHaveBeenCalledTimes(1);
    // One comparison per document that needs it — never per chunk.
    expect(findCarriedContents).toHaveBeenCalledTimes(2);
  });

  it("treats content that differs only in whitespace as carried", async () => {
    const { pg } = fakePg({
      chunks: [chunkRow("c1", "a.pdf", "rev1", "Blieb\n  gleich."), chunkRow("c2", "a.pdf", "rev1", "Alter Text.")],
      current: [{ base_ref: "a.pdf", revision_id: "rev2" }],
      contents: { "a.pdf": ["Blieb gleich."] },
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [
        { base_ref: "a.pdf", chunk_id: "c1" },
        { base_ref: "a.pdf", chunk_id: "c2" },
      ],
      NOW,
    );
    expect(payload.results.map((r) => r.status)).toEqual(["carried", "changed"]);
  });
  it("skips the content read when every cited chunk is already current", async () => {
    const { pg, findCarriedContents } = fakePg({
      chunks: [chunkRow("c1", "a.pdf", "rev2", "Aktuell.")],
      current: [{ base_ref: "a.pdf", revision_id: "rev2" }],
      contents: {},
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [{ base_ref: "a.pdf", chunk_id: "c1" }],
      NOW,
    );
    expect(payload.results[0].status).toBe("current");
    expect(findCarriedContents).not.toHaveBeenCalled();
  });

  it("matches the (base_ref, chunk_id) pair: an id found under another document is unknown", async () => {
    const { pg } = fakePg({
      chunks: [chunkRow("c1", "other.pdf", "rev2", "Anderes Dokument.")],
      current: [
        { base_ref: "a.pdf", revision_id: "rev2" },
        { base_ref: "other.pdf", revision_id: "rev2" },
      ],
      contents: {},
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [{ base_ref: "a.pdf", chunk_id: "c1" }],
      NOW,
    );
    expect(payload.results[0].status).toBe("unknown");
  });

  it("treats a legacy (null) current revision as current for a null-revision chunk", async () => {
    const { pg } = fakePg({
      chunks: [chunkRow("legacy-1", "a.pdf", null, "Legacy-Zeile.")],
      current: [{ base_ref: "a.pdf", revision_id: null }],
      contents: {},
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [{ base_ref: "a.pdf", chunk_id: "legacy-1" }],
      NOW,
    );
    expect(payload.results[0].status).toBe("current");
    expect(payload.results[0].current_revision).toBeUndefined();
  });

  it("compares hashes on normalized content for the carried verdict", async () => {
    const cited = "Text  mit   leerzeichen.";
    const current = "Text mit leerzeichen.";
    expect(contentHash(cited)).toBe(contentHash(current));
    const { pg } = fakePg({
      chunks: [chunkRow("c1", "a.pdf", "rev1", cited)],
      current: [{ base_ref: "a.pdf", revision_id: "rev2" }],
      contents: { "a.pdf": [current] },
    });
    const payload = await buildCitationsCheck(
      pg,
      "documents",
      scope,
      [{ base_ref: "a.pdf", chunk_id: "c1" }],
      NOW,
    );
    expect(payload.results[0].status).toBe("carried");
  });

  it("propagates a load failure instead of guessing statuses", async () => {
    const pg = {
      getChunksByIds: vi.fn(async () => ({
        ok: false as const,
        error: { code: "POSTGRES_UNAVAILABLE" as const, message: "down" },
      })),
    } as unknown as PostgresClient;
    await expect(
      buildCitationsCheck(pg, "documents", scope, [
        { base_ref: "a.pdf", chunk_id: "c1" },
      ]),
    ).rejects.toThrow("Citation chunks load failed: down");
  });
});
