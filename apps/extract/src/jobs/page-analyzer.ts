// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/page-analyzer.ts
 *
 * The deterministic per-page analysis stage — `analyzed` (S2) in the per-page
 * stage sequence `analyzed → vision1 → refined → …`.
 *
 * ## What S2 is
 *
 * Before any model sees a page, poppler already knows a great deal about it for
 * free: the exact wording of every word and *where each word sits*. S2 captures
 * that. It runs `pdftotext -bbox-layout` for the page, reads the per-page size
 * from `pdfinfo -f N -l N`, and turns poppler's XHTML into a normalised
 * structure of blocks → lines → words plus the numbered-heading candidates
 * (parsing lives in `pipeline/bbox-layout.ts`). The result is what the later
 * deterministic and prompt stages consume:
 *
 *   - task 2.3 (Prompt v2) feeds the heading candidates to the Pass-1 prompt,
 *   - task 2.4 (snapping) trims a figure bbox to the ink and pulls `regionText`
 *     from the words inside it,
 *   - task 2.9 (text fast-path) builds blocks straight from this geometry for a
 *     `text` page, with no vision call at all.
 *
 * ## Why it is a checkpointed stage and not a helper
 *
 * S2 is deterministic — no model, so it costs nothing but CPU — but it is still
 * modelled as a {@link StageRunner} stage so a resume reuses it by `input_hash`
 * exactly like every other stage: its output is addressed by
 * `(job, page, "analyzed", input_hash)` and a crash between S2 and vision does
 * not re-run poppler. The stage declares **no budget** (it calls no model) and
 * persists `raw: null` (there is nothing to `reparse` — the analysis IS the
 * deterministic parse).
 *
 * ## Capability and graceful degradation
 *
 * A container whose poppler predates `-bbox-layout` (see
 * {@link probeBboxLayout}) cannot produce the geometry. S2 does not fail the
 * page over that: it returns an empty analysis, and the downstream text
 * fast-path simply never engages, so the page falls through to vision — which
 * is exactly the v1 behaviour. The same empty-but-valid analysis is returned
 * when a page has no text layer (a scan) or poppler emits malformed XHTML.
 */

import type { Logger } from "pino";
import { sha256Hex } from "@atf/extract-contract";
import {
  extractPageBboxLayout,
  probeBboxLayout,
  readPageSize,
  type BboxLayoutCapability,
  type PopplerTools,
} from "../pipeline/pdf.js";
import type { RunOptions } from "../pipeline/exec.js";
import {
  parseBboxLayoutPage,
  type PageAnalysis,
} from "../pipeline/bbox-layout.js";

/** The poppler operations the analyzer depends on, injected for tests. */
export interface AnalyzerPdfOps {
  extractPageBboxLayout: typeof extractPageBboxLayout;
  readPageSize: typeof readPageSize;
  probeBboxLayout: typeof probeBboxLayout;
}

const defaultAnalyzerPdfOps: AnalyzerPdfOps = {
  extractPageBboxLayout,
  readPageSize,
  probeBboxLayout,
};

/** Configuration the analyzer needs. */
export interface PageAnalyzerConfig {
  popplerBinDir: string | null;
  /** Wall-clock ceiling on the poppler invocation; 0 disables. */
  subprocessTimeoutMs: number;
}

export interface PageAnalyzerDeps {
  config: PageAnalyzerConfig;
  logger: Logger;
  pdfOps?: AnalyzerPdfOps;
  /**
   * A shared, process-wide `-bbox-layout` capability probe (memoised by the
   * caller). When given, every prepared source uses it instead of probing
   * poppler once per job; the poppler binary does not change at runtime.
   */
  capability?: () => Promise<BboxLayoutCapability>;
}

/**
 * A page analyzer bound to one prepared PDF. `analyze(page)` is the pure S2
 * work; the job runner wraps it in `runStage("analyzed", …)`. `capability` is
 * probed once and cached so the health/startup report and the per-page
 * fall-through share one answer.
 */
