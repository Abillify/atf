// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the page-scoped embedding context (defect D1, Requirement 2.1/2.2/2.5).
 *
 * The old behaviour concatenated every page `<summary>` into one chain and
 * prepended it to *every* chunk. From ~30 pages on, the context dwarfed the
 * chunk, and large documents blew past the embedding model's 8192-token window.
 *
 * The fix attributes each summary to its page and lets a chunk carry only the
 * summaries of the pages it actually covers, capped at 400 characters. These
 * tests pin that the embed input no longer grows with the document's page count
 * and that a chunk sees its own page's summary, not the whole document's.
 */

import { describe, it, expect } from "vitest";
import {
  buildJobsForDocument,
  type ChunkingOptions,
  type IngestDocument,
} from "../src/ingest-jobs.js";
import {
  buildPageContextPrefix,
  normalizeDocumentStructure,
  PAGE_SUMMARY_CONTEXT_LIMIT,
} from "../src/document-structure.js";
import type { EmbedFn } from "../src/semantic-chunker.js";

// A deterministic embed function; job building never needs real vectors here
// because these documents use text-boundary (not semantic) chunking.
const embedFn: EmbedFn = async (texts) => texts.map(() => [0, 0, 0]);

/** Text-boundary chunking with page context enabled (the /ingest-file defaults). */
function chunkingOptions(overrides: Partial<ChunkingOptions> = {}): ChunkingOptions {
  return {
    enabled: true,
    chunkSize: 500,
    overlapSize: 50,
    contextPrefixSize: null,
    lateChunkingAlpha: null,
    useSemanticChunking: false,
    breakpointPercentile: 75,
    useSummarization: false,
    chapterSplitMaxChunks: null,
    documentStructure: "auto",
    summaryMode: "auto",
    pageMarkers: true,
    figureChunks: true,
    normalizeTables: true,
    ...overrides,
  };
}

/** Build a Markdown document of `pageCount` pages, each with its own summary. */
function buildManyPageDocument(pageCount: number): string {
  const pages: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    pages.push(
      [
        `## Seite ${page}`,
        "",
        `<summary>Seite ${page} beschreibt Arbeitsschritt ${page} des Ablaufs.</summary>`,
        "",
        `Auf Seite ${page} wird Arbeitsschritt ${page} ausgeführt. ` +
          `Der Bearbeiter prüft die Eingaben und bestätigt das Ergebnis.`,
      ].join("\n"),
    );
  }
  return pages.join("\n\n---\n\n");
}

async function buildJobs(content: string, options = chunkingOptions()) {
  const doc: IngestDocument = {
    reference: "specs/handbuch.pdf",
    content,
    title: "Handbuch",
    tags: [],
    allowedUsers: [],
    allowedGroups: [],
  };
  return buildJobsForDocument(doc, 0, {}, "replace", options, embedFn, null);
}

describe("normalizeDocumentStructure: per-page summaries", () => {
  it("keeps one summary per page instead of concatenating them", () => {
    const structure = normalizeDocumentStructure(
      buildManyPageDocument(3),
      "specs/handbuch.pdf",
    );
    expect(structure.pageSummaries.get(1)).toContain("Arbeitsschritt 1");
    expect(structure.pageSummaries.get(2)).toContain("Arbeitsschritt 2");
    expect(structure.pageSummaries.get(3)).toContain("Arbeitsschritt 3");
    // No document-wide chain remains.
    expect(structure.embeddedSummary).toBeUndefined();
    // Summaries are stripped from the indexing body.
    expect(structure.content).not.toContain("<summary>");
  });

  it("keeps an unattributed summary as a document-level fallback", () => {
    const structure = normalizeDocumentStructure(
      "<summary>Ein Dokument ohne Seitenmarker.</summary>\n\nNur Text.",
      "specs/a.pdf",
    );
    expect(structure.pageSummaries.size).toBe(0);
    expect(structure.embeddedSummary).toBe("Ein Dokument ohne Seitenmarker.");
  });
});

