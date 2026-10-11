// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 19: resumption after an abort
 *
 * For every item set, every interruption cause (fault injection or
 * network loss in the fake Extract, process abort after n journal
 * writes, `abort("shutdown")` after the grace or `abort("logout")`) and every
 * interruption point during arbitrary transfers: no item still being
 * transferred at the abort is recorded afterwards in the state as `synced`
 * with a new marker. After another complete run all items are `synced`, and
 * no item whose success was in the journal before the abort is uploaded
 * again.
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
  /** Logout without grace → abort("logout"). */
  | { kind: "logout" }
  /** Network loss in the fake Extract (the ingest response is lost). */
  | { kind: "network-loss" }
  /** Process abort after n journal writes. */
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

describe("Property 19: resumption after an abort", () => {
  it("no aborted item is synced, the follow-up run completes, successes are not uploaded again", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, interruptionArb, async (items, interruption) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop19-"));
        const fake = new FakeExtract();
        // Track which item is opened first and abort there.
        let aborted = false;
        const abortFirstOpen = (): void => {
          if (aborted) return;
          aborted = true;
          controller.abort(interruption.kind === "logout" ? "logout" : "shutdown");
        };
        const controller = new AbortController();

        if (interruption.kind === "network-loss") {
          // The response is lost after Extract has stored the document.
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
        // The abort for shutdown/logout/process-abort happens after the
        // first successful journal write or at the first open.
        if (interruption.kind === "shutdown" || interruption.kind === "logout") {
          const originalOpen = first.adapter.open.bind(first.adapter);
          first.adapter.open = async (item, signal) => {
            const stream = await originalOpen(item, signal);
            abortFirstOpen();
            return stream;
          };
        }

        const report = await first.run();
        // The interrupted run reports itself as incomplete or with errors.
        expect(["incomplete", "ok"]).toContain(report.outcome);
        const stateAfter = structuredClone(first.store.state);
        await first.close();

        // Invariant 1: synced with a new marker ⇒ the document is in Extract
        // (only completely processed items wrote an outcome, 7.10).
        for (const item of items) {
          const entry = stateAfter.items[item.quellId];
          if (entry !== undefined && entry.status === "synced" && entry.marker === contentMarker(item.content)) {
            const ref = deriveReference("s1", item.quellId);
            expect(fake.documents.get("main")?.get(ref)).toBe(shaOf(item));
          }
        }

        // Invariant 2: items that were synced in the journal before the abort
        // are not opened again in the follow-up run (no re-upload).
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

  it("network loss leads to failed, not to a faked synced", async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop19n-"));
        const fake = new FakeExtract();
        // Every ingest call loses the response → retries are exhausted.
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
            // No marker progress without a confirmed transfer (8.10).
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

  it("a resumable session is continued and removed after success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atf-prop19r-"));
    const content = new Uint8Array(2048).fill(7);
    const items: HarnessItem[] = [{ quellId: "big.bin", content }];
    const fake = new FakeExtract();
    // The first PATCH loses the response after the commit → the session stays.
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
      // After successful completion no session is open any more (8.6).
      expect(entry?.pendingUpload).toBeUndefined();
      const ref = deriveReference("s1", "big.bin");
      expect(fake.documents.get("main")?.get(ref)).toBe(sha256Hex(content));
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
