// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-file.ts
 *
 * `POST /ingest-file` — accept a binary document and hand it to `@atf/extract`
 * as a v2 job (task 1.14, requirement 17.2).
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
 * So this route is a client of Extract, and a deliberately thin one.
 *
 * ## What changed from the v1 proxy
 *
 * The old route proxied the binary to Extract's `/v1/convert`, took the returned
 * Markdown, and fed it to the existing `/ingest` path. That forwarded figure
 * *descriptions* but dropped figure *bytes* — the response said so with
 * `X-Figure-Assets: not-stored`.
 *
 * This route now starts a v2 job at Extract instead:
 *
 *   1. Upload the source bytes to Extract's content-addressed store via the
 *      resumable upload protocol (`POST /v2/uploads` → `PATCH` → `complete`).
 *      Search holds the whole body already, so it sends it as one chunk.
 *   2. Create a job (`POST /v2/jobs`) for the stored source and return the job
 *      id. The caller polls `GET {converter}/v2/jobs/{id}` for progress.
 *
 * The Extract job drives render → vision → parse → emit, and its emitter streams
 * revisions *and figure assets* into Search's own revision API. So figure images
 * are now stored — the gap the `X-Figure-Assets: not-stored` note documented is
 * closed, and the header is gone.
 *
 * ## Auth / ACL
 *
 * The route keeps the same auth → scope → collection-ACL middleware chain in
 * `index.ts`. This handler adds only the outbound calls to Extract; it does not
 * re-implement any authorization.
 */

import { createHash } from "node:crypto";
import { createClientTlsInit } from "@atf/security-kit";
import type { Request, RequestHandler } from "express";
import type { Logger } from "pino";
import type { ConverterConfig } from "../config.js";
import { readHeader } from "../header-utils.js";
import { injectTraceHeaders } from "../trace-context.js";

/** Document types Extract accepts, and therefore this route's body types. */
export const CONVERTIBLE_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/webp",
] as const;

export interface IngestFileHandlerDeps {
  converter: ConverterConfig;
  logger: Logger;
}

/** An HTTP error carrying the status this handler should surface. */
function httpError(message: string, status: number, detail?: string): Error {
  return Object.assign(new Error(message), {
    status,
    ...(detail !== undefined ? { detail: detail.slice(0, 1000) } : {}),
  });
}

