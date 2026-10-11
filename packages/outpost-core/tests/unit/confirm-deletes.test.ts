// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression tests for the delete-confirmation gate (requirements 9.5, 9.11):
 * an over-threshold candidate set stays `awaiting-confirmation` across runs —
 * a previously stored `candidateSetHash` must NEVER self-confirm a later
 * delete pass. Only an explicit user confirmation (confirm-file / env,
 * modelled as {@link HarnessOptions.deleteConfirmation}) matching the CURRENT
 * candidate hash unlocks the deletion.
 */

import { describe, expect, it } from "vitest";
import { computeCandidateSetHash } from "../../src/sync/delete-planner.js";
import { makeHarness, type Harness } from "../fakes/run-harness.js";
import type { HarnessItem } from "../fakes/fake-adapter.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const ITEM_A: HarnessItem = { quellId: "a.txt", content: bytes("a") };
const ITEM_B: HarnessItem = { quellId: "b.txt", content: bytes("b") };
const ITEM_C: HarnessItem = { quellId: "c.txt", content: bytes("c") };

const deleteRequests = (h: Harness): number =>
  h.fake.requests.filter((r) => r.method === "DELETE").length;

describe("Confirm-Deletes: above the threshold it stays awaiting until confirmed", () => {
  it(
    "Run 1 syncs; Run 2 awaiting; Run 3 without confirmation does NOT delete; " +
      "Run 4 with the correct confirmation deletes exactly the candidates",
    async () => {
      const h1 = await makeHarness({
        items: [ITEM_A, ITEM_B, ITEM_C],
        config: { mirrorDelete: true, deleteThresholdPercent: 50 },
      });
      const report1 = await h1.run();
      expect(report1.outcome).toBe("ok");
      expect(report1.counters.new).toBe(3);
      await h1.close();

      const dir = h1.dir;
      // Run 2: only a present → b,c candidates (2/3 = 66 % > 50 %).
      const h2 = await makeHarness({
        items: [ITEM_A],
        dir,
        config: { mirrorDelete: true, deleteThresholdPercent: 50 },
      });
      const report2 = await h2.run();
      expect(report2.outcome).toBe("ok");
      expect(report2.deletePhase).toBe("awaiting-confirmation");
      expect(report2.awaitingConfirmation).toEqual({ count: 2, total: 3 });
      expect(deleteRequests(h2)).toBe(0);
      expect(Object.keys(h2.store.state.items).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
      const storedHash = h2.store.state.candidateSetHash;
      expect(storedHash).toBe(computeCandidateSetHash(["b.txt", "c.txt"]));
      await h2.close();

      // Run 3: the SAME candidate set, NO user confirmation. The stored
      // hash must not confirm the run by itself (bug fix 9.5/9.11).
      const h3 = await makeHarness({
        items: [ITEM_A],
        dir,
        config: { mirrorDelete: true, deleteThresholdPercent: 50 },
      });
      const report3 = await h3.run();
      expect(report3.deletePhase).toBe("awaiting-confirmation");
      expect(deleteRequests(h3)).toBe(0);
      expect(Object.keys(h3.store.state.items).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
      await h3.close();

      // Run 4: confirmed hash (read by the CLI from /data/state/<id>.confirm)
      // → exactly b,c are deleted, the hash is cleared.
      const confirmed = computeCandidateSetHash(["b.txt", "c.txt"]);
      const h4 = await makeHarness({
        items: [ITEM_A],
        dir,
        config: { mirrorDelete: true, deleteThresholdPercent: 50 },
        deleteConfirmation: confirmed,
      });
      const report4 = await h4.run();
      expect(report4.deletePhase).toBe("deleted");
      expect(report4.counters.deleted).toBe(2);
      expect(deleteRequests(h4)).toBe(2);
      expect(Object.keys(h4.store.state.items)).toEqual(["a.txt"]);
      expect(h4.store.state.candidateSetHash).toBeUndefined();
      await h4.close();
    },
  );

  it(
    "a confirmation for a DIFFERENT candidate set does not delete",
    async () => {
      const h1 = await makeHarness({
        items: [ITEM_A, ITEM_B, ITEM_C],
        config: { mirrorDelete: true, deleteThresholdPercent: 50 },
      });
      await h1.run();
      await h1.close();

      const h2 = await makeHarness({
        items: [ITEM_A],
        dir: h1.dir,
        config: { mirrorDelete: true, deleteThresholdPercent: 50 },
        // Stale confirmation (e.g. the candidate set of an earlier round).
        deleteConfirmation: computeCandidateSetHash(["b.txt"]),
      });
      const report = await h2.run();
      expect(report.deletePhase).toBe("awaiting-confirmation");
      expect(deleteRequests(h2)).toBe(0);
      expect(Object.keys(h2.store.state.items).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
      await h2.close();
    },
  );
});
