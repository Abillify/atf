// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/page-renderer.ts
 *
 * On-demand page rendering from the content-addressed source store (design
 * §9a.1, §9b; task 1.7, requirements 4.2, 6.1).
 *
 * The v1 pipeline (`pipeline/extract.ts`) renders from an in-memory upload and
 * holds the intermediate PDF in a scratch directory for the life of one
 * conversion. A v2 job cannot do that: it renders on a worker, on demand, from
 * the one durable copy in the {@link SourceStore}, and a resume after a crash
 * must be able to re-render any page without the original upload. So this module
 * prepares the source *once per run* (locate the stored file; convert an Office
 * document to a working PDF; normalise a single image) and then renders and
 * reads the text layer of individual pages against that prepared source.
 *
 * It reuses the exact poppler/sharp helpers the v1 pipeline uses
 * (`renderPage`, `extractPageText`, `adaptiveRenderDpi`, `cropFigure`,
 * `normalizeImageToPage`), so a v2 page image is byte-for-byte what v1 would
 * have produced at the same DPI — which is the whole point of task 1.7 being a
 * *structural* port and not a quality change.
 *
 * Nothing here is stateful beyond the prepared source: it deliberately does not
 * accumulate pages, so the job runner's memory does not grow with the page
 * count.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import type { BoundingBox } from "@atf/extract-contract/v1";
import type { EmailHeaders, PageRecord } from "@atf/extract-contract/v2";
import { ExtractError, conversionFailed, unsupportedMediaType } from "../errors.js";
import { resolveFormat, type SupportedFormat } from "../formats.js";
import type { SourceStore } from "../source-store.js";
import { convertToPdf, isLibreOfficeKind, officeExtensionFor } from "../pipeline/office.js";
import {
  buildBpmnRecords,
  buildDocxHeadingHints,
  buildEmailRecords,
  buildMboxRecords,
  extractDocxEmbeddings,
  type EmbeddedSource,
  parseMsg,
  splitMbox,
  type EmailAttachment,
  buildXlsxRecords,
  parseVsdx,
  type ParsedVsdx,
  readXlsx,
  type DocxHeadingHints,
  assertZipWithinLimits,
  DEFAULT_ZIP_LIMITS,
  type ZipLimits,
} from "../pipeline/native/index.js";
import {
  extractDocumentText,
  extractPageText,
  readPageSize,
  readPdfInfo,
  renderPage,
  type PdfPageSize,
  type PopplerTools,
} from "../pipeline/pdf.js";
import {
  createDirectIsolatedRunner,
  type IsolatedRunner,
} from "../pipeline/isolate.js";
import type { RunOptions } from "../pipeline/exec.js";
import {
  adaptiveRenderDpi,
  cropFigure,
  imageSize,
  normalizeImageToPage,
  type FigureCrop,
} from "../pipeline/raster.js";

/** The poppler operations the renderer depends on, injected for tests. */
export interface PdfOps {
  readPdfInfo: typeof readPdfInfo;
  readPageSize: typeof readPageSize;
  renderPage: typeof renderPage;
  extractPageText: typeof extractPageText;
  extractDocumentText: typeof extractDocumentText;
  imageSize: typeof imageSize;
}

const defaultPdfOps: PdfOps = {
  readPdfInfo,
  readPageSize,
  renderPage,
  extractPageText,
  extractDocumentText,
  imageSize,
};

/** The plain text of a native page record (headings, paragraphs, list items, cells). */
function pageRecordText(record: PageRecord): string {
  const parts: string[] = [];
  for (const block of record.blocks) {
    if (block.type === "list") parts.push(block.items.join("\n"));
    else if (block.type === "table") {
      for (const row of [...block.headerRows, ...block.rows]) {
        parts.push(row.map((c) => (typeof c === "string" ? c : c.text)).join(" "));
      }
    } else if (block.type === "figure") parts.push(block.description);
    else parts.push(block.text);
  }
  return parts.join("\n");
}

