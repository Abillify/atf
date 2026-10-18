// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * search-client.ts
 *
 * The thin binding to `@atf/search`.
 *
 * Thin is the design, not a shortcut. Search already owns chunking, embedding,
 * summarisation, ACLs and versioning; the only thing it lacked was a producer
 * that speaks its structure contract. So this client does plain HTTP calls and
 * no interpretation:
 *
 *   POST /ingest    the canonical Markdown, as text/markdown, with the `X-…`
 *                   headers built by the contract
 *
 * Figure images are not part of this path: the legacy v1 crop upload to
 * `/document-assets` was removed together with that endpoint. Images flow
 * exclusively through the v2 pipeline (`revision-client.ts` →
 * `PUT /v2/assets/:assetId`), where they are bound to a revision.
 */

import {
  type ErasureRequest,
  type ErasureResponse,
  ErasureResponseSchema,
} from "@atf/erasure-contract";
import {
  buildIngestHeaders,
  type ExtractedDocument,
  encodeHeaderValue,
  type IngestHeaderOptions,
} from "@atf/extract-contract/v1";
import { createClientTlsInit } from "@atf/security-kit";
import type { Logger } from "pino";
import { ingestFailed } from "./errors.js";
import { injectTraceHeaders } from "./trace-context.js";

/** Configuration slice, mirroring `SearchTargetConfig`. */
export interface SearchClientConfig {
  url: string;
  token: string | null;
  collection: string;
  timeoutMs: number;
  /** Optional CA bundle for trusting a self-signed Search TLS certificate. */
  caCertFile: string | null;
}

export interface IngestOutcome {
  /** Search's response body for the ingest call, passed through unmodified. */
  ingest: unknown;
  collection: string;
  reference: string;
}

export interface DeleteByReferenceOutcome {
  /** How many documents (all versions of the base ref) Search removed. */
  deleted: number;
}

