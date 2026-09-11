// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * convert.ts
 *
 * `POST /v1/convert` — an uploaded document in, canonical Markdown out.
 *
 * ## Three response modes for one operation
 *
 * A conversion takes seconds for a screenshot and tens of minutes for a
 * 200-page specification, so a single response shape cannot serve every caller.
 * The mode is selected by request headers rather than by separate routes, so a
 * caller changes one header instead of one URL:
 *
 *   `X-Callback-URL` present     → **async**. 202 immediately, result POSTed to
 *                                  the callback. The only mode that survives a
 *                                  proxy with a 60-second read timeout.
 *   `Accept: text/event-stream`  → **SSE**. Pages stream in reading order as they
 *                                  complete. What the UI uses, because a progress
 *                                  bar beats a spinner on a 40-page document.
 *   otherwise                    → **sync**. One response at the end.
 *
 * Sync returns JSON by default and Markdown for `Accept: text/markdown`. The
 * default is JSON because the envelope carries the figure geometry, per-page
 * warnings and token usage that a programmatic caller needs; Search's
 * `/ingest-file` proxy asks for Markdown because that is precisely what it
 * forwards to its own ingest path.
 *
 * ## Figure bytes are opt-in
 *
 * A 40-page document with four figures per page produces a multi-megabyte JSON
 * body once crops are base64-encoded, on a path where the bytes are usually
 * pushed straight to Search instead. `X-Include-Figure-Data: true` asks for them.
 */

import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import {
  EXTRACT_CONTRACT_HEADER,
  collectFigures,
  serializePage,
  type ConvertResponse,
  type ExtractedDocument,
  type ExtractedPage,
} from "@atf/extract-contract";
import { ExtractError, toErrorBody, validationError } from "../errors.js";
import { readHeader, parseBooleanHeader } from "../header-utils.js";
import { QueueSaturatedError, type WorkQueue } from "../queue.js";
import { readUpload, sanitizeFilename, type UploadedDocument } from "../upload.js";
import type { Extractor, ExtractResult } from "../pipeline/extract.js";
import type { FigureCrop } from "../pipeline/raster.js";
import { deliverCallback, resolveCallbackUrl, type CallbackConfig } from "./callback.js";

export interface ConvertHandlerConfig extends CallbackConfig {
  exposeErrorDetail: boolean;
}

export interface ConvertMetrics {
  recordDocument(mimeType: string, outcome: "ok" | "error"): void;
  recordQueueRejection(): void;
}

export interface ConvertHandlerDeps {
  extractor: Extractor;
  queue: WorkQueue;
  config: ConvertHandlerConfig;
  logger: Logger;
  metrics: ConvertMetrics;
}

/** Everything the handler derives from the request before doing work. */
export interface ConvertRequest {
  upload: UploadedDocument;
  reference: string;
  title: string | undefined;
  includeFigureData: boolean;
}

/**
 * Parse the request.
 *
 * `X-Reference` is optional here and defaults to the filename, because a caller
 * converting a document to read it back does not need a durable identity. It is
 * mandatory for ingest, where the reference *is* the row key.
 */
export function parseConvertRequest(req: Request): ConvertRequest {
  const upload = readUpload(req);
  const reference = readHeader(req, "x-reference")?.trim() || upload.filename;
  if (reference === "") throw validationError("X-Reference must not be empty");

  const includeFigureData = parseBooleanHeader(readHeader(req, "x-include-figure-data"));
  if (includeFigureData === null) {
    throw validationError("X-Include-Figure-Data must be one of: 1/0, true/false, yes/no, on/off");
  }

  const title = readHeader(req, "x-title")?.trim();
  return {
    upload,
    reference,
    title: title === undefined || title === "" ? undefined : sanitizeFilename(title),
    includeFigureData: includeFigureData ?? false,
  };
}

/** Build the JSON envelope, optionally embedding the crops. */
export function buildConvertResponse(
  result: ExtractResult,
  includeFigureData: boolean,
): ConvertResponse {
  const document = includeFigureData ? embedFigureData(result) : result.document;
  return { ...document, markdown: result.markdown };
}

function embedFigureData(result: ExtractResult): ExtractedDocument {
  return {
    ...result.document,
    pages: result.document.pages.map((page) => ({
      ...page,
      figures: page.figures.map((figure) => {
        const crop = result.crops.get(figure.id);
        return crop === undefined
          ? figure
          : { ...figure, dataBase64: Buffer.from(crop.buffer).toString("base64") };
      }),
    })),
  };
}

/** Headers describing the result, useful on both the JSON and Markdown paths. */
function setResultHeaders(res: Response, document: ExtractedDocument, figureCount: number): void {
  res.setHeader(EXTRACT_CONTRACT_HEADER, document.contract);
  res.setHeader("X-Page-Count", String(document.pageCount));
  res.setHeader("X-Figure-Count", String(figureCount));
  if (document.pipeline.visionModel !== undefined) {
    res.setHeader("X-Vision-Model", document.pipeline.visionModel);
  }
  if (document.warnings.length > 0) {
    res.setHeader("X-Extract-Warnings", String(document.warnings.length));
  }
}

/** True when the client asked for Markdown rather than the JSON envelope. */
function wantsMarkdown(req: Request): boolean {
  const accept = (req.headers["accept"] ?? "").toLowerCase();
  if (accept.includes("application/json")) return false;
  return accept.includes("text/markdown") || accept.includes("text/plain");
}

