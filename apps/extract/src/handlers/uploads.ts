// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * uploads.ts
 *
 * The resumable, chunked upload protocol for v2 sources (design §9a.1,
 * requirements 4.13, 4.14, 6.2).
 *
 * A 10 000-page source is multiple gigabytes, and a single POST of that over a
 * flaky link is a coin toss that costs the whole transfer when it lands tails.
 * So the source arrives in chunks that survive an abort:
 *
 *   POST   /v2/uploads              open a session; returns an upload_id and the
 *                                   confirmed offset (0), or pulls a `source_url`
 *                                   in one shot when the JSON body carries one.
 *   HEAD   /v2/uploads/{id}         report the last confirmed byte offset in the
 *                                   `Upload-Offset` response header, so a client
 *                                   resuming after an abort knows exactly where
 *                                   to continue.
 *   PATCH  /v2/uploads/{id}         append one chunk. The request's
 *                                   `Upload-Offset` must equal the confirmed
 *                                   offset (a wrong offset is a 409, never a
 *                                   silently misplaced write). The chunk is
 *                                   streamed into its own scratch file and its
 *                                   per-chunk sha256 verified BEFORE anything
 *                                   touches the session file; only then is it
 *                                   appended and the offset advanced, under a
 *                                   per-session lock (process-local mutex plus
 *                                   a row lock and an optimistic
 *                                   `received_offset = $expected` update in the
 *                                   database). A crash before the advance leaves
 *                                   the chunk re-sendable at the old offset.
 *   POST   /v2/uploads/{id}/complete  verify the whole-file sha256 the client
 *                                   declared at open time and move the assembled
 *                                   file into the content-addressed SourceStore.
 *
 * Nothing is ever buffered whole: PATCH streams the request body straight to the
 * session file, and `complete` hashes that file streaming. `MAX_UPLOAD_BYTES`
 * bounds the total.
 *
 * Session state (the confirmed offset, the expected digest, the status) lives in
 * the `uploads` table so a resume works across process restarts and across
 * replicas — the bytes are on a shared volume, the offset is in Postgres, and
 * the two together are the resumable session.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { join } from "node:path";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { Logger } from "pino";
import { conflict, notFound, validationError } from "../errors.js";
import { readHeader } from "../header-utils.js";
import type { ExtractStore } from "../persistence/index.js";
import {
  assertSha256Hex,
  hashFile,
  SourceChecksumError,
  type SourceStore,
} from "../source-store.js";
import {
  fetchSourceToStore,
  type HostResolver,
  type PinnedRequester,
  type SourceUrlConfig,
} from "./source-url.js";
import {
  createPgUploadOffsetCommitter,
  KeyedMutex,
  type UploadOffsetCommitter,
} from "./upload-session-lock.js";

export interface UploadsHandlerConfig {
  /** Scratch directory in-progress sessions stream into (`UPLOAD_TMP_DIR`). */
  tmpDir: string;
  /** Hard ceiling on a single source. */
  maxUploadBytes: number;
  /** SSRF-guarded `source_url` pull config. */
  sourceUrl: SourceUrlConfig;
}

export interface UploadsHandlerDeps {
  store: ExtractStore;
  sourceStore: SourceStore;
  config: UploadsHandlerConfig;
  logger: Logger;
  /** Injectable for tests; DNS resolver forwarded to the source_url pull. */
  resolver?: HostResolver;
  /** Injectable for tests; pinned HTTP requester for the source_url pull. */
  requestImpl?: PinnedRequester;
  /**
   * Commits a chunk append + offset advance atomically per session. Defaults
   * to the Postgres row-lock implementation over `store.withTransaction`.
   */
  offsetCommitter?: UploadOffsetCommitter;
}

/** Read a route parameter as a single string (Express 5 types it widely). */
function readParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

/** The scratch file a session's bytes accumulate in. */
function sessionPath(tmpDir: string, uploadId: string): string {
  return join(tmpDir, `${uploadId}.part`);
}

/** A digest may be sent bare or `sha256:`-prefixed; normalise to bare hex. */
function normalizeDigest(raw: string): string {
  const stripped = raw.trim().replace(/^sha-?256[:=]/i, "");
  return assertSha256Hex(stripped);
}

/**
 * Build a router mounting the four resumable-upload endpoints.
 *
 * The router is returned rather than mounted so `index.ts` can wrap it in the
 * same rate-limit → authenticate → authorise chain every other write route
 * uses, and so the whole feature stays absent when the database is not
 * configured.
 */
