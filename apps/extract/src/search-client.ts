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

import type { Logger } from "pino";
import {
  assetPath,
  buildAssetHeaders,
  buildIngestHeaders,
  collectFigures,
  type ExtractedDocument,
  type IngestHeaderOptions,
} from "@atf/extract-contract/v1";
import { ingestFailed } from "./errors.js";
import { injectTraceHeaders } from "./trace-context.js";

/** Configuration slice, mirroring `SearchTargetConfig`. */
export interface SearchClientConfig {
  url: string;
  token: string | null;
  collection: string;
  timeoutMs: number;
  uploadAssets: boolean;
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
  /** Reachability probe for `/health`. Never throws. */
  probe(): Promise<{ available: boolean; error?: string }>;
}

export function createSearchClient(
  config: SearchClientConfig,
  logger: Logger,
): SearchClient {
  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
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
      config.timeoutMs > 0 ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fetch(`${config.url}${path}`, { ...init, signal: controller.signal });
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
        { method: "POST", headers: { ...headers, ...authHeaders() }, body: markdown },
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
      { reference: document.reference, collection, pageCount: document.pageCount },
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
        { reference: document.reference, collection, assetsStored, assetsFailed },
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
            ...buildAssetHeaders(document, { id: figure.id, mimeType: crop.mimeType as never }, {
              collection,
            }),
            ...authHeaders(),
          },
          body: crop.buffer as unknown as BodyInit,
        },
        signal,
      );
      if (response.ok) return { ...base, stored: true };
      const body = await response.text().catch(() => "");
      return { ...base, stored: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
    } catch (error) {
      return {
        ...base,
        stored: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function probe(): Promise<{ available: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${config.url}/health`, { signal: controller.signal });
      if (response.ok) return { available: true };
      return { available: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ingestDocument, probe };
}
