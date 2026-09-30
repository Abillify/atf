// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `DELETE /v2/documents/{reference}` (E2, requirements 9.1, 9.3, 9.8).
 *
 * `200` and `404` both mean "the reference is gone" and count as success —
 * this keeps the mirror-delete loop idempotent across retries (9.3). A `403`
 * means the token lacks the `extract.delete` scope: the caller receives a
 * dedicated error so the scheduler can surface the configuration error
 * (9.10) instead of treating it as a transient failure.
 */

import type { ExtractHttpClient } from "../http/client.js";
import { apiErrorCode, apiErrorMessage, ExtractApiError } from "./api-error.js";

/** Raised on `403` — the token lacks `extract.delete` (9.8, 9.10). */
export class DeleteForbiddenError extends ExtractApiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(403, "FORBIDDEN", message, options);
    this.name = "DeleteForbiddenError";
  }
}

/** Result of a delete-by-reference call. */
export type DeleteResult =
  | { kind: "deleted"; deleted: number }
  | { kind: "not-found" };

/**
 * Delete a document by reference from a collection. `200`/`404` are success;
 * `403` throws `DeleteForbiddenError`; other statuses throw `ExtractApiError`.
 */
export async function deleteByReference(
  client: ExtractHttpClient,
  collection: string,
  reference: string,
  signal?: AbortSignal,
): Promise<DeleteResult> {
  const response = await client.request({
    url: `/v2/documents/${encodeURIComponent(reference)}`,
    method: "DELETE",
    headers: { "x-collection": collection },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status === 200) {
    const body = (response.json ?? {}) as Record<string, unknown>;
    const deleted = typeof body["deleted"] === "number" ? body["deleted"] : 1;
    return { kind: "deleted", deleted };
  }
  if (response.status === 404) {
    return { kind: "not-found" };
  }
  if (response.status === 403) {
    throw new DeleteForbiddenError(
      apiErrorMessage(response.json) ??
        "Löschen ohne Scope extract.delete abgelehnt (403)",
    );
  }
  throw new ExtractApiError(
    response.status,
    apiErrorCode(response.json),
    apiErrorMessage(response.json) ?? `deleteByReference antwortete mit ${response.status}`,
  );
}
