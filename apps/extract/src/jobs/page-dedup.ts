// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/page-dedup.ts
 *
 * Page deduplication by render hash — reuse an identical page's vision result
 * instead of calling the model again (design §5 S2; task 2.2, requirement 7.4).
 *
 * ## Why this exists
 *
 * Real documents repeat whole pages: a blank separator sheet between chapters,
 * a boilerplate legal page, the same "intentionally left blank" filler, a
 * repeated cover on a bound plan set. Each of those is byte-for-byte the same
 * rendered image, and paying for a vision call per copy is pure waste — on a
 * large scanned corpus it is a meaningful fraction of the bill (design §12:
 * page dedup is one of the levers that makes 10 000-page jobs affordable). If
 * two pages render identically, their vision result must be identical too, so
 * the second (and every later) copy can reuse the first's result with no model
 * call (requirement 7.4).
 *
 * ## The render hash
 *
 * {@link renderHash} is a SHA-256 over a *normalised* greyscale downscale of the
 * page image, not over the raw PNG bytes. Two reasons:
 *
 *   1. The raw encoded bytes can differ between renders of the identical page
 *      (PNG filter/zlib choices, metadata) even though the pixels are the same;
 *      hashing decoded, downscaled pixels is stable across those.
 *   2. Downscaling to a fixed grid makes the hash cheap and DPI-independent, so
 *      the same page rendered at an adapted DPI (a large page, see
 *      `adaptiveRenderDpi`) still collides with its twin.
 *
 * This deliberately errs toward *not* colliding: only genuinely identical
 * renders hash the same, so dedup never merges two pages that merely look
 * similar. A hash miss just means "run vision", which is always safe.
 *
 * ## How reuse is threaded through the runner
 *
 * The registry is a `renderHash → firstPage` map, small metadata that does not
 * grow with image size. When a page's render hash is already known, the runner
 * copies the first page's persisted `vision1` checkpoint into this page's
 * `vision1` stage (a checkpoint *reuse*, exactly like a resume) rather than
 * issuing a fresh model call. The dedup step is purely a decision about whether
 * to reuse; it computes no vision result of its own and stays deterministic.
 *
 * The registry itself is per-run in-memory state that a resume rebuilds cheaply
 * from the render stage as pages are re-walked; it is not persisted, because a
 * missed collision after a resume only costs one extra (correct) vision call.
 */

import { sha256Hex } from "@atf/extract-contract";
import sharp from "sharp";

/** The longer edge, in pixels, the page is downscaled to before hashing. */
const HASH_LONG_EDGE = 64;

/**
 * Compute a stable render hash for a page image: a SHA-256 over a normalised
 * greyscale downscale of the pixels (see the module header for why not the raw
 * bytes).
 *
 * Never throws: a decode failure returns `null`, and the caller then treats the
 * page as unique (runs vision), which is always safe.
 *
 * @param pngBuffer  The rendered page image (any sharp-decodable format).
 */
export async function renderHash(
  pngBuffer: Uint8Array,
  options: { longEdge?: number } = {},
): Promise<string | null> {
  const longEdge = options.longEdge ?? HASH_LONG_EDGE;
  try {
    const { data, info } = await sharp(pngBuffer, { limitInputPixels: false })
      .greyscale()
      .resize({
        width: longEdge,
        height: longEdge,
        fit: "inside",
        withoutEnlargement: false,
      })
      // A fixed background flattens any alpha so transparency does not perturb
      // the hash between two otherwise-identical pages.
      .flatten({ background: "#ffffff" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Prefix the dimensions so two different-shaped rasters can never collide
    // just because their downscaled pixel runs happen to agree.
    const header = `${info.width}x${info.height}x${info.channels}\n`;
    return sha256Hex(Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(data)]));
  } catch {
    return null;
  }
}

/** What the registry decides for a page. */
export type DedupDecision =
  | {
      /** First time this render hash was seen: run vision as normal. */
      kind: "unique";
    }
  | {
      /** An identical page was already processed: reuse its vision result. */
      kind: "duplicate";
      /** The page number whose vision result should be reused. */
      sourcePage: number;
    };

/**
 * A render-hash registry for one run. In-memory and bounded to one entry per
 * distinct render hash, so it never grows with image size — only with the count
 * of *distinct* pages.
 */
export interface DedupRegistry {
  /**
   * Register `page` under `hash` and decide whether it is a duplicate. The
   * first page to present a given hash is `unique` and becomes the source; every
   * later page with the same hash is a `duplicate` pointing at that source. A
   * `null` hash (unhashable image) is always `unique`.
   */
  register(page: number, hash: string | null): DedupDecision;
  /** The source page recorded for a hash, or `null` if unseen. */
  sourceFor(hash: string | null): number | null;
  /** Distinct render hashes seen so far (for metrics/tests). */
  size(): number;
}

/** Create an empty per-run dedup registry. */
export function createDedupRegistry(): DedupRegistry {
  const firstPageByHash = new Map<string, number>();

  return {
    register(page, hash) {
      if (hash === null) return { kind: "unique" };
      const existing = firstPageByHash.get(hash);
      if (existing === undefined) {
        firstPageByHash.set(hash, page);
        return { kind: "unique" };
      }
      if (existing === page) {
        // Re-registering the same page (a resume re-walk): still its own source.
        return { kind: "unique" };
      }
      return { kind: "duplicate", sourcePage: existing };
    },
    sourceFor(hash) {
      if (hash === null) return null;
      return firstPageByHash.get(hash) ?? null;
    },
    size() {
      return firstPageByHash.size;
    },
  };
}
