// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Resumable uploads via `/v2/uploads` (requirements 3.8, 8.5, 8.6).
 *
 * Protocol (mirrors `apps/extract/src/handlers/uploads.ts`):
 * - `POST /v2/uploads` opens a session (`X-Reference`, `X-Checksum-Sha256`,
 *   body `{size}`) and answers `201 {upload_id, offset}`.
 * - `HEAD /v2/uploads/{id}` reads `Upload-Offset` / `Upload-Status` — the
 *   resume point after a restart (the session id lives in Sync_State).
 * - `PATCH /v2/uploads/{id}` appends a chunk (8 MiB) with `Upload-Offset` and
 *   `X-Chunk-Checksum-Sha256`. A `409` carries the server's true offset in the
 *   `Upload-Offset` response header; the client adopts it and continues.
 * - `POST /v2/uploads/{id}/complete` is idempotent — a retried complete after
 *   a lost response answers `200` with the stored digest.
 *
 * Robustness rules (Property 22): every PATCH starts at the offset the server
 * confirmed; after a connection loss the client re-reads the offset with
 * `HEAD` before sending again; a chunk whose checksum the server rejects is
 * re-sent exactly once; `403`/`404` on `HEAD` (e.g. re-authenticated as a
 * different user) discard the session and start over from offset 0.
 */

import { createHash } from "node:crypto";
import type { ExtractHttpClient } from "../http/client.js";
import { apiErrorCode, apiErrorMessage, ExtractApiError } from "./api-error.js";

/** Chunk size for PATCH requests (8 MiB). */
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/** A session persisted in Sync_State (`pendingUpload`). */
export interface PendingUpload {
  uploadId: string;
  sha256: string;
}

/** Result of `HEAD /v2/uploads/{id}`. */
export interface UploadOffsetInfo {
  offset: number;
  status: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** TS 7 types `AbortSignal.aborted` as `false | undefined` — compare via Boolean. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Boolean(signal.aborted);
}

