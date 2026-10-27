// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the context optimization utilities introduced to reduce LLM input
 * token costs in multi-turn checkpointed conversations:
 *
 * - deduplicateRagContext: strips accumulated RAG messages from prior turns
 * - trimConversationHistory: sliding window over user/assistant exchanges
 * - Multi-breakpoint prompt caching (covered in anthropic-prompt-cache.test.ts)
 */

import { describe, test, expect } from "bun:test";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import type { ModelMessage } from "ai";
import {
  deduplicateRagContext,
  trimConversationHistory,
  isRagContextMessage,
  maskRagContextForModel,
} from "../exec-runtime.js";
import { HashRefHandleRegistry } from "../ref-handles.js";
import {
  applyAnthropicPromptCache,
  applyBedrockPromptCache,
} from "../message-mapping.js";

// ---------------------------------------------------------------------------
// isRagContextMessage
// ---------------------------------------------------------------------------

describe("isRagContextMessage", () => {
  test("detects the standard RAG citation preamble", () => {
    const content =
      "The following sources are ordered by relevance to the question. " +
      "If your answer uses a source, cite it inline as [n].\n\n" +
      "[1] Some doc\ncontent";
    expect(isRagContextMessage(content)).toBe(true);
  });

  test("detects tag-scoped RAG context", () => {
    const content =
      "Authoritative source tag for this question: Example Retail. " +
      "Sources carrying that tag are authoritative...";
    expect(isRagContextMessage(content)).toBe(true);
  });

  // The prompts were German before they were translated. A conversation
  // checkpointed before the change still carries the old wording, and failing to
  // recognise it would let RAG context accumulate unbounded for the rest of that
  // session instead of being deduplicated.
  test("still detects pre-translation German markers in checkpointed history", () => {
    expect(
      isRagContextMessage(
        "Die folgenden Quellen wurden nach Relevanz zur Frage sortiert.\n\n[1] Some doc",
      ),
    ).toBe(true);
    expect(
      isRagContextMessage(
        "Gefragter Mandant: Example Retail. Quellen, die mit diesem Mandanten getaggt sind...",
      ),
    ).toBe(true);
  });

  test("does not match regular system prompts", () => {
    expect(isRagContextMessage("You are a helpful assistant.")).toBe(false);
    expect(isRagContextMessage("Du bist ein Assistent.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deduplicateRagContext
// ---------------------------------------------------------------------------

describe("deduplicateRagContext", () => {
  const makeRagMessage = (turn: number) =>
    new SystemMessage({
      content:
        `Die folgenden Quellen wurden nach Relevanz zur Frage sortiert. ` +
        `Turn ${turn}\n\n[1] Doc ${turn}\ncontent ${turn}`,
    });

  test("no-op when there are zero RAG messages", () => {
    const msgs = [
      new HumanMessage("hello"),
      new AIMessage("hi"),
    ];
    const result = deduplicateRagContext(msgs);
    expect(result).toBe(msgs); // same reference — no filtering needed
  });

  test("no-op when there is exactly one RAG message", () => {
    const msgs = [
      makeRagMessage(1),
      new HumanMessage("hello"),
      new AIMessage("hi"),
    ];
    const result = deduplicateRagContext(msgs);
    expect(result).toBe(msgs);
  });

  test("keeps only the last RAG message when multiple accumulate", () => {
    const rag1 = makeRagMessage(1);
    const rag2 = makeRagMessage(2);
    const rag3 = makeRagMessage(3);
    const msgs = [
      rag1,
      new HumanMessage("turn 1"),
      new AIMessage("reply 1"),
      rag2,
      new HumanMessage("turn 2"),
      new AIMessage("reply 2"),
      rag3,
      new HumanMessage("turn 3"),
    ];
    const result = deduplicateRagContext(msgs);
    // Should only contain rag3, not rag1 or rag2
    expect(result.length).toBe(msgs.length - 2);
    expect(result).not.toContain(rag1);
    expect(result).not.toContain(rag2);
    expect(result).toContain(rag3);
    // Other messages preserved
    expect(result.filter((m) => m._getType() === "human").length).toBe(3);
    expect(result.filter((m) => m._getType() === "ai").length).toBe(2);
  });

  test("does not remove non-RAG system messages", () => {
    const systemPrompt = new SystemMessage("You are a helpful assistant.");
    const rag1 = makeRagMessage(1);
    const rag2 = makeRagMessage(2);
    const msgs = [
      systemPrompt,
      rag1,
      new HumanMessage("turn 1"),
      new AIMessage("reply 1"),
      rag2,
      new HumanMessage("turn 2"),
    ];
    const result = deduplicateRagContext(msgs);
    expect(result).toContain(systemPrompt);
    expect(result).not.toContain(rag1);
    expect(result).toContain(rag2);
  });
});

// ---------------------------------------------------------------------------
// maskRagContextForModel — grounding refs become handles at the model boundary
// ---------------------------------------------------------------------------

describe("maskRagContextForModel", () => {
  const REF =
    "/2025_Requirements Spec/2025_Requirements Spec.pdf/22. Requirements — Section";

  const groundingMessage = (ref: string) =>
    new SystemMessage({
      content:
        "The following sources are ordered by relevance to the question. " +
        "Base your answer on these case file contents.\n\n" +
        `RELEVANT PASSAGES (ordered by relevance to the question).\n\n` +
        `[1] Spezifikation (Ref: ${ref})\nPassage text.`,
    });

  test("replaces the grounding Ref with its handle", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF);
    const msgs = [groundingMessage(REF), new HumanMessage("frage")];
    const result = maskRagContextForModel(msgs, reg);
    const content = (result[0] as SystemMessage).content as string;
    expect(content).toContain(`(Ref: ${handle})`);
    expect(content).not.toContain(REF);
  });

  test("keeps the persisted message objects untouched (model-facing copy only)", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF);
    const rag = groundingMessage(REF);
    const msgs = [rag, new HumanMessage("frage")];
    maskRagContextForModel(msgs, reg);
    // The state's own message still carries the real reference — history,
    // client citations and audit surfaces must never see a handle.
    expect(rag.content as string).toContain(REF);
  });

  test("returns the same array reference when nothing changes", () => {
    const reg = new HashRefHandleRegistry();
    const msgs = [
      new SystemMessage("You are a helpful assistant."),
      new HumanMessage("frage"),
    ];
    expect(maskRagContextForModel(msgs, reg)).toBe(msgs);
  });

  test("leaves a non-RAG system message and an unregistered ref alone", () => {
    const reg = new HashRefHandleRegistry();
    reg.register("/andere/datei.pdf");
    const systemPrompt = new SystemMessage("Du bist ein Assistent.");
    const rag = groundingMessage("/nicht/registriert.pdf");
    const msgs = [systemPrompt, rag, new HumanMessage("frage")];
    const result = maskRagContextForModel(msgs, reg);
    expect(result).toBe(msgs);
    expect(result[0]).toBe(systemPrompt);
    expect(result[1]).toBe(rag);
  });

  test("preserves message identity fields on the masked copy", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF);
    const rag = new SystemMessage({
      content: `The following sources are ordered by relevance to the question.\n(Ref: ${REF})`,
      additional_kwargs: { trace: "keep-me" },
    });
    const [masked] = maskRagContextForModel([rag], reg);
    expect(masked?.additional_kwargs).toEqual({ trace: "keep-me" });
    expect(masked?._getType()).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// trimConversationHistory
// ---------------------------------------------------------------------------

describe("trimConversationHistory", () => {
  test("no-op when conversation has fewer turns than the limit", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "good" },
    ];
    const result = trimConversationHistory(msgs, 5);
    expect(result).toBe(msgs); // same reference
  });

  test("trims to the last N user turns", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "reply 2" },
      { role: "user", content: "turn 3" },
      { role: "assistant", content: "reply 3" },
      { role: "user", content: "turn 4" },
    ];
    const result = trimConversationHistory(msgs, 2);
    // Should keep system + last 2 user turns (turn 3: user+assistant, turn 4: user)
    expect(result.length).toBe(4); // system + user3 + assistant3 + user4
    expect((result[0] as { content: string }).content).toBe("sys");
    expect((result[1] as { content: string }).content).toBe("turn 3");
    expect((result[2] as { content: string }).content).toBe("reply 3");
    expect((result[3] as { content: string }).content).toBe("turn 4");
  });

  test("preserves system prefix even if there are multiple system messages at the start", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "reply 2" },
      { role: "user", content: "turn 3" },
    ];
    const result = trimConversationHistory(msgs, 1);
    // Should keep both system messages + last 1 user turn
    expect(result.length).toBe(3); // sys1 + sys2 + user3
    expect((result[0] as { content: string }).content).toBe("sys1");
    expect((result[1] as { content: string }).content).toBe("sys2");
    expect((result[2] as { content: string }).content).toBe("turn 3");
  });

  test("keeps tool messages as part of the exchange", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "let me search" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "search", output: { type: "text", value: "result" } }] } as unknown as ModelMessage,
      { role: "assistant", content: "here is the answer" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "reply 2" },
    ];
    const result = trimConversationHistory(msgs, 1);
    // Last 1 user turn = turn 2 + reply 2
    expect(result.length).toBe(3); // sys + user2 + assistant2
    expect((result[1] as { content: string }).content).toBe("turn 2");
  });

  test("handles maxTurns of 0 by returning the input unchanged", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
    ];
    const result = trimConversationHistory(msgs, 0);
    expect(result).toBe(msgs);
  });
});

