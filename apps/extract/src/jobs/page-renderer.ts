// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/page-renderer.ts
 *
 * On-demand page rendering from the content-addressed source store.
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
 *
 * The DERIVED PDF — the working copy of a PDF source, or the PDF a LibreOffice
 * conversion produces — IS cached across runs (Phase 11): a resume, a restart
 * at another stage, or a second `/v2/render` of the same document used to pay
 * the full copy/conversion again every time. The cache lives under
 * `TEMP_DIR/derived-pdf`, keyed by the source sha256 plus a conversion
 * identity (extension + LibreOffice version), and inherits the scratch
 * volume's lifecycle — with CONVERTER_MODE=isolated the sidecar mounts the
 * same volume at the same path, so cached paths stay valid across containers.
 * Page IMAGES are deliberately not cached: at render DPI they would be
 * gigabytes for a large document.
 */

import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import { boundingBoxToPixels, type BoundingBox } from "@atf/extract-contract/v1";
import type { EmailHeaders, PageRecord } from "@atf/extract-contract/v2";
import { ExtractError, conversionFailed, unsupportedMediaType } from "../errors.js";
import { resolveFormat, type SupportedFormat } from "../formats.js";
import {
  derivedPdfCacheDir,
  evictDerivedPdfs,
  touchDerivedPdf,
} from "./derived-pdf-cache.js";
import type { SourceStore } from "../source-store.js";
import {
  convertToPdf,
  HTML_SANITIZER_REVISION,
  isLibreOfficeKind,
  officeExtensionFor,
  probeLibreOfficeIdentity,
} from "../pipeline/office.js";
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
  readPageSizes,
  readPdfInfo,
  renderPage,
  renderPages,
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
  /**
   * Sizes of a page window in one `pdfinfo` call, and the window itself in one
   * `pdftoppm` call (see {@link PreparedSource.prefetch}). Optional: an
   * implementation without them simply renders page by page.
   */
  readPageSizes?: typeof readPageSizes;
  renderPage: typeof renderPage;
  renderPages?: typeof renderPages;
  extractPageText: typeof extractPageText;
  extractDocumentText: typeof extractDocumentText;
  imageSize: typeof imageSize;
}

/** How many pre-rendered pages (see `PreparedSource.prefetch`) a source holds at most. */
const PREFETCH_CACHE_PAGES = 16;
/** The shortest run of consecutive cold pages worth one window call. */
const MIN_PREFETCH_RUN = 4;
/** How many figure-resolution page renders are kept for the crops of a page. */
const FIGURE_PAGE_CACHE = 4;

