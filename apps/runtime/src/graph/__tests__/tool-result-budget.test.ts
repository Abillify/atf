// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the tool-result size budget.
 *
 * The contracts that matter:
 *   - capping is DETERMINISTIC (same input → same bytes), otherwise every
 *     replay step would invalidate the prompt-cache prefix;
 *   - the NEWEST result is never demoted (the loop must be able to progress);
 *   - head AND tail survive (failures/totals live at the end of tool output);
 *   - the AI-SDK path and the history path produce identical text for the same
 *     result sequence.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { ToolMessage, AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import {
  applyToolResultBudget,
  applyToolResultBudgetToHistory,
  budgetForContextWindow,
  capToolResultText,
  DEFAULT_RESULT_MAX_CHARS,
  DEFAULT_TURN_BUDGET_CHARS,
  DEMOTED_HEAD_CHARS,
  DEMOTED_TAIL_CHARS,
} from "../tool-result-budget.js";

/** Builds an AI-SDK tool message carrying one text tool-result part. */
function toolMsg(
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

function jsonToolMsg(
  toolCallId: string,
  toolName: string,
  value: unknown,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "json", value },
      },
    ],
  } as unknown as ModelMessage;
}

/** Reads the text payload back out of a tool message. */
function readText(msg: ModelMessage): string {
  const part = (msg.content as Array<{ output?: { value?: unknown } }>)[0];
  if (part === undefined) throw new Error("expected a first content part");
  return String(part.output?.value ?? "");
}

