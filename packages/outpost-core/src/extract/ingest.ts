// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `POST /v1/ingest` — the direct (non-resumable) upload path for files at or
 * below `resumableThresholdBytes` (requirements 8.1, 8.7, 8.8).
 *
 * The document travels as multipart/form-data in the field `document`
 * (`UPLOAD_FIELD` in Extract's `upload.ts`). Extract answers synchronously
 * with `200 {status: "ok" | "skipped"}` or, when it routes the document into
 * the v2 pipeline, with `202 {job_id}` — which the caller polls via `jobs.ts`.
 */

import type { Readable } from "node:stream";
import type { ExtractHttpClient } from "../http/client.js";
import { apiErrorCode, apiErrorMessage, ExtractApiError, retryAfterOf } from "./api-error.js";

/** Multipart field name the Extract ingest endpoint expects. */
export const INGEST_FIELD = "document";

/** Outcome of a direct ingest call. */
export type IngestResult =
  | {
      kind: "ingested";
      /** Extract's status: `ok` (indexed) or `skipped` (duplicate). */
      status: "ok" | "skipped";
      reference: string;
      collection?: string;
    }
  | { kind: "accepted"; jobId: string };

/** Collect a stream into bytes (the direct path is bounded by the threshold). */
async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a document directly. `headers` carries `X-Reference`, `X-Collection`,
 * `X-Source-Modified`, `X-Dedup`, `X-Title`, `X-Source` and the optional ACL
 * headers (built by `sync/headers.ts`, task 16).
 */
export async function ingest(
  client: ExtractHttpClient,
  headers: Record<string, string>,
  source: Uint8Array | Readable,
  filename: string,
  mimeType?: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const bytes = source instanceof Uint8Array ? source : await readAll(source);
  const form = new FormData();
  // Copy into a fresh Uint8Array so the backing buffer is a plain ArrayBuffer,
  // which is what BlobPart requires (ArrayBufferLike would not suffice).
  const parts: BlobPart[] = [new Uint8Array(bytes)];
  const blob =
    mimeType === undefined ? new Blob(parts) : new Blob(parts, { type: mimeType });
  form.append(INGEST_FIELD, blob, filename);
  const response = await client.request({
    url: "/v1/ingest",
    method: "POST",
    headers,
    // FormData sets its own content-type boundary — the client must not
    // override it, so the body is passed through untouched.
    body: form,
    ...(signal !== undefined ? { signal } : {}),
  });

  if (response.status === 200) {
    const body = (response.json ?? {}) as Record<string, unknown>;
    const status = body["status"] === "skipped" ? "skipped" : "ok";
    const reference = typeof body["reference"] === "string" ? body["reference"] : headers["X-Reference"] ?? "";
    const collection = typeof body["collection"] === "string" ? body["collection"] : undefined;
    return {
      kind: "ingested",
      status,
      reference,
      ...(collection !== undefined ? { collection } : {}),
    };
  }
  if (response.status === 202) {
    const body = (response.json ?? {}) as Record<string, unknown>;
    const jobId = typeof body["job_id"] === "string" ? body["job_id"] : "";
    if (jobId === "") {
      throw new ExtractApiError(202, undefined, "202 ohne job_id beantwortet");
    }
    return { kind: "accepted", jobId };
  }
  throw new ExtractApiError(
    response.status,
    apiErrorCode(response.json),
    apiErrorMessage(response.json) ?? `ingest antwortete mit ${response.status}`,
    { retryAfter: retryAfterOf(response.headers) },
  );
}

/** Convenience: read a file path into bytes for the direct path. */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(path));
}
