// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for graph-engine/error-strategy.ts — NodeErrorHandler
 *
 * Validates: Requirements 5.2, 5.3
 */

import { describe, test, expect } from "bun:test";
import {
  createNodeErrorHandler,
  normaliseSemaphoreError,
  resolveNodeErrorConfig,
  QueueOverflowError,
} from "../graph-engine/error-strategy.js";

import { createFlowSpanManager } from "../graph-engine/spans.js";
import { createTracer } from "../../observability/tracing.js";
import { QueueFullError } from "../semaphore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpanManager() {
  const tracer = createTracer({
    tracingEnabled: true,
    otelServiceName: "test",
  });
  return createFlowSpanManager(tracer, {
    flowId: "test-flow",
    executionId: "exec-1",
    tenantId: "tenant-a",
  });
}

// ---------------------------------------------------------------------------
// NodeErrorHandler Tests
// ---------------------------------------------------------------------------

describe("NodeErrorHandler", () => {
  test("fail-fast strategy returns propagate action", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    // Start the node span (so endNodeSpan can operate)
    spanManager.startNodeSpan("node-1");

    const result = handler.handle("node-1", new Error("boom"), {
      strategy: "fail-fast",
    });

    expect(result.action).toBe("propagate");
    expect(handler.capturedErrors).toHaveLength(0);

    spanManager.endFlow("error");
  });

  test("continue strategy captures the error and returns continue action", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("node-2");

    const result = handler.handle("node-2", new Error("recoverable"), {
      strategy: "continue",
    });

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.captured.nodeId).toBe("node-2");
      expect(result.captured.error.message).toBe("recoverable");
      expect(result.captured.strategy).toBe("continue");
      expect(result.captured.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(handler.capturedErrors).toHaveLength(1);

    spanManager.endFlow("ok");
  });

  test("fallback strategy with fallbackNodeId returns fallback action", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("node-3");

    const result = handler.handle("node-3", new Error("needs fallback"), {
      strategy: "fallback",
      fallbackNodeId: "fallback-node",
    });

    expect(result.action).toBe("fallback");
    if (result.action === "fallback") {
      expect(result.fallbackNodeId).toBe("fallback-node");
      expect(result.captured.nodeId).toBe("node-3");
      expect(result.captured.strategy).toBe("fallback");
    }
    expect(handler.capturedErrors).toHaveLength(1);

    spanManager.endFlow("ok");
  });

  test("fallback strategy without fallbackNodeId degrades to continue", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("node-4");

    const result = handler.handle(
      "node-4",
      new Error("no fallback configured"),
      {
        strategy: "fallback",
      },
    );

    expect(result.action).toBe("continue");
    expect(handler.capturedErrors).toHaveLength(1);

    spanManager.endFlow("ok");
  });

  test("handles non-Error throw values (string)", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("node-5");

    const result = handler.handle("node-5", "string error", {
      strategy: "continue",
    });

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.captured.error.message).toBe("string error");
    }

    spanManager.endFlow("ok");
  });

  test("handles non-Error throw values (object)", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("node-6");

    const result = handler.handle(
      "node-6",
      { code: 42 },
      {
        strategy: "continue",
      },
    );

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.captured.error.message).toContain("42");
    }

    spanManager.endFlow("ok");
  });

  test("accumulates multiple captured errors", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("a");
    handler.handle("a", new Error("err-a"), { strategy: "continue" });

    spanManager.startNodeSpan("b");
    handler.handle("b", new Error("err-b"), { strategy: "continue" });

    spanManager.startNodeSpan("c");
    handler.handle("c", new Error("err-c"), {
      strategy: "fallback",
      fallbackNodeId: "fb",
    });

    expect(handler.capturedErrors).toHaveLength(3);
    const [err0, err1, err2] = handler.capturedErrors;
    if (err0 === undefined || err1 === undefined || err2 === undefined) {
      throw new Error("expected three captured errors");
    }
    expect(err0.nodeId).toBe("a");
    expect(err1.nodeId).toBe("b");
    expect(err2.nodeId).toBe("c");

    spanManager.endFlow("ok");
  });
});

