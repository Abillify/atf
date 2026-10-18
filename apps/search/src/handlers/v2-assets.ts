// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/v2-assets.ts
 *
 * The v2 asset API (design §6.5, task 1.11). Routes are mounted behind the same
 * auth / scope / tenant / collection-ACL chain as the /ingest routes, so by the
 * time a handler runs the request already carries a
 * verified AccessScope (with a tenant) and a checked collection ACL. Each
 * handler defers storage semantics and the revision row-ACL read check to the
 * AssetStore.
 *
 *   PUT  /v2/assets/{assetId}   store an asset variant `full`, idempotent on the
 *                               checksum; generates thumb/preview (Req 5.8, 14.1).
 *                               The revision (X-Revision-Id and/or ?revision=)
 *                               must exist in the tenant + collection, belong
 *                               to X-Document-Reference and not be aborted.
 *   HEAD /v2/assets/{assetId}   existence of a variant (Req 5.8)
 *   GET  /v2/assets/{assetId}?variant=  read a variant, ACL-checked (Req 14.5)
 */

import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import type { AssetKind, AssetScope, AssetStore } from "../asset-store.js";
import { isAssetVariant, type AssetVariant } from "../asset-variants.js";
import { readHeader } from "../header-utils.js";

/** Bytes accepted for a v2 asset upload (matches the v1 asset MIME set). */
export const MAX_V2_ASSET_BYTES = 20 * 1024 * 1024;
export const V2_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const ASSET_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  "figure",
  "page",
  "tile",
  "native",
]);

/** The route params / query the asset routes read. */
interface AssetParams {
  assetId?: string;
}
interface AssetQuery {
  collection?: unknown;
  variant?: unknown;
  revision?: unknown;
}

/** Producer asset ids are lowercase sha256 hex (see @atf/extract-contract asset-id). */
export const ASSET_ID_RE = /^[0-9a-f]{64}$/;
/**
 * Readable ids additionally include the render cache's derived ids
 * (`<sha256>@s<source>:<region>[.p<px>]`, render-cache.ts cacheAssetIdFor).
 */
export const READABLE_ASSET_ID_RE = /^[0-9a-f]{64}(?:@[A-Za-z0-9:.,_+-]{1,256})?$/;

/**
 * The revision an upload binds to: `X-Revision-Id` and/or `?revision=`. Both
 * may be given but must agree. Returns undefined for a conflict.
 */
function resolveRevisionId(req: Parameters<RequestHandler>[0]): string | null | undefined {
  const header = readHeader(req, "x-revision-id")?.trim() || null;
  const rawQuery = (req.query as AssetQuery).revision;
  const query = typeof rawQuery === "string" && rawQuery.trim() !== "" ? rawQuery.trim() : null;
  if (header !== null && query !== null && header !== query) return undefined;
  return header ?? query;
}

function resolveCollection(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
): string {
  const resolved = (res.locals as { resolvedCollection?: unknown }).resolvedCollection;
  if (typeof resolved === "string" && resolved.length > 0) return resolved;
  const rawCollection = (req.query as AssetQuery).collection;
  const query = typeof rawCollection === "string" ? rawCollection : undefined;
  return query || readHeader(req, "x-collection") || "documents";
}

function assetScope(scope: AccessScope, collection: string): AssetScope | null {
  if (!scope.tenantId) return null;
  return { tenantId: scope.tenantId, collection };
}

