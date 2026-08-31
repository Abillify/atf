// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { PostgresClient } from "../postgres-client.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { SummaryClient } from "../summary-client.js";
import {
  accessScopeForRequest,
  scopeAllowsAcl,
} from "../access-scope.js";

export function createAdminStatsHandler(
  postgresClient: PostgresClient,
  logger?: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const collection = req.query["collection"] as string | undefined;
      const type = req.query["type"] as string | undefined;

      // Fix #13: expose limit as a query parameter (default 100, max 1000).
      const rawLimit = req.query["limit"];
      const parsedLimit =
        rawLimit !== undefined ? parseInt(String(rawLimit), 10) : 100;
      if (isNaN(parsedLimit) || parsedLimit <= 0 || parsedLimit > 1000) {
        res
          .status(400)
          .json({ error: "Limit must be a number between 1 and 1000" });
        return;
      }

      // Fix #13: expose offset/page for basic pagination.
      const rawOffset = req.query["offset"];
      const parsedOffset =
        rawOffset !== undefined ? parseInt(String(rawOffset), 10) : 0;
      if (isNaN(parsedOffset) || parsedOffset < 0) {
        res
          .status(400)
          .json({ error: "Offset must be a non-negative integer" });
        return;
      }

      let ingestStats, searchStats;
      const scope = accessScopeForRequest(req);

      if (!type || type === "ingest") {
        const ingestResult = await postgresClient.getIngestStats(
          scope,
          collection,
          parsedLimit,
          parsedOffset,
        );
        if (!ingestResult.ok) {
          log.warn({ error: ingestResult.error }, "Failed to get ingest stats");
          res
            .status(502)
            .json({ error: `PostgreSQL error: ${ingestResult.error.message}` });
          return;
        }
        ingestStats = ingestResult.result;
      }

      if (!type || type === "search") {
        const searchResult = await postgresClient.getSearchStats(
          scope,
          collection,
          parsedLimit,
          parsedOffset,
        );
        if (!searchResult.ok) {
          log.warn({ error: searchResult.error }, "Failed to get search stats");
          res
            .status(502)
            .json({ error: `PostgreSQL error: ${searchResult.error.message}` });
          return;
        }
        searchStats = searchResult.result;
      }

      const response: Record<string, unknown> = {
        status: "ok",
        limit: parsedLimit,
        offset: parsedOffset,
      };
      if (ingestStats !== undefined) response["ingest_stats"] = ingestStats;
      if (searchStats !== undefined) response["search_stats"] = searchStats;

      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  };
}

export interface HealthCheckDeps {
  postgresClient: PostgresClient;
  embeddingClient?: EmbeddingClient;
  /** Human-readable name → probe function. Return null = healthy. */
  extraProbes?: Record<string, () => Promise<string | null>>;
}

/**
 * Granular health handler (Fix #14).
 *
 * Response shape:
 *   200 { status: "healthy",   checks: { database: "ok", embedding: "ok", … },
 *         circuit_breakers: { embedding: "CLOSED", reranker: "OPEN", … } }
 *   503 { status: "unhealthy", checks: { database: "connection failed", … },
 *         circuit_breakers: { … } }
 *
 * Individual check failures are surfaced per-component so callers can
 * distinguish "DB is down" from "embedding server is slow" or
 * "circuit breaker tripped".
 *
 * Circuit breaker states are always included in the response — even when all
 * checks pass — so Kubernetes probes and monitoring dashboards can track
 * degraded-but-not-dead states without hitting /metrics.
 */
