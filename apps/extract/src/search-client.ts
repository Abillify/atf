// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * search-client.ts
 *
 * The thin binding to `@atf/search`.
 *
 * Thin is the design, not a shortcut. Search already owns chunking, embedding,
 * summarisation, ACLs and versioning; the only thing it lacked was a producer
 * that speaks its structure contract. So this client does exactly two HTTP calls
 * and no interpretation:
 *
 *   POST /ingest                     the canonical Markdown, as text/markdown,
 *                                    with the `X-…` headers built by the contract
 *   PUT  /document-assets/:assetId   one figure crop, raw bytes
 *
 * ## Ordering is a hard requirement, not a preference
 *
 * Ingest must complete before any asset upload. Search's asset handler resolves
 * the owning document and answers `404 Associated document is not visible` when it
 * cannot — so uploading crops first fails every one of them, and the failure looks
 * like a permissions problem rather than an ordering one. Asset ids are derived
 * from identity rather than content precisely so that this ordering is the only
 * constraint: a re-run overwrites the same rows instead of orphaning them.
 *
 * ## Partial failure is reported, not hidden
 *
 * A crop that fails to store does not fail the ingest. The document is already
 * indexed and its figure descriptions are already retrievable; only the image is
 * missing. Rolling the ingest back would trade a complete index with a missing
 * thumbnail for no index at all. The per-figure outcome is returned so the caller
 * can surface it, and the count of failures reaches the response.
 */

import {
  type ErasureRequest,
  type ErasureResponse,
  ErasureResponseSchema,
} from "@atf/erasure-contract";
import {
  assetPath,
  buildAssetHeaders,
  buildIngestHeaders,
  collectFigures,
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
  uploadAssets: boolean;
  /** Optional CA bundle for trusting a self-signed Search TLS certificate. */
  caCertFile: string | null;
}

/** A rendered crop ready to store. */
export interface AssetUpload {
  buffer: Uint8Array;
  mimeType: string;
}

export interface AssetOutcome {
  figureId: string;
  assetId: string;
  stored: boolean;
  /** Present when `stored` is false. */
  error?: string;
}

export interface IngestOutcome {
  /** Search's response body for the ingest call, passed through unmodified. */
  ingest: unknown;
  collection: string;
  reference: string;
  assets: AssetOutcome[];
  /** Convenience for the caller's response and log line. */
  assetsStored: number;
  assetsFailed: number;
}

export interface DeleteByReferenceOutcome {
  /** How many documents (all versions of the base ref) Search removed. */
  deleted: number;
}

export interface SearchClient {
  /** Ingest the document, then store its crops. */
  ingestDocument(args: {
    document: ExtractedDocument;
    markdown: string;
    crops: ReadonlyMap<string, AssetUpload>;
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
    crops: ReadonlyMap<string, AssetUpload>;
    options?: IngestHeaderOptions;
    signal?: AbortSignal | undefined;
  }): Promise<IngestOutcome> {
    const { document, markdown, crops, options, signal } = args;
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

    // Only now are the crops storable: Search resolves the owning document for
    // every asset and 404s when it does not yet exist.
    const assets: AssetOutcome[] = [];
    if (config.uploadAssets) {
      for (const figure of collectFigures(document)) {
        const crop = crops.get(figure.id);
        if (crop === undefined) {
          // No crop was produced (no usable geometry); the description is still
          // indexed, so this is not an error.
          continue;
        }
        assets.push(
          await storeAsset({ document, figure, crop, collection, signal }),
        );
      }
    }

    const assetsStored = assets.filter((asset) => asset.stored).length;
    const assetsFailed = assets.length - assetsStored;
    if (assetsFailed > 0) {
      logger.warn(
        {
          reference: document.reference,
          collection,
          assetsStored,
          assetsFailed,
        },
        "Some figure crops could not be stored; descriptions remain indexed",
      );
    }

    return {
      ingest,
      collection,
      reference: document.reference,
      assets,
      assetsStored,
      assetsFailed,
    };
  }

  async function storeAsset(args: {
    document: ExtractedDocument;
    figure: { id: string; assetId: string; mimeType: string };
    crop: AssetUpload;
    collection: string;
    signal: AbortSignal | undefined;
  }): Promise<AssetOutcome> {
    const { document, figure, crop, collection, signal } = args;
    const base = { figureId: figure.id, assetId: figure.assetId };
    try {
      const response = await request(
        assetPath(figure),
        {
          method: "PUT",
          headers: {
            ...buildAssetHeaders(
              document,
              { id: figure.id, mimeType: crop.mimeType as never },
              {
                collection,
              },
            ),
            ...authHeaders(),
          },
          body: crop.buffer as unknown as BodyInit,
        },
        signal,
      );
      if (response.ok) return { ...base, stored: true };
      const body = await response.text().catch(() => "");
      return {
        ...base,
        stored: false,
        error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
      };
    } catch (error) {
      return {
        ...base,
        stored: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
