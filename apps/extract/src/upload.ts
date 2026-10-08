// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * upload.ts
 *
 * Getting the document bytes off the request, in the two shapes callers
 * actually use.
 *
 *   **multipart/form-data**, field `document` — what an HTML form and `curl -F`
 *   produce. Required for the browser UI.
 *
 *   **raw body** with the document's own `Content-Type` — what a
 *   service-to-service caller produces, and what Search's `/ingest-file` proxy
 *   forwards. Simpler on both ends: no boundary to build, no boundary to parse.
 *
 * Supporting only multipart would force every programmatic caller to construct a
 * multipart envelope for a single file, and supporting only raw would make the UI
 * impossible. So the parser is chosen per request from the `Content-Type`, which
 * is the one thing both shapes agree on.
 *
 * Buffering: memory up to `UPLOAD_MEMORY_THRESHOLD_BYTES`, disk above it
 * (requirement 5.9). A document that waits in the conversion queue holds its
 * bytes for the whole wait, and a queue of 32 fifty-megabyte uploads is an
 * out-of-memory event with a 202 already sent — so above the threshold the
 * upload is spooled to a scratch file under `TEMP_DIR/uploads` and only read
 * back once a slot is free (or streamed straight into the source store).
 * Small uploads — the common case — never touch the filesystem. The scratch
 * file is removed in the handler's `finally`, by multer's own abort cleanup
 * when a request dies mid-upload, and by a startup sweep when the *process*
 * dies. `MAX_UPLOAD_BYTES` still bounds the total, and it is enforced by the
 * parser rather than checked afterwards — by the time you can check a buffer's
 * length you have already allocated it. The raw-body path stays in memory:
 * `express.raw` has no storage seam, and its size is bounded by the same limit.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import express, { type Request, type RequestHandler } from "express";
import multer from "multer";
import type { Logger } from "pino";
import { ExtractError, validationError } from "./errors.js";
import { supportedFormatsLabel, supportedMimeTypes } from "./formats.js";
import { readHeader } from "./header-utils.js";

/** Field name the multipart parser reads. */
export const UPLOAD_FIELD = "document";

/** Subdirectory of `TEMP_DIR` the upload scratch files live in. */
const UPLOAD_SCRATCH_SUBDIR = "uploads";

/**
 * The document bytes, wherever they currently are.
 *
 * Deliberately an accessor shape rather than a plain buffer: an upload spooled
 * to disk (requirement 5.9) must not be pulled into the heap by merely reading
 * the metadata, so callers that only store the bytes use `createReadStream()`
 * and callers that convert call `readBuffer()` once a queue slot is free.
 */
export interface UploadedDocument {
  /** Total size in bytes — known even when the bytes are on disk. */
  readonly size: number;
  /** Original filename, or a generated one when the caller sent none. */
  readonly filename: string;
  /** Declared type, used as a hint by `resolveFormat`. */
  readonly declaredMimeType: string | undefined;
  /** The full bytes; reads the scratch file only for a spooled upload. */
  readBuffer(): Promise<Uint8Array>;
  /** Stream the bytes without materialising them in the heap. */
  createReadStream(): Readable;
  /**
   * Remove the scratch file. Idempotent, and a no-op for an in-memory upload,
   * so every handler can call it unconditionally in its `finally`.
   */
  cleanup(): Promise<void>;
}

/**
 * `req.file` as `@types/multer` declares it on `Express.Request`.
 *
 * Narrowed to the fields this module reads, so the rest of the codebase does
 * not depend on multer's shape. `path` is set by the spooling engine below when
 * the upload went to disk; `buffer` is set when it stayed in memory.
 */
type MulterFile = {
  buffer?: Buffer;
  path?: string;
  size: number;
  originalname: string;
  mimetype: string;
};

function inMemoryUpload(
  buffer: Uint8Array,
  filename: string,
  declaredMimeType: string | undefined,
): UploadedDocument {
  return {
    size: buffer.byteLength,
    filename,
    declaredMimeType,
    async readBuffer() {
      return buffer;
    },
    createReadStream() {
      return Readable.from(buffer);
    },
    async cleanup() {
      // Nothing to release — the bytes live in the request's own memory.
    },
  };
}