const defaultPdfOps: PdfOps = {
  readPdfInfo,
  readPageSize,
  readPageSizes,
  renderPage,
  renderPages,
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
   * OOXML package (ZIP_MAX_*). Defaults to
   * {@link DEFAULT_ZIP_LIMITS} so a stub config stays valid.
   */
  zipLimits?: ZipLimits;
  /** MAX_EMBED_DEPTH — nesting ceiling for embedded `.msg` messages. */
  maxEmbedDepth?: number;
  /**
   * DERIVED_PDF_CACHE — reuse the derived PDF (a PDF source's working copy, or
   * a LibreOffice conversion's output) across runs, keyed by the source sha256
   * and the conversion identity, under `TEMP_DIR/derived-pdf`. Default true;
   * false restores the historical behaviour of re-deriving on every prepare.
   */
  derivedPdfCache?: boolean;
  /**
   * DERIVED_PDF_CACHE_MAX_MB — total size ceiling of the cache in bytes;
   * least recently used conversions go first. 0/undefined = unlimited.
   */
  derivedPdfCacheMaxBytes?: number;
  /**
   * DERIVED_PDF_CACHE_MAX_AGE_HOURS — time since last use, in milliseconds,
   * after which a conversion is dropped. 0/undefined = unlimited.
   */
  derivedPdfCacheMaxAgeMs?: number;
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
 * for BPMN and a chart/image-free XLSX, no rendering either. Present on a
 * {@link PreparedSource} when the format has a native path; the job runner
 * emits `records` directly instead of driving the vision loop, and uploads
 * `nativeAssets` (the original `.bpmn` XML) as-is.
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
   * DOCX heading-level hints from the styles, keyed by
   * normalised heading text. Null for a non-DOCX source or when the styles
   * could not be read. Consumed by the document pass to correct heading levels.
   */
  readonly docxHeadingHints: DocxHeadingHints | null;
  /**
   * Native Visio structure — shape texts and the connector graph, one
   * transcription per Visio page. Null for a non-VSDX
   * source or when the package could not be read.
   *
   * Unlike BPMN/XLSX, a VSDX is NOT native-only: the design keeps the
   * LibreOffice → PDF render for the page image "additionally", so
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
  /**
   * Warm the model-resolution render of a window of pages: ONE `pdfinfo` call
   * for their sizes and ONE `pdftoppm` call per run of consecutive pages that
   * share a DPI, instead of two subprocesses (each re-reading the PDF's
   * cross-reference table) per page. A later {@link render} of a warmed page
   * takes the image from here; a page that is not warmed, or whose warm-up
   * failed, renders on its own exactly as before. Never throws. A source with
   * no PDF behind it (an image, a native format) ignores the call. Optional so
   * a test renderer without it still works.
   */
  prefetch?(pages: readonly number[], signal?: AbortSignal): Promise<void>;
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
  /**
   * The page's physical size in points AS RENDERED (a `/Rotate 90` page is
   * reported portrait), without rasterising it. Falls back to one
   * model-resolution render when `pdfinfo` cannot say.
   */
  pageSizePt(
    page: number,
    signal?: AbortSignal,
  ): Promise<{ widthPt: number; heightPt: number }>;
  /**
   * Render a page, or only the `bbox` region of it, straight at `dpi` in ONE
   * poppler call (`/v2/render`): no model-resolution pass first, no second
   * render for the crop. `sizePt` is the result of {@link pageSizePt};
   * `maxPixels` bounds the fallback that renders the whole page. A source with
   * no physical resolution (a single image) cannot be enlarged: it returns its
   * own pixels and the nominal DPI. `dpi` of the result is the resolution the
   * pixels really have.
   */
  renderRegion(
    page: number,
    region: {
      bbox: BoundingBox | null;
      dpi: number;
      sizePt: { widthPt: number; heightPt: number };
      maxPixels: number;
    },
    signal?: AbortSignal,
  ): Promise<{ image: PageImage; dpi: number }>;
  /** Remove the scratch directory. Call when the run ends. */
  close(): Promise<void>;
}
export interface PageRendererDeps {
  config: PageRendererConfig;
  sourceStore: SourceStore;
  logger: Logger;
  pdfOps?: PdfOps;
  /**
   * Runs the native parsers off the main thread. Defaults
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
  /**
   * Enforce the derived-PDF cache limits now (age, then size), independent
   * of a conversion. The server runs it at start and on the retention
   * interval, so cached conversions also expire when no further Office
   * document arrives. Throttled like the sweep after a conversion; never
   * throws.
   */
  sweepDerivedPdfCache?(): Promise<void>;
}

/**
 * Cache files prepared sources are reading right now (path → holders), shared
 * by every renderer of the process: the server runs one renderer for jobs and
 * one for `/v2/render` over the same cache directory, and a sweep of either
 * must spare the files the other is reading.
 */
const pinnedCachePaths = new Map<string, number>();

/**
 * The cache file name for a derived PDF: the source content address plus a
 * digest of the conversion identity (the input extension and the LibreOffice
 * version string), so a different converter build never reuses an old result.
 */
