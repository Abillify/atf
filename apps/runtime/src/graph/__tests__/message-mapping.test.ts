// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Message mapping (`src/graph/message-mapping.ts`)
 *
 * Pure conversions between OpenAI ChatMessage, LangChain BaseMessage and AI SDK
 * ModelMessage, plus artifact stripping and prompt-cache markers. All pure — no
 * network, no runtime.
 */

import { describe, test, expect } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ModelMessage } from "ai";
import {
  stripRenderedArtifacts,
  chatMessageToBaseMessage,
  baseMessagesToModelMessages,
  aiResponseMessagesToBaseMessages,
  sanitizeReasoningSentinelModelMessages,
  stripReasoningSentinelMarkers,
  REASONING_SENTINEL,
  applyAnthropicPromptCache,
  applyBedrockPromptCache,
  coreMessagesToText,
} from "../message-mapping.js";
import type { ChatMessage } from "../../types/openai.js";

// ---------------------------------------------------------------------------
// stripRenderedArtifacts
// ---------------------------------------------------------------------------

describe("stripRenderedArtifacts", () => {
  test("removes tool_calls <details> blocks", () => {
    const input = 'before<details type="tool_calls">inner stuff</details>after';
    expect(stripRenderedArtifacts(input)).toBe("beforeafter");
  });

  test("removes <iframe> approval widgets (paired and self-closing)", () => {
    expect(stripRenderedArtifacts('a<iframe src="x">y</iframe>b')).toBe("ab");
    expect(stripRenderedArtifacts('a<iframe src="x" />b')).toBe("ab");
  });

  test("collapses the blank lines left behind and trims", () => {
    const input = 'x\n\n\n<iframe src="a"></iframe>\n\n\ny';
    expect(stripRenderedArtifacts(input)).toBe("x\n\ny");
  });

  test("leaves ordinary text untouched", () => {
    expect(stripRenderedArtifacts("just prose")).toBe("just prose");
  });
});

// ---------------------------------------------------------------------------
// chatMessageToBaseMessage
// ---------------------------------------------------------------------------

describe("chatMessageToBaseMessage", () => {
  test("maps each role to the right BaseMessage subtype", () => {
    expect(
      chatMessageToBaseMessage({ role: "system", content: "s" })._getType(),
    ).toBe("system");
    expect(
      chatMessageToBaseMessage({ role: "user", content: "u" })._getType(),
    ).toBe("human");
    expect(
      chatMessageToBaseMessage({ role: "assistant", content: "a" })._getType(),
    ).toBe("ai");
    expect(
      chatMessageToBaseMessage({
        role: "tool",
        content: "r",
        tool_call_id: "c1",
        name: "lookup",
      })._getType(),
    ).toBe("tool");
  });

  test("sanitises assistant history artifacts", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: 'answer<details type="tool_calls">x</details>',
    };
    expect(chatMessageToBaseMessage(msg).content).toBe("answer");
  });

  test("parses assistant tool_calls (and tolerates malformed args)", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "good", arguments: '{"a":1}' },
        },
        {
          id: "t2",
          type: "function",
          function: { name: "bad", arguments: "not-json" },
        },
      ],
    };
    const ai = chatMessageToBaseMessage(msg) as AIMessage;
    expect(ai.tool_calls).toEqual([
      { id: "t1", name: "good", args: { a: 1 } },
      { id: "t2", name: "bad", args: {} },
    ]);
  });

  test("collapses a text-only multimodal message to a plain string", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    };
    const m = chatMessageToBaseMessage(msg);
    expect(m._getType()).toBe("human");
    expect(m.content).toBe("one\ntwo");
  });

  test("preserves images and renders url/file blocks as text", () => {
    const png = `data:image/png;base64,${Buffer.from("hi").toString("base64")}`;
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: png } },
        { type: "image_url", image_url: { url: "https://example.com/x.png" } },
        { type: "file", file_url: { url: "https://example.com/doc" } },
      ],
    };
    const parts = chatMessageToBaseMessage(msg).content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    expect(
      parts.some((p) => p.type === "text" && /\[url:/.test(p.text ?? "")),
    ).toBe(true);
  });

  test("reports content errors via the callback", () => {
    const errors: string[] = [];
    const msg: ChatMessage = {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/tiff;base64,AAAA" },
        },
      ],
    };
    chatMessageToBaseMessage(msg, (e) => errors.push(e.type));
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// baseMessagesToModelMessages
// ---------------------------------------------------------------------------

