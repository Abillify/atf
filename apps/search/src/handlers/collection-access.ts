// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * collection-access.ts (handler)
 *
 * Express middleware that enforces collection-level ACLs on collection-scoped
 * routes. It resolves the target collection from the request (header / query /
 * route param depending on the route), takes the acting identity from the
 * principal established by the auth middleware, loads the collection ACL, and
 * rejects with 403 when access is denied.
 *
 * Identity resolution lives in `src/request-principal.ts`. In short: a VERIFIED
 * identity (JWT bearer, OIDC session) is authoritative and cannot be overridden
 * by X-User / X-Groups; header assertion remains available to service callers
 * holding the static API token. A caller with no identity at all is a
 * service/admin context and is allowed — set `ACL_REQUIRE_IDENTITY=true` to
 * refuse that case instead.
 *
 * This module used to read X-User / X-Groups directly, which meant a verified
 * end-user token arrived here as "no identity" and was therefore promoted to
 * admin — the ACLs were inert exactly on the path that mattered most.
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { PostgresClient } from "../postgres-client.js";
import { collectionTableName } from "../collection-ddl.js";
import type { CollectionAcl } from "../collection-access.js";
import { readHeader } from "../header-utils.js";
import { getPrincipal, type RequestPrincipal } from "../request-principal.js";
import {
  AccessDeniedError,
  accessScopeForRequest,
  requireCollectionAccess,
} from "../access-scope.js";

export type { RequestPrincipal };

/** The acting identity for this request, as resolved by the auth middleware. */
export function extractPrincipal(
  req: Parameters<RequestHandler>[0],
): RequestPrincipal {
  return getPrincipal(req);
}

export type CollectionResolver = (
  req: Parameters<RequestHandler>[0],
) => string | undefined;

/** Resolve the collection from the X-Collection header (ingest/search/delete). */
export const collectionFromHeader: CollectionResolver = (req) =>
  readHeader(req, "x-collection") || undefined;

/** Resolve the collection from the `?collection=` query param (read endpoints). */
export const collectionFromQuery: CollectionResolver = (req) =>
  (req.query["collection"] as string | undefined) || undefined;

/** Resolve the collection from the `:name` route param (admin endpoints). */
export const collectionFromParam: CollectionResolver = (req) =>
  (req.params as { name?: string })["name"] || undefined;

export function createCollectionAccessMiddleware(
  postgresClient: PostgresClient,
  resolve: CollectionResolver,
  options: {
    defaultCollection?: string;
    logger?: Logger;
    /**
     * Routes whose handler creates the collection on first write (the v1
     * ingest endpoints call `ensureCollection`). For those, an unknown
     * collection is not an error: the request proceeds with no stored ACL and
     * the handler creates the collection. Every other route answers 404 —
     * an index that does not exist holds nothing, which is not a permission
     * failure and must not be reported as one.
     */
    allowUnknownCollection?: boolean;
  } = {},
): RequestHandler {
  const defaultCollection = options.defaultCollection ?? "documents";
  return async (req, res, next) => {
    const log: Logger | undefined =
      (req as { log?: Logger }).log ?? options.logger;
    try {
      const collection = resolve(req) ?? defaultCollection;
      // The naming rule is public, so a bad name is reported as what it is
      // (400) rather than folded into "access denied".
      try {
        collectionTableName(collection);
      } catch (cause) {
        res.status(400).json({ error: (cause as Error).message, code: "INVALID_COLLECTION_NAME" });
        return;
      }
      const scope = accessScopeForRequest(req);
      let acl: CollectionAcl | undefined;
      try {
        acl = await requireCollectionAccess(postgresClient, collection, scope);
      } catch (error) {
        if (
          error instanceof AccessDeniedError &&
          error.code === "COLLECTION_NOT_FOUND" &&
          options.allowUnknownCollection
        ) {
          // First write: there is no stored ACL yet, the handler creates it
          // together with the collection.
          acl = undefined;
        } else {
          throw error;
        }
      }
      res.locals["accessScope"] = scope;
      res.locals["collectionAcl"] = acl;
      res.locals["resolvedCollection"] = collection;
      next();
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        const collection = resolve(req) ?? defaultCollection;
        if (err.code === "COLLECTION_NOT_FOUND") {
          log?.info({ collection }, err.message);
          res
            .status(404)
            .json({ error: err.message, code: "COLLECTION_NOT_FOUND" });
          return;
        }
        log?.warn({ collection }, err.message);
        res.status(403).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };
}
