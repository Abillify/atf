// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-call loop detection.
 *
 * The two assertions worth singling out: the churn detector must NOT fire on a
 * run of identical calls (that is a different detector, and double-reporting one
 * loop under two names makes the diagnosis worse), and the approval clock must
 * make a two-minute human wait invisible — otherwise every approved call looks
 * like the start of a loop.
 */
import { describe, expect, test } from "bun:test";
import {
  createToolLoopState,
  detectToolLoop,
  enterPolicyWait,
  exitPolicyWait,
  hashToolArgs,
  looksMutating,
  loopClockNow,
  recordToolCall,
  recordToolOutcome,
  shouldEmitLoopWarning,
  type ToolLoopState,
} from "../tool-loop-detection.js";

const T0 = 1_700_000_000_000;

/** Runs `count` calls of `toolName`, optionally varying the arguments. */
function replay(
  state: ToolLoopState,
  toolName: string,
  count: number,
  argsFor: (index: number) => unknown = () => ({ q: "same" }),
  startAt = T0,
): void {
  for (let index = 0; index < count; index += 1) {
    recordToolCall({
      state,
      toolName,
      args: argsFor(index),
      now: startAt + index * 1_000,
    });
  }
}

describe("identical repetition", () => {
  test("warns at the third identical call", () => {
    const state = createToolLoopState();
    replay(state, "search", 2);
    const verdict = detectToolLoop({
      state,
      toolName: "search",
      args: { q: "same" },
      now: T0 + 3_000,
    });
    expect(verdict).toMatchObject({
      stuck: true,
      severity: "warning",
      detector: "identical-repetition",
      count: 3,
    });
  });

  test("blocks at the fifth", () => {
    const state = createToolLoopState();
    replay(state, "search", 4);
    const verdict = detectToolLoop({
      state,
      toolName: "search",
      args: { q: "same" },
      now: T0 + 5_000,
    });
    expect(verdict).toMatchObject({
      stuck: true,
      severity: "critical",
      count: 5,
    });
  });

  test("the message says what to do instead, not just that it happened", () => {
    const state = createToolLoopState();
    replay(state, "search", 4);
    const verdict = detectToolLoop({
      state,
      toolName: "search",
      args: { q: "same" },
      now: T0 + 5_000,
    });
    if (!verdict.stuck) throw new Error("expected a verdict");
    // A bare "loop detected" produces another attempt at the same thing.
    expect(verdict.message).toContain("Stop repeating it");
    expect(verdict.message).toContain("tell the user");
  });

  test("a different argument set breaks the identical run", () => {
    const state = createToolLoopState();
    replay(state, "search", 4);
    const verdict = detectToolLoop({
      state,
      toolName: "search",
      args: { q: "different" },
      now: T0 + 5_000,
    });
    expect(verdict.stuck).toBe(false);
  });

  test("argument key order does not create a false difference", () => {
    // JSON.stringify would hash these differently and hide the repetition.
    expect(hashToolArgs({ a: 1, b: 2 })).toBe(hashToolArgs({ b: 2, a: 1 }));
  });
});

describe("argument churn", () => {
  test("warns on many calls with varied arguments", () => {
    const state = createToolLoopState();
    replay(state, "lookup", 5, (index) => ({ id: `guess-${index}` }));
    const verdict = detectToolLoop({
      state,
      toolName: "lookup",
      args: { id: "guess-5" },
      now: T0 + 6_000,
    });
    expect(verdict).toMatchObject({
      stuck: true,
      detector: "argument-churn",
    });
  });

  test("blocks after enough churn", () => {
    const state = createToolLoopState();
    replay(state, "lookup", 9, (index) => ({ id: `guess-${index}` }));
    const verdict = detectToolLoop({
      state,
      toolName: "lookup",
      args: { id: "guess-9" },
      now: T0 + 10_000,
    });
    expect(verdict).toMatchObject({
      stuck: true,
      severity: "critical",
      detector: "argument-churn",
    });
  });

  test("does NOT fire on identical repetition", () => {
    const state = createToolLoopState();
    // Six identical calls: enough to hit the churn count, but with no variety.
    // Reporting this as churn would describe one loop under two names.
    replay(state, "lookup", 6);
    const verdict = detectToolLoop({
      state,
      toolName: "lookup",
      args: { q: "same" },
      now: T0 + 7_000,
    });
    if (!verdict.stuck) throw new Error("expected a verdict");
    expect(verdict.detector).toBe("identical-repetition");
  });

  test("calls outside the window do not accumulate", () => {
    const state = createToolLoopState();
    replay(state, "lookup", 8, (index) => ({ id: `guess-${index}` }), T0);
    // Well past the 120s window.
    const verdict = detectToolLoop({
      state,
      toolName: "lookup",
      args: { id: "fresh" },
      now: T0 + 500_000,
    });
    expect(verdict.stuck).toBe(false);
  });
});

