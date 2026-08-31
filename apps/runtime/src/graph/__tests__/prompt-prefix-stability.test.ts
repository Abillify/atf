// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the prompt-prefix stability probe.
 *
 * These assert the CONTRACT the prompt/KV caches rely on: a previous request
 * whose messages are an exact leading prefix of the current one is `appendOnly`,
 * and anything else reports the exact index where reuse stops.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import {
  comparePrefix,
  fingerprintMessages,
  fingerprintMessage,
  PromptPrefixTracker,
  streamKey,
} from "../prompt-prefix-stability.js";

function sys(text: string): ModelMessage {
  return { role: "system", content: text } as ModelMessage;
}
function user(text: string): ModelMessage {
  return { role: "user", content: text } as ModelMessage;
}
function assistant(text: string): ModelMessage {
  return { role: "assistant", content: text } as ModelMessage;
}

describe("fingerprintMessage", () => {
  test("is stable for identical messages and differs on content change", () => {
    expect(fingerprintMessage(user("hallo")).hash).toBe(
      fingerprintMessage(user("hallo")).hash,
    );
    expect(fingerprintMessage(user("hallo")).hash).not.toBe(
      fingerprintMessage(user("hallo!")).hash,
    );
  });

  test("distinguishes the same text under different roles", () => {
    expect(fingerprintMessage(user("x")).hash).not.toBe(
      fingerprintMessage(assistant("x")).hash,
    );
  });

  test("ignores providerOptions so cache_control markers are not a divergence", () => {
    // applyAnthropicPromptCache moves its breakpoint between turns. That is
    // cache metadata, not part of the token stream — treating it as a change
    // would report a divergence every single turn and mask real regressions.
    const plain = user("frage");
    const decorated = {
      role: "user",
      content: "frage",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    } as unknown as ModelMessage;
    expect(fingerprintMessage(decorated).hash).toBe(
      fingerprintMessage(plain).hash,
    );
  });

  test("hashes array content including non-text parts", () => {
    const a = {
      role: "user",
      content: [{ type: "text", text: "sieh dir das an" }],
    } as unknown as ModelMessage;
    const b = {
      role: "user",
      content: [
        { type: "text", text: "sieh dir das an" },
        { type: "image", image: "abc" },
      ],
    } as unknown as ModelMessage;
    expect(fingerprintMessage(a).hash).not.toBe(fingerprintMessage(b).hash);
  });
});