describe("baseMessagesToModelMessages", () => {
  test("passes through a tool-free conversation unchanged in shape", () => {
    const out = baseMessagesToModelMessages([
      new SystemMessage("sys"),
      new HumanMessage("hi"),
      new AIMessage("hello"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  test("preserves a complete tool-call / tool-result pair", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: "srv/look", args: { q: 1 } }],
    });
    const tool = new ToolMessage({
      content: "result-text",
      tool_call_id: "c1",
      name: "srv/look",
    });
    const out = baseMessagesToModelMessages([new HumanMessage("q"), ai, tool]);
    const assistant = out.find((m) => m.role === "assistant");
    const toolMsg = out.find((m) => m.role === "tool");
    expect(assistant).toBeDefined();
    expect(toolMsg).toBeDefined();
    // Tool name is sanitised (no slash).
    const parts = assistant?.content as Array<{
      type: string;
      toolName?: string;
    }>;
    const call = parts.find((p) => p.type === "tool-call");
    expect(call?.toolName).toBe("srv_look");
  });

  test("drops an orphaned tool result (no matching call)", () => {
    const out = baseMessagesToModelMessages([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "a", args: {} }],
      }),
      new ToolMessage({ content: "orphan", tool_call_id: "other" }),
    ]);
    // The orphaned result and its unmatched call are removed.
    expect(out.find((m) => m.role === "tool")).toBeUndefined();
  });

  test("skips an empty assistant string message", () => {
    const out = baseMessagesToModelMessages([
      new HumanMessage("hi"),
      new AIMessage(""),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  test("maps a multimodal human message to text + file parts", () => {
    const human = new HumanMessage({
      content: [
        { type: "text", text: "see" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
          mediaType: "image/png",
        },
      ] as never,
    });
    const out = baseMessagesToModelMessages([human]);
    const parts = out[0]?.content as Array<{
      type: string;
      data?: URL;
      mediaType?: string;
    }>;
    expect(parts).toContainEqual({
      type: "file",
      data: new URL("data:image/png;base64,AAAA"),
      mediaType: "image/png",
    });
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  test("converts an MCP-style tool result array into a tool-result part", () => {
    const tool = new ToolMessage({
      content: [{ type: "text", text: "from-mcp" }] as never,
      tool_call_id: "c1",
      name: "srv",
    });
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: "srv", args: {} }],
    });
    const out = baseMessagesToModelMessages([ai, tool]);
    const toolMsg = out.find((m) => m.role === "tool");
    const parts = toolMsg?.content as Array<{ type: string; output?: unknown }>;
    expect(parts[0]?.type).toBe("tool-result");
  });
});

// ---------------------------------------------------------------------------
// aiResponseMessagesToBaseMessages
// ---------------------------------------------------------------------------

describe("aiResponseMessagesToBaseMessages", () => {
  test("returns undefined for no usable messages", () => {
    expect(aiResponseMessagesToBaseMessages([])).toBeUndefined();
  });

  test("maps assistant text + tool-call and a tool-result", () => {
    const out = aiResponseMessagesToBaseMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "look",
            input: { q: 2 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "look",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ]);
    expect(out).toBeDefined();
    const ai = out?.[0] as AIMessage;
    expect(ai._getType()).toBe("ai");
    expect(ai.tool_calls?.[0]?.name).toBe("look");
    const toolMsg = out?.[1] as ToolMessage;
    expect(toolMsg._getType()).toBe("tool");
    expect(toolMsg.content).toBe("done");
  });

  test("handles a plain assistant string entry", () => {
    const out = aiResponseMessagesToBaseMessages([
      { role: "assistant", content: "plain" },
    ]);
    expect(out?.[0]?.content).toBe("plain");
  });

  // Reasoning-sentinel pollution: the LM Studio shim rewrites native reasoning
  // into `content` with a per-delta "\x00r" sentinel, which the AI SDK
  // concatenates into the assistant message. It must never survive into the
  // engine BaseMessages (carried forward / persisted / replayed).
  test("drops reasoning content that preceded a tool call, keeps the tool call", () => {
    const out = aiResponseMessagesToBaseMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${REASONING_SENTINEL}Let me${REASONING_SENTINEL} search`,
          },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "look",
            input: { q: 1 },
          },
        ],
      },
    ]);
    const ai = out?.[0] as AIMessage;
    expect(ai.content).toBe("");
    expect(ai.tool_calls?.[0]?.name).toBe("look");
    // No NUL bytes anywhere.
    expect(JSON.stringify(out)).not.toContain("\u0000");
  });

  test("strips NUL sentinels from a plain answer turn (no tool call)", () => {
    const out = aiResponseMessagesToBaseMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${REASONING_SENTINEL}Thinking${REASONING_SENTINEL} hardFinal answer`,
          },
        ],
      },
    ]);
    const content = out?.[0]?.content as string;
    expect(content).not.toContain("\u0000");
    // The visible answer survives; the NUL markers are gone.
    expect(content).toContain("Final answer");
  });

  test("strips NUL sentinels from a plain assistant string entry", () => {
    const out = aiResponseMessagesToBaseMessages([
      { role: "assistant", content: `${REASONING_SENTINEL}reasoned answer` },
    ]);
    expect(out?.[0]?.content).toBe("reasoned answer");
  });
});

