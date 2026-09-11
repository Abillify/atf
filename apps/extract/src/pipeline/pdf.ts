// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pdf.ts
 *
 * PDF access via poppler: `pdfinfo`, `pdftotext`, `pdftoppm`.
 *
 * Every source format funnels through here. A PDF is used directly; DOCX and
 * XLSX are converted to PDF first (see `office.ts`). Having exactly one
 * page-producing path is the reason page numbers, page images and text offsets
 * agree across formats — the previous implementations had a separate
 * `mammoth`-based path for Word that returned the whole document as one
 * unpaginated block, so a Word document simply had no page numbers.
 *
 * Both signals are extracted per page and both are sent to the model:
 *
 *   `pdftotext -layout` — the embedded text layer, character-exact. This is the
 *   authority for wording, spelling and numbers. A vision model re-reading text
 *   it can already be told verbatim is how transcription errors get introduced.
 *
 *   `pdftoppm -png`     — the rendered page. This is the authority for
 *   structure: heading hierarchy, table geometry including merged cells, and
 *   where figures sit in the flow. None of that is recoverable from a text layer
 *   that linearises a table into a jumbled sequence.
 *
 * A scanned PDF has no text layer, so the text is empty and the model works from
 * the image alone — which is OCR, and is reported as such in the pipeline
 * descriptor rather than being silently indistinguishable from a text-layer
 * extraction.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { conversionFailed } from "../errors.js";
import { run, type RunOptions } from "./exec.js";

export interface PopplerTools {
  /** Directory holding the binaries, or null to resolve them via PATH. */
  binDir: string | null;
  /** Writable HOME/TMPDIR for the child processes. */
  home: string;
}

function binary(tools: PopplerTools, name: string): string {
  return tools.binDir === null ? name : join(tools.binDir, name);
}

/** Page geometry as reported by pdfinfo, in PostScript points. */
export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

export interface PdfInfo {
  pageCount: number;
  /** Size of the first page. Pages may differ; this is a hint, not a contract. */
  pageSize: PdfPageSize | null;
  /** True when the document is encrypted, which poppler may still be able to read. */
  encrypted: boolean;
}

/**
 * Read document-level metadata.
 *
 * The page count comes from `pdfinfo`. When that fails — a slightly malformed
 * PDF that poppler can still render — the count is recovered by counting form
 * feeds in the full text extraction, because refusing the document outright
 * would discard one that converts fine.
 */
export async function readPdfInfo(
  pdfPath: string,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<PdfInfo> {
  try {
    const { stdout } = await run(binary(tools, "pdfinfo"), [pdfPath], tools.home, options);
    const pages = /^Pages:\s+(\d+)/m.exec(stdout);
    const size = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
    const encrypted = /^Encrypted:\s+yes/im.test(stdout);
    const pageCount = pages?.[1] !== undefined ? Number.parseInt(pages[1], 10) : 0;
    if (pageCount > 0) {
      const widthRaw = size?.[1];
      const heightRaw = size?.[2];
      return {
        pageCount,
        pageSize:
          widthRaw !== undefined && heightRaw !== undefined
            ? { widthPt: Number.parseFloat(widthRaw), heightPt: Number.parseFloat(heightRaw) }
            : null,
        encrypted,
      };
    }
  } catch {
    // Fall through to the form-feed count below.
  }

  const pageCount = await countPagesByFormFeed(pdfPath, tools, options);
  return { pageCount, pageSize: null, encrypted: false };
}

/** Recover a page count from `pdftotext` output, where \f separates pages. */
async function countPagesByFormFeed(
  pdfPath: string,
  tools: PopplerTools,
  options: RunOptions,
): Promise<number> {
  try {
    const { stdout } = await run(
      binary(tools, "pdftotext"),
      ["-layout", pdfPath, "-"],
      tools.home,
      options,
    );
    // A trailing form feed produces one empty final segment; a document with no
    // extractable text produces none at all but is still one page.
    const segments = stdout.split("\f");
    const trailing = segments.at(-1)?.trim() === "" ? 1 : 0;
    return Math.max(1, segments.length - trailing);
  } catch (error) {
    throw conversionFailed(
      `Could not determine the page count: ${error instanceof Error ? error.message : String(error)}`,
      { pdfPath },
    );
  }
}

/**
 * Extract the text layer of one page.
 *
 * `-layout` preserves the physical column layout, which keeps a two-column page
 * from interleaving its columns line by line. It does not reconstruct tables —
 * that is what the rendered image is for.
 *
 * An empty result is a legitimate outcome (a scanned page), not an error.
 */
export async function extractPageText(
  pdfPath: string,
  page: number,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<string> {
  const { stdout } = await run(
    binary(tools, "pdftotext"),
    ["-layout", "-f", String(page), "-l", String(page), pdfPath, "-"],
    tools.home,
    options,
  );
  // pdftotext terminates each page with a form feed; it is a page separator, not
  // content, and left in place it reaches the model as a stray control character.
  // NUL bytes appear in text extracted from damaged PDFs and PostgreSQL rejects
  // them outright, so they are removed at the source rather than per row later.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: form feed and NUL are exactly what must go
  return stdout.replace(/\f/g, "\n").replace(/\u0000/g, "").trimEnd();
}

export interface RenderedPage {
  /** PNG bytes of the rendered page. */
  buffer: Buffer;
  /** 1-based page number. */
  page: number;
  /** Resolution the page was rendered at. */
  dpi: number;
}

/**
 * Rasterise one page to PNG.
 *
 * `-singlefile` makes the output name deterministic (`<prefix>.png`). Without
 * it, pdftoppm zero-pads the page number to the width of the total page count,
 * so the filename depends on how long the document is — a detail that has broken
 * every implementation that tried to guess it.
 *
 * PNG rather than JPEG: the input is text and line art, where JPEG ringing
 * around glyph edges measurably costs transcription accuracy, and the image is
 * consumed once by a model rather than stored.
 */
export async function renderPage(
  pdfPath: string,
  page: number,
  dpi: number,
  workDir: string,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<RenderedPage> {
  await mkdir(workDir, { recursive: true });
  const prefix = join(workDir, `page-${page}-${dpi}`);
  await run(
    binary(tools, "pdftoppm"),
    [
      "-png",
      "-r",
      String(dpi),
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      pdfPath,
      prefix,
    ],
    tools.home,
    options,
  );

  const outputPath = `${prefix}.png`;
  try {
    const buffer = await readFile(outputPath);
    if (buffer.length === 0) {
      throw conversionFailed(`pdftoppm produced an empty image for page ${page}`, { page });
    }
    return { buffer, page, dpi };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw conversionFailed(`pdftoppm produced no image for page ${page}`, { page, dpi });
    }
    throw error;
  }
}
