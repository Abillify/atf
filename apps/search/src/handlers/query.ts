// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/query.ts
 *
 * Read-only "query" REST endpoints that mirror the MCP read tools 1:1 so the
 * same capabilities are available over plain HTTP (and testable from the UI):
 *
 *   GET /documents          — list_documents   (one entry per document)
 *   GET /document           — get_document      (reassembled single document)
 *   GET /documents/content  — get_documents     (reassemble a whole folder)
 *   GET /folders            — list_folders      (folder structure)
 *   GET /summary            — get_summary       (stored summary of one doc)
 *   GET /summaries          — get_summaries     (summaries across a folder)
 *   GET /collection-stats   — collection_stats  (document/chunk counts)
 *
 * Every call emits a "query" activity event (source: "rest") so it shows up on
 * the Activity page next to ingest/search/delete.
 */

import type { Request, RequestHandler } from "express";
import type { Logger } from "pino";
import type { PostgresClient } from "../postgres-client.js";
import { emitActivity } from "../activity-emitter.js";
import { newActivityId } from "./activity-stream.js";
import { accessScopeForRequest } from "../access-scope.js";
import { getPrincipal } from "../request-principal.js";
import { getUsageContext } from "../usage-context.js";

export interface QueryHandlerOptions {
  defaultCollection?: string;
}

/**
 * Emit a "query" activity event for a read-only REST call.
 *
 * Includes the request's token-usage context (same as the MCP query tools) so
 * any cost incurred during the call surfaces on the Activity page.
 */
function emitQueryActivity(params: {
  req: Request;
  tool: string;
  summary: string;
  status: "ok" | "error";
  startTime: number;
  detail: Record<string, unknown>;
}): void {
  const usage = getUsageContext();
  emitActivity({
    id: newActivityId(),
    tenantId: getPrincipal(params.req).tenantId,
    type: "query",
    status: params.status,
    summary: `${params.tool}: ${params.summary}`,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - params.startTime,
    detail: { tool: params.tool, source: "rest", ...params.detail },
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: usage.cost,
          modelCosts: usage.modelCosts,
        }
      : undefined,
  });
}

/** Parse a positive-integer query param within [min, max]; returns undefined when absent. */
function parseIntParam(
  raw: unknown,
  { min, max }: { min: number; max: number },
): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n) || n < min || n > max) {
    return { error: `must be an integer between ${min} and ${max}` };
  }
  return { value: n };
}

