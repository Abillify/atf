// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * render-cache.ts
 *
 * The Search-side zoom / full-resolution render-and-cache capability (design
 * §9a.1, requirements 6.8, 14.4, 14.5).
 *
 * Search deliberately carries no poppler: rendering a page or a bbox region at
 * full resolution needs LibreOffice/poppler and a document-parser attack
 * surface, which belong in Extract, not on the query path (see
 * `handlers/ingest-file.ts` for the same reasoning). So when a research agent
 * zooms — asks for a `region` crop or a `full`-resolution page that was not
 * pre-stored — this module:
 *
 *   1. Looks the derived asset up in the {@link AssetStore} first. The store
 *      enforces the asset's revision tenant / collection / row ACL (14.5), so a
 *      cache hit is a pure, access-checked read and a caller who cannot see the
 *      document cannot warm or read its zoom.
 *   2. On a miss, calls Extract's `POST /v2/render` with the source sha256, the
 *      page and (for a region) the normalised bbox, PIXEL-LIMITED by Extract.
 *   3. Stores the returned PNG via `AssetStore.put` as a DERIVED asset — a new
 *      asset id keyed by `(base asset, region|full, target)` — so the next
 *      request for the same zoom is the pure read of step 1. Full-resolution
 *      page images are therefore never pre-stored (6.8); they materialise on
 *      first zoom and are cached from then on.
 *
 * ## What lives here vs. task 3.9
 *
 * This is the render+cache primitive. The MCP `get_asset(variant, region)` tool
 * (task 3.9) is the caller: it resolves the acting scope and the target asset,
 * then invokes {@link RenderCache.getOrRender} and streams the bytes. The HTTP
 * `GET /v2/assets/{id}` render-on-miss wiring, if added, calls the same
 * function. Keeping the capability here means both surfaces share one cache key,
 * one ACL path and one Extract client.
 */

import type { Logger } from "pino";
import type { ConverterConfig } from "./config.js";
import type { AccessScope } from "./access-scope.js";
import type { AssetKind, AssetScope, AssetStore } from "./asset-store.js";
import { injectTraceHeaders } from "./trace-context.js";

/** A normalised bbox `[x0,y0,x1,y1]` in `[0,1]`. */
export type RegionBox = readonly [number, number, number, number];

/** What a zoom asks Extract to render: a whole page (`full`) or a bbox crop. */
export interface RenderTarget {
  /**
   * sha256 of the document's source, addressed in Extract's source store. MUST
   * be resolved server-side from the ACL-checked asset's revision (never taken
   * from the caller) — see `get_asset` in handlers/mcp-nav.ts. Validated here as
   * lowercase 64-char hex.
   */
  sourceSha256: string;
  /** 1-based page number. */
  page: number;
  /** Normalised crop box; omitted / null renders the whole page (`full`). */
  bbox?: RegionBox | null;
  /** Desired long-edge pixel count; Extract clamps it to its own ceiling. */
  targetPixels?: number | null;
}

/** The document/asset identity the cached variant is bound to. */
export interface CacheBinding {
  assetScope: AssetScope;
  /** The base asset the zoom derives from (e.g. `page:p37`); the cache id extends it. */
  baseAssetId: string;
  documentReference: string;
  /** Revision the derived asset binds to, so it is reaped with the revision (14.3). */
  revisionId: string | null;
}

export interface RenderedAsset {
  assetId: string;
  mimeType: string;
  data: Buffer;
  width: number | null;
  height: number | null;
  /** True when this call rendered + cached; false when it was already cached. */
  rendered: boolean;
}

export interface RenderCacheError {
  status: number;
  code: string;
  message: string;
}

export type RenderCacheResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: RenderCacheError };

export interface RenderCache {
  /**
   * Return the cached zoom, or render it via Extract and cache it, enforcing the
   * asset's revision row ACL on both the read and the store (14.5). A caller who
   * cannot see the document gets a 404-shaped miss, never a rendered image.
   */
  getOrRender(
    binding: CacheBinding,
    target: RenderTarget,
    scope: AccessScope,
  ): Promise<RenderCacheResult<RenderedAsset>>;
  /** The cache asset id a given zoom maps to (exposed for tests / task 3.9). */
  cacheAssetId(baseAssetId: string, target: RenderTarget): string;
}