describe("approval clock", () => {
  test("paused time is excluded from the clock", () => {
    const state = createToolLoopState();
    enterPolicyWait(state, T0);
    exitPolicyWait(state, T0 + 120_000);
    // Two minutes of human decision must not advance the detector's clock.
    expect(loopClockNow(state, T0 + 120_000)).toBe(T0);
  });

  test("nested waits only resume the clock when the last one clears", () => {
    const state = createToolLoopState();
    enterPolicyWait(state, T0);
    enterPolicyWait(state, T0 + 1_000);
    exitPolicyWait(state, T0 + 2_000);
    // Still paused: one wait outstanding. A boolean flag would have resumed here
    // and counted the remaining wait as agent time.
    expect(loopClockNow(state, T0 + 10_000)).toBe(T0);
    exitPolicyWait(state, T0 + 10_000);
    expect(loopClockNow(state, T0 + 10_000)).toBe(T0);
    expect(loopClockNow(state, T0 + 11_000)).toBe(T0 + 1_000);
  });

  test("an unbalanced exit is ignored rather than corrupting the clock", () => {
    const state = createToolLoopState();
    exitPolicyWait(state, T0);
    expect(loopClockNow(state, T0)).toBe(T0);
  });

  test("a long approval does not turn the next call into churn", () => {
    const state = createToolLoopState();
    replay(state, "lookup", 5, (index) => ({ id: `guess-${index}` }));
    // The window is measured on the paused clock, so the earlier calls stay
    // inside it and the churn verdict is unaffected by the wait itself.
    enterPolicyWait(state, T0 + 5_000);
    exitPolicyWait(state, T0 + 305_000);
    const verdict = detectToolLoop({
      state,
      toolName: "lookup",
      args: { id: "guess-5" },
      now: T0 + 306_000,
    });
    expect(verdict).toMatchObject({ detector: "argument-churn" });
  });
});

describe("no progress", () => {
  test("identical outcomes from a mutating tool are flagged", () => {
    const state = createToolLoopState();
    for (let index = 0; index < 3; index += 1) {
      recordToolCall({
        state,
        toolName: "write_file",
        args: { path: `f-${index}.txt` },
        now: T0 + index * 1_000,
      });
      recordToolOutcome({
        state,
        toolName: "write_file",
        outcome: { changed: false },
      });
    }
    const verdict = detectToolLoop({
      state,
      toolName: "write_file",
      args: { path: "f-3.txt" },
      now: T0 + 4_000,
    });
    expect(verdict).toMatchObject({ stuck: true, detector: "no-progress" });
  });

  test("a changing outcome is progress", () => {
    const state = createToolLoopState();
    for (let index = 0; index < 4; index += 1) {
      recordToolCall({
        state,
        toolName: "write_file",
        args: { path: `f-${index}.txt` },
        now: T0 + index * 1_000,
      });
      recordToolOutcome({
        state,
        toolName: "write_file",
        outcome: { bytes: index },
      });
    }
    const verdict = detectToolLoop({
      state,
      toolName: "write_file",
      args: { path: "f-4.txt" },
      now: T0 + 5_000,
    });
    expect(verdict.stuck).toBe(false);
  });

  test("read-only tools are not subject to this detector", () => {
    const state = createToolLoopState();
    for (let index = 0; index < 5; index += 1) {
      recordToolCall({
        state,
        toolName: "fetch_status",
        args: { id: index },
        now: T0 + index * 1_000,
      });
      recordToolOutcome({
        state,
        toolName: "fetch_status",
        outcome: { status: "ok" },
      });
    }
    const verdict = detectToolLoop({
      state,
      toolName: "fetch_status",
      args: { id: 99 },
      now: T0 + 6_000,
    });
    // A read-only tool returning the same value repeatedly is legitimate polling,
    // so the no-progress detector must stay out of it. The churn detector may
    // still comment on six varied calls in six seconds, which is a different and
    // fair observation.
    if (verdict.stuck) expect(verdict.detector).not.toBe("no-progress");
  });

  test("the mutation heuristic recognises the common verbs", () => {
    expect(looksMutating("write_file")).toBe(true);
    expect(looksMutating("createIssue")).toBe(true);
    expect(looksMutating("run_python")).toBe(true);
    expect(looksMutating("search")).toBe(false);
    expect(looksMutating("get_user")).toBe(false);
  });
});

