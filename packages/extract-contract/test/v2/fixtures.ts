// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2 fixtures — a fictional appliance manual, deliberately generic, so the
 * published tree leaks no real corpus. Mirrors the v1 fixtures' subject.
 */

import {
  EXTRACT_CONTRACT_ID,
  buildAssetId,
  figureLocalId,
  pageLocalId,
  sha256Hex,
  type DocumentBeginRecord,
  type DocumentEndRecord,
  type ExtractRecord,
  type FigureBlock,
  type PageRecord,
} from "../../src/index.js";

export const REFERENCE = "docs/handbuch.pdf";

export function beginRecord(
  overrides: Partial<DocumentBeginRecord> = {},
): DocumentBeginRecord {
  return {
    type: "document.begin",
    contract: EXTRACT_CONTRACT_ID,
    reference: REFERENCE,
    title: "Betriebsanleitung — Kapitel 4",
    language: "de",
    source: {
      filename: "handbuch.pdf",
      mimeType: "application/pdf",
      bytes: 2048,
      sha256: sha256Hex("handbuch"),
    },
    pipeline: { extractor: "poppler", renderer: "pdftoppm", ocr: false, dpi: 200 },
    pageCount: 2,
    ...overrides,
  };
}

export function figureBlock(
  page: number,
  ordinal: number,
  overrides: Partial<FigureBlock> = {},
  reference = REFERENCE,
): FigureBlock {
  const figureId = overrides.figureId ?? `p${page}-f${ordinal}`;
  return {
    type: "figure",
    id: figureId,
    page,
    figureId,
    kind: "ui_mask",
    caption: `Abbildung ${ordinal}: Maske WE0${ordinal}`,
    description: "Erfassungsmaske für die Avisierung eines Antragseingangs.",
    bbox: [0.1, 0.2, 0.6, 0.75],
    assetId: buildAssetId(reference, figureLocalId(figureId)),
    transcription: {
      format: "fields",
      areas: [
        {
          name: "Kopf",
          fields: [
            { label: "Lieferant", type: "Auswahl", required: true },
            { label: "Avis-Nr.", type: "Text", required: true },
          ],
        },
      ],
      actions: ["Speichern", "Teilfreigabe", "Abbrechen"],
    },
    ...overrides,
  };
}

export function pageRecord(
  page: number,
  overrides: Partial<PageRecord> = {},
): PageRecord {
  return {
    type: "page",
    page,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    summary: `Seite ${page} beschreibt den Antragseingang.`,
    blocks: [
      {
        type: "heading",
        id: `p${page}-h1`,
        page,
        level: 2,
        numbering: "4.2",
        text: "Anmeldung",
        sectionPath: ["4 Antragseingang", "4.2 Anmeldung"],
      },
      { type: "paragraph", id: `p${page}-b1`, page, text: `Fließtext auf Seite ${page}.` },
    ],
    furniture: { header: "Antragseingang", footer: "Vertraulich", pageLabel: `S. ${page}` },
    assets: [
      {
        assetId: buildAssetId(REFERENCE, pageLocalId(page)),
        kind: "page",
        localId: pageLocalId(page),
        page,
        variants: { thumb: true, preview: true },
      },
    ],
    warnings: [],
    fidelity: { fastPath: true, labelCoverage: 1 },
    ...overrides,
  };
}

export function endRecord(
  overrides: Partial<DocumentEndRecord> = {},
): DocumentEndRecord {
  return {
    type: "document.end",
    reference: REFERENCE,
    pageCount: 2,
    outline: [
      { sectionId: "s4", level: 1, numbering: "4", title: "Antragseingang", pageStart: 1 },
      { sectionId: "s4.2", level: 2, numbering: "4.2", title: "Anmeldung", pageStart: 1 },
    ],
    identifiers: [
      { value: "WE01", kind: "mask", occurrences: [{ page: 1, blockId: "p1-f1" }] },
    ],
    summaries: [
      { scope: "document", id: "doc", summary: "Handbuch zum Antragseingang." },
    ],
    refs: [],
    warnings: [],
    ...overrides,
  };
}

/** A complete, well-formed stream: begin, one page with a figure, end. */
export function stream(): ExtractRecord[] {
  return [
    beginRecord(),
    pageRecord(1, {
      blocks: [
        {
          type: "heading",
          id: "p1-h1",
          page: 1,
          level: 2,
          numbering: "4.2",
          text: "Anmeldung",
          sectionPath: ["4 Antragseingang", "4.2 Anmeldung"],
        },
        { type: "paragraph", id: "p1-b1", page: 1, text: "Fließtext vor der Maske." },
        figureBlock(1, 1),
      ],
    }),
    pageRecord(2),
    endRecord(),
  ];
}