export function createIngestFileHandler(
  deps: IngestFileHandlerDeps,
): RequestHandler {
  const { converter, logger } = deps;
  // Optional private-CA trust for the converter endpoint (Req 11.8): an
  // undefined fragment keeps platform-default TLS, so spreading is always safe.
  const tlsInit = createClientTlsInit({ caCertFile: converter.caCertFile });

  /** Common headers for a call to Extract: auth + trace propagation. */
  function extractHeaders(
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...extra,
      ...(converter.token !== null
        ? { authorization: `Bearer ${converter.token}` }
        : {}),
    };
    injectTraceHeaders(headers);
    return headers;
  }

  /** One fetch to Extract, translating transport failures into HTTP statuses. */
  async function callExtract(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    aborted: () => boolean,
    label: string,
  ): Promise<Response> {
    try {
      return await fetch(`${converter.url}${path}`, {
        ...init,
        ...(tlsInit ?? {}),
        signal,
      });
    } catch (error) {
      throw httpError(
        aborted()
          ? `Extract did not respond within ${converter.timeoutMs} ms (${label})`
          : `Extract could not be reached (${label}): ${
              error instanceof Error ? error.message : String(error)
            }`,
        aborted() ? 504 : 502,
      );
    }
  }

  /**
   * Store the body in Extract's content-addressed source store via the
   * resumable protocol, sending the whole buffer as a single chunk. Returns the
   * whole-file sha256 the job is then created against.
   */
  async function uploadSource(
    body: Buffer,
    reference: string,
    signal: AbortSignal,
    aborted: () => boolean,
  ): Promise<string> {
    const sha256 = createHash("sha256").update(body).digest("hex");

    // 1. Open a session, declaring the reference, whole-file digest and size.
    const open = await callExtract(
      "/v2/uploads",
      {
        method: "POST",
        headers: extractHeaders({
          "content-type": "application/json",
          "x-reference": reference,
        }),
        body: JSON.stringify({ reference, sha256, size: body.length }),
      },
      signal,
      aborted,
      "open upload",
    );
    if (!open.ok) {
      const detail = await open.text().catch(() => "");
      throw httpError(
        `Extract rejected the upload session (HTTP ${open.status})`,
        open.status >= 400 && open.status < 500 ? open.status : 502,
        detail,
      );
    }
    const opened = (await open.json().catch(() => ({}))) as {
      upload_id?: string;
      status?: string;
      sha256?: string;
    };
    // A `source_url` open would complete inline, but this path always opens a
    // chunk session, so an upload_id is expected.
    if (typeof opened.upload_id !== "string") {
      throw httpError("Extract did not return an upload id", 502);
    }
    const uploadId = opened.upload_id;

    // 2. Append the whole body at offset 0.
    const patch = await callExtract(
      `/v2/uploads/${uploadId}`,
      {
        method: "PATCH",
        headers: extractHeaders({
          "content-type": "application/offset+octet-stream",
          "upload-offset": "0",
        }),
        body: new Uint8Array(body),
      },
      signal,
      aborted,
      "append chunk",
    );
    if (!patch.ok && patch.status !== 204) {
      const detail = await patch.text().catch(() => "");
      throw httpError(
        `Extract rejected the upload chunk (HTTP ${patch.status})`,
        patch.status >= 400 && patch.status < 500 ? patch.status : 502,
        detail,
      );
    }

    // 3. Complete: verify the whole-file digest and move it into the store.
    const complete = await callExtract(
      `/v2/uploads/${uploadId}/complete`,
      {
        method: "POST",
        headers: extractHeaders({
          "content-type": "application/json",
          "x-checksum-sha256": sha256,
        }),
        body: JSON.stringify({ sha256 }),
      },
      signal,
      aborted,
      "complete upload",
    );
    if (!complete.ok) {
      const detail = await complete.text().catch(() => "");
      throw httpError(
        `Extract could not finalise the upload (HTTP ${complete.status})`,
        complete.status >= 400 && complete.status < 500 ? complete.status : 502,
        detail,
      );
    }
    const finished = (await complete.json().catch(() => ({}))) as {
      sha256?: string;
    };
    return typeof finished.sha256 === "string" ? finished.sha256 : sha256;
  }

  /** Create a v2 job for the stored source and return the wire Job. */
  async function createJob(
    req: Request,
    reference: string,
    sourceSha256: string,
    attributes: Record<string, unknown>,
    signal: AbortSignal,
    aborted: () => boolean,
  ): Promise<{ jobId: string; status: string; collection?: string }> {
    const collection = readHeader(req, "x-collection")?.trim();
    const jobBody: Record<string, unknown> = {
      reference,
      sourceSha256,
      ...(collection !== undefined && collection !== "" ? { collection } : {}),
      ...attributes,
    };

    const res = await callExtract(
      "/v2/jobs",
      {
        method: "POST",
        headers: extractHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(jobBody),
      },
      signal,
      aborted,
      "create job",
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw httpError(
        `Extract rejected the job (HTTP ${res.status})`,
        res.status >= 400 && res.status < 500 ? res.status : 502,
        detail,
      );
    }
    const job = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      status?: string;
      collection?: string;
    };
    if (typeof job.jobId !== "string") {
      throw httpError("Extract did not return a job id", 502);
    }
    return {
      jobId: job.jobId,
      status: job.status ?? "queued",
      ...(typeof job.collection === "string"
        ? { collection: job.collection }
        : {}),
    };
  }

  return (req, res, _next) => {
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

      const reference = readHeader(req, "x-reference")?.trim();
      if (reference === undefined || reference === "") {
        res.status(400).json({ error: "X-Reference header is required" });
        return;
      }

      // Parsed before any upload, so a malformed header costs no transfer.
      const attributes = documentAttributeHeaders(req);

      const controller = new AbortController();
      const timeout =
        converter.timeoutMs > 0
          ? setTimeout(() => controller.abort(), converter.timeoutMs)
          : null;
      const onClose = (): void => controller.abort();
      req.on("aborted", onClose);
      const isAborted = (): boolean => controller.signal.aborted;

      const startedAt = Date.now();
      log.info(
        {
          bytes: body.length,
          contentType: req.headers["content-type"],
          reference,
        },
        "Starting a v2 extraction job for an uploaded document",
      );

      try {
        const sourceSha256 = await uploadSource(
          body,
          reference,
          controller.signal,
          isAborted,
        );
        const job = await createJob(
          req,
          reference,
          sourceSha256,
          attributes,
          controller.signal,
          isAborted,
        );

        log.info(
          {
            jobId: job.jobId,
            reference,
            sourceSha256,
            durationMs: Date.now() - startedAt,
          },
          "v2 extraction job started; assets are stored by the job's emitter",
        );

        res.setHeader("Location", `${converter.url}/v2/jobs/${job.jobId}`);
        res.status(202).json({
          status: "accepted",
          job_id: job.jobId,
          job_status: job.status,
          reference,
          ...(job.collection !== undefined
            ? { collection: job.collection }
            : {}),
          poll: `/v2/jobs/${job.jobId}`,
        });
      } finally {
        if (timeout !== null) clearTimeout(timeout);
        req.off("aborted", onClose);
      }
    })().catch((error: unknown) => {
      const status =
        error instanceof Error &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 502;
      const detail =
        error instanceof Error &&
        "detail" in error &&
        typeof error.detail === "string"
          ? error.detail
          : undefined;
      (req as Request & { log?: Logger }).log?.warn(
        { err: error, status, detail },
        "Starting the extraction job failed",
      );
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.status(status).json({
        error:
          error instanceof Error
            ? error.message
            : "Starting the extraction job failed",
        ...(detail !== undefined && detail !== ""
          ? { extract_detail: detail }
          : {}),
      });
    });
  };
}

