// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for history compression.
 *
 * The contracts that matter:
 *   - the deterministic pre-pass is idempotent and only removes content the model
 *     has already seen byte-identically (so it can never break the prompt prefix);
 *   - a summary is REUSED verbatim while the range it covers is unchanged, which
 *     is what makes summarising compatible with prompt caching;
 *   - window boundaries land on user turns, so no synthetic message is inserted
 *     and no tool message is orphaned;
 *   - an unknown context window disables summarising rather than guessing;
 *   - failures and pointless compactions trip the breaker instead of retrying
 *     every turn.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import {
  ANTI_THRASH_COOLDOWN_MS,
  applySummary,
  CompressionBreaker,
  compressHistory,
  dedupeRepeatedToolResults,
  DEFAULT_THRESHOLD_RATIO,
  effectiveThresholdRatio,
  fingerprintRange,
  MAX_TRIGGER_RATIO,
  selectCompressionWindow,
  shouldCompress,
  SMALL_CTX_THRESHOLD_RATIO,
  SUMMARY_PREFIX,
  SummaryCache,
} from "../history-compression.js";
import { capSummaryInput } from "../history-summarizer.js";
import { estimateMessagesTokens } from "../context-window.js";

function user(text: string): ModelMessage {
  return { role: "user", content: text } as ModelMessage;
}
function assistant(text: string): ModelMessage {
  return { role: "assistant", content: text } as ModelMessage;
}
function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value: text },
      },
    ],
  } as unknown as ModelMessage;
}
function readToolText(msg: ModelMessage): string {
  const part = (msg.content as Array<{ output?: { value?: unknown } }>)[0];
  if (part === undefined) throw new Error("expected a first content part");
  return String(part.output?.value ?? "");
}

// ---------------------------------------------------------------------------

describe("effectiveThresholdRatio", () => {
  test("small windows get the raised floor", () => {
    // Compacting a 32K local model at 50% throws away half its only context.
    expect(effectiveThresholdRatio(32_768)).toBe(SMALL_CTX_THRESHOLD_RATIO);
  });

  test("large windows keep the configured default", () => {
    expect(effectiveThresholdRatio(1_048_576)).toBe(DEFAULT_THRESHOLD_RATIO);
  });

  test("raise-only — an explicitly higher configured value wins", () => {
    expect(effectiveThresholdRatio(32_768, 0.8)).toBe(0.8);
    // ...but a lower one is lifted to the floor.
    expect(effectiveThresholdRatio(32_768, 0.2)).toBe(SMALL_CTX_THRESHOLD_RATIO);
  });

  test("never exceeds the hard ceiling", () => {
    // Above this the provider rejects the request before compaction can fire.
    expect(effectiveThresholdRatio(32_768, 0.99)).toBe(MAX_TRIGGER_RATIO);
    expect(effectiveThresholdRatio(1_048_576, 5)).toBe(MAX_TRIGGER_RATIO);
  });

  test("unknown window falls back to the configured default", () => {
    expect(effectiveThresholdRatio(undefined)).toBe(DEFAULT_THRESHOLD_RATIO);
  });

  test("a nonsensical configured value falls back rather than disabling", () => {
    expect(effectiveThresholdRatio(1_048_576, 0)).toBe(DEFAULT_THRESHOLD_RATIO);
    expect(effectiveThresholdRatio(1_048_576, Number.NaN)).toBe(
      DEFAULT_THRESHOLD_RATIO,
    );
  });
});

