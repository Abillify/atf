// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-page helpers of the v2 job runner: parsed-row access, figure geometry and
 * refinement, and the page record that is emitted. Split out of `job-runner.ts` unchanged.
 */

import { buildAssetId, figureLocalId, pageLocalId, tileLocalId, } from "@atf/extract-contract";
import {
  isValidBoundingBox,
  type BoundingBox,
} from "@atf/extract-contract/v1";
import type {
  AssetRef,
  Block,
  BBox,
  PageRecord,
} from "@atf/extract-contract/v2";
import type {
  JobRow,
  PageStageRow,
} from "../persistence/types.js";
import type {
  ParsedVisionPage,
} from "../vision/response.js";
import {
  isStageOutput,
} from "./stage-runner.js";
import {
  parseMarkdownBlocks,
} from "../pipeline/markdown-blocks.js";
import type { PageAnalysis } from "../pipeline/bbox-layout.js";
import { snapFigureBBox } from "../pipeline/bbox-snap.js";
import type { PageImage } from "./page-renderer.js";
import type {
  VisionStageParsed,
} from "./job-runner.js";

export const TRUNCATION_WARNING =
  "Die Modellantwort war auch beim größten Token-Budget abgeschnitten; der Seiteninhalt ist unvollständig.";

/** Recorded on a page whose text came from the Tesseract fallback. */
export const OCR_FALLBACK_WARNING =
  "Das Vision-Modell war nicht erreichbar; der Text dieser Seite wurde stattdessen mit Tesseract-OCR erkannt und ist möglicherweise unvollständig.";

/** The parsed result of a checkpoint row, or undefined when it has none. */
export function parsedOfRow<T>(row: PageStageRow): T | undefined {
  const output = row.output;
  if (isStageOutput(output)) return (output.parsed ?? undefined) as T | undefined;
  return undefined;
}

/**
 * True when a checkpoint carries a raw model response a reparse can re-read:
 * a finished unit, or one that failed permanently after the model answered. A
 * unit in a transient backoff is left for its retry.
 */
export function reparseable(row: PageStageRow): boolean {
  if (!isStageOutput(row.output) || typeof row.output.raw !== "string") return false;
  return row.status === "done" || (row.status === "failed" && row.next_attempt_at === null);
}

