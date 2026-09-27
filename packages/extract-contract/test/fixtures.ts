// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  EXTRACT_CONTRACT_ID,
  buildDocumentAssetId,
  buildFigureId,
  sha256Hex,
  type ExtractedDocument,
  type ExtractedFigure,
  type ExtractedPage,
} from "../src/v1/index.js";

/**
 * Fixtures are deliberately generic.
 *
 * A test corpus that mirrors a real document set leaks which document set it
 * mirrors — process names, terminology and file naming are recognisable even
 * without a customer name attached. This repository is published, so the
 * fixtures describe a fictional appliance manual and nothing else.
 */
export const REFERENCE = "docs/handbuch.pdf";

export function figure(
  page: number,
  ordinal: number,
  overrides: Partial<ExtractedFigure> = {},
  reference = REFERENCE,
): ExtractedFigure {
  const id = overrides.id ?? buildFigureId(page, ordinal);
  return {
    id,
    page,
    description: `Ablaufdiagramm ${id} mit einem Entscheidungspunkt.`,
    bbox: [0.1, 0.2, 0.6, 0.75],
    assetId: buildDocumentAssetId(reference, id),
    mimeType: "image/png",
    ...overrides,
  };
}

export function page(
  number: number,
  overrides: Partial<ExtractedPage> = {},
): ExtractedPage {
  return {
    page: number,
    markdown: `# Einleitung\n\nAbsatz auf Seite ${number}.`,
    summary: `Seite ${number} beschreibt den Aufbau.`,
    figures: [],
    warnings: [],
    ...overrides,
  };
}

export function document(
  overrides: Partial<ExtractedDocument> = {},
): ExtractedDocument {
  const pages = overrides.pages ?? [page(1), page(2)];
  return {
    contract: EXTRACT_CONTRACT_ID,
    reference: REFERENCE,
    title: "Betriebsanleitung — Kapitel 1",
    source: {
      filename: "handbuch.pdf",
      mimeType: "application/pdf",
      bytes: 1024,
      sha256: sha256Hex("handbuch"),
    },
    pipeline: { extractor: "poppler", renderer: "pdftoppm", ocr: false, dpi: 200 },
    pageCount: pages.length,
    pageLabel: "Seite",
    warnings: [],
    ...overrides,
    pages,
  };
}
