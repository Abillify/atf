// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 19: Wiederaufnahme nach Abbruch
 *
 * Für jede Item-Menge, jeden Unterbrechungsgrund (Fehlerinjektion bzw.
 * Netzwerkverlust im Fake-Extract, Prozessabbruch nach n Journal-Schreib-
 * vorgängen, `abort("shutdown")` nach Grace oder `abort("logout")`) und jeden
 * Unterbrechungszeitpunkt während beliebiger Übertragungen gilt: Kein zum
 * Abbruchzeitpunkt noch übertragenes Item ist danach im State als `synced` mit
 * neuem Marker verzeichnet. Nach einem erneuten vollständigen Lauf sind alle
 * Items `synced`, und kein Item, dessen Erfolg vor dem Abbruch im Journal
 * stand, wird erneut hochgeladen.
 *
 * **Validates: Requirements 3.8, 7.8, 7.10, 10.7**
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deriveReference } from "../../src/sync/reference.js";
import { makeHarness } from "../fakes/run-harness.js";
import { contentMarker, sha256Hex, type HarnessItem } from "../fakes/fake-adapter.js";
import { FakeExtract } from "../fakes/fake-extract.js";

const quellIdArb = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter((s) => /^[a-z0-9][a-z0-9._-]*$/.test(s));

const itemsArb = fc.uniqueArray(
  fc
    .tuple(quellIdArb, fc.uint8Array({ minLength: 1, maxLength: 32 }))
    .map(([quellId, content]): HarnessItem => ({
      quellId,
      content: new Uint8Array(content),
    })),
  { selector: (item) => item.quellId, minLength: 2, maxLength: 6 },
);

type Interruption =
  /** SIGTERM/Shutdown mit Grace → abort("shutdown"). */
  | { kind: "shutdown" }
  /** Logout ohne Grace → abort("logout"). */
  | { kind: "logout" }
  /** Netzwerkverlust im Fake-Extract (ingest-Antwort geht verloren). */
  | { kind: "network-loss" }
  /** Prozessabbruch nach n Journal-Schreibvorgängen. */
  | { kind: "crash"; afterWrites: number };

const interruptionArb: fc.Arbitrary<Interruption> = fc.oneof(
  fc.constant({ kind: "shutdown" } as Interruption),
  fc.constant({ kind: "logout" } as Interruption),
  fc.constant({ kind: "network-loss" } as Interruption),
  fc
    .integer({ min: 1, max: 5 })
    .map((n): Interruption => ({ kind: "crash", afterWrites: n })),
);

const shaOf = (item: HarnessItem): string => sha256Hex(item.content);