function spooledUpload(
  path: string,
  size: number,
  filename: string,
  declaredMimeType: string | undefined,
): UploadedDocument {
  let cached: Uint8Array | undefined;
  let cleanedUp = false;
  return {
    size,
    filename,
    declaredMimeType,
    async readBuffer() {
      if (cached === undefined) cached = new Uint8Array(await readFile(path));
      return cached;
    },
    createReadStream() {
      return createReadStream(path);
    },
    async cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      // Drop the cached copy too: the point of spooling is the heap.
      cached = undefined;
      await unlink(path).catch(() => {
        // Already gone (multer's abort cleanup got here first) — that is the
        // desired end state, whichever path reached it.
      });
    },
  };
}

/**
 * Multer storage that buffers in memory up to `thresholdBytes` and spools the
 * rest to a scratch file (requirement 5.9).
 *
 * The prefix is kept in memory and written out when the threshold is crossed,
 * so a small upload never touches the filesystem at all. The file is created
 * exclusively (`wx`, owner-only) and its path is published onto multer's file
 * object the moment it exists: multer's abort cleanup only removes a pending
 * file that already has a truthy `path`, and a request that dies after the
 * spool was opened must not leave it behind. A failure mid-stream removes the
 * partial file here; a crash of the whole process is what the startup sweep
 * covers.
 */
function createSpoolStorage(tempDir: string, thresholdBytes: number): multer.StorageEngine {
  const scratchRoot = join(tempDir, UPLOAD_SCRATCH_SUBDIR);

  async function spool(file: Express.Multer.File): Promise<Partial<Express.Multer.File>> {
    const chunks: Buffer[] = [];
    let buffered = 0;
    let path: string | undefined;
    let handle: FileHandle | undefined;
    let written = 0;
    try {
      for await (const rawChunk of file.stream) {
        const chunk = rawChunk as Buffer;
        if (handle === undefined && buffered + chunk.length > thresholdBytes) {
          await mkdir(scratchRoot, { recursive: true });
          path = join(scratchRoot, `upload-${randomUUID()}`);
          handle = await open(path, "wx", 0o600);
          file.path = path;
          for (const prefix of chunks) {
            await handle.write(prefix, 0, prefix.length, written);
            written += prefix.length;
          }
          chunks.length = 0;
        }
        if (handle !== undefined) {
          await handle.write(chunk, 0, chunk.length, written);
          written += chunk.length;
        } else {
          chunks.push(chunk);
        }
        buffered += chunk.length;
      }
      if (handle !== undefined) await handle.close();
      return path === undefined
        ? { buffer: Buffer.concat(chunks), size: buffered }
        : { size: buffered, path };
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {});
      if (path !== undefined) await unlink(path).catch(() => {});
      throw error;
    }
  }

  return {
    _handleFile(_req, file, callback) {
      spool(file).then(
        (info) => callback(null, info),
        (error: unknown) =>
          callback(error instanceof Error ? error : new Error(String(error))),
      );
    },
    _removeFile(_req, file, callback) {
      const path = file.path;
      if (typeof path !== "string" || path === "") {
        callback(null);
        return;
      }
      unlink(path).then(
        () => callback(null),
        (error: NodeJS.ErrnoException) => callback(error.code === "ENOENT" ? null : error),
      );
    },
  };
}

/**
 * Remove upload scratch files left behind by a previous crash.
 *
 * Called at startup, before the server accepts a single request, so no live
 * upload can be swept away. This is the backstop for the one window no
 * in-request cleanup can cover: the process died between spooling and the
 * handler's `finally`.
 */
export async function sweepUploadScratch(
  tempDir: string,
  logger: Logger,
): Promise<void> {
  const root = join(tempDir, UPLOAD_SCRATCH_SUBDIR);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return; // no spool has ever happened here — nothing to sweep
  }
  if (names.length === 0) return;
  for (const name of names) {
    await rm(join(root, name), { force: true }).catch(() => {});
  }
  logger.warn(
    { count: names.length, root },
    "Removed upload scratch files left behind by a previous crash",
  );
}

export interface UploadMiddlewareOptions {
  maxUploadBytes: number;
  /** Uploads above this many bytes are spooled to disk (req 5.9). 0 = always. */
  uploadMemoryThresholdBytes: number;
  /** Scratch root; the spool lives in `uploads` beneath it. */
  tempDir: string;
}