describe("shouldCompress", () => {
  test("fires at or above the threshold", () => {
    expect(shouldCompress({ estimatedTokens: 0, utilization: 0.75 }, 0.75)).toBe(
      true,
    );
    expect(shouldCompress({ estimatedTokens: 0, utilization: 0.9 }, 0.75)).toBe(
      true,
    );
  });

  test("does not fire below the threshold", () => {
    expect(shouldCompress({ estimatedTokens: 0, utilization: 0.5 }, 0.75)).toBe(
      false,
    );
  });

  test("an unknown window never triggers compaction", () => {
    // Compacting on a guess would degrade context for no demonstrated reason.
    expect(shouldCompress({ estimatedTokens: 999_999 }, 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("dedupeRepeatedToolResults", () => {
  const body = "DOC".repeat(500); // 1500 chars, above the dedupe minimum

  test("keeps the newest copy and back-references the older ones", () => {
    const msgs = [
      user("lies das dokument"),
      toolResult("1", "read_file", body),
      assistant("ok"),
      user("nochmal"),
      toolResult("2", "read_file", body),
    ];
    const out = dedupeRepeatedToolResults(msgs);
    expect(out.stats.collapsed).toBe(1);
    const msg4 = out.messages[4];
    const msg1 = out.messages[1];
    if (msg4 === undefined || msg1 === undefined) {
      throw new Error("expected messages at indices 1 and 4");
    }
    // Newest keeps the payload.
    expect(readToolText(msg4)).toBe(body);
    // Older becomes a back-reference that points at the surviving copy.
    expect(readToolText(msg1)).toContain("Identical earlier");
    expect(readToolText(msg1)).toContain("read_file");
    expect(out.stats.charsSaved).toBeGreaterThan(1_000);
  });

  test("leaves differing results alone (same reference)", () => {
    const msgs = [
      toolResult("1", "read_file", body),
      toolResult("2", "read_file", `${body}X`),
    ];
    const out = dedupeRepeatedToolResults(msgs);
    expect(out.messages).toBe(msgs);
    expect(out.stats.collapsed).toBe(0);
  });

  test("ignores short results where a marker would cost more than the payload", () => {
    const msgs = [toolResult("1", "read_file", "kurz"), toolResult("2", "read_file", "kurz")];
    expect(dedupeRepeatedToolResults(msgs).messages).toBe(msgs);
  });

  test("is idempotent — re-applying changes nothing", () => {
    // Required for prompt-cache stability: this runs on every request.
    const msgs = [
      toolResult("1", "read_file", body),
      toolResult("2", "read_file", body),
      toolResult("3", "read_file", body),
    ];
    const once = dedupeRepeatedToolResults(msgs);
    const twice = dedupeRepeatedToolResults(once.messages);
    expect(twice.messages.map(readToolText)).toEqual(
      once.messages.map(readToolText),
    );
    expect(twice.stats.collapsed).toBe(0);
  });

  test("collapses all but the newest across three copies", () => {
    const msgs = [
      toolResult("1", "read_file", body),
      toolResult("2", "read_file", body),
      toolResult("3", "read_file", body),
    ];
    const out = dedupeRepeatedToolResults(msgs);
    expect(out.stats.collapsed).toBe(2);
    const msg2 = out.messages[2];
    if (msg2 === undefined) throw new Error("expected a message at index 2");
    expect(readToolText(msg2)).toBe(body);
  });

  test("does not mutate the input", () => {
    const msgs = [
      toolResult("1", "read_file", body),
      toolResult("2", "read_file", body),
    ];
    dedupeRepeatedToolResults(msgs);
    const msg0 = msgs[0];
    if (msg0 === undefined) throw new Error("expected a message at index 0");
    expect(readToolText(msg0)).toBe(body);
  });

  test("preserves tool call ids", () => {
    const out = dedupeRepeatedToolResults([
      toolResult("call-a", "read_file", body),
      toolResult("call-b", "read_file", body),
    ]);
    const firstMsg = out.messages[0];
    if (firstMsg === undefined) throw new Error("expected a first message");
    const part = (firstMsg.content as Array<{ toolCallId?: string }>)[0];
    if (part === undefined) throw new Error("expected a first content part");
    expect(part.toolCallId).toBe("call-a");
  });
});

// ---------------------------------------------------------------------------

describe("selectCompressionWindow", () => {
  /** Builds `turns` user/assistant exchanges. */
  function conversation(turns: number, chars = 400): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (let i = 0; i < turns; i++) {
      out.push(user(`frage-${i} ${"x".repeat(chars)}`));
      out.push(assistant(`antwort-${i} ${"y".repeat(chars)}`));
    }
    return out;
  }

  test("both boundaries land on user messages", () => {
    // This is what lets the summary ride on an existing turn instead of being
    // injected, and prevents orphaning a tool message from its assistant turn.
    const msgs = conversation(10);
    const w = selectCompressionWindow(msgs, 500);
    expect(w).toBeDefined();
    if (w === undefined) throw new Error("expected a compression window");
    const headMsg = msgs[w.headEnd];
    const tailMsg = msgs[w.tailStart];
    if (headMsg === undefined || tailMsg === undefined) {
      throw new Error("expected messages at the window boundaries");
    }
    expect(headMsg.role).toBe("user");
    expect(tailMsg.role).toBe("user");
  });

  test("returns undefined when there are too few turns to have a middle", () => {
    expect(selectCompressionWindow(conversation(2), 10_000)).toBeUndefined();
    expect(selectCompressionWindow([], 10_000)).toBeUndefined();
  });

  test("a generous tail budget keeps more turns verbatim", () => {
    const msgs = conversation(12);
    const tight = selectCompressionWindow(msgs, 200);
    const generous = selectCompressionWindow(msgs, 100_000);
    if (tight === undefined || generous === undefined) {
      throw new Error("expected both compression windows to be defined");
    }
    expect(generous.tailStart).toBeLessThanOrEqual(tight.tailStart);
  });

  test("honours the minimum tail turns even under a tiny budget", () => {
    const msgs = conversation(12);
    const w = selectCompressionWindow(msgs, 1);
    if (w === undefined) throw new Error("expected a compression window");
    // At least two user turns must survive in the tail.
    const tailUsers = msgs
      .slice(w.tailStart)
      .filter((m) => m.role === "user").length;
    expect(tailUsers).toBeGreaterThanOrEqual(2);
  });

  test("the head is preserved before the middle", () => {
    const msgs = conversation(10);
    const w = selectCompressionWindow(msgs, 500);
    if (w === undefined) throw new Error("expected a compression window");
    expect(w.headEnd).toBeGreaterThan(0);
    expect(w.tailStart).toBeGreaterThan(w.headEnd);
  });
});

// ---------------------------------------------------------------------------

describe("applySummary", () => {
  const msgs = [
    user("erste frage"),
    assistant("erste antwort"),
    user("zweite frage"),
    assistant("zweite antwort"),
    user("dritte frage"),
  ];

  test("replaces the middle and prefixes the summary onto the tail turn", () => {
    const out = applySummary(msgs, { headEnd: 2, tailStart: 4 }, "ZUSAMMENFASSUNG");
    // head (2) + merged tail head (1) + rest (0) = 3
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
    const mergedTail = out[2];
    if (mergedTail === undefined) throw new Error("expected a merged tail message");
    expect(String(mergedTail.content)).toContain("ZUSAMMENFASSUNG");
    expect(String(mergedTail.content)).toContain("dritte frage");
  });

  test("inserts no new message and creates no same-role adjacency", () => {
    // Strict providers (Bedrock Converse) reject both.
    const out = applySummary(msgs, { headEnd: 2, tailStart: 4 }, "S");
    for (const [i, msg] of out.entries()) {
      if (i === 0) continue;
      const prev = out[i - 1];
      if (prev === undefined) throw new Error("expected a previous message");
      expect(msg.role).not.toBe(prev.role);
    }
  });

  test("frames the summary as reference, not as a new instruction", () => {
    const out = applySummary(msgs, { headEnd: 2, tailStart: 4 }, "S");
    const mergedTail = out[2];
    if (mergedTail === undefined) throw new Error("expected a merged tail message");
    expect(String(mergedTail.content)).toContain(SUMMARY_PREFIX);
  });

  test("prepends a text part to a multimodal tail turn", () => {
    const withImage = [
      user("a"),
      assistant("b"),
      user("c"),
      assistant("d"),
      {
        role: "user",
        content: [{ type: "image", image: "xyz" }],
      } as unknown as ModelMessage,
    ];
    const out = applySummary(withImage, { headEnd: 2, tailStart: 4 }, "S");
    const mergedTail = out[2];
    if (mergedTail === undefined) throw new Error("expected a merged tail message");
    const content = mergedTail.content as Array<{ type: string }>;
    const [firstPart, secondPart] = content;
    if (firstPart === undefined || secondPart === undefined) {
      throw new Error("expected two content parts");
    }
    expect(firstPart.type).toBe("text");
    expect(secondPart.type).toBe("image"); // image survived
  });

  test("reduces the token estimate", () => {
    const long = [
      user("a".repeat(400)),
      assistant("b".repeat(400)),
      user("c".repeat(4_000)),
      assistant("d".repeat(4_000)),
      user("e".repeat(400)),
    ];
    const before = estimateMessagesTokens(long);
    const after = estimateMessagesTokens(
      applySummary(long, { headEnd: 2, tailStart: 4 }, "kurz"),
    );
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------

describe("SummaryCache", () => {
  test("returns a summary only for a matching range fingerprint", () => {
    const c = new SummaryCache();
    c.set("k", "fp-1", "SUMMARY");
    expect(c.get("k", "fp-1")).toBe("SUMMARY");
    // Range changed → the cached summary no longer describes it.
    expect(c.get("k", "fp-2")).toBeUndefined();
  });

  test("evicts least-recently-used entries beyond the cap", () => {
    const c = new SummaryCache(2);
    c.set("a", "f", "A");
    c.set("b", "f", "B");
    c.get("a", "f"); // refresh a
    c.set("c", "f", "C"); // evicts b
    expect(c.size).toBe(2);
    expect(c.get("b", "f")).toBeUndefined();
    expect(c.get("a", "f")).toBe("A");
  });
});

describe("fingerprintRange", () => {
  test("is stable for identical ranges and differs on content change", () => {
    const a = [user("x"), assistant("y")];
    expect(fingerprintRange(a)).toBe(fingerprintRange([user("x"), assistant("y")]));
    expect(fingerprintRange(a)).not.toBe(
      fingerprintRange([user("x"), assistant("z")]),
    );
  });

  test("distinguishes the same text under different roles", () => {
    expect(fingerprintRange([user("x")])).not.toBe(
      fingerprintRange([assistant("x")]),
    );
  });
});

describe("CompressionBreaker", () => {
  test("blocks for the cooldown window, then recovers", () => {
    const b = new CompressionBreaker();
    const t0 = 1_000_000;
    expect(b.isBlocked("k", t0)).toBe(false);
    b.trip("k", t0);
    expect(b.isBlocked("k", t0 + 1)).toBe(true);
    expect(b.isBlocked("k", t0 + ANTI_THRASH_COOLDOWN_MS - 1)).toBe(true);
    expect(b.isBlocked("k", t0 + ANTI_THRASH_COOLDOWN_MS)).toBe(false);
  });

  test("reset clears the block", () => {
    const b = new CompressionBreaker();
    b.trip("k", 0);
    b.reset("k");
    expect(b.isBlocked("k", 1)).toBe(false);
  });

  test("stays bounded", () => {
    const b = new CompressionBreaker(1_000, 2);
    b.trip("a", 0);
    b.trip("b", 0);
    b.trip("c", 0);
    expect(b.isBlocked("a", 1)).toBe(false); // evicted
    expect(b.isBlocked("c", 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("compressHistory", () => {
  const body = "DOC".repeat(500);

  function longConversation(turns: number, chars = 2_000): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (let i = 0; i < turns; i++) {
      out.push(user(`frage-${i} ${"x".repeat(chars)}`));
      out.push(assistant(`antwort-${i} ${"y".repeat(chars)}`));
    }
    out.push(user("aktuelle frage"));
    return out;
  }

  const neverCalled = async (): Promise<string | undefined> => {
    throw new Error("summarizer must not be called");
  };

  test("runs the deterministic pre-pass even when the window is unknown", () => {
    return compressHistory(
      [
        user("a"),
        toolResult("1", "read_file", body),
        assistant("b"),
        user("c"),
        toolResult("2", "read_file", body),
      ],
      {
        key: "k",
        thresholdRatio: 0.5,
        summarize: neverCalled,
        cache: new SummaryCache(),
        breaker: new CompressionBreaker(),
      },
    ).then((r) => {
      expect(r.dedupe.collapsed).toBe(1);
      expect(r.summarized).toBe(false);
      expect(r.skipped).toBe("unknown-window");
    });
  });

  test("skips summarising when the pre-pass brought it under the threshold", async () => {
    // The cheapest win: a summariser call avoided entirely.
    const msgs = [
      user("a"),
      toolResult("1", "read_file", "Z".repeat(20_000)),
      assistant("b"),
      user("c"),
      toolResult("2", "read_file", "Z".repeat(20_000)),
      assistant("d"),
      user("e"),
    ];
    const r = await compressHistory(msgs, {
      key: "k",
      inputBudget: 12_000,
      thresholdRatio: 0.75,
      summarize: neverCalled,
      cache: new SummaryCache(),
      breaker: new CompressionBreaker(),
    });
    expect(r.dedupe.collapsed).toBe(1);
    expect(r.skipped).toBe("under-threshold");
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
  });

  test("summarises when over the threshold and reports the reduction", async () => {
    const msgs = longConversation(10);
    const r = await compressHistory(msgs, {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize: async () => "KURZE ZUSAMMENFASSUNG",
      cache: new SummaryCache(),
      breaker: new CompressionBreaker(),
    });
    expect(r.summarized).toBe(true);
    expect(r.summaryFromCache).toBe(false);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    expect(r.messages.length).toBeLessThan(msgs.length);
  });

  test("reuses the cached summary while the covered range is unchanged", async () => {
    // The load-bearing property: without this the summary bytes would differ
    // every turn and invalidate the prompt-cache prefix on every request.
    const cache = new SummaryCache();
    const breaker = new CompressionBreaker();
    let calls = 0;
    const summarize = async (): Promise<string> => {
      calls++;
      return `SUMMARY-${calls}`;
    };
    const msgs = longConversation(10);
    const opts = {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize,
      cache,
      breaker,
    };

    const first = await compressHistory(msgs, opts);
    const second = await compressHistory(msgs, opts);

    expect(calls).toBe(1);
    expect(second.summaryFromCache).toBe(true);
    // Identical bytes on the second pass — the prefix survives.
    expect(second.messages.map((m) => String(m.content))).toEqual(
      first.messages.map((m) => String(m.content)),
    );
  });

  test("regenerates the summary when the covered range changes", async () => {
    const cache = new SummaryCache();
    const breaker = new CompressionBreaker();
    let calls = 0;
    const summarize = async (): Promise<string> => `SUMMARY-${++calls}`;
    const base = {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize,
      cache,
      breaker,
    };

    await compressHistory(longConversation(10), base);
    // A longer conversation shifts the window, so the covered range differs.
    await compressHistory(longConversation(16), base);
    expect(calls).toBe(2);
  });

  test("a failing summariser fails open and trips the breaker", async () => {
    const breaker = new CompressionBreaker();
    const msgs = longConversation(10);
    const opts = {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize: async (): Promise<string | undefined> => {
        throw new Error("provider down");
      },
      cache: new SummaryCache(),
      breaker,
    };
    const r = await compressHistory(msgs, opts);
    // History is preserved — losing it would be worse than an oversized prompt.
    expect(r.summarized).toBe(false);
    expect(r.skipped).toBe("summarizer-failed");
    expect(breaker.isBlocked("k")).toBe(true);

    // Second attempt short-circuits on the cooldown instead of retrying.
    const again = await compressHistory(msgs, opts);
    expect(again.skipped).toBe("cooldown");
  });

  test("an empty summary is treated as a failure", async () => {
    const r = await compressHistory(longConversation(10), {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize: async () => "   ",
      cache: new SummaryCache(),
      breaker: new CompressionBreaker(),
    });
    expect(r.skipped).toBe("summarizer-failed");
  });

  test("a summary that does not shrink anything is rejected", async () => {
    // Paying for a model call AND replacing verbatim history with a paraphrase
    // that is just as long is strictly worse than doing nothing.
    const breaker = new CompressionBreaker();
    const r = await compressHistory(longConversation(10), {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize: async () => "S".repeat(200_000),
      cache: new SummaryCache(),
      breaker,
    });
    expect(r.summarized).toBe(false);
    expect(r.skipped).toBe("ineffective");
    expect(breaker.isBlocked("k")).toBe(true);
  });

  test("a conversation with no summarisable middle trips the breaker", async () => {
    const breaker = new CompressionBreaker();
    const r = await compressHistory([user("x".repeat(200_000))], {
      key: "k",
      inputBudget: 2_000,
      thresholdRatio: 0.5,
      summarize: neverCalled,
      cache: new SummaryCache(),
      breaker,
    });
    expect(r.skipped).toBe("no-window");
    expect(breaker.isBlocked("k")).toBe(true);
  });
});

describe("capSummaryInput", () => {
  test("passes short transcripts through untouched", () => {
    expect(capSummaryInput("kurz", 1_000)).toBe("kurz");
  });

  test("keeps head and tail of an oversized transcript", () => {
    const t = `HEAD${"x".repeat(50_000)}TAIL`;
    const out = capSummaryInput(t, 5_000);
    expect(out.length).toBeLessThanOrEqual(5_000);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("omitted");
  });

  test("is deterministic", () => {
    const t = "x".repeat(50_000);
    expect(capSummaryInput(t, 5_000)).toBe(capSummaryInput(t, 5_000));
  });
});
