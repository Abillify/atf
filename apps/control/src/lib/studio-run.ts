// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Studio test runs (`src/lib/studio-run.ts`): chat-completion helpers used by
 * the builder's Run & Trace panel, plus registering the CANVAS definition as a
 * throwaway test flow so a run exercises unsaved edits rather than whatever
 * version is live (`POST /flows/:id/test-run` in the runtime).
 */

import { json, streamSse } from "./control-api";
import { backendUrl } from "./backend-url";
import type { FlowDefinition, FlowValidationReport } from "../types/flow";

export interface PlaygroundResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  citations?: string[];
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

export async function fetchChatCompletion(
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
// Canvas test registration
// ---------------------------------------------------------------------------

export type TestRunRegistration =
  | { ok: true; model: string }
  | { ok: false; unsupported: true }
  | { ok: false; unsupported?: false; error: string; validation?: FlowValidationReport };

/**
 * Registers `definition` for a test run. `unsupported` means the runtime is
 * older than the endpoint (404/501) — the caller can fall back to the live flow.
 */
export async function registerTestRun(
  token: string | null,
  definition: FlowDefinition,
): Promise<TestRunRegistration> {
  let resp: Response;
  try {
    resp = await fetch(
      backendUrl(`/flows/${encodeURIComponent(definition.id)}/test-run`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(definition),
      },
    );
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (resp.status === 404 || resp.status === 501) {
    return { ok: false, unsupported: true };
  }
  const data = (await resp.json().catch(() => ({}))) as {
    model?: string;
    error?: { message?: string };
    validation?: FlowValidationReport;
  };
  if (!resp.ok || typeof data.model !== "string") {
    return {
      ok: false,
      error: data.error?.message ?? `HTTP ${resp.status}`,
      ...(data.validation ? { validation: data.validation } : {}),
    };
  }
  return { ok: true, model: data.model };
}
