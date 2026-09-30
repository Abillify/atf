// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared error type for Extract API responses the outpost cannot act on.
 * Carries the HTTP status and, when present, the machine-readable `code`
 * from the JSON error body so callers can branch (403 on delete, 401, …).
 */
export class ExtractApiError extends Error {
  /** The `Retry-After` header of the response, when the service sent one (8.9). */
  readonly retryAfter: string | undefined;

  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    options?: { cause?: unknown; retryAfter?: string },
  ) {
    super(message, options);
    this.name = "ExtractApiError";
    this.retryAfter = options?.retryAfter;
  }
}

/** Read the `Retry-After` header from an HTTP response, when present. */
export function retryAfterOf(headers: Headers | undefined): string | undefined {
  const value = headers?.get("retry-after");
  return value === null || value === "" ? undefined : value;
}

/** Extract the `code` field of a JSON error body, when present. */
export function apiErrorCode(json: unknown): string | undefined {
  if (typeof json === "object" && json !== null) {
    const code = (json as Record<string, unknown>)["code"];
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Extract the `error`/`message` text of a JSON error body, when present. */
export function apiErrorMessage(json: unknown): string | undefined {
  if (typeof json === "object" && json !== null) {
    const record = json as Record<string, unknown>;
    const error = record["error"];
    if (typeof error === "string") return error;
    const message = record["message"];
    if (typeof message === "string") return message;
  }
  return undefined;
}