/** Parse an optional integer header, returning null when absent/malformed. */
function intHeader(req: Parameters<RequestHandler>[0], name: string): number | null {
  const raw = readHeader(req, name);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse an X-BBox header of the form "x0,y0,x1,y1" (normalized), else null. */
function bboxHeader(req: Parameters<RequestHandler>[0]): number[] | null {
  const raw = readHeader(req, "x-bbox");
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

export function createV2AssetHandlers(
  store: AssetStore,
  logger: Logger,
): { put: RequestHandler; get: RequestHandler; head: RequestHandler } {
  return {
    // PUT /v2/assets/:assetId
    put: async (req, res, next) => {
      try {
        const log = (req as { log?: Logger }).log ?? logger;
        const scope = (res.locals as { accessScope?: AccessScope }).accessScope;
        if (!scope?.tenantId) {
          res.status(403).json({ error: "Tenant context is required" });
          return;
        }
        const mimeType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (!mimeType || !V2_ASSET_MIME_TYPES.has(mimeType)) {
          res.status(415).json({ error: "Content-Type must be image/png, image/jpeg, image/webp, or image/gif" });
          return;
        }
        const data = req.body;
        if (!Buffer.isBuffer(data) || data.length === 0) {
          res.status(400).json({ error: "A non-empty raw image body is required" });
          return;
        }
        if (data.length > MAX_V2_ASSET_BYTES) {
          res.status(413).json({ error: `Image exceeds ${MAX_V2_ASSET_BYTES} bytes` });
          return;
        }
        const documentReference = readHeader(req, "x-document-reference");
        if (!documentReference) {
          res.status(400).json({ error: "X-Document-Reference is required" });
          return;
        }
        const kindRaw = (readHeader(req, "x-asset-kind") ?? "figure").toLowerCase();
        if (!ASSET_KINDS.has(kindRaw as AssetKind)) {
          res.status(400).json({ error: "X-Asset-Kind must be figure, page, tile, or native" });
          return;
        }
        // If the caller declares a checksum, it must match the bytes (guards a
        // corrupted upload before we generate variants).
        const declared = readHeader(req, "x-checksum");
        const checksum = createHash("sha256").update(data).digest("hex");
        if (declared && declared.toLowerCase() !== checksum) {
          res.status(400).json({ error: "X-Checksum does not match the request body" });
          return;
        }

        const assetId = String((req.params as AssetParams).assetId ?? "");
        if (!ASSET_ID_RE.test(assetId)) {
          res.status(400).json({ error: "assetId must be a lowercase sha256 hex digest", code: "INVALID_ASSET_ID" });
          return;
        }
        const revisionId = resolveRevisionId(req);
        if (revisionId === undefined) {
          res.status(400).json({ error: "X-Revision-Id and ?revision= disagree", code: "REVISION_CONFLICT" });
          return;
        }
        const result = await store.put(
          {
            tenantId: scope.tenantId,
            collection: resolveCollection(req, res),
            assetId,
            kind: kindRaw as AssetKind,
            documentReference,
            revisionId,
            figureId: readHeader(req, "x-figure-id") ?? null,
            page: intHeader(req, "x-page"),
            bbox: bboxHeader(req),
            mimeType,
            data,
          },
          scope,
        );
        if (!result.ok) {
          log.warn({ error: result.error, assetId }, "v2 asset PUT failed");
          res.status(result.error.status).json({ error: result.error.message, code: result.error.code });
          return;
        }
        res.status(result.result.created ? 201 : 200).json({
          status: "ok",
          asset_id: result.result.assetId,
          checksum: result.result.checksum,
          variants: result.result.variants,
        });
      } catch (error) {
        next(error);
      }
    },

    // GET /v2/assets/:assetId?variant=
    get: async (req, res, next) => {
      try {
        const log = (req as { log?: Logger }).log ?? logger;
        const scope = (res.locals as { accessScope?: AccessScope }).accessScope;
        if (!scope?.tenantId) {
          res.status(404).end();
          return;
        }
        const collection = resolveCollection(req, res);
        const as = assetScope(scope, collection);
        if (!as) {
          res.status(404).end();
          return;
        }
        const rawVariant = (req.query as AssetQuery).variant;
        const variantRaw = typeof rawVariant === "string" ? rawVariant : "full";
        if (!isAssetVariant(variantRaw)) {
          res.status(400).json({ error: "variant must be thumb, preview, or full" });
          return;
        }
        const variant: AssetVariant = variantRaw;
        const assetId = String((req.params as AssetParams).assetId ?? "");
        if (!READABLE_ASSET_ID_RE.test(assetId)) {
          res.status(404).end();
          return;
        }
        const result = await store.get(as, assetId, variant, scope);
        if (!result.ok) {
          log.warn({ error: result.error, assetId }, "v2 asset GET failed");
          // A denied ACL / missing asset is indistinguishable to the caller: 404.
          res.status(result.error.status >= 500 ? result.error.status : 404).end();
          return;
        }
        const asset = result.result;
        if (!asset) {
          res.status(404).end();
          return;
        }
        const etag = `"sha256-${asset.checksum ?? createHash("sha256").update(asset.data).digest("hex")}"`;
        if (req.headers["if-none-match"] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader("Content-Type", asset.mimeType);
        res.setHeader("Content-Length", String(asset.data.length));
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "private, no-store");
        res.status(200).send(asset.data);
      } catch (error) {
        next(error);
      }
    },

    // HEAD /v2/assets/:assetId?variant=
    head: async (req, res, next) => {
      try {
        const scope = (res.locals as { accessScope?: AccessScope }).accessScope;
        if (!scope?.tenantId) {
          res.status(404).end();
          return;
        }
        const collection = resolveCollection(req, res);
        const as = assetScope(scope, collection);
        if (!as) {
          res.status(404).end();
          return;
        }
        const rawVariant = (req.query as AssetQuery).variant;
        const variantRaw = typeof rawVariant === "string" ? rawVariant : "full";
        if (!isAssetVariant(variantRaw)) {
          res.status(400).end();
          return;
        }
        const assetId = String((req.params as AssetParams).assetId ?? "");
        if (!READABLE_ASSET_ID_RE.test(assetId)) {
          res.status(404).end();
          return;
        }
        const result = await store.head(as, assetId, variantRaw, scope);
        if (!result.ok) {
          res.status(result.error.status >= 500 ? result.error.status : 404).end();
          return;
        }
        if (!result.result.exists) {
          res.status(404).end();
          return;
        }
        if (result.result.mimeType) res.setHeader("Content-Type", result.result.mimeType);
        if (typeof result.result.length === "number") {
          res.setHeader("Content-Length", String(result.result.length));
        }
        if (result.result.checksum) {
          res.setHeader("ETag", `"sha256-${result.result.checksum}"`);
        }
        res.status(200).end();
      } catch (error) {
        next(error);
      }
    },
  };
}
