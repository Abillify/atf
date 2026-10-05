// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Text tool-call detection (`src/graph/text-tool-call.ts`)
 *
 * Pure, dependency-free detection of tool calls that a model wrote as plain
 * text instead of emitting a native (structured) tool call. Local models served
 * through an OpenAI-compatible shim (observed with Qwen on LM Studio, local-model
 * traces 01636a1d / f679dbe6) fall back to their chat-template syntax when the
 * provider parser misses a call — most often in a step where no tools are
 * offered any more. Two template families occur:
 *
 * - Qwen XML:  `<tool_call>\n<function=NAME>\n<parameter=KEY>\nVALUE\n</parameter>…</function>\n</tool_call>`
 * - Hermes:    `<tool_call>{"name": "NAME", "arguments": {…}}</tool_call>`
 *
 * Such text is never an answer for the user. The LLM handler uses this module
 * to keep it out of `content`, reject it and retry without tools. Leaf module
 * (like `repetition-guard.ts`) so it is unit-testable without the handler
 * barrel.
 */

export type TextToolCallFormat = "qwen-xml" | "hermes" | "prefix";

export interface TextToolCallDetection {
  detected: boolean;
  format?: TextToolCallFormat;
}

/** Openers that start a template tool call; a reply beginning with one is never prose. */
const TEXT_TOOL_CALL_OPENERS = ["<tool_call", "<function="] as const;

const HERMES_BLOCK_RE = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
const QWEN_XML_RE =
  /<function=[A-Za-z0-9_.:-]+>\s*(?:<parameter=[^>\n]+>|<\/function>)/;

/**
 * Removes fenced code blocks and inline code spans. An answer that documents
 * the template syntax inside backticks must not be classified as a call.
 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

function isHermesPayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { name?: unknown }).name === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Detects a tool call written as text. Complete template blocks are found even
 * when surrounded by prose; a reply that merely starts with a template opener
 * (including a truncated one) is reported as `prefix`.
 */
export function detectTextToolCall(text: string): TextToolCallDetection {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { detected: false };

  const prose = stripCode(trimmed);
  for (const match of prose.matchAll(HERMES_BLOCK_RE)) {
    if (isHermesPayload(match[1] ?? "")) {
      return { detected: true, format: "hermes" };
    }
  }
  if (QWEN_XML_RE.test(prose)) return { detected: true, format: "qwen-xml" };
  if (TEXT_TOOL_CALL_OPENERS.some((opener) => trimmed.startsWith(opener))) {
    return { detected: true, format: "prefix" };
  }
  return { detected: false };
}

/**
 * True while a streamed buffer could still become a text tool call: its
 * left-trimmed content is a prefix of a template opener or starts with one.
 * Used to keep the preamble lookahead from releasing such text to `content`.
 */
export function looksLikeTextToolCallPrefix(buf: string): boolean {
  const head = buf.trimStart();
  return TEXT_TOOL_CALL_OPENERS.some(
    (opener) => opener.startsWith(head) || head.startsWith(opener),
  );
}