/** A page image plus the geometry needed to resolve a normalised bbox. */
export interface PageImage {
  buffer: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/** The rendered page and its text layer, the inputs to the vision stage. */
export interface RenderedPageInput {
  image: PageImage;
  /** The embedded text layer, empty for a scanned page or an image source. */
  rawText: string;
  /** True when there was no text layer, so the page's text must come from OCR. */
  usedOcr: boolean;
  /**
   * The page's physical size in PostScript points. For a PDF page this is the
   * `pdfinfo` page box (or, when that probe fails, the pixel size at the actual
   * render DPI); for an image source it is the pixel size at the configured
   * render DPI. Optional so a stub renderer without it still works — the runner
   * then derives the size from the pixels and `dpi`.
   */
  sizePt?: { widthPt: number; heightPt: number };
  /**
   * The DPI the page image was actually rendered at. The adaptive render DPI
   * lowers it for large formats, so pixels ÷ configured DPI would understate an
   * A0 plan; this is the value to convert pixels back to points with.
   */
  dpi?: number;
}

/** Configuration slice the renderer needs. */
export interface PageRendererConfig {
  renderDpi: number;
  figureDpi: number;
  tempDir: string;
  libreofficeBin: string;
  popplerBinDir: string | null;
  /** Wall-clock ceiling on each poppler/LibreOffice invocation; 0 disables. */
  subprocessTimeoutMs: number;
  /**
   * ZIP-container ceilings enforced before any native reader inflates an
   * OOXML package (ZIP_MAX_*, requirement 5.1). Defaults to
   * {@link DEFAULT_ZIP_LIMITS} so a stub config stays valid.
   */
  zipLimits?: ZipLimits;
  /** MAX_EMBED_DEPTH — nesting ceiling for embedded `.msg` messages (requirement 5.4). */
  maxEmbedDepth?: number;
}

/** Either a PDF on disk or a single normalised image. */
type PageSource =
  | { kind: "pdf"; pdfPath: string }
  | { kind: "image"; image: PageImage };

/**
 * A prepared source, bound to one run. `render`/`renderFigureCrop` are the
 * per-page operations the job runner calls; `close` removes the scratch
 * directory. `pageCount` is known after preparation.
 */
/**
 * A natively-parsed source: contract records produced with no model call and,
 * for BPMN and a chart/image-free XLSX, no rendering either (design §10,
 * requirements 10.1–10.3). Present on a {@link PreparedSource} when the format
 * has a native path; the job runner emits `records` directly instead of driving
 * the vision loop, and uploads `nativeAssets` (the original `.bpmn` XML) as-is.
 */
export interface NativeSource {
  /** Contract page records, already built, in page order. */
  records: PageRecord[];
  /** `native:` asset bodies (the original source part) to upload verbatim. */
  nativeAssets: Array<{ assetId: string; localId: string; buffer: Uint8Array; mimeType: string }>;
  warnings: string[];
  /** E-mail only: the threading headers for `document.begin.email`. */
  email?: EmailHeaders;
  /** E-mail only: the subject, used as the document title. */
  title?: string;
  /** E-mail only: attachments, each ingested as a document of its own. */
  attachments?: EmailAttachment[];
  /** E-mail only: the quoted history removed from the text (kept when the parent is unknown). */
  quotedHistory?: string;
  /** Extra config every child job (attachment, mbox message) is created with. */
  childConfig?: Record<string, unknown>;
  /** The source's text for fingerprinting and version detection, when not the records'. */
  text?: string;
}

export interface PreparedSource {
  readonly pageCount: number;
  readonly format: SupportedFormat;
  /**
   * Native records when the source was parsed without a model (BPMN always; an
   * XLSX with no embedded chart/image). Null when the source is rendered and
   * driven through vision as usual.
   */
  readonly native: NativeSource | null;
  /**
   * DOCX heading-level hints from the styles (requirement 10.3), keyed by
   * normalised heading text. Null for a non-DOCX source or when the styles
   * could not be read. Consumed by the document pass to correct heading levels.
   */
  readonly docxHeadingHints: DocxHeadingHints | null;
  /**
   * Native Visio structure — shape texts and the connector graph, one
   * transcription per Visio page (requirement 10.4). Null for a non-VSDX
   * source or when the package could not be read.
   *
   * Unlike BPMN/XLSX, a VSDX is NOT native-only: the design keeps the
   * LibreOffice → PDF render for the page image "zusätzlich" (design §10.4), so
   * `native` above stays null and the source is rendered and driven through the
   * normal PDF path. This field carries the parsed shape/connector structure
   * alongside that render, so the document pass can attach the `process`/
   * `diagram` transcription to the rendered Visio page (its `pages[i]` aligns
   * with the rendered page order) instead of asking a vision model to re-derive
   * a graph we already read from the XML.
   */
  readonly vsdxStructure: ParsedVsdx | null;
  /**
   * Files a DOCX embeds (Visio, Excel, BPMN, PDF …), each ingested as a child
   * document with its native parser. Absent when there are none.
   */
  readonly embeddedSources?: readonly EmbeddedSource[];
  /**
   * The prepared PDF path, when the source is (or was converted to) a PDF.
   * `null` for a single-image source, which has no text layer. Exposed so the
   * deterministic S2 analyzer (task 2.1/2.3) can run `pdftotext -bbox-layout`
   * over the same prepared file the renderer uses.
   */
  readonly pdfPath: string | null;
  /** The scratch directory poppler tools should treat as `HOME`. */
  readonly home: string;
  /**
   * The text of pages `1..maxPages`, one string per page, without rendering:
   * the PDF text layer in one poppler call, or a native source's own text.
   * Null when the source has no text layer (a single image). Optional so a
   * test renderer without it still works — the job then skips the text
   * fingerprint and page-text version detection.
   */
  readText?(maxPages: number, signal?: AbortSignal): Promise<string[] | null>;
  /** Render page N and read its text layer. */
  render(page: number, signal?: AbortSignal): Promise<RenderedPageInput>;
  /**
   * Cut a figure crop for a page, re-rendering at `figureDpi` when that
   * improves on the model-resolution image. `pageImage` is the already-rendered
   * model-resolution page, reused as the fallback crop source.
   */
  renderFigureCrop(
    page: number,
    bbox: BoundingBox,
    pageImage: PageImage,
    signal?: AbortSignal,
  ): Promise<FigureCrop>;
  /** Remove the scratch directory. Call when the run ends. */
  close(): Promise<void>;
}

export interface PageRendererDeps {
  config: PageRendererConfig;
  sourceStore: SourceStore;
  logger: Logger;
  pdfOps?: PdfOps;
  /**
   * Runs the native parsers off the main thread (requirement 5.2). Defaults
   * to a direct in-process runner so a stub setup stays valid; the server
   * wires the Worker-backed one from PARSE_ISOLATED.
   */
  isolated?: IsolatedRunner;
}

/** The page-renderer surface: prepare a source, then render its pages. */
export interface PageRenderer {
  prepare(args: {
    sourceSha256: string;
    filename: string;
    /** Document reference, so native asset ids match the contract derivation. */
    reference?: string;
    signal?: AbortSignal;
  }): Promise<PreparedSource>;
}

/**
 * Create a page renderer that prepares sources from the store on demand.
 */
export function createPageRenderer(deps: PageRendererDeps): PageRenderer {
  const { config, sourceStore, logger } = deps;
  const pdfOps = deps.pdfOps ?? defaultPdfOps;
  const isolated = deps.isolated ?? createDirectIsolatedRunner();
  const zipLimits = config.zipLimits ?? DEFAULT_ZIP_LIMITS;

  function subprocessOptions(signal: AbortSignal | undefined): RunOptions {
    return {
      // Passed through as configured: a 0 is a deliberate disable, which the
      // production-readiness gate rejects (requirement 5.5).
      timeoutMs: config.subprocessTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  /**
   * A {@link PreparedSource} for a natively-parsed source (BPMN, or a
   * chart/image-free XLSX): the records are already built, there is nothing to
   * render, and the per-page operations are never called by the runner (it
   * emits `native.records` directly). `render`/`renderFigureCrop` throw if
   * invoked, which surfaces a wiring bug rather than silently returning nothing.
   */
  function nativeOnlyPrepared(
    format: SupportedFormat,
    native: NativeSource,
    docxHeadingHints: DocxHeadingHints | null,
  ): PreparedSource {
    return {
      pageCount: native.records.length,
      format,
      native,
      docxHeadingHints,
      vsdxStructure: null,
      pdfPath: null,
      home: "",
      async readText(maxPages) {
        if (native.text !== undefined) return [native.text];
        return native.records.slice(0, maxPages).map(pageRecordText);
      },
      async render() {
        throw new Error(`render() called on a native-only ${format.label} source`);
      },
      async renderFigureCrop() {
        throw new Error(`renderFigureCrop() called on a native-only ${format.label} source`);
      },
      async close() {
        /* nothing to clean up: no scratch directory was created */
      },
    };
  }

  async function prepare(args: {
    sourceSha256: string;
    filename: string;
    reference?: string;
    signal?: AbortSignal;
  }): Promise<PreparedSource> {
    const sourcePath = await sourceStore.locate(args.sourceSha256);
    if (sourcePath === null) {
      throw conversionFailed(
        "The job's source is not present in the source store",
        {
          sourceSha256: args.sourceSha256,
        },
      );
    }

    const buffer = await readFile(sourcePath);
    const resolved = resolveFormat({ buffer, filename: args.filename });
    if (!resolved.ok) {
      throw unsupportedMediaType(resolved.reason, { filename: args.filename });
    }
    const format = resolved.format;
    const reference = args.reference ?? args.sourceSha256;

    // ── E-mail: parse natively, no render, no model ───────────────────────
    if (format.kind === "email") {
      // An mbox export with several messages: an index page, and every
      // message a child document of its own.
      const isMsg = format.mimeType === "application/vnd.ms-outlook";
      const messages = isMsg
        ? [buffer]
        : await isolated.run({ kind: "mbox-split", buffer }, () =>
            splitMbox(buffer),
          );
      if (messages.length > 1) {
        const mbox = await isolated.run(
          { kind: "mbox-records", messages },
          () => buildMboxRecords(messages),
        );
        return nativeOnlyPrepared(
          format,
          {
            records: mbox.records,
            nativeAssets: [],
            warnings: mbox.warnings,
            attachments: mbox.attachments,
            text: mbox.text,
            childConfig: { mboxMessageIds: mbox.messageIds },
          },
          null,
        );
      }
      const built = await isolated.run(
        isMsg
          ? { kind: "email", buffer, msgMaxEmbedDepth: config.maxEmbedDepth }
          : { kind: "email", buffer },
        () =>
          isMsg
            ? buildEmailRecords(buffer, parseMsg(buffer, config.maxEmbedDepth))
            : buildEmailRecords(buffer),
      );
      return nativeOnlyPrepared(
        format,
        {
          records: built.records,
          nativeAssets: [],
          warnings: built.warnings,
          email: built.email,
          title: built.title,
          attachments: built.attachments,
          text: built.text,
          ...(built.quotedHistory !== undefined
            ? { quotedHistory: built.quotedHistory }
            : {}),
        },
        null,
      );
    }

    // ── BPMN: parse natively, no render, no model (requirement 10.1) ──────
    if (format.kind === "bpmn") {
      const native = await isolated.run(
        { kind: "bpmn", reference, buffer },
        () => buildBpmnRecords(reference, buffer),
      );
      return nativeOnlyPrepared(format, native, null);
    }

    // ── XLSX: read cells/merges/values natively; render only when the
    //    workbook embeds a chart or image (requirement 10.2) ───────────────
    if (
      format.mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const parsed = await isolated.run(
        { kind: "xlsx", buffer, limits: zipLimits },
        () => readXlsx(buffer, zipLimits),
      );
      if (!parsed.needsRender) {
        const built = buildXlsxRecords(reference, parsed);
        return nativeOnlyPrepared(
          format,
          {
            records: built.records,
            nativeAssets: [],
            warnings: built.warnings,
          },
          null,
        );
      }
      // A chart/image workbook still renders below; the native tables are not
      // used, but the render captures what the grid cannot.
      logger.info(
        { reference, renderReasons: parsed.renderReasons },
        "XLSX has embedded charts/images; rendering in addition to the grid",
      );
    }

    // ── DOCX: read authoritative heading levels from the styles; the render
    //    path is unchanged (requirement 10.3) ──────────────────────────────
    const isDocx =
      format.mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const docxHeadingHints: DocxHeadingHints | null = isDocx
      ? await isolated.run(
          { kind: "docx-headings", buffer, limits: zipLimits },
          () => buildDocxHeadingHints(buffer, zipLimits),
        )
      : null;
    // Embedded objects (Visio, Excel, BPMN …) become child documents with
    // their native parsers; the render only sees their preview picture.
    const embedded = isDocx
      ? await isolated.run(
          { kind: "docx-embeddings", buffer, limits: zipLimits },
          () => extractDocxEmbeddings(buffer, zipLimits),
        )
      : { sources: [], warnings: [] };
    if (embedded.warnings.length > 0) {
      logger.info(
        { reference, warnings: embedded.warnings },
        "DOCX embedded objects read with warnings",
      );
    }

    // ── VSDX: read shape texts and the connector graph natively, but STILL
    //    render via LibreOffice below for the page image (design §10.4,
    //    requirement 10.4 — "zusätzlich LibreOffice → PDF für das Bild"). The
    //    native structure rides alongside the render as `vsdxStructure`. ─────
    const vsdxStructure: ParsedVsdx | null =
      format.kind === "visio"
        ? await isolated.run({ kind: "vsdx", buffer, limits: zipLimits }, () =>
            parseVsdx(buffer, zipLimits),
          )
        : null;
    if (vsdxStructure !== null && vsdxStructure.warnings.length > 0) {
      logger.info(
        { reference, warnings: vsdxStructure.warnings },
        "VSDX native structure parsed with warnings; rendering continues",
      );
    }

    // ── PPTX: no native reader, so the ZIP guard (requirement 5.1) runs here,
    //    before the LibreOffice conversion inflates the package. XLSX, DOCX
    //    and VSDX are guarded inside their native readers above. ────────────
    if (format.kind === "presentation") {
      await isolated.run(
        { kind: "zip-guard", buffer, limits: zipLimits },
        () => {
          assertZipWithinLimits(buffer, zipLimits);
          return null;
        },
      );
    }

    const scratchRoot = config.tempDir || tmpdir();
    // TEMP_DIR is created at server start, but a cleaned /tmp or an embedder that never calls
    // startServer must not turn every render into an ENOENT 500.
    await mkdir(scratchRoot, { recursive: true });
    const workDir = await mkdtemp(join(scratchRoot, "job-"));
    const tools: PopplerTools = { binDir: config.popplerBinDir, home: workDir };

    let pageSource: PageSource;
    let pageCount: number;

    try {
      if (format.kind === "image") {
        const page = await normalizeImageToPage(buffer);
        pageSource = {
          kind: "image",
          image: {
            buffer: page.buffer,
            mimeType: page.mimeType,
            width: page.width,
            height: page.height,
          },
        };
        pageCount = 1;
      } else {
        let pdfPath: string;
        if (format.kind === "pdf") {
          pdfPath = join(workDir, "source.pdf");
          await writeFile(pdfPath, buffer);
        } else if (isLibreOfficeKind(format)) {
          // Word/Excel/PowerPoint/Visio → PDF via LibreOffice (design §10.4).
          pdfPath = await convertToPdf(
            { buffer, extension: officeExtensionFor(format) },
            {
              binary: config.libreofficeBin,
              workDir,
              ...subprocessOptions(args.signal),
            },
          );
        } else {
          throw unsupportedMediaType(`No render path for ${format.label}`, {
            filename: args.filename,
          });
        }
        const info = await pdfOps.readPdfInfo(
          pdfPath,
          tools,
          subprocessOptions(args.signal),
        );
        if (info.pageCount < 1) {
          throw conversionFailed("The document reports no pages", {
            filename: args.filename,
          });
        }
        pageSource = { kind: "pdf", pdfPath };
        pageCount = info.pageCount;
      }
    } catch (err) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    async function renderPdfPage(
      page: number,
      signal: AbortSignal | undefined,
    ): Promise<{
      image: PageImage;
      sizePt: { widthPt: number; heightPt: number };
      dpi: number;
    }> {
      if (pageSource.kind !== "pdf")
        throw new Error("renderPdfPage on a non-PDF source");
      const runOptions = subprocessOptions(signal);
      let pageSize: PdfPageSize | null = null;
      try {
        pageSize = await pdfOps.readPageSize(
          pageSource.pdfPath,
          page,
          tools,
          runOptions,
        );
      } catch {
        pageSize = null;
      }
      const dpi =
        pageSize !== null
          ? adaptiveRenderDpi(pageSize, config.renderDpi)
          : config.renderDpi;
      const rendered = await pdfOps.renderPage(
        pageSource.pdfPath,
        page,
        dpi,
        join(workDir, "render"),
        tools,
        runOptions,
      );
      const size = await pdfOps.imageSize(rendered.buffer);
      const image: PageImage = {
        buffer: rendered.buffer,
        mimeType: "image/png",
        width: size.width,
        height: size.height,
      };
      // The physical page size in points: pdfinfo's page box when known, else
      // the pixels converted back at the DPI actually used for this render.
      const sizePt =
        pageSize !== null && pageSize.widthPt > 0 && pageSize.heightPt > 0
          ? { widthPt: pageSize.widthPt, heightPt: pageSize.heightPt }
          : {
              widthPt: (size.width * 72) / dpi,
              heightPt: (size.height * 72) / dpi,
            };
      return { image, sizePt, dpi };
    }

    const prepared: PreparedSource = {
      pageCount,
      format,
      native: null,
      docxHeadingHints,
      vsdxStructure,
      ...(embedded.sources.length > 0
        ? { embeddedSources: embedded.sources }
        : {}),
      pdfPath: pageSource.kind === "pdf" ? pageSource.pdfPath : null,
      home: workDir,

      async readText(maxPages, signal) {
        if (pageSource.kind !== "pdf") return null;
        return pdfOps.extractDocumentText(
          pageSource.pdfPath,
          Math.min(maxPages, pageCount),
          tools,
          subprocessOptions(signal),
        );
      },

      async render(page, signal) {
        if (pageSource.kind === "image") {
          // A single-image source has no text layer; the model transcribes from
          // the pixels, which is reported as OCR.
          // An image has no physical size; its nominal size is the pixels at the
          // configured render DPI.
          const image = pageSource.image;
          return {
            image,
            rawText: "",
            usedOcr: true,
            sizePt: {
              widthPt: (image.width * 72) / config.renderDpi,
              heightPt: (image.height * 72) / config.renderDpi,
            },
            dpi: config.renderDpi,
          };
        }
        const { image, sizePt, dpi } = await renderPdfPage(page, signal);
        const rawText = await pdfOps.extractPageText(
          pageSource.pdfPath,
          page,
          tools,
          subprocessOptions(signal),
        );
        return { image, rawText, usedOcr: rawText.trim() === "", sizePt, dpi };
      },

      async renderFigureCrop(page, bbox, pageImage, signal) {
        let cropSource: PageImage = pageImage;
        if (pageSource.kind === "pdf" && config.figureDpi > config.renderDpi) {
          try {
            const rendered = await pdfOps.renderPage(
              pageSource.pdfPath,
              page,
              config.figureDpi,
              join(workDir, "figures"),
              tools,
              subprocessOptions(signal),
            );
            const size = await pdfOps.imageSize(rendered.buffer);
            cropSource = {
              buffer: rendered.buffer,
              mimeType: "image/png",
              width: size.width,
              height: size.height,
            };
          } catch (error) {
            logger.warn(
              { page, err: error },
              "Figure re-render failed; using the model-resolution page",
            );
          }
        }
        return cropFigure(cropSource.buffer, bbox, cropSource);
      },

      async close() {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      },
    };

    return prepared;
  }

  return { prepare };
}

/** Re-exported so callers do not reach into the pipeline layer directly. */
export { ExtractError };
export type { BoundingBox, FigureCrop };

