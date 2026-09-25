"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowRunDrawer — the Studio builder's single test loop ("Run & Trace").
 *
 * Runs a prompt and highlights nodes on the SAME canvas as they execute.
 *
 * What runs:
 *  - "Canvas" (default): the definition currently on the canvas, unsaved edits
 *    included. It is registered via `POST /flows/:id/test-run` as a throwaway
 *    flow and run under the model id that call returns — nothing is saved and
 *    the live flow is untouched. Validation errors are reported instead of
 *    running a broken graph.
 *  - "Live": the version the runtime currently serves for `flowId`.
 *  An older runtime without the test-run endpoint falls back to "Live" and
 *  says so.
 *
 * Trace: opens the monitoring SSE stream and — since the backend does not echo
 * the execution_id back — locks onto the first execution starting at or after
 * submission (safe for this single-operator loop), then derives per-node
 * state with the shared `deriveNodeStates` and reports it up for the canvas.
 * Token/cost totals are summed from those node states.
 *
 * "Save as eval case" (formerly the separate Playground panel) hands prompt +
 * answer to the page, which stores it in the eval dataset.
 */

import type React from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { Button } from "../lib/ui";
import { useMonitoringEvents } from "../hooks/useMonitoringEvents";
import { deriveNodeStates, type NodeState } from "./graph/graphUtils";
import {
  streamChatCompletion,
  registerTestRun,
  type PlaygroundResult,
} from "../lib/studio-run";
import type { FlowDefinition, FlowValidationReport } from "../types/flow";

type RunTarget = "canvas" | "live";

export interface FlowRunDrawerProps {
  flowId: string;
  onLiveStatesChange: (states: Map<string, NodeState> | undefined) => void;
  /** Current canvas definition (source form) — what a "Canvas" run executes. */
  getDefinition?: () => FlowDefinition;
  /** True when the flow exists in the runtime, i.e. "Live" is runnable. */
  liveAvailable?: boolean;
  /** Canvas run refused by validation — lets the builder open its Problems list. */
  onValidationFailed?: (report: FlowValidationReport) => void;
  /**
   * Stores prompt + answer as an eval case with `expected` as the reference
   * answer. Rejects with a readable message when it could not be stored.
   */
  /** Resolves with the created eval case's id (when the backend returns one). */
  onSaveEvalCase?: (prompt: string, flowId: string, result: PlaygroundResult, expected: string) => Promise<string | undefined>;
  /** Removes a saved eval case again — offered right after saving. */
  onDeleteEvalCase?: (id: string) => Promise<void>;
}

function sumStates(states: Map<string, NodeState> | undefined) {
  if (!states || states.size === 0) return null;
  let input = 0;
  let output = 0;
  let cost = 0;
  let any = false;
  for (const s of states.values()) {
    if (s.input_tokens != null) { input += s.input_tokens; any = true; }
    if (s.output_tokens != null) { output += s.output_tokens; any = true; }
    if (s.cost != null) { cost += s.cost; any = true; }
  }
  return any ? { input, output, cost, nodes: states.size } : null;
}

