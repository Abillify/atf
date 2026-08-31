// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for POST /v1/chat/completions
 *
 * Uses a mock FlowRegistry and a mock GraphEngineService so no real LLM calls
 * are made. Covers:
 *  - 400 validation errors (missing model, missing messages, invalid JSON)
 *  - 404 when the requested model/flow is not found
 *  - Non-streaming (stream: false) happy path
 *  - SSE streaming (stream: true / default) happy path incl. [DONE] terminator
 *  - Error chunk forwarding in streaming mode
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createChatRouter } from "../chat.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import type { ChatMessage, ChatCompletionChunk } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { LlmStreamFallbackPolicy } from "../../llm-stream-fallback-policy.js";
import { createMetrics } from "../../observability/metrics.js";
import type { Metrics } from "../../observability/metrics.js";
import { TOKEN_KEY } from "../../middleware/auth.js";
import type { AuthContext } from "../../middleware/auth.js";
import {
  TokenLimitEnforcer,
  TokenLimitService,
  InMemoryTokenLimitStore,
  type UsageAnalytics,
  type TokenUsageTotals,
  type UsageSeriesPoint,
} from "../../observability/token-limits.js";

/** Analytics stub reporting a fixed consumed-token total. */
function analyticsWith(totalTokens: number): UsageAnalytics {
  const totals: TokenUsageTotals = {
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens,
    cost: 0,
  };
  return {
    totals: async () => totals,
    series: async (): Promise<UsageSeriesPoint[]> => [],
    distinctModels: async () => [],
    byModel: async () => ({}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid FlowDefinition for mock registry */
const MOCK_FLOW: FlowDefinition = {
  id: "mock-flow",
  name: "Mock Flow",
  nodes: [{ id: "n1", type: "llm", label: "LLM Node" }],
  edges: [],
};

/** Build a mock FlowRegistry with the given flows (or just MOCK_FLOW by default) */
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

/** Build a GraphEngineService mock that calls provided callbacks */
function mockEngine(
  opts: {
    onChunk?: (
      send: OnChunk,
      done: OnDone,
      flowId: string,
      messages: ChatMessage[],
    ) => Promise<void>;
  } = {},
): GraphEngineService {
  const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
      if (opts.onChunk) {
        await opts.onChunk(onChunk, onDone, flowId, messages);
      } else {
        // default: emit one token then done
        await onChunk({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1000000,
          model: flowId,
          choices: [
            { index: 0, delta: { content: "Hello!" }, finish_reason: null },
          ],
        });
        await onDone(zeroUsage);
      }
    },
  } as GraphEngineService;
}

/** Build the Hono test app with a fake token injected (bypasses auth middleware) */
function buildApp(
  registry: FlowRegistry = mockRegistry(),
  engine: GraphEngineService = mockEngine(),
  llmStreamFallbackPolicy?: LlmStreamFallbackPolicy,
  metrics?: Metrics,
): Hono<AuthContext> {
  const app = new Hono<AuthContext>();
  // Inject a mock token so the route can call ctx.get(TOKEN_KEY) safely
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "header.payload.sig");
    await next();
  });
  app.route(
    "/",
    createChatRouter(
      registry,
      engine,
      undefined,
      undefined,
      undefined,
      llmStreamFallbackPolicy === undefined && metrics === undefined
        ? undefined
        : {
            ...(llmStreamFallbackPolicy !== undefined
              ? { llmStreamFallbackPolicy }
              : {}),
            ...(metrics !== undefined ? { metrics } : {}),
          },
    ),
  );
  return app;
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — token limit enforcement", () => {
  function appWithEnforcer(enforcer: TokenLimitEnforcer): Hono<AuthContext> {
    const app = new Hono<AuthContext>();
    app.use("*", async (ctx, next) => {
      ctx.set(TOKEN_KEY, "header.payload.sig");
      await next();
    });
    app.route(
      "/",
      createChatRouter(
        mockRegistry(),
        mockEngine(),
        undefined,
        undefined,
        undefined,
        {
          limitEnforcer: enforcer,
        },
      ),
    );
    return app;
  }

  const body = JSON.stringify({
    model: "mock-flow",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  it("rejects with 402 when a global token limit is exhausted", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 100,
    });
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(store, analyticsWith(150)),
    );
    const res = await appWithEnforcer(enforcer).request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    expect(res.status).toBe(402);
    const parsed = (await res.json()) as {
      error: { type: string; message: string };
    };
    expect(parsed.error.type).toBe("insufficient_quota");
    expect(parsed.error.message.toLowerCase()).toContain("token limit");
  });

  it("admits the request when under the limit", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 1000,
    });
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(store, analyticsWith(150)),
    );
    const res = await appWithEnforcer(enforcer).request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions — compliance policy enforcement (ADR-0009)", () => {
  const MOCK_FLOW_BLOCKED_MODEL: FlowDefinition = {
    id: "mock-flow",
    name: "Mock Flow",
    nodes: [
      {
        id: "n1",
        type: "llm",
        label: "LLM Node",
        llm: { provider: "openai", model: "gpt-3.5-turbo" },
      },
    ],
    edges: [],
  };

  function appWithPolicy(
    policy: import("../../compliance/policy-schema.js").CompliancePolicy | undefined,
    flow: FlowDefinition = MOCK_FLOW_BLOCKED_MODEL,
  ): Hono<AuthContext> {
    const app = new Hono<AuthContext>();
    app.use("*", async (ctx, next) => {
      ctx.set(TOKEN_KEY, "header.payload.sig");
      await next();
    });
    app.route(
      "/",
      createChatRouter(
        mockRegistry([flow]),
        mockEngine(),
        undefined,
        undefined,
        undefined,
        { compliancePolicyLoader: { policy } },
      ),
    );
    return app;
  }

  const body = JSON.stringify({
    model: "mock-flow",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  it("admits the request when no policy is loaded", async () => {
    const res = await appWithPolicy(undefined).request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
  });

  it("rejects with 403 before the graph engine runs when the flow's model is blocked", async () => {
    let engineCalled = false;
    const app = new Hono<AuthContext>();
    app.use("*", async (ctx, next) => {
      ctx.set(TOKEN_KEY, "header.payload.sig");
      await next();
    });
    app.route(
      "/",
      createChatRouter(
        mockRegistry([MOCK_FLOW_BLOCKED_MODEL]),
        mockEngine({
          onChunk: async () => {
            engineCalled = true;
          },
        }),
        undefined,
        undefined,
        undefined,
        {
          compliancePolicyLoader: {
            policy: {
              version: "1",
              failClosed: true,
              modelRules: [
                {
                  tenant: "*",
                  blockedModels: [{ provider: "openai", model: "gpt-3*" }],
                },
              ],
            },
          },
        },
      ),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(403);
    const parsed = (await res.json()) as { error: { type: string; message: string } };
    expect(parsed.error.type).toBe("permission_error");
    expect(engineCalled).toBe(false);
  });

  it("admits the request when the flow's declared model complies", async () => {
    const compliantFlow: FlowDefinition = {
      id: "mock-flow",
      name: "Mock Flow",
      nodes: [
        {
          id: "n1",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o" },
        },
      ],
      edges: [],
    };
    const res = await appWithPolicy(
      {
        version: "1",
        failClosed: true,
        modelRules: [
          { tenant: "*", blockedModels: [{ provider: "openai", model: "gpt-3*" }] },
        ],
      },
      compliantFlow,
    ).request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
  });

  it("rejects with 403 when the flow declares a dataClass not permitted for its provider", async () => {
    const flowWithPersonalData: FlowDefinition = {
      id: "mock-flow",
      name: "Mock Flow",
      dataClasses: ["personal"],
      nodes: [
        {
          id: "n1",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o" },
        },
      ],
      edges: [],
    };
    let engineCalled = false;
    const app = new Hono<AuthContext>();
    app.use("*", async (ctx, next) => {
      ctx.set(TOKEN_KEY, "header.payload.sig");
      await next();
    });
    app.route(
      "/",
      createChatRouter(
        mockRegistry([flowWithPersonalData]),
        mockEngine({
          onChunk: async () => {
            engineCalled = true;
          },
        }),
        undefined,
        undefined,
        undefined,
        {
          compliancePolicyLoader: {
            policy: {
              version: "1",
              failClosed: true,
              dataRules: [
                {
                  dataClass: "personal",
                  description: "GDPR — personal data stays on local models only",
                  allowedProviders: [{ provider: "ollama" }],
                },
              ],
            },
          },
        },
      ),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(403);
    const parsed = (await res.json()) as { error: { type: string; message: string } };
    expect(parsed.error.type).toBe("permission_error");
    expect(parsed.error.message).toContain("personal");
    expect(engineCalled).toBe(false);
  });

  it("admits the request when the flow's declared dataClass IS permitted for its provider", async () => {
    const flowWithLocalPersonalData: FlowDefinition = {
      id: "mock-flow",
      name: "Mock Flow",
      dataClasses: ["personal"],
      nodes: [
        {
          id: "n1",
          type: "llm",
          llm: { provider: "ollama", model: "llama3" },
        },
      ],
      edges: [],
    };
    const res = await appWithPolicy(
      {
        version: "1",
        failClosed: true,
        dataRules: [
          { dataClass: "personal", allowedProviders: [{ provider: "ollama" }] },
        ],
      },
      flowWithLocalPersonalData,
    ).request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions — validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 when model field is missing", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("model");
  });

  it("returns 400 when model is empty string", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "  ",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 when messages field is missing", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-flow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("messages");
  });

  it("returns 400 when messages is an empty array", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock-flow", messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("messages");
  });
});

