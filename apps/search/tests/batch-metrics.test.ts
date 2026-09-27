// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Batch-processing metrics of the v2 batch worker (requirement 18.1), as
 * rendered by `HttpMetrics.render()`. The worker loop wires `recordBatchTick`
 * / `setBatchBacklog`; this test covers the registry contract only.
 */

import { describe, expect, it } from "vitest";
import { HttpMetrics } from "../src/http-metrics.js";

describe("HttpMetrics batch metrics", () => {
  it("renders tick outcomes, durations, units and backlog", () => {
    const metrics = new HttpMetrics();
    metrics.recordBatchTick({ outcome: "idle", durationMs: 3 });
    metrics.recordBatchTick({ outcome: "processed", durationMs: 1200, units: 40 });
    metrics.recordBatchTick({ outcome: "deferred", durationMs: 200 });
    metrics.recordBatchTick({ outcome: "bogus" as never });
    metrics.setBatchBacklog(7);
    const text = metrics.render();
    expect(text).toContain('vectorsearch_batch_ticks_total{outcome="idle"} 1');
    expect(text).toContain('vectorsearch_batch_ticks_total{outcome="processed"} 1');
    expect(text).toContain('vectorsearch_batch_ticks_total{outcome="deferred"} 1');
    expect(text).not.toContain('outcome="bogus"');
    // Idle ticks are not timed.
    expect(text).toContain("vectorsearch_batch_duration_seconds_count 2");
    expect(text).toContain('vectorsearch_batch_duration_seconds_bucket{le="0.25"} 1');
    expect(text).toContain('vectorsearch_batch_duration_seconds_bucket{le="2.5"} 2');
    expect(text).toContain("vectorsearch_batch_units_total 40");
    expect(text).toContain("vectorsearch_batch_pending 7");
  });
});

describe("batch worker onTick observer", () => {
  /** A pool whose connect() always fails, so every tick ends in "error". */
  const deadPool = {
    connect: async () => {
      throw new Error("db unreachable");
    },
  } as never;
  const embedding = {} as never;

  it("reports each tick's outcome and duration", async () => {
    const { createBatchWorker } = await import("../src/batch-worker.js");
    const seen: Array<{ kind: string; durationMs: number }> = [];
    const worker = createBatchWorker(deadPool, embedding, {
      intervalMs: 0,
      onTick: (outcome, durationMs) => {
        seen.push({ kind: outcome.kind, durationMs });
      },
    });
    const outcome = await worker.tick();
    expect(outcome.kind).toBe("error");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("error");
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    worker.stop();
  });

  it("never lets a throwing observer change the tick outcome", async () => {
    const { createBatchWorker } = await import("../src/batch-worker.js");
    const worker = createBatchWorker(deadPool, embedding, {
      intervalMs: 0,
      onTick: () => {
        throw new Error("observer bug");
      },
    });
    await expect(worker.tick()).resolves.toMatchObject({ kind: "error" });
    worker.stop();
  });
});
