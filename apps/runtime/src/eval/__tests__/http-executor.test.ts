// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import {
  createHttpExecutor,
  executionIdFromCompletionId,
  summarizeDebugTrace,
} from "../run.js";

/** Minimal Response for the fake fetch seam. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completionBody(executionId = "exec-1"): Record<string, unknown> {
  return {
    id: `chatcmpl-${executionId}`,
    object: "chat.completion",
    created: 1,
    model: "demo",
    choices: [
      { index: 0, message: { role: "assistant", content: "answer" } },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
}

describe("executionIdFromCompletionId", () => {
  it("strips the chatcmpl- prefix", () => {
    expect(executionIdFromCompletionId("chatcmpl-abc")).toBe("abc");
  });
  it("returns undefined for replay ids, missing ids and foreign ids", () => {
    expect(executionIdFromCompletionId("chatcmpl-replay-xyz")).toBeUndefined();
    expect(executionIdFromCompletionId(undefined)).toBeUndefined();
    expect(executionIdFromCompletionId("something-else")).toBeUndefined();
    expect(executionIdFromCompletionId("chatcmpl-")).toBeUndefined();
  });
});

describe("summarizeDebugTrace", () => {
  it("collects tool-call names, the last finish reason and all codes", () => {
    const summary = summarizeDebugTrace({
      nodes: [
        {
          tool_calls: [{ name: "search/web" }, { name: "calc/math" }],
          diagnostics: [{ code: "retry" }],
          finish_reason: "tool_calls",
        },
        {
          tool_calls: [{ name: "search/web" }],
          diagnostics: [{ code: "empty_response" }, { code: "retry" }],
          finish_reason: "stop",
        },
      ],
    });
    expect(summary.toolCalls).toEqual(["search/web", "calc/math", "search/web"]);
    expect(summary.finishReason).toBe("stop");
    expect(summary.diagnostics).toEqual(["retry", "empty_response", "retry"]);
  });
  it("falls back to a top-level finish reason", () => {
    const summary = summarizeDebugTrace({ finish_reason: "length" });
    expect(summary.finishReason).toBe("length");
  });
  it("yields empty lists for an empty object", () => {
    const summary = summarizeDebugTrace({});
    expect(summary.toolCalls).toEqual([]);
    expect(summary.diagnostics).toEqual([]);
    expect(summary.finishReason).toBeUndefined();
  });
  it("tolerates malformed entries", () => {
    const summary = summarizeDebugTrace({
      nodes: [null, { tool_calls: [null, { name: 7 }, { name: "ok" }] }],
    });
    expect(summary.toolCalls).toEqual(["ok"]);
  });
  it("reports the executed flow revision when the trace names it", () => {
    const summary = summarizeDebugTrace({ flow_version: "1.2.3", flow_digest: "sha256:abc" });
    expect(summary.flowVersion).toBe("1.2.3");
    expect(summary.flowDigest).toBe("sha256:abc");
    const bare = summarizeDebugTrace({ flow_version: 3, flow_digest: null });
    expect(bare.flowVersion).toBeUndefined();
    expect(bare.flowDigest).toBeUndefined();
  });
});

describe("createHttpExecutor trace fetch", () => {
  it("reads tool calls, finish reason and diagnostics from the trace", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/v1/chat/completions"))
        return jsonResponse(completionBody("exec-42"));
      return jsonResponse({
        nodes: [
          {
            tool_calls: [{ name: "search/web" }, { name: "crm/lookup" }],
            diagnostics: [{ code: "retry" }],
            finish_reason: "stop",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const executor = createHttpExecutor("http://localhost:3000", "tok", fetchFn);
    const result = await executor("demo", [{ role: "user", content: "hi" }]);
    expect(result.text).toBe("answer");
    expect(result.toolCalls).toEqual(["search/web", "crm/lookup"]);
    expect(result.finishReason).toBe("stop");
    expect(result.diagnostics).toEqual(["retry"]);
    expect(urls[1]).toBe("http://localhost:3000/monitoring/debug/exec-42");
  });

  it("omits the fields and warns on stderr when the trace 404s", async () => {
    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const fetchFn = (async (input: string | URL | Request) =>
        String(input).endsWith("/v1/chat/completions")
          ? jsonResponse(completionBody("exec-404"))
          : new Response("not found", { status: 404 })) as unknown as typeof fetch;

      const executor = createHttpExecutor(
        "http://localhost:3000",
        undefined,
        fetchFn,
      );
      const result = await executor("demo", [{ role: "user", content: "hi" }]);
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBeUndefined();
      expect(result.diagnostics).toBeUndefined();
      expect(warnings.join("")).toContain(
        "eval: debug trace for exec-404 unavailable (HTTP 404); toolCalled/trace assertions cannot pass",
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("skips the trace fetch when fetchTrace is false", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(completionBody());
    }) as unknown as typeof fetch;
    const executor = createHttpExecutor(
      "http://localhost:3000",
      undefined,
      fetchFn,
      false,
    );
    const result = await executor("demo", [{ role: "user", content: "hi" }]);
    expect(result.toolCalls).toBeUndefined();
    expect(urls).toHaveLength(1);
  });

  it("skips the trace fetch for replay ids", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse({
        ...completionBody(),
        id: "chatcmpl-replay-7",
      });
    }) as unknown as typeof fetch;
    const executor = createHttpExecutor(
      "http://localhost:3000",
      undefined,
      fetchFn,
    );
    const result = await executor("demo", [{ role: "user", content: "hi" }]);
    expect(result.toolCalls).toBeUndefined();
    expect(urls).toHaveLength(1);
  });
});
