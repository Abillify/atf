// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for task 0.4 — linking text and figures (Requirement 2.4/2.5).
 *
 *   - `![figure_ID]` placeholders are substituted with a readable reference
 *     `[Abbildung <id>: <first sentence>]` instead of being deleted, and the
 *     referenced figure id is recorded in the covering chunk's `figure_refs`.
 *   - A figure chunk's embed input carries title, next heading and page summary.
 *   - The search evidence / answer surfaces the `asset_ids` of referenced
 *     figures.
 */

import { describe, it, expect } from "vitest";
import {
  buildJobsForDocument,
  type ChunkingOptions,
  type IngestDocument,
} from "../src/ingest-jobs.js";
import {
  firstSentence,
  normalizeDocumentStructure,
} from "../src/document-structure.js";
import { buildVerifiedEvidencePack } from "../src/evidence-pack.js";
import type { SearchResult } from "../src/postgres-client.js";
import type { EmbedFn } from "../src/semantic-chunker.js";

const embedFn: EmbedFn = async (texts) => texts.map(() => [0, 0, 0]);

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

const REFERENCE = "specs/handbuch.pdf";

/** A document whose running text references a declared figure by placeholder. */
function documentWithFigure(): string {
  return [
    "## Seite 3",
    "",
    "<summary>Seite 3 beschreibt den Antragseingang.</summary>",
    "",
    "<figures>",
    '<figure id="p3-f1" bbox="[0.1, 0.2, 0.6, 0.75]" page="3">Ablaufdiagramm des Antragseingangs. Es zeigt drei Schritte.</figure>',
    "</figures>",
    "",
    "Der Antragseingang folgt einem festen Ablauf.",
    "",
    "![figure_p3-f1]",
    "",
    "## Prozessschritte",
    "",
    "Die Schritte werden nachfolgend erläutert.",
  ].join("\n");
}

async function buildJobs(content: string, options = chunkingOptions()) {
  const doc: IngestDocument = {
    reference: REFERENCE,
    content,
    title: "Handbuch",
    tags: [],
    allowedUsers: [],
    allowedGroups: [],
  };
  return buildJobsForDocument(doc, 0, {}, "replace", options, embedFn, null);
}

describe("firstSentence", () => {
  it("returns the first sentence of a multi-sentence caption", () => {
    expect(firstSentence("Ablaufdiagramm des Antragseingangs. Es zeigt drei Schritte.")).toBe(
      "Ablaufdiagramm des Antragseingangs.",
    );
  });

  it("returns the whole text when there is no sentence terminator", () => {
    expect(firstSentence("Maske WE01")).toBe("Maske WE01");
  });

  it("caps an overly long sentence", () => {
    const long = `${"A".repeat(200)}.`;
    const sentence = firstSentence(long, 160);
    expect(sentence.length).toBeLessThanOrEqual(161);
    expect(sentence.endsWith("…")).toBe(true);
  });
});

