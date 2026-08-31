// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `MEMORY_TOP_K` is actually read.
 *
 * The env var was parsed into `AppConfig.memoryTopK` and then never consumed:
 * the memory handler only looked at its own `node.config.topK` and fell back to a
 * hard-coded 5. A deployment that configured the global default saw no effect,
 * with nothing reporting that the setting was inert.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// MEMORY_TOP_K — the global default is now actually read
// ---------------------------------------------------------------------------

describe("MEMORY_TOP_K global default", () => {
  /**
   * `MEMORY_TOP_K` was parsed into `AppConfig.memoryTopK` and then never read:
   * the memory handler only looked at its own `node.config.topK` and fell back to
   * a hard-coded 5. A deployment that configured the env var saw no effect.
   *
   * Exercised through the handler's recall call rather than a full engine run, so
   * the precedence itself is the subject.
   */
  const runRecall = async (opts: {
    globalTopK?: number;
    nodeTopK?: number;
  }): Promise<number> => {
    const { nodeType } = await import("../../graph/handlers/memory.js");
    let observedTopK = -1;

    const runtime = {
      appConfig: {
        ...(opts.globalTopK !== undefined
          ? { memoryTopK: opts.globalTopK }
          : {}),
      },
      ctx: { ssoToken: "a.b.c", executionId: "e1", userEmail: "u@example.com" },
      onNodeStart: () => {},
      memoryStore: {
        recall: async (
          _scope: unknown,
          _query: string,
          topK: number,
        ): Promise<unknown[]> => {
          observedTopK = topK;
          return [];
        },
      },
    };

    const handler = nodeType.factory(
      {
        id: "recall",
        type: "memory",
        ...(opts.nodeTopK !== undefined
          ? { config: { topK: opts.nodeTopK } }
          : {}),
      } as never,
      { nodeMap: new Map() } as never,
    );

    await handler(
      {
        messages: [{ _getType: () => "human", content: "remember me" }],
        context: {},
      } as never,
      { configurable: { runtime } } as never,
    );
    return observedTopK;
  };

  test("MEMORY_TOP_K is used when the node sets no topK", async () => {
    expect(await runRecall({ globalTopK: 12 })).toBe(12);
  });

  test("the node's own topK still wins over the global default", async () => {
    expect(await runRecall({ globalTopK: 12, nodeTopK: 3 })).toBe(3);
  });

  test("neither configured falls back to 5 (unchanged behaviour)", async () => {
    expect(await runRecall({})).toBe(5);
  });

  test("a non-positive global value is ignored rather than passed through", async () => {
    expect(await runRecall({ globalTopK: 0 })).toBe(5);
  });
});
