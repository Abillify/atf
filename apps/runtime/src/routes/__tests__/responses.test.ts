// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for POST /v1/responses (OpenAI Responses API)
 *
 * Uses a mock FlowRegistry and GraphEngineService (no real LLM calls). Covers:
 *  - 400 validation (missing model, missing/empty input, invalid JSON)
 *  - 404 when the flow is not found
 *  - Non-streaming happy path → `response` object with output_text
 *  - Structured `input` items (system + user) translation
 *  - Streaming (stream: true) → typed SSE events incl. response.completed
 *  - Tool-call passthrough surfaced as a function_call output item
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createResponsesRouter } from "../responses.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import type { ChatMessage, ChatCompletionChunk } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { FlowDefinition } from "../../types/flow.js";
import { TOKEN_KEY } from "../../middleware/auth.js";
import type { AuthContext } from "../../middleware/auth.js";

const MOCK_FLOW: FlowDefinition = {
  id: "mock-flow",
  name: "Mock Flow",
  nodes: [{ id: "n1", type: "llm", label: "LLM Node" }],
  edges: [],
};

function mockRegistry(flows: FlowDefinition[] = [MOCK_FLOW]): FlowRegistry {
  const map = new Map<string, FlowDefinition>(flows.map((f) => [f.id, f]));
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  } as unknown as FlowRegistry;
}

type OnChunk = (chunk: ChatCompletionChunk) => Promise<void>;
type OnDone = (usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) => Promise<void>;

function mockEngine(
  opts: {
    onChunk?: (
      send: OnChunk,
      done: OnDone,
      flowId: string,
      messages: ChatMessage[],
    ) => Promise<void>;
    capture?: { messages?: ChatMessage[] };
  } = {},
): GraphEngineService {
  const zeroUsage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  return {
    buildGraph: () => {
      throw new Error("not used in route tests");
    },
    invalidateCache: () => {},
    hasCapacity: () => true,
    getQueueState: () => ({
      active: 0,
      waiting: 0,
      available: 50,
      queueLimit: 0,
    }),
    executeFlow: async (
      flowId: string,
      messages: ChatMessage[],
      _ctx: RequestContext,
      onChunk: OnChunk,
      onDone: OnDone,
    ) => {
      if (opts.capture) opts.capture.messages = messages;
      if (opts.onChunk) {
        await opts.onChunk(onChunk, onDone, flowId, messages);
      } else {
        await onChunk({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1000000,
          model: flowId,
          choices: [
            { index: 0, delta: { content: "Hallo!" }, finish_reason: null },
          ],
        });
        await onDone(zeroUsage);
      }
    },
  } as GraphEngineService;
}

function buildApp(
  registry: FlowRegistry = mockRegistry(),
  engine: GraphEngineService = mockEngine(),
): Hono<AuthContext> {
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "header.payload.sig");
    await next();
  });
  app.route("/", createResponsesRouter(registry, engine));
  return app;
}

function post(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/responses — validation", () => {
  it("400 on invalid JSON", async () => {
    const res = await buildApp().fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 when model is missing", async () => {
    const res = await buildApp().fetch(post({ input: "hi" }));
    expect(res.status).toBe(400);
  });

  it("400 when input is empty", async () => {
    const res = await buildApp().fetch(post({ model: "mock-flow", input: "" }));
    expect(res.status).toBe(400);
  });

  it("404 when the flow is not found", async () => {
    const res = await buildApp().fetch(
      post({ model: "does-not-exist", input: "hi" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/responses — non-streaming", () => {
  it("returns a Responses object with output_text (string input)", async () => {
    const res = await buildApp().fetch(
      post({ model: "mock-flow", input: "hallo" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output_text).toBe("Hallo!");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output[0]?.type).toBe("message");
    const content = output[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("output_text");
    expect(content[0]?.text).toBe("Hallo!");
    const usage = body.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(3);
    expect(usage.output_tokens).toBe(2);
    expect(usage.total_tokens).toBe(5);
  });

  it("translates structured input items (system + user) to messages", async () => {
    const capture: { messages?: ChatMessage[] } = {};
    const app = buildApp(mockRegistry(), mockEngine({ capture }));
    const res = await app.fetch(
      post({
        model: "mock-flow",
        input: [
          { role: "system", content: [{ type: "input_text", text: "test" }] },
          { role: "user", content: [{ type: "input_text", text: "hallo" }] },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(capture.messages).toEqual([
      { role: "system", content: "test" },
      { role: "user", content: "hallo" },
    ]);
  });

  it("prepends instructions as a system message", async () => {
    const capture: { messages?: ChatMessage[] } = {};
    const app = buildApp(mockRegistry(), mockEngine({ capture }));
    await app.fetch(
      post({ model: "mock-flow", input: "hi", instructions: "Be terse." }),
    );
    expect(capture.messages?.[0]).toEqual({
      role: "system",
      content: "Be terse.",
    });
    expect(capture.messages?.[1]).toEqual({ role: "user", content: "hi" });
  });

  it("surfaces model tool calls as a function_call output item", async () => {
    const engine = mockEngine({
      onChunk: async (send, done, flowId) => {
        await send({
          id: "c",
          object: "chat.completion.chunk",
          created: 1,
          model: flowId,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    index: 0,
                    function: { name: "get_weather", arguments: '{"city":"B"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        await done({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      },
    });
    const res = await buildApp(mockRegistry(), engine).fetch(
      post({ model: "mock-flow", input: "weather?" }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;
    const fnCall = output.find((o) => o.type === "function_call");
    expect(fnCall).toBeDefined();
    expect(fnCall?.call_id).toBe("call_1");
    expect(fnCall?.name).toBe("get_weather");
    expect(fnCall?.arguments).toBe('{"city":"B"}');
  });
});

describe("POST /v1/responses — streaming", () => {
  it("emits typed SSE events ending in response.completed", async () => {
    const res = await buildApp().fetch(
      post({ model: "mock-flow", input: "hallo", stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
    // The delta carries the streamed token.
    expect(text).toContain('"delta":"Hallo!"');
  });
});
