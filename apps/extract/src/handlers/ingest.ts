// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest.ts
 *
 * `POST /v1/ingest` — convert an uploaded document and write it into Search in
 * one call.
 *
 * This is the full path, as opposed to Search's own `/ingest-file` proxy. The
 * difference is figure images: the proxy forwards Markdown, so Search receives
 * figure *descriptions* as retrievable text but no crops. Here the crops exist in
 * memory already, so they are stored too. A caller who wants figures in search
 * results uses this route; a caller who just wants a PDF indexed can use either.
 *
 * ## Why the ACL comes from the principal and not from the request
 *
 * `X-Allowed-Users` / `X-Allowed-Groups` are accepted only as a *narrowing* of
 * what the caller already is. A verified end-user token ingests documents visible
 * to that user and their groups; it cannot ingest a document visible to someone
 * else. The alternative — passing the headers through — would let any credential
 * that may convert a file also publish it to an arbitrary audience, which is a
 * privilege escalation dressed up as a convenience.
 *
 * A service credential with no end-user identity ingests with an empty ACL, which
 * in Search means unrestricted. That is the documented behaviour for
 * service-to-service ingest, and `ACL_REQUIRE_IDENTITY` is the switch that turns
 * it into a 403 for deployments where every document must be attributable.
 */

import { randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { Logger } from "pino";
import { collectFigures, type IngestHeaderOptions } from "@atf/extract-contract/v1";
import { validationError } from "../errors.js";
import { readHeader, readListHeader, parseBooleanHeader } from "../header-utils.js";
import { getPrincipal, runWithPrincipal, type RequestPrincipal } from "../request-principal.js";
import { QueueSaturatedError, type WorkQueue } from "../queue.js";
import {
  readUpload,
  sanitizeFilename,
  type UploadedDocument,
} from "../upload.js";
import type { Extractor } from "../pipeline/extract.js";
import type { SearchClient } from "../search-client.js";

export interface IngestMetrics {
  recordDocument(mimeType: string, outcome: "ok" | "error"): void;
  recordQueueRejection(): void;
}

export interface IngestHandlerDeps {
  extractor: Extractor;
  searchClient: SearchClient;
  queue: WorkQueue;
  logger: Logger;
  metrics: IngestMetrics;
  /** Collection used when the request does not name one. */
  defaultCollection: string;
}

/**
 * Intersect the requested ACL with the caller's own identity.
 *
 * An empty request means "as wide as the caller"; a non-empty one may only
 * remove. Returning the intersection rather than rejecting a superset keeps a
 * bulk uploader working when one document names a group the caller happens not to
 * be in.
 */
export function resolveAcl(
  principal: RequestPrincipal,
  requested: { users: string[]; groups: string[] },
): { allowedUsers: string[]; allowedGroups: string[] } {
  const ownUsers = principal.userId !== undefined ? [principal.userId] : [];
  const ownGroups = principal.userGroups ?? [];

  // No identity: a service context. Search treats an empty ACL as unrestricted,
  // which is the documented service-to-service behaviour.
  if (ownUsers.length === 0 && ownGroups.length === 0) {
    return { allowedUsers: [], allowedGroups: [] };
  }

  const users =
    requested.users.length === 0 ? ownUsers : requested.users.filter((u) => ownUsers.includes(u));
  const groups =
    requested.groups.length === 0
      ? ownGroups
      : requested.groups.filter((g) => ownGroups.includes(g));

  return { allowedUsers: users, allowedGroups: groups };
}

function canonicalValidFrom(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match) throw validationError("X-Valid-From must be an RFC 3339 date-time with an explicit timezone");
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map(Number);
  const daysInMonth = month !== undefined && month >= 1 && month <= 12 && year !== undefined
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day === undefined || day < 1 || day > daysInMonth || (hour ?? 24) > 23 || (minute ?? 60) > 59 || (second ?? 60) > 59 || (offsetHour ?? 0) > 23 || (offsetMinute ?? 0) > 59 || !Number.isFinite(Date.parse(value))) {
    throw validationError("X-Valid-From must be a valid RFC 3339 date-time with an explicit timezone");
  }
  return new Date(value).toISOString();
}

