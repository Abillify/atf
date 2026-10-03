// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-call loop detection (`src/graph/tool-loop-detection.ts`)
 *
 * Detects an agent that is *busy* but not *progressing*, by looking at the shape
 * of its tool calls rather than at its generated text.
 *
 * Distinct from `repetition-guard.ts`, which detects a degenerate generation loop
 * (the model emitting the same block of text endlessly). The two failures look
 * nothing alike from the inside: the text guard sees one runaway generation, this
 * sees a sequence of individually plausible calls that collectively achieve
 * nothing. Both are needed; neither subsumes the other.
 *
 * ## Why the existing limits are not enough
 *
 * `checkLimits` in `agent-harness/types.ts` bounds iterations, cost, and time.
 * Those are *ceilings*: they stop a runaway eventually, at the price of the whole
 * budget. A loop detector stops it at the point where the behaviour became
 * recognisable, which for an assistant that can execute code is the difference
 * between a wasted turn and a wasted hour.
 *
 * ## The four detectors
 *
 * 1. **Identical repetition.** Same tool, byte-identical arguments, N times. The
 *    unambiguous case.
 * 2. **Argument churn.** Same tool, arguments varying slightly each time, no
 *    result being used. This is a model guessing, and it is the most common real
 *    loop — it evades an identical-arguments check completely.
 * 3. **No progress.** Repeated mutating calls whose outcome never changes
 *    (writing a file whose content is already what is being written).
 * 4. **Call-pair cycles.** A→B→A→B. Two tools that undo or re-trigger each other.
 *
 * ## The approval clock
 *
 * Churn is measured over wall-clock time as well as call count, so a human
 * approval that takes two minutes would otherwise register as the model sitting
 * still — and then the *next* call after approval looks like churn. The clock is
 * therefore pausable: {@link enterPolicyWait} / {@link exitPolicyWait} bracket any
 * period where the agent is blocked on something outside itself. Nested waits are
 * counted, because several concurrent approvals can overlap and the clock must
 * only resume when the last one clears.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ToolLoopDetectionConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Identical calls before a warning. Default 3. */
  identicalWarnAt?: number;
  /** Identical calls before blocking. Default 5. */
  identicalBlockAt?: number;
  /** Same-tool calls with varying args before a warning. Default 6. */
  churnWarnAt?: number;
  /** Same-tool calls with varying args before blocking. Default 10. */
  churnBlockAt?: number;
  /**
   * Window in which churn is counted, excluding paused time. Default 120_000 ms.
   * Bounded by time as well as count so a long, legitimately varied session does
   * not accumulate into a false positive.
   */
  churnWindowMs?: number;
  /** Mutating calls with no observable effect before a warning. Default 3. */
  noProgressWarnAt?: number;
  /** Mutating calls with no observable effect before blocking. Default 5. */
  noProgressBlockAt?: number;
  /** Repetitions of an A→B→A→B cycle before a warning. Default 3. */
  cycleWarnAt?: number;
  /** Repetitions of an A→B→A→B cycle before blocking. Default 4. */
  cycleBlockAt?: number;
}

interface ResolvedConfig {
  enabled: boolean;
  identicalWarnAt: number;
  identicalBlockAt: number;
  churnWarnAt: number;
  churnBlockAt: number;
  churnWindowMs: number;
  noProgressWarnAt: number;
  noProgressBlockAt: number;
  cycleWarnAt: number;
  cycleBlockAt: number;
}

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  identicalWarnAt: 3,
  identicalBlockAt: 5,
  churnWarnAt: 6,
  churnBlockAt: 10,
  churnWindowMs: 120_000,
  noProgressWarnAt: 3,
  noProgressBlockAt: 5,
  cycleWarnAt: 3,
  cycleBlockAt: 4,
};