describe("normalizeDocumentStructure: figure placeholder substitution (Requirement 2.4)", () => {
  it("replaces the placeholder with a readable reference instead of deleting it", () => {
    const structure = normalizeDocumentStructure(documentWithFigure(), REFERENCE);
    expect(structure.content).not.toMatch(/!\[figure_/);
    expect(structure.content).toContain(
      "[Abbildung p3-f1: Ablaufdiagramm des Antragseingangs.]",
    );
  });

  it("records the referenced figure with its char span in the final body", () => {
    const structure = normalizeDocumentStructure(documentWithFigure(), REFERENCE);
    expect(structure.figureReferences).toHaveLength(1);
    const ref = structure.figureReferences[0];
    expect(ref?.id).toBe("p3-f1");
    expect(ref?.assetId).toBe(structure.figures[0]?.assetId);
    // The span must point at the substituted marker in the final content.
    expect(
      structure.content.slice(ref?.charStart ?? 0, ref?.charEnd ?? 0),
    ).toContain("[Abbildung p3-f1");
  });

  it("captures the next heading for the figure", () => {
    const structure = normalizeDocumentStructure(documentWithFigure(), REFERENCE);
    expect(structure.figures[0]?.nextHeading).toBe("Prozessschritte");
  });

  it("still substitutes a placeholder that has no declared <figure> block", () => {
    const structure = normalizeDocumentStructure(
      "## Seite 1\n\nText.\n\n![figure_orphan]",
      REFERENCE,
    );
    expect(structure.content).toContain("[Abbildung orphan]");
    // No declared figure, so nothing to attribute an asset id to.
    expect(structure.figureReferences).toHaveLength(0);
  });
});

describe("buildJobsForDocument: figure_refs on the covering chunk (Requirement 2.4)", () => {
  it("records the referenced figure id and asset id on the text chunk", async () => {
    const jobs = await buildJobs(documentWithFigure());
    const textJobs = jobs.filter((job) => job.point.chunk?.figure_id === undefined);
    const withRef = textJobs.find((job) => job.point.chunk?.figure_refs?.length);
    expect(withRef).toBeDefined();
    const refs = withRef?.point.chunk?.figure_refs ?? [];
    expect(refs).toEqual([
      { figure_id: "p3-f1", asset_id: expect.any(String) },
    ]);
    // The figure chunk itself does not reference other figures.
    const figureJob = jobs.find((job) => job.point.chunk?.figure_id === "p3-f1");
    expect(figureJob?.point.chunk?.figure_refs).toBeUndefined();
  });
});

describe("buildJobsForDocument: figure chunk embed input (Requirement 2.5)", () => {
  it("includes title, next heading and the page summary", async () => {
    const jobs = await buildJobs(documentWithFigure());
    const figureJob = jobs.find((job) => job.point.chunk?.figure_id === "p3-f1");
    expect(figureJob).toBeDefined();
    const embed = figureJob?.embedInput ?? "";
    expect(embed).toContain("title: Handbuch");
    expect(embed).toContain("heading: Prozessschritte");
    expect(embed).toContain("Seite 3 beschreibt den Antragseingang");
  });
});

describe("verified evidence surfaces referenced figure asset ids (Requirement 2.4)", () => {
  it("exposes figureRefs and assetIds in the answer citation", () => {
    const result: SearchResult = {
      id: "1",
      score: 0.9,
      content: "Der Antragseingang folgt einem festen Ablauf. [Abbildung p3-f1: …]",
      metadata: { version: "v1" },
      reference: "specs/handbuch.pdf_chunk_0",
      base_ref: "specs/handbuch.pdf",
      evidence: {
        reference: "specs/handbuch.pdf_chunk_0",
        root_document_id: "specs/handbuch.pdf",
        figure_refs: [{ figure_id: "p3-f1", asset_id: "asset-abc" }],
        asset_ids: ["asset-abc"],
      },
      created: new Date("2026-03-01T00:00:00.000Z"),
      modified: new Date("2026-03-01T00:00:00.000Z"),
      valid_from: null,
      effective_valid_from: new Date("2026-03-01T00:00:00.000Z"),
    };
    const pack = buildVerifiedEvidencePack({
      collection: "handbuch",
      query: "antragseingang",
      effectiveQuery: "antragseingang",
      accessScopeFingerprint: "scope",
      results: [result],
      requestedLimit: 10,
      retrievedAt: "2026-09-11T00:00:00.000Z",
      hybrid: false,
      hydeApplied: false,
      reranked: false,
      includeAllVersions: false,
      candidateMultiplier: 4,
      fetchLimit: 10,
      sparseApplied: false,
    });
    const citation = pack.evidence[0]?.citation;
    expect(citation?.assetIds).toEqual(["asset-abc"]);
    expect(citation?.figureRefs).toEqual([
      { figureId: "p3-f1", assetId: "asset-abc" },
    ]);
  });
});
