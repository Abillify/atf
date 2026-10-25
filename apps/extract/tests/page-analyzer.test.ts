// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * page-analyzer.test.ts
 *
 * The deterministic per-page analysis stage — `analyzed` (S2) (task 2.1,
 * ). Driven with injected poppler ops so no binary is spawned;
 * one separately-guarded test shells out to the real `pdftotext -bbox-layout`
 * only when poppler is installed, to prove the wrapper and parser agree with
 * what poppler emits.
 *
 * Covers:
 *  - analyze() returns normalised geometry parsed from the bbox-layout output
 *  - a non-PDF source (pdfPath = null) yields an empty analysis, no poppler call
 *  - an unsupported -bbox-layout capability yields an empty analysis (fall-through)
 *  - a poppler failure degrades to an empty analysis rather than throwing
 *  - a page whose bbox-layout size is missing falls back to pdfinfo for the size
 *  - inputHash is deterministic and does not depend on the model/prompt
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testLogger } from "./helpers.js";
import {
  createPageAnalyzer,
  type AnalyzerPdfOps,
} from "../src/jobs/page-analyzer.js";
import type { BboxLayoutCapability } from "../src/pipeline/pdf.js";

const XHTML = `<doc><page width="600" height="800"><flow><block><line>
  <word xMin="60" yMin="80" xMax="180" yMax="120">2.1</word>
  <word xMin="190" yMin="80" xMax="360" yMax="120">Anmeldung</word>
</line></block></flow></page></doc>`;

/** poppler ops that never spawn a process; each behaviour is a spy. */
function fakeOps(overrides: Partial<AnalyzerPdfOps> = {}): AnalyzerPdfOps {
  return {
    async extractPageBboxLayout() {
      return XHTML;
    },
    async readPageSize() {
      return { widthPt: 600, heightPt: 800 };
    },
    async probeBboxLayout(): Promise<BboxLayoutCapability> {
      return { supported: true, version: "pdftotext version 24.02.0" };
    },
    ...overrides,
  };
}

function analyzerWith(ops: AnalyzerPdfOps) {
  return createPageAnalyzer({
    config: { popplerBinDir: null, subprocessTimeoutMs: 0 },
    logger: testLogger,
    pdfOps: ops,
  });
}