function resolveConfig(config?: ToolLoopDetectionConfig): ResolvedConfig {
  if (config === undefined) return DEFAULTS;
  const bounded = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    enabled: config.enabled ?? DEFAULTS.enabled,
    identicalWarnAt: bounded(config.identicalWarnAt, DEFAULTS.identicalWarnAt),
    identicalBlockAt: bounded(config.identicalBlockAt, DEFAULTS.identicalBlockAt),
    churnWarnAt: bounded(config.churnWarnAt, DEFAULTS.churnWarnAt),
    churnBlockAt: bounded(config.churnBlockAt, DEFAULTS.churnBlockAt),
    churnWindowMs: bounded(config.churnWindowMs, DEFAULTS.churnWindowMs),
    noProgressWarnAt: bounded(config.noProgressWarnAt, DEFAULTS.noProgressWarnAt),
    noProgressBlockAt: bounded(config.noProgressBlockAt, DEFAULTS.noProgressBlockAt),
    cycleWarnAt: bounded(config.cycleWarnAt, DEFAULTS.cycleWarnAt),
    cycleBlockAt: bounded(config.cycleBlockAt, DEFAULTS.cycleBlockAt),
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** Which detector fired. */
export type LoopDetector =
  | "identical-repetition"
  | "argument-churn"
  | "no-progress"
  | "call-pair-cycle";

/**
 * Severity.
 *
 * `warning` injects a note into the transcript and lets the call through — the
 * model often corrects itself once told. `critical` refuses the call. Two levels
 * rather than one because blocking on the first sign produces false positives on
 * legitimately repetitive work, and warning only produces an agent that ignores
 * the warning forever.
 */
export type LoopSeverity = "warning" | "critical";

export type LoopVerdict =
  | { stuck: false }
  | {
      stuck: true;
      severity: LoopSeverity;
      detector: LoopDetector;
      /** Occurrences that triggered the verdict. */
      count: number;
      /**
       * Message written into the transcript (warning) or returned as the refusal
       * (critical). States what was observed and what to do differently — a bare
       * "loop detected" produces another attempt at the same thing.
       */
      message: string;
      /** For `call-pair-cycle`, the other tool in the cycle. */
      pairedTool?: string;
      /** Dedupe key so one warning is not emitted on every subsequent call. */
      warningKey: string;
    };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CallRecord {
  toolName: string;
  /** Hash of the normalised arguments. */
  argsHash: string;
  /** Clock reading, already excluding paused time. */
  at: number;
  /** Outcome hash, set once the call completes. Absent while in flight. */
  outcomeHash?: string;
  /** True when the tool is known to mutate state. */
  mutating: boolean;
  /**
   * True once the call is known to have FAILED (transport error, timeout,
   * `isError` result). Infrastructure failures are not the model's fault: a
   * retry after an MCP timeout is a legitimate attempt to make progress, not
   * the aimless argument-guessing the churn detector exists to catch. The
   * internal test series showed the consequence of ignoring this:
   * 52-60 MCP 5 s timeouts per run inflated the churn counter until the guard
   * blocked the very searches that would have answered the question.
   */
  failed?: boolean;
}

/**
 * Per-session detection state.
 *
 * Bounded: only the most recent {@link MAX_TRACKED_CALLS} calls are retained. All
 * four detectors look at recent history, so an unbounded log would grow for the
 * length of a session to answer questions that never reach beyond its tail.
 */
export interface ToolLoopState {
  calls: CallRecord[];
  /** Warning keys already emitted, so a warning fires once per pattern. */
  warned: Set<string>;
  /** Nesting depth of policy waits. Zero means the clock is running. */
  policyWaitDepth: number;
  /** Wall-clock instant the current pause began. */
  pauseStartedAt?: number;
  /** Total paused milliseconds, subtracted from every clock reading. */
  pausedTotalMs: number;
}

/** Calls retained per session. */
const MAX_TRACKED_CALLS = 64;

/** Warning keys retained per session. */
const MAX_WARNED_KEYS = 64;

export function createToolLoopState(): ToolLoopState {
  return {
    calls: [],
    warned: new Set(),
    policyWaitDepth: 0,
    pausedTotalMs: 0,
  };
}

/**
 * The detector's clock: wall time minus time spent paused.
 *
 * Churn is partly a rate measurement, and a rate is meaningless if the numerator
 * includes minutes the agent spent blocked on a human. Reading the clock through
 * this function is what makes an approval invisible to the detector.
 */
export function loopClockNow(state: ToolLoopState, now: number): number {
  const activePause = state.pauseStartedAt !== undefined ? now - state.pauseStartedAt : 0;
  return now - state.pausedTotalMs - activePause;
}

/**
 * Marks the start of a period where the agent is blocked on something external
 * (an approval prompt, a human decision, a queued resource).
 *
 * Counted rather than boolean: several approvals can be outstanding at once, and
 * the clock must only resume when the last of them clears. A boolean would resume
 * on the first release and count the remaining wait as agent time.
 */
export function enterPolicyWait(state: ToolLoopState, now: number): void {
  state.policyWaitDepth += 1;
  if (state.policyWaitDepth === 1) state.pauseStartedAt = now;
}

/** Marks the end of one external wait. Resumes the clock at depth zero. */
export function exitPolicyWait(state: ToolLoopState, now: number): void {
  if (state.policyWaitDepth === 0) return;
  state.policyWaitDepth -= 1;
  if (state.policyWaitDepth === 0 && state.pauseStartedAt !== undefined) {
    state.pausedTotalMs += now - state.pauseStartedAt;
    state.pauseStartedAt = undefined;
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Stable hash of tool arguments.
 *
 * Keys are sorted recursively before serialisation: two calls with the same
 * arguments in a different key order are the same call, and `JSON.stringify`
 * would hash them differently and hide an identical repetition.
 */
export function hashToolArgs(args: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(args), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Hash of a tool result, used by the no-progress detector. */
export function hashToolOutcome(outcome: unknown): string {
  return hashToolArgs(outcome);
}

// ---------------------------------------------------------------------------
// Mutating tools
// ---------------------------------------------------------------------------

/**
 * Name fragments that mark a tool as state-mutating.
 *
 * Heuristic by necessity: tool names come from MCP servers with no capability
 * metadata, so there is nothing authoritative to consult. Used ONLY by the
 * no-progress detector, where a false negative costs a missed detection and a
 * false positive costs a spurious warning — both acceptable. Nothing about
 * authorisation depends on this list.
 */
const MUTATING_NAME_FRAGMENTS = [
  "write",
  "create",
  "update",
  "delete",
  "remove",
  "patch",
  "put",
  "post",
  "insert",
  "upsert",
  "set_",
  "save",
  "edit",
  "move",
  "rename",
  "apply",
  "send",
  "execute",
  "run",
];

/** True when the tool name suggests it changes state. */
export function looksMutating(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  return MUTATING_NAME_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectLoopInput {
  state: ToolLoopState;
  toolName: string;
  args: unknown;
  now: number;
  config?: ToolLoopDetectionConfig;
}

/**
 * Checks whether the call about to be made continues a loop.
 *
 * Called BEFORE the tool runs, so a critical verdict prevents the call rather
 * than reporting it afterwards. Does not mutate state — {@link recordToolCall}
 * does that, and separating them lets a caller evaluate a call it then decides
 * not to make.
 */
export function detectToolLoop(input: DetectLoopInput): LoopVerdict {
  const config = resolveConfig(input.config);
  if (!config.enabled) return { stuck: false };

  const clock = loopClockNow(input.state, input.now);
  const argsHash = hashToolArgs(input.args);
  const { calls } = input.state;

  // 1. Identical repetition — same tool, same arguments, consecutively.
  let identical = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined) break;
    if (call.toolName !== input.toolName || call.argsHash !== argsHash) break;
    identical += 1;
  }
  if (identical + 1 >= config.identicalBlockAt) {
    return {
      stuck: true,
      severity: "critical",
      detector: "identical-repetition",
      count: identical + 1,
      warningKey: `identical:${input.toolName}:${argsHash}`,
      message:
        `You have called \`${input.toolName}\` with identical arguments ${identical + 1} times. ` +
        "The result will not change. Stop repeating it: either use the result you already have, " +
        "change the arguments meaningfully, try a different approach, or tell the user what is blocking you.",
    };
  }
  if (identical + 1 >= config.identicalWarnAt) {
    return {
      stuck: true,
      severity: "warning",
      detector: "identical-repetition",
      count: identical + 1,
      warningKey: `identical:${input.toolName}:${argsHash}`,
      message:
        `Note: this is call ${identical + 1} to \`${input.toolName}\` with identical arguments. ` +
        "Repeating it will return the same result. Use the result you have, or change your approach.",
    };
  }

  // 2. Argument churn — same tool, varying arguments, within the active window.
  // Calls already known to have FAILED are excluded: retrying after a
  // transport error or timeout is progress-seeking, not guessing. Without
  // this, an infra outage (e.g. an MCP server slower than the request
  // timeout) drives the counter to a block while the model is doing
  // exactly the right thing. In-flight calls (outcome unknown) still count.
  const windowStart = clock - config.churnWindowMs;
  const recentSameTool = calls.filter(
    (call) =>
      call.toolName === input.toolName &&
      call.at >= windowStart &&
      call.failed !== true,
  );
  const distinctArgs = new Set(recentSameTool.map((call) => call.argsHash));
  distinctArgs.add(argsHash);
  const churnCount = recentSameTool.length + 1;
  // Churn requires VARIETY: a repeated-identical run is detector 1's business,
  // and counting it here too would report the same loop under two names.
  const churning = churnCount >= config.churnWarnAt && distinctArgs.size >= 3;
  if (churning && churnCount >= config.churnBlockAt) {
    return {
      stuck: true,
      severity: "critical",
      detector: "argument-churn",
      count: churnCount,
      warningKey: `churn:${input.toolName}`,
      message:
        `You have called \`${input.toolName}\` ${churnCount} times with ${distinctArgs.size} different argument sets ` +
        "without getting anywhere. Guessing at arguments is not converging. Stop, re-read what the tool " +
        "actually expects, or tell the user what you cannot determine.",
    };
  }
  if (churning) {
    return {
      stuck: true,
      severity: "warning",
      detector: "argument-churn",
      count: churnCount,
      warningKey: `churn:${input.toolName}`,
      message:
        `Note: ${churnCount} calls to \`${input.toolName}\` with ${distinctArgs.size} different argument sets. ` +
        "If you are guessing, stop and check the tool's expected input instead of trying another variation.",
    };
  }

  // 3. No progress — repeated mutating calls whose outcome never changes.
  if (looksMutating(input.toolName)) {
    const completedSameTool = calls.filter(
      (call) => call.toolName === input.toolName && call.mutating && call.outcomeHash !== undefined,
    );
    const lastOutcomes = completedSameTool.slice(-config.noProgressBlockAt);
    const distinctOutcomes = new Set(lastOutcomes.map((call) => call.outcomeHash));
    if (lastOutcomes.length >= config.noProgressWarnAt && distinctOutcomes.size === 1) {
      const severity: LoopSeverity =
        lastOutcomes.length >= config.noProgressBlockAt ? "critical" : "warning";
      return {
        stuck: true,
        severity,
        detector: "no-progress",
        count: lastOutcomes.length,
        warningKey: `no-progress:${input.toolName}`,
        message:
          severity === "critical"
            ? `\`${input.toolName}\` has produced the same outcome ${lastOutcomes.length} times in a row. ` +
              "Nothing is changing. Verify the current state before writing again, or report that the " +
              "change is not taking effect."
            : `Note: \`${input.toolName}\` returned the same outcome ${lastOutcomes.length} times. ` +
              "Check whether the change is actually being applied before repeating it.",
      };
    }
  }

  // 4. Call-pair cycle — A→B→A→B, where this call would be the next A or B.
  const cycle = detectCallPairCycle(calls, input.toolName);
  if (cycle !== undefined) {
    if (cycle.repetitions >= config.cycleBlockAt) {
      return {
        stuck: true,
        severity: "critical",
        detector: "call-pair-cycle",
        count: cycle.repetitions,
        pairedTool: cycle.pairedTool,
        warningKey: `cycle:${[input.toolName, cycle.pairedTool].sort().join("+")}`,
        message:
          `You are cycling between \`${input.toolName}\` and \`${cycle.pairedTool}\` ` +
          `(${cycle.repetitions} round trips). Each one appears to undo or re-trigger the other. ` +
          "Break the cycle: establish the current state once, then take a single decisive action.",
      };
    }
    if (cycle.repetitions >= config.cycleWarnAt) {
      return {
        stuck: true,
        severity: "warning",
        detector: "call-pair-cycle",
        count: cycle.repetitions,
        pairedTool: cycle.pairedTool,
        warningKey: `cycle:${[input.toolName, cycle.pairedTool].sort().join("+")}`,
        message:
          `Note: you have alternated between \`${input.toolName}\` and \`${cycle.pairedTool}\` ` +
          `${cycle.repetitions} times. Check whether these two calls are cancelling each other out.`,
      };
    }
  }

  return { stuck: false };
}

/**
 * Finds an A→B→A→B alternation ending at `nextTool`.
 *
 * Walks backwards while the tool names strictly alternate between two values.
 * Requires the pair to be distinct, so a run of the same tool is not reported as
 * a cycle — that is detector 1 or 2.
 */
function detectCallPairCycle(
  calls: readonly CallRecord[],
  nextTool: string,
): { pairedTool: string; repetitions: number } | undefined {
  const previous = calls[calls.length - 1];
  if (previous === undefined || previous.toolName === nextTool) return undefined;
  const pairedTool = previous.toolName;

  // `alternations` counts the call about to be made plus every strictly
  // alternating call before it. The walk therefore starts at the LAST recorded
  // call and expects `pairedTool` there — an earlier version started one index
  // further back, silently dropping the most recent call and under-counting every
  // cycle by one, so a genuine three-round-trip cycle reported two and never
  // reached the threshold.
  let alternations = 1;
  let expected = pairedTool;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined || call.toolName !== expected) break;
    alternations += 1;
    expected = expected === nextTool ? pairedTool : nextTool;
  }
  // Two alternations are one round trip.
  const repetitions = Math.floor(alternations / 2);
  return repetitions >= 1 ? { pairedTool, repetitions } : undefined;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Appends a call to the history. Call after the detection check. */
export function recordToolCall(params: {
  state: ToolLoopState;
  toolName: string;
  args: unknown;
  now: number;
}): void {
  const { state } = params;
  state.calls.push({
    toolName: params.toolName,
    argsHash: hashToolArgs(params.args),
    at: loopClockNow(state, params.now),
    mutating: looksMutating(params.toolName),
  });
  if (state.calls.length > MAX_TRACKED_CALLS) {
    state.calls.splice(0, state.calls.length - MAX_TRACKED_CALLS);
  }
}

/**
 * Whether a tool outcome represents a FAILURE rather than a result.
 *
 * Three shapes reach the runtime: an explicit `isError` envelope (the AI-SDK
 * tool-error convention), a thrown transport error surfaced as an error string,
 * and the loop-guard's own refusal. All three mean "the tool never produced
 * evidence", which the churn detector must not count against the model.
 */
export function isFailedOutcome(outcome: unknown): boolean {
  if (outcome === undefined || outcome === null) return true;
  // A thrown transport/execution error: never produced evidence.
  if (outcome instanceof Error) return true;
  if (typeof outcome === "object") {
    const record = outcome as Record<string, unknown>;
    if (record.isError === true) return true;
    // The loop guard's refusal envelope — the call never reached the server.
    if (record.loop_blocked === true) return true;
    // An AI-SDK tool-error part: { type: "tool-error", ... }.
    if (record.type === "tool-error") return true;
    return false;
  }
  if (typeof outcome === "string") {
    const trimmed = outcome.trim();
    if (trimmed.length === 0) return true;
    // `sanitizeToolResultOutput` maps any raw failure to this generic text
    // (message-mapping.ts); the structured diagnostic keeps the real cause.
    if (/^tool execution failed\.?$/iu.test(trimmed)) return true;
    return false;
  }
  return false;
}

/**
 * Attaches an outcome to the most recent matching call.
 *
 * Searched backwards for the newest call of that tool without an outcome, rather
 * than assuming the last entry: several tools can be in flight concurrently and
 * results arrive out of order.
 *
 * A failed outcome additionally marks the call so the argument-churn detector
 * ignores it — see {@link CallRecord.failed}.
 */
export function recordToolOutcome(params: {
  state: ToolLoopState;
  toolName: string;
  outcome: unknown;
}): void {
  const failed = isFailedOutcome(params.outcome);
  const hash = hashToolOutcome(params.outcome);
  for (let index = params.state.calls.length - 1; index >= 0; index -= 1) {
    const call = params.state.calls[index];
    if (call === undefined) continue;
    if (call.toolName === params.toolName && call.outcomeHash === undefined) {
      call.outcomeHash = hash;
      if (failed) call.failed = true;
      return;
    }
  }
}

/**
 * Whether a warning for this pattern should be emitted.
 *
 * Once per pattern per session. Repeating the same warning on every subsequent
 * call fills the context with copies of itself, which is a variant of the problem
 * it is warning about.
 */
export function shouldEmitLoopWarning(state: ToolLoopState, warningKey: string): boolean {
  if (state.warned.has(warningKey)) return false;
  if (state.warned.size >= MAX_WARNED_KEYS) {
    const oldest = state.warned.values().next();
    if (!oldest.done) state.warned.delete(oldest.value);
  }
  state.warned.add(warningKey);
  return true;
}
