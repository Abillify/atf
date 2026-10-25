// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * revision-client.ts
 *
 * The v2 revision client: the HTTP binding the emitter uses to
 * stream a job's staged outbox to Search's revision API.
 *
 * The v1 {@link SearchClient} in `search-client.ts` speaks the plain Markdown
 * contract (`POST /ingest`), which stays the transport for the synchronous
 * `/v1/ingest` path — text only, since figure crops live on the v2 path. The v2
 * job emitter needs the *revision* routes instead:
 *
 *   POST   /v2/documents/{ref}/revisions                     open a revision
 *   PUT    …/revisions/{rev}/batches/{seq}                    stage an NDJSON batch
 *   GET    …/revisions/{rev}                                  read the revision state
 *   PUT    /v2/assets/{assetId}                               store a crop, idempotent
 *   HEAD   /v2/assets/{assetId}                               check a crop exists
 *   POST   …/revisions/{rev}/segments/{n}/commit             commit a segment
 *   POST   …/revisions/{rev}/commit                           final commit (document.end)
 *   POST   /v2/sources/identify                               dedup + canonical reference
 *
 * ## Idempotency is the contract, not a nicety
 *
 * Every write route is idempotent by identity: the revision by its
 * `Idempotency-Key` (the extract job id), a batch by its `Content-Digest` at a
 * `seq`, an asset by its checksum. That is what makes the outbox reconciliation
 * safe — a resend of an already-accepted batch is a `noop`, not a duplicate. So
 * this client only frames the requests and reads the acks; the emitter decides
 * *what* to send after reconciling against {@link RevisionClient.getState}.
 *
 * ## Transient vs permanent
 *
 * A network error, a timeout, or a 5xx is {@link RevisionTransientError}: the
 * outbox row stays where it is and the emitter retries with backoff, then
 * reconciles. A 4xx that is not a retryable conflict is a
 * {@link RevisionPermanentError}: the batch is malformed or the revision is
 * gone, and retrying cannot help. A `409` on a commit is neither — it carries
 * the `missingRanges` the emitter must still send, so it is surfaced as a typed
 * result rather than thrown.
 */

import type { Logger } from "pino";
import {
  revisionSchema,
  batchAckSchema,
  revisionStateSchema,
  commitResultSchema,
  identifyResponseSchema,
  type IdentifyRequest,
  type IdentifyResponse,
  type Revision,
  type BatchAck,
  type RevisionState,
  type CommitResult,
  type Visibility,
} from "@atf/extract-contract/v2";
import { createClientTlsInit } from "@atf/security-kit";
import { injectTraceHeaders } from "./trace-context.js";
import { encodeHeaderValue } from "@atf/extract-contract/v1";

/** Configuration slice, mirroring `SearchTargetConfig` plus the collection. */
export interface RevisionClientConfig {
  url: string;
  token: string | null;
  collection: string;
  timeoutMs: number;
  /** Optional CA bundle for trusting a self-signed Search TLS certificate. */
  caCertFile: string | null;
}

/** A crop ready to store, addressed by its asset id. */
export interface AssetBody {
  assetId: string;
  buffer: Uint8Array;
  mimeType: string;
  checksum: string;
  kind: "figure" | "page" | "tile" | "native";
  /**
   * The local id the asset id was derived from (e.g. `p368-f1`, `page:p37`),
   * sent as `x-figure-id` so Search indexes the figure identity — the
   * `expected_figure_id` fail-closed check and `list_figures` depend on it.
   */
  localId?: string | undefined;
  /** 1-based page the asset belongs to, sent as `x-page` (region zooms need it). */
  page?: number | undefined;
  /** Normalized [x0,y0,x1,y1] crop box, sent as `x-bbox`. */
  bbox?: readonly number[] | undefined;
}

/**
 * A retryable failure: the request never reached a definitive answer (network,
 * timeout, 5xx). The outbox row is left untouched so a later pass retries it.
 */
export class RevisionTransientError extends Error {
  readonly retryable = true as const;
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RevisionTransientError";
    this.status = status;
  }
}

/**
 * A non-retryable failure: the server refused the request for a reason retrying
 * cannot fix (malformed batch, missing revision, auth). The emitter fails the
 * job rather than looping.
 */
export class RevisionPermanentError extends Error {
  readonly retryable = false as const;
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RevisionPermanentError";
    this.status = status;
    this.code = code;
  }
}