// ---------------------------------------------------------------------------
// 404 — flow not found
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — 404", () => {
  it("returns 404 when requested model/flow is not in the registry", async () => {
    const app = buildApp(mockRegistry([])); // empty registry
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nonexistent-flow",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.message).toContain("nonexistent-flow");
  });
});

// ---------------------------------------------------------------------------
// Non-streaming path (stream: false)
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — non-streaming (stream: false)", () => {
  it("returns full ChatCompletionResponse with required fields", async () => {
    const app = buildApp(mockRegistry(), mockEngine());
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      created: number;
      choices: Array<{
        message: { role: string; content: string };
        finish_reason: string;
        index: number;
      }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("mock-flow");
    expect(typeof body.id).toBe("string");
    expect(body.id.startsWith("chatcmpl-")).toBe(true);
    expect(typeof body.created).toBe("number");
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toBe("Hello!");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  it("collects multiple token chunks into a single content string", async () => {
    const engine = mockEngine({
      onChunk: async (onChunk, onDone) => {
        for (const token of ["Foo", " ", "Bar"]) {
          await onChunk({
            id: "chatcmpl-x",
            object: "chat.completion.chunk",
            created: 0,
            model: "mock-flow",
            choices: [
              { index: 0, delta: { content: token }, finish_reason: null },
            ],
          });
        }
        await onDone({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        });
      },
    });
    const app = buildApp(mockRegistry(), engine);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe("Foo Bar");
  });

  it("keeps legacy non-streaming exception materialization", async () => {
    const engine = mockEngine({
      onChunk: async () => {
        throw new Error("provider failed");
      },
    });
    const res = await buildApp(mockRegistry(), engine, "legacy").request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mock-flow",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.choices[0]?.message.content).toBe(
      "[Error: provider failed]",
    );
    expect(body.choices[0]?.finish_reason).toBe("error");
  });

  it("reports non-streaming exception materialization without changing the wire response", async () => {
    const engine = mockEngine({
      onChunk: async () => {
        throw new Error("provider failed");
      },
    });
    const metrics = createMetrics(true);
    const res = await buildApp(
      mockRegistry(),
      engine,
      "report",
      metrics,
    ).request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe(
      "[Error: provider failed]",
    );
    expect(metrics.render()).toContain(
      'aiperator_stream_fallback_total{kind="route",reason="non_streaming_exception_materialization"} 1',
    );
  });

  it("rethrows non-streaming exceptions when fallback policy is disabled", async () => {
    const engine = mockEngine({
      onChunk: async () => {
        throw new Error("provider failed");
      },
    });
    const res = await buildApp(mockRegistry(), engine, "disabled").request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mock-flow",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      },
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("[Error:");
  });
});