export function FlowRunDrawer({
  flowId,
  onLiveStatesChange,
  getDefinition,
  liveAvailable = true,
  onValidationFailed,
  onSaveEvalCase,
  onDeleteEvalCase,
}: FlowRunDrawerProps): React.JSX.Element {
  const { token, isAuthenticated, renewNow } = useAuth();

  const [target, setTarget] = useState<RunTarget>(getDefinition ? "canvas" : "live");
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Map<string, NodeState> | undefined>(undefined);
  /** Eval-case form: closed, editing the expected answer, saving, or done. */
  const [evalForm, setEvalForm] = useState<
    | { state: "closed" }
    | { state: "editing" | "saving"; expected: string; error?: string }
    | { state: "saved" | "removing"; id?: string; error?: string }
    | { state: "removed" }
  >({ state: "closed" });
  const abortRef = useRef<AbortController | null>(null);

  const runStartedAtRef = useRef<number>(0);
  const activeExecutionIdRef = useRef<string | null>(null);
  const awaitingExecutionRef = useRef(false);

  const reportStates = useCallback(
    (states: Map<string, NodeState> | undefined) => {
      setRunStates(states);
      onLiveStatesChange(states);
    },
    [onLiveStatesChange],
  );

  // isAuthenticated statt !!token: bei AUTHN_MODE=disabled gibt es kein
  // Token, der Event-Stream ist trotzdem erreichbar.
  const { events } = useMonitoringEvents({
    enabled: !!flowId && isAuthenticated,
    token: token ?? undefined,
    onSessionExpired: renewNow,
  });

  // Lock onto the execution this run started (see module doc), then keep the
  // reported live-state map fresh as further events for it arrive.
  useEffect(() => {
    if (awaitingExecutionRef.current && activeExecutionIdRef.current === null) {
      let candidate: { id: string; start: number } | null = null;
      for (const e of events) {
        const t = new Date(e.start_time).getTime();
        if (Number.isNaN(t) || t < runStartedAtRef.current) continue;
        if (candidate === null || t < candidate.start) {
          candidate = { id: e.execution_id, start: t };
        }
      }
      if (candidate) {
        activeExecutionIdRef.current = candidate.id;
        awaitingExecutionRef.current = false;
      }
    }
    const id = activeExecutionIdRef.current;
    if (id === null) return;
    const scoped = events.filter((e) => e.execution_id === id);
    if (scoped.length > 0) reportStates(deriveNodeStates(scoped));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!flowId || !prompt.trim()) return;

    setIsRunning(true);
    setError(null);
    setNotice(null);
    setEvalForm({ state: "closed" });
    setStreamingContent("");
    setLastPrompt(prompt);
    reportStates(undefined);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let model = flowId;
      if (target === "canvas" && getDefinition) {
        const reg = await registerTestRun(token ?? null, getDefinition());
        if (reg.ok) {
          model = reg.model;
        } else if ("unsupported" in reg && reg.unsupported) {
          if (!liveAvailable) {
            setError("This runtime can't test unsaved canvases, and the flow isn't live yet — save it first.");
            return;
          }
          setNotice("This runtime can't run the canvas directly — ran the LIVE version instead.");
        } else {
          if (reg.validation) onValidationFailed?.(reg.validation);
          setError(reg.error);
          return;
        }
      }

      runStartedAtRef.current = Date.now();
      activeExecutionIdRef.current = null;
      awaitingExecutionRef.current = true;

      let fullContent = "";
      for await (const chunk of streamChatCompletion(
        token ?? null,
        model,
        prompt,
        controller.signal,
      )) {
        fullContent += chunk;
        setStreamingContent(fullContent);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [flowId, prompt, token, target, getDefinition, liveAvailable, onValidationFailed, reportStates]);

  const handleStop = (): void => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const handleClear = (): void => {
    activeExecutionIdRef.current = null;
    awaitingExecutionRef.current = false;
    setStreamingContent("");
    setError(null);
    setNotice(null);
    reportStates(undefined);
  };

  // Stop an in-flight run when the flow changes / the bar unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const totals = useMemo(() => sumStates(runStates), [runStates]);
  const hasOutput = Boolean(error || streamingContent || notice);

  const targetBtn = (t: RunTarget, label: string, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={target === t}
      onClick={() => setTarget(t)}
      disabled={isRunning || (t === "canvas" && !getDefinition) || (t === "live" && !liveAvailable)}
      title={title}
      className={`px-2 py-0.5 text-[11px] disabled:opacity-40 ${
        target === t ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs font-semibold text-muted-foreground">
          ▶ Run &amp; Trace
        </span>
        <div
          role="radiogroup"
          aria-label="What to run"
          className="flex shrink-0 overflow-hidden rounded border border-border"
        >
          {targetBtn("canvas", "Canvas", "Run what is on the canvas now, unsaved edits included. Nothing is saved.")}
          {targetBtn("live", "Live", "Run the version the runtime currently serves.")}
        </div>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleRun();
            }
          }}
          placeholder="Test prompt…"
          disabled={isRunning}
          aria-label="Test prompt"
          className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleRun()}
          disabled={isRunning || !flowId || !prompt.trim()}
        >
          {isRunning ? "Running…" : "Run"}
        </Button>
        {isRunning && (
          <Button variant="destructive" size="sm" onClick={handleStop}>
            Stop
          </Button>
        )}
        {hasOutput && !isRunning && (
          <button
            type="button"
            onClick={handleClear}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            title="Clear result and canvas trace"
          >
            ✕
          </button>
        )}
      </div>

      {hasOutput && (
        <div className="flex max-h-48 flex-col gap-1.5 overflow-auto rounded border border-border bg-muted p-2 text-xs">
          {notice && <p className="text-amber-600">{notice}</p>}
          {error ? (
            <p className="text-red-600" role="alert">
              {error}
            </p>
          ) : (
            streamingContent && (
              <pre className="whitespace-pre-wrap break-words text-foreground">
                {streamingContent}
                {isRunning && (
                  <span
                    className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </pre>
            )
          )}
          {onSaveEvalCase && (evalForm.state === "editing" || evalForm.state === "saving") && (
            <div className="space-y-1 rounded border border-border bg-card p-2">
              <label className="block text-[11px] font-medium text-foreground">
                Expected answer (reference for the eval)
                <textarea
                  aria-label="Expected answer"
                  rows={4}
                  value={evalForm.expected}
                  disabled={evalForm.state === "saving"}
                  onChange={(e) => setEvalForm({ state: "editing", expected: e.target.value })}
                  className="mt-0.5 w-full resize-y rounded border border-border bg-background px-2 py-1 text-[11px] font-normal"
                />
              </label>
              <p className="text-[10px] text-muted-foreground">
                Pre-filled with this run's answer — correct it to what the flow SHOULD answer. Evals compare future runs against it.
              </p>
              {evalForm.error && (
                <p role="alert" className="text-[11px] text-red-600">{evalForm.error}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEvalForm({ state: "closed" })}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={evalForm.state === "saving" || !evalForm.expected.trim()}
                  onClick={() => {
                    const expected = evalForm.expected;
                    setEvalForm({ state: "saving", expected });
                    onSaveEvalCase(
                      lastPrompt,
                      flowId,
                      {
                        content: streamingContent,
                        ...(totals
                          ? { promptTokens: totals.input, completionTokens: totals.output, cost: totals.cost }
                          : {}),
                      },
                      expected,
                    ).then(
                      (id) => setEvalForm({ state: "saved", ...(id ? { id } : {}) }),
                      (err: unknown) =>
                        setEvalForm({
                          state: "editing",
                          expected,
                          error: `Not saved: ${err instanceof Error ? err.message : String(err)}`,
                        }),
                    );
                  }}
                  className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  {evalForm.state === "saving" ? "Saving…" : "Save eval case"}
                </button>
              </div>
            </div>
          )}
          {!isRunning && !error && streamingContent && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
              {totals ? (
                <>
                  <span>{totals.nodes} node(s) traced</span>
                  <span>↑{totals.input} / ↓{totals.output} tokens</span>
                  <span>~${totals.cost.toFixed(5)}</span>
                </>
              ) : (
                <span>No trace data received (monitoring stream unavailable?)</span>
              )}
              {onSaveEvalCase && evalForm.state === "closed" && (
                <button
                  type="button"
                  onClick={() => setEvalForm({ state: "editing", expected: streamingContent })}
                  className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-card"
                  title="Store this prompt with a reference answer in the eval dataset"
                >
                  Save as eval case…
                </button>
              )}
              {(evalForm.state === "saved" || evalForm.state === "removing") && (
                <span className="ml-auto flex items-center gap-2">
                  {evalForm.error ? (
                    <span role="alert" className="text-red-600">{evalForm.error}</span>
                  ) : (
                    <span className="text-green-700">Saved to the eval dataset.</span>
                  )}
                  {onDeleteEvalCase && evalForm.id && (
                    <button
                      type="button"
                      disabled={evalForm.state === "removing"}
                      onClick={() => {
                        const id = evalForm.id as string;
                        setEvalForm({ state: "removing", id });
                        onDeleteEvalCase(id).then(
                          () => setEvalForm({ state: "removed" }),
                          (err: unknown) =>
                            setEvalForm({
                              state: "saved",
                              id,
                              error: `Not removed: ${err instanceof Error ? err.message : String(err)}`,
                            }),
                        );
                      }}
                      className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-card disabled:opacity-50"
                      title="Delete this eval case from the dataset again"
                    >
                      {evalForm.state === "removing" ? "Removing…" : "Remove"}
                    </button>
                  )}
                </span>
              )}
              {evalForm.state === "removed" && (
                <span className="ml-auto">Eval case removed.</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