// ---------------------------------------------------------------------------
// Semaphore Overflow Normalisation Tests (Req. 5.3)
// ---------------------------------------------------------------------------

describe("normaliseSemaphoreError", () => {
  test("converts QueueFullError to QueueOverflowError", () => {
    const original = new QueueFullError(100);
    const normalised = normaliseSemaphoreError(original);

    expect(normalised).toBeInstanceOf(QueueOverflowError);
    const qoe = normalised as QueueOverflowError;
    expect(qoe.code).toBe("QUEUE_FULL");
    expect(qoe.httpStatus).toBe(503);
    expect(qoe.maxQueueDepth).toBe(100);
    expect(qoe.message).toContain("concurrency queue is full");
    expect(qoe.cause).toBe(original);
  });

  test("passes through non-QueueFullError unchanged", () => {
    const original = new Error("something else");
    const result = normaliseSemaphoreError(original);
    expect(result).toBe(original);
  });

  test("passes through non-Error values unchanged", () => {
    const result = normaliseSemaphoreError("string error");
    expect(result).toBe("string error");
  });
});

// ---------------------------------------------------------------------------
// resolveNodeErrorConfig Tests
// ---------------------------------------------------------------------------

describe("resolveNodeErrorConfig", () => {
  test("defaults to fail-fast when no config", () => {
    const config = resolveNodeErrorConfig(undefined);
    expect(config.strategy).toBe("fail-fast");
    expect(config.fallbackNodeId).toBeUndefined();
  });

  test("defaults to fail-fast when errorStrategy is not set", () => {
    const config = resolveNodeErrorConfig({ someOtherKey: true });
    expect(config.strategy).toBe("fail-fast");
  });

  test("defaults to fail-fast when errorStrategy is invalid", () => {
    const config = resolveNodeErrorConfig({ errorStrategy: "bogus" });
    expect(config.strategy).toBe("fail-fast");
  });

  test("resolves continue strategy", () => {
    const config = resolveNodeErrorConfig({ errorStrategy: "continue" });
    expect(config.strategy).toBe("continue");
  });

  test("resolves fail-fast strategy explicitly", () => {
    const config = resolveNodeErrorConfig({ errorStrategy: "fail-fast" });
    expect(config.strategy).toBe("fail-fast");
  });

  test("resolves fallback strategy with fallbackNodeId", () => {
    const config = resolveNodeErrorConfig({
      errorStrategy: "fallback",
      fallbackNodeId: "node-fb",
    });
    expect(config.strategy).toBe("fallback");
    expect(config.fallbackNodeId).toBe("node-fb");
  });

  test("resolves fallback strategy without fallbackNodeId", () => {
    const config = resolveNodeErrorConfig({ errorStrategy: "fallback" });
    expect(config.strategy).toBe("fallback");
    expect(config.fallbackNodeId).toBeUndefined();
  });

  test("ignores fallbackNodeId when strategy is not fallback", () => {
    const config = resolveNodeErrorConfig({
      errorStrategy: "continue",
      fallbackNodeId: "should-be-ignored",
    });
    expect(config.strategy).toBe("continue");
    expect(config.fallbackNodeId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Semaphore Overflow + NodeErrorHandler Interaction (Req. 5.3 + 5.2)
// ---------------------------------------------------------------------------

describe("NodeErrorHandler with QueueOverflowError", () => {
  test("continue strategy captures normalised QueueOverflowError", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    // Simulate: semaphore throws QueueFullError → normalised to QueueOverflowError
    const original = new QueueFullError(50);
    const normalised = normaliseSemaphoreError(original) as QueueOverflowError;

    spanManager.startNodeSpan("sem-node-1");
    const result = handler.handle("sem-node-1", normalised, {
      strategy: "continue",
    });

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.captured.error).toBeInstanceOf(QueueOverflowError);
      expect((result.captured.error as QueueOverflowError).code).toBe(
        "QUEUE_FULL",
      );
      expect((result.captured.error as QueueOverflowError).httpStatus).toBe(
        503,
      );
      expect(result.captured.nodeId).toBe("sem-node-1");
      expect(result.captured.strategy).toBe("continue");
    }

    spanManager.endFlow("ok");
  });

  test("fail-fast strategy propagates QueueOverflowError", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    const original = new QueueFullError(100);
    const normalised = normaliseSemaphoreError(original) as QueueOverflowError;

    spanManager.startNodeSpan("sem-node-2");
    const result = handler.handle("sem-node-2", normalised, {
      strategy: "fail-fast",
    });

    expect(result.action).toBe("propagate");
    expect(handler.capturedErrors).toHaveLength(0);

    spanManager.endFlow("error");
  });

  test("fallback strategy routes QueueOverflowError to fallback node", () => {
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    const original = new QueueFullError(25);
    const normalised = normaliseSemaphoreError(original) as QueueOverflowError;

    spanManager.startNodeSpan("sem-node-3");
    const result = handler.handle("sem-node-3", normalised, {
      strategy: "fallback",
      fallbackNodeId: "queue-fallback",
    });

    expect(result.action).toBe("fallback");
    if (result.action === "fallback") {
      expect(result.fallbackNodeId).toBe("queue-fallback");
      expect(result.captured.error).toBeInstanceOf(QueueOverflowError);
      expect((result.captured.error as QueueOverflowError).maxQueueDepth).toBe(
        25,
      );
      expect(result.captured.nodeId).toBe("sem-node-3");
    }

    spanManager.endFlow("ok");
  });

  test("Semaphore acquire overflow → normalise → handler end-to-end", async () => {
    const { Semaphore } = await import("../semaphore.js");

    // Semaphore: 1 slot, queue depth of 1, fill both slots
    const sem = new Semaphore(1, 1);
    await sem.acquire(); // uses the 1 slot
    // One waiter occupies the queue
    void sem.acquire(); // fills the queue (depth 1)

    // Next acquire must throw QueueFullError
    let thrown: unknown;
    try {
      await sem.acquire();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(QueueFullError);
    const normalised = normaliseSemaphoreError(thrown);
    expect(normalised).toBeInstanceOf(QueueOverflowError);

    // Feed into NodeErrorHandler
    const spanManager = makeSpanManager();
    const handler = createNodeErrorHandler(spanManager);

    spanManager.startNodeSpan("overflow-node");
    const result = handler.handle("overflow-node", normalised, {
      strategy: "continue",
    });

    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.captured.error).toBeInstanceOf(QueueOverflowError);
      expect((result.captured.error as QueueOverflowError).code).toBe(
        "QUEUE_FULL",
      );
      expect((result.captured.error as QueueOverflowError).httpStatus).toBe(
        503,
      );
    }

    spanManager.endFlow("ok");
    sem.release(); // Clean up
  });
});

// ---------------------------------------------------------------------------
// QueueOverflowError Tests
// ---------------------------------------------------------------------------

describe("QueueOverflowError", () => {
  test("has correct properties", () => {
    const err = new QueueOverflowError(50);
    expect(err.name).toBe("QueueOverflowError");
    expect(err.code).toBe("QUEUE_FULL");
    expect(err.httpStatus).toBe(503);
    expect(err.maxQueueDepth).toBe(50);
    expect(err.message).toContain("50");
    expect(err).toBeInstanceOf(Error);
  });

  test("preserves cause", () => {
    const cause = new Error("original");
    const err = new QueueOverflowError(10, cause);
    expect(err.cause).toBe(cause);
  });
});