/** Parse the Search-bound options a caller may set. */
function parseIngestOptions(req: Request, defaultCollection: string): IngestHeaderOptions {
  const principal = getPrincipal(req);
  const acl = resolveAcl(principal, {
    users: readListHeader(req, "x-allowed-users"),
    groups: readListHeader(req, "x-allowed-groups"),
  });

  const versionModeRaw = readHeader(req, "x-version-mode");
  if (versionModeRaw !== undefined && !["replace", "version"].includes(versionModeRaw)) {
    throw validationError('X-Version-Mode must be "replace" or "version"');
  }
  const validFrom = canonicalValidFrom(readHeader(req, "x-valid-from"));

  const semanticChunking = parseBooleanHeader(readHeader(req, "x-semantic-chunking"));
  if (semanticChunking === null) {
    throw validationError("X-Semantic-Chunking must be one of: 1/0, true/false, yes/no, on/off");
  }

  const metadata = readMetadataHeader(req);

  const chunkSize = readHeader(req, "x-chunk-size");
  const chunkOverlap = readHeader(req, "x-chunk-overlap");

  // Chunking / structure overrides. Each mirrors the accepted range in
  // apps/search/src/ingest-header-parser.ts: absent → Search's default, a
  // valid value → override, anything else → 400 here rather than a late 400
  // from Search after a conversion has already been paid for.
  const lateChunkingAlpha = parseFloatHeader(readHeader(req, "x-late-chunking-alpha"), {
    min: 0,
    max: 1,
    name: "X-Late-Chunking-Alpha",
  });
  const breakpointPercentile = parseIntHeader(readHeader(req, "x-breakpoint-percentile"), {
    min: 1,
    max: 99,
    name: "X-Breakpoint-Percentile",
  });
  const contextPrefixSize = parseIntHeader(readHeader(req, "x-context-prefix-size"), {
    min: 0,
    name: "X-Context-Prefix-Size",
  });
  const chapterSplitMaxChunks = parseIntHeader(readHeader(req, "x-chapter-split-max-chunks"), {
    min: 0,
    name: "X-Chapter-Split-Max-Chunks",
  });

  const summarize = parseBooleanHeader(readHeader(req, "x-summarize"));
  if (summarize === null) {
    throw validationError("X-Summarize must be one of: 1/0, true/false, yes/no, on/off");
  }

  const quantizationRaw = readHeader(req, "x-quantization")?.trim().toLowerCase();
  if (quantizationRaw !== undefined && quantizationRaw !== "" && quantizationRaw !== "none" && quantizationRaw !== "binary") {
    throw validationError('X-Quantization must be "none" or "binary"');
  }

  const documentStructureRaw = readHeader(req, "x-document-structure")?.trim().toLowerCase();
  if (documentStructureRaw !== undefined && documentStructureRaw !== "" && documentStructureRaw !== "auto" && documentStructureRaw !== "off") {
    throw validationError('X-Document-Structure must be "auto" or "off"');
  }

  const summaryModeRaw = readHeader(req, "x-summary-mode")?.trim().toLowerCase();
  if (
    summaryModeRaw !== undefined && summaryModeRaw !== "" &&
    !["auto", "generate", "embedded", "off"].includes(summaryModeRaw)
  ) {
    throw validationError('X-Summary-Mode must be one of: auto, generate, embedded, off');
  }

  return {
    collection: readHeader(req, "x-collection")?.trim() || defaultCollection,
    allowedUsers: acl.allowedUsers,
    allowedGroups: acl.allowedGroups,
    ...(readHeader(req, "x-source") !== undefined ? { source: readHeader(req, "x-source") } : {}),
    ...(readHeader(req, "x-link") !== undefined ? { link: readHeader(req, "x-link") } : {}),
    ...(readHeader(req, "x-version") !== undefined ? { version: readHeader(req, "x-version") } : {}),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(versionModeRaw !== undefined ? { versionMode: versionModeRaw as "replace" | "version" } : {}),
    ...(readHeader(req, "x-fts-language") !== undefined
      ? { ftsLanguage: readHeader(req, "x-fts-language") }
      : {}),
    ...(chunkSize !== undefined ? { chunkSize: Number.parseInt(chunkSize, 10) } : {}),
    ...(chunkOverlap !== undefined ? { chunkOverlap: Number.parseInt(chunkOverlap, 10) } : {}),
    ...(semanticChunking !== undefined ? { semanticChunking } : {}),
    ...(lateChunkingAlpha !== undefined ? { lateChunkingAlpha } : {}),
    ...(breakpointPercentile !== undefined ? { breakpointPercentile } : {}),
    ...(contextPrefixSize !== undefined ? { contextPrefixSize } : {}),
    ...(chapterSplitMaxChunks !== undefined ? { chapterSplitMaxChunks } : {}),
    ...(summarize !== undefined ? { summarize } : {}),
    ...(quantizationRaw !== undefined && quantizationRaw !== ""
      ? { quantization: quantizationRaw as "none" | "binary" }
      : {}),
    ...(documentStructureRaw !== undefined && documentStructureRaw !== ""
      ? { documentStructure: documentStructureRaw as "auto" | "off" }
      : {}),
    ...(summaryModeRaw !== undefined && summaryModeRaw !== ""
      ? { summaryMode: summaryModeRaw as "auto" | "generate" | "embedded" | "off" }
      : {}),
    ...(readListHeader(req, "x-tags").length > 0 ? { tags: readListHeader(req, "x-tags") } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Parse an integer-valued override header with range validation. */
function parseIntHeader(
  value: string | undefined,
  opts: { min?: number; max?: number; name: string },
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  if (
    !Number.isInteger(parsed) ||
    (opts.min !== undefined && parsed < opts.min) ||
    (opts.max !== undefined && parsed > opts.max)
  ) {
    const range =
      opts.max !== undefined ? `${opts.min}–${opts.max}` : `an integer ≥ ${opts.min ?? 0}`;
    throw validationError(
      `${opts.name} must be ${opts.max !== undefined ? `an integer in ${range}` : range}`,
    );
  }
  return parsed;
}

/** Parse a float-valued override header with range validation. */
function parseFloatHeader(
  value: string | undefined,
  opts: { min: number; max: number; name: string },
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < opts.min || parsed > opts.max) {
    throw validationError(`${opts.name} must be a number in ${opts.min}–${opts.max}`);
  }
  return parsed;
}

export function createIngestHandler(deps: IngestHandlerDeps): RequestHandler {
  const { extractor, searchClient, queue, logger, metrics, defaultCollection } = deps;

  return (req, res, next) => {
    // Read outside the async block so the `finally` below can always release a
    // spooled scratch file, whichever path the request took.
    let upload: UploadedDocument;
    try {
      upload = readUpload(req);
    } catch (error) {
      next(error);
      return;
    }

    void (async () => {
      // Unlike conversion, the reference is mandatory here: it is the row key
      // Search stores under, and defaulting it to a filename would make two
      // uploads of "scan.pdf" from different sources overwrite each other.
      const reference = readHeader(req, "x-reference")?.trim();
      if (reference === undefined || reference === "") {
        throw validationError(
          "X-Reference is required for ingest and identifies the document",
        );
      }

      const titleRaw = readHeader(req, "x-title")?.trim();
      const options = parseIngestOptions(req, defaultCollection);
      const principal = getPrincipal(req);

      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      // The principal travels through AsyncLocalStorage rather than a parameter
      // because ingest happens after the extraction resolves, and the request may
      // already be gone by then.
      const outcome = await runWithPrincipal(principal, () =>
        queue.submit(async () => {
          // Materialise *inside* the queue slot: a spooled upload must not
          // hold its bytes in the heap while it waits.
          const buffer = await upload.readBuffer();
          try {
            const result = await extractor.extract({
              buffer,
              filename: upload.filename,
              declaredMimeType: upload.declaredMimeType,
              reference,
              ...(titleRaw !== undefined && titleRaw !== ""
                ? { title: sanitizeFilename(titleRaw) }
                : {}),
              signal: controller.signal,
            });
            metrics.recordDocument(result.document.source.mimeType, "ok");

            const ingested = await searchClient.ingestDocument({
              document: result.document,
              markdown: result.markdown,
              options,
              signal: controller.signal,
            });
            return { result, ingested };
          } catch (error) {
            metrics.recordDocument(
              upload.declaredMimeType ?? "unknown",
              "error",
            );
            throw error;
          }
        }),
      );

      if (res.writableEnded) return;

      const figures = collectFigures(outcome.result.document);
      logger.info(
        {
          reference,
          collection: outcome.ingested.collection,
          pageCount: outcome.result.document.pageCount,
          figures: figures.length,
        },
        "Document converted and ingested",
      );

      // Figure images are not part of this v1 text path: they flow through the
      // v2 pipeline (jobs/emitter.ts → PUT /v2/assets/:assetId).
      res.status(200).json({
        status: "ok",
        reference,
        collection: outcome.ingested.collection,
        contract: outcome.result.document.contract,
        page_count: outcome.result.document.pageCount,
        figure_count: figures.length,
        warnings: outcome.result.document.warnings,
        search: outcome.ingested.ingest,
      });
    })()
      .catch((error: unknown) => {
        if (error instanceof QueueSaturatedError) {
          metrics.recordQueueRejection();
          res.setHeader("Retry-After", "30");
          res.status(503).json({
            error: "The conversion queue is full; retry shortly",
            code: "QUEUE_SATURATED",
            retryable: true,
          });
          return;
        }
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        next(error);
      })
      .finally(() => {
        void upload.cleanup();
      });
  };
}

/** Correlation id for a log line when no request id is available. */
export function newIngestId(): string {
  return randomUUID();
}

/** Parse the `X-Metadata` header: a JSON object, or absent. */
export function readMetadataHeader(req: Request): Record<string, unknown> | undefined {
  const metadataRaw = readHeader(req, "x-metadata");
  if (metadataRaw === undefined || metadataRaw.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(metadataRaw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw validationError("X-Metadata must be a JSON object");
  }
}
