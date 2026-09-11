// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * errors.ts
 *
 * The error taxonomy, which exists to answer one question consistently: is this
 * the caller's fault, ours, or the model's?
 *
 * The distinction is not cosmetic. A conversion pipeline fails in three
 * genuinely different ways and each needs a different HTTP status and a
 * different operator response:
 *
 *  - the upload is wrong (unsupported type, too many pages) → 4xx, do not retry;
 *  - a converter binary is missing or crashed → 500, fix the image;
 *  - the vision endpoint timed out or refused → 502, retry or check the model.
 *
 * Returning 500 for all three, which is what an untyped `throw new Error` gets
 * you, makes a client retry an unsupported file forever and makes an operator
 * hunt for a bug that is really a missing `poppler-utils`.
 *
 * Error *messages* never reach the client unless `EXPOSE_ERROR_DETAIL` is on:
 * they contain converter command lines and temporary paths. The client gets a
 * stable `code` plus an `errorId` that appears in the log.
 */

export type ExtractErrorCode =
  /** Caller sent something this service cannot accept. */
  | "VALIDATION_FAILED"
  /** MIME type is outside the supported set. */
  | "UNSUPPORTED_MEDIA_TYPE"
  /** Upload exceeds MAX_UPLOAD_BYTES. */
  | "PAYLOAD_TOO_LARGE"
  /** Document has more pages than MAX_PAGES allows. */
  | "TOO_MANY_PAGES"
  /** A converter binary is missing from the image. */
  | "CONVERTER_UNAVAILABLE"
  /** A converter ran but failed or produced nothing usable. */
  | "CONVERSION_FAILED"
  /** The vision endpoint failed, timed out, or returned an unusable response. */
  | "VISION_UNAVAILABLE"
  /** Search rejected the ingest or the asset upload. */
  | "INGEST_FAILED"
  /** The produced document violates the extract contract. */
  | "CONTRACT_VIOLATION"
  /** Work queue is saturated. */
  | "QUEUE_SATURATED"
  /** Client disconnected before the conversion finished. */
  | "CLIENT_ABORTED";

/** HTTP status each code maps to. */
const STATUS_BY_CODE: Record<ExtractErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_PAGES: 422,
  CONVERTER_UNAVAILABLE: 500,
  CONVERSION_FAILED: 500,
  VISION_UNAVAILABLE: 502,
  INGEST_FAILED: 502,
  CONTRACT_VIOLATION: 500,
  QUEUE_SATURATED: 503,
  CLIENT_ABORTED: 499,
};

/**
 * Codes a client can usefully retry.
 *
 * Surfaced as `retryable` in the error body so a caller does not have to
 * reverse-engineer the policy from the status code — 500 from a missing binary
 * is permanent, 500 from a flaky LibreOffice run is not, and both are 500.
 */
const RETRYABLE: ReadonlySet<ExtractErrorCode> = new Set<ExtractErrorCode>([
  "CONVERSION_FAILED",
  "VISION_UNAVAILABLE",
  "INGEST_FAILED",
  "QUEUE_SATURATED",
]);

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  /** Structured context for the log. Never sent to the client. */
  readonly context: Record<string, unknown>;

  constructor(
    code: ExtractErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE.has(code);
    this.context = context;
  }
}

export function validationError(message: string, context?: Record<string, unknown>): ExtractError {
  return new ExtractError("VALIDATION_FAILED", message, context);
}

export function unsupportedMediaType(
  message: string,
  context?: Record<string, unknown>,
): ExtractError {
  return new ExtractError("UNSUPPORTED_MEDIA_TYPE", message, context);
}

export function conversionFailed(
  message: string,
  context?: Record<string, unknown>,
): ExtractError {
  return new ExtractError("CONVERSION_FAILED", message, context);
}

export function converterUnavailable(
  message: string,
  context?: Record<string, unknown>,
): ExtractError {
  return new ExtractError("CONVERTER_UNAVAILABLE", message, context);
}

export function visionUnavailable(
  message: string,
  context?: Record<string, unknown>,
): ExtractError {
  return new ExtractError("VISION_UNAVAILABLE", message, context);
}

export function ingestFailed(message: string, context?: Record<string, unknown>): ExtractError {
  return new ExtractError("INGEST_FAILED", message, context);
}

/** True when the failure is the caller's to fix. */
export function isClientError(error: unknown): boolean {
  return error instanceof ExtractError && error.status >= 400 && error.status < 500;
}

/** The body shape every error response uses. */
export interface ErrorBody {
  error: string;
  code: ExtractErrorCode | "INTERNAL";
  retryable: boolean;
  errorId: string;
  /** Only present when EXPOSE_ERROR_DETAIL is enabled. */
  detail?: string;
}

/**
 * Build the client-facing body.
 *
 * A client error's message is safe to return — it describes what the caller
 * sent. A server error's is not, so it is replaced by a generic string and the
 * real one stays in the log under `errorId`.
 */
export function toErrorBody(
  error: unknown,
  errorId: string,
  exposeDetail: boolean,
): ErrorBody {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ExtractError) {
    return {
      error: isClientError(error) ? error.message : `Extraction failed (${error.code})`,
      code: error.code,
      retryable: error.retryable,
      errorId,
      ...(exposeDetail ? { detail } : {}),
    };
  }
  return {
    error: "Internal Server Error",
    code: "INTERNAL",
    retryable: false,
    errorId,
    ...(exposeDetail ? { detail } : {}),
  };
}
