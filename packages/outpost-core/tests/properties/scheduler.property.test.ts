// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 28: Serialisierung der Runs je Source
 *
 * **Validates: Requirements 10.4**
 *
 * Zu keinem Zeitpunkt laufen zwei Runs derselben Quelle, und jeder Trigger
 * waehrend eines laufenden Runs fuehrt zu genau einem spaeteren Lauf
 * (pending-Koaleszenz). Trigger werden deterministisch ABGEGEBEN, waehrend
 * ein Lauf aktiv ist (im runSource-Callback), damit die Zaehlung exakt ist:
 * totalRuns = 1 + Anzahl der Laeufe, in denen mindestens ein Trigger
 * abgegeben wurde.
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
  /** Trigger-Anzahl waehrend jedem Lauf; der erste Wert gilt fuer Lauf 1. */
  perRun: number[];
}

describe("Property 28: Serialisierung der Runs je Source", () => {
  it("nie zwei gleichzeitige Läufe; jeder Trigger während eines Laufs → genau ein Folgelauf", async () => {
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
                // Trigger abgeben, solange dieser Lauf aktiv ist (pending).
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

          // Initialer Trigger je Quelle (kein Intervall-Start).
          for (const id of ids) scheduler.trigger(id);

          // Settle: wartet, bis keine Läufe aktiv/pending und die Zahl stabil ist.
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
