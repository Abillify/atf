// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { LlmConfig } from "../config/schema.ts";
import type { ToolDefinition } from "../tools/types.ts";
import type { MonitorBus } from "../monitor/events.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type RoutingDecision =
  | { kind: "tool"; tool: string; arguments: Record<string, unknown> }
  | { kind: "text"; text: string };

export interface ILlmClient {
  route(
    prompt: string,
    systemPrompt: string,
    tools: ToolDefinition[],
    ctx: AuthContext,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<RoutingDecision>;

  interpret(
    userPrompt: string,
    toolName: string,
    toolResult: string,
    systemPrompt: string,
    ctx: AuthContext,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLlmClient(config: LlmConfig, bus?: MonitorBus): ILlmClient {
  if (config.provider === "bedrock") return new BedrockLlmClient(config, bus);
  return new LlmClient(config, bus);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible client
// ---------------------------------------------------------------------------

interface ChatToolCall {
  function?: { name?: string; arguments?: string };
}
interface ChatMessage {
  content?: string | null;
  tool_calls?: ChatToolCall[];
}
interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatMessage }>;
}

export class LlmClient implements ILlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly bus?: MonitorBus,
  ) {}

  async route(
    prompt: string,
    systemPrompt: string,
    tools: ToolDefinition[],
    ctx: AuthContext,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<RoutingDecision> {
    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      stream: false,
      ...(this.config.maxTokens ? { max_tokens: this.config.maxTokens } : {}),
      messages: [
        { role: "system", content: systemPrompt || DEFAULT_SYSTEM },
        { role: "user", content: prompt },
      ],
      // Omit `tools`/`tool_choice` entirely when there's nothing to route to —
      // OpenAI's API (and several compatible servers) reject `tools: []` with
      // "Invalid 'tools': empty array" rather than just ignoring it. This can
      // happen for the `ask` router when no read-access tools are configured.
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: normalizeParameters(t.inputSchema),
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    };

    this.bus?.publish({
      type: "llm_request",
      sessionId,
      username: ctx.username,
      status: "ok",
      message: "routing request",
      meta: {
        phase: "route",
        prompt,
        systemPrompt: systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? "..." : ""),
        model: this.config.model,
        toolCount: tools.length,
      },
    });

    const message = await this.call(body, ctx, signal);

    const call = message.tool_calls?.[0]?.function;
    if (call?.name) {
      const decision = {
        kind: "tool" as const,
        tool: call.name,
        arguments: safeJson(call.arguments),
      };
      this.bus?.publish({
        type: "llm_response",
        sessionId,
        username: ctx.username,
        tool: call.name,
        status: "ok",
        message: "tool selected",
        meta: { phase: "route", decision },
      });
      return decision;
    }

    const fromContent = parseToolFromText(message.content ?? "");
    if (fromContent) {
      this.bus?.publish({
        type: "llm_response",
        sessionId,
        username: ctx.username,
        tool: fromContent.kind === "tool" ? fromContent.tool : undefined,
        status: "ok",
        message: "tool selected (from text)",
        meta: { phase: "route", decision: fromContent },
      });
      return fromContent;
    }

