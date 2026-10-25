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

import { mkdir, readFile, readdir, rm } from "node:fs/promises";
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
    const { stdout } = await run(
      binary(tools, "pdfinfo"),
      [pdfPath],
      tools.home,
      options,
    );
    const pages = /^Pages:\s+(\d+)/m.exec(stdout);
    const size = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
    const encrypted = /^Encrypted:\s+yes/im.test(stdout);
    const pageCount =
      pages?.[1] !== undefined ? Number.parseInt(pages[1], 10) : 0;
    if (pageCount > 0) {
      const widthRaw = size?.[1];
      const heightRaw = size?.[2];
      return {
        pageCount,
        pageSize:
          widthRaw !== undefined && heightRaw !== undefined
            ? {
                widthPt: Number.parseFloat(widthRaw),
                heightPt: Number.parseFloat(heightRaw),
              }
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

/**
 * Read the size of one specific page.
 *
 * `pdfinfo -f N -l N` reports the size of the requested page range rather than
 * only the first page of the document. A single document can mix page sizes —
 * an A4 report with a folded-out A0 plan is the case that matters here — so the
 * DPI has to be chosen per page from the page's own size, not from a
 * document-level hint. Returns null when the size cannot be parsed, so the
 * caller falls back to its preferred DPI rather than failing the page.
 *
 * The size is the page AS RENDERED: `pdfinfo` prints the unrotated box next to
 * a separate `rot:` line, so a page with `/Rotate 90|270` has its width and
 * height swapped here. Without that, pixel coordinates derived from this size
 * (a region render, a tile grid) would address a transposed page.
 */
export async function readPageSize(
  pdfPath: string,
  page: number,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<PdfPageSize | null> {
  try {
    const { stdout } = await run(
      binary(tools, "pdfinfo"),
      ["-f", String(page), "-l", String(page), pdfPath],
      tools.home,
      options,
    );
    // With a page range, poppler prints `Page  N size: W x H pts`; a
    // single-page document keeps the document-level `Page size:` line.
    const size =
      /^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout) ??
      /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
    const widthRaw = size?.[1];
    const heightRaw = size?.[2];
    if (widthRaw === undefined || heightRaw === undefined) return null;
    const widthPt = Number.parseFloat(widthRaw);
    const heightPt = Number.parseFloat(heightRaw);
    if (!(widthPt > 0) || !(heightPt > 0)) return null;
    const rotation =
      /^Page\s+\d+\s+rot:\s+(\d+)/m.exec(stdout) ?? /^Page rot:\s+(\d+)/m.exec(stdout);
    const quarterTurns = Math.round((Number.parseInt(rotation?.[1] ?? "0", 10) % 360) / 90);
    return quarterTurns % 2 === 1
      ? { widthPt: heightPt, heightPt: widthPt }
      : { widthPt, heightPt };
  } catch {
    return null;
  }
}

/**
 * Read the sizes of pages `first..last` in ONE `pdfinfo` call (the per-page
 * {@link readPageSize} spawns a process, and re-reads the cross-reference table,
 * for every page). Same semantics per page: the size AS RENDERED, with
 * `/Rotate 90|270` swapping width and height. A page whose size cannot be
 * parsed is absent from the map, so the caller falls back to its preferred DPI.
 * The whole call failing yields an empty map.
 */
export async function readPageSizes(
  pdfPath: string,
  first: number,
  last: number,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<Map<number, PdfPageSize>> {
  const sizes = new Map<number, PdfPageSize>();
  try {
    const { stdout } = await run(
      binary(tools, "pdfinfo"),
      ["-f", String(first), "-l", String(last), pdfPath],
      tools.home,
      options,
    );
    const rotations = new Map<number, number>();
    for (const match of stdout.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) {
      rotations.set(Number.parseInt(match[1] ?? "0", 10), Number.parseInt(match[2] ?? "0", 10));
    }
    const record = (page: number, widthRaw: string | undefined, heightRaw: string | undefined, rot: number): void => {
      if (widthRaw === undefined || heightRaw === undefined) return;
      const widthPt = Number.parseFloat(widthRaw);
      const heightPt = Number.parseFloat(heightRaw);
      if (!(widthPt > 0) || !(heightPt > 0)) return;
      const quarterTurns = Math.round((rot % 360) / 90);
      sizes.set(page, quarterTurns % 2 === 1 ? { widthPt: heightPt, heightPt: widthPt } : { widthPt, heightPt });
    };
    for (const match of stdout.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
      const page = Number.parseInt(match[1] ?? "0", 10);
      record(page, match[2], match[3], rotations.get(page) ?? 0);
    }
    if (sizes.size === 0 && first === last) {
      // A single-page document keeps the document-level lines.
      const size = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
      const rot = /^Page rot:\s+(\d+)/m.exec(stdout);
      record(first, size?.[1], size?.[2], Number.parseInt(rot?.[1] ?? "0", 10));
    }
  } catch {
    sizes.clear();
  }
  return sizes;
}

/**
 * Rasterise pages `first..last` at one DPI in ONE `pdftoppm` call.
 *
 * {@link renderPage} avoids guessing poppler's output names with
 * `-singlefile`; that flag cannot be used for a range, where pdftoppm writes
 * `<prefix>-<page>.png` with the page number zero-padded to the width of the
 * document's page count. The names are therefore not predicted but READ: every
 * file the call left under its own unique prefix is matched by the trailing
 * number. Each file is removed after it is read, so a window never leaves more
 * than the call's output on disk. A page the call produced no image for is
 * simply absent from the result.
 */
export async function renderPages(
  pdfPath: string,
  first: number,
  last: number,
  dpi: number,
  workDir: string,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<RenderedPage[]> {
  await mkdir(workDir, { recursive: true });
  const tag = `win-${first}-${last}-${dpi}`;
  const prefix = join(workDir, tag);
  await run(
    binary(tools, "pdftoppm"),
    ["-png", "-r", String(dpi), "-f", String(first), "-l", String(last), pdfPath, prefix],
    tools.home,
    options,
  );
  const pattern = new RegExp(`^${tag}-(\\d+)\\.png$`);
  const rendered: RenderedPage[] = [];
  for (const name of await readdir(workDir)) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const page = Number.parseInt(match[1] ?? "0", 10);
    const path = join(workDir, name);
    try {
      const buffer = await readFile(path);
      if (buffer.length > 0 && page >= first && page <= last) rendered.push({ buffer, page, dpi });
    } finally {
      await rm(path, { force: true });
    }
  }
  return rendered.sort((a, b) => a.page - b.page);
}

/**
 * The minimum poppler version that supports `pdftotext -bbox-layout`.
 *
 * `-bbox` arrived in poppler 0.20 and the layout-preserving `-bbox-layout`
 * variant in 0.42 (2016). Every currently supported distribution ships far
 * newer poppler, so this is documentation of the hard requirement more than a
 * gate an operator will realistically trip — but a container built on a stale
 * base image would otherwise fail the analyzed (S2) stage with an opaque
 * "unknown option" from pdftotext, which this turns into a legible capability
 * report at startup.
 */
export const MIN_POPPLER_BBOX_LAYOUT = { major: 0, minor: 42 } as const;

/** The outcome of probing poppler for `-bbox-layout` support. */
export interface BboxLayoutCapability {
  /** True when pdftotext is present and new enough for `-bbox-layout`. */
  supported: boolean;
  /** The parsed poppler version banner, when it could be read. */
  version: string | null;
  /** A human-readable reason when `supported` is false. */
  reason?: string;
}

/** Parse `pdftotext version 24.02.0` (or `0.42.0`) into major/minor numbers. */
export function parsePopplerVersion(
  banner: string,
): { major: number; minor: number } | null {
  const match = /version\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(banner);
  if (match === null) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor };
}

/** True when `version` is at least `min` by (major, minor). */
function versionAtLeast(
  version: { major: number; minor: number },
  min: { major: number; minor: number },
): boolean {
  if (version.major !== min.major) return version.major > min.major;
  return version.minor >= min.minor;
}

/**
 * Probe whether the image's `pdftotext` supports `-bbox-layout`, the flag the
 * deterministic page analysis depends on.
 *
 * `pdftotext -v` prints its version banner on stderr; we parse it and compare
 * against {@link MIN_POPPLER_BBOX_LAYOUT}. A v1-only deployment that never runs
 * the analyzed stage does not need this — so the probe is *reported*, not
 * fatal: the caller surfaces it in `/health` and a startup log, and only the S2
 * stage treats a missing capability as a per-page fall-through to vision.
 */
export async function probeBboxLayout(
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<BboxLayoutCapability> {
  let banner: string;
  try {
    const { stdout, stderr } = await run(
      binary(tools, "pdftotext"),
      ["-v"],
      tools.home,
      { timeoutMs: 10_000, ...options },
    );
    banner = (stderr.trim() || stdout.trim()).split("\n")[0]?.trim() ?? "";
  } catch (error) {
    return {
      supported: false,
      version: null,
      reason: `pdftotext is not runnable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const version = parsePopplerVersion(banner);
  if (version === null) {
    // The binary ran but the banner was unrecognisable. Assume support rather
    // than block a working deployment on a version-string quirk; the S2 stage's
    // own per-page fall-through still covers a genuinely missing flag.
    return { supported: true, version: banner === "" ? null : banner };
  }
  const supported = versionAtLeast(version, MIN_POPPLER_BBOX_LAYOUT);
  return {
    supported,
    version: banner,
    ...(supported
      ? {}
      : {
          reason: `poppler ${version.major}.${version.minor} is older than the ${MIN_POPPLER_BBOX_LAYOUT.major}.${MIN_POPPLER_BBOX_LAYOUT.minor} required for pdftotext -bbox-layout`,
        }),
  };
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

/**
 * Extract the text layer of pages `1..lastPage` in ONE `pdftotext` call, one
 * string per page (split on the form feed pdftotext ends each page with).
 *
 * Reading order rather than `-layout`: this text feeds the duplicate
 * fingerprint and the version detection, which need the words in order, not
 * their columns. A page without a text layer yields an empty string.
 */
export async function extractDocumentText(
  pdfPath: string,
  lastPage: number,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<string[]> {
  const { stdout } = await run(
    binary(tools, "pdftotext"),
    ["-f", "1", "-l", String(Math.max(1, lastPage)), "-enc", "UTF-8", pdfPath, "-"],
    tools.home,
    options,
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what must go
  const pages = stdout.replace(/\u0000/g, "").split("\f");
  // The output ends with a form feed, which leaves one empty trailing entry.
  if (pages.length > lastPage) pages.length = lastPage;
  return pages.map((page) => page.trimEnd());
}

/**
 * Extract the page geometry of one page via `pdftotext -bbox-layout`.
 *
 * Where {@link extractPageText} gives the *wording* of a page (a linearised
 * string), `-bbox-layout` gives the *geometry*: an XHTML document with a
 * `<word>` per word carrying `xMin/yMin/xMax/yMax` in page-pixel space, grouped
 * into `<line>` and `<block>`. This is the raw signal the deterministic page
 * analysis turns into normalised blocks/lines/words — parsing
 * lives in `pipeline/bbox-layout.ts`, which is a pure function of the string
 * returned here, so it is testable without poppler.
 *
 * An empty text layer (a scan) produces a `<page>` with no `<word>`, which is a
 * legitimate outcome, not an error. NUL bytes are stripped for the same reason
 * as in {@link extractPageText}: PostgreSQL rejects them and a damaged PDF can
 * leak them into the markup.
 */
export async function extractPageBboxLayout(
  pdfPath: string,
  page: number,
  tools: PopplerTools,
  options: RunOptions = {},
): Promise<string> {
  const { stdout } = await run(
    binary(tools, "pdftotext"),
    ["-bbox-layout", "-f", String(page), "-l", String(page), pdfPath, "-"],
    tools.home,
    options,
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL bytes must go
  return stdout.replace(/\u0000/g, "");
}

/** A pixel rectangle of the page at the render DPI (`pdftoppm -x -y -W -H`). */
export interface RenderRegion {
  left: number;
  top: number;
  width: number;
  height: number;
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
  region?: RenderRegion,
): Promise<RenderedPage> {
  await mkdir(workDir, { recursive: true });
  // The region is part of the name, so two crops of one page never share a file.
  const regionTag =
    region === undefined ? "" : `-${region.left}x${region.top}-${region.width}x${region.height}`;
  const prefix = join(workDir, `page-${page}-${dpi}${regionTag}`);
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
      // Only the region is rasterised: a small crop at a high DPI never
      // allocates the whole page at that DPI.
      ...(region === undefined
        ? []
        : [
            "-x",
            String(region.left),
            "-y",
            String(region.top),
            "-W",
            String(region.width),
            "-H",
            String(region.height),
          ]),
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
      throw conversionFailed(
        `pdftoppm produced an empty image for page ${page}`,
        { page },
      );
    }
    return { buffer, page, dpi };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw conversionFailed(`pdftoppm produced no image for page ${page}`, {
        page,
        dpi,
      });
    }
    throw error;
  }
}