export function createHealthHandler(
  postgresClientOrDeps: PostgresClient | HealthCheckDeps,
  logger?: Logger,
): RequestHandler {
  // Support both the old single-arg signature and the new HealthCheckDeps shape.
  const deps: HealthCheckDeps =
    "ping" in postgresClientOrDeps
      ? { postgresClient: postgresClientOrDeps as PostgresClient }
      : (postgresClientOrDeps as HealthCheckDeps);

  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const checks: Record<string, string> = {};
      let allHealthy = true;

      // ── Database check ──────────────────────────────────────────────────
      const pingResult = await deps.postgresClient.ping();
      if (pingResult.ok) {
        checks["database"] = "ok";
      } else {
        checks["database"] = pingResult.error.message;
        allHealthy = false;
        log.warn({ error: pingResult.error }, "Health check: database failed");
      }

      // ── Embedding server check (probe only — no actual embedding) ────────
      // Uses a lightweight embed call with a short text to verify reachability.
      // Failures are reported but do NOT mark the service unhealthy on their
      // own — the DB is the source of truth for readiness.
      if (deps.embeddingClient) {
        try {
          const embedResult = await deps.embeddingClient.embed("health");
          checks["embedding"] = embedResult.ok
            ? "ok"
            : embedResult.error.message;
          if (!embedResult.ok) {
            log.warn(
              { error: embedResult.error },
              "Health check: embedding server degraded",
            );
          }
        } catch (err) {
          checks["embedding"] = err instanceof Error ? err.message : "error";
          log.warn({ err }, "Health check: embedding server probe threw");
        }
      }

      // ── Extra probes (reranker, SPLADE, etc.) ────────────────────────────
      if (deps.extraProbes) {
        for (const [name, probe] of Object.entries(deps.extraProbes)) {
          try {
            const failure = await probe();
            checks[name] = failure ?? "ok";
          } catch (err) {
            checks[name] = err instanceof Error ? err.message : "error";
          }
        }
      }

      // ── Circuit breaker states ───────────────────────────────────────────
      // Report the state of every downstream service circuit breaker so
      // monitoring tools can detect degraded (OPEN/HALF_OPEN) states without
      // waiting for the next /metrics scrape.
      const circuitBreakerStatuses =
        deps.postgresClient.getCircuitBreakerStatuses();
      const circuitBreakers: Record<
        string,
        { state: string; failures: number }
      > = {};
      for (const cb of circuitBreakerStatuses) {
        circuitBreakers[cb.name] = { state: cb.state, failures: cb.failures };
        // A tripped circuit breaker marks the service as degraded, not unhealthy,
        // since it protects the system rather than causing it to fail.
        if (cb.state === "OPEN") {
          checks[`circuit_breaker_${cb.name}`] = "OPEN — requests paused";
        }
      }

      const status = allHealthy ? "healthy" : "unhealthy";
      res.status(allHealthy ? 200 : 503).json({
        status,
        timestamp: new Date().toISOString(),
        checks,
        ...(circuitBreakerStatuses.length > 0
          ? { circuit_breakers: circuitBreakers }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  };
}

export function createListCollectionsHandler(
  postgresClient: PostgresClient,
  logger?: Logger,
  options: { filterByAcl?: boolean } = {},
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const scope = accessScopeForRequest(req);
      const result = await postgresClient.listCollections(scope);
      if (!result.ok) {
        log.warn({ error: result.error }, "Failed to list collections");
        res
          .status(502)
          .json({ error: `PostgreSQL error: ${result.error.message}` });
        return;
      }
      const collections = options.filterByAcl
        ? result.result.filter((collection) => {
            if (
              scope.scopes.includes("knowledge") &&
              !scope.scopes.includes(`kb:${collection.collection}`)
            ) {
              return false;
            }
            return scopeAllowsAcl(scope, {
              allowedUsers: collection.allowedUsers,
              allowedGroups: collection.allowedGroups,
            });
          })
        : result.result;
      res.status(200).json({ status: "ok", collections });
    } catch (err) {
      next(err);
    }
  };
}

