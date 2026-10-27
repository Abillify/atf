// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Tombstones and incremental listings.
 *
 * A delta source lists changes only, so an item missing from such a listing
 * was NOT deleted: the absence-based delete phase must not run. Deletions and
 * revoked access arrive as tombstones (`removal`) instead: `access-revoked`
 * always removes the synced copy, `deleted` follows Mirror_Delete.
 */
import { describe, expect, it } from "vitest";
import type { SourceAdapter, SourceItem } from "../../src/sources/types.js";
import { fakeAdapter, type HarnessItem } from "../fakes/fake-adapter.js";
import type { FakeExtract } from "../fakes/fake-extract.js";
import { makeHarness } from "../fakes/run-harness.js";

const content = (text: string): Uint8Array => new TextEncoder().encode(text);
const both: HarnessItem[] = [
  { quellId: "docs/a.txt", content: content("eins") },
  { quellId: "docs/b.txt", content: content("zwei") },
];

function storedReferences(fake: FakeExtract): string[] {
  const out: string[] = [];
  for (const bucket of fake.documents.values()) out.push(...bucket.keys());
  return out.sort();
}

/** A delta-style adapter: lists `items` plus `tombstones`, optionally incremental. */
function deltaAdapter(
  items: readonly HarnessItem[],
  tombstones: Array<Pick<SourceItem, "quellId" | "removal">>,
  incremental: boolean,
): SourceAdapter & { listingIsIncremental(): boolean } {
  const base = fakeAdapter(items);
  return {
    async *list(signal: AbortSignal): AsyncIterable<SourceItem> {
      for await (const item of base.list(signal)) yield item;
      for (const t of tombstones) {
        yield { quellId: t.quellId, name: t.quellId, size: 0, modified: new Date(0), marker: "", removal: t.removal };
      }
    },
    open: (item, signal) => base.open(item, signal),
    listingIsIncremental: () => incremental,
  };
}

describe("incremental listings and tombstones", () => {
  it("an incremental listing does not delete items it did not mention", async () => {
    // Threshold 100 %: without the incremental guard the unmentioned item
    // would be deleted straight away rather than waiting for confirmation.
    const config = { mirrorDelete: true, deleteThresholdPercent: 100 };
    const first = await makeHarness({ items: both, config });
    try {
      await first.run();
      expect(storedReferences(first.fake)).toHaveLength(2);
      const second = await makeHarness({
        items: [],
        dir: first.dir,
        fake: first.fake,
        config,
        makeAdapter: () => deltaAdapter([both[1] as HarnessItem], [], true),
      });
      try {
        await second.run();
        expect(storedReferences(second.fake)).toHaveLength(2);
        expect(Object.keys(second.store.state.items).sort()).toEqual(["docs/a.txt", "docs/b.txt"]);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("an access-revoked tombstone removes the synced copy even with Mirror_Delete off", async () => {
    const first = await makeHarness({ items: both, config: { mirrorDelete: false } });
    try {
      await first.run();
      const second = await makeHarness({
        items: [],
        dir: first.dir,
        fake: first.fake,
        config: { mirrorDelete: false },
        makeAdapter: () => deltaAdapter([], [{ quellId: "docs/a.txt", removal: "access-revoked" }], true),
      });
      try {
        const report = await second.run();
        expect(report.counters.deleted).toBe(1);
        expect(storedReferences(second.fake)).toHaveLength(1);
        expect(second.store.state.items["docs/a.txt"]).toBeUndefined();
        expect(second.store.state.items["docs/b.txt"]).toBeDefined();
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("a deleted tombstone follows Mirror_Delete", async () => {
    const first = await makeHarness({ items: both, config: { mirrorDelete: false } });
    try {
      await first.run();
      const marked = await makeHarness({
        items: [],
        dir: first.dir,
        fake: first.fake,
        config: { mirrorDelete: false },
        makeAdapter: () => deltaAdapter([], [{ quellId: "docs/a.txt", removal: "deleted" }], true),
      });
      try {
        await marked.run();
        expect(storedReferences(marked.fake)).toHaveLength(2);
        expect(marked.store.state.items["docs/a.txt"]?.status).toBe("deleted-in-source");
      } finally {
        await marked.close();
      }
      const deleted = await makeHarness({
        items: [],
        dir: first.dir,
        fake: first.fake,
        config: { mirrorDelete: true },
        makeAdapter: () => deltaAdapter([], [{ quellId: "docs/b.txt", removal: "deleted" }], true),
      });
      try {
        await deleted.run();
        expect(deleted.store.state.items["docs/b.txt"]).toBeUndefined();
        expect(storedReferences(deleted.fake)).toHaveLength(1);
      } finally {
        await deleted.close();
      }
    } finally {
      await first.close();
    }
  });

  it("a tombstone for an item that was never synced does nothing", async () => {
    const harness = await makeHarness({
      items: [],
      makeAdapter: () => deltaAdapter([], [{ quellId: "docs/x.txt", removal: "access-revoked" }], false),
    });
    try {
      const report = await harness.run();
      expect(report.counters.deleted).toBe(0);
      expect(harness.fake.ingests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
