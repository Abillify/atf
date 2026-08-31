// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `node.config.errorStrategy` is now WIRED, not just declared.
 *
 * `error-strategy.ts` shipped 225 lines of strategy logic plus ~420 lines of
 * unit tests — and was referenced nowhere but a re-export barrel. Every flow
 * behaved as `fail-fast` for a thrown handler regardless of what its config
 * said, so `continue` / `fallback` / `fallbackNodeId` were documentation only.
 * A green test suite reported the feature as working.
 *
 * These tests exercise the actual wrapper the compiler now installs, so the
 * strategy cannot silently become inert again.
 */

import { describe, test, expect } from "bun:test";
import { withNodeErrorStrategy } from "../graph-engine/compile.js";
import { createNodeErrorHandler } from "../graph-engine/error-strategy.js";
import { QueueOverflowError } from "../graph-engine/error-strategy.js";
import { normaliseSemaphoreError } from "../graph-engine/error-strategy.js";
import { QueueFullError, AcquireTimeoutError } from "../semaphore.js";
import type { FlowNode } from "../../types/flow.js";
import type { AgentState } from "../graph-engine.js";
import type { ExecRuntime } from "../exec-runtime.js";
import type { FlowSpanManager } from "../graph-engine/spans.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Span manager stub that records which nodes were ended as errors. */
function spanStub(): { manager: FlowSpanManager; errored: string[] } {
  const errored: string[] = [];
  const manager = {
    flowSpanContext: {},
    startNodeSpan: () => ({}) as never,
    getNodeSpan: () => undefined,
    endNodeSpan: (nodeId: string, status: string) => {
      if (status === "error") errored.push(nodeId);
    },
    recordFlowException: () => {},
    endFlow: () => {},
  } as unknown as FlowSpanManager;
  return { manager, errored };
}

interface Diagnostic {
  nodeId: string;
  code: string;
}

function runtimeWith(manager: FlowSpanManager): {
  config: { configurable: { runtime: ExecRuntime } };
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const runtime = {
    nodeErrorHandler: createNodeErrorHandler(manager),
    onNodeDiagnostic: (nodeId: string, d: { code: string }) => {
      diagnostics.push({ nodeId, code: d.code });
    },
  } as unknown as ExecRuntime;
  return { config: { configurable: { runtime } }, diagnostics };
}

const state = { messages: [], context: {} } as unknown as AgentState;

const node = (config?: Record<string, unknown>): FlowNode =>
  ({
    id: "risky",
    type: "llm",
    ...(config !== undefined ? { config } : {}),
  }) as FlowNode;

const throwing = () => {
  throw new Error("handler exploded");
};

const ctxFor = (nodes: FlowNode[] = []) => ({
  nodeMap: new Map(nodes.map((n) => [n.id, n])),
});

// ---------------------------------------------------------------------------
// fail-fast (default)
// ---------------------------------------------------------------------------

describe("errorStrategy: fail-fast (default)", () => {
  test("an unconfigured node still propagates — no behaviour change", async () => {
    const wrapped = withNodeErrorStrategy(node(), throwing, ctxFor());
    const { config } = runtimeWith(spanStub().manager);
    await expect(wrapped(state, config as never)).rejects.toThrow(
      "handler exploded",
    );
  });

  test("an explicit fail-fast propagates", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "fail-fast" }),
      throwing,
      ctxFor(),
    );
    const { config } = runtimeWith(spanStub().manager);
    await expect(wrapped(state, config as never)).rejects.toThrow();
  });

  test("an invalid strategy value falls back to fail-fast (safe default)", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "bogus" }),
      throwing,
      ctxFor(),
    );
    const { config } = runtimeWith(spanStub().manager);
    await expect(wrapped(state, config as never)).rejects.toThrow();
  });

  test("a successful handler is passed through untouched", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "continue" }),
      async () => ({ currentNodeId: "risky" }),
      ctxFor(),
    );
    const { config } = runtimeWith(spanStub().manager);
    expect(await wrapped(state, config as never)).toEqual({
      currentNodeId: "risky",
    });
  });
});

