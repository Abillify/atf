// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for request idempotency on POST /v1/chat/completions.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createChatRouter } from "../chat.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import type { ChatMessage, ChatCompletionChunk } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { FlowDefinition } from "../../types/flow.js";
import { TOKEN_KEY, type AuthContext } from "../../middleware/auth.js";
import { InMemoryIdempotencyStore } from "../../graph/idempotency-store.js";

const FLOW: FlowDefinition = {
  id: "mock-flow",
  name: "Mock Flow",
  nodes: [{ id: "n1", type: "llm" }],
  edges: [],
};

function mockRegistry(): FlowRegistry {
  const map = new Map([[FLOW.id, FLOW]]);
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  } as unknown as FlowRegistry;
}

function countingEngine(
  counter: { runs: number },
  text = "Hello!",
): GraphEngineService {
  return {
    buildGraph: () => {
      throw new Error("unused");
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
      _messages: ChatMessage[],
      _ctx: RequestContext,
      onChunk: (c: ChatCompletionChunk) => Promise<void>,
      onDone: (u: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }) => Promise<void>,
    ) => {
      counter.runs++;
      await onChunk({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: flowId,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
      await onDone({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    },
  } as GraphEngineService;
}

function buildApp(counter: { runs: number }) {
  const store = new InMemoryIdempotencyStore();
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "header.payload.sig");
    await next();
  });
  app.route(
    "/",
    createChatRouter(
      mockRegistry(),
      countingEngine(counter),
      undefined,
      undefined,
      undefined,
      {
        idempotencyStore: store,
      },
    ),
  );
  return app;
}

const post = (body: unknown, key?: string) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(key !== undefined ? { "Idempotency-Key": key } : {}),
  },
  body: JSON.stringify(body),
});

const req = (over: Record<string, unknown> = {}) => ({
  model: "mock-flow",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
  ...over,
});

describe("idempotency — non-streaming", () => {
  it("replays the stored response on a retry with the same key (no re-execution)", async () => {
    const counter = { runs: 0 };
    const app = buildApp(counter);

    const first = await app.request(
      "/v1/chat/completions",
      post(req(), "key-1"),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const firstChoice = firstBody.choices[0];
    if (firstChoice === undefined) throw new Error("expected a first choice");
    expect(firstChoice.message.content).toBe("Hello!");
    expect(counter.runs).toBe(1);

    const second = await app.request(
      "/v1/chat/completions",
      post(req(), "key-1"),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    const secondBody = (await second.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const secondChoice = secondBody.choices[0];
    if (secondChoice === undefined) throw new Error("expected a first choice");
    expect(secondChoice.message.content).toBe("Hello!");
    expect(counter.runs).toBe(1); // NOT re-executed
  });

  it("runs separately for different idempotency keys", async () => {
    const counter = { runs: 0 };
    const app = buildApp(counter);
    await app.request("/v1/chat/completions", post(req(), "key-a"));
    await app.request("/v1/chat/completions", post(req(), "key-b"));
    expect(counter.runs).toBe(2);
  });

  it("rejects reuse of a key with a different request body (422)", async () => {
    const counter = { runs: 0 };
    const app = buildApp(counter);
    await app.request("/v1/chat/completions", post(req(), "key-x"));
    const res = await app.request(
      "/v1/chat/completions",
      post(
        req({ messages: [{ role: "user", content: "different" }] }),
        "key-x",
      ),
    );
    expect(res.status).toBe(422);
    expect(counter.runs).toBe(1);
  });

  it("executes normally when no idempotency key is supplied", async () => {
    const counter = { runs: 0 };
    const app = buildApp(counter);
    await app.request("/v1/chat/completions", post(req()));
    await app.request("/v1/chat/completions", post(req()));
    expect(counter.runs).toBe(2);
  });
});

describe("idempotency — streaming", () => {
  it("replays a stored answer as an SSE stream", async () => {
    const counter = { runs: 0 };
    const app = buildApp(counter);

    const first = await app.request(
      "/v1/chat/completions",
      post(req({ stream: true }), "skey"),
    );
    expect(first.status).toBe(200);
    await first.text(); // drain the stream
    expect(counter.runs).toBe(1);

    const second = await app.request(
      "/v1/chat/completions",
      post(req({ stream: true }), "skey"),
    );
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    const text = await second.text();
    expect(text).toContain("Hello!");
    expect(text).toContain("[DONE]");
    expect(counter.runs).toBe(1); // replayed, not re-run
  });
});
