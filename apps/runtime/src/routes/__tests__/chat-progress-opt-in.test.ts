// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Harness progress on the streaming chat path is opt-in. Without the opt-in
 * the SSE stream carries only OpenAI-compatible frames (every `data:` frame
 * is a chunk with `choices`, plus `[DONE]`); with `X-ATF-Progress: 1` or
 * `metadata.atf_progress` it additionally carries `event: atf.progress`.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { executeStreaming } from "../chat/streaming.js";
import {
  emitHarnessProgress,
  harnessProgressRequested,
  type HarnessProgress,
} from "../../graph/agent-harness/progress-event.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ChatCompletionChunk } from "../../types/openai.js";

const PROGRESS: HarnessProgress = {
  phase: "research",
  tasksDone: 1,
  tasksTotal: 3,
  elapsedMs: 100,
};

let executionCounter = 0;

/** A graph engine that emits one progress event and one content chunk. */
function fakeEngine(): GraphEngineService {
  return {
    async executeFlow(
      _flowId: string,
      _messages: unknown,
      requestCtx: RequestContext,
      onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
      onUsage: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => Promise<void>,
    ): Promise<void> {
      emitHarnessProgress(requestCtx.executionId, PROGRESS);
      // Let the serialized write of the progress frame (if any) settle.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await onChunk({
        id: `chatcmpl-${requestCtx.executionId}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      } as ChatCompletionChunk);
      await onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    },
  } as unknown as GraphEngineService;
}

/** Streams one run and returns the raw SSE body. */
async function stream(headers: Record<string, string>, metadata?: Record<string, unknown>): Promise<string> {
  const app = new Hono();
  app.post("/chat", (ctx) => {
    executionCounter += 1;
    const requestCtx = { executionId: `progress-opt-in-${executionCounter}` } as RequestContext;
    return executeStreaming(
      { graphEngine: fakeEngine(), sseHeartbeatMs: 0 },
      {
        ctx,
        flowToRun: "demo",
        messages: [{ role: "user", content: "hi" }],
        requestCtx,
        resolvedModel: "test-model",
        finalize: async () => {},
        setRunUsage: () => {},
        progressEvents: harnessProgressRequested(ctx.req.header("X-ATF-Progress"), metadata),
      },
    );
  });
  const res = await app.request("/chat", { method: "POST", headers });
  return res.text();
}

/** Splits an SSE body into frames (blank-line separated, comments dropped). */
function frames(body: string): string[] {
  return body
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f !== "" && !f.startsWith(":"));
}

describe("atf.progress opt-in on the streaming chat path", () => {
  test("without opt-in only OpenAI-compatible chunks with choices are streamed", async () => {
    const body = await stream({});
    expect(body).not.toContain("atf.progress");
    expect(body).not.toContain("event:");
    const all = frames(body);
    expect(all.length).toBeGreaterThan(1);
    for (const frame of all) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      expect(data).not.toBe("");
      if (data === "[DONE]") continue;
      const parsed = JSON.parse(data) as { choices?: unknown };
      expect(Array.isArray(parsed.choices)).toBe(true);
    }
    expect(body).toContain("Hello");
  });

  test("X-ATF-Progress: 1 adds the atf.progress event", async () => {
    const body = await stream({ "X-ATF-Progress": "1" });
    expect(body).toContain(`event: atf.progress\ndata: ${JSON.stringify(PROGRESS)}`);
    expect(body).toContain("Hello");
  });

  test("metadata.atf_progress adds the atf.progress event", async () => {
    const body = await stream({}, { atf_progress: true });
    expect(body).toContain("event: atf.progress");
  });
});

describe("harnessProgressRequested", () => {
  test("accepts the header values 1 and true", () => {
    expect(harnessProgressRequested("1", undefined)).toBe(true);
    expect(harnessProgressRequested(" TRUE ", undefined)).toBe(true);
  });
  test("accepts metadata.atf_progress true or \"true\"", () => {
    expect(harnessProgressRequested(undefined, { atf_progress: true })).toBe(true);
    expect(harnessProgressRequested(undefined, { atf_progress: "true" })).toBe(true);
  });
  test("is off by default and for other values", () => {
    expect(harnessProgressRequested(undefined, undefined)).toBe(false);
    expect(harnessProgressRequested("0", {})).toBe(false);
    expect(harnessProgressRequested("yes", { atf_progress: 1 })).toBe(false);
    expect(harnessProgressRequested("", { atf_progress: false })).toBe(false);
  });
});
