// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * extract.ts
 *
 * The orchestrator: an uploaded file in, a contract-valid document out.
 *
 * ## One page-producing path
 *
 * Every format funnels into the same PDF page loop. A PDF is used as-is; Word
 * and spreadsheet documents become a PDF via LibreOffice first; a single image becomes a one-page
 * document without a text layer. That is why page numbers, page images and text
 * offsets agree across formats — and why a Word document has page numbers at all,
 * which the implementation this replaces could not provide because it parsed
 * OOXML directly and never laid the document out.
 *
 * ## Per page
 *
 *   1. render at `RENDER_DPI`      → what the model sees
 *   2. extract the text layer      → what the model must not re-read
 *   3. one vision call             → summary, figures, body Markdown
 *   4. render at `FIGURE_DPI` and crop, but only when the page has figures
 *
 * Step 4 renders the page a second time on purpose. Crops are shown to a human in
 * a search result, so they should be sharper than the model's input; and
 * re-rasterising a page costs milliseconds next to a model call that costs
 * seconds. Pages without figures skip it entirely.
 *
 * ## One bad page does not lose the document
 *
 * A page whose model call fails outright is recorded as an empty page carrying a
 * warning, and the run continues. The alternative — failing the document — throws
 * away 199 good pages because of one, after having already paid for them. The
 * failure is not hidden: it lands in the page's warnings, the document's
 * warnings, and `extract_vision_failures_total`.
 *
 * A page whose model call *truncates* at the largest token budget keeps its
 * partial content, also with a warning, for the same reason.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import {
  EXTRACT_CONTRACT_ID,
  buildDocumentAssetId,
  isValidBoundingBox,
  sha256Hex,
  validateDocument,
  serializeDocument,
  type ExtractedDocument,
  type ExtractedFigure,
  type ExtractedPage,
  type PageLabel,
} from "@atf/extract-contract/v1";
import { ExtractError, conversionFailed, unsupportedMediaType } from "../errors.js";
import { resolveFormat, type SupportedFormat } from "../formats.js";
import { mapOrdered } from "../queue.js";
import type { VisionClient } from "../vision/client.js";
import { parseVisionPage } from "../vision/response.js";
import { convertToPdf, officeExtensionFor } from "./office.js";
import {
  extractPageText,
  readPageSize,
  readPdfInfo,
  renderPage,
  type PdfPageSize,
  type PopplerTools,
  type RenderedPage,
} from "./pdf.js";
import type { RunOptions } from "./exec.js";
import {
  adaptiveRenderDpi,
  cropFigure,
  imageSize,
  normalizeImageToPage,
  type FigureCrop,
} from "./raster.js";
import { checkTextFidelity, textFidelityWarning } from "./text-fidelity.js";

/**
 * The poppler operations the orchestrator depends on, injected so a test can
 * make a single page fail without a corrupt fixture and without touching the
 * other pages. In production these are the real functions from `pdf.ts`.
 */
export interface PdfOps {
  readPdfInfo: typeof readPdfInfo;
  readPageSize: typeof readPageSize;
  renderPage: typeof renderPage;
  extractPageText: typeof extractPageText;
  imageSize: typeof imageSize;
}

const defaultPdfOps: PdfOps = {
  readPdfInfo,
  readPageSize,
  renderPage,
  extractPageText,
  imageSize,
};

/** Configuration slice the extractor needs. */
export interface ExtractorConfig {
  renderDpi: number;
  figureDpi: number;
  maxPages: number;
  tempDir: string;
  pageLabel: PageLabel;
  libreofficeBin: string;
  popplerBinDir: string | null;
  pageConcurrency: number;
  /** Wall-clock ceiling on each poppler/LibreOffice invocation; 0 disables. */
  subprocessTimeoutMs: number;
  /** Recorded in the pipeline descriptor so an index can be audited later. */
  visionModel: string;
}

/** Observability hooks, kept as an interface so tests can pass a no-op. */
export interface ExtractorMetrics {
  recordPage(mimeType: string, durationMs: number): void;
  recordVision(options: {
    ok: boolean;
    truncated: boolean;
    inputTokens: number;
    outputTokens: number;
  }): void;
  recordFigures(detected: number, rendered: number): void;
  recordTextFidelity(options: { flagged: boolean; missingTokens: number }): void;
}

export interface ExtractorDeps {
  config: ExtractorConfig;
  logger: Logger;
  vision: VisionClient;
  metrics: ExtractorMetrics;
  /** Overridable poppler operations. Defaults to the real `pdf.ts` functions. */
  pdfOps?: PdfOps;
}

