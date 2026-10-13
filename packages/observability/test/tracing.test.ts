// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  createTracer,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  NOOP_TRACER,
  parseTraceparent,
  type Tracer,
} from "../src/index.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function stubFetch(calls: { url: string; body: unknown }[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
}

// biome-ignore lint/suspicious/noExplicitAny: test-only traversal of OTLP JSON
type OtlpJson = any;

/** Extracts the exported spans from the n-th OTLP request captured by stubFetch. */
function exportedSpans(
  calls: { url: string; body: unknown }[],
  n = 0,
): OtlpJson[] {
  const payload = calls[n]?.body as OtlpJson;
  return payload.resourceSpans[0].scopeSpans[0].spans as OtlpJson[];
}

describe("W3C trace context", () => {
  test("parseTraceparent accepts a valid sampled header", () => {
    const ctx = parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(ctx).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
  });

  test("parseTraceparent reads the sampled flag", () => {
    const ctx = parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`);
    expect(ctx?.sampled).toBe(false);
  });

  test("parseTraceparent lowercases ids", () => {
    const ctx = parseTraceparent(
      `00-${TRACE_ID.toUpperCase()}-${SPAN_ID.toUpperCase()}-01`,
    );
    expect(ctx?.traceId).toBe(TRACE_ID);
    expect(ctx?.spanId).toBe(SPAN_ID);
  });

  test("parseTraceparent rejects malformed values", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent("")).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-xyz03331-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
  });

  test("formatTraceparent round-trips", () => {
    const ctx = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true };
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
  });

  test("generated ids have the right shape", () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("createTracer — disabled (default)", () => {
  test("returns a noop tracer", async () => {
    const tracer = createTracer({});
    expect(tracer.enabled).toBe(false);
    const span = tracer.startSpan("x");
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    span.setAttribute("k", "v").setStatus("ok").end();
    await tracer.flush();
    await tracer.shutdown();
  });

  test("NOOP_TRACER keeps parent trace id for propagation", () => {
    const parent = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true };
    const span = NOOP_TRACER.startSpan("child", { parent });
    expect(span.spanContext().traceId).toBe(TRACE_ID);
  });
});

describe("createTracer — enabled, no endpoint (log-only)", () => {
  test("emits debug log lines instead of exporting", async () => {
    const logged: Record<string, unknown>[] = [];
    const logger = {
      debug: (_m: string, fields?: Record<string, unknown>) => {
        if (fields) logged.push(fields);
      },
      warn: () => {},
    };
    const tracer = createTracer(
      { tracingEnabled: true, otelServiceName: "svc" },
      logger,
    );
    expect(tracer.enabled).toBe(true);
    tracer.startSpan("op", { kind: "server" }).end();
    await tracer.flush();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.["name"]).toBe("op");
    await tracer.shutdown();
  });
});

describe("createTracer — enabled with OTLP endpoint", () => {
  function makeTracer(): {
    tracer: Tracer;
    calls: { url: string; body: unknown }[];
  } {
    const calls: { url: string; body: unknown }[] = [];
    const tracer = createTracer(
      {
        tracingEnabled: true,
        otelExporterOtlpEndpoint: "http://collector:4318/v1/traces",
        otelServiceName: "atf-search",
      },
      undefined,
      { fetchFn: stubFetch(calls), flushIntervalMs: 60_000 },
    );
    return { tracer, calls };
  }

  test("exports OTLP/HTTP JSON with resource and scope", async () => {
    const { tracer, calls } = makeTracer();
    const span = tracer.startSpan("GET /search", {
      kind: "server",
      attributes: { "http.method": "GET", "http.status_code": 200 },
    });
    span.setStatus("ok");
    span.end();
    await tracer.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://collector:4318/v1/traces");
    const payload = calls[0]?.body as OtlpJson;
    const svcName = payload.resourceSpans[0].resource.attributes[0];
    expect(svcName).toEqual({
      key: "service.name",
      value: { stringValue: "atf-search" },
    });
    const spans = exportedSpans(calls);
    expect(spans).toHaveLength(1);
    const out = spans[0];
    expect(out["name"]).toBe("GET /search");
    expect(out["kind"]).toBe(2); // server
    expect(out["status"]).toEqual({ code: 1 }); // ok
    // intValue is serialised as a string per OTLP JSON
    const attrs = out["attributes"] as Record<string, unknown>[];
    expect(attrs).toContainEqual({
      key: "http.status_code",
      value: { intValue: "200" },
    });
    expect(attrs).toContainEqual({
      key: "http.method",
      value: { stringValue: "GET" },
    });
    await tracer.shutdown();
  });

  test("child spans link to their parent", async () => {
    const { tracer, calls } = makeTracer();
    const parent = tracer.startSpan("parent", { kind: "server" });
    tracer
      .startSpan("child", { parent: parent.spanContext(), kind: "client" })
      .end();
    parent.end();
    await tracer.flush();
    const spans = exportedSpans(calls);
    const child = spans.find((s) => s["name"] === "child");
    const par = spans.find((s) => s["name"] === "parent");
    expect(child?.["parentSpanId"]).toBe(par?.["spanId"]);
    expect(child?.["traceId"]).toBe(par?.["traceId"]);
    expect(child?.["kind"]).toBe(3); // client
    await tracer.shutdown();
  });

  test("recordException marks the span as error", async () => {
    const { tracer, calls } = makeTracer();
    const span = tracer.startSpan("boom");
    span.recordException(new Error("kaputt"));
    span.end();
    await tracer.flush();
    const out = exportedSpans(calls)[0];
    expect(out["status"]).toEqual({ code: 2, message: "kaputt" });
    await tracer.shutdown();
  });

  test("maxBatch triggers an automatic flush", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const tracer = createTracer(
      {
        tracingEnabled: true,
        otelExporterOtlpEndpoint: "http://c/v1/traces",
        otelServiceName: "x",
      },
      undefined,
      { fetchFn: stubFetch(calls), maxBatch: 2, flushIntervalMs: 60_000 },
    );
    tracer.startSpan("a").end();
    expect(calls).toHaveLength(0);
    tracer.startSpan("b").end();
    // flush is async — give the microtask queue a turn
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    await tracer.shutdown();
  });

  test("shutdown flushes remaining spans", async () => {
    const { tracer, calls } = makeTracer();
    tracer.startSpan("late").end();
    await tracer.shutdown();
    expect(calls).toHaveLength(1);
  });

  test("export failures are swallowed and logged", async () => {
    const warned: Record<string, unknown>[] = [];
    const logger = {
      debug: () => {},
      warn: (_m: string, fields?: Record<string, unknown>) => {
        if (fields) warned.push(fields);
      },
    };
    const failing = (async () => {
      throw new Error("collector down");
    }) as unknown as typeof fetch;
    const tracer = createTracer(
      {
        tracingEnabled: true,
        otelExporterOtlpEndpoint: "http://c/v1/traces",
        otelServiceName: "x",
      },
      logger,
      { fetchFn: failing, flushIntervalMs: 60_000 },
    );
    tracer.startSpan("op").end();
    await tracer.flush();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.["error"]).toBe("collector down");
    await tracer.shutdown();
  });
});
