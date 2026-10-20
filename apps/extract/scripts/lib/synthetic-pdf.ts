// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * synthetic-pdf.ts
 *
 * A dependency-free writer for multi-page PDFs with a real text layer, used by
 * the benchmarks under `scripts/` and the poppler tests so they need no binary
 * fixture and no network. Each page carries numbered text lines and a few
 * filled rectangles (so rendering is not trivially empty); page sizes and
 * rotation can vary per page.
 *
 * Deterministic: the same arguments always yield the same bytes.
 */

export interface SyntheticPage {
  /** Page box in points; default A4 (595 × 842). */
  widthPt?: number;
  heightPt?: number;
  /** `/Rotate` in degrees (0, 90, 180, 270). */
  rotate?: number;
}

export interface SyntheticPdfOptions {
  /** Number of pages. */
  pages: number;
  /** Per-page overrides; return `undefined` for the defaults. */
  page?: (pageNumber: number) => SyntheticPage | undefined;
  /** Text lines per page (default 40). */
  lines?: number;
}

/** Escape a string for a PDF literal. */
function pdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Build the PDF bytes. */
export function buildSyntheticPdf(options: SyntheticPdfOptions): Buffer {
  const { pages } = options;
  if (!Number.isInteger(pages) || pages < 1) throw new Error("pages must be a positive integer");
  const lineCount = options.lines ?? 40;

  // Object numbering: 1 catalog, 2 pages, 3 font, then per page a page object
  // and its content stream.
  const FONT = 3;
  const pageObj = (n: number): number => 4 + (n - 1) * 2;
  const contentObj = (n: number): number => pageObj(n) + 1;
  const total = 3 + pages * 2;

  const bodies: string[] = new Array<string>(total + 1).fill("");
  bodies[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  bodies[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${pageObj(i + 1)} 0 R`).join(" ")}] /Count ${pages} >>`;
  bodies[FONT] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  for (let n = 1; n <= pages; n++) {
    const spec = options.page?.(n) ?? {};
    const width = spec.widthPt ?? 595;
    const height = spec.heightPt ?? 842;
    const rotate = spec.rotate ?? 0;
    bodies[pageObj(n)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]` +
      `${rotate !== 0 ? ` /Rotate ${rotate}` : ""}` +
      ` /Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contentObj(n)} 0 R >>`;
    const ops: string[] = ["0.85 g 40 40 120 30 re f 0.6 g 200 40 80 30 re f 0 g", "BT /F1 11 Tf 14 TL 56 " + String(height - 56) + " Td"];
    for (let line = 1; line <= lineCount; line++) {
      ops.push(`(${pdfText(`Seite ${n} Zeile ${line}: Die Anforderung ${n}.${line} gilt fuer alle Module.`)}) Tj T*`);
    }
    ops.push("ET");
    const stream = ops.join("\n");
    bodies[contentObj(n)] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  }

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = new Array<number>(total + 1).fill(0);
  let position = chunks[0]?.length ?? 0;
  for (let id = 1; id <= total; id++) {
    offsets[id] = position;
    const chunk = Buffer.from(`${id} 0 obj\n${bodies[id]}\nendobj\n`, "latin1");
    chunks.push(chunk);
    position += chunk.length;
  }
  const xrefStart = position;
  const xref = [`xref\n0 ${total + 1}\n0000000000 65535 f \n`];
  for (let id = 1; id <= total; id++) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join(""), "latin1"));
  return Buffer.concat(chunks);
}
