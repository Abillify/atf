// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * stage-metrics.test.ts
 *
 * The per-stage Prometheus metrics of the v2 pipeline:
 * duration histogram, outcome counter, token counter and the emit backlog
 * gauge, rendered by `HttpMetrics.render()`.
 */

import { describe, expect, it } from "vitest";
import { HttpMetrics } from "../src/http-metrics.js";

describe("HttpMetrics stage metrics", () => {
  it("renders duration, outcome and token series per stage", () => {
    const metrics = new HttpMetrics();
    metrics.recordStage({ stage: "vision1", outcome: "done", durationMs: 1500, tokens: 1200 });
    metrics.recordStage({ stage: "vision1", outcome: "done", durationMs: 500, tokens: 300 });
    metrics.recordStage({ stage: "vision1", outcome: "reused" });
    metrics.recordStage({ stage: "tiled", outcome: "failed_transient", durationMs: 20 });
    metrics.recordStage({ stage: "docpass", outcome: "failed_permanent", durationMs: 70_000 });
    const text = metrics.render();

    expect(text).toContain("# TYPE extract_stage_duration_seconds histogram");
    expect(text).toContain('extract_stage_duration_seconds_count{stage="vision1"} 2');
    expect(text).toContain('extract_stage_duration_seconds_sum{stage="vision1"} 2');
    expect(text).toContain('extract_stage_duration_seconds_bucket{stage="vision1",le="1"} 1');
    expect(text).toContain('extract_stage_duration_seconds_bucket{stage="vision1",le="2.5"} 2');
    expect(text).toContain('extract_stage_duration_seconds_bucket{stage="docpass",le="60"} 0');
    expect(text).toContain('extract_stage_duration_seconds_bucket{stage="docpass",le="120"} 1');

    expect(text).toContain("# TYPE extract_stage_total counter");
    expect(text).toContain('extract_stage_total{stage="vision1",outcome="done"} 2');
    expect(text).toContain('extract_stage_total{stage="vision1",outcome="reused"} 1');
    expect(text).toContain('extract_stage_total{stage="tiled",outcome="failed_transient"} 1');
    expect(text).toContain('extract_stage_total{stage="docpass",outcome="failed_permanent"} 1');

    expect(text).toContain('extract_stage_tokens_total{stage="vision1"} 1500');
    expect(text).not.toContain('extract_stage_tokens_total{stage="tiled"}');
  });

  it("bounds the stage label and ignores invalid values", () => {
    const metrics = new HttpMetrics();
    metrics.recordStage({ stage: "Some/Arbitrary Name", outcome: "done", durationMs: -5, tokens: Number.NaN });
    metrics.recordStage({ stage: "x", outcome: "bogus" as never });
    const text = metrics.render();
    expect(text).toContain('extract_stage_total{stage="other",outcome="done"} 1');
    expect(text).not.toContain('extract_stage_duration_seconds_count{stage="other"}');
    expect(text).not.toContain('extract_stage_tokens_total{stage="other"}');
    expect(text).not.toContain('stage="x"');
  });

  it("exposes the emit backlog gauge", () => {
    const metrics = new HttpMetrics();
    expect(metrics.render()).toContain("extract_emit_outbox_pending 0");
    metrics.setEmitBacklog(42);
    expect(metrics.render()).toContain("extract_emit_outbox_pending 42");
    metrics.setEmitBacklog(-1);
    expect(metrics.render()).toContain("extract_emit_outbox_pending 0");
  });
});