/** Open a new upload session. Returns the session id and confirmed offset. */
export async function openUpload(
  client: ExtractHttpClient,
  reference: string,
  sha256: string,
  size: number,
  signal?: AbortSignal,
): Promise<PendingUpload> {
  const response = await client.request({
    url: "/v2/uploads",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-reference": reference,
      "x-checksum-sha256": sha256,
    },
    body: JSON.stringify({ size }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status !== 201) {
    throw new ExtractApiError(
      response.status,
      apiErrorCode(response.json),
      apiErrorMessage(response.json) ?? `openUpload antwortete mit ${response.status}`,
    );
  }
  const body = (response.json ?? {}) as Record<string, unknown>;
  const uploadId = typeof body["upload_id"] === "string" ? body["upload_id"] : "";
  if (uploadId === "") {
    throw new ExtractApiError(201, undefined, "openUpload ohne upload_id beantwortet");
  }
  return { uploadId, sha256 };
}

/**
 * Read the confirmed offset of a session. `found: false` for `404`/`403` —
 * the caller must then discard the session and start over.
 */
export async function uploadOffset(
  client: ExtractHttpClient,
  uploadId: string,
  signal?: AbortSignal,
): Promise<{ found: true } & UploadOffsetInfo | { found: false }> {
  const response = await client.request({
    url: `/v2/uploads/${encodeURIComponent(uploadId)}`,
    method: "HEAD",
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status === 404 || response.status === 403) {
    return { found: false };
  }
  if (response.status !== 200) {
    throw new ExtractApiError(
      response.status,
      apiErrorCode(response.json),
      apiErrorMessage(response.json) ?? `uploadOffset antwortete mit ${response.status}`,
    );
  }
  const offsetHeader = response.headers.get("upload-offset");
  const offset = offsetHeader === null ? Number.NaN : Number(offsetHeader);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ExtractApiError(200, undefined, `ungültiger Upload-Offset: ${offsetHeader}`);
  }
  return { found: true, offset, status: response.headers.get("upload-status") ?? "open" };
}

/** Outcome of a single PATCH request. */
export type PatchOutcome =
  /** Chunk accepted; `offset` is the new confirmed offset. */
  | { kind: "ok"; offset: number }
  /** Offset mismatch; `serverOffset` is the server's true offset (adopt it). */
  | { kind: "offset-conflict"; serverOffset: number | undefined }
  /** The server rejected the chunk checksum — the bytes may be corrupt. */
  | { kind: "checksum-mismatch" };

/** Is this a chunk-checksum rejection from Extract (`VALIDATION_FAILED`)? */
function isChecksumMismatch(response: { json: unknown; status: number }): boolean {
  if (response.status !== 400) return false;
  const message = apiErrorMessage(response.json) ?? "";
  return /checksum mismatch/i.test(message);
}

/**
 * Send one chunk at `offset`. The caller decides how to react to the outcome;
 * no retrying happens here (the resumable driver owns the retry policy).
 */
export async function patchChunk(
  client: ExtractHttpClient,
  uploadId: string,
  offset: number,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PatchOutcome> {
  const response = await client.request({
    url: `/v2/uploads/${encodeURIComponent(uploadId)}`,
    method: "PATCH",
    headers: {
      "upload-offset": String(offset),
      "x-chunk-checksum-sha256": sha256Hex(bytes),
      "content-type": "application/octet-stream",
    },
    body: bytes,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status === 204) {
    const header = response.headers.get("upload-offset");
    const confirmed = header === null ? offset + bytes.length : Number(header);
    return { kind: "ok", offset: confirmed };
  }
  if (response.status === 409) {
    const header = response.headers.get("upload-offset");
    const serverOffset = header === null || !Number.isInteger(Number(header)) ? undefined : Number(header);
    return { kind: "offset-conflict", serverOffset };
  }
  if (isChecksumMismatch(response)) {
    return { kind: "checksum-mismatch" };
  }
  throw new ExtractApiError(
    response.status,
    apiErrorCode(response.json),
    apiErrorMessage(response.json) ?? `patchChunk antwortete mit ${response.status}`,
  );
}

/** Complete a session. Idempotent — a repeated call after a lost response succeeds. */
export async function completeUpload(
  client: ExtractHttpClient,
  uploadId: string,
  sha256: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; deduped?: boolean }> {
  const response = await client.request({
    url: `/v2/uploads/${encodeURIComponent(uploadId)}/complete`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-checksum-sha256": sha256,
    },
    body: JSON.stringify({ sha256 }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status !== 200) {
    throw new ExtractApiError(
      response.status,
      apiErrorCode(response.json),
      apiErrorMessage(response.json) ?? `completeUpload antwortete mit ${response.status}`,
    );
  }
  const body = (response.json ?? {}) as Record<string, unknown>;
  const stored = typeof body["sha256"] === "string" ? body["sha256"] : sha256;
  return {
    sha256: stored,
    ...(typeof body["deduped"] === "boolean" ? { deduped: body["deduped"] } : {}),
  };
}

/**
 * Read a byte range of the source. The executor supplies this over an open
 * stream or a temp file; the driver only ever needs `[offset, offset+len)`.
 */
export type ChunkReader = (offset: number, length: number) => Promise<Uint8Array>;

export interface ResumableUploadResult {
  uploadId: string;
  sha256: string;
  /** True when an existing session was resumed rather than freshly opened. */
  resumed: boolean;
}

/**
 * Drive a full resumable upload. `pending` is the session from Sync_State (if
 * any); it is validated with `HEAD` and discarded on `403`/`404`. After a
 * connection loss the confirmed offset is re-read with `HEAD`, so every PATCH
 * starts where the server actually is. A checksum rejection re-sends the
 * chunk once; a lost `complete` response is retried once (idempotent).
 *
 * `onSession` (when given) is invoked whenever the usable session changes —
 * with the freshly opened session or `undefined` when one was discarded — so
 * the executor can persist `pendingUpload` to the journal immediately (7.8).
 */
export async function runResumableUpload(
  client: ExtractHttpClient,
  args: {
    reference: string;
    sha256: string;
    size: number;
    readChunk: ChunkReader;
    pending?: PendingUpload;
    chunkSize?: number;
    onSession?: (session: PendingUpload | undefined) => Promise<void> | void;
  },
  signal?: AbortSignal,
): Promise<ResumableUploadResult> {
  const chunkSize = args.chunkSize ?? CHUNK_SIZE_BYTES;
  let resumed = false;
  let session: PendingUpload | undefined = args.pending;
  let offset = 0;

  // ── resolve the session and its confirmed offset ─────────────────────────
  if (session !== undefined) {
    const info = await uploadOffset(client, session.uploadId, signal);
    if (info.found && info.status === "open") {
      offset = info.offset;
      resumed = true;
    } else {
      // 403/404 (e.g. re-authenticated as another user) or a terminal status:
      // the session is unusable → start over from scratch.
      session = undefined;
      await args.onSession?.(undefined);
    }
  }
  if (session === undefined) {
    session = await openUpload(client, args.reference, args.sha256, args.size, signal);
    offset = 0;
    await args.onSession?.(session);
  }

  // ── send chunks until the whole file is confirmed ────────────────────────
  let checksumRetriesForChunk = 0;
  while (offset < args.size) {
    const length = Math.min(chunkSize, args.size - offset);
    const bytes = await args.readChunk(offset, length);
    try {
      const outcome = await patchChunk(client, session.uploadId, offset, bytes, signal);
      if (outcome.kind === "ok") {
        if (outcome.offset <= offset) {
          throw new ExtractApiError(204, undefined, `Offset Fortschritt ausgeblieben: ${offset} -> ${outcome.offset}`);
        }
        offset = outcome.offset;
        checksumRetriesForChunk = 0;
        continue;
      }
      if (outcome.kind === "offset-conflict") {
        // The server states the true offset — adopt it and continue there.
        if (outcome.serverOffset === undefined) {
          const info = await uploadOffset(client, session.uploadId, signal);
          offset = info.found ? info.offset : 0;
        } else {
          offset = outcome.serverOffset;
        }
        checksumRetriesForChunk = 0;
        continue;
      }
      // checksum-mismatch: re-read and re-send the chunk exactly once.
      if (checksumRetriesForChunk >= 1) {
        throw new ExtractApiError(400, "CHUNK_CHECKSUM_MISMATCH", `Chunk bei Offset ${offset} zweimal abgelehnt`);
      }
      checksumRetriesForChunk += 1;
    } catch (error) {
      // Connection loss (or lost 204): the chunk may or may not have landed.
      // Re-read the confirmed offset; if it moved, the chunk arrived — count
      // it and continue. An abort propagates unchanged.
      if (aborted(signal)) throw error;
      // A definitive client/server error (not a transport loss) is final —
      // the executor's retry policy owns that path, not the chunk loop.
      if (error instanceof ExtractApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        throw error;
      }
      const info = await uploadOffset(client, session.uploadId, signal);
      if (!info.found) {
        // The session vanished mid-flight: start a fresh one from zero.
        session = await openUpload(client, args.reference, args.sha256, args.size, signal);
        offset = 0;
        resumed = false;
        checksumRetriesForChunk = 0;
        await args.onSession?.(session);
        continue;
      }
      if (info.status !== "open") {
        // Completed concurrently (a retried request landed twice) — done.
        break;
      }
      offset = info.offset;
      checksumRetriesForChunk = 0;
    }
  }

  // ── complete (idempotent; one retry on a lost response) ──────────────────
  try {
    const result = await completeUpload(client, session.uploadId, args.sha256, signal);
    return { uploadId: session.uploadId, sha256: result.sha256, resumed };
  } catch (error) {
    if (aborted(signal)) throw error;
    if (error instanceof ExtractApiError) throw error;
    // Lost response: complete is idempotent → retry once.
    const result = await completeUpload(client, session.uploadId, args.sha256, signal);
    return { uploadId: session.uploadId, sha256: result.sha256, resumed };
  }
}