/** A human-readable message from any thrown value. */
export function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ordinal `n` of a page-scoped figure id `p<page>-f<n>` (1 when unparsable). */
export function figureOrdinalOf(figureId: string): number {
  const match = /-f(\d+)$/.exec(figureId);
  const n = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** A figure has a usable, positive-area bbox. */
export function isCroppable(bbox: BoundingBox | undefined): bbox is BoundingBox {
  return bbox !== undefined && isValidBoundingBox(bbox);
}

/** The normalised area (0–1) of a bbox `[x1,y1,x2,y2]`. */
function bboxArea(bbox: BoundingBox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

/**
 * Decide whether a figure gets Pass 2. A figure
 * runs Pass 2 only when its kind is in `FIGURE_PASS2_KINDS`, it has a usable
 * bbox, and that bbox covers at least `minArea` of the page. The Pass-2 crop
 * uses the S4-snapped bbox when present, falling back to the raw
 * Pass-1 bbox. Returns the bbox to crop when Pass 2 should run.
 */
export function pass2Gate(
  figure: VisionStageParsed["figures"][number],
  kinds: ReadonlySet<string>,
  minArea: number,
): { run: false } | { run: true; bbox: BoundingBox } {
  const kind = figure.kind ?? "other";
  if (!kinds.has(kind)) return { run: false };
  const bbox = isCroppable(figure.snappedBbox)
    ? figure.snappedBbox
    : isCroppable(figure.bbox)
      ? figure.bbox
      : undefined;
  if (bbox === undefined) return { run: false };
  if (bboxArea(bbox) < minArea) return { run: false };
  return { run: true, bbox };
}

/** Convert a v1 (readonly) bbox to the v2 record's mutable tuple. */
function toBBox(bbox: BoundingBox): BBox {
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

/** The page-image asset id for a page. */
export function pageAssetId(reference: string, page: number): string {
  return buildAssetId(reference, pageLocalId(page));
}

/**
 * S4 deterministic refinement of the Pass-1 figures. For each figure with a
 * usable bbox, snap the box to the ink and the adjacent text blocks and
 * collect the text-layer words inside it as `regionText`/`labels`; a figure
 * without a box is passed through untouched.
 *
 * This is deliberately folded onto the `vision1` checkpoint rather than being a
 * separate `refined` stage. S4 is deterministic and its only inputs are the
 * rendered page image and this page's S2 analysis — both already in hand inside
 * the vision stage — so computing it here and persisting the result on the
 * checkpoint means a resume (or a render-hash reuse) replays the snapped bbox
 * and region text with no recompute, which a separate stage would only
 * duplicate. The concurrent scheduler drives whole pages, not per-stage fan-out
 * within a page, so a distinct S4 stage would add a checkpoint round-trip
 * without changing resume behaviour. `snapFigureBBox` never throws, so a page
 * is never failed over refinement.
 *
 * Returns the figures in input order with `snappedBbox`/`regionText`/`labels`
 * filled in where available.
 */
export async function refineFigures(
  figures: ParsedVisionPage["figures"],
  image: PageImage,
  analysis: PageAnalysis | null,
): Promise<VisionStageParsed["figures"]> {
  const refined: VisionStageParsed["figures"] = [];
  for (const f of figures) {
    const base = { id: f.id, description: f.description, kind: f.kind, caption: f.caption, bbox: f.bbox };
    if (!isCroppable(f.bbox)) {
      refined.push(base);
      continue;
    }
    const result = await snapFigureBBox(toBBox(f.bbox), {
      image: { buffer: image.buffer, width: image.width, height: image.height },
      analysis,
    });
    refined.push({
      ...base,
      snappedBbox: result.bbox as unknown as BoundingBox,
      ...(result.regionText !== undefined ? { regionText: result.regionText } : {}),
      ...(result.labels !== undefined ? { labels: result.labels } : {}),
    });
  }
  return refined;
}

/**
 * Build a contract-valid v2 page record from the parsed vision output.
 *
 * The Pass-1 body Markdown is mapped to typed blocks by the deterministic
 * {@link parseMarkdownBlocks} (headings with numbering, paragraphs, lists,
 * tables with cells and continuation flags, code); each figure block is placed
 * at its `![figure_<id>]` position in the reading order, and figures the body
 * never referenced follow at the end. A fast-path page emits its S2 blocks
 * verbatim. Because the mapping is a pure function of the persisted
 * checkpoint, a resume or a `reparse` rebuilds the identical record.
 */
export function buildPageRecord(
  reference: string,
  page: number,
  parsed: VisionStageParsed,
): PageRecord {
  const blocks: Block[] = [];
  const warnings = [...parsed.warnings];
  const assets: AssetRef[] = [];

  // ── figure blocks, keyed by figure id for placement in the flow ──────────
  const figureBlocks = new Map<string, Block>();
  const figureOrder: string[] = [];
  let figureOrdinal = 0;
  for (const figure of parsed.figures) {
    figureOrdinal += 1;
    const assetId = buildAssetId(reference, figureLocalId(figure.id));
    // Prefer the S4-snapped bbox for the emitted block and asset so
    // consumers see the refined region; fall back to the raw Pass-1 bbox, then
    // the full page.
    const resolvedBbox = isCroppable(figure.snappedBbox)
      ? figure.snappedBbox
      : isCroppable(figure.bbox)
        ? figure.bbox
        : ([0, 0, 1, 1] as BoundingBox);
    const bbox = toBBox(resolvedBbox);
    figureOrder.push(figure.id);
    figureBlocks.set(figure.id, {
      id: `p${page}-fb${figureOrdinal}`,
      page,
      type: "figure",
      figureId: figure.id,
      // The model-supplied kind; falls back to "other" for a
      // checkpoint written before this field existed.
      kind: figure.kind ?? "other",
      ...(figure.caption !== undefined ? { caption: figure.caption } : {}),
      description: figure.description,
      // The verbatim text-layer words inside the snapped bbox and their
      // deduplicated labels. Absent for a scan or a
      // container without `-bbox-layout` geometry.
      ...(figure.regionText !== undefined ? { regionText: figure.regionText } : {}),
      ...(figure.labels !== undefined && figure.labels.length > 0 ? { labels: figure.labels } : {}),
      // The structured Pass-2 transcription (task 2.5, S5). Present only for a
      // gated kind that ran Pass 2; `renderMarkdown` renders it per format.
      ...(figure.transcription !== undefined ? { transcription: figure.transcription } : {}),
      bbox,
      assetId,
    });
    assets.push({ assetId, kind: "figure", localId: figureLocalId(figure.id), page, bbox });
  }

  // ── body blocks in reading order ─────────────────────────────────────────
  if (parsed.fastPath === true && parsed.fastPathBlocks !== undefined) {
    // A fast-path page carries its blocks (heading/paragraph/list, all
    // source:"text-layer") built from the S2 geometry; no vision markdown.
    blocks.push(...parsed.fastPathBlocks);
  } else if (parsed.markdown.trim() !== "") {
    const body = parseMarkdownBlocks(parsed.markdown, {
      page,
      source: parsed.usedOcr ? "vision" : "text-layer",
    });
    for (const item of body.items) {
      if (item.kind === "block") {
        blocks.push(item.block);
        continue;
      }
      // A figure placeholder: the figure block goes exactly here.
      const figureBlock = figureBlocks.get(item.figureId);
      if (figureBlock !== undefined) {
        blocks.push(figureBlock);
        figureBlocks.delete(item.figureId);
      }
    }
    warnings.push(...body.warnings);
  }
  // Figures the body did not reference follow the text, in figure order.
  for (const id of figureOrder) {
    const figureBlock = figureBlocks.get(id);
    if (figureBlock !== undefined) blocks.push(figureBlock);
  }

  // ── tiling (S6): a page-spanning drawing figure with its tiles ───────────
  // A large-format page that was tiled emits one `technical_drawing` figure
  // covering the whole page. It carries the merged, overlap-deduplicated
  // transcription and the `tiles[]` refs; each tile is a `tile` asset
  // addressable by its own bbox for the research zoom. The tile bytes are not
  // stored — they reproduce on demand from the content-addressed source,
  // exactly like a figure crop.
  if (parsed.tiled !== undefined && parsed.tiled.tiles.length > 0) {
    figureOrdinal += 1;
    const wholePage = toBBox([0, 0, 1, 1] as BoundingBox);
    const figureId = `p${page}-tiled`;
    const figureAssetId = buildAssetId(reference, figureLocalId(figureId));
    blocks.push({
      id: `p${page}-fb${figureOrdinal}`,
      page,
      type: "figure",
      figureId,
      kind: "technical_drawing",
      description:
        "Großformatige Seite, in überlappende Kacheln zerlegt und zusammengeführt (S6).",
      transcription: parsed.tiled.transcription,
      tiles: parsed.tiled.tiles,
      bbox: wholePage,
      assetId: figureAssetId,
    });
    // The whole-page figure crop asset (the plan as one image).
    assets.push({
      assetId: figureAssetId,
      kind: "figure",
      localId: figureLocalId(figureId),
      page,
      bbox: wholePage,
    });
    // Each tile as its own addressable `tile` asset with its region bbox.
    for (const tile of parsed.tiled.tiles) {
      assets.push({
        assetId: tile.assetId,
        kind: "tile",
        localId: tileLocalId(tile.tileId),
        page,
        bbox: tile.bbox,
      });
    }
  }

  // The page image itself is always an addressable asset.
  assets.push({
    assetId: buildAssetId(reference, pageLocalId(page)),
    kind: "page",
    localId: pageLocalId(page),
    page,
  });

  return {
    type: "page",
    page,
    size: { wPt: parsed.size.wPt, hPt: parsed.size.hPt },
    // The deterministic page class. Falls back to
    // the v1 heuristic for a checkpoint written before this field existed.
    class: parsed.pageClass ?? (parsed.usedOcr ? "scan" : "text"),
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
    blocks,
    assets,
    warnings,
    // `fastPath` records that the page took the deterministic text fast-path
    // a consumer and the eval harness read it as the per-page
    // fast-path signal alongside the /metrics counter.
    fidelity: { ocr: parsed.usedOcr, ...(parsed.fastPath === true ? { fastPath: true } : {}) },
  };
}

/** A minimal valid page record, for the budget-pause path. */
export function emptyRecord(page: number): PageRecord {
  return {
    type: "page",
    page,
    size: { wPt: 1, hPt: 1 },
    class: "text",
    blocks: [],
    assets: [],
    warnings: [],
  };
}

/** The source filename, from the config snapshot when present, else the reference. */
export function filenameOf(job: JobRow): string {
  const source = (job.config as { source?: { filename?: unknown } }).source;
  if (source !== undefined && typeof source.filename === "string" && source.filename !== "") {
    return source.filename;
  }
  return job.reference;
}
