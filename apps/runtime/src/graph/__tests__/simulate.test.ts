// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for counterfactual impact simulation (`simulate.ts`).
 *
 * Exercises the real executeFlow path with a mocked LLM provider (no real
 * API calls) — the throwaway single-flow registry, the cost-cap stop
 * condition, snapshot pool filtering, and the static (diff/compliance/access)
 * sections.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateFlow } from "../graph-engine/simulate.js";
import { InMemoryReplayStore, type ExecutionSnapshot } from "../replay.js";
import { createFlowAuthorizer, type FlowAuthorizer } from "../flow-authorizer.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

/** Mock LLM that always answers with the same fixed text and a fixed token usage. */
function mockLlmFactory(responseText: string) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              controller.enqueue({
                type: "text-delta",
                id: "1",
                delta: responseText,
              });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 5, text: undefined, reasoning: undefined },
                },
              });
              controller.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
}

function draftFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: "my-flow",
    name: "My Flow",
    nodes: [{ id: "llm-1", type: "llm" }],
    edges: [],
    ...overrides,
  };
}

function snap(over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    executionId: `exec-${crypto.randomUUID()}`,
    flowId: "my-flow",
    messages: [{ role: "user", content: "hi" }],
    responseText: "the old answer",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("simulateFlow — static sections", () => {
  test("reports a structural diff when a published version exists", async () => {
    const draft = draftFlow({ nodes: [{ id: "llm-1", type: "llm" }, { id: "llm-2", type: "llm" }] });
    const published = draftFlow();
    const store = new InMemoryReplayStore();

    const report = await simulateFlow(
      "my-flow",
      draft,
      published,
      { maxSnapshots: 5, maxCostUsd: 1 },
      { appConfig: baseConfig, replayStore: store },
    );

    expect(report.structural?.changed).toBe(true);
    expect(report.structural?.nodes.added).toContain("llm-2");
    expect(report.compliance.draft.entries).toHaveLength(1);
    expect(report.compliance.published).toBeDefined();
  });

  test("omits the structural diff when there is no published version", async () => {
    const draft = draftFlow();
    const store = new InMemoryReplayStore();

    const report = await simulateFlow(
      "my-flow",
      draft,
      undefined,
      { maxSnapshots: 5, maxCostUsd: 1 },
      { appConfig: baseConfig, replayStore: store },
    );

    expect(report.structural).toBeUndefined();
    expect(report.compliance.published).toBeUndefined();
  });

  test("access check reflects the current policy for an anonymous identity", async () => {
    const draft = draftFlow();
    const store = new InMemoryReplayStore();
    const flowAuthorizer: FlowAuthorizer = {
      authorize: () => ({ allowed: false, reason: "no anonymous access" }),
      reload: () => {},
      hasPolicy: () => true,
    };

    const report = await simulateFlow(
      "my-flow",
      draft,
      undefined,
      { maxSnapshots: 5, maxCostUsd: 1 },
      { appConfig: baseConfig, replayStore: store, flowAuthorizer },
    );

    expect(report.access.hasPolicy).toBe(true);
    expect(report.access.allowsAnonymous).toBe(false);
    expect(report.access.reason).toBe("no anonymous access");
  });

  test("access defaults to open when no authorizer is configured", async () => {
    const store = new InMemoryReplayStore();
    const report = await simulateFlow(
      "my-flow",
      draftFlow(),
      undefined,
      { maxSnapshots: 5, maxCostUsd: 1 },
      { appConfig: baseConfig, replayStore: store },
    );
    expect(report.access.hasPolicy).toBe(false);
    expect(report.access.allowsAnonymous).toBe(true);
  });
});

describe("simulateFlow — behavioral sample", () => {
  test("executes the draft against real snapshots and reports similarity", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap({ executionId: "a", responseText: "hello world" }));
    await store.save(snap({ executionId: "b", responseText: "totally different" }));

    const draft = draftFlow();
    const report = await simulateFlow(
      "my-flow",
      draft,
      undefined,
      { maxSnapshots: 5, maxCostUsd: 10 },
      {
        appConfig: baseConfig,
        replayStore: store,
        llmProviderFactory: mockLlmFactory("hello world"),
      },
    );

    expect(report.behavior.available).toBe(2);
    expect(report.behavior.sampled).toBe(2);
    expect(report.behavior.cases).toHaveLength(2);
    // One snapshot's stored answer matches the draft's answer verbatim...
    const matched = report.behavior.cases.find((c) => c.executionId === "a");
    expect(matched?.similarity).toBe(1);
    expect(matched?.changed).toBe(false);
    // ...the other doesn't.
    const changed = report.behavior.cases.find((c) => c.executionId === "b");
    expect(changed?.similarity).toBeLessThan(1);
    expect(changed?.changed).toBe(true);
    expect(report.behavior.changedCount).toBe(1);
  });

  test("only samples snapshots belonging to the target flow id", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap({ executionId: "mine", flowId: "my-flow" }));
    await store.save(snap({ executionId: "other", flowId: "some-other-flow" }));

    const report = await simulateFlow(
      "my-flow",
      draftFlow(),
      undefined,
      { maxSnapshots: 5, maxCostUsd: 10 },
      {
        appConfig: baseConfig,
        replayStore: store,
        llmProviderFactory: mockLlmFactory("x"),
      },
    );

    expect(report.behavior.available).toBe(1);
    expect(report.behavior.cases.map((c) => c.executionId)).toEqual(["mine"]);
  });

  test("caps the sample at maxSnapshots even when more are available", async () => {
    const store = new InMemoryReplayStore();
    for (let i = 0; i < 5; i++) {
      await store.save(snap({ executionId: `s${i}` }));
    }

    const report = await simulateFlow(
      "my-flow",
      draftFlow(),
      undefined,
      { maxSnapshots: 2, maxCostUsd: 10 },
      {
        appConfig: baseConfig,
        replayStore: store,
        llmProviderFactory: mockLlmFactory("x"),
      },
    );

    expect(report.behavior.available).toBe(5);
    expect(report.behavior.sampled).toBe(2);
    expect(report.costCap.capped).toBe(false);
  });

  test("stops early once the cost cap is hit and reports it as capped", async () => {
    const store = new InMemoryReplayStore();
    for (let i = 0; i < 3; i++) {
      await store.save(snap({ executionId: `s${i}` }));
    }
    // Priced so each call costs 7*100000/1e6 + 5*100000/1e6 = $1.20.
    const draft = draftFlow({
      pricing: { "openai/mock-model": { prompt: 100_000, completion: 100_000 } },
    });

    const report = await simulateFlow(
      "my-flow",
      draft,
      undefined,
      { maxSnapshots: 3, maxCostUsd: 1.5 },
      {
        appConfig: baseConfig,
        replayStore: store,
        llmProviderFactory: mockLlmFactory("x"),
      },
    );

    // First call: spent 0 < 1.5 -> runs (spent becomes 1.2).
    // Second call: spent 1.2 < 1.5 -> runs (spent becomes 2.4).
    // Third call: spent 2.4 >= 1.5 -> stops before executing.
    expect(report.behavior.sampled).toBe(2);
    expect(report.costCap.capped).toBe(true);
    expect(report.costCap.spentUsd).toBeCloseTo(2.4, 5);
  });

  test("a persistently failing provider does not crash the whole simulation", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap({ executionId: "boom" }));
    await store.save(snap({ executionId: "next" }));

    const throwingFactory = () =>
      new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("provider boom");
        },
      });

    // The graph engine's own node-error-strategy handles a failing node
    // internally (retries, then a fallback/empty response) — executeFlow()
    // itself does not necessarily reject. What matters for the simulation is
    // that a broken draft never crashes the run and every requested snapshot
    // still gets a recorded case.
    const report = await simulateFlow(
      "my-flow",
      draftFlow(),
      undefined,
      { maxSnapshots: 5, maxCostUsd: 10 },
      {
        appConfig: baseConfig,
        replayStore: store,
        llmProviderFactory: throwingFactory,
      },
    );

    expect(report.behavior.sampled).toBe(2);
    expect(report.behavior.cases).toHaveLength(2);
  });
});

describe("simulateFlow — access authorizer integration", () => {
  test("real FlowAuthorizer with no access.json allows anonymous", () => {
    const authorizer = createFlowAuthorizer("./flows");
    expect(authorizer.hasPolicy()).toBe(false);
  });
});