function derivedPdfName(
  sourceSha256: string,
  extension: string,
  converterIdentity: string,
): string {
  // An HTML source is rewritten by the sanitizer before conversion, so the
  // PDF depends on the sanitizer's output too: a hardening change must not be
  // masked by a PDF built from the old, weaker rewrite.
  const sanitizer =
    extension === ".html" || extension === ".htm"
      ? `\u0000html-sanitizer-${HTML_SANITIZER_REVISION}`
      : "";
  const identity = createHash("sha256")
    .update(`${extension}\u0000${converterIdentity}${sanitizer}`)
    .digest("hex")
    .slice(0, 16);
  return `${sourceSha256}-${identity}.pdf`;
}

/** True when `path` is an existing regular file. */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** True when `path` lives under `root`. */
function pathUnder(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Create a page renderer that prepares sources from the store on demand.
 */
export function createPageRenderer(deps: PageRendererDeps): PageRenderer {
  const { config, sourceStore, logger } = deps;
  const pdfOps = deps.pdfOps ?? defaultPdfOps;
  const isolated = deps.isolated ?? createDirectIsolatedRunner();
  const zipLimits = config.zipLimits ?? DEFAULT_ZIP_LIMITS;
  const derivedPdfCacheEnabled = config.derivedPdfCache ?? true;
  const cacheLimits = {
    maxBytes: config.derivedPdfCacheMaxBytes ?? 0,
    maxAgeMs: config.derivedPdfCacheMaxAgeMs ?? 0,
  };

  // Pins go to the process-wide `pinnedCachePaths`: poppler re-opens the path
  // for every page, so a file in use must outlive the eviction sweeps until
  // `close()`.
  const pin = (path: string): void => {
    pinnedCachePaths.set(path, (pinnedCachePaths.get(path) ?? 0) + 1);
  };
  const unpin = (path: string): void => {
    const holders = (pinnedCachePaths.get(path) ?? 0) - 1;
    if (holders > 0) pinnedCachePaths.set(path, holders);
    else pinnedCachePaths.delete(path);
  };

  /** Throttle: at most one sweep per minute, plus one on first use. */
  const SWEEP_INTERVAL_MS = 60_000;
  let lastSweepAt = 0;
  let sweeping: Promise<void> | null = null;
  function sweepCache(scratchRoot: string): Promise<void> {
    if (cacheLimits.maxBytes <= 0 && cacheLimits.maxAgeMs <= 0) {
      return Promise.resolve();
    }
    if (sweeping !== null) return sweeping;
    const now = Date.now();
    if (lastSweepAt !== 0 && now - lastSweepAt < SWEEP_INTERVAL_MS) {
      return Promise.resolve();
    }
    lastSweepAt = now;
    sweeping = evictDerivedPdfs(derivedPdfCacheDir(scratchRoot), cacheLimits, {
      now,
      pinned: new Set(pinnedCachePaths.keys()),
    })
      .then((result) => {
        if (result.removedByAge + result.removedBySize > 0) {
          logger.info(
            { ...result, limits: cacheLimits },
            "Derived-PDF cache swept",
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "Derived-PDF cache sweep failed");
      })
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  }

  function subprocessOptions(signal: AbortSignal | undefined): RunOptions {
    return {
      // Passed through as configured: a 0 is a deliberate disable, which the
      // production-readiness gate rejects.
      timeoutMs: config.subprocessTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  /**
   * The LibreOffice build identity for the cache key, probed once per process
   * (`--version` through the configured transport, so it works in isolated
   * mode too). A conversion is only reused while the binary reports the same
   * version. Only a SUCCESSFUL probe is remembered: a transient failure
   * (sidecar not up yet, timeout) yields `null` for that call — the cache is
   * bypassed — instead of pinning an `unknown` identity for the rest of the
   * process, under which PDFs from different builds would share one key.
   */
  let libreofficeIdentityPromise: Promise<string> | null = null;
  async function libreofficeIdentity(
    scratchRoot: string,
  ): Promise<string | null> {
    if (libreofficeIdentityPromise !== null) {
      return libreofficeIdentityPromise;
    }
    const identity = await probeLibreOfficeIdentity(
      config.libreofficeBin,
      scratchRoot,
      subprocessOptions(undefined),
    );
    if (identity !== null) {
      libreofficeIdentityPromise = Promise.resolve(identity);
      return identity;
    }
    logger.warn(
      "LibreOffice version probe failed; derived-PDF cache bypassed for this conversion",
    );
    return null;
  }

  /**
   * Publish a fresh conversion atomically: `link` either creates the cache
   * entry whole or fails with EEXIST, so a concurrent prepare — or a crash
   * mid-conversion — can never expose a partial PDF.
   */
  async function publishDerivedPdf(
    convertedPath: string,
    cacheDir: string,
    cachePath: string,
  ): Promise<string> {
    try {
      await mkdir(cacheDir, { recursive: true });
      await link(convertedPath, cachePath);
      return cachePath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // A concurrent prepare won the race; its file is the valid one.
        await rm(convertedPath, { force: true }).catch(() => {});
        return cachePath;
      }
      logger.warn(
        { err, cachePath },
        "derived-PDF cache publish failed; continuing with the fresh conversion",
      );
      return convertedPath;
    }
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
        throw new Error(
          `render() called on a native-only ${format.label} source`,
        );
      },
      async renderFigureCrop() {
        throw new Error(
          `renderFigureCrop() called on a native-only ${format.label} source`,
        );
      },
      async pageSizePt() {
        throw new Error(
          `pageSizePt() called on a native-only ${format.label} source`,
        );
      },
      async renderRegion() {
        throw new Error(
          `renderRegion() called on a native-only ${format.label} source`,
        );
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

    // ── BPMN: parse natively, no render, no model ──────
    if (format.kind === "bpmn") {
      const native = await isolated.run(
        { kind: "bpmn", reference, buffer },
        () => buildBpmnRecords(reference, buffer),
      );
      return nativeOnlyPrepared(format, native, null);
    }

    // ── XLSX: read cells/merges/values natively; render only when the
    // workbook embeds a chart or image ───────────────
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
    // path is unchanged ──────────────────────────────
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
    // render via LibreOffice below for the page image ("additionally
    // LibreOffice → PDF for the image"). The native structure rides alongside
    // the render as `vsdxStructure`. ─────
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

    // ── PPTX: no native reader, so the ZIP guard runs here,
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
    /** The derived-PDF cache file this prepared source holds a pin on. */
    let pinnedHere: string | null = null;
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
          // The stored source is immutable and poppler only ever reads it, so
          // with the cache on it serves directly — no per-run copy — as long
          // as it sits under the scratch root, which is the one path the
          // converter sidecar is guaranteed to see at the same absolute
          // location (CONVERTER_MODE=isolated). Outside the scratch root, the
          // historical copy into the work directory keeps the file reachable.
          if (derivedPdfCacheEnabled && pathUnder(scratchRoot, sourcePath)) {
            pdfPath = sourcePath;
          } else {
            pdfPath = join(workDir, "source.pdf");
            await writeFile(pdfPath, buffer);
          }
        } else if (isLibreOfficeKind(format)) {
          // Word/Excel/PowerPoint/Visio → PDF via LibreOffice.
          // The conversion result is cached under TEMP_DIR/derived-pdf, keyed
          // by the source content address and the converter identity, so a
          // resume or a second render of the same document skips it (Phase 11).
          const extension = officeExtensionFor(format);
          const cacheDir = derivedPdfCacheDir(scratchRoot);
          // The cache is keyed by the converter build; with no readable
          // identity there is no safe key, so this conversion runs uncached.
          const identity = derivedPdfCacheEnabled
            ? await libreofficeIdentity(scratchRoot)
            : null;
          const cachePath =
            identity === null
              ? null
              : join(
                  cacheDir,
                  derivedPdfName(args.sourceSha256, extension, identity),
                );
          if (cachePath !== null && (await isRegularFile(cachePath))) {
            pdfPath = cachePath;
            // A hit is a use: refresh the last-use time the retention reads.
            await touchDerivedPdf(cachePath);
          } else {
            const converted = await convertToPdf(
              { buffer, extension },
              {
                binary: config.libreofficeBin,
                workDir,
                ...subprocessOptions(args.signal),
              },
            );
            pdfPath =
              cachePath !== null
                ? await publishDerivedPdf(converted, cacheDir, cachePath)
                : converted;
          }
          if (cachePath !== null && pdfPath === cachePath) {
            pin(cachePath);
            pinnedHere = cachePath;
            // Sweep AFTER pinning, so the file just produced is never the
            // victim of its own sweep.
            void sweepCache(scratchRoot);
          }
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
      if (pinnedHere !== null) {
        unpin(pinnedHere);
        pinnedHere = null;
      }
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    type PdfRender = {
      image: PageImage;
      sizePt: { widthPt: number; heightPt: number };
      dpi: number;
    };
    /** Pages rendered ahead by {@link PreparedSource.prefetch}, taken (once) by `render`. */
    const warm = new Map<number, PdfRender>();
    /** Pages a prefetch is working on right now; `render` waits for these. */
    const warming = new Map<number, Promise<void>>();
    /**
     * Page sizes a window's `pdfinfo` already read. `render` and `pageSizePt`
     * use them instead of spawning one `pdfinfo` per page; a few numbers per
     * page, bounded by the page count.
     */
    const knownSizes = new Map<number, PdfPageSize>();

    async function prefetchPages(
      pages: readonly number[],
      signal: AbortSignal | undefined,
    ): Promise<void> {
      if (pageSource.kind !== "pdf") return;
      const readSizes = pdfOps.readPageSizes;
      const renderWindow = pdfOps.renderPages;
      if (readSizes === undefined || renderWindow === undefined) return;
      const pdfPath = pageSource.pdfPath;
      const wanted = [...new Set(pages)]
        .filter(
          (p) =>
            Number.isInteger(p) &&
            p >= 1 &&
            p <= pageCount &&
            !warm.has(p) &&
            !warming.has(p),
        )
        .sort((a, b) => a - b);
      // Runs of consecutive pages. A short run gains little (the saving is the
      // per-page spawn and cross-reference read), and waiting until a few pages
      // are cold keeps the steady-state windows from degenerating into pairs.
      const runs: number[][] = [];
      for (const p of wanted) {
        const run = runs[runs.length - 1];
        if (run !== undefined && run[run.length - 1] === p - 1) run.push(p);
        else runs.push([p]);
      }
      const work = runs.filter((run) => run.length >= MIN_PREFETCH_RUN);
      if (work.length === 0) return;
      const runOptions = subprocessOptions(signal);
      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      for (const run of work) for (const p of run) warming.set(p, done);
      try {
        for (const run of work) {
          const first = run[0] ?? 0;
          const last = run[run.length - 1] ?? first;
          const sizes = await readSizes(pdfPath, first, last, tools, runOptions);
          for (const [p, size] of sizes) knownSizes.set(p, size);
          // One pdftoppm call per stretch of pages that render at the same DPI.
          // Oversized sheets get an adaptive, lower DPI, which bounds their
          // pixels, so a stretch of them is windowed at that DPI too; a single
          // sheet between pages of another DPI is rendered on its own by
          // `render`.
          const dpiOf = (p: number): number => {
            const size = sizes.get(p);
            return size !== undefined ? adaptiveRenderDpi(size, config.renderDpi) : config.renderDpi;
          };
          let start = 0;
          while (start < run.length) {
            const dpi = dpiOf(run[start] ?? 0);
            let end = start;
            while (end + 1 < run.length && dpiOf(run[end + 1] ?? 0) === dpi) end++;
            const from = run[start] ?? 0;
            const to = run[end] ?? from;
            if (to > from) {
              const rendered = await renderWindow(
                pdfPath,
                from,
                to,
                dpi,
                join(workDir, "window"),
                tools,
                runOptions,
              );
              for (const item of rendered) {
                const size = await pdfOps.imageSize(item.buffer);
                const pageSize = sizes.get(item.page);
                warm.set(item.page, {
                  image: {
                    buffer: item.buffer,
                    mimeType: "image/png",
                    width: size.width,
                    height: size.height,
                  },
                  sizePt:
                    pageSize !== undefined
                      ? { widthPt: pageSize.widthPt, heightPt: pageSize.heightPt }
                      : {
                          widthPt: (size.width * 72) / dpi,
                          heightPt: (size.height * 72) / dpi,
                        },
                  dpi,
                });
              }
            }
            start = end + 1;
          }
        }
      } catch (error) {
        if (signal?.aborted !== true) {
          logger.debug({ err: error }, "Page window pre-render failed; pages render on their own");
        }
      } finally {
        for (const run of work) for (const p of run) warming.delete(p);
        // Bound what an unconsumed warm-up (a page that turned out to be done,
        // a paused job) can hold.
        while (warm.size > PREFETCH_CACHE_PAGES) {
          const oldest = warm.keys().next().value;
          if (oldest === undefined) break;
          warm.delete(oldest);
        }
        settle();
      }
    }

    async function renderPdfPage(
      page: number,
      signal: AbortSignal | undefined,
    ): Promise<PdfRender> {
      if (pageSource.kind !== "pdf")
        throw new Error("renderPdfPage on a non-PDF source");
      const pending = warming.get(page);
      if (pending !== undefined) await pending;
      const ready = warm.get(page);
      if (ready !== undefined) {
        warm.delete(page);
        return ready;
      }
      const runOptions = subprocessOptions(signal);
      let pageSize: PdfPageSize | null = knownSizes.get(page) ?? null;
      if (pageSize === null) {
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

    /** Figure-resolution renders by page, most recently used last. Failures are not kept. */
    const figureRenders = new Map<number, Promise<PageImage | null>>();

    function figurePageRender(
      page: number,
      signal: AbortSignal | undefined,
    ): Promise<PageImage | null> {
      const cached = figureRenders.get(page);
      if (cached !== undefined) {
        figureRenders.delete(page);
        figureRenders.set(page, cached);
        return cached;
      }
      if (pageSource.kind !== "pdf") return Promise.resolve(null);
      const pdfPath = pageSource.pdfPath;
      const pending = (async (): Promise<PageImage | null> => {
        try {
          const rendered = await pdfOps.renderPage(
            pdfPath,
            page,
            config.figureDpi,
            join(workDir, "figures"),
            tools,
            subprocessOptions(signal),
          );
          const size = await pdfOps.imageSize(rendered.buffer);
          return {
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
          return null;
        }
      })();
      figureRenders.set(page, pending);
      void pending.then((image) => {
        if (image === null && figureRenders.get(page) === pending) figureRenders.delete(page);
      });
      while (figureRenders.size > FIGURE_PAGE_CACHE) {
        const oldest = figureRenders.keys().next().value;
        if (oldest === undefined) break;
        figureRenders.delete(oldest);
      }
      return pending;
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

      prefetch: (pages, signal) => prefetchPages(pages, signal),

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

      async pageSizePt(page, signal) {
        if (pageSource.kind === "image") {
          const image = pageSource.image;
          return {
            widthPt: (image.width * 72) / config.renderDpi,
            heightPt: (image.height * 72) / config.renderDpi,
          };
        }
        const size =
          knownSizes.get(page) ??
          (await pdfOps
            .readPageSize(pageSource.pdfPath, page, tools, subprocessOptions(signal))
            .catch(() => null));
        if (size !== null) return { widthPt: size.widthPt, heightPt: size.heightPt };
        return (await renderPdfPage(page, signal)).sizePt;
      },
      async renderRegion(page, region, signal) {
        if (pageSource.kind === "image") {
          const image = pageSource.image;
          const out =
            region.bbox === null ? image : await cropFigure(image.buffer, region.bbox, image);
          return { image: out, dpi: config.renderDpi };
        }
        const runOptions = subprocessOptions(signal);
        const dpi = Math.max(1, Math.floor(region.dpi));
        const read = async (
          rendered: { buffer: Uint8Array },
        ): Promise<PageImage> => {
          const size = await pdfOps.imageSize(rendered.buffer);
          return {
            buffer: rendered.buffer,
            mimeType: "image/png",
            width: size.width,
            height: size.height,
          };
        };
        if (region.bbox === null) {
          const whole = await pdfOps.renderPage(
            pageSource.pdfPath,
            page,
            dpi,
            join(workDir, "render"),
            tools,
            runOptions,
          );
          return { image: await read(whole), dpi };
        }
        // Only the region is rasterised, at the page's pixel grid for `dpi`
        // (poppler rounds the page size up to whole pixels).
        const pagePx = {
          width: Math.max(1, Math.ceil((region.sizePt.widthPt * dpi) / 72)),
          height: Math.max(1, Math.ceil((region.sizePt.heightPt * dpi) / 72)),
        };
        const pixels = boundingBoxToPixels(region.bbox, pagePx.width, pagePx.height);
        try {
          const cropped = await pdfOps.renderPage(
            pageSource.pdfPath,
            page,
            dpi,
            join(workDir, "regions"),
            tools,
            runOptions,
            pixels,
          );
          const image = await read(cropped);
          // A region that poppler clipped (the page is not the size we assumed:
          // an unusual box, a UserUnit) comes back smaller than asked for.
          if (
            Math.abs(image.width - pixels.width) <= 2 &&
            Math.abs(image.height - pixels.height) <= 2
          ) {
            return { image, dpi };
          }
          logger.warn(
            { page, requested: pixels, got: { width: image.width, height: image.height } },
            "Region render came back with an unexpected size; rendering the whole page instead",
          );
        } catch (error) {
          if (signal?.aborted === true) throw error;
          logger.warn(
            { page, err: error },
            "Region render failed; rendering the whole page instead",
          );
        }
        // Fallback: the whole page at the highest DPI that stays under the pixel
        // ceiling, then the crop — never an upscale.
        const areaIn2 = Math.max(
          (region.sizePt.widthPt / 72) * (region.sizePt.heightPt / 72),
          1e-9,
        );
        const safeDpi = Math.max(
          36,
          Math.min(dpi, Math.floor(Math.sqrt(region.maxPixels / areaIn2))),
        );
        const whole = await pdfOps.renderPage(
          pageSource.pdfPath,
          page,
          safeDpi,
          join(workDir, "render"),
          tools,
          runOptions,
        );
        const full = await read(whole);
        return { image: await cropFigure(full.buffer, region.bbox, full), dpi: safeDpi };
      },
      async renderFigureCrop(page, bbox, pageImage, signal) {
        let cropSource: PageImage = pageImage;
        if (pageSource.kind === "pdf" && config.figureDpi > config.renderDpi) {
          // The page is rasterised at figureDpi ONCE; every figure and tile
          // crop of it (and the crop re-cut at upload time) shares that render.
          const figureRender = await figurePageRender(page, signal);
          if (figureRender !== null) cropSource = figureRender;
        }
        return cropFigure(cropSource.buffer, bbox, cropSource);
      },

      async close() {
        if (pinnedHere !== null) {
          unpin(pinnedHere);
          pinnedHere = null;
        }
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      },
    };

    return prepared;
  }

  return {
    prepare,
    sweepDerivedPdfCache: () =>
      derivedPdfCacheEnabled ? sweepCache(config.tempDir || tmpdir()) : Promise.resolve(),
  };
}

/** Re-exported so callers do not reach into the pipeline layer directly. */
export { ExtractError };
export type { BoundingBox, FigureCrop };