/** The v2 revision transport the emitter drives. */
export interface RevisionClient {
  /** Open (or idempotently re-open) a revision for a document reference. */
  createRevision(args: {
    reference: string;
    idempotencyKey: string;
    /** The source claim (`identify` sourceId) this revision indexes. */
    sourceId?: string | undefined;
    /** Who may read the document's units (sent as X-Allowed-Users / -Groups). */
    acl?: { allowedUsers: readonly string[]; allowedGroups: readonly string[] } | undefined;
    visibility?: Visibility | undefined;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<Revision>;

  /** Read the revision state, for the resume reconciliation. */
  getState(args: {
    reference: string;
    revisionId: string;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<RevisionState>;

  /** Stage one NDJSON batch at `seq`; idempotent on `contentDigest`. */
  putBatch(args: {
    reference: string;
    revisionId: string;
    seq: number;
    body: Uint8Array;
    contentDigest: string;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<BatchAck>;

  /** Check whether an asset already exists under the revision. */
  headAsset(args: {
    assetId: string;
    reference: string;
    revisionId: string;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<boolean>;

  /** Store a crop; idempotent on its checksum. */
  putAsset(args: {
    asset: AssetBody;
    reference: string;
    revisionId: string;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<void>;

  /** Commit a segment, making its pages searchable under `progressive`. */
  commitSegment(args: {
    reference: string;
    revisionId: string;
    segment: number;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<CommitResult>;

  /** Final commit (document.end) → the atomic is_latest switch (Search-side). */
  commit(args: {
    reference: string;
    revisionId: string;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<CommitResult>;

  /**
   * Register the job's source claim and ask Search whether the source is new,
   * a new version of an indexed document, or a duplicate. Optional so a
   * transport without it (tests, an old deployment) skips identification.
   * Returns null when Search does not offer the route (404/405).
   */
  identify?(args: {
    request: IdentifyRequest;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<IdentifyResponse | null>;
}

export function createRevisionClient(
  config: RevisionClientConfig,
  logger: Logger,
): RevisionClient {
  // Empty unless SEARCH_CA_CERT_FILE is set; spread into every fetch so the
  // custom CA covers the whole revision outbox protocol.
  const tlsInit = createClientTlsInit({ caCertFile: config.caCertFile });

  function baseHeaders(collection: string): Record<string, string> {
    const headers: Record<string, string> = { "x-collection": collection };
    if (config.token !== null) headers.authorization = `Bearer ${config.token}`;
    injectTraceHeaders(headers);
    return headers;
  }

  /** `fetch` with a per-request timeout that also honours the caller's signal. */
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
    } catch (error) {
      // A thrown fetch is always transient: DNS, connection reset, or the
      // timeout above. The caller retries with backoff, then reconciles.
      throw new RevisionTransientError(
        `Search could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** A 5xx (and 429) is transient; any other non-2xx is permanent. */
  async function classifyError(
    response: Response,
    what: string,
  ): Promise<never> {
    const body = await response.text().catch(() => "");
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // non-JSON body; leave code undefined
    }
    const detail = `${what} failed with HTTP ${response.status}: ${body.slice(0, 300)}`;
    if (response.status >= 500 || response.status === 429) {
      throw new RevisionTransientError(detail, response.status);
    }
    throw new RevisionPermanentError(detail, response.status, code);
  }

  function encodeRef(reference: string): string {
    return encodeURIComponent(reference);
  }

  return {
    async createRevision(args) {
      const collection = args.collection ?? config.collection;
      const headers: Record<string, string> = {
        ...baseHeaders(collection),
        "idempotency-key": args.idempotencyKey,
      };
      if (args.visibility !== undefined)
        headers["x-visibility"] = args.visibility;
      if (args.sourceId !== undefined) headers["x-source-id"] = args.sourceId;
      if (args.acl !== undefined) {
        if (args.acl.allowedUsers.length > 0) {
          headers["x-allowed-users"] = encodeHeaderValue(
            args.acl.allowedUsers.join(","),
          );
        }
        if (args.acl.allowedGroups.length > 0) {
          headers["x-allowed-groups"] = encodeHeaderValue(
            args.acl.allowedGroups.join(","),
          );
        }
      }
      const response = await request(
        `/v2/documents/${encodeRef(args.reference)}/revisions`,
        { method: "POST", headers },
        args.signal,
      );
      if (!response.ok) await classifyError(response, "createRevision");
      const json: unknown = await response.json().catch(() => ({}));
      return revisionSchema.parse(json);
    },

    async getState(args) {
      const collection = args.collection ?? config.collection;
      const response = await request(
        `/v2/documents/${encodeRef(args.reference)}/revisions/${encodeURIComponent(args.revisionId)}`,
        { method: "GET", headers: baseHeaders(collection) },
        args.signal,
      );
      if (!response.ok) await classifyError(response, "getRevisionState");
      const json: unknown = await response.json().catch(() => ({}));
      return revisionStateSchema.parse(json);
    },

    async putBatch(args) {
      const collection = args.collection ?? config.collection;
      const response = await request(
        `/v2/documents/${encodeRef(args.reference)}/revisions/${encodeURIComponent(args.revisionId)}/batches/${args.seq}`,
        {
          method: "PUT",
          headers: {
            ...baseHeaders(collection),
            "content-type": "application/x-ndjson",
            "content-digest": args.contentDigest,
          },
          body: args.body as unknown as BodyInit,
        },
        args.signal,
      );
      if (!response.ok)
        await classifyError(response, `putBatch(seq=${args.seq})`);
      const json: unknown = await response.json().catch(() => ({}));
      return batchAckSchema.parse(json);
    },

    async headAsset(args) {
      const collection = args.collection ?? config.collection;
      const response = await request(
        `/v2/assets/${encodeURIComponent(args.assetId)}?collection=${encodeURIComponent(collection)}`,
        {
          method: "HEAD",
          headers: {
            ...baseHeaders(collection),
            "x-revision-id": args.revisionId,
          },
        },
        args.signal,
      );
      if (response.status === 404) return false;
      if (response.ok) return true;
      await classifyError(response, `headAsset(${args.assetId})`);
      return false; // unreachable; classifyError always throws
    },

    async putAsset(args) {
      const collection = args.collection ?? config.collection;
      const { asset } = args;
      const headers: Record<string, string> = {
        ...baseHeaders(collection),
        "content-type": asset.mimeType,
        "x-document-reference": args.reference,
        "x-revision-id": args.revisionId,
        "x-asset-kind": asset.kind,
        "x-checksum": asset.checksum,
      };
      // Figure identity + placement metadata (Search v2 asset handler reads
      // x-figure-id / x-page / x-bbox). Without these the stored asset carries
      // no figure_id/page, so expected_figure_id fails closed and region zooms
      // are unavailable. encodeHeaderValue keeps non-ASCII local ids safe.
      if (asset.localId !== undefined && asset.localId !== "") {
        headers["x-figure-id"] = encodeHeaderValue(asset.localId);
      }
      if (
        asset.page !== undefined &&
        Number.isSafeInteger(asset.page) &&
        asset.page >= 1
      ) {
        headers["x-page"] = String(asset.page);
      }
      if (
        asset.bbox !== undefined &&
        asset.bbox.length === 4 &&
        asset.bbox.every((n) => Number.isFinite(n))
      ) {
        headers["x-bbox"] = asset.bbox.join(",");
      }
      const response = await request(
        `/v2/assets/${encodeURIComponent(asset.assetId)}?revision=${encodeURIComponent(args.revisionId)}`,
        {
          method: "PUT",
          headers,
          body: asset.buffer as unknown as BodyInit,
        },
        args.signal,
      );
      if (!response.ok)
        await classifyError(response, `putAsset(${asset.assetId})`);
    },

    async commitSegment(args) {
      const collection = args.collection ?? config.collection;
      const response = await request(
        `/v2/documents/${encodeRef(args.reference)}/revisions/${encodeURIComponent(args.revisionId)}/segments/${args.segment}/commit`,
        { method: "POST", headers: baseHeaders(collection) },
        args.signal,
      );
      // A 409 carries missingRanges; surface it as a typed result, not a throw,
      // so the emitter can send the gap and retry rather than fail the job.
      if (response.status === 409) {
        const json: unknown = await response.json().catch(() => ({}));
        return commitResultSchema.parse({
          ...(json as object),
          committed: false,
        });
      }
      if (!response.ok)
        await classifyError(response, `commitSegment(${args.segment})`);
      const json: unknown = await response.json().catch(() => ({}));
      return commitResultSchema.parse(json);
    },

    async identify(args) {
      const collection = args.collection ?? config.collection;
      const response = await request(
        "/v2/sources/identify",
        {
          method: "POST",
          headers: {
            ...baseHeaders(collection),
            "content-type": "application/json",
          },
          body: JSON.stringify(args.request),
        },
        args.signal,
      );
      // An older Search without the route: identification is skipped.
      if (response.status === 404 || response.status === 405) return null;
      if (!response.ok) await classifyError(response, "identify");
      const json: unknown = await response.json().catch(() => ({}));
      return identifyResponseSchema.parse(json);
    },

    async commit(args) {
      const collection = args.collection ?? config.collection;
      const response = await request(
        `/v2/documents/${encodeRef(args.reference)}/revisions/${encodeURIComponent(args.revisionId)}/commit`,
        { method: "POST", headers: baseHeaders(collection) },
        args.signal,
      );
      if (response.status === 409) {
        const json: unknown = await response.json().catch(() => ({}));
        logger.warn(
          { revisionId: args.revisionId },
          "Final commit rejected: batches still missing",
        );
        return commitResultSchema.parse({
          ...(json as object),
          committed: false,
        });
      }
      if (!response.ok) await classifyError(response, "commit");
      const json: unknown = await response.json().catch(() => ({}));
      return commitResultSchema.parse(json);
    },
  };
}