describe("call-pair cycles", () => {
  test("an A/B alternation is detected", () => {
    const state = createToolLoopState();
    const sequence = ["open", "close", "open", "close", "open"];
    for (const [index, tool] of sequence.entries()) {
      recordToolCall({
        state,
        toolName: tool,
        args: { n: index },
        now: T0 + index * 1_000,
      });
    }
    const verdict = detectToolLoop({
      state,
      toolName: "close",
      args: { n: 5 },
      now: T0 + 6_000,
    });
    expect(verdict).toMatchObject({
      stuck: true,
      detector: "call-pair-cycle",
      pairedTool: "open",
    });
  });

  test("a run of one tool is not a cycle", () => {
    const state = createToolLoopState();
    replay(state, "open", 4, (index) => ({ n: index }));
    const verdict = detectToolLoop({
      state,
      toolName: "open",
      args: { n: 99 },
      now: T0 + 5_000,
    });
    if (verdict.stuck) expect(verdict.detector).not.toBe("call-pair-cycle");
  });

  test("a three-tool rotation is not reported as a pair cycle", () => {
    const state = createToolLoopState();
    const sequence = ["a", "b", "c", "a", "b", "c"];
    for (const [index, tool] of sequence.entries()) {
      recordToolCall({
        state,
        toolName: tool,
        args: { n: index },
        now: T0 + index * 1_000,
      });
    }
    const verdict = detectToolLoop({
      state,
      toolName: "a",
      args: { n: 6 },
      now: T0 + 7_000,
    });
    // Only one alternation deep (c→a), so below the warning bar.
    expect(verdict.stuck).toBe(false);
  });
});

describe("warning dedupe", () => {
  test("a warning key is emitted once", () => {
    const state = createToolLoopState();
    expect(shouldEmitLoopWarning(state, "churn:lookup")).toBe(true);
    // Repeating the warning on every call fills the context with copies of
    // itself, which is a variant of the problem it warns about.
    expect(shouldEmitLoopWarning(state, "churn:lookup")).toBe(false);
    expect(shouldEmitLoopWarning(state, "churn:other")).toBe(true);
  });
});

describe("bounds and configuration", () => {
  test("call history is bounded", () => {
    const state = createToolLoopState();
    replay(state, "search", 200, (index) => ({ n: index }));
    expect(state.calls.length).toBeLessThanOrEqual(64);
  });

  test("detection can be switched off", () => {
    const state = createToolLoopState();
    replay(state, "search", 10);
    const verdict = detectToolLoop({
      state,
      toolName: "search",
      args: { q: "same" },
      now: T0 + 11_000,
      config: { enabled: false },
    });
    expect(verdict.stuck).toBe(false);
  });

  test("thresholds are configurable", () => {
    const state = createToolLoopState();
    replay(state, "search", 1);
    const verdict = detectToolLoop({
      state,
      toolName: "search",
      args: { q: "same" },
      now: T0 + 2_000,
      config: { identicalWarnAt: 2, identicalBlockAt: 2 },
    });
    expect(verdict).toMatchObject({ stuck: true, severity: "critical" });
  });
});