export interface SearchClient {
  /** Ingest the document's canonical Markdown (text only, no figure crops). */
  ingestDocument(args: {
    document: ExtractedDocument;
    markdown: string;
    /** Overrides merged over the configured defaults. */
    options?: IngestHeaderOptions;
    signal?: AbortSignal | undefined;
  }): Promise<IngestOutcome>;
  /**
   * Remove a document by reference from Search (extract-outpost E2,
   * requirements 9.1, 9.3, 9.7).
   *
   * `DELETE /delete` with `X-Reference` and `X-Collection`, authenticated with
   * the service token. The caller's end-user identity is forwarded as
   * `X-User`/`X-Groups` exactly like the revision client forwards it, so
   * Search's `accessScopeForRequest` applies the caller's ACL rather than the
   * unrestricted service scope: a caller may only delete documents they could
   * also read. Search answers `200 {status:"ok", deleted:n}` with `n = 0` for a
   * reference it never held; the caller maps `0` to its own `404`.
   */
  deleteByReference(args: {
    collection: string;
    reference: string;
    /** The acting principal's identity, forwarded for Search's ACL check. */
    identity?: { userId?: string; userGroups?: readonly string[] } | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<DeleteByReferenceOutcome>;
  /**
   * Forward an erasure (DSAR) request to Search's `POST /v1/erasure`
   * (task 4.6, requirements 2.7, 2.12).
   *
   * The request body is the shared `@atf/erasure-contract` request, sent with
   * the same `requestId` so Search's own ledger keeps the cascade idempotent
   * even when Extract retries. The acting identity is forwarded as
   * `X-User`/`X-Groups` exactly like {@link deleteByReference}, so Search
   * applies the caller's ACL. Search's per-store results (`search.*`) are
   * returned as-is for the caller to merge into its own response.
   *
   * Throws {@link ingestFailed} when Search is unreachable or rejects — the
   * caller reports the cascade as `failed` rather than pretending success.
   */
  erase(args: {
    request: ErasureRequest;
    identity?: { userId?: string; userGroups?: readonly string[] } | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ErasureResponse>;
  /** Reachability probe for `/health`. Never throws. */
  probe(): Promise<{ available: boolean; error?: string }>;
}

export function createSearchClient(
  config: SearchClientConfig,
  logger: Logger,
): SearchClient {
  // Empty unless SEARCH_CA_CERT_FILE is set; spread into every fetch so the
  // custom CA applies to ingest, delete, erasure, and the health probe alike.
  const tlsInit = createClientTlsInit({ caCertFile: config.caCertFile });

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.token !== null)
      headers["authorization"] = `Bearer ${config.token}`;
    injectTraceHeaders(headers);
    return headers;
  }

  /**
   * `fetch` with a timeout that also honours the caller's abort signal.
   *
   * Both matter: the timeout stops a stalled Search from holding a conversion
   * slot, and the caller's signal stops a client disconnect from continuing to
   * write into the index on their behalf.
   */
  async function request(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout =
      config.timeoutMs > 0
        ? setTimeout(() => controller.abort(), config.timeoutMs)
        : null;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fetch(`${config.url}${path}`, {
        ...init,
        ...(tlsInit ?? {}),
        signal: controller.signal,
      });
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function ingestDocument(args: {
    document: ExtractedDocument;
    markdown: string;
    options?: IngestHeaderOptions;
    signal?: AbortSignal | undefined;
  }): Promise<IngestOutcome> {
    const { document, markdown, options, signal } = args;
    const collection = options?.collection ?? config.collection;
    const headers = buildIngestHeaders(document, { ...options, collection });

    let response: Response;
    try {
      response = await request(
        "/ingest",
        {
          method: "POST",
          headers: { ...headers, ...authHeaders() },
          body: markdown,
        },
        signal,
      );
    } catch (error) {
      throw ingestFailed(
        `Search could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { collection, reference: document.reference },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw ingestFailed(
        `Search rejected the ingest with HTTP ${response.status}: ${body.slice(0, 500)}`,
        { collection, reference: document.reference, status: response.status },
      );
    }

    const ingest: unknown = await response.json().catch(() => ({}));
    logger.info(
      {
        reference: document.reference,
        collection,
        pageCount: document.pageCount,
      },
      "Document ingested into Search",
    );

    return { ingest, collection, reference: document.reference };
  }

  async function deleteByReference(args: {
    collection: string;
    reference: string;
    identity?: { userId?: string; userGroups?: readonly string[] } | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<DeleteByReferenceOutcome> {
    const { collection, reference, identity, signal } = args;
    const headers: Record<string, string> = {
      ...authHeaders(),
      "x-collection": encodeHeaderValue(collection),
      "x-reference": encodeHeaderValue(reference),
    };
    // Forward the acting end-user identity exactly like the revision client
    // forwards its ACL headers, so Search derives the caller's access scope
    // instead of the unrestricted service scope (E2, requirement 9.7).
    if (identity?.userId !== undefined && identity.userId !== "") {
      headers["x-user"] = encodeHeaderValue(identity.userId);
    }
    if (identity?.userGroups !== undefined && identity.userGroups.length > 0) {
      headers["x-groups"] = encodeHeaderValue(identity.userGroups.join(","));
    }

    let response: Response;
    try {
      response = await request(
        "/delete",
        { method: "DELETE", headers },
        signal,
      );
    } catch (error) {
      throw ingestFailed(
        `Search could not be reached for the delete: ${error instanceof Error ? error.message : String(error)}`,
        { collection, reference },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw ingestFailed(
        `Search rejected the delete with HTTP ${response.status}: ${body.slice(0, 500)}`,
        { collection, reference, status: response.status },
      );
    }

    const json = (await response.json().catch(() => ({}))) as {
      deleted?: unknown;
    };
    const deleted =
      typeof json.deleted === "number" && Number.isInteger(json.deleted)
        ? json.deleted
        : 0;
    logger.info(
      { reference, collection, deleted },
      "Document deleted from Search",
    );
    return { deleted };
  }

  async function erase(args: {
    request: ErasureRequest;
    identity?: { userId?: string; userGroups?: readonly string[] } | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ErasureResponse> {
    const { request: erasureRequest, identity, signal } = args;
    const headers: Record<string, string> = {
      ...authHeaders(),
      "content-type": "application/json",
    };
    if (identity?.userId !== undefined && identity.userId !== "") {
      headers["x-user"] = encodeHeaderValue(identity.userId);
    }
    if (identity?.userGroups !== undefined && identity.userGroups.length > 0) {
      headers["x-groups"] = encodeHeaderValue(identity.userGroups.join(","));
    }

    let response: Response;
    try {
      response = await request(
        "/v1/erasure",
        { method: "POST", headers, body: JSON.stringify(erasureRequest) },
        signal,
      );
    } catch (error) {
      throw ingestFailed(
        `Search could not be reached for the erasure: ${error instanceof Error ? error.message : String(error)}`,
        { requestId: erasureRequest.requestId },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw ingestFailed(
        `Search rejected the erasure with HTTP ${response.status}: ${body.slice(0, 500)}`,
        { requestId: erasureRequest.requestId, status: response.status },
      );
    }

    const parsed = ErasureResponseSchema.safeParse(
      await response.json().catch(() => ({})),
    );
    if (!parsed.success) {
      throw ingestFailed("Search returned a malformed erasure response", {
        requestId: erasureRequest.requestId,
      });
    }
    logger.info(
      {
        requestId: erasureRequest.requestId,
        results: parsed.data.results.length,
      },
      "Search erasure cascade completed",
    );
    return parsed.data;
  }

  async function probe(): Promise<{ available: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${config.url}/health`, {
        ...(tlsInit ?? {}),
        signal: controller.signal,
      });
      if (response.ok) return { available: true };
      return { available: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ingestDocument, deleteByReference, erase, probe };
}