export function createQueryHandlers(
  postgresClient: PostgresClient,
  logger: Logger,
  options: QueryHandlerOptions = {},
): {
  listDocuments: RequestHandler;
  getDocument: RequestHandler;
  getDocuments: RequestHandler;
  listFolders: RequestHandler;
  getSummary: RequestHandler;
  getSummaries: RequestHandler;
  collectionStats: RequestHandler;
} {
  const defaultCollection = options.defaultCollection ?? "documents";

  const col = (req: { query: Record<string, unknown> }): string =>
    (req.query["collection"] as string | undefined) ?? defaultCollection;
  const pathPrefix = (req: { query: Record<string, unknown> }): string | undefined =>
    (req.query["path_prefix"] as string | undefined) || undefined;

  // ── GET /documents ─────────────────────────────────────────────────────────
  const listDocuments: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const prefix = pathPrefix(req);
      const limit = parseIntParam(req.query["limit"], { min: 1, max: 1000 });
      if (limit.error) {
        res.status(400).json({ error: `limit ${limit.error}` });
        return;
      }
      const offset = parseIntParam(req.query["offset"], { min: 0, max: 1e9 });
      if (offset.error) {
        res.status(400).json({ error: `offset ${offset.error}` });
        return;
      }

      const directRaw = String(req.query["direct"] ?? "").trim().toLowerCase();
      const directOnly = ["1", "true", "yes", "on"].includes(directRaw);
      const result = await postgresClient.listDocuments(collection, accessScopeForRequest(req), {
        ...(prefix !== undefined ? { pathPrefix: prefix } : {}),
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(offset.value !== undefined ? { offset: offset.value } : {}),
        ...(directOnly ? { directOnly: true } : {}),
      });
      if (!result.ok) {
        log.warn({ error: result.error }, "list_documents failed");
        emitQueryActivity({
          req,
          tool: "list_documents",
          summary: `${collection}${prefix ? " " + prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, path_prefix: prefix, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      const { documents, total } = result.result;
      emitQueryActivity({
        req,
        tool: "list_documents",
        summary: `${documents.length} of ${total} document${total === 1 ? "" : "s"} in ${collection}${prefix ? " " + prefix : ""}`,
        status: "ok",
        startTime,
        detail: { collection, path_prefix: prefix, count: documents.length, total },
      });
      res.status(200).json({ status: "ok", documents, count: documents.length, total });
    } catch (err) {
      next(err);
    }
  };

  // ── GET /document ──────────────────────────────────────────────────────────
  const getDocument: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const reference = (req.query["reference"] as string | undefined)?.trim();
      if (!reference) {
        res.status(400).json({ error: "reference query parameter is required" });
        return;
      }
      const maxChars = parseIntParam(req.query["max_chars"], {
        min: 1000,
        max: 2_000_000,
      });
      if (maxChars.error) {
        res.status(400).json({ error: `max_chars ${maxChars.error}` });
        return;
      }
      const offset = parseIntParam(req.query["offset"], { min: 0, max: 1e9 });
      if (offset.error) {
        res.status(400).json({ error: `offset ${offset.error}` });
        return;
      }

      const result = await postgresClient.getDocument(collection, accessScopeForRequest(req), reference, {
        ...(maxChars.value !== undefined ? { maxChars: maxChars.value } : {}),
        ...(offset.value !== undefined ? { offset: offset.value } : {}),
      });
      if (!result.ok) {
        log.warn({ error: result.error }, "get_document failed");
        emitQueryActivity({
          req,
          tool: "get_document",
          summary: `${reference}${collection !== "documents" ? " in " + collection : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, reference, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      if (result.result === null) {
        emitQueryActivity({
          req,
          tool: "get_document",
          summary: `${reference}${collection !== "documents" ? " in " + collection : ""} — not found`,
          status: "error",
          startTime,
          detail: { collection, reference, notFound: true },
        });
        res.status(404).json({
          error: `No document found for reference "${reference}" in collection "${collection}".`,
        });
        return;
      }
      emitQueryActivity({
        req,
        tool: "get_document",
        summary: `${reference}${collection !== "documents" ? " in " + collection : ""}`,
        status: "ok",
        startTime,
        detail: { collection, reference },
      });
      res.status(200).json({ status: "ok", document: result.result });
    } catch (err) {
      next(err);
    }
  };

  // ── GET /documents/content ─────────────────────────────────────────────────
  const getDocuments: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const prefix = pathPrefix(req);
      const limit = parseIntParam(req.query["limit"], { min: 1, max: 200 });
      if (limit.error) {
        res.status(400).json({ error: `limit ${limit.error}` });
        return;
      }
      const maxChars = parseIntParam(req.query["max_chars"], {
        min: 1000,
        max: 2_000_000,
      });
      if (maxChars.error) {
        res.status(400).json({ error: `max_chars ${maxChars.error}` });
        return;
      }

      const result = await postgresClient.getDocumentsByPrefix(collection, accessScopeForRequest(req), {
        ...(prefix !== undefined ? { pathPrefix: prefix } : {}),
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(maxChars.value !== undefined ? { maxChars: maxChars.value } : {}),
      });
      if (!result.ok) {
        log.warn({ error: result.error }, "get_documents failed");
        emitQueryActivity({
          req,
          tool: "get_documents",
          summary: `${collection}${prefix ? " " + prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, path_prefix: prefix, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      const { documents, total, truncated } = result.result;
      emitQueryActivity({
        req,
        tool: "get_documents",
        summary: `${documents.length} of ${total} document${total === 1 ? "" : "s"} in ${collection}${prefix ? " " + prefix : ""}${truncated ? " (truncated)" : ""}`,
        status: "ok",
        startTime,
        detail: { collection, path_prefix: prefix, count: documents.length, total, truncated },
      });
      res.status(200).json({ status: "ok", documents, count: documents.length, total, truncated });
    } catch (err) {
      next(err);
    }
  };

  // ── GET /folders ─────────────────────────────────────────────────────────
  const listFolders: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const prefix = pathPrefix(req);
      const depth = parseIntParam(req.query["depth"], { min: -1, max: 100 });
      if (depth.error) {
        res.status(400).json({ error: `depth ${depth.error}` });
        return;
      }

      const result = await postgresClient.listFolders(collection, accessScopeForRequest(req), {
        ...(prefix !== undefined ? { pathPrefix: prefix } : {}),
        ...(depth.value !== undefined ? { depth: depth.value } : {}),
      });
      if (!result.ok) {
        log.warn({ error: result.error }, "list_folders failed");
        emitQueryActivity({
          req,
          tool: "list_folders",
          summary: `${collection}${prefix ? " " + prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, path_prefix: prefix, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      emitQueryActivity({
        req,
        tool: "list_folders",
        summary: `${collection}${prefix ? " " + prefix : "/"}`,
        status: "ok",
        startTime,
        detail: { collection, path_prefix: prefix, result: result.result },
      });
      res.status(200).json({ status: "ok", ...result.result });
    } catch (err) {
      next(err);
    }
  };

  // ── GET /summary ─────────────────────────────────────────────────────────
  const getSummary: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const reference = (req.query["reference"] as string | undefined)?.trim();
      if (!reference) {
        res.status(400).json({ error: "reference query parameter is required" });
        return;
      }

      const result = await postgresClient.getSummary(collection, accessScopeForRequest(req), reference);
      if (!result.ok) {
        log.warn({ error: result.error }, "get_summary failed");
        emitQueryActivity({
          req,
          tool: "get_summary",
          summary: `${reference}${collection !== "documents" ? " in " + collection : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, reference, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      if (result.result === null) {
        emitQueryActivity({
          req,
          tool: "get_summary",
          summary: `${reference}${collection !== "documents" ? " in " + collection : ""} — not found`,
          status: "error",
          startTime,
          detail: { collection, reference, notFound: true },
        });
        res.status(404).json({
          error: `No document found for reference "${reference}" in collection "${collection}".`,
        });
        return;
      }
      emitQueryActivity({
        req,
        tool: "get_summary",
        summary: `${reference}${collection !== "documents" ? " in " + collection : ""}`,
        status: "ok",
        startTime,
        detail: { collection, reference },
      });
      res.status(200).json({ status: "ok", summary: result.result });
    } catch (err) {
      next(err);
    }
  };

  // ── GET /summaries ─────────────────────────────────────────────────────────
  const getSummaries: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const prefix = pathPrefix(req);
      const limit = parseIntParam(req.query["limit"], { min: 1, max: 1000 });
      if (limit.error) {
        res.status(400).json({ error: `limit ${limit.error}` });
        return;
      }
      const offset = parseIntParam(req.query["offset"], { min: 0, max: 1e9 });
      if (offset.error) {
        res.status(400).json({ error: `offset ${offset.error}` });
        return;
      }

      const result = await postgresClient.getSummaries(collection, accessScopeForRequest(req), {
        ...(prefix !== undefined ? { pathPrefix: prefix } : {}),
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(offset.value !== undefined ? { offset: offset.value } : {}),
      });
      if (!result.ok) {
        log.warn({ error: result.error }, "get_summaries failed");
        emitQueryActivity({
          req,
          tool: "get_summaries",
          summary: `${collection}${prefix ? " " + prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, path_prefix: prefix, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      const { summaries, total } = result.result;
      emitQueryActivity({
        req,
        tool: "get_summaries",
        summary: `${summaries.length} of ${total} summar${total === 1 ? "y" : "ies"} in ${collection}${prefix ? " " + prefix : ""}`,
        status: "ok",
        startTime,
        detail: { collection, path_prefix: prefix, count: summaries.length, total },
      });
      res.status(200).json({ status: "ok", summaries, count: summaries.length, total });
    } catch (err) {
      next(err);
    }
  };

  // ── GET /collection-stats ────────────────────────────────────────────────
  const collectionStats: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const startTime = Date.now();
    try {
      const collection = col(req);
      const prefix = pathPrefix(req);

      const result = await postgresClient.getCollectionStats(collection, accessScopeForRequest(req), prefix);
      if (!result.ok) {
        log.warn({ error: result.error }, "collection_stats failed");
        emitQueryActivity({
          req,
          tool: "collection_stats",
          summary: `${collection}${prefix ? " " + prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection, path_prefix: prefix, error: result.error.message },
        });
        res.status(502).json({ error: result.error.message });
        return;
      }
      emitQueryActivity({
        req,
        tool: "collection_stats",
        summary: `${collection}${prefix ? " " + prefix : ""}`,
        status: "ok",
        startTime,
        detail: { collection, path_prefix: prefix, stats: result.result },
      });
      res.status(200).json({ status: "ok", stats: result.result });
    } catch (err) {
      next(err);
    }
  };

  return {
    listDocuments,
    getDocument,
    getDocuments,
    listFolders,
    getSummary,
    getSummaries,
    collectionStats,
  };
}