export interface ExtractProgress {
  page: ExtractedPage;
  crops: ReadonlyMap<string, FigureCrop>;
  pageCount: number;
  usage: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number };
  timing: { elapsedMs: number; pageMs: number; visionMs: number };
}

export interface ExtractInput {
  buffer: Uint8Array;
  filename: string;
  declaredMimeType?: string | undefined;
  /** Stable document identity; asset ids are derived from it. */
  reference: string;
  title?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Called once the input has become a page-addressable document. */
  onPrepared?: (state: { pageCount: number; extractionMs: number }) => void | Promise<void>;
  /**
   * Called for each page in reading order as soon as its prefix is complete.
   * Used by the SSE handler; the crops for that page are passed alongside so a
   * caller can upload them incrementally instead of holding all of them.
   */
  onPage?: (page: ExtractedPage, crops: ReadonlyMap<string, FigureCrop>) => void | Promise<void>;
  /** Rich additive progress callback with cumulative usage and timing. */
  onProgress?: (progress: ExtractProgress) => void | Promise<void>;
}

export interface ExtractResult {
  document: ExtractedDocument;
  /** Serialized canonical Markdown. */
  markdown: string;
  /** Rendered figure crops, keyed by figure id. */
  crops: Map<string, FigureCrop>;
}

/** What one page contributed, before assembly. */
interface PageOutcome {
  page: ExtractedPage;
  crops: Map<string, FigureCrop>;
  /** True when the page had no text layer, so its text came from the image. */
  usedOcr: boolean;
  usage: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number };
  pageMs: number;
  visionMs: number;
}

