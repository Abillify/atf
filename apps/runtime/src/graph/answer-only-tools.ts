// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Provider-safe answer-only rounds (`src/graph/answer-only-tools.ts`)
 *
 * The LLM handler runs "answer-only" rounds that must not call tools: the
 * final round past the `maxToolSteps` budget and the continuation retries
 * after `post_tool_answer_missing` / `text_tool_call_rejected`. Their history
 * still holds the native tool calls and results gathered so far. How a round
 * can be both tool-free and valid depends on what each AI SDK provider puts
 * on the wire (verified against the installed provider sources):
 *
 * - `@ai-sdk/openai` (chat + responses; also used for ollama and the
 *   OpenAI-compatible local servers) and `@ai-sdk/azure` send the tool list
 *   even under `toolChoice: "none"`, and local models keep "calling" listed
 *   tools as plain text. The definitions are removed (`activeTools: []`);
 *   these APIs accept tool messages without tool definitions.
 * - `@ai-sdk/google` sends the declarations with `functionCallingConfig`
 *   mode `NONE`, so the tools stay declared and calls are disabled.
 * - `@ai-sdk/anthropic` drops `tools` under `toolChoice: "none"` (the SDK
 *   does not map it), and the Messages API rejects tool_use / tool_result
 *   blocks without tool definitions. `@ai-sdk/amazon-bedrock` likewise drops
 *   the toolConfig (Converse has no "none") and then silently strips every
 *   tool call and result from the prompt, so the answer round would lose
 *   its evidence. For both, the tool exchange is rewritten as plain text and
 *   no tools are sent, so no tool call is possible.
 * - Unknown protocols get the text form too: it is valid on any chat API and
 *   never depends on how an unverified SDK maps tool choice.
 *
 * The rewrite runs on the already sanitized and budgeted step messages, so
 * DLP-effective arguments, blanked older arguments and tool-result caps apply
 * to the text exactly as they did to the structured blocks.
 */

import type { ModelMessage } from "ai";
import type { ProviderProtocol } from "../config/providers.js";

export type AnswerOnlyToolMode = "strip" | "declare-none" | "text";

/** How an answer-only round keeps tools out for the given wire protocol. */
export function answerOnlyToolMode(
  protocol: ProviderProtocol | undefined,
): AnswerOnlyToolMode {
  switch (protocol) {
    case "openai":
    case "ollama":
    case "azure":
      return "strip";
    case "google":
      return "declare-none";
    default:
      return "text";
  }
}

type AssistantPart = Exclude<
  Extract<ModelMessage, { role: "assistant" }>["content"],
  string
>[number];
type ToolPart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolPart, { type: "tool-result" }>;
type UserPart = Exclude<
  Extract<ModelMessage, { role: "user" }>["content"],
  string
>[number];

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const callHeader = (toolName: string, toolCallId: string): string =>
  `[Recorded tool call ${toolName} (id ${toolCallId}), already executed]`;

const resultHeader = (toolName: string, toolCallId: string): string =>
  `[Recorded tool result ${toolName} (id ${toolCallId})]`;

/** Tool result → user content parts (text, plus media that a user turn can carry). */
function resultParts(part: ToolResultPart): UserPart[] {
  const header = resultHeader(part.toolName, part.toolCallId);
  const output = part.output;
  switch (output.type) {
    case "text":
      return [{ type: "text", text: `${header}\n${output.value}` }];
    case "json":
      return [{ type: "text", text: `${header}\n${stringify(output.value)}` }];
    case "error-text":
      return [{ type: "text", text: `${header}\nError: ${output.value}` }];
    case "error-json":
      return [
        { type: "text", text: `${header}\nError: ${stringify(output.value)}` },
      ];
    case "execution-denied":
      return [
        {
          type: "text",
          text:
            `${header}\nExecution denied` +
            (output.reason !== undefined ? `: ${output.reason}` : ""),
        },
      ];
    case "content": {
      const parts: UserPart[] = [{ type: "text", text: header }];
      for (const item of output.value) {
        switch (item.type) {
          case "text":
            parts.push({ type: "text", text: item.text });
            break;
          case "file":
            parts.push({
              type: "file",
              data: item.data,
              mediaType: item.mediaType,
              ...(item.filename !== undefined ? { filename: item.filename } : {}),
            });
            break;
          case "file-data":
          case "image-data":
            parts.push({
              type: "file",
              data: { type: "data", data: item.data },
              mediaType: item.mediaType,
            });
            break;
          case "image-url":
            parts.push({
              type: "file",
              data: { type: "url", url: new URL(item.url) },
              mediaType: "image",
            });
            break;
          case "file-url":
            parts.push({
              type: "file",
              data: { type: "url", url: new URL(item.url) },
              mediaType: item.mediaType ?? "application/octet-stream",
            });
            break;
          default:
            // Provider file references / custom parts have no portable
            // user-turn form; name them instead of dropping them silently.
            parts.push({
              type: "text",
              text: `[tool output part "${item.type}" not representable as text]`,
            });
        }
      }
      return parts;
    }
    default:
      return [{ type: "text", text: `${header}\n${stringify(output)}` }];
  }
}

function assistantPart(part: AssistantPart): AssistantPart {
  switch (part.type) {
    case "tool-call":
      return {
        type: "text",
        text:
          `${callHeader(part.toolName, part.toolCallId)}\n` +
          `Arguments: ${stringify(part.input ?? {})}`,
      };
    case "tool-result": {
      // Provider-executed result inside the assistant turn.
      const text = resultParts(part as ToolResultPart)
        .map((p) => (p.type === "text" ? p.text : `[${p.mediaType} attachment]`))
        .join("\n");
      return { type: "text", text };
    }
    case "tool-approval-request":
      return {
        type: "text",
        text: `[Tool approval requested for call ${part.toolCallId}]`,
      };
    default:
      return part;
  }
}

/**
 * Rewrites every native tool call / tool result into plain text: assistant
 * tool calls become assistant text (tool name, call id, arguments), tool
 * messages become user messages (tool name, call id, full result). Message
 * level `providerOptions` (prompt-cache breakpoints) are kept. Pure; returns
 * the same array when there is nothing to rewrite.
 */
export function toolHistoryAsText(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const out = messages.map((message): ModelMessage => {
    if (message.role === "tool") {
      changed = true;
      const content: UserPart[] = [];
      for (const part of message.content) {
        if (part.type === "tool-result") {
          content.push(...resultParts(part));
        } else {
          content.push({
            type: "text",
            text: `[Tool approval ${part.approved ? "granted" : "denied"} for ${part.approvalId}]`,
          });
        }
      }
      return {
        role: "user",
        content,
        ...(message.providerOptions !== undefined
          ? { providerOptions: message.providerOptions }
          : {}),
      };
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      if (
        !message.content.some(
          (part) =>
            part.type === "tool-call" ||
            part.type === "tool-result" ||
            part.type === "tool-approval-request",
        )
      ) {
        return message;
      }
      changed = true;
      return { ...message, content: message.content.map(assistantPart) };
    }
    return message;
  });
  return changed ? out : messages;
}