/**
 * Build the body parser for the conversion routes.
 *
 * Both parsers are constructed once and dispatched per request, because
 * constructing multer per request leaks its internal state and re-deriving the
 * raw type list per request is wasted work on a hot path.
 */
export function createUploadMiddleware(
  options: UploadMiddlewareOptions,
): RequestHandler {
  const multipart = multer({
    storage: createSpoolStorage(
      options.tempDir,
      options.uploadMemoryThresholdBytes,
    ),
    limits: {
      fileSize: options.maxUploadBytes,
      // One file, no stray fields: this endpoint takes a document, and accepting
      // more would mean deciding which one wins.
      files: 1,
      fields: 8,
    },
  }).single(UPLOAD_FIELD);

  const raw = express.raw({
    type: supportedMimeTypes(),
    limit: options.maxUploadBytes,
  });

  return (req, res, next) => {
    const contentType = req.headers["content-type"] ?? "";

    if (contentType.toLowerCase().includes("multipart/form-data")) {
      multipart(req, res, (error: unknown) => {
        if (error !== undefined && error !== null) {
          next(translateMulterError(error, options.maxUploadBytes));
          return;
        }
        next();
      });
      return;
    }

    raw(req, res, next);
  };
}

/** Map multer's error codes onto the service's taxonomy. */
function translateMulterError(error: unknown, maxUploadBytes: number): unknown {
  const code = (error as { code?: string }).code;
  if (code === "LIMIT_FILE_SIZE") {
    return new ExtractError(
      "PAYLOAD_TOO_LARGE",
      `The upload exceeds the ${maxUploadBytes} byte limit`,
      { maxUploadBytes },
    );
  }
  if (code === "LIMIT_UNEXPECTED_FILE") {
    return validationError(`Send the file in the "${UPLOAD_FIELD}" field`);
  }
  if (code === "LIMIT_FILE_COUNT") {
    return validationError("Send exactly one file per request");
  }
  return error;
}

/**
 * Read the uploaded document, whichever shape it arrived in.
 *
 * The filename is only ever a hint used for format resolution and as a default
 * title. It never reaches a filesystem path or a process argument: `office.ts`
 * generates its own filename precisely so an attacker-controlled one cannot.
 */
export function readUpload(req: Request): UploadedDocument {
  const file: MulterFile | undefined = req.file;
  if (file !== undefined) {
    // Multer decodes the filename as latin1 while browsers send UTF-8, so an
    // umlaut in a filename arrives mangled unless it is re-decoded here.
    const filename = sanitizeFilename(
      Buffer.from(file.originalname, "latin1").toString("utf8"),
    );
    return typeof file.path === "string" && file.path !== ""
      ? spooledUpload(file.path, file.size, filename, file.mimetype)
      : inMemoryUpload(file.buffer ?? Buffer.alloc(0), filename, file.mimetype);
  }

  const body: unknown = req.body;
  if (Buffer.isBuffer(body) && body.length > 0) {
    return inMemoryUpload(
      body,
      sanitizeFilename(
        readHeader(req, "x-filename") ??
          filenameFromDisposition(req) ??
          "document",
      ),
      req.headers["content-type"],
    );
  }

  throw validationError(
    `No document received. Send multipart/form-data with a "${UPLOAD_FIELD}" field, or the ` +
      `raw file with its Content-Type. Supported formats: ${supportedFormatsLabel()}.`,
  );
}

/** `Content-Disposition: attachment; filename="report.pdf"` */
function filenameFromDisposition(req: Request): string | undefined {
  const raw = req.headers["content-disposition"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim();
}

/**
 * Reduce a client-supplied filename to something safe to log, echo and use as a
 * title.
 *
 * Path separators, control characters and traversal sequences are removed. This
 * is defence in depth rather than the primary control — nothing here is used to
 * build a path — but a filename does reach log lines, an HTTP response header and
 * the document title, and `../../etc/passwd\r\nX-Injected: 1` should not survive
 * any of those.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must go
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  const cleaned = base === undefined || base === "" ? "document" : base;
  // Long filenames end up in headers, where implementations differ on limits.
  return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned;
}