/** A page image plus the geometry needed to resolve a normalised bbox. */
interface PageImage {
  buffer: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

export interface Extractor {
  extract(input: ExtractInput): Promise<ExtractResult>;
}

export function createExtractor(deps: ExtractorDeps): Extractor {
  const { config, logger, vision, metrics } = deps;
  const pdfOps = deps.pdfOps ?? defaultPdfOps;

  /**
   * Base run options for a poppler/LibreOffice call: the configured subprocess
   * timeout plus the client's abort signal. A hung child otherwise ties up a
   * `PAGE_CONCURRENCY` slot indefinitely (Requirement 2.9).
   */
  function subprocessOptions(signal: AbortSignal | undefined): RunOptions {
    return {
      ...(config.subprocessTimeoutMs > 0 ? { timeoutMs: config.subprocessTimeoutMs } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  async function extract(input: ExtractInput): Promise<ExtractResult> {
    const startedAt = Date.now();

    const resolved = resolveFormat({
      buffer: input.buffer,
      filename: input.filename,
      declaredMimeType: input.declaredMimeType,
    });
    if (!resolved.ok) {
      throw unsupportedMediaType(resolved.reason, { filename: input.filename });
    }
    const format = resolved.format;
    if (format.kind === "email") {
      throw unsupportedMediaType(
        "E-mail (EML) is ingested through the job pipeline (POST /v2/jobs, or /v1/ingest with a database)",
        { filename: input.filename },
      );
    }

    // A per-conversion scratch directory. LibreOffice profiles, rendered pages
    // and the intermediate PDF all live here, and it is removed unconditionally
    // so a failed conversion cannot accumulate hundreds of megabytes.
    const workDir = await mkdtemp(join(config.tempDir || tmpdir(), "convert-"));
    const tools: PopplerTools = { binDir: config.popplerBinDir, home: workDir };

    try {
      const prepared = await preparePages(input, format, workDir, tools);
      const { pageCount, pageSource } = prepared;
      const extractionMs = Date.now() - startedAt;

      if (config.maxPages > 0 && pageCount > config.maxPages) {
        throw new ExtractError(
          "TOO_MANY_PAGES",
          `The document has ${pageCount} pages; the configured limit is ${config.maxPages}`,
          { pageCount, maxPages: config.maxPages },
        );
      }

      logger.info(
        {
          reference: input.reference,
          format: format.mimeType,
          pageCount,
          renderDpi: config.renderDpi,
          figureDpi: config.figureDpi,
        },
        "Extraction started",
      );

      await input.onPrepared?.({ pageCount, extractionMs });

      const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
      const cumulativeUsage = {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      const outcomes = await mapOrdered(
        pageNumbers,
        config.pageConcurrency,
        (pageNumber) =>
          convertPage({
            pageNumber,
            pageCount,
            pageSource,
            input,
            format,
            workDir,
            tools,
          }),
        async (outcome) => {
          cumulativeUsage.requests += outcome.usage.requests;
          cumulativeUsage.promptTokens += outcome.usage.promptTokens;
          cumulativeUsage.completionTokens += outcome.usage.completionTokens;
          cumulativeUsage.totalTokens += outcome.usage.totalTokens;
          if (input.onPage !== undefined) await input.onPage(outcome.page, outcome.crops);
          await input.onProgress?.({
            page: outcome.page,
            crops: outcome.crops,
            pageCount,
            usage: { ...cumulativeUsage },
            timing: {
              elapsedMs: Date.now() - startedAt,
              pageMs: outcome.pageMs,
              visionMs: outcome.visionMs,
            },
          });
        },
      );

      const pages = outcomes.map((outcome) => outcome.page);
      const crops = new Map<string, FigureCrop>();
      for (const outcome of outcomes) {
        for (const [figureId, crop] of outcome.crops) crops.set(figureId, crop);
      }

      const warnings = pages.flatMap((page) =>
        page.warnings.map((warning) => `Seite ${page.page}: ${warning}`),
      );

      const document: ExtractedDocument = {
        contract: EXTRACT_CONTRACT_ID,
        reference: input.reference,
        ...(input.title !== undefined ? { title: input.title } : { title: input.filename }),
        source: {
          filename: input.filename,
          mimeType: format.mimeType,
          bytes: input.buffer.byteLength,
          sha256: sha256Hex(input.buffer),
        },
        pipeline: {
          extractor: extractorLabel(format),
          renderer: format.kind === "image" ? "sharp" : "pdftoppm",
          visionModel: config.visionModel,
          // Honest labelling: a page with no text layer had its text read out of
          // the image, which is OCR, and an operator comparing two ingests of the
          // same file needs to see that they differed in that.
          ocr: outcomes.some((outcome) => outcome.usedOcr),
          dpi: config.renderDpi,
        },
        pageCount: pages.length,
        pageLabel: config.pageLabel,
        pages,
        usage: {
          requests: outcomes.reduce((sum, outcome) => sum + outcome.usage.requests, 0),
          promptTokens: outcomes.reduce((sum, outcome) => sum + outcome.usage.promptTokens, 0),
          completionTokens: outcomes.reduce(
            (sum, outcome) => sum + outcome.usage.completionTokens,
            0,
          ),
          totalTokens: outcomes.reduce((sum, outcome) => sum + outcome.usage.totalTokens, 0),
        },
        timings: {
          totalMs: Date.now() - startedAt,
          extractionMs,
          visionMs: outcomes.reduce((sum, outcome) => sum + outcome.visionMs, 0),
          renderMs: outcomes.reduce(
            (sum, outcome) => sum + Math.max(0, outcome.pageMs - outcome.visionMs),
            0,
          ),
          ...(outcomes[0] !== undefined
            ? { timeToFirstPageMs: extractionMs + outcomes[0].pageMs }
            : {}),
          avgVisionMsPerPage:
            outcomes.length === 0
              ? 0
              : Math.round(
                  outcomes.reduce((sum, outcome) => sum + outcome.visionMs, 0) /
                    outcomes.length,
                ),
          perPageVisionMs: outcomes.map((outcome) => outcome.visionMs),
        },
        warnings,
      };

      // Contract violations are a bug in this service, not in the upload, so they
      // are logged in full and reported as a server error rather than silently
      // shipped to Search where they would corrupt an index.
      const issues = validateDocument(document);
      const errors = issues.filter((issue) => issue.severity === "error");
      if (errors.length > 0) {
        logger.error(
          { reference: input.reference, issues: errors },
          "The extracted document violates the extract contract",
        );
        throw new ExtractError(
          "CONTRACT_VIOLATION",
          `The extracted document violates the contract: ${errors
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")}`,
          { issues: errors },
        );
      }
      for (const issue of issues) {
        logger.warn({ reference: input.reference, issue }, "Extract contract warning");
      }

      const markdown = serializeDocument(document);
      logger.info(
        {
          reference: input.reference,
          pageCount: pages.length,
          figures: crops.size,
          markdownLength: markdown.length,
          durationMs: Date.now() - startedAt,
          ocr: document.pipeline.ocr,
        },
        "Extraction complete",
      );

      return { document, markdown, crops };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Resolve the source into something page-addressable.
   *
   * Returns either a PDF path plus its page count, or a single pre-rendered
   * image. Both are handled by the same page loop below.
   */
  async function preparePages(
    input: ExtractInput,
    format: SupportedFormat,
    workDir: string,
    tools: PopplerTools,
  ): Promise<{ pageCount: number; pageSource: PageSource }> {
    if (format.kind === "image") {
      const page = await normalizeImageToPage(input.buffer);
      return {
        pageCount: 1,
        pageSource: {
          kind: "image",
          image: {
            buffer: page.buffer,
            mimeType: page.mimeType,
            width: page.width,
            height: page.height,
          },
        },
      };
    }

    let pdfPath: string;
    if (format.kind === "pdf") {
      pdfPath = join(workDir, "source.pdf");
      await writeFile(pdfPath, input.buffer);
    } else {
      pdfPath = await convertToPdf(
        { buffer: input.buffer, extension: officeExtensionFor(format) },
        {
          binary: config.libreofficeBin,
          workDir,
          ...subprocessOptions(input.signal),
        },
      );
    }

    const info = await pdfOps.readPdfInfo(pdfPath, tools, subprocessOptions(input.signal));
    if (info.pageCount < 1) {
      throw conversionFailed("The document reports no pages", { filename: input.filename });
    }
    return { pageCount: info.pageCount, pageSource: { kind: "pdf", pdfPath } };
  }

  /**
   * Render one PDF page at a DPI chosen from that page's own size.
   *
   * The size comes from `pdfinfo -f N -l N`, not a document-level hint, because a
   * document can mix sizes — an A4 report with a folded-out A0 plan is the case
   * that matters. A page larger than the preferred DPI would produce is scaled
   * down (`adaptiveRenderDpi`) so it stays under the pixel ceiling and is
   * rendered rather than dropped (Requirement 2.7). A page whose size cannot be
   * read falls back to the preferred DPI.
   */
  async function renderPdfPage(
    pdfPath: string,
    pageNumber: number,
    workDir: string,
    tools: PopplerTools,
    input: ExtractInput,
  ): Promise<RenderedPage> {
    const runOptions = subprocessOptions(input.signal);
    let pageSize: PdfPageSize | null = null;
    try {
      pageSize = await pdfOps.readPageSize(pdfPath, pageNumber, tools, runOptions);
    } catch {
      // A size probe failure is not fatal: render at the preferred DPI and let
      // the pixel guard in the renderer catch a genuinely oversized page.
      pageSize = null;
    }
    const dpi =
      pageSize !== null ? adaptiveRenderDpi(pageSize, config.renderDpi) : config.renderDpi;
    if (pageSize !== null && dpi < config.renderDpi) {
      logger.info(
        { reference: input.reference, page: pageNumber, pageSize, dpi, renderDpi: config.renderDpi },
        "Page is large; rendering DPI adapted to stay under the pixel limit",
      );
    }
    return pdfOps.renderPage(pdfPath, pageNumber, dpi, join(workDir, "render"), tools, runOptions);
  }

  /** The empty, warned page a failed page collapses to, so the run continues. */
  function failedPage(
    pageNumber: number,
    error: unknown,
    pageStartedAt: number,
    format: SupportedFormat,
    reference: string,
  ): PageOutcome {
    logger.error(
      { reference, page: pageNumber, err: error },
      "Page render or text extraction failed; continuing with an empty page",
    );
    // No vision call happened, so this is not counted as a vision failure; the
    // page still lands in the per-page and document warnings.
    metrics.recordPage(format.mimeType, Date.now() - pageStartedAt);
    return {
      page: {
        page: pageNumber,
        markdown: "",
        figures: [],
        warnings: [
          `Die Seite konnte nicht gerendert oder ihr Text nicht extrahiert werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
      crops: new Map(),
      usedOcr: false,
      usage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      pageMs: Date.now() - pageStartedAt,
      visionMs: 0,
    };
  }

  /** Convert one page: render, read text, ask the model, cut crops. */
  async function convertPage(args: {
    pageNumber: number;
    pageCount: number;
    pageSource: PageSource;
    input: ExtractInput;
    format: SupportedFormat;
    workDir: string;
    tools: PopplerTools;
  }): Promise<PageOutcome> {
    const { pageNumber, pageCount, pageSource, input, format, workDir, tools } = args;
    const pageStartedAt = Date.now();
    const warnings: string[] = [];
    const runOptions = subprocessOptions(input.signal);

    let image: PageImage;
    let rawText = "";

    if (pageSource.kind === "image") {
      image = pageSource.image;
      // An uploaded image has no text layer by definition; the model transcribes
      // from the pixels, which is reported as OCR.
    } else {
      // Rendering and text extraction shell out to poppler, and any of the three
      // calls can fail on a single malformed page — a broken xref, an image the
      // decoder chokes on, a subprocess timeout. Failing here would abort the
      // whole document and throw away every other page, so a per-page failure is
      // caught and turned into an empty page carrying a warning; the run
      // continues (Requirement 2.8).
      try {
        const rendered = await renderPdfPage(pageSource.pdfPath, pageNumber, workDir, tools, input);
        const size = await pdfOps.imageSize(rendered.buffer);
        image = {
          buffer: rendered.buffer,
          mimeType: "image/png",
          width: size.width,
          height: size.height,
        };
        rawText = await pdfOps.extractPageText(pageSource.pdfPath, pageNumber, tools, runOptions);
      } catch (error) {
        // A client disconnect aborts the whole run; anything else costs this page
        // and nothing more.
        if (error instanceof ExtractError && error.code === "CLIENT_ABORTED") throw error;
        if (input.signal?.aborted === true) throw error;
        return failedPage(pageNumber, error, pageStartedAt, format, input.reference);
      }
    }

    const usedOcr = rawText.trim() === "";

    let parsed: ReturnType<typeof parseVisionPage>;
    let visionMs = 0;
    let usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
      const visionStartedAt = Date.now();
      const response = await vision.analyzePage({
        page: pageNumber,
        pageCount,
        rawText,
        image: { buffer: image.buffer, mimeType: image.mimeType },
        signal: input.signal,
      });
      visionMs = Date.now() - visionStartedAt;
      usage = { requests: response.requests, ...response.usage };
      metrics.recordVision({
        ok: true,
        truncated: response.truncated,
        inputTokens: response.usage.promptTokens,
        outputTokens: response.usage.completionTokens,
      });
      if (response.truncated) {
        warnings.push(
          "Die Modellantwort war auch beim größten Token-Budget abgeschnitten; " +
            "der Seiteninhalt ist unvollständig.",
        );
      }
      parsed = parseVisionPage(response.raw, pageNumber);
    } catch (error) {
      // A client disconnect must abort the whole run; anything else costs this
      // page and nothing more.
      if (error instanceof ExtractError && error.code === "CLIENT_ABORTED") throw error;
      if (input.signal?.aborted === true) throw error;

      metrics.recordVision({ ok: false, truncated: false, inputTokens: 0, outputTokens: 0 });
      logger.error(
        { reference: input.reference, page: pageNumber, err: error },
        "Page conversion failed; continuing with an empty page",
      );
      metrics.recordPage(format.mimeType, Date.now() - pageStartedAt);
      return {
        page: {
          page: pageNumber,
          markdown: "",
          figures: [],
          warnings: [
            `Die Seite konnte nicht konvertiert werden: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
        },
        crops: new Map(),
        usedOcr,
        usage,
        pageMs: Date.now() - pageStartedAt,
        visionMs,
      };
    }

    warnings.push(...parsed.warnings);

    // Verify the model kept the text layer's wording. Only meaningful when there
    // was an authoritative text layer to compare against — an OCR page has no
    // ground truth, so the check would compare the model's output to itself.
    if (!usedOcr) {
      const fidelity = checkTextFidelity(rawText, parsed.markdown);
      metrics.recordTextFidelity({
        flagged: fidelity.flagged,
        missingTokens: fidelity.missing.length,
      });
      const fidelityWarning = textFidelityWarning(fidelity);
      if (fidelityWarning !== undefined) warnings.push(fidelityWarning);
    }

    const { figures, crops } = await renderFigures({
      parsed,
      pageNumber,
      pageSource,
      image,
      input,
      workDir,
      tools,
      warnings,
    });

    metrics.recordFigures(parsed.figures.length, crops.size);
    metrics.recordPage(format.mimeType, Date.now() - pageStartedAt);

    const page: ExtractedPage = {
      page: pageNumber,
      markdown: parsed.markdown,
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      figures,
      warnings,
    };
    return {
      page,
      crops,
      usedOcr,
      usage,
      pageMs: Date.now() - pageStartedAt,
      visionMs,
    };
  }

  /**
   * Cut crops for a page's figures.
   *
   * Figures without a usable bbox are kept but produce no crop: the description
   * is still retrievable text and still worth indexing, and dropping the figure
   * entirely would lose it for a geometry problem.
   */
  async function renderFigures(args: {
    parsed: ReturnType<typeof parseVisionPage>;
    pageNumber: number;
    pageSource: PageSource;
    image: PageImage;
    input: ExtractInput;
    workDir: string;
    tools: PopplerTools;
    warnings: string[];
  }): Promise<{ figures: ExtractedFigure[]; crops: Map<string, FigureCrop> }> {
    const { parsed, pageNumber, pageSource, image, input, workDir, tools, warnings } = args;
    const figures: ExtractedFigure[] = [];
    const crops = new Map<string, FigureCrop>();

    const croppable = parsed.figures.filter(
      (figure) => figure.bbox !== undefined && isValidBoundingBox(figure.bbox),
    );

    // Only re-render when there is something to cut out of the higher-resolution
    // page, and only when re-rendering can actually improve on what we have.
    let cropSource: PageImage = image;
    if (
      croppable.length > 0 &&
      pageSource.kind === "pdf" &&
      config.figureDpi > config.renderDpi
    ) {
      try {
        const rendered = await pdfOps.renderPage(
          pageSource.pdfPath,
          pageNumber,
          config.figureDpi,
          join(workDir, "figures"),
          tools,
          subprocessOptions(input.signal),
        );
        const size = await pdfOps.imageSize(rendered.buffer);
        cropSource = {
          buffer: rendered.buffer,
          mimeType: "image/png",
          width: size.width,
          height: size.height,
        };
      } catch (error) {
        // Falling back to the model-resolution page yields a coarser crop, which
        // is much better than no crop.
        warnings.push(
          "Die höher aufgelöste Seite für die Abbildungsausschnitte konnte nicht " +
            "erzeugt werden; es wurde die Modellauflösung verwendet.",
        );
        logger.warn(
          { reference: input.reference, page: pageNumber, err: error },
          "Figure re-render failed; using the model-resolution page",
        );
      }
    }

    for (const figure of parsed.figures) {
      const base = {
        id: figure.id,
        page: pageNumber,
        description: figure.description,
        assetId: buildDocumentAssetId(input.reference, figure.id),
      };

      if (figure.bbox === undefined || !isValidBoundingBox(figure.bbox)) {
        // The contract requires a box with area, so an unusable one is replaced
        // by the full page: the entry stays, and its crop is the page it is on,
        // which is still the right thing to show a reader.
        warnings.push(
          `Abbildung ${figure.id} hatte keine verwertbare Bounding-Box; es wird die ` +
            "gesamte Seite als Ausschnitt verwendet.",
        );
        const crop = await cropFigure(cropSource.buffer, [0, 0, 1, 1], cropSource).catch(
          () => null,
        );
        figures.push({
          ...base,
          bbox: [0, 0, 1, 1],
          mimeType: "image/png",
          ...(crop !== null ? { bytes: crop.buffer.byteLength, checksum: sha256Hex(crop.buffer) } : {}),
        });
        if (crop !== null) crops.set(figure.id, crop);
        continue;
      }

      try {
        const crop = await cropFigure(cropSource.buffer, figure.bbox, cropSource);
        crops.set(figure.id, crop);
        figures.push({
          ...base,
          bbox: [...figure.bbox],
          mimeType: crop.mimeType,
          bytes: crop.buffer.byteLength,
          checksum: sha256Hex(crop.buffer),
        });
      } catch (error) {
        warnings.push(
          `Der Ausschnitt für Abbildung ${figure.id} konnte nicht erzeugt werden; ` +
            "die Beschreibung bleibt indexiert.",
        );
        logger.warn(
          { reference: input.reference, page: pageNumber, figure: figure.id, err: error },
          "Figure crop failed; keeping the description",
        );
        figures.push({ ...base, bbox: [...figure.bbox], mimeType: "image/png" });
      }
    }

    return { figures, crops };
  }

  return { extract };
}

/** Either a PDF on disk or a single normalised image. */
type PageSource =
  | { kind: "pdf"; pdfPath: string }
  | { kind: "image"; image: PageImage };

function extractorLabel(format: SupportedFormat): string {
  switch (format.kind) {
    case "pdf":
      return "poppler";
    case "word":
    case "spreadsheet":
    case "presentation":
    case "visio":
      return "libreoffice+poppler";
    case "bpmn":
      return "native-bpmn";
    case "email":
      return "native-email";
    case "image":
      return "sharp";
  }
}