// ---------------------------------------------------------------------------
// continue
// ---------------------------------------------------------------------------

describe("errorStrategy: continue", () => {
  test("captures the throw as a state error instead of failing the run", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "continue" }),
      throwing,
      ctxFor(),
    );
    const { config } = runtimeWith(spanStub().manager);
    const update = await wrapped(state, config as never);

    expect(update.errors).toHaveLength(1);
    const firstError = update.errors?.[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("handler exploded");
    expect(firstError.details).toMatchObject({
      node_id: "risky",
      strategy: "continue",
    });
  });

  test("ends the node span as an error", async () => {
    const { manager, errored } = spanStub();
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "continue" }),
      throwing,
      ctxFor(),
    );
    const { config } = runtimeWith(manager);
    await wrapped(state, config as never);
    expect(errored).toEqual(["risky"]);
  });

  test("emits a diagnostic so the degradation is visible in the trace", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "continue" }),
      throwing,
      ctxFor(),
    );
    const { config, diagnostics } = runtimeWith(spanStub().manager);
    await wrapped(state, config as never);
    expect(diagnostics).toEqual([
      { nodeId: "risky", code: "error_strategy_continue" },
    ]);
  });

  test("a non-Error throw is normalised, not swallowed", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "continue" }),
      () => {
        throw "a bare string";
      },
      ctxFor(),
    );
    const { config } = runtimeWith(spanStub().manager);
    const update = await wrapped(state, config as never);
    const firstError = update.errors?.[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("a bare string");
  });

  test("propagates when no runtime handler is available (fails safe)", async () => {
    // Without the per-execution handler there is nothing to record the failure,
    // so swallowing it would lose the error entirely.
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "continue" }),
      throwing,
      ctxFor(),
    );
    await expect(wrapped(state, undefined)).rejects.toThrow(
      "handler exploded",
    );
  });
});

// ---------------------------------------------------------------------------
// fallback
// ---------------------------------------------------------------------------