describe("buildPageContextPrefix", () => {
  const summaries = new Map<number, string>([
    [1, "Erste Seite."],
    [2, "Zweite Seite."],
    [3, "Dritte Seite."],
  ]);

  it("returns only the summaries of the pages a chunk covers", () => {
    expect(buildPageContextPrefix(summaries, 2, 2)).toBe("Zweite Seite.");
    expect(buildPageContextPrefix(summaries, 1, 3)).toBe(
      "Erste Seite. Zweite Seite. Dritte Seite.",
    );
  });

  it("caps the joined context at the 400-character limit", () => {
    const long = new Map<number, string>();
    for (let page = 1; page <= 50; page++) long.set(page, "X".repeat(50));
    const prefix = buildPageContextPrefix(long, 1, 50);
    expect(prefix).toBeDefined();
    expect(prefix?.length ?? 0).toBeLessThanOrEqual(PAGE_SUMMARY_CONTEXT_LIMIT);
    expect(prefix?.length ?? 0).toBeGreaterThan(0);
  });

  it("returns undefined when no page summary applies", () => {
    expect(buildPageContextPrefix(summaries, undefined, undefined)).toBeUndefined();
    expect(buildPageContextPrefix(new Map(), 1, 1)).toBeUndefined();
    expect(buildPageContextPrefix(summaries, 9, 9)).toBeUndefined();
  });
});

describe("buildJobsForDocument: embedding input stays bounded (D1)", () => {
  it("keeps every 2000-page chunk's embed input under the token limit", async () => {
    const jobs = await buildJobs(buildManyPageDocument(2000));
    expect(jobs.length).toBeGreaterThan(0);

    // A conservative character budget: bge-m3 accepts 8192 tokens; even at a
    // pessimistic ~1 token per character an input must stay well under that.
    // The point of the test is that this holds regardless of page count — the
    // context prefix is capped at 400 chars, it does not grow with 2000 pages.
    const TOKEN_LIMIT = 8192;
    for (const job of jobs) {
      expect(job.embedInput.length).toBeLessThan(TOKEN_LIMIT);
      const prefix = job.point.prefix;
      if (prefix !== undefined) {
        expect(prefix.length).toBeLessThanOrEqual(PAGE_SUMMARY_CONTEXT_LIMIT);
      }
    }
  });

  it("gives each chunk only the summaries of the pages it covers", async () => {
    // A chunk may span several pages; its context must be exactly those pages'
    // summaries — never a summary from a page outside its [page_start,page_end].
    const jobs = await buildJobs(buildManyPageDocument(40));
    for (const job of jobs) {
      const start = job.point.chunk?.page_start;
      const end = job.point.chunk?.page_end ?? start;
      if (start === undefined || end === undefined) continue;
      // Every covered page's summary is present.
      for (let page = start; page <= end; page++) {
        expect(job.embedInput).toContain(`Seite ${page} beschreibt Arbeitsschritt ${page}`);
      }
      // A page just outside the range must not leak into the context. The
      // summary marker "beschreibt Arbeitsschritt N" only appears in summaries,
      // so its absence proves the neighbouring page's summary was not attached.
      const outside = end + 1;
      if (outside <= 40) {
        expect(job.embedInput).not.toContain(
          `Seite ${outside} beschreibt Arbeitsschritt ${outside}`,
        );
      }
    }
  });

  it("attaches the summary of a figure's page to its embed input", async () => {
    const content = [
      "## Seite 7",
      "",
      "<summary>Seite 7 zeigt die Erfassungsmaske WE01.</summary>",
      "",
      "<figures>",
      '<figure id="p7-f1" bbox="[0.1, 0.2, 0.6, 0.75]" page="7">Maske WE01.</figure>',
      "</figures>",
      "",
      "Beschreibung der Maske.",
      "",
      "![figure_p7-f1]",
    ].join("\n");
    const jobs = await buildJobs(content);
    const figureJob = jobs.find((job) => job.point.chunk?.figure_id === "p7-f1");
    expect(figureJob).toBeDefined();
    expect(figureJob?.embedInput ?? "").toContain("Seite 7 zeigt die Erfassungsmaske WE01");
  });
});

describe("buildJobsForDocument: embed input header snapshot", () => {
  it("matches the canonical header layout for a text chunk", async () => {
    const content = [
      "## Seite 1",
      "",
      "<summary>Seite 1 führt in das Thema ein.</summary>",
      "",
      "Dies ist der Fließtext der ersten Seite des Dokuments.",
    ].join("\n");
    const jobs = await buildJobs(content);
    expect(jobs).toHaveLength(1);
    // Page markers (`## Seite N`) and separators (`---`) are stripped from the
    // body (task 0.3, Requirement 2.3); the header carries only the page-scoped
    // summary as context, capped at 400.
    expect(jobs[0]?.embedInput).toMatchInlineSnapshot(`
      "title: Handbuch
      ref: specs/handbuch.pdf
      Seite 1 führt in das Thema ein.
      ---
      Dies ist der Fließtext der ersten Seite des Dokuments."
    `);
  });
});