// ---------------------------------------------------------------------------
// reasoning-sentinel sanitizers (tool-loop replay + markers)
// ---------------------------------------------------------------------------

describe("reasoning-sentinel sanitizers", () => {
  test("stripReasoningSentinelMarkers removes every NUL sentinel", () => {
    expect(
      stripReasoningSentinelMarkers(
        `${REASONING_SENTINEL}a${REASONING_SENTINEL}b`,
      ),
    ).toBe("ab");
    // No sentinel → unchanged (referential no-op friendly).
    expect(stripReasoningSentinelMarkers("clean")).toBe("clean");
  });

  test("sanitizeReasoningSentinelModelMessages drops reasoning on tool-call turns", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: `${REASONING_SENTINEL}mulling it over` },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "look",
            input: {},
          },
        ],
      } as unknown as ModelMessage,
    ];
    const out = sanitizeReasoningSentinelModelMessages(messages);
    const asst = out[2] as { content: Array<{ type: string; text?: string }> };
    // Reasoning text part dropped, tool-call preserved.
    expect(asst.content.some((p) => p.type === "text")).toBe(false);
    expect(asst.content.some((p) => p.type === "tool-call")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("\u0000");
  });

  test("sanitizeReasoningSentinelModelMessages strips markers from a string answer turn", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: `${REASONING_SENTINEL}done` },
    ];
    const out = sanitizeReasoningSentinelModelMessages(messages);
    expect(out[0]?.content).toBe("done");
  });

  test("sanitizeReasoningSentinelModelMessages returns the same reference when nothing changed", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "clean answer" },
    ];
    expect(sanitizeReasoningSentinelModelMessages(messages)).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// prompt-cache markers
// ---------------------------------------------------------------------------

describe("prompt-cache markers", () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];

  test("applyAnthropicPromptCache marks only the system message", () => {
    const out = applyAnthropicPromptCache(messages);
    const sys = out[0] as { providerOptions?: { anthropic?: unknown } };
    expect(sys.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
    expect(
      (out[1] as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
  });

  test("applyBedrockPromptCache marks the system message with the given ttl", () => {
    const out = applyBedrockPromptCache(messages, "1h");
    const sys = out[0] as {
      providerOptions?: { bedrock?: { cachePoint?: { ttl?: string } } };
    };
    expect(sys.providerOptions?.bedrock?.cachePoint?.ttl).toBe("1h");
  });

  test("returns messages unchanged when there is no system message", () => {
    const noSys: ModelMessage[] = [{ role: "user", content: "hi" }];
    expect(applyAnthropicPromptCache(noSys)).toEqual(noSys);
    expect(applyBedrockPromptCache(noSys)).toEqual(noSys);
  });
});

// ---------------------------------------------------------------------------
// coreMessagesToText
// ---------------------------------------------------------------------------

describe("coreMessagesToText", () => {
  test("flattens string and structured content, summarising non-text parts", () => {
    const text = coreMessagesToText([
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "file", data: "https://x/y.png", mediaType: "image/png" },
        ],
      } as ModelMessage,
    ]);
    expect(text).toContain("system: sys");
    expect(text).toContain("user: hello [image]");
  });
});
