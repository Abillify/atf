// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Test for the hard execution timeout (Fix #3).
 *
 * A model whose stream never finishes would otherwise hold a concurrency slot
 * forever. With executionTimeoutMs set, executeFlow must abort, emit a timeout
 * error chunk, and resolve so the semaphore slot is released.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";

const config: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  executionTimeoutMs: 100,
};

const flow: FlowDefinition = {
  id: "hang-flow",
  name: "Hang",
  nodes: [
    { id: "llm", type: "llm", llm: { provider: "ollama", model: "test" } },
  ],
  edges: [],
};

/** A model whose stream emits nothing and never closes — simulates a hung provider. */
function hangingModelFactory() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start() {
          /* never enqueue, never close */
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

function makeCtx(): RequestContext {
  return { ssoToken: "a.b.c", executionId: "exec-timeout" };
}

describe("Graph engine — execution timeout", () => {
  test("aborts a hung execution, emits a timeout error chunk, and resolves", async () => {
    const engine = createGraphEngine(config, {
    flowRegistry: { get: () => flow, list: () => [flow] },
    llmProviderFactory: hangingModelFactory as never,
  });

    const chunks: ChatCompletionChunk[] = [];
    let done = false;

    const exec = engine
      .executeFlow(
        "hang-flow",
        [{ role: "user", content: "hi" }],
        makeCtx(),
        async (c) => {
          chunks.push(c);
        },
        async () => {
          done = true;
        },
      )
      .then(() => "resolved" as const);

    // Guard: the call must resolve well before this watchdog fires.
    const watchdog = new Promise<"hung">((resolve) =>
      setTimeout(() => resolve("hung"), 3000),
    );

    const outcome = await Promise.race([exec, watchdog]);
    expect(outcome).toBe("resolved");
    expect(done).toBe(true);

    const errorChunk = chunks.find(
      (c) => c.choices[0]?.finish_reason === "error",
    );
    expect(errorChunk).toBeDefined();
    const withErr = errorChunk as ChatCompletionChunk & {
      error?: { message: string };
    };
    expect(withErr.error?.message).toContain("timeout");
  });
});