// ---------------------------------------------------------------------------
// Multi-breakpoint prompt caching
// ---------------------------------------------------------------------------

describe("multi-breakpoint prompt cache (Anthropic)", () => {
  test("marks conversation boundary in addition to system message", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "good" },
      { role: "user", content: "what is 2+2?" }, // current turn
    ];
    const out = applyAnthropicPromptCache(msgs);

    // System message should have cache breakpoint.
    const sys = out[0] as { providerOptions?: { anthropic?: unknown } };
    expect(sys.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });

    // The message just before the final user turn (assistant "good" at index 4)
    // should have the cache breakpoint.
    const boundary = out[4] as { providerOptions?: { anthropic?: unknown } };
    expect(boundary.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });

    // The final user message should NOT have a breakpoint.
    const lastUser = out[5] as { providerOptions?: unknown };
    expect(lastUser.providerOptions).toBeUndefined();
  });

  test("only marks system message when there is only one user turn", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];
    const out = applyAnthropicPromptCache(msgs);
    const sys = out[0] as { providerOptions?: { anthropic?: unknown } };
    expect(sys.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
    const user = out[1] as { providerOptions?: unknown };
    expect(user.providerOptions).toBeUndefined();
  });
});

describe("multi-breakpoint prompt cache (Bedrock)", () => {
  test("marks conversation boundary in addition to system message", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "good" },
      { role: "user", content: "what is 2+2?" }, // current turn
    ];
    const out = applyBedrockPromptCache(msgs, "1h");

    // System message should have cache breakpoint.
    const sys = out[0] as {
      providerOptions?: { bedrock?: { cachePoint?: { ttl?: string } } };
    };
    expect(sys.providerOptions?.bedrock?.cachePoint?.ttl).toBe("1h");

    // Boundary message (index 4) should have cache breakpoint.
    const boundary = out[4] as {
      providerOptions?: { bedrock?: { cachePoint?: { ttl?: string } } };
    };
    expect(boundary.providerOptions?.bedrock?.cachePoint?.ttl).toBe("1h");

    // Final user message should NOT have a breakpoint.
    const lastUser = out[5] as { providerOptions?: unknown };
    expect(lastUser.providerOptions).toBeUndefined();
  });
});
