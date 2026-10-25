// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * summary/generator.ts
 *
 * The summary-hierarchy generator.
 *
 * ## What it produces, and when
 *
 * The streaming document pass emits a *section-closed* event as soon as a
 * section ends (the next heading at the same or a higher level pops it). This
 * generator turns each such event into an **abschnitts-summary** over the
 * text-LLM, immediately — the design forms section summaries "as soon as a
 * section ends". At document end it produces the remaining open sections'
 * summaries, then the **chapter** summaries (the level-1/2 headings' subtrees)
 * and finally the **document** summary. That is roughly `sections + chapters +
 * 1` calls, one-off and offline.
 *
 * RAPTOR-light: each level summarises the level below it, not the raw text. A
 * section summarises its page summaries + block text (bounded by the
 * accumulator); a chapter summarises its sections' summaries; the document
 * summarises the chapters'. Tokens stay bounded on a 10 000-page document.
 *
 * ## Each summary is a checkpointed stage
 *
 * Every summary — section, chapter, document — runs through the {@link
 * StageRunner} as its own checkpoint, keyed by a distinct `stage` string on the
 * `page` unit (no new table, no migration): a section summary at
 * `summary:section:<sectionId>` on the section's start page, chapter summaries
 * at `summary:chapter:<sectionId>` and the document summary at
 * `summary:document`, both on the last page. A resume reuses a completed
 * checkpoint with the SAME input hash and never re-calls the text-LLM
 * the produced {@link SummaryNode} is re-added to the pass
 * from the checkpoint so it still lands on `document.end.summaries`.
 *
 * ## Optional and outage-tolerant
 *
 * The generator only exists when `SUMMARY_URL` is configured (the runner passes
 * `null` otherwise and the whole pass is skipped — `document.end.summaries`
 * stays empty, the job still completes). When the text-LLM is unreachable the
 * client's retries are exhausted into a {@link TransientSummaryFailure}, which
 * this generator maps to a {@link TransientStageError}: the stage runner records
 * a retryable checkpoint and rethrows, and the caller pauses the job on
 * dependency (like the emitter) rather than losing the pages already produced.
 * A summary is never allowed to fail the whole document.
 */

import type { Logger } from "pino";
import { sha256Hex } from "@atf/extract-contract";
import type { OutlineNode, SummaryNode } from "@atf/extract-contract/v2";
import type { StageKey } from "../persistence/extract-queries.js";
import {
  TransientStageError,
  type BudgetLedger,
  type StageRunner,
} from "../jobs/stage-runner.js";
import type { ClosedOutlineNode } from "../jobs/docpass/outline.js";
import type { DocumentPass } from "../jobs/docpass/document-pass.js";
import { TransientSummaryFailure, type SummaryClient } from "./client.js";
import { SUMMARY_PROMPT_VERSION, type SummaryScope } from "./prompts.js";

/** The generator's collaborators. */
export interface SummaryGeneratorDeps {
  client: SummaryClient;
  stageRunner: StageRunner;
  logger: Logger;
  /** The job id and source sha, for stage keys and input hashing. */
  jobId: string;
  sourceSha256: string;
  /** The model id, folded into the input hash so a model change recomputes. */
  model: string;
  /** The budget ledger; a summary call is gated like a vision call. */
  budget: BudgetLedger;
  /** Rough per-summary token estimate for the pre-call budget guard. */
  tokenEstimate: number;
}

/** The generator's surface, driven by the ordered document pass. */
export interface SummaryGenerator {
  /**
   * Produce section summaries for the sections that closed on a page. Each is a
   * checkpointed stage; a resume reuses it without a model call. The produced
   * node is added to the pass so it lands on `document.end`.
   */
  onSectionsClosed(closed: readonly ClosedOutlineNode[], pass: DocumentPass): Promise<void>;
  /**
   * At document end: summarise the still-open sections, then the chapters
   * (level-1/2 subtrees), then the whole document. Called once after the last
   * page is folded.
   */
  finalize(pass: DocumentPass, outline: readonly OutlineNode[], lastPage: number): Promise<void>;
}

/** Create a summary generator. Only wired when `SUMMARY_URL` is configured. */
export function createSummaryGenerator(deps: SummaryGeneratorDeps): SummaryGenerator {
  const { client, stageRunner, logger, jobId, sourceSha256, model, budget, tokenEstimate } = deps;

  /** The stage key for a summary of a given scope+id. */
  function stageKey(scope: SummaryScope, id: string, page: number): StageKey {
    return { job_id: jobId, page, stage: `summary:${scope}:${id}` };
  }

  /**
   * The input hash for a summary stage: the scope, id, prompt version, model and
   * a hash of the content. A change to the content, the prompt or the model
   * recomputes; an unchanged resume reuses the checkpoint (no model call).
   */
  function inputHash(scope: SummaryScope, id: string, content: string): string {
    return sha256Hex(
      ["summary", sourceSha256, scope, id, SUMMARY_PROMPT_VERSION, model, sha256Hex(content)].join("\n"),
    );
  }

  /**
   * Run one summary through a checkpointed stage. Returns the produced node (or
   * null when the content was empty — nothing to summarise). Maps a text-LLM
   * outage to a TransientStageError so the caller pauses on dependency.
   */
  async function runSummaryStage(args: {
    scope: SummaryScope;
    id: string;
    page: number;
    title?: string | undefined;
    content: string;
    pageStart?: number | undefined;
    pageEnd?: number | undefined;
    pass: DocumentPass;
  }): Promise<void> {
    const { scope, id, page, title, content, pageStart, pageEnd, pass } = args;

    // Already produced (in-memory or a prior run rehydrated it): skip.
    if (pass.hasSummary(scope, id)) return;
    if (content.trim() === "") return; // nothing to summarise

    const result = await stageRunner.runStage<SummaryNode | undefined, string>({
      unit: "page",
      key: stageKey(scope, id, page),
      inputHash: inputHash(scope, id, content),
      budget: { ledger: budget, estimatedTokens: tokenEstimate },
      fn: async () => {
        let summary: string;
        let tokensUsed = 0;
        try {
          const res = await client.summarize({ scope, title, content });
          summary = res.text;
          tokensUsed = res.usage.totalTokens;
        } catch (err) {
          if (err instanceof TransientSummaryFailure) {
            // A text-LLM outage: pause on dependency rather than fail the doc.
            throw new TransientStageError(err.message, err);
          }
          throw err;
        }
        const node: SummaryNode = {
          scope,
          id,
          summary,
          ...(pageStart !== undefined ? { pageStart } : {}),
          ...(pageEnd !== undefined ? { pageEnd } : {}),
        };
        return { raw: summary, parsed: node, tokensUsed };
      },
    });

    // Either freshly produced or reused from a checkpoint (no model call). In
    // both cases add the node to the pass so it lands on document.end.summaries
    // and the resume guard (hasSummary) sees it.
    if (result.parsed !== undefined) {
      pass.addSummary(result.parsed);
      if (scope === "section") pass.releaseSection(id);
    }
  }

  async function onSectionsClosed(
    closed: readonly ClosedOutlineNode[],
    pass: DocumentPass,
  ): Promise<void> {
    for (const section of closed) {
      const pageEnd = section.pageEnd ?? section.pageStart;
      await runSummaryStage({
        scope: "section",
        id: section.sectionId,
        // Key the stage on the section's start page so the checkpoint is stable
        // across resumes (the close page can shift if upstream pages change).
        page: section.pageStart,
        title: titleOf(section),
        content: pass.sectionInput(section.sectionId, section.pageStart, pageEnd),
        pageStart: section.pageStart,
        pageEnd,
        pass,
      });
    }
  }

  async function finalize(
    pass: DocumentPass,
    outline: readonly OutlineNode[],
    lastPage: number,
  ): Promise<void> {
    // 1. Sections still open at the end never fired a close event — summarise
    //    them now from their accumulated content.
    for (const section of pass.openSectionsAtEnd(lastPage)) {
      const pageEnd = section.pageEnd ?? lastPage;
      await runSummaryStage({
        scope: "section",
        id: section.sectionId,
        page: section.pageStart,
        title: titleOf(section),
        content: pass.sectionInput(section.sectionId, section.pageStart, pageEnd),
        pageStart: section.pageStart,
        pageEnd,
        pass,
      });
    }

    const summaries = pass.summaries();
    const sectionSummaries = new Map(
      summaries.filter((s) => s.scope === "section").map((s) => [s.id, s] as const),
    );

    // 2. Chapters = the shallow outline nodes (level 1 and 2). A chapter is
    //    summarised from the summaries of the sections it contains (itself plus
    //    its descendants), i.e. RAPTOR-light one level up.
    const chapters = outline.filter((n) => n.level <= 2);
    for (const chapter of chapters) {
      const descendants = descendantSections(outline, chapter);
      const content = descendants
        .map((d) => sectionSummaries.get(d.sectionId)?.summary)
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .join("\n\n");
      await runSummaryStage({
        scope: "chapter",
        id: chapter.sectionId,
        page: lastPage,
        title: titleOf(chapter),
        content,
        pageStart: chapter.pageStart,
        pageEnd: chapter.pageEnd ?? lastPage,
        pass,
      });
    }

    // 3. The document summary rolls up the chapter summaries (falling back to
    //    the section summaries when there are no chapters).
    const chapterSummaries = pass
      .summaries()
      .filter((s) => s.scope === "chapter")
      .map((s) => s.summary);
    const docContent = (chapterSummaries.length > 0
      ? chapterSummaries
      : [...sectionSummaries.values()].map((s) => s.summary)
    )
      .filter((s) => s.trim() !== "")
      .join("\n\n");
    await runSummaryStage({
      scope: "document",
      id: "document",
      page: lastPage,
      content: docContent,
      pageStart: 1,
      pageEnd: lastPage,
      pass,
    });

    logger.info(
      { jobId, sections: sectionSummaries.size, chapters: chapters.length },
      "Summary hierarchy complete",
    );
  }

  return { onSectionsClosed, finalize };
}

/** The display title of an outline node: "4.2 Anmeldung" when numbered. */
function titleOf(node: { numbering?: string | undefined; title: string }): string {
  return node.numbering !== undefined ? `${node.numbering} ${node.title}`.trim() : node.title;
}

/**
 * The sections contained in a chapter: the chapter itself plus every deeper
 * outline node between it and the next node at the same-or-shallower level, in
 * document order. The outline is already sorted top-to-bottom by the pass.
 */
function descendantSections(
  outline: readonly OutlineNode[],
  chapter: OutlineNode,
): OutlineNode[] {
  const start = outline.indexOf(chapter);
  if (start < 0) return [chapter];
  const result: OutlineNode[] = [chapter];
  for (let i = start + 1; i < outline.length; i++) {
    const node = outline[i];
    if (node === undefined) break;
    if (node.level <= chapter.level) break; // next sibling/ancestor: chapter ended
    result.push(node);
  }
  return result;
}
