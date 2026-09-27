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
 *
 * Attach: `attachExecutionId` (a request opened from the Live Graph) shows a
 * recorded execution — running or finished — exactly like a run started
 * here: durable events merged with the live stream drive the canvas trace,
 * prompt and answer come from the request/response boundaries, and it can be
 * pinned or saved as an eval case. A new run or Clear detaches.
 */

import type React from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { Button } from "../lib/ui";
import { useMonitoringEvents } from "../hooks/useMonitoringEvents";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { describeRun, mergeExecutionEvents, type AttachedRunInfo } from "../lib/run-attach";
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
  /**
   * The canvas is unchanged from the live version (no edits since loading a
   * file or published flow). A "Canvas" run then runs the live flow under its
   * real id, so it counts as flow traffic (Autopilot/Optimizer snapshots)
   * instead of a throwaway `<id>@studio-…` test run.
   */
  canvasIsLive?: boolean;
  /** Canvas run refused by validation — lets the builder open its Problems list. */
  onValidationFailed?: (report: FlowValidationReport) => void;
  /**
   * Stores prompt + answer as an eval case with `expected` as the reference
   * answer. Rejects with a readable message when it could not be stored.
   */
  /** Resolves with the created eval case's id (when the backend returns one). */
  onSaveEvalCase?: (prompt: string, flowId: string, result: PlaygroundResult, expected: string) => Promise<string | undefined>;
  /** Removes a saved eval case again — offered right after saving. */
  /** Pins this run's node results as sample data for the expression builder. */
  onPinRun?: (executionId: string) => Promise<void>;
  onDeleteEvalCase?: (id: string) => Promise<void>;
  /** Recorded execution to show as the current run (opened from the Live Graph). */
  attachExecutionId?: string;
  /** The attached execution was replaced by a new run or cleared. */
  onDetach?: () => void;
  /** Execution of the current run, once known (null: no run / cleared). */
  onExecutionChange?: (executionId: string | null) => void;
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
  canvasIsLive = false,
  onValidationFailed,
  onSaveEvalCase,
  onDeleteEvalCase,
  onPinRun,
  attachExecutionId,
  onDetach,
  onExecutionChange,
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
  /** Execution of the current run (state, so the Pin button renders once it is known). */
  const [runExecutionId, setRunExecutionId] = useState<string | null>(null);
  const [pinState, setPinState] = useState<
    { state: "idle" | "pinning" | "pinned" } | { state: "error"; message: string }
  >({ state: "idle" });
  const onExecutionChangeRef = useRef(onExecutionChange);
  onExecutionChangeRef.current = onExecutionChange;
  useEffect(() => {
    onExecutionChangeRef.current?.(runExecutionId);
  }, [runExecutionId]);

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

  // Attached execution (see module doc) and what its events say about it.
  const [attached, setAttached] = useState<string | null>(null);
  const [attachedInfo, setAttachedInfo] = useState<AttachedRunInfo | null>(null);
  const durable = useExecutionEvents(token ? { token } : undefined);
  const loadDurable = durable.load;

  useEffect(() => {
    if (!attachExecutionId || !isAuthenticated) return;
    abortRef.current?.abort();
    setAttached(attachExecutionId);
    setAttachedInfo(null);
    activeExecutionIdRef.current = attachExecutionId;
    awaitingExecutionRef.current = false;
    setRunExecutionId(attachExecutionId);
    setError(null);
    setNotice(null);
    setStreamingContent("");
    setEvalForm({ state: "closed" });
    setPinState({ state: "idle" });
    void loadDurable(attachExecutionId);
  }, [attachExecutionId, isAuthenticated, loadDurable]);

  const detach = useCallback(() => {
    if (attached === null) return;
    setAttached(null);
    setAttachedInfo(null);
    onDetach?.();
  }, [attached, onDetach]);

  // Once the attached run finishes, re-read the durable log: it holds events
  // this tab's stream missed while the run was going.
  const attachedRunning = attached !== null && (attachedInfo?.running ?? true);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (attached !== null && wasRunningRef.current && attachedInfo !== null && !attachedInfo.running) {
      void loadDurable(attached, true);
    }
    wasRunningRef.current = attachedInfo?.running ?? false;
  }, [attached, attachedInfo, loadDurable]);

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
        setRunExecutionId(candidate.id);
        awaitingExecutionRef.current = false;
      }
    }
    const id = activeExecutionIdRef.current;
    if (id === null) return;
    const live = events.filter((e) => e.execution_id === id);
    const scoped =
      attached === id && durable.executionId === id ? mergeExecutionEvents(durable.events, live) : live;
    if (scoped.length > 0) reportStates(deriveNodeStates(scoped));
    if (attached === id) {
      const info = describeRun(scoped);
      setAttachedInfo(info);
      if (info.prompt !== undefined) {
        setPrompt(info.prompt);
        setLastPrompt(info.prompt);
      }
      setStreamingContent(info.answer ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, attached, durable.executionId, durable.events]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!flowId || !prompt.trim()) return;

    detach();
    setIsRunning(true);
    setError(null);
    setNotice(null);
    setEvalForm({ state: "closed" });
    setPinState({ state: "idle" });
    setRunExecutionId(null);
    setStreamingContent("");
    setLastPrompt(prompt);
    reportStates(undefined);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let model = flowId;
      if (target === "canvas" && getDefinition && !(canvasIsLive && liveAvailable)) {
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
  }, [flowId, prompt, token, target, getDefinition, liveAvailable, canvasIsLive, onValidationFailed, reportStates, detach]);

  const handleStop = (): void => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const handleClear = (): void => {
    detach();
    setRunExecutionId(null);
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
  /** A run is in progress: started here, or the attached one still going. */
  const busy = isRunning || attachedRunning;
  const hasOutput = Boolean(error || streamingContent || notice || attached);

  const targetBtn = (t: RunTarget, label: string, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={target === t}
      onClick={() => setTarget(t)}
      disabled={busy || (t === "canvas" && !getDefinition) || (t === "live" && !liveAvailable)}
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
          disabled={busy}
          aria-label="Test prompt"
          className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleRun()}
          disabled={busy || !flowId || !prompt.trim()}
        >
          {busy ? "Running…" : "Run"}
        </Button>
        {isRunning && (
          <Button variant="destructive" size="sm" onClick={handleStop}>
            Stop
          </Button>
        )}
        {hasOutput && !busy && (
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
          {attached && (
            <p className="text-muted-foreground" data-testid="attached-run">
              Request <code className="font-mono">{attached.slice(0, 8)}</code> opened from the Live Graph
              {attachedInfo?.flowId && attachedInfo.flowId !== flowId ? ` (ran as ${attachedInfo.flowId})` : ""}
              {attachedRunning ? " — still running, tracing live…" : "."}
            </p>
          )}
          {error ? (
            <p className="text-red-600" role="alert">
              {error}
            </p>
          ) : (
            streamingContent && (
              <pre className="whitespace-pre-wrap break-words text-foreground">
                {streamingContent}
                {busy && (
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
          {!busy && !error && (streamingContent || attached) && (
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
              {onPinRun && runExecutionId && (
                <button
                  type="button"
                  disabled={pinState.state === "pinning"}
                  onClick={() => {
                    const id = runExecutionId;
                    setPinState({ state: "pinning" });
                    onPinRun(id).then(
                      () => setPinState({ state: "pinned" }),
                      (err: unknown) =>
                        setPinState({ state: "error", message: err instanceof Error ? err.message : String(err) }),
                    );
                  }}
                  className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-card disabled:opacity-50"
                  title="Use this run's node results, query and user context as preview values in the expression builder (ƒx)"
                >
                  {pinState.state === "pinned" ? "📌 Pinned as sample data" : pinState.state === "pinning" ? "Pinning…" : "📌 Pin as sample data"}
                </button>
              )}
              {pinState.state === "error" && (
                <span role="alert" className="text-red-600">Not pinned: {pinState.message}</span>
              )}
              {onSaveEvalCase && evalForm.state === "closed" && streamingContent && (
                <button
                  type="button"
                  onClick={() => setEvalForm({ state: "editing", expected: streamingContent })}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-card"
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
