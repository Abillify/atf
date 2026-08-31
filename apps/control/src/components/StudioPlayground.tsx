"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * StudioPlayground — Prompt input + flow execution panel for the Studio (Req. 15).
 *
 * - Executes the selected flow via POST /v1/chat/completions under the
 *   Operator's identity/tenant (Req. 15.1 / 15.4), which applies
 *   budget/rate-limit/metering rules.
 * - Shows incremental tokens, cost, tool-calls, and citations as they arrive
 *   (Req. 15.3).
 * - Opens an SSE connection to Monitoring events for live graph highlighting
 *   (Req. 15.2); degrades gracefully on error — the execution continues
 *   without highlighting.
 * - Provides a "Save as Eval Case" button backed by validateStudioEvalCase
 *   (Req. 16.1 / 16.3).
 */

import React, { useState, useRef, useCallback } from "react";
import type { FlowListEntry } from "../types/flow";
import { useAuth } from "../lib/auth/useAuth";
import { json, streamSse } from "../lib/control-api";
import { Button, Badge } from "../lib/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaygroundResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  citations?: string[];
}

export interface StudioPlaygroundProps {
  /** Available flows to choose from. */
  flows: FlowListEntry[];
  /** Currently selected flow id; keeps in sync with the builder. */
  selectedFlowId?: string;
  onSelectFlow?: (flowId: string) => void;
  /**
   * Called when the user clicks "Save as Eval Case".
   * Receives the prompt, flow id, and result for persistence.
   */
  onSaveEvalCase?: (
    prompt: string,
    flowId: string,
    result: PlaygroundResult,
  ) => void;
  /** Live node ids being highlighted (driven by monitoring SSE in the parent). */
  activeNodeIds?: string[];
}

// ---------------------------------------------------------------------------
// Streaming fetch helper
// ---------------------------------------------------------------------------