describe("Property 19: Wiederaufnahme nach Abbruch", () => {
  it("kein abgebrochenes Item ist synced, Folgelauf completes, Erfolge nicht erneut geladen", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, interruptionArb, async (items, interruption) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop19-"));
        const fake = new FakeExtract();
        // Verfolge, welches Item als erstes geöffnet wird, und brich dort ab.
        let aborted = false;
        const abortFirstOpen = (): void => {
          if (aborted) return;
          aborted = true;
          controller.abort(interruption.kind === "logout" ? "logout" : "shutdown");
        };
        const controller = new AbortController();

        if (interruption.kind === "network-loss") {
          // Antwort geht verloren, nachdem Extract das Dokument gespeichert hat.
          fake.inject({ kind: "abort-after-commit", pathIncludes: "/v1/ingest" });
        }

        let writes = 0;
        const first = await makeHarness({
          items,
          fake,
          dir,
          signal: controller.signal,
          storeTweak:
            interruption.kind === "crash"
              ? (store) => {
                  const original = store.upsert.bind(store);
                  store.upsert = async (quellId, itemState) => {
                    await original(quellId, itemState);
                    writes += 1;
                    if (writes >= interruption.afterWrites) {
                      controller.abort("crash");
                      throw new Error("simulierter Prozessabbruch");
                    }
                  };
                }
              : undefined,
        });
        // Der Abbruch für shutdown/logout/prozessabbruch erfolgt nach dem
        // ersten erfolgreichen Journal-Write bzw. beim ersten open.
        if (interruption.kind === "shutdown" || interruption.kind === "logout") {
          const originalOpen = first.adapter.open.bind(first.adapter);
          first.adapter.open = async (item, signal) => {
            const stream = await originalOpen(item, signal);
            abortFirstOpen();
            return stream;
          };
        }

        const report = await first.run();
        // Der unterbrochene Lauf meldet sich als unvollständig oder mit Fehlern.
        expect(["incomplete", "ok"]).toContain(report.outcome);
        const stateAfter = structuredClone(first.store.state);
        await first.close();

        // Invariante 1: synced mit neuem Marker ⇒ Dokument liegt bei Extract
        // (nur vollständig verarbeitete Items schrieben ein Outcome, 7.10).
        for (const item of items) {
          const entry = stateAfter.items[item.quellId];
          if (entry !== undefined && entry.status === "synced" && entry.marker === contentMarker(item.content)) {
            const ref = deriveReference("s1", item.quellId);
            expect(fake.documents.get("main")?.get(ref)).toBe(shaOf(item));
          }
        }

        // Invariante 2: Items, die vor dem Abbruch als synced im Journal
        // standen, werden im Folgelauf nicht erneut geöffnet (kein Re-Upload).
        const alreadySynced = items.filter((item) => {
          const entry = stateAfter.items[item.quellId];
          return (
            entry !== undefined &&
            entry.status === "synced" &&
            entry.marker === contentMarker(item.content) &&
            entry.sha256 === shaOf(item)
          );
        });

        const second = await makeHarness({ items, fake, dir });
        try {
          const follow = await second.run();
          expect(follow.outcome).toBe("ok");
          for (const item of items) {
            const entry = second.store.state.items[item.quellId];
            expect(entry?.status).toBe("synced");
            expect(entry?.marker).toBe(contentMarker(item.content));
            expect(entry?.sha256).toBe(shaOf(item));
          }
          const reopened = second.adapter.openCalls.filter((id) =>
            alreadySynced.some((item) => item.quellId === id),
          );
          expect(reopened).toEqual([]);
        } finally {
          await second.close();
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Netzwerkverlust führt zu failed, nicht zu einem vorgetäuschten synced", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop19n-"));
        const fake = new FakeExtract();
        // Jeder ingest-Aufruf verliert die Antwort → Retries erschöpfen.
        for (let i = 0; i < items.length * 8; i++) {
          fake.inject({ kind: "network-error", pathIncludes: "/v1/ingest" });
        }
        const harness = await makeHarness({ items, fake, dir });
        try {
          const report = await harness.run();
          expect(report.outcome).toBe("ok");
          expect(report.counters.failed).toBe(items.length);
          for (const item of items) {
            const entry = harness.store.state.items[item.quellId];
            expect(entry?.status).toBe("failed");
            expect(entry?.lastError?.code).toBe("RETRIES_EXHAUSTED");
            // Kein Marker-Fortschritt ohne bestätigte Übertragung (8.10).
            expect(entry?.marker).toBe("");
          }
        } finally {
          await harness.close();
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });

  it("Resumable Session wird fortgesetzt und nach Erfolg entfernt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atf-prop19r-"));
    const content = new Uint8Array(2048).fill(7);
    const items: HarnessItem[] = [{ quellId: "big.bin", content }];
    const fake = new FakeExtract();
    // Erster PATCH verliert die Antwort nach Commit → Session bleibt bestehen.
    fake.patchFaults.set(0, "network-after");
    const harness = await makeHarness({
      items,
      fake,
      dir,
      limits: { resumableThresholdBytes: 1024 },
    });
    try {
      const report = await harness.run();
      expect(report.outcome).toBe("ok");
      const entry = harness.store.state.items["big.bin"];
      expect(entry?.status).toBe("synced");
      // Nach erfolgreichem Abschluss ist keine Session mehr offen (8.6).
      expect(entry?.pendingUpload).toBeUndefined();
      const ref = deriveReference("s1", "big.bin");
      expect(fake.documents.get("main")?.get(ref)).toBe(sha256Hex(content));
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
