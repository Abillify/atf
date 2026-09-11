// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-file.ts
 *
 * `POST /ingest-file` — accept a binary document, have `@atf/extract` convert it,
 * and index the result through the existing ingest path.
 *
 * ## Why Search does not convert documents itself
 *
 * PDF and office conversion needs poppler and LibreOffice. Adding them to this
 * container would mean several hundred megabytes, a glibc base image instead of
 * Alpine, a writable HOME for the LibreOffice profile, and a document-parser
 * attack surface — all in the service that sits on the query path. Conversion is
 * also minutes-long and CPU-heavy, while Search scales on query latency; sharing
 * one process means they compete for the same pool and the same request timeout.
 *
 * So this route is a proxy, and a deliberately thin one.
 *
 * ## How thin
 *
 * The converter returns canonical Markdown. That Markdown is written back onto
 * the request as a `text/markdown` body, and the *existing* ingest handler runs
 * unchanged. Header parsing, collection resolution, ACLs, versioning, chunking,
 * embedding and upsert are all reused rather than reimplemented — the only thing
 * this file adds is one outbound HTTP call and the body swap.
 *
 * ## What this route does not do
 *
 * Figure *images* are not stored. The converter renders crops, but forwarding
 * Markdown does not carry bytes, and fetching each crop back would make this an
 * orchestrator rather than a proxy. Figure *descriptions* are in the Markdown as
 * `<figure>` entries, so they are chunked and retrievable — a search for what a
 * diagram shows still finds it, there is just no thumbnail to open.
 *
 * Callers that need stored crops use `POST /v1/ingest` on the converter itself,
 * which has the bytes in memory already and uploads them via
 * `PUT /document-assets/:assetId`. That difference is the whole reason both
 * routes exist.
 */

import type { Request, RequestHandler } from "express";
import type { Logger } from "pino";
import type { ConverterConfig } from "../config.js";
import { readHeader } from "../header-utils.js";
import { encodeBase64 } from "../metadata.js";
import { injectTraceHeaders } from "../trace-context.js";

/** Document types the converter accepts, and therefore this route's body types. */
export const CONVERTIBLE_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "image/gif",
] as const;

/** Response header the converter uses to declare its output contract. */
const CONTRACT_HEADER = "x-extract-contract";

export interface IngestFileHandlerDeps {
  converter: ConverterConfig;
  logger: Logger;
  /**
   * The unmodified `POST /ingest` handler.
   *
   * Injected rather than imported so this file cannot accumulate a second copy
   * of the ingest contract: everything after conversion is literally the same
   * code path a Markdown caller takes.
   */
  ingestHandler: RequestHandler;
}

interface ConversionResult {
  markdown: string;
  contract: string | undefined;
  pageCount: string | undefined;
  figureCount: string | undefined;
}

/**
 * Merge converter provenance into the caller's `X-Metadata`.
 *
 * Provenance is what lets an operator answer "which converter version produced
 * the chunks in this collection" months later, and it is the reason the contract
 * keeps it out of the document body. Doing it here gives this route the same
 * provenance the converter's own ingest path records.
 *
 * The caller's keys win: a conflict means they set the field deliberately.
 */
function mergeProvenance(
  existing: string | undefined,
  provenance: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    const raw = existing.toLowerCase().startsWith("base64:")
      ? Buffer.from(existing.slice("base64:".length), "base64").toString("utf-8")
      : existing;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Leave the caller's value alone. It is invalid, and the ingest handler
      // will reject it with a message about X-Metadata rather than about this
      // route — which is the more useful error.
      return existing;
    }
  }
  const merged = JSON.stringify({ ...provenance, ...base });
  // Non-ASCII in a caller's metadata would make the header illegal.
  return /^[\x20-\x7E]*$/.test(merged) ? merged : `base64:${encodeBase64(merged)}`;
}