export function createDeleteCollectionHandler(
  postgresClient: PostgresClient,
  logger?: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const name = (req.params as { name?: string })["name"];
      if (!name || name.trim() === "") {
        res.status(400).json({ error: "Collection name is required" });
        return;
      }

      const result = await postgresClient.deleteCollection(name);
      if (!result.ok) {
        const status =
          result.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502;
        log.warn({ error: result.error }, "Failed to delete collection");
        res.status(status).json({ error: result.error.message });
        return;
      }

      log.info({ collection: name }, "Collection deleted");
      res.status(200).json({ status: "ok", dropped: result.result.dropped });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * POST /collections/:name/rename
 * Body: { "new_name": "my_new_collection" }
 *
 * Renames a collection table and updates the vs_collection_config row.
 * Both operations are wrapped in a transaction so partial renames are impossible.
 * Returns 400 for invalid names, 404 when the source collection does not exist.
 */
export function createRenameCollectionHandler(
  postgresClient: PostgresClient,
  logger?: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const oldName = (req.params as { name?: string })["name"];
      if (!oldName || oldName.trim() === "") {
        res.status(400).json({ error: "Collection name is required" });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const newName =
        typeof body?.["new_name"] === "string" ? body["new_name"].trim() : "";
      if (!newName) {
        res
          .status(400)
          .json({ error: "Request body must contain a non-empty new_name" });
        return;
      }
      if (oldName === newName) {
        res
          .status(400)
          .json({ error: "new_name must differ from the current name" });
        return;
      }

      const result = await postgresClient.renameCollection(oldName, newName);
      if (!result.ok) {
        const status =
          result.error.code === "INVALID_COLLECTION_NAME"
            ? 400
            : result.error.code === "COLLECTION_NOT_FOUND"
              ? 404
              : 502;
        log.warn({ error: result.error }, "Failed to rename collection");
        res.status(status).json({ error: result.error.message });
        return;
      }

      log.info(
        { from: oldName, to: newName },
        "Collection renamed successfully",
      );
      res.status(200).json({ status: "ok", from: oldName, to: newName });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * POST /collections/:name/backfill-summaries
 *
 * For every document/chapter in the collection whose chunk-0 row has no
 * `prefix` (i.e. never received a summary), reassemble its text, generate a
 * summary via the configured summary model, and store it in the `prefix`
 * column (also flagging chunk.summary = true and merging the summary into the
 * FTS vector).
 *
 * Returns 503 when no summary model is configured. Processes documents
 * sequentially — the summary client's own concurrency semaphore and circuit
 * breaker still apply — and logs progress to stdout so long runs are visible.
 *
 * Optional query param `limit` caps how many documents are processed in one
 * call (default: all missing).
 */
export function createBackfillSummariesHandler(
  postgresClient: PostgresClient,
  summaryClient: SummaryClient | null,
  logger?: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      if (summaryClient === null) {
        res.status(503).json({
          error:
            "Summarization is not configured. Set SUMMARY_MODEL to enable summary backfill.",
        });
        return;
      }

      const name = (req.params as { name?: string })["name"];
      if (!name || name.trim() === "") {
        res.status(400).json({ error: "Collection name is required" });
        return;
      }

      const rawLimit = req.query["limit"];
      let limit = Number.POSITIVE_INFINITY;
      if (rawLimit !== undefined) {
        const parsed = parseInt(String(rawLimit), 10);
        if (isNaN(parsed) || parsed <= 0) {
          res
            .status(400)
            .json({ error: "limit must be a positive integer" });
          return;
        }
        limit = parsed;
      }

      const scope = accessScopeForRequest(req);
      const listResult = await postgresClient.listDocumentsMissingSummary(name, scope);
      if (!listResult.ok) {
        const status =
          listResult.error.code === "INVALID_COLLECTION_NAME"
            ? 400
            : listResult.error.code === "COLLECTION_NOT_FOUND"
              ? 404
              : 502;
        log.warn(
          { error: listResult.error },
          "Backfill: failed to list documents missing summary",
        );
        res.status(status).json({ error: listResult.error.message });
        return;
      }

      const allRefs = listResult.result;
      const refs = allRefs.slice(0, limit === Infinity ? allRefs.length : limit);

      log.info(
        { collection: name, missing: allRefs.length, processing: refs.length },
        "Backfill: starting summary backfill",
      );

      // Stream progress as NDJSON so the UI can render a live progress bar.
      // Once the first line is written the status code is locked at 200, so
      // all validation that could fail (auth, name, limit, listing) happened
      // above and returned proper JSON error codes.
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      // Disable proxy buffering (nginx) so progress lines arrive immediately.
      res.setHeader("X-Accel-Buffering", "no");
      res.status(200);
      res.flushHeaders?.();

      const write = (event: Record<string, unknown>): void => {
        res.write(JSON.stringify(event) + "\n");
      };

      // Stop early if the client disconnects (closed tab, aborted fetch).
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

      write({
        type: "start",
        collection: name,
        missing: allRefs.length,
        processed: refs.length,
      });

      let updated = 0;
      let failed = 0;

      for (let i = 0; i < refs.length; i++) {
        if (aborted) {
          log.warn(
            { collection: name, processedSoFar: i },
            "Backfill: client disconnected, stopping",
          );
          break;
        }
        const ref = refs[i]!;
        log.info(
          { collection: name, reference: ref, index: i + 1, total: refs.length },
          "Backfill: processing document",
        );

        const emitProgress = (
          status: "updated" | "failed",
          error?: string,
        ): void => {
          write({
            type: "progress",
            index: i + 1,
            total: refs.length,
            reference: ref,
            status,
            updated,
            failed,
            ...(error ? { error } : {}),
          });
        };

        const textResult = await postgresClient.getDocumentText(name, ref, scope);
        if (!textResult.ok) {
          failed++;
          log.warn(
            { collection: name, reference: ref, error: textResult.error },
            "Backfill: failed to load document text",
          );
          emitProgress("failed", textResult.error.message);
          continue;
        }
        const content = textResult.result.content;
        if (!content || content.trim() === "") {
          failed++;
          emitProgress("failed", "Document has no text content");
          continue;
        }

        log.info(
          { collection: name, reference: ref, contentLength: content.length },
          "Backfill: summarizing",
        );
        const summaryRes = await summaryClient.summarize(content);
        if (!summaryRes.ok) {
          failed++;
          log.warn(
            { collection: name, reference: ref, error: summaryRes.error },
            "Backfill: summary generation failed",
          );
          emitProgress("failed", summaryRes.error.message);
          continue;
        }

        const setResult = await postgresClient.setDocumentSummary(
          name,
          ref,
          summaryRes.result,
          scope,
        );
        if (!setResult.ok) {
          failed++;
          log.warn(
            { collection: name, reference: ref, error: setResult.error },
            "Backfill: failed to store summary",
          );
          emitProgress("failed", setResult.error.message);
          continue;
        }
        updated++;
        log.info(
          {
            collection: name,
            reference: ref,
            summaryLength: summaryRes.result.length,
            rowsUpdated: setResult.result.updated,
          },
          "Backfill: summary stored",
        );
        emitProgress("updated");
      }

      log.info(
        { collection: name, updated, failed, total: refs.length, aborted },
        "Backfill: finished",
      );

      write({
        type: "done",
        collection: name,
        missing: allRefs.length,
        processed: updated + failed,
        updated,
        failed,
        aborted,
      });
      res.end();
    } catch (err) {
      // If streaming already started, headers are sent — just terminate the
      // stream with a final error line instead of delegating to the JSON
      // error handler (which would throw "headers already sent").
      if (res.headersSent) {
        try {
          res.write(
            JSON.stringify({ type: "error", error: (err as Error).message }) + "\n",
          );
        } catch {
          /* ignore */
        }
        res.end();
        return;
      }
      next(err);
    }
  };
}

/**
 * GET /collections/:name/permissions
 *
 * Return the collection-level ACL. Empty arrays mean the collection is public.
 */
export function createGetCollectionPermissionsHandler(
  postgresClient: PostgresClient,
  logger?: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const name = (req.params as { name?: string })["name"];
      if (!name || name.trim() === "") {
        res.status(400).json({ error: "Collection name is required" });
        return;
      }
      const result = await postgresClient.getCollectionAcl(name);
      if (!result.ok) {
        const status =
          result.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502;
        log.warn({ error: result.error }, "Failed to load collection permissions");
        res.status(status).json({ error: result.error.message });
        return;
      }
      res.status(200).json({
        status: "ok",
        collection: name,
        allowed_users: result.result.allowedUsers,
        allowed_groups: result.result.allowedGroups,
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * PUT /collections/:name/permissions
 * Body: { "allowed_users": ["alice"], "allowed_groups": ["legal"] }
 *
 * Replace the collection-level ACL. Both arrays are optional and default to
 * empty; setting both to empty makes the collection public again. Returns 404
 * when the collection has no config row yet (i.e. it does not exist).
 */
export function createSetCollectionPermissionsHandler(
  postgresClient: PostgresClient,
  logger?: Logger,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger!;
    try {
      const name = (req.params as { name?: string })["name"];
      if (!name || name.trim() === "") {
        res.status(400).json({ error: "Collection name is required" });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const parseList = (v: unknown, field: string): string[] | { error: string } => {
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
          return { error: `${field} must be an array of strings` };
        }
        return v as string[];
      };
      const users = parseList(body["allowed_users"], "allowed_users");
      if (!Array.isArray(users)) {
        res.status(400).json({ error: users.error });
        return;
      }
      const groups = parseList(body["allowed_groups"], "allowed_groups");
      if (!Array.isArray(groups)) {
        res.status(400).json({ error: groups.error });
        return;
      }

      const result = await postgresClient.setCollectionAcl(name, users, groups);
      if (!result.ok) {
        const status =
          result.error.code === "INVALID_COLLECTION_NAME"
            ? 400
            : result.error.code === "COLLECTION_NOT_FOUND"
              ? 404
              : 502;
        log.warn({ error: result.error }, "Failed to set collection permissions");
        res.status(status).json({ error: result.error.message });
        return;
      }

      log.info(
        { collection: name, allowedUsers: users, allowedGroups: groups },
        "Collection permissions updated",
      );
      res.status(200).json({
        status: "ok",
        collection: name,
        allowed_users: users,
        allowed_groups: groups,
      });
    } catch (err) {
      next(err);
    }
  };
}