export function createUploadsRouter(deps: UploadsHandlerDeps): Router {
  const { store, sourceStore, config, logger } = deps;
  const router = express.Router();
  const sessionLocks = new KeyedMutex();
  const offsetCommitter = deps.offsetCommitter ?? createPgUploadOffsetCommitter(store);

  // ── POST /v2/uploads ────────────────────────────────────────────────────
  // Two shapes: a JSON body with `source_url` pulls in one shot; anything else
  // opens a resumable session. Both require `reference`.
  const openHandler: RequestHandler = (req, res, next) => {
    void openSession(req, res).catch(next);
  };

  async function openSession(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reference =
      (readHeader(req, "x-reference") ?? (typeof body["reference"] === "string" ? body["reference"] : ""))
        .trim();
    if (reference === "") {
      throw validationError("A reference is required (X-Reference header or reference field)");
    }

    const expectedSha256Raw =
      readHeader(req, "x-checksum-sha256") ??
      (typeof body["sha256"] === "string" ? body["sha256"] : undefined);
    let expectedSha256: string | undefined;
    if (expectedSha256Raw !== undefined && expectedSha256Raw.trim() !== "") {
      try {
        expectedSha256 = normalizeDigest(expectedSha256Raw);
      } catch {
        throw validationError("sha256 must be a 64-character hex digest");
      }
    }

    // ── source_url pull ─────────────────────────────────────────────────
    const sourceUrl = typeof body["source_url"] === "string" ? body["source_url"].trim() : "";
    if (sourceUrl !== "") {
      const stored = await fetchSourceToStore({
        rawUrl: sourceUrl,
        store: sourceStore,
        config: config.sourceUrl,
        logger,
        ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
        ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
        ...(deps.requestImpl !== undefined ? { requestImpl: deps.requestImpl } : {}),
      });
      res.status(201).json({
        status: "completed",
        reference,
        sha256: stored.sha256,
        size: stored.size,
        deduped: stored.deduped,
        source: "source_url",
      });
      return;
    }

    // ── resumable session ───────────────────────────────────────────────
    const declaredSize =
      typeof body["size"] === "number" && Number.isInteger(body["size"]) ? body["size"] : null;
    if (declaredSize !== null && declaredSize > config.maxUploadBytes) {
      throw validationError(
        `Declared size ${declaredSize} exceeds the ${config.maxUploadBytes} byte limit`,
      );
    }

    const uploadId = randomUUID();
    await mkdir(config.tmpDir, { recursive: true });
    // Create an empty session file so a PATCH before any bytes still appends
    // into a real file rather than racing its creation.
    await (await open(sessionPath(config.tmpDir, uploadId), "w")).close();

    const row = await store.createUpload({
      upload_id: uploadId,
      reference,
      expected_sha256: expectedSha256 ?? null,
      size: declaredSize,
    });

    res.status(201)
      .location(`/v2/uploads/${uploadId}`)
      .json({
        status: "open",
        upload_id: uploadId,
        reference: row.reference,
        offset: 0,
        ...(declaredSize !== null ? { size: declaredSize } : {}),
        ...(expectedSha256 !== undefined ? { sha256: expectedSha256 } : {}),
      });
  }

  // ── HEAD /v2/uploads/{id} ─────────────────────────────────────────────────
  const headHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const upload = await store.getUpload(readParam(req, "id"));
      if (upload === null) {
        res.status(404).end();
        return;
      }
      const offset = Number(upload.received_offset);
      // Upload-Offset is the resume point; Cache-Control keeps a proxy from
      // serving a stale offset to a resuming client.
      res.setHeader("Upload-Offset", String(offset));
      res.setHeader("Upload-Status", upload.status);
      if (upload.size !== null) res.setHeader("Upload-Length", String(upload.size));
      res.setHeader("Cache-Control", "no-store");
      res.status(200).end();
    })().catch(next);
  };

  // ── PATCH /v2/uploads/{id} ────────────────────────────────────────────────
  const patchHandler: RequestHandler = (req, res, next) => {
    void appendChunk(req, res).catch(next);
  };

  async function appendChunk(req: Request, res: Response): Promise<void> {
    const uploadId = readParam(req, "id");

    // Process-local guard: one chunk in flight per session. A concurrent PATCH
    // is refused instead of racing the first one; the database guard in the
    // committer covers other replicas.
    const release = sessionLocks.tryAcquire(uploadId);
    if (release === null) {
      throw conflict(`Another chunk for upload session ${uploadId} is still in progress`);
    }
    const chunkPath = join(config.tmpDir, `${uploadId}.${randomUUID()}.chunk`);
    try {
      const upload = await store.getUpload(uploadId);
      if (upload === null) throw notFound(`Upload session ${uploadId} does not exist`);
      if (upload.status !== "open") {
        throw conflict(`Upload session ${uploadId} is ${upload.status}, not open`);
      }

      const confirmedOffset = Number(upload.received_offset);

      // The client states where it believes the session is. A mismatch is a 409
      // carrying the true offset, so a resuming client can correct itself rather
      // than corrupting the file by writing at the wrong place.
      const offsetHeader = readHeader(req, "upload-offset");
      if (offsetHeader === undefined) {
        throw validationError("Upload-Offset header is required on PATCH");
      }
      const claimedOffset = Number(offsetHeader);
      if (!Number.isInteger(claimedOffset) || claimedOffset < 0) {
        throw validationError("Upload-Offset must be a non-negative integer");
      }
      if (claimedOffset !== confirmedOffset) {
        res.setHeader("Upload-Offset", String(confirmedOffset));
        throw conflict(
          `Upload-Offset ${claimedOffset} does not match the confirmed offset ${confirmedOffset}`,
        );
      }

      // Validate the declared digest format before reading a single byte.
      const declaredChunkDigest = readHeader(req, "x-chunk-checksum-sha256");
      let expectedChunkDigest: string | undefined;
      if (declaredChunkDigest !== undefined && declaredChunkDigest.trim() !== "") {
        try {
          expectedChunkDigest = normalizeDigest(declaredChunkDigest);
        } catch {
          throw validationError("X-Chunk-Checksum-Sha256 must be a 64-character hex digest");
        }
      }

      // Stage the chunk in its own scratch file, hashing as it lands. The
      // session file is not touched until the chunk is complete and verified,
      // so an aborted or corrupt chunk can never leave bytes in the session.
      const { sha256: actualChunkDigest, length: chunkLength } = await streamToFile(
        req,
        chunkPath,
        config.maxUploadBytes - confirmedOffset,
        config.maxUploadBytes,
      );

      // Per-chunk checksum: verified BEFORE the persistent append.
      if (expectedChunkDigest !== undefined && actualChunkDigest !== expectedChunkDigest) {
        throw validationError(
          `Chunk checksum mismatch: expected ${expectedChunkDigest}, got ${actualChunkDigest}`,
          { uploadId, offset: confirmedOffset },
        );
      }

      const newOffset = confirmedOffset + chunkLength;
      const sessionFile = sessionPath(config.tmpDir, uploadId);
      const result = await offsetCommitter.commitChunk({
        uploadId,
        expectedOffset: confirmedOffset,
        newOffset,
        append: () => appendFileAt(chunkPath, sessionFile, confirmedOffset),
      });
      if (result.status === "conflict") {
        const current = result.current;
        if (current !== null) res.setHeader("Upload-Offset", String(Number(current.received_offset)));
        throw conflict(
          current === null
            ? `Upload session ${uploadId} does not exist anymore`
            : current.status !== "open"
              ? `Upload session ${uploadId} is ${current.status}, not open`
              : `Upload session ${uploadId} moved to offset ${Number(current.received_offset)} meanwhile`,
        );
      }

      res.setHeader("Upload-Offset", String(newOffset));
      res.status(204).end();
      logger.debug(
        { uploadId, from: confirmedOffset, to: newOffset, size: result.row.size ?? null },
        "Upload chunk confirmed",
      );
    } finally {
      await rm(chunkPath, { force: true }).catch(() => {});
      release();
    }
  }

  // ── POST /v2/uploads/{id}/complete ────────────────────────────────────────
  const completeHandler: RequestHandler = (req, res, next) => {
    void completeSession(req, res).catch(next);
  };

  async function completeSession(req: Request, res: Response): Promise<void> {
    const uploadId = readParam(req, "id");
    const upload = await store.getUpload(uploadId);
    if (upload === null) throw notFound(`Upload session ${uploadId} does not exist`);
    if (upload.status === "completed") {
      // Idempotent: completing an already-completed session returns the stored
      // digest rather than erroring, so a retried complete after a lost response
      // is a no-op.
      if (upload.expected_sha256 !== null && (await sourceStore.has(upload.expected_sha256))) {
        res.status(200).json({
          status: "completed",
          upload_id: uploadId,
          reference: upload.reference,
          sha256: upload.expected_sha256,
        });
        return;
      }
    }
    if (upload.status !== "open" && upload.status !== "completed") {
      throw conflict(`Upload session ${uploadId} is ${upload.status} and cannot be completed`);
    }

    const path = sessionPath(config.tmpDir, uploadId);
    const info = await statOrNull(path);
    if (info === null) {
      throw conflict(`Upload session ${uploadId} has no data on disk`);
    }
    const confirmedOffset = Number(upload.received_offset);
    // The confirmed offset and the file size must agree, otherwise a chunk was
    // written but not confirmed (or vice versa) and the assembly is unsound.
    if (info.size !== confirmedOffset) {
      throw conflict(
        `Upload session ${uploadId} has ${info.size} bytes on disk but a confirmed offset of ${confirmedOffset}`,
      );
    }
    if (upload.size !== null && confirmedOffset !== upload.size) {
      throw conflict(
        `Upload session ${uploadId} is incomplete: ${confirmedOffset} of ${upload.size} bytes`,
      );
    }

    // A client can declare the whole-file digest at open time or at complete
    // time; complete-time wins when both are present.
    const bodyDigestRaw =
      readHeader(req, "x-checksum-sha256") ??
      (typeof (req.body as Record<string, unknown>)?.["sha256"] === "string"
        ? ((req.body as Record<string, unknown>)["sha256"] as string)
        : undefined);
    let expected = upload.expected_sha256 ?? undefined;
    if (bodyDigestRaw !== undefined && bodyDigestRaw.trim() !== "") {
      try {
        expected = normalizeDigest(bodyDigestRaw);
      } catch {
        throw validationError("sha256 must be a 64-character hex digest");
      }
    }

    if (expected === undefined) {
      // Without a declared digest there is nothing to verify against; hash the
      // assembled file and use that as the address, but say so.
      const { sha256 } = await hashFile(path);
      expected = sha256;
    }

    try {
      const stored = await sourceStore.commitFile(path, expected);
      await store.updateUploadOffset(uploadId, confirmedOffset, "completed");
      logger.info(
        { uploadId, sha256: stored.sha256, size: stored.size, deduped: stored.deduped },
        "Upload completed and stored",
      );
      res.status(200).json({
        status: "completed",
        upload_id: uploadId,
        reference: upload.reference,
        sha256: stored.sha256,
        size: stored.size,
        deduped: stored.deduped,
      });
    } catch (err) {
      if (err instanceof SourceChecksumError) {
        // Leave the session open so the client can re-send the corrupt bytes;
        // commitFile already removed the scratch file, so recreate an empty one
        // and reset the offset to zero.
        await store.updateUploadOffset(uploadId, 0, "open");
        await (await open(path, "w")).close();
        throw validationError(
          `Whole-file checksum mismatch: expected ${err.expected}, got ${err.actual}`,
          { uploadId },
        );
      }
      throw err;
    }
  }

  router.post("/", openHandler);
  router.head("/:id", headHandler);
  router.patch("/:id", patchHandler);
  router.post("/:id/complete", completeHandler);

  return router;
}