export function createConvertHandler(deps: ConvertHandlerDeps): RequestHandler {
  const { extractor, queue, config, logger, metrics } = deps;

  /** Abort the conversion when the client goes away, so the slot is released. */
  function abortOnDisconnect(req: Request, res: Response): AbortController {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    req.on("aborted", () => controller.abort());
    return controller;
  }

  async function runConversion(
    parsed: ConvertRequest,
    signal: AbortSignal,
    onPage?: (page: ExtractedPage, crops: ReadonlyMap<string, FigureCrop>) => void | Promise<void>,
  ): Promise<ExtractResult> {
    return queue.submit(async () => {
      try {
        const result = await extractor.extract({
          buffer: parsed.upload.buffer,
          filename: parsed.upload.filename,
          declaredMimeType: parsed.upload.declaredMimeType,
          reference: parsed.reference,
          title: parsed.title,
          signal,
          ...(onPage !== undefined ? { onPage } : {}),
        });
        metrics.recordDocument(result.document.source.mimeType, "ok");
        return result;
      } catch (error) {
        metrics.recordDocument(parsed.upload.declaredMimeType ?? "unknown", "error");
        throw error;
      }
    });
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  async function handleSync(
    req: Request,
    res: Response,
    parsed: ConvertRequest,
  ): Promise<void> {
    const controller = abortOnDisconnect(req, res);
    const result = await runConversion(parsed, controller.signal);
    if (res.writableEnded) return;

    const figureCount = collectFigures(result.document).length;
    setResultHeaders(res, result.document, figureCount);

    if (wantsMarkdown(req)) {
      res.status(200).type("text/markdown; charset=utf-8").send(result.markdown);
      return;
    }
    res.status(200).json(buildConvertResponse(result, parsed.includeFigureData));
  }

  // ── SSE ───────────────────────────────────────────────────────────────────
  async function handleStream(
    req: Request,
    res: Response,
    parsed: ConvertRequest,
  ): Promise<void> {
    const controller = abortOnDisconnect(req, res);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Without this, nginx buffers the whole stream and the client sees nothing
    // until the conversion is finished — which defeats the entire mode.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // A page can take minutes. Comment frames keep intermediaries from closing
    // an apparently idle connection.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 15_000);

    try {
      send("accepted", { reference: parsed.reference, filename: parsed.upload.filename });

      const result = await runConversion(parsed, controller.signal, (page) => {
        send("progress", {
          type: "progress",
          page: page.page,
          // The serialized page, so a client can append it verbatim and end up
          // with exactly the document the sync mode would have returned.
          markdown: serializePage(page),
          figures: page.figures,
          warnings: page.warnings,
        });
      });

      send("done", buildConvertResponse(result, parsed.includeFigureData));
    } catch (error) {
      const errorId = randomUUID();
      logger.error({ err: error, errorId, reference: parsed.reference }, "Streamed conversion failed");
      send("error", toErrorBody(error, errorId, config.exposeErrorDetail));
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  // ── async ─────────────────────────────────────────────────────────────────
  // No `req` parameter, deliberately: the response is sent before the conversion
  // starts, so anything read from the request afterwards would be read from a
  // connection that may already be gone. Everything needed is in `parsed`.
  async function handleAsync(
    res: Response,
    parsed: ConvertRequest,
    rawCallbackUrl: string,
  ): Promise<void> {
    const callbackUrl = resolveCallbackUrl(rawCallbackUrl, config);
    const jobId = randomUUID();

    res.status(202).json({
      status: "accepted",
      job_id: jobId,
      reference: parsed.reference,
      callback_url: callbackUrl.toString(),
    });

    // Deliberately detached: the response has already been sent, so nothing here
    // can be reported to the caller except through the callback.
    void (async () => {
      const controller = new AbortController();
      try {
        const result = await runConversion(parsed, controller.signal);
        await deliverCallback({
          url: callbackUrl,
          jobId,
          body: { status: "completed", job_id: jobId, ...buildConvertResponse(result, parsed.includeFigureData) },
          config,
          logger,
        });
      } catch (error) {
        const errorId = randomUUID();
        logger.error(
          { err: error, errorId, jobId, reference: parsed.reference },
          "Asynchronous conversion failed",
        );
        await deliverCallback({
          url: callbackUrl,
          jobId,
          body: {
            status: "failed",
            job_id: jobId,
            reference: parsed.reference,
            ...toErrorBody(error, errorId, config.exposeErrorDetail),
          },
          config,
          logger,
        }).catch(() => {
          // Already logged inside deliverCallback; there is nobody else to tell.
        });
      }
    })();
  }

  return (req, res, next) => {
    let parsed: ConvertRequest;
    try {
      parsed = parseConvertRequest(req);
    } catch (error) {
      next(error);
      return;
    }

    const callbackUrl = readHeader(req, "x-callback-url");
    const accept = (req.headers["accept"] ?? "").toLowerCase();

    const run =
      callbackUrl !== undefined && callbackUrl.trim() !== ""
        ? handleAsync(res, parsed, callbackUrl.trim())
        : accept.includes("text/event-stream")
          ? handleStream(req, res, parsed)
          : handleSync(req, res, parsed);

    run.catch((error: unknown) => {
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
        // An SSE or streaming response already reported the failure to the
        // client; re-entering the error middleware would try to write headers
        // that are long gone.
        if (!res.writableEnded) res.end();
        return;
      }
      next(error);
    });
  };
}

/** Re-exported so the ingest handler shares the same request parsing. */
export { ExtractError };
