// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Long-term memory fact extractor (`src/graph/memory-extractor.ts`)
 *
 * Auto-capture used to dump every raw user turn into a single per-user memory
 * bucket. Because that bucket is shared across all of a user's conversations
 * (scope = tenant + user, no conversation dimension) and the `memory`/`recall`
 * node pulls from it on every turn, conversation-specific content (people,
 * cases, one-off details) leaked from one chat into unrelated chats of the same
 * user.
 *
 * This module replaces that with an LLM extraction step: from a completed turn
 * it distills only *durable, user-specific* facts worth remembering across
 * conversations (identity, role/team, stable preferences, persistent context),
 * and explicitly drops ephemeral, conversation-bound material. The caller
 * stores the returned facts (deduplicated) instead of the raw turn.
 *
 * Like the model-based input guardrail, the extractor is bounded by a timeout
 * and fails OPEN by returning an empty list — a model outage must never break
 * the request hot path, and capturing nothing is always the safe default.
 *
 * No `any` at module boundaries.
 */

import { generateObject, jsonSchema } from "ai";
import type { LanguageModel } from "ai";

/** A single completed turn to distill durable user facts from. */
export interface MemoryExtractInput {
  /** The latest user message (plain text). */
  userMessage: string;
  /** The assistant's reply to that message, used only as disambiguating context. */
  assistantMessage?: string;
}

/** Extracts durable, user-specific facts from a turn; never throws. */
export type MemoryExtract = (input: MemoryExtractInput) => Promise<string[]>;

export interface MemoryExtractorOptions {
  /** Abort the model call after this many ms (fail-open). Default 6000. */
  timeoutMs?: number;
  /** Maximum number of facts kept from a single turn. Default 5. */
  maxFacts?: number;
  /** Maximum characters kept per fact. Default 240. */
  maxFactChars?: number;
  /** Optional structured logger for diagnostics. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

const EXTRACTOR_SYSTEM_PROMPT =
  "You maintain a personal long-term memory about ONE user of an assistant. " +
  "Given a single conversation turn, extract only DURABLE facts about THE USER " +
  "that are worth remembering in FUTURE, UNRELATED conversations.\n" +
  "INCLUDE: the user's identity, role, team or employer (when the user states " +
  "it about themselves), stable preferences (preferred language, tone, answer " +
  "format), persistent constraints, and long-lived projects or responsibilities " +
  "the user owns.\n" +
  "EXCLUDE (do NOT store): the assistant's answer or any fact it asserted; the " +
  "user's one-off question or task for this conversation; transient details " +
  "(specific ticket numbers, case IDs, amounts, dates); third parties mentioned " +
  "only in passing (other people, customers, debtors, companies that are the " +
  "subject of the request rather than a stable fact about the user); anything " +
  "you are unsure is durable.\n" +
  "Write each fact as a short, self-contained statement about the user, in the " +
  "SAME LANGUAGE as the user's message. Prefer returning an EMPTY list: most " +
  "turns contain nothing durable. Never invent facts.";

const RESULT_SCHEMA = jsonSchema<{ facts: string[] }>({
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: { type: "string" },
      description:
        "Durable, user-specific facts worth recalling in future conversations. Empty when the turn contains none.",
    },
  },
  required: ["facts"],
  additionalProperties: false,
});

/**
 * Normalises the model's raw `facts` array: keeps non-empty strings, trims and
 * length-caps each, drops case-insensitive duplicates, and bounds the count.
 */
function sanitizeFacts(
  raw: unknown,
  maxFacts: number,
  maxFactChars: number,
): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const fact = item.trim().slice(0, maxFactChars).trim();
    if (fact.length === 0) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
    if (out.length >= maxFacts) break;
  }
  return out;
}

/**
 * Builds a memory fact extractor bound to a specific {@link LanguageModel}.
 * The returned function is safe to call on the request hot path: it is bounded
 * by a timeout and never throws (fails open with an empty list).
 */
export function createMemoryExtractor(
  model: LanguageModel,
  opts: MemoryExtractorOptions = {},
): MemoryExtract {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const maxFacts = opts.maxFacts ?? 5;
  const maxFactChars = opts.maxFactChars ?? 240;
  const logger = opts.logger;

  return async (input: MemoryExtractInput): Promise<string[]> => {
    const userMessage = input.userMessage.trim();
    if (userMessage.length === 0) return [];

    const assistant = input.assistantMessage?.trim();
    const turn =
      assistant !== undefined && assistant.length > 0
        ? `USER:\n${userMessage}\n\nASSISTANT (context only — never store its claims):\n${assistant}`
        : `USER:\n${userMessage}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { object } = await generateObject({
        model,
        schema: RESULT_SCHEMA,
        system: EXTRACTOR_SYSTEM_PROMPT,
        messages: [{ role: "user", content: turn }],
        abortSignal: controller.signal,
        temperature: 0,
      });
      return sanitizeFacts(object.facts, maxFacts, maxFactChars);
    } catch (err) {
      // Fail open — an extractor outage must not break the request.
      logger?.warn("Memory fact extraction failed (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
}
