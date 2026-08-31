// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the metrics registry (src/observability/metrics.ts)
 */

import { describe, test, expect } from "bun:test";
import { createMetrics } from "../metrics.js";

describe("Metrics registry", () => {
  test("renders Prometheus counters with labels", () => {
    const m = createMetrics(true);
    m.recordRequest("/v1/chat/completions", 200, 12);
    m.recordRequest("/v1/chat/completions", 200, 20);
    const out = m.render();
    expect(out).toContain("# TYPE aiperator_requests_total counter");
    expect(out).toContain(
      'aiperator_requests_total{route="/v1/chat/completions",status="200"} 2',
    );
    // Histogram series present
    expect(out).toContain("aiperator_request_duration_ms_bucket");
    expect(out).toContain("aiperator_request_duration_ms_count");
  });

  test("aggregates LLM tokens and cost into the summary", () => {
    const m = createMetrics(true);
    m.recordLlmCall("openai", "gpt-4o", "ok", 100, 50, 0.001);
    m.recordLlmCall("openai", "gpt-4o", "ok", 200, 80, 0.002);
    m.recordLlmCall("openai", "gpt-4o", "error", 0, 0, 0);
    const s = m.summary();
    expect(s.tokensPrompt).toBe(300);
    expect(s.tokensCompletion).toBe(130);
    expect(s.llmCallsTotal).toBe(3);
    expect(s.llmErrorsTotal).toBe(1);
    expect(s.costTotal).toBeCloseTo(0.003, 6);
    expect(s.costByModel["openai/gpt-4o"]).toBeCloseTo(0.003, 6);
    expect(s.tokensByModel["openai/gpt-4o"]).toEqual({
      prompt: 300,
      completion: 130,
    });
  });

  test("tracks node executions, errors and average latency", () => {
    const m = createMetrics(true);
    m.recordNode("flow-a", "n1", "completed", 100);
    m.recordNode("flow-a", "n2", "error", 300);
    const s = m.summary();
    expect(s.nodeExecutionsTotal).toBe(2);
    expect(s.nodeErrorsTotal).toBe(1);
    expect(s.avgNodeLatencyMs).toBe(200);
  });

  test("reflects gauges in summary", () => {
    const m = createMetrics(true);
    m.setActiveExecutions(7);
    m.setQueueDepth(3);
    const s = m.summary();
    expect(s.activeExecutions).toBe(7);
    expect(s.queueDepth).toBe(3);
  });

  test("disabled metrics are a no-op", () => {
    const m = createMetrics(false);
    m.recordRequest("/x", 200, 5);
    expect(m.render()).toBe("");
    expect(m.summary().requestsTotal).toBe(0);
  });
});