/** The message at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

describe("budgetForContextWindow", () => {
  test("unknown window yields the absolute defaults", () => {
    for (const bad of [undefined, 0, -1, Number.NaN]) {
      const b = budgetForContextWindow(bad as number | undefined);
      expect(b.perResultChars).toBe(DEFAULT_RESULT_MAX_CHARS);
      expect(b.perTurnChars).toBe(DEFAULT_TURN_BUDGET_CHARS);
    }
  });

  test("a large window is clamped to the historical defaults (no behaviour change)", () => {
    // 200k tokens ≈ 800k chars; 15% would be 120k, above the 100k default.
    const b = budgetForContextWindow(200_000);
    expect(b.perResultChars).toBe(DEFAULT_RESULT_MAX_CHARS);
    expect(b.perTurnChars).toBe(DEFAULT_TURN_BUDGET_CHARS);
  });

  test("a small local window shrinks the budget proportionally", () => {
    // 32k tokens ≈ 128k chars → 15% = 19_200, 30% = 38_400.
    const b = budgetForContextWindow(32_768);
    expect(b.perResultChars).toBeLessThan(DEFAULT_RESULT_MAX_CHARS);
    expect(b.perTurnChars).toBeLessThan(DEFAULT_TURN_BUDGET_CHARS);
    expect(b.perResultChars).toBe(Math.floor(32_768 * 4 * 0.15));
    expect(b.perTurnChars).toBe(Math.floor(32_768 * 4 * 0.3));
  });

  test("a tiny window is floored so output stays usable", () => {
    const b = budgetForContextWindow(2_000);
    expect(b.perResultChars).toBeGreaterThanOrEqual(8_000);
    expect(b.perTurnChars).toBeGreaterThanOrEqual(16_000);
  });

  test("per-result budget never exceeds the per-turn budget", () => {
    // Invariant: a single result may not be allowed more than the whole turn.
    for (const win of [2_000, 8_000, 32_768, 128_000, 200_000, 1_048_576]) {
      const b = budgetForContextWindow(win);
      expect(b.perResultChars).toBeLessThanOrEqual(b.perTurnChars);
    }
  });
});

describe("capToolResultText", () => {
  test("content within the cap is returned untouched", () => {
    const r = capToolResultText("kurz", 1_000, "read");
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("kurz");
  });

  test("keeps both the head and the tail", () => {
    const body = `HEAD${"x".repeat(50_000)}TAIL`;
    const r = capToolResultText(body, 10_000, "read");
    expect(r.truncated).toBe(true);
    expect(r.content.startsWith("HEAD")).toBe(true);
    expect(r.content.endsWith("TAIL")).toBe(true);
  });

  test("is deterministic — the same input yields identical bytes", () => {
    // This is what keeps the prompt prefix stable across replay steps.
    const body = "x".repeat(80_000);
    expect(capToolResultText(body, 10_000, "read").content).toBe(
      capToolResultText(body, 10_000, "read").content,
    );
  });

  test("names the tool so the model knows what to re-issue", () => {
    const r = capToolResultText("x".repeat(50_000), 5_000, "vectorsearch");
    expect(r.content).toContain("vectorsearch");
  });

  test("reports how much was elided", () => {
    const r = capToolResultText("x".repeat(50_000), 5_000, "read");
    expect(r.originalChars).toBe(50_000);
    expect(r.content).toContain("elided");
  });

  test("the marker counts against the cap — output never exceeds maxChars", () => {
    // The bug this guards: with the marker OUTSIDE the budget, capped output was
    // longer than its own cap, so the next replay step re-capped it and the
    // bytes the model had already seen changed — a prompt-cache miss per step.
    for (const max of [2_000, 5_000, 10_000, 40_000]) {
      const r = capToolResultText("x".repeat(120_000), max, "read");
      expect(r.content.length).toBeLessThanOrEqual(max);
    }
  });

  test("capping is idempotent at the text level", () => {
    const once = capToolResultText("x".repeat(120_000), 5_000, "read");
    const twice = capToolResultText(once.content, 5_000, "read");
    expect(twice.truncated).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  test("falls back to a plain cut when the budget cannot fit a marker", () => {
    const r = capToolResultText("x".repeat(1_000), 40, "read");
    expect(r.truncated).toBe(true);
    expect(r.content).toHaveLength(40);
  });

  test("a zero/negative cap is a no-op rather than erasing content", () => {
    expect(capToolResultText("abc", 0).truncated).toBe(false);
    expect(capToolResultText("abc", -5).content).toBe("abc");
  });
});

describe("applyToolResultBudget (AI SDK path)", () => {
  const budget = { perResultChars: 5_000, perTurnChars: 12_000 };

  test("leaves a list without tool results untouched (same reference)", () => {
    const msgs = [
      { role: "user", content: "hi" } as ModelMessage,
      { role: "assistant", content: "hallo" } as ModelMessage,
    ];
    const out = applyToolResultBudget(msgs, budget);
    expect(out.messages).toBe(msgs);
    expect(out.stats.inspected).toBe(0);
  });

  test("leaves small results untouched (same reference)", () => {
    const msgs = [toolMsg("1", "read", "klein")];
    const out = applyToolResultBudget(msgs, budget);
    expect(out.messages).toBe(msgs);
    expect(out.stats.cappedByResult).toBe(0);
  });

  test("caps an oversized single result", () => {
    const msgs = [toolMsg("1", "read", "y".repeat(40_000))];
    const out = applyToolResultBudget(msgs, budget);
    expect(out.stats.cappedByResult).toBe(1);
    expect(readText(at(out.messages, 0)).length).toBeLessThan(40_000);
    expect(out.stats.charsSaved).toBeGreaterThan(30_000);
  });

  test("does not mutate the input messages", () => {
    const msgs = [toolMsg("1", "read", "y".repeat(40_000))];
    const before = readText(at(msgs, 0));
    applyToolResultBudget(msgs, budget);
    expect(readText(at(msgs, 0))).toBe(before);
  });

  test("demotes the OLDEST results and keeps the newest at full size", () => {
    // Three results of 4_500 chars each = 13_500 > perTurnChars (12_000).
    const msgs = [
      toolMsg("1", "read", "a".repeat(4_500)),
      toolMsg("2", "read", "b".repeat(4_500)),
      toolMsg("3", "read", "c".repeat(4_500)),
    ];
    const out = applyToolResultBudget(msgs, budget);
    // Newest keeps its full (pass-1) size.
    expect(readText(at(out.messages, 2))).toHaveLength(4_500);
    // Oldest was demoted to the short preview.
    expect(readText(at(out.messages, 0)).length).toBeLessThan(4_500);
    expect(out.stats.demotedByTurn).toBeGreaterThanOrEqual(1);
  });

  test("the newest result is admitted even when it alone exceeds the turn budget", () => {
    // Otherwise the model could never make progress on the call it just made.
    const tight = { perResultChars: 20_000, perTurnChars: 5_000 };
    const msgs = [toolMsg("1", "read", "z".repeat(15_000))];
    const out = applyToolResultBudget(msgs, tight);
    expect(readText(at(out.messages, 0))).toHaveLength(15_000);
    expect(out.stats.demotedByTurn).toBe(0);
  });

  test("is idempotent — re-applying does not shrink further", () => {
    // Required for cache stability: prepareStep runs on every step, and step N+1
    // must produce the same bytes as step N for an unchanged result.
    const msgs = [
      toolMsg("1", "read", "a".repeat(9_000)),
      toolMsg("2", "read", "b".repeat(9_000)),
    ];
    const once = applyToolResultBudget(msgs, budget);
    const twice = applyToolResultBudget(once.messages, budget);
    expect(twice.messages.map(readText)).toEqual(once.messages.map(readText));
  });

  test("appending a new result does not alter earlier results' bytes", () => {
    // Prefix-stability contract inside a turn: step N+1 adds a result; the
    // already-shown ones must not be rewritten (beyond an intended demotion).
    const step1 = applyToolResultBudget(
      [toolMsg("1", "read", "a".repeat(3_000))],
      budget,
    );
    const step2 = applyToolResultBudget(
      [toolMsg("1", "read", "a".repeat(3_000)), toolMsg("2", "read", "b".repeat(3_000))],
      budget,
    );
    // Combined 6_000 < 12_000 budget, so nothing is demoted and result 1 is
    // byte-identical between the two steps.
    expect(readText(at(step2.messages, 0))).toBe(readText(at(step1.messages, 0)));
  });

  test("serialises and caps an oversized json result", () => {
    const big = { rows: Array.from({ length: 5_000 }, (_, i) => `row-${i}`) };
    const out = applyToolResultBudget([jsonToolMsg("1", "search", big)], budget);
    expect(out.stats.cappedByResult).toBe(1);
    const part = at(
      at(out.messages, 0).content as Array<{ output?: { type?: string } }>,
      0,
    );
    // Truncated JSON is no longer valid JSON, so it is re-emitted as text.
    expect(part.output?.type).toBe("text");
  });

  test("preserves tool-call ids and tool names when rewriting", () => {
    const out = applyToolResultBudget(
      [toolMsg("call-42", "vectorsearch", "y".repeat(40_000))],
      budget,
    );
    const part = at(
      at(out.messages, 0).content as Array<{
        toolCallId?: string;
        toolName?: string;
      }>,
      0,
    );
    expect(part.toolCallId).toBe("call-42");
    expect(part.toolName).toBe("vectorsearch");
  });

  test("non-tool-result parts in a tool message are left alone", () => {
    const msg = {
      role: "tool",
      content: [{ type: "something-else", payload: "x".repeat(40_000) }],
    } as unknown as ModelMessage;
    const input = [msg];
    const out = applyToolResultBudget(input, budget);
    // Unrecognised part shapes are not rewritten — returning the same reference
    // proves nothing was touched.
    expect(out.messages).toBe(input);
    expect(out.stats.inspected).toBe(0);
  });
});

describe("applyToolResultBudgetToHistory (persistence path)", () => {
  const budget = { perResultChars: 5_000, perTurnChars: 12_000 };

  function histTool(id: string, name: string, text: string): BaseMessage {
    return new ToolMessage({ content: text, tool_call_id: id, name });
  }

  test("caps oversized tool messages and leaves other messages untouched", () => {
    const msgs: BaseMessage[] = [
      new HumanMessage("frage"),
      new AIMessage("antwort"),
      histTool("1", "read", "y".repeat(40_000)),
    ];
    const out = applyToolResultBudgetToHistory(msgs, budget);
    expect(out.stats.cappedByResult).toBe(1);
    expect(out.messages[0]).toBe(msgs[0]);
    expect(out.messages[1]).toBe(msgs[1]);
    expect(String(at(out.messages, 2).content).length).toBeLessThan(40_000);
  });

  test("preserves tool_call_id and name", () => {
    const out = applyToolResultBudgetToHistory(
      [histTool("call-7", "vectorsearch", "y".repeat(40_000))],
      budget,
    );
    const tm = out.messages[0] as ToolMessage;
    expect(tm.tool_call_id).toBe("call-7");
    expect(tm.name).toBe("vectorsearch");
  });

  test("returns the same reference when nothing needs capping", () => {
    const msgs = [histTool("1", "read", "klein")];
    expect(applyToolResultBudgetToHistory(msgs, budget).messages).toBe(msgs);
  });

  test("produces text identical to the AI-SDK path for the same sequence", () => {
    // The load-bearing consistency property: what gets persisted must equal what
    // the model was shown, or the next turn replays a different version of an
    // already-processed message.
    const texts = ["a".repeat(9_000), "b".repeat(4_500), "c".repeat(4_500)];
    const sdk = applyToolResultBudget(
      texts.map((t, i) => toolMsg(String(i), "read", t)),
      budget,
    );
    const hist = applyToolResultBudgetToHistory(
      texts.map((t, i) => histTool(String(i), "read", t)),
      budget,
    );
    expect(hist.messages.map((m) => String(m.content))).toEqual(
      sdk.messages.map(readText),
    );
  });

  test("demoted previews stay within the preview size", () => {
    const msgs = [
      histTool("1", "read", "a".repeat(9_000)),
      histTool("2", "read", "b".repeat(9_000)),
      histTool("3", "read", "c".repeat(9_000)),
    ];
    const out = applyToolResultBudgetToHistory(msgs, budget);
    const previewMax = DEMOTED_HEAD_CHARS + DEMOTED_TAIL_CHARS;
    const first = String(at(out.messages, 0).content);
    // Head + tail + marker; the payload kept is bounded by the preview size.
    expect(first.length).toBeLessThan(previewMax + 400);
  });
});
