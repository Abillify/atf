// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import { readHeader } from "../header-utils.js";
import type { PostgresClient } from "../postgres-client.js";
import { buildDocumentAssetId } from "../document-structure.js";

export const MAX_DOCUMENT_ASSET_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function collectionForRequest(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
): string {
  const resolved = (res.locals as { resolvedCollection?: unknown }).resolvedCollection;
  if (typeof resolved === "string" && resolved.length > 0) return resolved;
  const query = typeof req.query["collection"] === "string" ? req.query["collection"] : undefined;
  return query || readHeader(req, "x-collection") || "documents";
}

export function createPutDocumentAssetHandler(
  postgresClient: PostgresClient,
  logger: Logger,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const log = (req as { log?: Logger }).log ?? logger;
      const mimeType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (!mimeType || !DOCUMENT_ASSET_MIME_TYPES.has(mimeType)) {
        res.status(415).json({ error: "Content-Type must be image/png, image/jpeg, image/webp, or image/gif" });
        return;
      }
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        res.status(400).json({ error: "A non-empty raw image body is required" });
        return;
      }
      if (data.length > MAX_DOCUMENT_ASSET_BYTES) {
        res.status(413).json({ error: `Image exceeds ${MAX_DOCUMENT_ASSET_BYTES} bytes` });
        return;
      }
      const documentReference = readHeader(req, "x-document-reference");
      const figureId = readHeader(req, "x-figure-id");
      if (!documentReference || !figureId) {
        res.status(400).json({ error: "X-Document-Reference and X-Figure-Id are required" });
        return;
      }
      const rawAssetId = req.params["assetId"];
      const assetId = typeof rawAssetId === "string" ? rawAssetId : "";
      const expectedAssetId = buildDocumentAssetId(documentReference, figureId);
      if (assetId !== expectedAssetId) {
        res.status(400).json({ error: "Asset ID does not match X-Document-Reference and X-Figure-Id" });
        return;
      }
      const scope = (res.locals as { accessScope?: AccessScope }).accessScope;
      if (!scope?.tenantId) {
        res.status(403).json({ error: "Tenant context is required" });
        return;
      }
      const checksum = createHash("sha256").update(data).digest("hex");
      const result = await postgresClient.upsertDocumentAsset({
        tenantId: scope.tenantId,
        collection: collectionForRequest(req, res),
        assetId,
        documentReference,
        figureId,
        mimeType,
        data,
        checksum,
      }, scope);
      if (!result.ok) {
        log.warn({ error: result.error, assetId }, "Document asset upsert failed");
        res.status(502).json({ error: result.error.message });
        return;
      }
      if (!result.result) {
        res.status(404).json({ error: "Associated document is not visible" });
        return;
      }
      res.status(result.result.created ? 201 : 200).json({ status: "ok", asset_id: assetId, checksum });
    } catch (error) {
      next(error);
    }
  };
}

export function createGetDocumentAssetHandler(
  postgresClient: PostgresClient,
  logger: Logger,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const log = (req as { log?: Logger }).log ?? logger;
      const scope = (res.locals as { accessScope?: AccessScope }).accessScope;
      if (!scope?.tenantId) {
        res.status(404).end();
        return;
      }
      const rawAssetId = req.params["assetId"];
      const assetId = typeof rawAssetId === "string" ? rawAssetId : "";
      const result = await postgresClient.getDocumentAsset(collectionForRequest(req, res), assetId, scope);
      if (!result.ok) {
        log.warn({ error: result.error, assetId }, "Document asset lookup failed");
        res.status(404).end();
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
  };
}
