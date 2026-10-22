// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-call loop guard + result memo wrapper for the `llm` node handler.
 *
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged. Wraps `runtime.executeToolCall` (coverage single-flight) rather
 * than replacing it.
 */
import type { FlowNode } from "../../types/flow.js";
import type { ExecRuntime } from "../exec-runtime.js";
import {
  detectToolLoop,
  hashToolArgs,
  isFailedOutcome,
  looksMutating,
  recordToolCall,
  recordToolOutcome,
  shouldEmitLoopWarning,
  type ToolLoopDetectionConfig,
} from "../tool-loop-detection.js";

/**
 * Tool-call loop guard (opt-in: `config.toolLoopGuard: true`, or an object
 * of ToolLoopDetectionConfig overrides). The detectors in
 * tool-loop-detection.ts exist since their commit but were never wired into
 * this loop — a production trace shows the consequence: an
 * unanswerable question drove 11 near-identical searches (863k prompt
 * tokens, 263 s) because `stopWhen: stepCountIs(maxToolSteps)` only bounds
 * the ceiling, not the futility. Off by default: research flows
 * legitimately fire dozens of varied searches per assignment; interactive
 * responders opt in. The guard wraps
 * `runtime.executeToolCall` (coverage single-flight) rather than replacing
 * it, and runs BEFORE the call so a critical verdict never reaches the MCP
 * server. Warnings ride inside the tool result — the model reads them;
 * diagnostics alone would not.
 *
 * Result memo (per node execution): a research flow that repeats the exact
 * same read-only call pays the MCP round-trip twice for identical bytes.
 * An internal test series showed 27 tool steps whose prompts grew ~6k chars each —
 * repeated searches for the same phrase cost ~1.2M prompt tokens in a single
 * flow. Keyed by tool name + canonicalised args, so only bit-identical
 * calls hit. Mutating tools (`looksMutating`) are never memoised, and a
 * failed outcome is never stored — a timeout must stay retryable.
 */
