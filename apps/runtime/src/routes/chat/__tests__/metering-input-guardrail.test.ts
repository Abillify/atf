// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the model-classifier observability inside
 * `evaluateInputGuardrail` (chat/metering.ts) — Requirement 7.5: every
 * classifier failure (fail-open AND fail-closed) must emit a metric and a
 * trace diagnosis; Requirement 7.6: chunked classification of long input is
 * observable too.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { evaluateInputGuardrail } from "../metering.js";
import { InputGuardrail } from "../../../graph/input-guardrails.js";
import type {
  ModelClassifierResult,
  ModelInputClassify,
} from "../../../graph/input-guardrail-model.js";
import type { RequestContext } from "../../../types/monitoring.js";
import type { Metrics } from "../../../observability/metrics.js";

const BASE_REQUEST_CTX: RequestContext = {
  ssoToken: "test-token",
  executionId: "exec-1",
};

const MESSAGES = [{ role: "user", content: "hello world" }] as never;

interface CounterCall {
  name: string;
  labels: Record<string, string>;
}

/** Metrics fake recording recordCounter calls. */
function metricsFake(): { metrics: Metrics; counters: CounterCall[] } {
  const counters: CounterCall[] = [];
  const metrics = {
    recordCounter: (name: string, labels: Record<string, string>) => {
      counters.push({ name, labels });
    },
    recordRejected: () => {},
  } as unknown as Metrics;
  return { metrics, counters };
}

function classifyReturning(result: ModelClassifierResult): ModelInputClassify {
  return async () => result;
}

/** Runs evaluateInputGuardrail inside a Hono context. */
async function run(opts: {
  classify: ModelInputClassify;
  mode?: "flag" | "block";
  metrics?: Metrics;
}) {
  const app = new Hono();
  let outcome: Awaited<ReturnType<typeof evaluateInputGuardrail>> | undefined;
  app.get("/", async (c) => {
    outcome = await evaluateInputGuardrail({
      messages: MESSAGES,
      flowId: "f1",
      requestCtx: BASE_REQUEST_CTX,
      ctx: c,
      inputGuardrail: new InputGuardrail(),
      inputGuardrailMode: opts.mode ?? "flag",
      inputGuardrailClassify: opts.classify,
      // 0 → the model layer always runs, independent of the heuristic score.
      inputGuardrailModelMinScore: 0,
      metrics: opts.metrics,
    });
    if (outcome.blocked) return outcome.response;
    return c.json({ ok: true });
  });
  const response = await app.request("/");
  if (outcome === undefined) throw new Error("evaluateInputGuardrail not run");
  if (outcome.blocked) {
    return { blocked: true as const, response, params: undefined };
  }
  return {
    blocked: false as const,
    response,
    params: outcome.requestCtxPatch?.requestParams as
      | Record<string, unknown>
      | undefined,
  };
}

describe("evaluateInputGuardrail — model classifier degradation (Req 7.5)", () => {
  it("fail-open: counts the degraded metric and patches the trace diagnosis", async () => {
    const { metrics, counters } = metricsFake();
    const { blocked, params } = await run({
      metrics,
      classify: classifyReturning({
        score: 0,
        isInjection: false,
        degraded: { failMode: "open", error: "provider down" },
      }),
    });
    expect(blocked).toBe(false);
    expect(counters).toContainEqual({
      name: "aiperator_input_guardrail_model_degraded_total",
      labels: { fail_mode: "open" },
    });
    expect(params?.inputGuardrailClassifierDegraded).toBe("open");
    expect(params?.inputGuardrailClassifierError).toBe("provider down");
  });

  it("fail-closed: counts the degraded metric and blocks in block mode", async () => {
    const { metrics, counters } = metricsFake();
    const { blocked, response } = await run({
      mode: "block",
      metrics,
      classify: classifyReturning({
        score: 1,
        isInjection: true,
        reason: "classifier_unavailable",
        degraded: { failMode: "closed", error: "timeout" },
      }),
    });
    expect(blocked).toBe(true);
    expect(response.status).toBe(422);
    expect(counters).toContainEqual({
      name: "aiperator_input_guardrail_model_degraded_total",
      labels: { fail_mode: "closed" },
    });
  });

  it("healthy classification emits no degraded metric or diagnosis", async () => {
    const { metrics, counters } = metricsFake();
    const { blocked, params } = await run({
      metrics,
      classify: classifyReturning({ score: 0, isInjection: false }),
    });
    expect(blocked).toBe(false);
    expect(
      counters.some(
        (c) => c.name === "aiperator_input_guardrail_model_degraded_total",
      ),
    ).toBe(false);
    expect(params).toBeUndefined();
  });
});

describe("evaluateInputGuardrail — chunked classification (Req 7.6)", () => {
  it("counts the chunked metric and records the chunk count in the trace", async () => {
    const { metrics, counters } = metricsFake();
    const { blocked, params } = await run({
      metrics,
      classify: classifyReturning({
        score: 0.4,
        isInjection: false,
        chunks: 3,
      }),
    });
    expect(blocked).toBe(false);
    expect(counters).toContainEqual({
      name: "aiperator_input_guardrail_model_chunked_total",
      labels: {},
    });
    expect(params?.inputGuardrailChunks).toBe(3);
    expect(params?.inputRiskScore).toBe(0.4);
  });

  it("single-chunk results carry no chunk marker", async () => {
    const { metrics, counters } = metricsFake();
    const { params } = await run({
      metrics,
      classify: classifyReturning({ score: 0.2, isInjection: false, chunks: 1 }),
    });
    expect(
      counters.some(
        (c) => c.name === "aiperator_input_guardrail_model_chunked_total",
      ),
    ).toBe(false);
    expect(params?.inputGuardrailChunks).toBeUndefined();
  });
});