/**
 * Stream a request body into a fresh scratch file, hashing it as it lands.
 * Rejects (and removes the partial file) once more than `maxChunkBytes` have
 * arrived, so the session's total never exceeds `maxUploadBytes`.
 */
async function streamToFile(
  source: Readable,
  path: string,
  maxChunkBytes: number,
  maxUploadBytes: number,
): Promise<{ sha256: string; length: number }> {
  const hash = createHash("sha256");
  let length = 0;
  const out = createWriteStream(path, { flags: "wx" });
  try {
    for await (const piece of source) {
      const buf = piece as Buffer;
      length += buf.length;
      if (length > maxChunkBytes) {
        throw validationError(`Upload exceeds the ${maxUploadBytes} byte limit`);
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          out.once("drain", resolve);
          out.once("error", reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    await rm(path, { force: true }).catch(() => {});
    throw err;
  }
  return { sha256: hash.digest("hex"), length };
}

/**
 * Append the verified scratch chunk to the session file at `offset` and fsync
 * it. The session file is first truncated to `offset`, dropping a torn tail a
 * crash mid-append may have left; on failure it is rolled back to `offset`.
 */
async function appendFileAt(chunkPath: string, sessionFile: string, offset: number): Promise<void> {
  const target = await open(sessionFile, "r+");
  try {
    const src = await open(chunkPath, "r");
    try {
      await target.truncate(offset);
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let position = offset;
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await target.write(buf, written, bytesRead - written, position);
          written += bytesWritten;
          position += bytesWritten;
        }
      }
      await target.sync();
    } finally {
      await src.close();
    }
  } catch (err) {
    await target.truncate(offset).catch(() => {});
    throw err;
  } finally {
    await target.close();
  }
}

async function statOrNull(path: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size };
  } catch {
    return null;
  }
}

/** Exported for tests that want to clean a scratch directory. */
export { sessionPath as _sessionPath };