describe("comparePrefix", () => {
  test("append-only growth keeps the whole previous prompt reusable", () => {
    const prev = fingerprintMessages([sys("S"), user("f1"), assistant("a1")]);
    const curr = fingerprintMessages([
      sys("S"),
      user("f1"),
      assistant("a1"),
      user("f2"),
    ]);
    const r = comparePrefix(prev, curr);
    expect(r.appendOnly).toBe(true);
    expect(r.firstDivergenceIndex).toBe(-1);
    expect(r.stableMessages).toBe(3);
    expect(r.firstDivergenceRole).toBeUndefined();
  });

  test("a changed system message diverges at index 0", () => {
    const prev = fingerprintMessages([sys("S alt"), user("f1")]);
    const curr = fingerprintMessages([sys("S neu"), user("f1")]);
    const r = comparePrefix(prev, curr);
    expect(r.appendOnly).toBe(false);
    expect(r.firstDivergenceIndex).toBe(0);
    expect(r.firstDivergenceRole).toBe("system");
    expect(r.stableMessages).toBe(0);
    expect(r.stableChars).toBe(0);
    expect(r.reuseRatio).toBe(0);
  });

  test("dropping a middle message diverges at that index", () => {
    // This is the deduplicateRagContext / history-rewrite shape: the leading
    // system message survives but everything after the removal re-prefills.
    const prev = fingerprintMessages([
      sys("S"),
      user("rag-1"),
      user("f1"),
      assistant("a1"),
    ]);
    const curr = fingerprintMessages([
      sys("S"),
      user("f1"),
      assistant("a1"),
      user("f2"),
    ]);
    const r = comparePrefix(prev, curr);
    expect(r.appendOnly).toBe(false);
    expect(r.firstDivergenceIndex).toBe(1);
    expect(r.stableMessages).toBe(1);
  });

  test("reuseRatio is weighted by characters, not message count", () => {
    // One big stable system message plus one small new turn should report high
    // reuse — a message-count ratio would understate it badly.
    const big = "x".repeat(9_000);
    const prev = fingerprintMessages([sys(big)]);
    const curr = fingerprintMessages([sys(big), user("y".repeat(1_000))]);
    const r = comparePrefix(prev, curr);
    expect(r.appendOnly).toBe(true);
    expect(r.stableChars).toBe(9_000);
    expect(r.currentChars).toBe(10_000);
    expect(r.reuseRatio).toBe(0.9);
  });

  test("an identical repeated prompt is fully reused", () => {
    const msgs = fingerprintMessages([sys("S"), user("f1")]);
    const r = comparePrefix(msgs, msgs);
    expect(r.appendOnly).toBe(true);
    expect(r.reuseRatio).toBe(1);
  });

  test("an empty current prompt does not divide by zero", () => {
    const r = comparePrefix(fingerprintMessages([sys("S")]), []);
    expect(r.currentChars).toBe(0);
    expect(r.reuseRatio).toBe(0);
    expect(r.appendOnly).toBe(false);
  });

  test("a shortened history reports divergence at the truncation point", () => {
    // Trimming/compression: previous is LONGER than current, and the tail is
    // gone. The previous list is not a prefix of the current one.
    const prev = fingerprintMessages([sys("S"), user("f1"), assistant("a1")]);
    const curr = fingerprintMessages([sys("S"), user("f1")]);
    const r = comparePrefix(prev, curr);
    expect(r.appendOnly).toBe(false);
    expect(r.firstDivergenceIndex).toBe(2);
    expect(r.firstDivergenceRole).toBe("assistant");
  });
});

describe("PromptPrefixTracker", () => {
  test("reports nothing on first observation, then compares", () => {
    const t = new PromptPrefixTracker();
    const k = streamKey("chat-1", "responder", "openai/qwen3");
    expect(t.observe(k, [sys("S"), user("f1")])).toBeUndefined();
    const second = t.observe(k, [sys("S"), user("f1"), assistant("a1")]);
    expect(second?.appendOnly).toBe(true);
  });

  test("keeps streams independent per conversation, node and model", () => {
    const t = new PromptPrefixTracker();
    t.observe(streamKey("chat-1", "responder", "m1"), [sys("A")]);
    // Different node → separate stream, so still no comparison available.
    expect(
      t.observe(streamKey("chat-1", "planner", "m1"), [sys("B")]),
    ).toBeUndefined();
    // Different model → separate stream (a different cache entirely).
    expect(
      t.observe(streamKey("chat-1", "responder", "m2"), [sys("A")]),
    ).toBeUndefined();
    // Same triple → compares against the first observation.
    expect(
      t.observe(streamKey("chat-1", "responder", "m1"), [sys("A")]),
    ).toBeDefined();
  });

  test("evicts least-recently-observed streams beyond the cap", () => {
    const t = new PromptPrefixTracker(2);
    t.observe("a", [sys("A")]);
    t.observe("b", [sys("B")]);
    t.observe("a", [sys("A")]); // refresh "a" so "b" is now the oldest
    t.observe("c", [sys("C")]); // evicts "b"
    expect(t.size).toBe(2);
    // Assert the survivor BEFORE probing the evicted key: every observe() is
    // itself an insertion, so probing "b" would evict another entry.
    expect(t.observe("a", [sys("A")])).toBeDefined(); // survived
    expect(t.observe("b", [sys("B")])).toBeUndefined(); // was evicted
    expect(t.size).toBe(2); // stays bounded
  });

  test("forget drops a stream", () => {
    const t = new PromptPrefixTracker();
    t.observe("k", [sys("S")]);
    t.forget("k");
    expect(t.observe("k", [sys("S")])).toBeUndefined();
  });
});
