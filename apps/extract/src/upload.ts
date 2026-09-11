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
 * Memory storage rather than disk: the buffer is needed in full anyway to sniff
 * its type, hash it and hand it to a converter, and a disk round-trip would add a
 * cleanup path that can leak on crash. `MAX_UPLOAD_BYTES` is what keeps that
 * bounded, and it is enforced by the parser rather than checked afterwards — by
 * the time you can check a buffer's length you have already allocated it.
 */

import express, { type Request, type RequestHandler } from "express";
import multer from "multer";
import { ExtractError, validationError } from "./errors.js";
import { supportedFormatsLabel, supportedMimeTypes } from "./formats.js";
import { readHeader } from "./header-utils.js";

/** Field name the multipart parser reads. */
export const UPLOAD_FIELD = "document";

export interface UploadedDocument {
  buffer: Uint8Array;
  /** Original filename, or a generated one when the caller sent none. */
  filename: string;
  /** Declared type, used as a hint by `resolveFormat`. */
  declaredMimeType: string | undefined;
}

/**
 * `req.file` as `@types/multer` declares it on `Express.Request`.
 *
 * Narrowed to the three fields this module reads, so the rest of the codebase
 * does not depend on multer's shape.
 */
type MulterFile = { buffer: Buffer; originalname: string; mimetype: string };

/**
 * Build the body parser for the conversion routes.
 *
 * Both parsers are constructed once and dispatched per request, because
 * constructing multer per request leaks its internal state and re-deriving the
 * raw type list per request is wasted work on a hot path.
 */
export function createUploadMiddleware(options: { maxUploadBytes: number }): RequestHandler {
  const multipart = multer({
    storage: multer.memoryStorage(),
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
    return {
      buffer: file.buffer,
      // Multer decodes the filename as latin1 while browsers send UTF-8, so an
      // umlaut in a filename arrives mangled unless it is re-decoded here.
      filename: sanitizeFilename(Buffer.from(file.originalname, "latin1").toString("utf8")),
      declaredMimeType: file.mimetype,
    };
  }

  const body: unknown = req.body;
  if (Buffer.isBuffer(body) && body.length > 0) {
    return {
      buffer: body,
      filename: sanitizeFilename(
        readHeader(req, "x-filename") ?? filenameFromDisposition(req) ?? "document",
      ),
      declaredMimeType: req.headers["content-type"],
    };
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
