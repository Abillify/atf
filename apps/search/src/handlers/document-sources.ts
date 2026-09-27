// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/document-sources.ts
 *
 * Source identification for dedup and version chains (see document-identity.ts):
 *
 *   POST /v2/sources/identify            register an ingest's source claim and
 *                                        decide new / new_version / duplicate
 *   GET  /v2/documents/{ref}/sources     every source of a document, indexed
 *                                        ones and skipped duplicates
 *
 * Mounted behind the same auth / scope / tenant / collection-ACL chain as the
 * revision routes: identify needs write scope (it creates a claim), the listing
 * read scope.
 */

import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { identifyRequestSchema } from "@atf/extract-contract";
import { rowAclForRevision, type AccessScope } from "../access-scope.js";
import type { CollectionAcl } from "../collection-access.js";
import { readHeader } from "../header-utils.js";
import {
  identifySource,
  listDocumentSources,
  type IdentityOptions,
} from "../document-identity.js";

export interface DocumentSourceHandlerOptions {
  identity: IdentityOptions;
  logger: Logger;
}

function tenantAndCollection(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
): { tenantId: string; collection: string; accessScope: AccessScope } | null {
  const accessScope = (res.locals as { accessScope?: AccessScope }).accessScope;
  if (!accessScope?.tenantId) {
    res.status(403).json({ error: "Tenant context is required" });
    return null;
  }
  const collection =
    (res.locals as { resolvedCollection?: string }).resolvedCollection ??
    readHeader(req, "x-collection") ??
    "documents";
  return { tenantId: accessScope.tenantId, collection, accessScope };
}

export function createDocumentSourceHandlers(
  pool: Pool,
  options: DocumentSourceHandlerOptions,
): { identify: RequestHandler; list: RequestHandler } {
  const { identity, logger } = options;
  return {
    // POST /v2/sources/identify
    identify: async (req, res, next) => {
      try {
        const scope = tenantAndCollection(req, res);
        if (!scope) return;
        const parsed = identifyRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid identify request",
            code: "INVALID_IDENTIFY_REQUEST",
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
          return;
        }
        const body = parsed.data;
        // Resolved exactly like the revision's row ACL, so a source matches the
        // sources its document will be readable alongside.
        const acl = rowAclForRevision(
          scope.accessScope,
          (res.locals as { collectionAcl?: CollectionAcl }).collectionAcl,
          { users: body.allowedUsers ?? [], groups: body.allowedGroups ?? [] },
        );
        const result = await identifySource(
          pool,
          {
            tenantId: scope.tenantId,
            collection: scope.collection,
            acl,
            sourceId: body.sourceId,
            phase: body.phase,
            reference: body.reference,
            documentKey: body.documentKey,
            filename: body.filename,
            mimeType: body.mimeType,
            sourceSha256: body.sourceSha256,
            textHash: body.textHash,
            minhash: body.minhash,
            messageId: body.messageId,
            version: body.version,
            dedup: body.dedup,
          },
          identity,
        );
        logger.info(
          {
            sourceId: body.sourceId,
            phase: body.phase,
            decision: result.decision,
            canonicalReference: result.canonicalReference,
            duplicateOf: result.duplicateOf?.reference,
          },
          "Source identified",
        );
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },

    // GET /v2/documents/{ref}/sources
    list: async (req, res, next) => {
      try {
        const scope = tenantAndCollection(req, res);
        if (!scope) return;
        const raw = (req.params as { ref?: string }).ref;
        const reference = typeof raw === "string" ? decodeURIComponent(raw) : "";
        if (reference === "") {
          res.status(400).json({ error: "A document reference is required" });
          return;
        }
        const sources = await listDocumentSources(pool, {
          tenantId: scope.tenantId,
          collection: scope.collection,
          reference,
          scope: scope.accessScope,
        });
        res.status(200).json({ reference, sources });
      } catch (error) {
        next(error);
      }
    },
  };
}