export interface PreparedAnalyzer {
  /** Analyse one page's geometry. Never throws; degrades to an empty analysis. */
  analyze(page: number, signal?: AbortSignal): Promise<PageAnalysis>;
  /** The one-shot `-bbox-layout` capability probe result for this run. */
  capability(): Promise<BboxLayoutCapability>;
  /** The stable input-hash contribution for a page's `analyzed` stage. */
  inputHash(sourceSha256: string, page: number): string;
}

export interface PageAnalyzer {
  /** Bind the analyzer to a prepared PDF path (or a non-PDF source with none). */
  forSource(args: { pdfPath: string | null; home: string }): PreparedAnalyzer;
}

/**
 * Create a page analyzer. `forSource` binds it to one run's PDF; a non-PDF
 * source (a single image) has no text layer, so `pdfPath` is `null` and every
 * `analyze` returns an empty analysis without touching poppler.
 */
export function createPageAnalyzer(deps: PageAnalyzerDeps): PageAnalyzer {
  const { config, logger } = deps;
  const pdfOps = deps.pdfOps ?? defaultAnalyzerPdfOps;

  function runOptions(signal: AbortSignal | undefined): RunOptions {
    return {
      // Passed through as configured: a 0 is a deliberate disable, which the
      // production-readiness gate rejects.
      timeoutMs: config.subprocessTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  function emptyFor(page: number): PageAnalysis {
    return {
      page,
      size: { widthPt: 0, heightPt: 0 },
      blocks: [],
      lines: [],
      words: [],
      headingCandidates: [],
    };
  }

  function forSource(args: {
    pdfPath: string | null;
    home: string;
  }): PreparedAnalyzer {
    const { pdfPath, home } = args;
    const tools: PopplerTools = { binDir: config.popplerBinDir, home };
    let capabilityPromise: Promise<BboxLayoutCapability> | null = null;

    async function capability(): Promise<BboxLayoutCapability> {
      if (capabilityPromise === null) {
        const probe = deps.capability ?? (() => pdfOps.probeBboxLayout(tools));
        capabilityPromise = probe().catch(
          (err): BboxLayoutCapability => ({
            supported: false,
            version: null,
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return capabilityPromise;
    }

    async function analyze(
      page: number,
      signal?: AbortSignal,
    ): Promise<PageAnalysis> {
      if (pdfPath === null) return emptyFor(page);

      const cap = await capability();
      if (!cap.supported) {
        logger.warn(
          { page, reason: cap.reason, version: cap.version },
          "pdftotext -bbox-layout unavailable; page analysis (S2) is empty, page falls through to vision",
        );
        return emptyFor(page);
      }

      const opts = runOptions(signal);
      let xhtml: string;
      try {
        xhtml = await pdfOps.extractPageBboxLayout(pdfPath, page, tools, opts);
      } catch (err) {
        // A per-page geometry failure is not fatal to the page: the analysis is
        // empty and the page is handled by vision, exactly as v1 did.
        logger.warn(
          { page, err },
          "pdftotext -bbox-layout failed for page; using an empty analysis",
        );
        return emptyFor(page);
      }

      const analysis = parseBboxLayoutPage(xhtml, page);

      // The `<page>` size from `-bbox-layout` is authoritative for normalisation
      // and already applied by the parser. When poppler omitted it (rare), fall
      // back to `pdfinfo -f N -l N` for the reported size so the record still
      // carries a page size even though geometry could not be normalised.
      if (!(analysis.size.widthPt > 0) || !(analysis.size.heightPt > 0)) {
        try {
          const size = await pdfOps.readPageSize(pdfPath, page, tools, opts);
          if (size !== null)
            analysis.size = { widthPt: size.widthPt, heightPt: size.heightPt };
        } catch {
          // Leave the zero size; downstream treats it as "no usable geometry".
        }
      }

      return analysis;
    }

    function inputHash(sourceSha256: string, page: number): string {
      // Deterministic: source + page + the fact that this is the bbox-layout
      // analysis. No model or prompt hash participates — S2 calls no model.
      return sha256Hex(`analyzed\n${sourceSha256}\n${page}\nbbox-layout`);
    }

    return { analyze, capability, inputHash };
  }

  return { forSource };
}

export type { PageAnalysis } from "../pipeline/bbox-layout.js";
export type { BboxLayoutCapability } from "../pipeline/pdf.js";
