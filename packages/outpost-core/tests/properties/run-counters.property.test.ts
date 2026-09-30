// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 30: Konsistenz der Run-Zähler
 *
 * Für jeden Sync_Run ist die Summe `new + updated + skipped + failed` gleich
 * der Anzahl verarbeiteter Source_Items nach Filterung, `deleted` gleich der
 * Anzahl bestätigter Löschungen, und jedes Item wird in genau einer Klasse
 * gezählt.
 *
 * **Validates: Requirements 11.1**
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { processedTotal } from "../../src/sync/counters.js";
import { deriveReference } from "../../src/sync/reference.js";
import { makeHarness } from "../fakes/run-harness.js";
import { contentMarker, sha256Hex, type HarnessItem } from "../fakes/fake-adapter.js";
import { FakeExtract } from "../fakes/fake-extract.js";

const quellIdArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => /^[a-z0-9][a-z0-9._-]*$/.test(s));

const itemArb: fc.Arbitrary<HarnessItem> = fc
  .tuple(quellIdArb, fc.uint8Array({ minLength: 0, maxLength: 48 }))
  .map(([quellId, content]) => ({
    quellId,
    content: new Uint8Array(content),
  }));

const itemsArb = fc.uniqueArray(itemArb, {
  selector: (item) => item.quellId,
  minLength: 1,
  maxLength: 8,
});

describe("Property 30: Konsistenz der Run-Zähler", () => {
  it("new + updated + skipped + failed == verarbeitete Items", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop30-"));
        const harness = await makeHarness({ items, dir });
        try {
          const report = await harness.run();
          expect(report.outcome).toBe("ok");
          expect(processedTotal(report.counters)).toBe(items.length);
          // Erster Lauf ohne vorherigen State: alles neu.
          expect(report.counters.new).toBe(items.length);
          expect(report.counters.updated).toBe(0);
          expect(report.counters.failed).toBe(0);
        } finally {
          await harness.close();
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  it("zweiter Lauf ohne Änderungen zählt alles als skipped", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop30b-"));
        const harness = await makeHarness({ items, dir });
        try {
          await harness.run();
          const second = await harness.run();
          expect(second.outcome).toBe("ok");
          expect(processedTotal(second.counters)).toBe(items.length);
          expect(second.counters.skipped).toBe(items.length);
          expect(second.counters.new).toBe(0);
          expect(second.counters.updated).toBe(0);
        } finally {
          await harness.close();
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  it("geänderte Inhalte zählen als updated, neue als new, gelöschte in deleted", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        fc.pre(items.length >= 2);
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop30c-"));
        const fake = new FakeExtract();
        const harness = await makeHarness({ items, fake, dir });
        try {
          await harness.run();
          // Change one item's content, drop another from the listing.
          const [changed, dropped] = items;
          if (changed === undefined || dropped === undefined) throw new Error("harness needs two items");
          const newContent = new Uint8Array([...changed.content, 0xff]);
          const nextItems: HarnessItem[] = [
            { quellId: changed.quellId, content: newContent },
            ...items.slice(2),
          ];
          const harness2 = await makeHarness({ items: nextItems, fake, dir });
          try {
            const report = await harness2.run();
            expect(report.outcome).toBe("ok");
            expect(processedTotal(report.counters)).toBe(nextItems.length);
            expect(report.counters.updated).toBe(1);
            expect(report.counters.skipped).toBe(nextItems.length - 1);
            // 1 von n ≤ 50 % → unter Schwellwert, bestätigt gelöscht (9.1).
            expect(report.counters.deleted).toBe(1);
            expect(report.deletePhase).toBe("deleted");
            const ref = deriveReference("s1", dropped.quellId);
            expect(fake.documents.get("main")?.has(ref)).toBe(false);
            expect(harness2.store.state.items[dropped.quellId]).toBeUndefined();
            const entry = harness2.store.state.items[changed.quellId];
            expect(entry?.sha256).toBe(sha256Hex(newContent));
            expect(entry?.marker).toBe(contentMarker(newContent));
          } finally {
            await harness2.close();
          }
        } finally {
          await harness.close();
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });

  it("fehlgeschlagene Items zählen als failed und nicht als new", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop30d-"));
        const fake = new FakeExtract();
        // Erste ingest-Antwort 422 → permanenter Fehler für genau ein Item.
        fake.inject({ kind: "status", status: 422, pathIncludes: "/v1/ingest" });
        const harness = await makeHarness({ items, fake, dir });
        try {
          const report = await harness.run();
          expect(processedTotal(report.counters)).toBe(items.length);
          expect(report.counters.failed).toBe(1);
          expect(report.counters.new).toBe(items.length - 1);
        } finally {
          await harness.close();
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });
});