    const textResponse = { kind: "text" as const, text: (message.content ?? "").trim() };
    this.bus?.publish({
      type: "llm_response",
      sessionId,
      username: ctx.username,
      status: "ok",
      message: "no tool selected",
      meta: { phase: "route", decision: textResponse },
    });
    return textResponse;
  }

  async interpret(
    userPrompt: string,
    toolName: string,
    toolResult: string,
    systemPrompt: string,
    ctx: AuthContext,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      stream: false,
      ...(this.config.maxTokens ? { max_tokens: this.config.maxTokens } : {}),
      messages: [
        { role: "system", content: systemPrompt || DEFAULT_SYSTEM },
        { role: "user", content: userPrompt },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: toolName, arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: toolResult },
      ],
    };

    this.bus?.publish({
      type: "llm_request",
      sessionId,
      username: ctx.username,
      tool: toolName,
      status: "ok",
      message: "interpretation request",
      meta: {
        phase: "interpret",
        toolName,
        toolResult: toolResult.slice(0, 500) + (toolResult.length > 500 ? "..." : ""),
        model: this.config.model,
      },
    });

    const message = await this.call(body, ctx, signal);
    const interpretation = (message.content ?? "").trim() || "No response from model.";

    this.bus?.publish({
      type: "llm_response",
      sessionId,
      username: ctx.username,
      tool: toolName,
      status: "ok",
      message: "interpretation complete",
      meta: {
        phase: "interpret",
        interpretation: interpretation.slice(0, 500) + (interpretation.length > 500 ? "..." : ""),
      },
    });

    return interpretation;
  }

  private async call(body: unknown, ctx: AuthContext, signal?: AbortSignal): Promise<ChatMessage> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const token = this.config.forwardBearerToken ? ctx.rawToken : this.config.apiKey;
    try {
      const res = await fetch(`${this.config.baseUrl?.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as ChatCompletionResponse;
      return json.choices?.[0]?.message ?? {};
    } catch (err) {
      logger.debug("llm call error", { error: (err as Error).message });
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// AWS Bedrock Converse client
// ---------------------------------------------------------------------------

export class BedrockLlmClient implements ILlmClient {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly config: LlmConfig,
    private readonly bus?: MonitorBus,
  ) {
    this.client = new BedrockRuntimeClient({
      region: config.region,
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
            },
          }
        : {}),
    });
  }

  async route(
    prompt: string,
    systemPrompt: string,
    tools: ToolDefinition[],
    ctx: AuthContext,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<RoutingDecision> {
    const command = new ConverseCommand({
      modelId: this.config.model,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
      // Omit toolConfig entirely when there's nothing to route to — Bedrock's
      // Converse API rejects an empty toolConfig.tools list with a
      // ValidationException rather than just ignoring it.
      ...(tools.length > 0
        ? {
            toolConfig: {
              tools: tools.map((t) => ({
                toolSpec: {
                  name: t.name,
                  description: t.description ?? "",
                  inputSchema: { json: normalizeParameters(t.inputSchema) as never },
                },
              })),
              toolChoice: { auto: {} },
            },
          }
        : {}),
      inferenceConfig: {
        temperature: this.config.temperature,
        ...(this.config.maxTokens ? { maxTokens: this.config.maxTokens } : {}),
      },
    });

    this.bus?.publish({
      type: "llm_request",
      sessionId,
      username: ctx.username,
      status: "ok",
      message: "routing request (bedrock)",
      meta: {
        phase: "route",
        prompt,
        systemPrompt: systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? "..." : ""),
        model: this.config.model,
        toolCount: tools.length,
      },
    });

    const response = await Promise.race([
      this.client.send(command, { abortSignal: signal }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Bedrock Converse timed out after ${this.config.timeoutMs}ms`)),
          this.config.timeoutMs,
        ),
      ),
    ]);

    const content: ContentBlock[] = response.output?.message?.content ?? [];

    for (const block of content) {
      if ("toolUse" in block && block.toolUse?.name) {
        const decision = {
          kind: "tool" as const,
          tool: block.toolUse.name,
          arguments: (block.toolUse.input as Record<string, unknown>) ?? {},
        };
        this.bus?.publish({
          type: "llm_response",
          sessionId,
          username: ctx.username,
          tool: block.toolUse.name,
          status: "ok",
          message: "tool selected",
          meta: { phase: "route", decision },
        });
        return decision;
      }
    }

    const text = content.find((b): b is ContentBlock & { text: string } => "text" in b)?.text ?? "";
    const fromText = parseToolFromText(text);
    if (fromText) {
      this.bus?.publish({
        type: "llm_response",
        sessionId,
        username: ctx.username,
        tool: fromText.kind === "tool" ? fromText.tool : undefined,
        status: "ok",
        message: "tool selected (from text)",
        meta: { phase: "route", decision: fromText },
      });
      return fromText;
    }

    const textResponse = { kind: "text" as const, text: text.trim() };
    this.bus?.publish({
      type: "llm_response",
      sessionId,
      username: ctx.username,
      status: "ok",
      message: "no tool selected",
      meta: { phase: "route", decision: textResponse },
    });
    return textResponse;
  }

  async interpret(
    userPrompt: string,
    toolName: string,
    toolResult: string,
    systemPrompt: string,
    ctx: AuthContext,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const command = new ConverseCommand({
      modelId: this.config.model,
      messages: [
        { role: "user", content: [{ text: userPrompt }] },
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "call_1", name: toolName, input: {} } }],
        },
        {
          role: "user",
          content: [{ toolResult: { toolUseId: "call_1", content: [{ text: toolResult }] } }],
        },
      ],
      ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
      inferenceConfig: {
        temperature: this.config.temperature,
        ...(this.config.maxTokens ? { maxTokens: this.config.maxTokens } : {}),
      },
    });

    this.bus?.publish({
      type: "llm_request",
      sessionId,
      username: ctx.username,
      tool: toolName,
      status: "ok",
      message: "interpretation request (bedrock)",
      meta: {
        phase: "interpret",
        toolName,
        toolResult: toolResult.slice(0, 500) + (toolResult.length > 500 ? "..." : ""),
        model: this.config.model,
      },
    });

    const response = await Promise.race([
      this.client.send(command, { abortSignal: signal }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Bedrock Converse timed out after ${this.config.timeoutMs}ms`)),
          this.config.timeoutMs,
        ),
      ),
    ]);

    const content: ContentBlock[] = response.output?.message?.content ?? [];
    const text = content.find((b): b is ContentBlock & { text: string } => "text" in b)?.text ?? "";
    const interpretation = text.trim() || "No response from model.";

    this.bus?.publish({
      type: "llm_response",
      sessionId,
      username: ctx.username,
      tool: toolName,
      status: "ok",
      message: "interpretation complete",
      meta: {
        phase: "interpret",
        interpretation: interpretation.slice(0, 500) + (interpretation.length > 500 ? "..." : ""),
      },
    });

    return interpretation;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM =
  "You are a tool router. Choose the single most appropriate tool for the user's request and fill its arguments. If no tool fits, answer briefly in plain text.";

function normalizeParameters(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && schema.type) return schema;
  return { type: "object", properties: {}, ...schema };
}

function safeJson(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseToolFromText(text: string): RoutingDecision | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const obj = JSON.parse(match[0]) as { tool?: string; arguments?: unknown };
    if (typeof obj.tool === "string") {
      return {
        kind: "tool",
        tool: obj.tool,
        arguments:
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : {},
      };
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}
