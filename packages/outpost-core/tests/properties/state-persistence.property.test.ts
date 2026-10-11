// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 18: Sync_State persistence and
 * robustness
 *
 * **Validates: Requirements 7.1, 7.7**
 *
 * For every `SourceState`, writing (snapshot and arbitrary journal
 * sequences) and loading again yields an equivalent state. For
 * arbitrary byte sequences as snapshot content or for a journal cut off at
 * an arbitrary point, loading does not throw: it returns
 * either an empty state (snapshot unreadable) or the state up to the
 * last complete journal line.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyJournalEntry,
  crc32,
  decodeJournalRecord,
  deriveReference,
  encodeJournalRecord,
  SyncStateStore,
  type ItemState,
  type JournalEntry,
  type SourceState,
} from "../../src/index.js";

let tmpDir: string;
let dirCounter = 0;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "outpost-state-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  dirCounter += 1;
  const dir = path.join(tmpDir, `d${dirCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const itemArb: fc.Arbitrary<ItemState> = fc.record({
  reference: fc.stringMatching(/^outpost:s1:[A-Za-z0-9_-]{32}$/),
  marker: fc.string({ minLength: 0, maxLength: 24 }),
  sha256: fc.option(fc.stringMatching(/^[0-9a-f]{64}$/), { nil: undefined }),
  size: fc.nat({ max: 1_000_000_000 }),
  status: fc.constantFrom("synced", "failed", "pending-job", "deleted-in-source"),
  jobId: fc.option(fc.uuid(), { nil: undefined }),
  pendingUpload: fc.option(
    fc.record({
      uploadId: fc.uuid(),
      sha256: fc.stringMatching(/^[0-9a-f]{64}$/),
    }),
    { nil: undefined },
  ),
  lastError: fc.option(
    fc.record({
      code: fc.stringMatching(/^[A-Z_]{3,16}$/),
      message: fc.string({ maxLength: 40 }),
      at: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map((d) => d.toISOString()),
    }),
    { nil: undefined },
  ),
  syncedAt: fc.option(
    fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map((d) => d.toISOString()),
    { nil: undefined },
  ),
});

const entryArb: fc.Arbitrary<JournalEntry> = fc.oneof(
  fc.record({
    op: fc.constant("upsert" as const),
    quellId: fc.stringMatching(/^[a-z][a-z0-9/._-]{0,20}$/),
    item: itemArb,
  }),
  fc.record({
    op: fc.constant("delete" as const),
    quellId: fc.stringMatching(/^[a-z][a-z0-9/._-]{0,20}$/),
  }),
  fc.record({
    op: fc.constant("meta" as const),
    collection: fc.option(fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/), { nil: undefined }),
    // undefined = unchanged, null = remove, string = set
    candidateSetHash: fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.stringMatching(/^[0-9a-f]{16}$/),
    ),
  }),
);

function expectedState(base: SourceState, entries: JournalEntry[]): SourceState {
  return entries.reduce(applyJournalEntry, base);
}

describe("Property 18: Sync_State persistence and robustness", () => {
  it("writing (snapshot + journal) and loading again is equivalent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 0, maxLength: 12 }),
        fc.boolean(),
        async (entries, flushHalfway) => {
          const dir = await freshDir();
          const base: SourceState = {
            version: 1,
            sourceId: "s1",
            collection: "col",
            items: {},
          };
          const store = await SyncStateStore.open({ dir, sourceId: "s1", collection: "col" });
          const mid = flushHalfway ? Math.floor(entries.length / 2) : entries.length;
          for (const [i, entry] of entries.entries()) {
            if (entry.op === "upsert") await store.upsert(entry.quellId, entry.item);
            else if (entry.op === "delete") await store.deleteItem(entry.quellId);
            else await store.setMeta({ collection: entry.collection, candidateSetHash: entry.candidateSetHash });
            if (i === mid - 1) await store.flush(); // snapshot in the middle of the run
          }
          const expected = expectedState(base, entries);
          expect(store.state).toEqual(expected);
          // Reopen without a flush: journal replay yields the same state.
          await store.close();
          const reopened = await SyncStateStore.open({ dir, sourceId: "s1", collection: "col" });
          expect(reopened.state).toEqual(expected);
          // With a flush: the snapshot contains the same state.
          await reopened.flush();
          const onDisk = JSON.parse(await readFile(path.join(dir, "s1.json"), "utf8")) as SourceState;
          expect(onDisk).toEqual(expected);
          await reopened.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("arbitrary byte garbage as a snapshot: no throw, empty state + quarantine", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 200 }), async (bytes) => {
        const dir = await freshDir();
        await writeFile(path.join(dir, "s1.json"), new Uint8Array(bytes));
        const store = await SyncStateStore.open({ dir, sourceId: "s1", collection: "col" });
        expect(store.state.items).toEqual({});
        expect(store.state.collection).toBe("col");
        // An unreadable snapshot is moved to *.corrupt-<ts> (7.7).
        const names = await readdir(dir);
        expect(names.some((n) => n.startsWith("s1.json.corrupt-"))).toBe(true);
        expect(names).not.toContain("s1.json");
        await store.close();
      }),
      { numRuns: 100 },
    );
  });

  it("truncated journal: state up to the last complete line", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 400 }),
        async (entries, cutFraction) => {
          const dir = await freshDir();
          const store = await SyncStateStore.open({ dir, sourceId: "s1", collection: "col" });
          for (const entry of entries) {
            if (entry.op === "upsert") await store.upsert(entry.quellId, entry.item);
            else if (entry.op === "delete") await store.deleteItem(entry.quellId);
            else await store.setMeta({ collection: entry.collection, candidateSetHash: entry.candidateSetHash });
          }
          await store.close();
          const journalPath = path.join(dir, "s1.journal");
          const full = await readFile(journalPath);
          // Cut the journal off at an arbitrary point.
          const cut = full.length === 0 ? 0 : cutFraction % full.length;
          await writeFile(journalPath, full.subarray(0, cut));
          const reopened = await SyncStateStore.open({ dir, sourceId: "s1", collection: "col" });
          // Reconstruct the expected state from the complete lines.
          let offset = 0;
          let expected: SourceState = { version: 1, sourceId: "s1", collection: "col", items: {} };
          for (;;) {
            const record = decodeJournalRecord(full, offset);
            if (!record.ok || record.next > cut) break;
            const entry = JSON.parse(record.payload) as JournalEntry;
            expected = applyJournalEntry(expected, entry);
            offset = record.next;
          }
          expect(reopened.state).toEqual(expected);
          await reopened.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("record encoding: encode/decode round trip and CRC check", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 300 }), (payload) => {
        const bytes = new TextEncoder().encode(payload);
        const record = encodeJournalRecord(bytes);
        const decoded = decodeJournalRecord(Buffer.from(record), 0);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.payload).toBe(payload);
          expect(decoded.next).toBe(record.length);
        }
        // A changed payload byte → CRC error.
        if (bytes.length > 0) {
          const broken = Buffer.from(record);
          broken[8] = ((broken[8] ?? 0) + 1) % 256;
          expect(decodeJournalRecord(broken, 0).ok).toBe(false);
        }
        // Truncated record → not ok.
        expect(decodeJournalRecord(Buffer.from(record.subarray(0, record.length - 1)), 0).ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("crc32 entspricht bekannter Referenz (IEEE)", () => {
    // "123456789" → 0xCBF43926 (Standard-Testvektor).
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("compaction after compactAfterEntries empties the journal", async () => {
    const dir = await freshDir();
    const store = await SyncStateStore.open({
      dir,
      sourceId: "s1",
      collection: "col",
      compactAfterEntries: 3,
    });
    const ref = deriveReference("s1", "a.txt");
    const item: ItemState = { reference: ref, marker: "m", size: 1, status: "synced" };
    await store.upsert("a.txt", item);
    await store.upsert("b.txt", item);
    // Still below the threshold: the journal contains lines.
    expect((await readFile(path.join(dir, "s1.journal"))).length).toBeGreaterThan(0);
    await store.upsert("c.txt", item); // 3rd entry → compaction
    expect((await readFile(path.join(dir, "s1.journal"))).length).toBe(0);
    const onDisk = JSON.parse(await readFile(path.join(dir, "s1.json"), "utf8")) as SourceState;
    expect(Object.keys(onDisk.items).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    await store.close();
  });
});