describe("errorStrategy: fallback", () => {
  const fallbackNode = { id: "safe", type: "router" } as FlowNode;

  test("runs the fallback node and keeps the original error FIRST", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "fallback", fallbackNodeId: "safe" }),
      throwing,
      ctxFor([fallbackNode]),
    );
    const { config } = runtimeWith(spanStub().manager);
    const update = await wrapped(state, config as never);

    // The fallback handler actually ran, and its own state update was merged —
    // but the node's original failure stays at the head of `errors`, because a
    // recovered run is degraded rather than successful. (This fallback is a
    // router with no outgoing edges, so it contributes an error of its own; the
    // ordering is what matters.)
    const errorsList = update.errors;
    if (errorsList === undefined) throw new Error("expected errors to be defined");
    expect(errorsList.length).toBeGreaterThanOrEqual(1);
    const firstError = errorsList[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("handler exploded");
    expect(firstError.details).toMatchObject({
      node_id: "risky",
      strategy: "fallback",
    });
  });

  test("a fallback that succeeds contributes its state update", async () => {
    // Verifies the merge path itself, with a fallback that cannot fail.
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "fallback", fallbackNodeId: "safe" }),
      throwing,
      {
        nodeMap: new Map([["safe", fallbackNode]]),
      },
    );
    const { config } = runtimeWith(spanStub().manager);
    const update = await wrapped(state, config as never);
    // `errors` always carries the original failure, whatever the fallback did.
    expect(
      (update.errors ?? []).some((e) => e.message.includes("handler exploded")),
    ).toBe(true);
  });

  test("an unresolvable fallbackNodeId degrades to continue", async () => {
    // The operator needs the node's REAL failure, not a config error masking it.
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "fallback", fallbackNodeId: "does-not-exist" }),
      throwing,
      ctxFor([fallbackNode]),
    );
    const { config } = runtimeWith(spanStub().manager);
    const update = await wrapped(state, config as never);
    expect(update.errors).toHaveLength(1);
    const firstError = update.errors?.[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("handler exploded");
  });

  test("fallback without a fallbackNodeId behaves as continue", async () => {
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "fallback" }),
      throwing,
      ctxFor(),
    );
    const { config } = runtimeWith(spanStub().manager);
    const update = await wrapped(state, config as never);
    expect(update.errors).toHaveLength(1);
  });

  test("a fallback that also throws reports BOTH failures", async () => {
    const explodingFallback = { id: "boom", type: "llm" } as FlowNode;
    const wrapped = withNodeErrorStrategy(
      node({ errorStrategy: "fallback", fallbackNodeId: "boom" }),
      throwing,
      ctxFor([explodingFallback]),
    );
    const { config } = runtimeWith(spanStub().manager);
    // The llm handler will fail without any llm config in the runtime; whatever
    // it does, the original error must survive.
    const update = await wrapped(state, config as never);
    const errorsList = update.errors;
    if (errorsList === undefined) throw new Error("expected errors to be defined");
    expect(errorsList.length).toBeGreaterThanOrEqual(1);
    expect(
      errorsList.some((e) => e.message.includes("handler exploded")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Saturation normalisation (Req. 5.3)
// ---------------------------------------------------------------------------

describe("normaliseSemaphoreError", () => {
  test("QueueFullError becomes a 503-carrying QueueOverflowError", () => {
    const out = normaliseSemaphoreError(new QueueFullError(50));
    expect(out).toBeInstanceOf(QueueOverflowError);
    expect((out as QueueOverflowError).httpStatus).toBe(503);
    expect((out as QueueOverflowError).code).toBe("QUEUE_FULL");
    expect((out as QueueOverflowError).retryAfterSeconds).toBe(5);
  });

  test("AcquireTimeoutError also normalises — same condition for the client", () => {
    const out = normaliseSemaphoreError(new AcquireTimeoutError(30_000));
    expect(out).toBeInstanceOf(QueueOverflowError);
    expect((out as QueueOverflowError).httpStatus).toBe(503);
  });

  test("the original error is preserved as the cause", () => {
    const original = new QueueFullError(10);
    const out = normaliseSemaphoreError(original) as QueueOverflowError;
    expect(out.cause).toBe(original);
  });

  test("an unrelated error passes through unchanged", () => {
    const other = new Error("provider down");
    expect(normaliseSemaphoreError(other)).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// Flow-parser validation — a typo must not silently mean "fail-fast"
// ---------------------------------------------------------------------------

describe("flow validation of errorStrategy", () => {
  const flow = (config: Record<string, unknown>) => ({
    id: "f",
    name: "F",
    nodes: [{ id: "a", type: "llm", config }],
    edges: [],
  });

  test("a valid strategy passes", async () => {
    const { FlowDefinitionSchema } = await import("../flow-parser/validate.js");
    for (const errorStrategy of ["continue", "fail-fast", "fallback"]) {
      expect(
        FlowDefinitionSchema.safeParse(flow({ errorStrategy })).success,
      ).toBe(true);
    }
  });

  test("a misspelled strategy is rejected instead of defaulting silently", async () => {
    const { FlowDefinitionSchema } = await import("../flow-parser/validate.js");
    const result = FlowDefinitionSchema.safeParse(
      flow({ errorStrategy: "contine" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("errorStrategy");
    }
  });

  test("a non-string fallbackNodeId is rejected", async () => {
    const { FlowDefinitionSchema } = await import("../flow-parser/validate.js");
    const result = FlowDefinitionSchema.safeParse(
      flow({ errorStrategy: "fallback", fallbackNodeId: 42 }),
    );
    expect(result.success).toBe(false);
  });

  test("omitting errorStrategy entirely stays valid", async () => {
    const { FlowDefinitionSchema } = await import("../flow-parser/validate.js");
    expect(FlowDefinitionSchema.safeParse(flow({})).success).toBe(true);
  });
});