export interface RenderCacheDeps {
  converter: ConverterConfig;
  assetStore: AssetStore;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function ok<T>(result: T): RenderCacheResult<T> {
  return { ok: true, result };
}
function fail<T>(error: RenderCacheError): RenderCacheResult<T> {
  return { ok: false, error };
}

/** Round a normalised coordinate to a stable key fragment (avoids float drift). */
function coord(n: number): string {
  return n.toFixed(4);
}

/** Lowercase hex sha256, as addressed by Extract's content-addressed source store. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Hex chars of the source digest carried in the cache key (64 bits: collision-safe per base asset). */
const SOURCE_KEY_CHARS = 16;

/**
 * The cache key for a zoom, appended to the base asset id.
 *
 *   full render          → `<base>@s<src16>:full[.p<target>]`
 *   region crop          → `<base>@s<src16>:region:<x0>,<y0>,<x1>,<y1>[.p<target>]`
 *
 * The bbox (rounded to 4 decimals), the target pixel count AND a prefix of the
 * source digest are all in the key, so two zooms that differ only in region or
 * resolution never collide, and a re-ingested document whose base asset id is
 * reused (e.g. `page:p37`) never serves a crop rendered from the previous
 * source. A re-request for the identical zoom resolves to the same cached asset
 * (the deterministic-render property is what makes that safe — the same key
 * always denotes the same bytes).
 */
export function cacheAssetIdFor(baseAssetId: string, target: RenderTarget): string {
  const region =
    target.bbox === undefined || target.bbox === null
      ? "full"
      : `region:${target.bbox.map(coord).join(",")}`;
  const suffix =
    target.targetPixels !== undefined && target.targetPixels !== null
      ? `.p${target.targetPixels}`
      : "";
  const source = target.sourceSha256.toLowerCase().slice(0, SOURCE_KEY_CHARS);
  return `${baseAssetId}@s${source}:${region}${suffix}`;
}

export function createRenderCache(deps: RenderCacheDeps): RenderCache {
  const { converter, assetStore, logger } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  function extractHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      ...extra,
      ...(converter.token !== null ? { authorization: `Bearer ${converter.token}` } : {}),
    };
    injectTraceHeaders(headers);
    return headers;
  }

  /** Call Extract's POST /v2/render, returning the PNG bytes and its pixel size. */
  async function renderViaExtract(
    target: RenderTarget,
  ): Promise<RenderCacheResult<{ data: Buffer; width: number | null; height: number | null }>> {
    const controller = new AbortController();
    const timeout =
      converter.timeoutMs > 0 ? setTimeout(() => controller.abort(), converter.timeoutMs) : null;
    try {
      const body: Record<string, unknown> = {
        source: target.sourceSha256,
        page: target.page,
        ...(target.bbox !== undefined && target.bbox !== null ? { bbox: target.bbox } : {}),
        ...(target.targetPixels !== undefined && target.targetPixels !== null
          ? { targetPixels: target.targetPixels }
          : {}),
      };
      let response: Response;
      try {
        response = await doFetch(`${converter.url}/v2/render`, {
          method: "POST",
          headers: extractHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        return fail({
          status: aborted ? 504 : 502,
          code: aborted ? "RENDER_TIMEOUT" : "RENDER_UNREACHABLE",
          message: aborted
            ? `Extract did not render within ${converter.timeoutMs} ms`
            : `Extract could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!response.ok) {
        // A 404 from Extract means the source is not stored; surface it as a
        // miss rather than a server error so the caller can 404 the zoom.
        const detail = await response.text().catch(() => "");
        return fail({
          status: response.status === 404 ? 404 : response.status >= 500 ? 502 : response.status,
          code: response.status === 404 ? "SOURCE_NOT_FOUND" : "RENDER_FAILED",
          message: `Extract render failed (HTTP ${response.status}): ${detail.slice(0, 200)}`,
        });
      }
      const arrayBuffer = await response.arrayBuffer();
      const data = Buffer.from(arrayBuffer);
      const widthHeader = response.headers.get("x-render-width");
      const heightHeader = response.headers.get("x-render-height");
      return ok({
        data,
        width: widthHeader ? Number(widthHeader) : null,
        height: heightHeader ? Number(heightHeader) : null,
      });
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  return {
    cacheAssetId: cacheAssetIdFor,

    async getOrRender(binding, target, scope): Promise<RenderCacheResult<RenderedAsset>> {
      // Fail closed on a malformed source digest before any read or render.
      if (!SHA256_HEX.test(target.sourceSha256)) {
        return fail({
          status: 400,
          code: "INVALID_SOURCE_SHA256",
          message: "sourceSha256 must be a lowercase 64-character hex sha256",
        });
      }
      const assetId = cacheAssetIdFor(binding.baseAssetId, target);

      // 1. Cache read — ACL enforced by the store (14.5). A hit is a pure read.
      const cached = await assetStore.get(binding.assetScope, assetId, "full", scope);
      if (!cached.ok) {
        return fail({
          status: cached.error.status,
          code: cached.error.code,
          message: cached.error.message,
        });
      }
      if (cached.result !== null) {
        return ok({
          assetId,
          mimeType: cached.result.mimeType,
          data: cached.result.data,
          width: cached.result.width,
          height: cached.result.height,
          rendered: false,
        });
      }

      // 2. Miss — render on demand from the source via Extract (6.8, 14.4).
      const rendered = await renderViaExtract(target);
      if (!rendered.ok) return fail(rendered.error);

      // 3. Cache the result as a derived asset. A region crop is a `tile`; a
      //    full page is a `page`. The store also generates thumb/preview so a
      //    later low-res request is served without another render.
      const kind: AssetKind =
        target.bbox !== undefined && target.bbox !== null ? "tile" : "page";
      const put = await assetStore.put(
        {
          tenantId: binding.assetScope.tenantId,
          collection: binding.assetScope.collection,
          assetId,
          kind,
          documentReference: binding.documentReference,
          revisionId: binding.revisionId,
          figureId: null,
          page: target.page,
          bbox:
            target.bbox !== undefined && target.bbox !== null
              ? [target.bbox[0], target.bbox[1], target.bbox[2], target.bbox[3]]
              : null,
          mimeType: "image/png",
          data: rendered.result.data,
        },
        scope,
      );
      if (!put.ok) {
        // The render succeeded but caching failed. Return the bytes anyway —
        // the zoom is answerable this once — but log so a persistent cache
        // failure is visible rather than a silent per-request re-render.
        logger.warn(
          { assetId, error: put.error, page: target.page },
          "Rendered a zoom but could not cache it; serving uncached bytes",
        );
        return ok({
          assetId,
          mimeType: "image/png",
          data: rendered.result.data,
          width: rendered.result.width,
          height: rendered.result.height,
          rendered: true,
        });
      }

      logger.debug(
        { assetId, kind, page: target.page, hasBbox: kind === "tile" },
        "Rendered a zoom via Extract and cached it as an asset variant",
      );
      return ok({
        assetId,
        mimeType: "image/png",
        data: rendered.result.data,
        width: rendered.result.width,
        height: rendered.result.height,
        rendered: true,
      });
    },
  };
}