describe("createPageAnalyzer", () => {
  it("analyses a page into normalised geometry", async () => {
    const prepared = analyzerWith(fakeOps()).forSource({
      pdfPath: "/tmp/x.pdf",
      home: "/tmp",
    });
    const analysis = await prepared.analyze(1);

    expect(analysis.page).toBe(1);
    expect(analysis.size).toEqual({ widthPt: 600, heightPt: 800 });
    expect(analysis.words).toHaveLength(2);
    expect(analysis.words[0]?.bbox[0]).toBeCloseTo(0.1, 6);
    expect(analysis.headingCandidates[0]?.numbering).toBe("2.1");
  });

  it("returns an empty analysis for a non-PDF source without probing poppler", async () => {
    const extract = vi.fn(fakeOps().extractPageBboxLayout);
    const probe = vi.fn(fakeOps().probeBboxLayout);
    const prepared = analyzerWith(
      fakeOps({ extractPageBboxLayout: extract, probeBboxLayout: probe }),
    ).forSource({ pdfPath: null, home: "/tmp" });

    const analysis = await prepared.analyze(1);
    expect(analysis.words).toEqual([]);
    expect(analysis.blocks).toEqual([]);
    expect(analysis.size).toEqual({ widthPt: 0, heightPt: 0 });
    expect(extract).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("falls through to an empty analysis when -bbox-layout is unsupported", async () => {
    const extract = vi.fn(fakeOps().extractPageBboxLayout);
    const prepared = analyzerWith(
      fakeOps({
        extractPageBboxLayout: extract,
        async probeBboxLayout() {
          return {
            supported: false,
            version: "pdftotext version 0.30.0",
            reason: "too old",
          };
        },
      }),
    ).forSource({ pdfPath: "/tmp/x.pdf", home: "/tmp" });

    const analysis = await prepared.analyze(1);
    expect(analysis.words).toEqual([]);
    // No geometry was requested once the capability probe said "no".
    expect(extract).not.toHaveBeenCalled();
  });

  it("degrades a poppler failure to an empty analysis rather than throwing", async () => {
    const prepared = analyzerWith(
      fakeOps({
        async extractPageBboxLayout() {
          throw new Error("pdftotext exploded");
        },
      }),
    ).forSource({ pdfPath: "/tmp/x.pdf", home: "/tmp" });

    await expect(prepared.analyze(1)).resolves.toMatchObject({
      words: [],
      blocks: [],
    });
  });

  it("falls back to pdfinfo for the page size when bbox-layout omits it", async () => {
    const readPageSize = vi.fn(async () => ({ widthPt: 595, heightPt: 842 }));
    const prepared = analyzerWith(
      fakeOps({
        // A bbox-layout page with no width/height: geometry can't be normalised,
        // but the reported size should still come from pdfinfo.
        async extractPageBboxLayout() {
          return `<doc><page><flow></flow></page></doc>`;
        },
        readPageSize,
      }),
    ).forSource({ pdfPath: "/tmp/x.pdf", home: "/tmp" });

    const analysis = await prepared.analyze(4);
    expect(readPageSize).toHaveBeenCalledOnce();
    expect(analysis.size).toEqual({ widthPt: 595, heightPt: 842 });
  });

  it("probes the capability once and caches it across pages", async () => {
    const probe = vi.fn(fakeOps().probeBboxLayout);
    const prepared = analyzerWith(
      fakeOps({ probeBboxLayout: probe }),
    ).forSource({
      pdfPath: "/tmp/x.pdf",
      home: "/tmp",
    });
    await prepared.analyze(1);
    await prepared.analyze(2);
    await prepared.capability();
    expect(probe).toHaveBeenCalledOnce();
  });

  it("produces a deterministic input hash independent of any model/prompt", () => {
    const prepared = analyzerWith(fakeOps()).forSource({
      pdfPath: "/tmp/x.pdf",
      home: "/tmp",
    });
    const sha = "a".repeat(64);
    const h1 = prepared.inputHash(sha, 5);
    const h2 = prepared.inputHash(sha, 5);
    expect(h1).toBe(h2);
    expect(prepared.inputHash(sha, 6)).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Guarded integration: only runs where a real poppler is installed ────────

function popplerAvailable(): boolean {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeReal = popplerAvailable() ? describe : describe.skip;

describeReal("createPageAnalyzer with real poppler", () => {
  it("reads geometry from a real pdftotext -bbox-layout run", async () => {
    // A tiny one-page PDF authored inline (no external fixture): a single line
    // of text is enough to exercise the wrapper + parser against real poppler.
    const dir = await mkdtemp(join(tmpdir(), "bbox-real-"));
    try {
      const pdfPath = join(dir, "one.pdf");
      await writeFile(pdfPath, MINIMAL_PDF);
      const prepared = createPageAnalyzer({
        config: { popplerBinDir: null, subprocessTimeoutMs: 30_000 },
        logger: testLogger,
      }).forSource({ pdfPath, home: dir });

      const cap = await prepared.capability();
      expect(cap.supported).toBe(true);

      const analysis = await prepared.analyze(1);
      // The page has a positive size and, if the text layer was read, words with
      // in-range normalised coordinates.
      expect(analysis.size.widthPt).toBeGreaterThan(0);
      for (const word of analysis.words) {
        for (const c of word.bbox) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A minimal, hand-written single-page PDF with a text layer ("Hello 1.2"). Kept
 * inline so the guarded test needs no binary asset. Coordinates are in the
 * default 612×792 media box.
 */
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>stream
BT /F1 24 Tf 72 700 Td (Hello 1.2) Tj ET
endstream endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000209 00000 n 
0000000276 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
370
%%EOF`,
  "latin1",
);
