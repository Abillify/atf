// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for graph-engine/spans.ts — FlowSpanManager
 *
 * Validates: Requirements 5.1
 */

import { describe, test, expect } from "bun:test";
import { createFlowSpanManager } from "../graph-engine/spans.js";
import { createTracer } from "../../observability/tracing.js";
import type { SpanContext } from "../../observability/tracing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a no-op tracer for testing span lifecycle without export. */
function noopTracer() {
  return createTracer({ tracingEnabled: false });
}

/** Creates a real (enabled) tracer without an endpoint (logs spans only). */
function enabledTracer() {
  return createTracer({ tracingEnabled: true, otelServiceName: "test" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlowSpanManager", () => {
  test("creates a flow span with correct context propagation", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "test-flow",
      executionId: "exec-1",
      tenantId: "tenant-a",
    });

    const ctx = mgr.flowSpanContext;
    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.spanId).toHaveLength(16);
    expect(ctx.sampled).toBe(true);

    mgr.endFlow("ok");
  });

  test("creates child node spans linked to the flow span", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-1",
      executionId: "exec-2",
    });

    const nodeSpan = mgr.startNodeSpan("node-a");
    const nodeCtx = nodeSpan.spanContext();

    // Node span shares the same traceId as the flow span (parent-child relationship).
    expect(nodeCtx.traceId).toBe(mgr.flowSpanContext.traceId);
    // But has its own unique spanId.
    expect(nodeCtx.spanId).not.toBe(mgr.flowSpanContext.spanId);
    expect(nodeCtx.spanId).toHaveLength(16);

    mgr.endNodeSpan("node-a", "ok");
    mgr.endFlow("ok");
  });

  test("getNodeSpan returns the active span", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-1",
      executionId: "exec-3",
    });

    expect(mgr.getNodeSpan("node-x")).toBeUndefined();

    mgr.startNodeSpan("node-x");
    expect(mgr.getNodeSpan("node-x")).toBeDefined();

    mgr.endNodeSpan("node-x", "ok");
    // After ending, the span is no longer tracked.
    expect(mgr.getNodeSpan("node-x")).toBeUndefined();

    mgr.endFlow("ok");
  });

  test("endNodeSpan with error sets error status", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-1",
      executionId: "exec-4",
    });

    mgr.startNodeSpan("failing-node");
    // Should not throw
    mgr.endNodeSpan("failing-node", "error", "something went wrong", {
      "aiperator.latency_ms": 42,
    });

    mgr.endFlow("error");
  });

  test("endFlow closes all dangling node spans", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-1",
      executionId: "exec-5",
    });

    mgr.startNodeSpan("node-1");
    mgr.startNodeSpan("node-2");
    // Don't explicitly end the node spans — endFlow should handle it.
    mgr.endFlow("ok");

    // After endFlow, node spans are no longer accessible.
    expect(mgr.getNodeSpan("node-1")).toBeUndefined();
    expect(mgr.getNodeSpan("node-2")).toBeUndefined();
  });

  test("endFlow is idempotent", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-1",
      executionId: "exec-6",
    });

    mgr.endFlow("ok");
    // Second call should not throw.
    mgr.endFlow("error");
  });

  test("recordFlowException does not throw", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-1",
      executionId: "exec-7",
    });

    mgr.recordFlowException(new Error("test error"));
    mgr.recordFlowException("string error");
    mgr.endFlow("error");
  });

  test("works with a no-op tracer (zero-cost path)", () => {
    const tracer = noopTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-noop",
      executionId: "exec-noop",
    });

    const nodeSpan = mgr.startNodeSpan("node-noop");
    expect(nodeSpan).toBeDefined();

    mgr.endNodeSpan("node-noop", "ok");
    mgr.endFlow("ok");
  });

  test("respects parent trace context for cross-service correlation", () => {
    const tracer = enabledTracer();
    const parentContext: SpanContext = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      sampled: true,
    };

    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-child",
      executionId: "exec-child",
      parentContext,
    });

    // The flow span inherits the parent's traceId.
    expect(mgr.flowSpanContext.traceId).toBe("a".repeat(32));
    // But has its own spanId.
    expect(mgr.flowSpanContext.spanId).not.toBe("b".repeat(16));

    mgr.endFlow("ok");
  });

  test("startNodeSpan accepts custom attributes", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-attrs",
      executionId: "exec-attrs",
    });

    // Should not throw when passing extra attributes.
    const span = mgr.startNodeSpan("node-typed", {
      "aiperator.node_type": "llm",
    });
    expect(span).toBeDefined();

    mgr.endNodeSpan("node-typed", "ok");
    mgr.endFlow("ok");
  });

  test("endNodeSpan on unknown nodeId is a no-op", () => {
    const tracer = enabledTracer();
    const mgr = createFlowSpanManager(tracer, {
      flowId: "flow-safe",
      executionId: "exec-safe",
    });

    // Should not throw for an untracked nodeId.
    mgr.endNodeSpan("nonexistent", "ok");
    mgr.endFlow("ok");
  });
});