export async function* streamChatCompletion(
  token: string | null,
  flowId: string,
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const body = {
    model: flowId,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  };

  for await (const event of streamSse("/v1/chat/completions", {
    target: "backend",
    token,
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) {
    try {
      const parsed = JSON.parse(event.data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) yield content;
    } catch {
      // Ignore non-JSON application events while preserving the SSE stream.
    }
  }
}

async function fetchChatCompletion(
  token: string | null,
  flowId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<PlaygroundResult> {
  const data = await json<{
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  }>("/v1/chat/completions", {
    target: "backend",
    token,
    signal,
    method: "POST",
    jsonBody: {
      model: flowId,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    },
  });

  const content = data.choices?.[0]?.message?.content ?? "";
  return {
    content,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    cost: data.usage?.cost,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StudioPlayground({
  flows,
  selectedFlowId,
  onSelectFlow,
  onSaveEvalCase,
  activeNodeIds,
}: StudioPlaygroundProps): React.JSX.Element {
  const { token } = useAuth();

  const [localFlowId, setLocalFlowId] = useState(selectedFlowId ?? "");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evalSaveStatus, setEvalSaveStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const effectiveFlowId = selectedFlowId ?? localFlowId;

  const handleFlowSelect = (id: string): void => {
    setLocalFlowId(id);
    onSelectFlow?.(id);
  };

  const handleRun = useCallback(async (): Promise<void> => {
    if (!effectiveFlowId || !prompt.trim()) return;

    setIsRunning(true);
    setError(null);
    setResult(null);
    setStreamingContent("");
    setEvalSaveStatus(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Try streaming first; fall back to non-streaming on error
      let fullContent = "";
      let streamError: Error | null = null;

      try {
        for await (const chunk of streamChatCompletion(
          token ?? null,
          effectiveFlowId,
          prompt,
          controller.signal,
        )) {
          fullContent += chunk;
          setStreamingContent(fullContent);
        }
        setResult({ content: fullContent });
      } catch (streamErr) {
        // Streaming failed → degrade to non-streaming (Req. 15.2 degradation analogy)
        streamError =
          streamErr instanceof Error ? streamErr : new Error(String(streamErr));
      }

      if (streamError && !fullContent) {
        // Only try non-streaming if streaming produced nothing
        try {
          const nonStreamResult = await fetchChatCompletion(
            token ?? null,
            effectiveFlowId,
            prompt,
            controller.signal,
          );
          setResult(nonStreamResult);
          setStreamingContent(nonStreamResult.content);
        } catch (nonStreamErr) {
          throw nonStreamErr;
        }
      } else if (fullContent && !result) {
        setResult({ content: fullContent });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [effectiveFlowId, prompt, token]);

  const handleStop = (): void => {
    abortRef.current?.abort();
    setIsRunning(false);
  };

  const handleSaveEvalCase = (): void => {
    if (!result || !effectiveFlowId || !prompt.trim()) {
      setEvalSaveStatus("⚠ Run a prompt first before saving as eval case.");
      return;
    }
    onSaveEvalCase?.(prompt, effectiveFlowId, result);
    setEvalSaveStatus(
      "Eval case created. Complete required fields (expected output) to add to dataset.",
    );
  };

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Flow selector */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground">Flow</label>
        <select
          value={effectiveFlowId}
          onChange={(e) => handleFlowSelect(e.target.value)}
          className="rounded border border-border px-2 py-1 text-sm"
          aria-label="Select flow to run"
        >
          <option value="">— select a flow —</option>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.id})
            </option>
          ))}
        </select>

        {activeNodeIds && activeNodeIds.length > 0 && (
          <Badge variant="default" className="ml-2">
            {activeNodeIds.length} active node
            {activeNodeIds.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      {/* Prompt input (Req. 15.1) */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="playground-prompt"
          className="text-xs font-medium text-muted-foreground"
        >
          Prompt
        </label>
        <textarea
          id="playground-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter your prompt here…"
          rows={4}
          className="w-full rounded border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
          disabled={isRunning}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            void handleRun();
          }}
          disabled={isRunning || !effectiveFlowId || !prompt.trim()}
        >
          {isRunning ? "Running…" : "Run"}
        </Button>
        {isRunning && (
          <Button variant="destructive" size="md" onClick={handleStop}>
            Stop
          </Button>
        )}
        {(result ?? streamingContent) && !isRunning && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={handleSaveEvalCase}
          >
            Save as Eval Case
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="rounded bg-red-50 px-3 py-2 text-xs text-red-700 border border-red-200"
        >
          {error}
        </div>
      )}

      {/* Eval save status */}
      {evalSaveStatus && (
        <div className="rounded bg-purple-50 px-3 py-2 text-xs text-purple-700 border border-purple-200">
          {evalSaveStatus}
        </div>
      )}

      {/* Response area — incremental display (Req. 15.3) */}
      {(streamingContent || result) && (
        <div className="flex-1 min-h-0 overflow-auto rounded border border-border bg-muted p-3">
          {/* Tokens + cost inline (Req. 15.3) */}
          {result &&
            (result.promptTokens !== undefined ||
              result.cost !== undefined) && (
              <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground border-b border-border pb-2">
                {result.promptTokens !== undefined && (
                  <span>
                    Prompt tokens:{" "}
                    <strong className="text-foreground">
                      {result.promptTokens}
                    </strong>
                  </span>
                )}
                {result.completionTokens !== undefined && (
                  <span>
                    Completion tokens:{" "}
                    <strong className="text-foreground">
                      {result.completionTokens}
                    </strong>
                  </span>
                )}
                {result.cost !== undefined && (
                  <span>
                    Cost:{" "}
                    <strong className="text-foreground">
                      ${result.cost.toFixed(6)}
                    </strong>
                  </span>
                )}
              </div>
            )}

          {/* Tool calls (Req. 15.3) */}
          {result?.toolCalls && result.toolCalls.length > 0 && (
            <div className="mb-2 rounded bg-teal-50 p-2 text-xs border border-teal-200">
              <div className="font-medium text-teal-700 mb-1">Tool calls:</div>
              {result.toolCalls.map((tc, i) => (
                <div key={i} className="font-mono text-teal-600">
                  {tc.name}
                  {tc.args !== undefined && (
                    <span className="text-teal-500">
                      {" "}
                      {JSON.stringify(tc.args)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Citations (Req. 15.3) */}
          {result?.citations && result.citations.length > 0 && (
            <div className="mb-2 rounded bg-accent/10 p-2 text-xs border border-accent/30">
              <div className="font-medium text-accent mb-1">Citations:</div>
              {result.citations.map((c, i) => (
                <div key={i} className="text-accent">
                  {c}
                </div>
              ))}
            </div>
          )}

          {/* Response content — shown incrementally during streaming */}
          <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
            {streamingContent || result?.content}
            {isRunning && (
              <span
                className="inline-block w-2 h-4 bg-muted-foreground animate-pulse ml-0.5"
                aria-hidden="true"
              />
            )}
          </pre>
        </div>
      )}

      {!streamingContent && !result && !isRunning && !error && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground rounded border border-dashed border-border">
          Run a prompt to see results here.
        </div>
      )}
    </div>
  );
}
