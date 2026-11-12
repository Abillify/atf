// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Anthropic Messages API (`POST /v1/messages`) and the trust-proxy model
 * mapping (ADR 0038): request translation, refusal of unsupported fields,
 * non-streaming and streaming responses, tool use in both directions,
 * x-api-key authentication, and routing — flows first, then PROXY_MODELS.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createChatRouter } from "../chat.js";
import { createMessagesRouter } from "../messages.js";
import {
  MessagesRequestError,
  translateMessagesRequest,
} from "../messages/translate.js";
import { MessagesStreamTranslator } from "../messages/streaming.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import {
  createProxyRegistry,
  proxyEntryMatches,
} from "../../graph/flow-registry-proxy.js";
import type { ChatCompletionChunk, ChatMessage } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { FlowDefinition } from "../../types/flow.js";
import { authMiddleware, TOKEN_KEY } from "../../middleware/auth.js";
import type { AuthContext } from "../../middleware/auth.js";

const FLOW: FlowDefinition = {
  id: "support",
  name: "Support",
  nodes: [{ id: "n1", type: "llm", label: "LLM" }],
  edges: [],
};

function registry(flows: FlowDefinition[] = [FLOW]): FlowRegistry {
  const map = new Map(flows.map((f) => [f.id, f]));
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

type OnChunk = (chunk: ChatCompletionChunk) => Promise<void>;
type OnDone = (usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) => Promise<void>;

interface Seen {
  flowId?: string;
  messages?: ChatMessage[];
  ctx?: RequestContext;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): ChatCompletionChunk {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as unknown as ChatCompletionChunk;
}

function engine(
  seen: Seen,
  script?: (send: OnChunk, done: OnDone) => Promise<void>,
): GraphEngineService {
  return {
    buildGraph: () => {
      throw new Error("unused");
    },
    invalidateCache: () => {},
    hasCapacity: () => true,
    getQueueState: () => ({ active: 0, waiting: 0, available: 50, queueLimit: 0 }),
    executeFlow: async (
      flowId: string,
      messages: ChatMessage[],
      ctx: RequestContext,
      onChunk: OnChunk,
      onDone: OnDone,
    ) => {
      seen.flowId = flowId;
      seen.messages = messages;
      seen.ctx = ctx;
      if (script !== undefined) {
        await script(onChunk, onDone);
        return;
      }
      await onChunk(chunk({ content: "Hello " }));
      await onChunk(chunk({ content: "there." }));
      await onDone({ prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
    },
  } as GraphEngineService;
}

function app(
  reg: FlowRegistry,
  eng: GraphEngineService,
  withAuth = false,
): Hono<AuthContext> {
  const a = new Hono<AuthContext>();
  if (withAuth) {
    a.use("/v1/*", authMiddleware(undefined, undefined));
  } else {
    a.use("*", async (ctx, next) => {
      ctx.set(TOKEN_KEY, "header.payload.sig");
      await next();
    });
  }
  const chat = createChatRouter(reg, eng);
  a.route("/", chat);
  a.route("/", createMessagesRouter(chat));
  return a;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("translateMessagesRequest", () => {
  it("maps system, text, images and tools", () => {
    const out = translateMessagesRequest({
      model: "support",
      max_tokens: 100,
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
      tools: [{ name: "lookup", description: "Find", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
      stop_sequences: ["END"],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    expect(out.tools?.[0]?.function.name).toBe("lookup");
    expect(out.tool_choice).toBe("required");
    expect(out.stop).toEqual(["END"]);
    expect(out.max_tokens).toBe(100);
  });

  it("maps a tool round trip: tool_use → tool_calls, tool_result → tool message", () => {
    const out = translateMessagesRequest({
      model: "support",
      max_tokens: 50,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Berlin" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "12°C" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Berlin"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "12°C" },
      { role: "user", content: "thanks" },
    ]);
  });

  it.each([
    [{ thinking: { type: "enabled", budget_tokens: 1000 } }, "thinking"],
    [{ service_tier: "auto" }, "service_tier"],
    [{ top_k: 5 }, "top_k"],
    [{ metadata: { user_id: "u1" } }, "metadata"],
    [{ unknown_field: 1 }, "unknown_field"],
  ])("refuses %p naming the field", (extra, field) => {
    expect(() =>
      translateMessagesRequest({
        model: "support",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
        ...extra,
      }),
    ).toThrow(new RegExp(String(field)));
  });

  it("refuses cache_control anywhere, and a missing max_tokens", () => {
    expect(() =>
      translateMessagesRequest({
        model: "support",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
    ).toThrow(/cache_control/);
    expect(() =>
      translateMessagesRequest({ model: "support", messages: [{ role: "user", content: "hi" }] }),
    ).toThrow(MessagesRequestError);
  });
});

describe("POST /v1/messages", () => {
  it("answers in the Anthropic message shape, echoing the requested model", async () => {
    const seen: Seen = {};
    const res = await app(registry(), engine(seen)).fetch(
      post({ model: "support", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("support");
    expect(body.content).toEqual([{ type: "text", text: "Hello there." }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 11, output_tokens: 4 });
    expect(seen.flowId).toBe("support");
  });

  it("returns 400 in the Anthropic error envelope for unsupported fields", async () => {
    const res = await app(registry(), engine({})).fetch(
      post({
        model: "support",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 1024 },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("thinking");
  });

  it("maps a 404 of the pipeline to not_found_error", async () => {
    const res = await app(registry(), engine({})).fetch(
      post({ model: "nope", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
  });

  it("streams the Anthropic event sequence", async () => {
    const res = await app(registry(), engine({})).fetch(
      post({
        model: "support",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"text_delta"');
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it("streams a client tool call as a tool_use block with input_json_delta", async () => {
    const eng = engine({}, async (send, done) => {
      await send(
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":' } },
          ],
        }),
      );
      await send(chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }));
      await done({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    });
    const res = await app(registry(), eng).fetch(
      post({
        model: "support",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "find x" }],
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
      }),
    );
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"type":"tool_use","id":"call_1","name":"lookup"');
    expect(text).toContain('"partial_json":"{\\"q\\":"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});

describe("x-api-key", () => {
  const jwt = "aaa.bbb.ccc";

  it("authenticates /v1/messages with x-api-key alone", async () => {
    const res = await app(registry(), engine({}), true).fetch(
      post(
        { model: "support", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
        { "x-api-key": jwt },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("refuses different credentials in Authorization and x-api-key", async () => {
    const res = await app(registry(), engine({}), true).fetch(
      post(
        { model: "support", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
        { "x-api-key": jwt, authorization: "Bearer xxx.yyy.zzz" },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("is not read on other routes", async () => {
    const res = await app(registry(), engine({}), true).fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": jwt },
        body: JSON.stringify({ model: "support", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("trust-proxy routing (PROXY_MODELS)", () => {
  const entries = [
    { match: "claude-*", provider: "anthropic-main", model: "claude-sonnet-4-5" },
    { match: "support", provider: "openai-main", model: "gpt-x" },
  ];

  it("matches exact names and trailing-* prefixes only", () => {
    const [prefix, exact] = entries;
    if (prefix === undefined || exact === undefined) throw new Error("entries expected");
    expect(proxyEntryMatches(prefix, "claude-opus")).toBe(true);
    expect(proxyEntryMatches(prefix, "xclaude-opus")).toBe(false);
    expect(proxyEntryMatches(exact, "support")).toBe(true);
    expect(proxyEntryMatches(exact, "support-2")).toBe(false);
  });

  it("runs the pass-through flow for a mapped model", async () => {
    const seen: Seen = {};
    const reg = createProxyRegistry(registry(), entries);
    const res = await app(reg, engine(seen)).fetch(
      post({ model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(200);
    expect(seen.flowId).toBe("__proxy__.0");
    const flow = reg.get("__proxy__.0");
    expect(flow?.nodes[0]?.llm).toEqual({ provider: "anthropic-main", model: "claude-sonnet-4-5" });
    expect(flow?.metadata?.version).toBe("1");
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe("claude-sonnet-4-5");
  });

  it("a real flow wins over a proxy entry with the same name", async () => {
    const seen: Seen = {};
    const reg = createProxyRegistry(registry(), entries);
    await app(reg, engine(seen)).fetch(
      post({ model: "support", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(seen.flowId).toBe("support");
    expect(reg.proxyFlowFor("support")).toBeUndefined();
  });

  it("also routes /v1/chat/completions", async () => {
    const seen: Seen = {};
    const reg = createProxyRegistry(registry(), entries);
    const res = await app(reg, engine(seen)).fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen.flowId).toBe("__proxy__.0");
  });

  it("an unmapped model still 404s", async () => {
    const reg = createProxyRegistry(registry(), entries);
    const res = await app(reg, engine({})).fetch(
      post({ model: "gemini-pro", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(404);
  });

  it("does not list the pass-through flows as flows", () => {
    const reg = createProxyRegistry(registry(), entries);
    expect(reg.list().map((f) => f.id)).toEqual(["support"]);
  });
});

describe("MessagesStreamTranslator", () => {
  it("turns an error frame into an Anthropic error event and stops", () => {
    const t = new MessagesStreamTranslator("m");
    const out =
      t.push(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`) +
      t.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { message: "boom" } })}\n\n`,
      ) +
      t.end();
    const events = [...out.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(events.at(-1)).toBe("error");
    expect(out).toContain('"message":"boom"');
    expect(events).not.toContain("message_stop");
  });

  it("ignores named side-channel events such as atf.progress", () => {
    const t = new MessagesStreamTranslator("m");
    const out = t.push('event: atf.progress\ndata: {"phase":"x"}\n\n') + t.end();
    expect(out).not.toContain("phase");
  });
});
