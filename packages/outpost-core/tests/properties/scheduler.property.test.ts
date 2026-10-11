// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 28: serialization of runs per source
 *
 * **Validates: Requirements 10.4**
 *
 * At no point do two runs of the same source run, and every trigger
 * during a running run leads to exactly one later run
 * (pending coalescing). Triggers are fired deterministically while a run is
 * active (in the runSource callback) so the count is exact:
 * totalRuns = 1 + the number of runs in which at least one trigger
 * was fired.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { outpostConfigSchema, type OutpostConfig, type SourceConfig } from "../../src/config/schema.js";
import { Scheduler } from "../../src/schedule/scheduler.js";
import { newCounters } from "../../src/sync/counters.js";
import type { RunReport } from "../../src/sync/run.js";
import { testLogger } from "../fakes/test-logger.js";

function makeCfg(ids: readonly string[]): OutpostConfig {
  const base = outpostConfigSchema.parse({
    extractUrl: "https://extract.example.com",
    collection: "main",
    syncIntervalSec: 900,
  });
  const sources = ids.map(
    (id): SourceConfig =>
      ({ type: "local", path: `/src/${id}`, id, watch: false }) as SourceConfig,
  );
  return { ...base, sources };
}

function okReport(): RunReport {
  return { outcome: "ok", counters: newCounters(), deletePhase: "none" };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Plan {
  /** Trigger count during each run; the first value applies to run 1. */
  perRun: number[];
}

describe("Property 28: serialization of runs per source", () => {
  it("never two concurrent runs; every trigger during a run → exactly one follow-up run", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sourceCount: fc.integer({ min: 1, max: 4 }),
          plans: fc.array(
            fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 0, maxLength: 4 }),
            { minLength: 1, maxLength: 4 },
          ),
        }),
        async ({ sourceCount, plans }) => {
          const ids = Array.from({ length: sourceCount }, (_, i) => `s${i}`);
          const planFor = new Map<string, Plan>();
          ids.forEach((id, i) => {
            planFor.set(id, { perRun: plans[i % plans.length] ?? [] });
          });

          const cfg = makeCfg(ids);
          const active = new Map<string, number>(ids.map((id) => [id, 0]));
          const runs = new Map<string, number>(ids.map((id) => [id, 0]));
          let maxConcurrent = 0;

          const scheduler = new Scheduler({
            cfg,
            logger: testLogger(),
            flushSource: async () => undefined,
            runSource: async (src, signal): Promise<RunReport> => {
              const plan = planFor.get(src.id) ?? { perRun: [] };
              const n = (runs.get(src.id) ?? 0) + 1;
              runs.set(src.id, n);
              const now = (active.get(src.id) ?? 0) + 1;
              active.set(src.id, now);
              maxConcurrent = Math.max(maxConcurrent, now);
              const triggers = n <= plan.perRun.length ? plan.perRun[n - 1] : undefined;
              if (triggers !== undefined) {
                // Fire triggers while this run is active (pending).
                for (let i = 0; i < triggers; i += 1) {
                  scheduler.trigger(src.id);
                }
              }
              await sleep(Math.floor((n % 3) + 1));
              active.set(src.id, (active.get(src.id) ?? 1) - 1);
              if (Boolean(signal.aborted)) return { ...okReport(), outcome: "incomplete" };
              return okReport();
            },
          });

          // Initial trigger per source (no interval start).
          for (const id of ids) scheduler.trigger(id);

          // Settle: waits until no runs are active/pending and the count is stable.
          let prevTotal = -1;
          let stable = 0;
          for (let i = 0; i < 200 && stable < 10; i += 1) {
            await sleep(2);
            const total = [...runs.values()].reduce((a, b) => a + b, 0);
            const activeTotal = [...active.values()].reduce((a, b) => a + b, 0);
            const pendingTotal = scheduler
              .status()
              .reduce((a, s) => a + (s.pending ? 1 : 0), 0);
            if (total === prevTotal && activeTotal === 0 && pendingTotal === 0) {
              stable += 1;
            } else {
              stable = 0;
              prevTotal = total;
            }
          }

          expect(maxConcurrent).toBeLessThanOrEqual(1);
          for (const id of ids) {
            const plan = planFor.get(id) ?? { perRun: [] };
            const expected = 1 + plan.perRun.length;
            expect(runs.get(id)).toBe(expected);
            const view = scheduler.status().find((s) => s.sourceId === id);
            expect(view?.pending).toBe(false);
            expect(view?.status).toBe("idle");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
