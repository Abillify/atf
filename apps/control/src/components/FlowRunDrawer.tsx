"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowRunDrawer — the Studio builder's "Live-Test & Trace im Canvas" bar.
 *
 * A quick-iteration test loop that runs a prompt against the flow being
 * edited and highlights nodes on the SAME canvas as they execute — no need
 * to switch to the separate `/graph` monitor or the full Playground panel to
 * see what a change did.
 *
 * Mechanics:
 *  - Sends the prompt to `POST /v1/chat/completions` (same endpoint the
 *    Playground uses) and streams the assistant reply via the shared
 *    `streamChatCompletion` helper.
 *  - Opens the monitoring SSE stream (`useMonitoringEvents`, same hook the
 *    `/graph` page uses) and — since the backend does not currently echo the
 *    execution_id it assigned back to the caller — locks onto the first
 *    execution whose earliest event starts at or after the moment this run
 *    was submitted. That is safe for the single-operator manual test loop
 *    this drawer serves (one run at a time); the full `/graph` page remains
 *    the tool for inspecting concurrent/production traffic.
 *  - Derives per-node status/latency/cost from those scoped events via the
 *    shared `deriveNodeStates` (graphUtils.ts) — the exact function the
 *    read-only monitor uses — and reports the map up so `StudioBuilder` can
 *    feed it into `FlowCanvas`'s `liveStates` prop.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { Button } from "../lib/ui";
import { useMonitoringEvents } from "../hooks/useMonitoringEvents";
import { deriveNodeStates, type NodeState } from "./graph/graphUtils";
import { streamChatCompletion } from "./StudioPlayground";

export interface FlowRunDrawerProps {
  flowId: string;
  onLiveStatesChange: (states: Map<string, NodeState> | undefined) => void;
}

export function FlowRunDrawer({
  flowId,
  onLiveStatesChange,
}: FlowRunDrawerProps): React.JSX.Element {
  const { token, renewNow } = useAuth();

  const [expanded, setExpanded] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runStartedAtRef = useRef<number>(0);
  const activeExecutionIdRef = useRef<string | null>(null);
  const awaitingExecutionRef = useRef(false);

  const { events } = useMonitoringEvents({
    enabled: !!flowId && !!token,
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
    if (scoped.length > 0) onLiveStatesChange(deriveNodeStates(scoped));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!flowId || !prompt.trim()) return;

    setIsRunning(true);
    setError(null);
    setStreamingContent("");
    runStartedAtRef.current = Date.now();
    activeExecutionIdRef.current = null;
    awaitingExecutionRef.current = true;
    onLiveStatesChange(undefined);

    abortRef.current = new AbortController();
    try {
      let fullContent = "";
      for await (const chunk of streamChatCompletion(
        token ?? null,
        flowId,
        prompt,
      )) {
        fullContent += chunk;
        setStreamingContent(fullContent);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [flowId, prompt, token, onLiveStatesChange]);

  const handleStop = (): void => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const handleClear = (): void => {
    activeExecutionIdRef.current = null;
    awaitingExecutionRef.current = false;
    setStreamingContent("");
    setError(null);
    onLiveStatesChange(undefined);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse run bar" : "Expand run bar"}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="text-xs font-semibold text-muted-foreground">
          ▶ Run &amp; Trace
        </span>
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
        {(streamingContent || error) && !isRunning && (
          <button
            onClick={handleClear}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            title="Clear trace"
          >
            ✕
          </button>
        )}
      </div>

      {expanded && (error || streamingContent) && (
        <div className="max-h-32 overflow-auto rounded border border-border bg-muted p-2 text-xs">
          {error ? (
            <p className="text-red-600" role="alert">
              {error}
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-foreground">
              {streamingContent}
              {isRunning && (
                <span
                  className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
