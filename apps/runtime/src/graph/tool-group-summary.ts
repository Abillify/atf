// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-group summariser (`src/graph/tool-group-summary.ts`)
 *
 * Produces a short, LLM-generated summary of each MCP server's capabilities
 * from its (often long, detail-heavy) server-level `instructions` — used in the
 * `select_tools` meta-tool description to advertise capability GROUPS the model
 * has NOT already been shown, without dumping the full instructions (which can
 * contain large discovery lists like every parking space or employee).
 *
 * Summaries are generated only on connect/reconnect (via {@link update}, which
 * dedupes by a content hash so an unchanged instruction set never re-summarises)
 * and cached for the process lifetime. Generation is fire-and-forget: the first
 * requests after startup fall back to the cheaper description-based summary
 * until the LLM summary is ready, then it is used.
 *
 * The FULL instructions (not the summary) are what a model receives once a
 * tool's group is actually selected (RAG top-K) or loaded via `select_tools`;
 * this summary is purely the lightweight "here's what else exists" hint.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { Logger } from "../observability/logger.js";

export interface ToolGroupSummarizer {
  /** Cached LLM summary for a server, or undefined when not (yet) available. */
  getSummary(server: string): string | undefined;
  /**
   * (Re)generates the summary for a server from its full instructions. Deduped
   * by content hash; fire-and-forget. Pass undefined/empty to drop the cache.
   */
  update(server: string, instructions: string | undefined): void;
}

const SUMMARY_SYSTEM_PROMPT =
  "You summarise an MCP tool server's capabilities for a tool-selection index. " +
  "In ONE or TWO short sentences, describe what kinds of actions and queries " +
  "these tools enable. Omit all detailed data (specific names, ids, parking " +
  "spaces, employees, projects), per-parameter details and step-by-step usage " +
  "rules — capture only the gist of the capabilities so a model can decide " +
  "whether to request this group. Plain text, no preamble, no markdown.";

/** Minimal subset of the AI SDK `generateText` used here (injectable for tests). */
export type GenerateTextFn = (args: {
  model: LanguageModel;
  system: string;
  prompt: string;
}) => Promise<{ text: string }>;

class LlmToolGroupSummarizer implements ToolGroupSummarizer {
  /** server → { hash of the instructions, summary (undefined while in flight) }. */
  private readonly cache = new Map<
    string,
    { hash: string; summary?: string }
  >();

  constructor(
    private readonly model: LanguageModel,
    private readonly logger?: Logger,
    private readonly generate: GenerateTextFn = generateText as unknown as GenerateTextFn,
  ) {}

  getSummary(server: string): string | undefined {
    return this.cache.get(server)?.summary;
  }

  update(server: string, instructions: string | undefined): void {
    if (instructions === undefined || instructions.trim() === "") {
      this.cache.delete(server);
      return;
    }
    const hash = crypto.createHash("sha256").update(instructions).digest("hex");
    const existing = this.cache.get(server);
    // Already summarised (or in flight) for this exact content — nothing to do.
    if (existing?.hash === hash) return;
    // Mark in-flight under the new hash (summary stays from the old entry until
    // the new one lands, so a stale-but-useful summary is not dropped early).
    this.cache.set(server, {
      hash,
      ...(existing?.summary !== undefined ? { summary: existing.summary } : {}),
    });
    void this.run(server, instructions, hash);
  }

  private async run(
    server: string,
    instructions: string,
    hash: string,
  ): Promise<void> {
    try {
      const { text } = await this.generate({
        model: this.model,
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: instructions,
      });
      const summary = text.trim();
      // Only store if this is still the current content hash (a newer update
      // may have superseded us while the LLM call was in flight).
      if (this.cache.get(server)?.hash === hash && summary !== "") {
        this.cache.set(server, { hash, summary });
      }
      this.logger?.debug?.("Tool group summary generated", { server });
    } catch (err) {
      // Drop the in-flight marker so the next reconnect retries; callers fall
      // back to the description-based summary meanwhile.
      if (
        this.cache.get(server)?.hash === hash &&
        this.cache.get(server)?.summary === undefined
      ) {
        this.cache.delete(server);
      }
      this.logger?.warn("Tool group summary generation failed", {
        server,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Builds an LLM-backed {@link ToolGroupSummarizer}. */
export function createToolGroupSummarizer(
  model: LanguageModel,
  logger?: Logger,
  generate?: GenerateTextFn,
): ToolGroupSummarizer {
  return new LlmToolGroupSummarizer(model, logger, generate);
}