export function createIngestFileHandler(deps: IngestFileHandlerDeps): RequestHandler {
  const { converter, logger, ingestHandler } = deps;

  async function convert(req: Request, body: Buffer): Promise<ConversionResult> {
    const headers: Record<string, string> = {
      // Raw upload rather than multipart: no boundary to build here and none to
      // parse there.
      "content-type": req.headers["content-type"] ?? "application/octet-stream",
      // Markdown, not the JSON envelope: that string is exactly what gets
      // forwarded to the ingest path.
      accept: "text/markdown",
    };
    if (converter.token !== null) headers["authorization"] = `Bearer ${converter.token}`;

    const reference = readHeader(req, "x-reference");
    if (reference !== undefined) headers["x-reference"] = req.headers["x-reference"] as string;
    const title = req.headers["x-title"];
    if (typeof title === "string") headers["x-title"] = title;
    const filename = req.headers["x-filename"];
    if (typeof filename === "string") headers["x-filename"] = filename;
    const disposition = req.headers["content-disposition"];
    if (typeof disposition === "string") headers["content-disposition"] = disposition;
    injectTraceHeaders(headers);

    const controller = new AbortController();
    const timeout =
      converter.timeoutMs > 0 ? setTimeout(() => controller.abort(), converter.timeoutMs) : null;
    // A client that gave up should not keep a conversion running on their behalf.
    const onClose = (): void => controller.abort();
    req.on("aborted", onClose);

    try {
      const response = await fetch(`${converter.url}/v1/convert`, {
        method: "POST",
        headers,
        body: new Uint8Array(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // A converter 4xx is the caller's fault (unsupported type, too many
        // pages) and is passed through so they see why; a 5xx is ours and
        // becomes a 502.
        const status = response.status >= 400 && response.status < 500 ? response.status : 502;
        throw Object.assign(
          new Error(`The document converter returned HTTP ${response.status}`),
          { status, detail: detail.slice(0, 1000), converterStatus: response.status },
        );
      }

      return {
        markdown: await response.text(),
        contract: response.headers.get(CONTRACT_HEADER) ?? undefined,
        pageCount: response.headers.get("x-page-count") ?? undefined,
        figureCount: response.headers.get("x-figure-count") ?? undefined,
      };
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      const aborted = controller.signal.aborted;
      throw Object.assign(
        new Error(
          aborted
            ? `The document converter did not respond within ${converter.timeoutMs} ms`
            : `The document converter could not be reached: ${
                error instanceof Error ? error.message : String(error)
              }`,
        ),
        { status: aborted ? 504 : 502 },
      );
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      req.off("aborted", onClose);
    }
  }

  return (req, res, next) => {
    void (async () => {
      const log: Logger = (req as Request & { log?: Logger }).log ?? logger;

      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({
          error:
            "Send the raw document as the request body with its own Content-Type. " +
            `Supported: ${CONVERTIBLE_MIME_TYPES.join(", ")}`,
        });
        return;
      }

      // Checked here so a 40-page conversion is not paid for before discovering
      // the request could never have been indexed.
      if (!readHeader(req, "x-reference")) {
        res.status(400).json({ error: "X-Reference header is required" });
        return;
      }

      const startedAt = Date.now();
      log.info(
        { bytes: body.length, contentType: req.headers["content-type"] },
        "Converting an uploaded document before ingest",
      );

      const converted = await convert(req, body);

      log.info(
        {
          contract: converted.contract,
          pageCount: converted.pageCount,
          figureCount: converted.figureCount,
          markdownLength: converted.markdown.length,
          durationMs: Date.now() - startedAt,
        },
        "Document converted; handing off to the ingest path",
      );

      // Rewrite the request into the shape the ingest handler already accepts.
      // Everything downstream — header parsing, ACLs, chunking, embedding — is
      // the unmodified Markdown path.
      req.body = converted.markdown;
      req.headers["content-type"] = "text/markdown; charset=utf-8";
      req.headers["content-length"] = String(Buffer.byteLength(converted.markdown, "utf-8"));

      // The converter emits per-page <summary> blocks, so asking Search to
      // regenerate them would pay twice for worse summaries: the converter saw
      // the rendered page, Search only sees text.
      if (req.headers["x-summary-mode"] === undefined && /<summary\b/i.test(converted.markdown)) {
        req.headers["x-summary-mode"] = "embedded";
      }

      req.headers["x-metadata"] = mergeProvenance(readHeader(req, "x-metadata"), {
        ...(converted.contract !== undefined ? { extract_contract: converted.contract } : {}),
        extract_via: "search/ingest-file",
      });

      if (converted.contract !== undefined) {
        res.setHeader("X-Extract-Contract", converted.contract);
      }
      // Stated on every response, because "the figure descriptions are indexed
      // but the images are not" is the kind of limitation that is otherwise only
      // discovered when someone clicks a figure in a result.
      res.setHeader("X-Figure-Assets", "not-stored");

      ingestHandler(req, res, next);
    })().catch((error: unknown) => {
      const status =
        error instanceof Error && "status" in error && typeof error.status === "number"
          ? error.status
          : 502;
      const detail =
        error instanceof Error && "detail" in error && typeof error.detail === "string"
          ? error.detail
          : undefined;
      (req as Request & { log?: Logger }).log?.warn(
        { err: error, status, detail },
        "Document conversion failed",
      );
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.status(status).json({
        error: error instanceof Error ? error.message : "Document conversion failed",
        ...(detail !== undefined && detail !== "" ? { converter_detail: detail } : {}),
      });
    });
  };
}
