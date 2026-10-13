// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — planner message context slimming.

 * Pure helpers that prepare the message list for planner LLM calls: tool
 * noise removal and the compact folder digest replacing the full
 * collection overview. Extracted verbatim from loop.ts (Req 13.6).
 *
 * @module agent-harness/loop-planner-context
 */

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { isRagContextMessage } from "../exec-runtime.js";

// ---------------------------------------------------------------------------
// Message filtering for planner
// ---------------------------------------------------------------------------

/**
 * Filters messages to remove tool-related content that would cause
 * tool call/result mismatch errors when sent to the planner LLM.
 *
 * The planner only needs to see:
 * - User messages (the original request and any follow-ups)
 * - System messages (context and instructions)
 * - Assistant messages with text content (final answers from delegated nodes)
 *
 * Tool execution details (assistant messages with tool_calls and tool
 * messages with results) are filtered out because:
 * 1. They're not relevant to the planning task
 * 2. They can cause validation errors if tool calls and results don't match
 *    perfectly (e.g., when delegated nodes use tools that the planner doesn't
 *    have access to)
 *
 * For assistant messages that have both text content AND tool calls, we:
 * - Create a new message with ONLY the text content (no tool calls)
 * - This preserves the assistant's textual response while avoiding tool call/result mismatches
 *
 * @param messages - The full message history from state.messages
 * @returns Filtered messages safe to send to the planner LLM
 */
export function filterMessagesForPlanner(messages: BaseMessage[]): BaseMessage[] {
  const result: BaseMessage[] = [];

  for (const msg of messages) {
    const type =
      (msg as { _getType?: () => string })._getType?.() ??
      (msg as { getType?: () => string }).getType?.();

    // Remove tool result messages entirely
    if (type === "tool") continue;

    // Handle assistant messages
    if (type === "ai") {
      const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
      const content = (msg as { content?: unknown }).content;

      // If the message has tool calls but also has text content, preserve the text
      if (toolCalls && toolCalls.length > 0) {
        const textContent = typeof content === "string" ? content.trim() : "";
        if (textContent.length > 0) {
          // Create a new AIMessage with only the text content, no tool calls
          result.push(new AIMessage(textContent));
        }
        // If no text content, skip this message entirely (it's purely a tool call)
        continue;
      }

      // No tool calls - keep the message as is
      result.push(msg);
      continue;
    }

    // Keep user and system messages
    result.push(msg);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Planner context slimming — folder digest instead of the full doc overview
// ---------------------------------------------------------------------------

/** Max folders listed in the planner's folder digest (keeps it bounded). */
const PLANNER_DIGEST_MAX_FOLDERS = 60;

/** Returns the folder (dirname) of a document reference path. */
function folderOf(ref: string): string {
  const trimmed = ref.trim();
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return trimmed.length > 0 ? trimmed : "(root)";
  return trimmed.slice(0, idx);
}

/**
 * Derives a COMPACT folder-level structure digest from an injected
 * COLLECTION OVERVIEW system message. The planner only needs the collection's
 * shape ("one step per folder") — not all N document titles, which can be tens
 * of thousands of characters. This parses each overview line's `(Ref: /path/…)`,
 * folds it to its folder, and emits `folder → count` entries.
 *
 * Returns "" when the content has no parseable overview lines (caller then
 * drops the message rather than injecting an empty digest). Exported for tests.
 */
export function folderDigestFromOverview(content: string): string {
  const refRe = /\(Ref:\s*([^)]+)\)/;
  const counts = new Map<string, number>();
  let docsSeen = 0;
  for (const line of content.split("\n")) {
    const m = line.match(refRe);
    if (m === null) continue;
    docsSeen++;
    const folder = folderOf(m[1] ?? "");
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  if (counts.size === 0) return "";

  // Prefer the store's true total from the header ("… of TOTAL N documents") so
  // the planner sees the real size even when the overview was char-capped; fall
  // back to the number of parsed lines.
  //
  // The `INSGESAMT` alternative is the pre-translation wording. A checkpointed
  // conversation can still carry a German overview, and losing the total there
  // would silently understate the collection size to the planner rather than
  // fail visibly. See LEGACY_RAG_MARKERS in exec-runtime.ts.
  const totalMatch = content.match(
    /(?:TOTAL|INSGESAMT)\s+(\d+)\s+(?:documents?|dokument)/i,
  );
  const total =
    totalMatch !== null && Number.isFinite(Number(totalMatch[1]))
      ? Number(totalMatch[1])
      : docsSeen;

  const folders = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const shown = folders.slice(0, PLANNER_DIGEST_MAX_FOLDERS);
  const lines = shown.map(([f, n]) => `- ${f}: ${n} doc(s)`);
  const moreNote =
    folders.length > shown.length
      ? `\n- … and ${folders.length - shown.length} more folders`
      : "";
  const capNote =
    docsSeen < total
      ? ` (folder structure derived from the first ${docsSeen} of ${total} documents)`
      : "";

  return (
    `COLLECTION STRUCTURE (folder overview for PLANNING — derived from the ` +
    `collection overview, NOT the complete document list). ${total} documents ` +
    `in total across ${counts.size} folders${capNote}. Typically plan ONE ` +
    `research step per folder or per sub-aspect of the question; the ` +
    `researcher sees the complete document list itself and picks the ` +
    `individual documents.\n${lines.join("\n")}${moreNote}`
  );
}

/**
 * Rewrites the message list for a planner call so the planner never carries the
 * full (up to ~40k-char) AKTEN-UEBERBLICK:
 *   - initial plan (`replan === false`): each RAG-context system message is
 *     REPLACED by its compact {@link folderDigestFromOverview}. (#4a)
 *   - re-plan (`replan === true`): RAG-context messages are DROPPED entirely —
 *     the planner decides "continue or stop?" from `priorProgress` + the
 *     condensed findings alone, so the map is redundant. (#1)
 * Non-RAG messages pass through untouched. Pure; does not mutate the argument.
 */
export function transformRagForPlanner(
  messages: BaseMessage[],
  replan: boolean,
): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    const text = typeof content === "string" ? content : "";
    if (text.length > 0 && isRagContextMessage(text)) {
      if (replan) continue; // #1: drop the map on re-plan
      const digest = folderDigestFromOverview(text); // #4a: folder digest
      if (digest.length > 0) out.push(new SystemMessage({ content: digest }));
      continue;
    }
    out.push(msg);
  }
  return out;
}