// ---------------------------------------------------------------------------
// SSE streaming path (stream: true / default)
// ---------------------------------------------------------------------------

/** Parse raw SSE text into an array of data-frame payloads (as raw strings) */
function parseSseFrames(raw: string): string[] {
  return raw
    .split("\n\n")
    .filter((block) => block.includes("data: "))
    .map((block) => {
      // Blocks may be prefixed with `id: N\n` when the replay buffer is active.
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      return dataLine ? dataLine.slice("data: ".length).trim() : "";
    })
    .filter((s) => s.length > 0);
}

describe("POST /v1/chat/completions — SSE streaming", () => {
  it("sets correct SSE headers", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("stream terminates with [DONE] as the last frame", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const raw = await res.text();
    const frames = parseSseFrames(raw);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1]).toBe("[DONE]");
  });

  it("stream contains at least one token chunk with content", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const raw = await res.text();
    const frames = parseSseFrames(raw);
    const dataFrames = frames.filter((f) => f !== "[DONE]");
    expect(dataFrames.length).toBeGreaterThan(0);
    const firstFrame = dataFrames[0];
    if (firstFrame === undefined) throw new Error("expected a data frame");
    const firstChunk = JSON.parse(firstFrame) as {
      object: string;
      choices: Array<{ delta: { content: string } }>;
    };
    expect(firstChunk.object).toBe("chat.completion.chunk");
    expect(firstChunk.choices[0]?.delta.content).toBe("Hello!");
  });

  it("error during execution emits error chunk then [DONE]", async () => {
    const engine = mockEngine({
      onChunk: async (_onChunk, onDone) => {
        // Simulate executeFlow throwing
        void onDone; // suppress unused
        throw new Error("LLM unavailable");
      },
    });
    const app = buildApp(mockRegistry(), engine);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const raw = await res.text();
    const frames = parseSseFrames(raw);
    expect(frames[frames.length - 1]).toBe("[DONE]");
    const errorFrame = frames.find((f) => {
      if (f === "[DONE]") return false;
      try {
        const parsed = JSON.parse(f) as {
          choices?: Array<{ finish_reason?: string }>;
        };
        return parsed.choices?.[0]?.finish_reason === "error";
      } catch {
        return false;
      }
    });
    expect(errorFrame).toBeTruthy();
    if (errorFrame === undefined) throw new Error("expected an error frame");
    const errChunk = JSON.parse(errorFrame) as {
      error: { message: string; type: string };
    };
    expect(errChunk.error.message).toContain("LLM unavailable");
  });

  it("non-streaming JSON is the default when stream is omitted (OpenAI-compatible)", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mock-flow",
        messages: [{ role: "user", content: "hi" }],
        // stream field intentionally omitted → must NOT stream (spec default false)
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const parsed = (await res.json()) as { object: string };
    expect(parsed.object).toBe("chat.completion");
  });
});
