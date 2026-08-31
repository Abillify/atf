// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { PostgresClient } from "../postgres-client.js";
import type { Metadata } from "../metadata.js";
import { buildPostgresFilter } from "./search.js";
import { readHeader } from "../header-utils.js";
import { emitActivity } from "../activity-emitter.js";
import { accessScopeForRequest } from "../access-scope.js";
import { newActivityId } from "./activity-stream.js";

export function createDeleteHandler(
  postgresClient: PostgresClient,
  logger: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    try {
      const metadata: Metadata =
        (res.locals as { metadata?: Metadata }).metadata ?? {};

      const collectionRaw = readHeader(req, "x-collection") || "documents";

      // X-Reference: delete by exact document reference (removes all versions of that base_ref).
      const reference = readHeader(req, "x-reference");

      if (reference) {
        const deleteResult = await postgresClient.delete(
          {},
          collectionRaw,
          accessScopeForRequest(req),
          reference,
        );
        if (!deleteResult.ok) {
          const status =
            deleteResult.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502;
          log.warn({ error: deleteResult.error }, "Delete by reference failed");
          emitActivity({
            id: newActivityId(),
            type: "delete",
            status: "error",
            summary:
              reference +
              (collectionRaw !== "documents" ? " in " + collectionRaw : ""),
            timestamp: new Date().toISOString(),
            duration_ms: 0,
            detail: { error: deleteResult.error.message },
          });
          res.status(status).json({ error: deleteResult.error.message });
          return;
        }
        emitActivity({
          id: newActivityId(),
          type: "delete",
          status: "ok",
          summary:
            reference +
            (collectionRaw !== "documents" ? " in " + collectionRaw : ""),
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          detail: { deleted: deleteResult.result.deleted },
        });
        res
          .status(200)
          .json({ status: "ok", deleted: deleteResult.result.deleted });
        return;
      }

      // Fall back to metadata-filter delete.
      const filter = buildPostgresFilter(metadata);
      if (!filter) {
        res.status(400).json({
          error:
            "Either X-Reference or at least one metadata filter is required for deletion",
        });
        return;
      }

      const deleteResult = await postgresClient.delete(filter, collectionRaw, accessScopeForRequest(req));
      if (!deleteResult.ok) {
        const status =
          deleteResult.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502;
        log.warn({ error: deleteResult.error }, "Delete failed");
        emitActivity({
          id: newActivityId(),
          type: "delete",
          status: "error",
          summary:
            "filter delete" +
            (collectionRaw !== "documents" ? " in " + collectionRaw : ""),
          timestamp: new Date().toISOString(),
          duration_ms: 0,
          detail: { error: deleteResult.error.message },
        });
        res.status(status).json({ error: deleteResult.error.message });
        return;
      }

      emitActivity({
        id: newActivityId(),
        type: "delete",
        status: "ok",
        summary:
          "filter delete" +
          (collectionRaw !== "documents" ? " in " + collectionRaw : ""),
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        detail: { deleted: deleteResult.result.deleted },
      });

      res
        .status(200)
        .json({ status: "ok", deleted: deleteResult.result.deleted });
    } catch (err) {
      next(err);
    }
  };
}