export function buildLoopGuardedExecuteToolCall(
  runtime: ExecRuntime,
  node: FlowNode,
): ExecRuntime["executeToolCall"] {
  const loopGuardSetting = (
    node.config as
      | { toolLoopGuard?: boolean | ToolLoopDetectionConfig }
      | undefined
  )?.toolLoopGuard;
  const loopGuardEnabled =
    loopGuardSetting === true ||
    (typeof loopGuardSetting === "object" && loopGuardSetting !== null);
  const innerExecuteToolCall = runtime.executeToolCall;
  const toolResultMemo = new Map<string, Promise<unknown>>();
  // Per-execution budget: the limit is checked BEFORE the call is
  // dispatched (a running call is never aborted) and the call counts against
  // it even when the loop guard later blocks it or the result memo serves it
  // from cache — an attempted call is a call.
  const budgetCheck = () => {
    runtime.executionBudget?.check("toolCalls");
    runtime.executionBudget?.check("wallMs");
    runtime.executionBudget?.addToolCall();
  };
  return loopGuardEnabled
    ? async (toolCallId, toolName, args, execute) => {
        budgetCheck();
        const memoKey = looksMutating(toolName)
          ? undefined
          : `${toolName}\u0000${hashToolArgs(args)}`;
        // The memo is consulted only AFTER the guard verdict below, never
        // before: a cached answer must still count as a call, or the
        // identical-repeat detector would never reach its threshold and a
        // model looping on one query would loop forever for free.
        const reuseMemo = async (): Promise<unknown> => {
          const cached = await (
            toolResultMemo as Map<string, Promise<unknown>>
          ).get(memoKey as string);
          runtime.onNodeDiagnostic?.(node.id, {
            level: "info",
            code: "tool_result_memo_hit",
            message: `Reused cached result for \`${toolName}\` (identical arguments).`,
            details: { node_id: node.id, tool: toolName },
          });
          return cached;
        };
        const runInner = (): Promise<unknown> =>
          innerExecuteToolCall !== undefined
            ? innerExecuteToolCall(toolCallId, toolName, args, execute)
            : execute();
        // Record the outcome against the call the guard is about to log, so
        // the churn detector can tell "the model kept re-asking" from "the
        // server kept timing out" — see CallRecord.failed.
        const runAndRecord = async (): Promise<unknown> => {
          let outcome: unknown;
          try {
            outcome = await runInner();
          } catch (error) {
            recordToolOutcome({
              state: runtime.toolLoopState as NonNullable<
                typeof runtime.toolLoopState
              >,
              toolName,
              outcome: error,
            });
            throw error;
          }
          recordToolOutcome({
            state: runtime.toolLoopState as NonNullable<
              typeof runtime.toolLoopState
            >,
            toolName,
            outcome,
          });
          return outcome;
        };
        const loopState = runtime.toolLoopState;
        if (loopState === undefined) {
          if (memoKey !== undefined && toolResultMemo.has(memoKey))
            return reuseMemo();
          const result = await runInner();
          if (memoKey !== undefined && !isFailedOutcome(result))
            toolResultMemo.set(memoKey, Promise.resolve(result));
          return result;
        }
        const verdict = detectToolLoop({
          state: loopState,
          toolName,
          args,
          now: Date.now(),
          ...(typeof loopGuardSetting === "object" &&
          loopGuardSetting !== null
            ? { config: loopGuardSetting }
            : {}),
        });
        if (verdict.stuck) {
          runtime.metrics.recordCounter(
            "aiperator_tool_loop_guard_total",
            {
              node: node.id,
              detector: verdict.detector,
              severity: verdict.severity,
            },
            1,
          );
          if (verdict.severity === "critical") {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "tool_loop_blocked",
              message: `Tool loop guard blocked \`${toolName}\` (${verdict.detector}, ${verdict.count}x): ${verdict.message}`,
              details: {
                node_id: node.id,
                detector: verdict.detector,
                count: verdict.count,
              },
            });
            // Deliberately NOT an `isError` envelope: the model must be
            // able to READ why the call was refused so it can change
            // strategy or answer from what it already has. A tool-error
            // shape is anonymised to a generic "Tool execution failed."
            // by `sanitizeToolResultOutput` before it reaches the prompt
            // (message-mapping.ts), which would erase the only signal the
            // model has. The operator-facing diagnostic above keeps the
            // structured code; the model gets a plain, readable result.
            return {
              loop_blocked: true,
              detector: verdict.detector,
              count: verdict.count,
              message: verdict.message,
            };
          }
          if (shouldEmitLoopWarning(loopState, verdict.warningKey)) {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "info",
              code: "tool_loop_warning",
              message: `Tool loop guard warned on \`${toolName}\` (${verdict.detector}, ${verdict.count}x).`,
              details: {
                node_id: node.id,
                detector: verdict.detector,
                count: verdict.count,
              },
            });
            recordToolCall({
              state: loopState,
              toolName,
              args,
              now: Date.now(),
            });
            if (memoKey !== undefined && toolResultMemo.has(memoKey)) {
              const cached = await reuseMemo();
              recordToolOutcome({
                state: loopState,
                toolName,
                outcome: cached,
              });
              // The warning must reach the MODEL, not just the operator: it
              // rides along as a sibling field of the real result.
              return { loop_warning: verdict.message, result: cached };
            }
            const result = await runAndRecord();
            if (memoKey !== undefined && !isFailedOutcome(result))
              toolResultMemo.set(memoKey, Promise.resolve(result));
            // The warning must reach the MODEL, not just the operator: it
            // rides along as a sibling field of the real result.
            return { loop_warning: verdict.message, result };
          }
        }
        recordToolCall({ state: loopState, toolName, args, now: Date.now() });
        if (memoKey !== undefined && toolResultMemo.has(memoKey)) {
          const cached = await reuseMemo();
          recordToolOutcome({ state: loopState, toolName, outcome: cached });
          return cached;
        }
        const pending = runAndRecord();
        if (memoKey !== undefined) {
          // Store the promise so concurrent identical calls share one
          // round-trip; drop the entry again if it fails, keeping the call
          // retryable.
          toolResultMemo.set(memoKey, pending);
          pending.catch(() => {
            if (toolResultMemo.get(memoKey) === pending)
              toolResultMemo.delete(memoKey);
          });
        }
        return pending;
      }
    : async (toolCallId, toolName, args, execute) => {
        budgetCheck();
        return innerExecuteToolCall !== undefined
          ? innerExecuteToolCall(toolCallId, toolName, args, execute)
          : execute();
      };
}