/**
 * The document attributes and identity inputs of a file ingest, read from the
 * same headers Search's `/ingest` takes and mapped onto the Extract job
 * (contract 2.2): X-Title, X-Tags, X-Metadata, X-Link, X-Source, X-Version,
 * X-Source-Modified and X-Dedup. Without them a file ingested through the v2
 * path would lose the tags and metadata the tag and metadata filters rely on.
 * An invalid X-Metadata is a 400, not a silently dropped header.
 */
export function documentAttributeHeaders(req: Request): Record<string, unknown> {
  const text = (name: string): string | undefined => {
    const value = readHeader(req, name)?.trim();
    return value !== undefined && value !== "" ? value : undefined;
  };
  const tags = (text("x-tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  let metadata: Record<string, unknown> | undefined;
  const metadataRaw = text("x-metadata");
  if (metadataRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(metadataRaw);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError("X-Metadata must be a JSON object", 400);
    }
    metadata = parsed as Record<string, unknown>;
  }
  const dedup = text("x-dedup")?.toLowerCase();
  const title = text("x-title");
  const link = text("x-link");
  const sourceLabel = text("x-source");
  const version = text("x-version");
  const sourceModifiedAt = text("x-source-modified");
  return {
    ...(title !== undefined ? { title } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(sourceLabel !== undefined ? { sourceLabel } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(sourceModifiedAt !== undefined ? { sourceModifiedAt } : {}),
    ...(dedup === "auto" || dedup === "exact" || dedup === "off" ? { dedup } : {}),
  };
}
