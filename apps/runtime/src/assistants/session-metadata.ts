// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Automatic session naming and tagging (`src/assistants/session-metadata.ts`).
 *
 * A conversational session list is only usable when each row says what it is
 * about. Rather than making every client name its own conversations, the first
 * completed turn of an untitled session triggers a short side-model call that
 * produces a title and a few tags. The result is stored on the session row
 * (authoritative) and projected into the Vectorsearch session index so content
 * search also matches the generated title.
 *
 * ## Why best-effort and idempotent
 *
 * Naming happens after the answer was delivered. A model failure, a timeout, or
 * a concurrent second turn must never affect the conversation: every error is
 * swallowed by the caller-visible `safe` wrapper, and the generation only fires
 * while the session still has no title, so repeated turns cannot overwrite a
 * name (user renames via PATCH win permanently, as they clear the same field).
 */
import { generateObject, jsonSchema, type LanguageModel } from "ai";
import type { AssistantSessionStore, AssistantSessionStatus } from "./session-store.js";
import type { AssistantScope } from "./types.js";

const TITLE_MAX_CHARS = 120;
const TAG_MAX = 6;

const metadataSchema = jsonSchema<{ title: string; tags: string[] }>({
  type: "object",
  properties: {
    title: { type: "string", description: "Concise session title in the language of the conversation, max 8 words." },
    tags: {
      type: "array",
      items: { type: "string" },
      maxItems: TAG_MAX,
      description: "Short topical tags (subsystems, entities, actions), lowercase, no punctuation.",
    },
  },
  required: ["title", "tags"],
  additionalProperties: false,
});

/** Normalise model output into storable values; returns undefined when unusable. */
export function normalizeSessionMetadata(raw: { title?: unknown; tags?: unknown }):
  { title: string; tags: string[] } | undefined {
  const title = typeof raw.title === "string" ? raw.title.trim().replace(/\s+/g, " ") : "";
  if (title.length === 0) return undefined;
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9äöüß._:-]/g, ""))
        .filter((tag) => tag.length > 0 && tag.length <= 64)
        .slice(0, TAG_MAX)
    : [];
  return { title: title.slice(0, TITLE_MAX_CHARS), tags };
}

export interface SessionMetadataGenerator {
  /**
   * Generate and persist title/tags for an untitled session. Returns whether
   * metadata was written. Never throws for model or storage failures that would
   * only affect naming — programming errors still surface via the caller's
   * catch, which is why this is designed to be invoked fire-and-forget.
   */
  maybeGenerate(params: {
    scope: AssistantScope;
    conversationId: string;
    query: string;
    answer: string;
    token?: string;
  }): Promise<boolean>;
}

export function createSessionMetadataGenerator(deps: {
  sessionStore: AssistantSessionStore;
  model: LanguageModel;
  /** Optional Vectorsearch projection for the generated title. */
  indexDocument?: (params: {
    scope: AssistantScope;
    conversationId: string;
    documentId: string;
    content: string;
    kind: "event" | "snapshot";
    sequence: number;
    token: string;
  }) => Promise<void>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** Cap for each side of the prompt; naming needs only the conversation gist. */
  maxChars?: number;
}): SessionMetadataGenerator {
  const maxChars = deps.maxChars ?? 4_000;
  return {
    async maybeGenerate(params) {
      try {
        const existing = await deps.sessionStore.getSession(params.scope, params.conversationId);
        // A title (auto or user-set) means the work is done; never overwrite.
        if (existing === undefined || existing.title !== undefined) return false;
        const { object } = await generateObject({
          model: deps.model,
          schema: metadataSchema,
          system:
            "You name chat sessions for an ERP assistant. Reply with a title (max 8 words, " +
            "language of the conversation) and up to 6 short topical tags. " +
            "Tags: lowercase, no punctuation, e.g. 'vertraege', 'mahnwesen', 'case', 'fehleranalyse'.",
          prompt:
            `User: ${params.query.slice(0, maxChars)}\n\n` +
            `Assistant: ${params.answer.slice(0, maxChars)}`,
          maxOutputTokens: 200,
        });
        const meta = normalizeSessionMetadata(object ?? {});
        if (meta === undefined) return false;
        const updated = await deps.sessionStore.updateSession({
          scope: params.scope,
          conversationId: params.conversationId,
          title: meta.title,
          tags: meta.tags,
        });
        if (updated === undefined) return false;
        if (deps.indexDocument !== undefined && params.token !== undefined && params.token !== "") {
          try {
            await deps.indexDocument({
              scope: params.scope,
              conversationId: params.conversationId,
              documentId: `title:${params.conversationId}`,
              content: `${meta.title}\n${meta.tags.join(" ")}`,
              kind: "snapshot",
              sequence: updated.lastSequence,
              token: params.token,
            });
          } catch (error) {
            deps.logger?.warn("Session title projection failed", {
              conversationId: params.conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return true;
      } catch (error) {
        deps.logger?.warn("Session metadata generation failed", {
          conversationId: params.conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}

/**
 * Fire-and-forget helper used by flow nodes: marks the session's conversational
 * status without ever failing the turn.
 */
export async function safeSetSessionStatus(
  store: AssistantSessionStore | undefined,
  params: {
    scope: AssistantScope;
    conversationId: string;
    status: AssistantSessionStatus;
    error?: string;
  },
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (store === undefined) return;
  try {
    await store.setSessionStatus(params);
  } catch (error) {
    logger?.warn("Assistant session status update failed", {
      conversationId: params.conversationId,
      status: params.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
