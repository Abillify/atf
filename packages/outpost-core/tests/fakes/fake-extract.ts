// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory fake of the Extract API surface the outpost uses:
 * `GET /v1/whoami`, `POST /v1/ingest`, `/v2/uploads` (open/HEAD/PATCH/complete
 * including the 409 offset protocol), `POST /v2/jobs`, `GET /v2/jobs/{id}`
 * and `DELETE /v2/documents/{reference}`.
 *
 * Designed to plug into `ExtractHttpClient` as `fetchImpl`. Fault injection:
 * `inject()` queues per-path failures (network errors, aborts before/after
 * the server committed a chunk, plain HTTP error statuses); `scriptJob()`
 * scripts the status sequence of a job.
 */

import { createHash } from "node:crypto";
import type { JobStatus, WhoamiResponse } from "@atf/extract-contract/v2";

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface FakeUploadSession {
  uploadId: string;
  reference: string;
  expectedSha256: string;
  size: number;
  received: number;
  bytes: Buffer;
  status: "open" | "completed";
}

export interface FakeJob {
  jobId: string;
  reference: string;
  sourceSha256: string;
  statuses: JobStatus[];
  reads: number;
  /** Collection the job links the document to (set on ingest/jobs requests). */
  collection?: string;
  /** True once the completed job has stored its document. */
  documentStored?: boolean;
}

export interface RecordedPatch {
  uploadId: string;
  claimedOffset: number;
  confirmedOffset: number;
  accepted: boolean;
  checksumOk: boolean;
}

export type Injection =
  /** fetch rejects before the server sees the request. */
  | { kind: "network-error"; pathIncludes?: string }
  /** the server applies the request, then the response is lost. */
  | { kind: "abort-after-commit"; pathIncludes?: string }
  /** plain HTTP error status. */
  | { kind: "status"; status: number; body?: unknown; pathIncludes?: string };

/** Fault applied to the Nth PATCH request (0-based), consumed once. */
export type PatchFault =
  /** connection drops before the server commits the chunk. */
  | "network-before"
  /** the server commits, then the response (204) is lost. */
  | "network-after"
  /** 409 carrying the true offset in the response header, no commit. */
  | "offset-409"
  /** bytes are corrupted in transit → 400 checksum mismatch, no commit. */
  | "corrupt-transit";

export interface FakeExtractOptions {
  whoami?: WhoamiResponse;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  requireToken?: string;
  /** ingest mode: synchronous 200 or asynchronous 202 with a job. */
  ingestMode?: "sync" | "async";
  /** answer `skipped` instead of `ok` for sync ingest. */
  ingestSkipped?: boolean;
  /** reject DELETE with 403 regardless of scopes. */
  deleteForbidden?: boolean;
}

const DEFAULT_WHOAMI: WhoamiResponse = {
  source: "service",
  scopes: ["extract.ingest", "extract.delete"],
  service: { name: "atf-extract", version: "0.11.0" },
  features: {
    ingest: true,
    resumableUploads: true,
    deleteByReference: true,
    ownJobRead: true,
  },
  limits: { maxUploadBytes: 52_428_800 },
};

export class FakeExtract {
  readonly uploads = new Map<string, FakeUploadSession>();
  readonly jobs = new Map<string, FakeJob>();
  /** collection → reference → sha256 of the stored document. */
  readonly documents = new Map<string, Map<string, string>>();
  readonly patches: RecordedPatch[] = [];
  readonly requests: Array<{ method: string; url: string }> = [];
  whoamiResponse: WhoamiResponse;
  ingestMode: "sync" | "async";
  ingestSkipped: boolean;
  deleteForbidden: boolean;
  requireToken: string | undefined;

  /** Faults keyed by PATCH index (0-based); each fires at most once. */
  readonly patchFaults = new Map<number, PatchFault>();
  private patchCount = 0;
  private injections: Injection[] = [];
  private nextUploadId = 1;
  private nextJobId = 1;

  constructor(options: FakeExtractOptions = {}) {
    this.whoamiResponse = options.whoami ?? DEFAULT_WHOAMI;
    this.ingestMode = options.ingestMode ?? "sync";
    this.ingestSkipped = options.ingestSkipped ?? false;
    this.deleteForbidden = options.deleteForbidden ?? false;
    this.requireToken = options.requireToken;
  }

  /** Queue a fault; consumed by the next matching request. */
  inject(injection: Injection): void {
    this.injections.push(injection);
  }

  /** Script the status sequence of a job (last entry repeats). */
  scriptJob(jobId: string, statuses: JobStatus[]): void {
    const job = this.jobs.get(jobId);
    if (job !== undefined) {
      job.statuses = [...statuses];
      job.reads = 0;
    } else {
      this.jobs.set(jobId, {
        jobId,
        reference: "scripted",
        sourceSha256: "0".repeat(64),
        statuses: [...statuses],
        reads: 0,
      });
    }
  }

  /** All bytes assembled for an upload session. */
  assembledBytes(uploadId: string): Uint8Array {
    const session = this.uploads.get(uploadId);
    if (session === undefined) throw new Error(`unknown upload ${uploadId}`);
    return new Uint8Array(session.bytes.subarray(0, session.received));
  }

  /** The fetch implementation to hand to `ExtractHttpClient`. */
  readonly fetchImpl = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    // Like real fetch: an aborted signal rejects before the server is touched.
    if (init?.signal != null && Boolean(init.signal.aborted)) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = parsed.pathname;
    this.requests.push({ method, url });

    if (this.requireToken !== undefined) {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== `Bearer ${this.requireToken}`) {
        return jsonResponse(401, { error: "unauthorized", code: "UNAUTHORIZED" });
      }
    }

    const injection = this.takeInjection(path);
    if (injection !== undefined && injection.kind === "network-error") {
      throw new TypeError("fetch failed");
    }

    const response = await this.route(method, path, parsed, init);

    if (injection !== undefined && injection.kind === "abort-after-commit") {
      // The server already applied the request; the response never arrives.
      throw new TypeError("fetch failed");
    }
    if (injection !== undefined && injection.kind === "status") {
      return jsonResponse(injection.status, injection.body ?? { error: "injected" });
    }
    return response;
  };

  private takeInjection(path: string): Injection | undefined {
    const index = this.injections.findIndex(
      (i) => i.pathIncludes === undefined || path.includes(i.pathIncludes),
    );
    if (index === -1) return undefined;
    return this.injections.splice(index, 1)[0];
  }

  private async route(
    method: string,
    path: string,
    _url: URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);

    if (method === "GET" && path === "/v1/whoami") {
      return jsonResponse(200, this.whoamiResponse);
    }

    if (method === "POST" && path === "/v1/ingest") {
      return this.handleIngest(headers, init);
    }

    if (method === "POST" && path === "/v2/uploads") {
      return this.handleOpenUpload(headers, init);
    }

    const uploadMatch = /^\/v2\/uploads\/([^/]+)(\/complete)?$/.exec(path);
    if (uploadMatch !== null) {
      const uploadId = uploadMatch[1] ?? "";
      const isComplete = uploadMatch[2] !== undefined;
      if (method === "HEAD") return this.handleHeadUpload(uploadId);
      if (method === "PATCH") return this.handlePatch(uploadId, headers, init);
      if (method === "POST" && isComplete) return this.handleComplete(uploadId, headers);
    }

    if (method === "POST" && path === "/v2/jobs") {
      return this.handleCreateJob(init);
    }

    const jobMatch = /^\/v2\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch !== null && method === "GET") {
      return this.handleGetJob(jobMatch[1] ?? "");
    }

    const docMatch = /^\/v2\/documents\/(.+)$/.exec(path);
    if (docMatch !== null && method === "DELETE") {
      return this.handleDelete(decodeURIComponent(docMatch[1] ?? ""), headers);
    }

    return jsonResponse(404, { error: "not found", code: "NOT_FOUND" });
  }

  private async handleIngest(
    headers: Headers,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const reference = headers.get("x-reference");
    if (reference === null || reference === "") {
      return jsonResponse(400, { error: "X-Reference is required", code: "VALIDATION_FAILED" });
    }
    let bytes: Uint8Array;
    const body = init?.body;
    if (body instanceof FormData) {
      const file = body.get("document");
      if (file === null) {
        return jsonResponse(400, { error: 'field "document" required', code: "VALIDATION_FAILED" });
      }
      bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    } else if (body instanceof Uint8Array) {
      bytes = body;
    } else {
      return jsonResponse(400, { error: "no document", code: "VALIDATION_FAILED" });
    }
    const sha = sha256Hex(bytes);
    const collection = headers.get("x-collection") ?? "default";
    if (this.ingestMode === "async") {
      const jobId = `job-${this.nextJobId++}`;
      this.jobs.set(jobId, {
        jobId,
        reference,
        sourceSha256: sha,
        statuses: ["queued", "processing", "completed"],
        reads: 0,
        collection,
      });
      return jsonResponse(202, { status: "accepted", job_id: jobId, reference });
    }
    const existing = this.documents.get(collection)?.get(reference);
    const skipped = this.ingestSkipped || existing === sha;
    this.storeDocument(collection, reference, sha);
    return jsonResponse(200, {
      status: skipped ? "skipped" : "ok",
      reference,
      collection,
    });
  }

  private storeDocument(collection: string, reference: string, sha: string): void {
    let bucket = this.documents.get(collection);
    if (bucket === undefined) {
      bucket = new Map();
      this.documents.set(collection, bucket);
    }
    bucket.set(reference, sha);
  }

  private handleOpenUpload(headers: Headers, init: RequestInit | undefined): Response {
    const reference = headers.get("x-reference");
    const sha = headers.get("x-checksum-sha256");
    if (reference === null || reference === "") {
      return jsonResponse(400, { error: "X-Reference required", code: "VALIDATION_FAILED" });
    }
    if (sha === null || !/^[0-9a-f]{64}$/.test(sha)) {
      return jsonResponse(400, { error: "X-Checksum-Sha256 required", code: "VALIDATION_FAILED" });
    }
    const body = (parseJson(init?.body) ?? {}) as Record<string, unknown>;
    const size = typeof body["size"] === "number" ? body["size"] : 0;
    const uploadId = `upl-${this.nextUploadId++}`;
    this.uploads.set(uploadId, {
      uploadId,
      reference,
      expectedSha256: sha,
      size,
      received: 0,
      bytes: Buffer.alloc(size),
      status: "open",
    });
    return jsonResponse(201, {
      status: "open",
      upload_id: uploadId,
      reference,
      offset: 0,
      size,
      sha256: sha,
    });
  }

  private handleHeadUpload(uploadId: string): Response {
    const session = this.uploads.get(uploadId);
    if (session === undefined) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 200,
      headers: {
        "upload-offset": String(session.received),
        "upload-status": session.status,
        "upload-length": String(session.size),
      },
    });
  }

  private handlePatch(
    uploadId: string,
    headers: Headers,
    init: RequestInit | undefined,
  ): Response {
    const session = this.uploads.get(uploadId);
    if (session === undefined) return jsonResponse(404, { code: "NOT_FOUND" });
    if (session.status !== "open") {
      return jsonResponse(409, { error: `session is ${session.status}`, code: "CONFLICT" });
    }
    const fault = this.patchFaults.get(this.patchCount);
    this.patchFaults.delete(this.patchCount);
    this.patchCount += 1;

    const claimed = Number(headers.get("upload-offset") ?? "-1");
    if (fault === "network-before") {
      throw new TypeError("fetch failed");
    }
    if (fault === "offset-409") {
      return new Response(
        JSON.stringify({ error: "offset mismatch", code: "CONFLICT" }),
        { status: 409, headers: { "upload-offset": String(session.received), "content-type": "application/json" } },
      );
    }
    if (claimed !== session.received) {
      // The true offset travels in the response header (409 protocol).
      return new Response(
        JSON.stringify({ error: "offset mismatch", code: "CONFLICT" }),
        { status: 409, headers: { "upload-offset": String(session.received), "content-type": "application/json" } },
      );
    }
    const chunk: Uint8Array =
      init?.body instanceof Uint8Array ? (init.body as Uint8Array) : new Uint8Array(0);
    const declared = headers.get("x-chunk-checksum-sha256");
    // `corrupt-transit` flips a byte before hashing — the declared digest of
    // the intact chunk no longer matches what the server received.
    let received: Uint8Array = chunk;
    if (fault === "corrupt-transit" && chunk.length > 0) {
      received = Uint8Array.from(chunk, (b: number, i: number) => (i === 0 ? b ^ 0xff : b));
    }
    const actual = sha256Hex(received);
    if (declared !== null && declared !== actual) {
      return jsonResponse(400, {
        error: `Chunk checksum mismatch: expected ${declared}, got ${actual}`,
        code: "VALIDATION_FAILED",
      });
    }
    // Server-side commit.
    Buffer.from(received.buffer, received.byteOffset, received.byteLength).copy(
      session.bytes,
      session.received,
    );
    session.received += received.length;
    if (fault === "network-after") {
      // Committed, but the 204 never reaches the client.
      throw new TypeError("fetch failed");
    }
    this.patches.push({
      uploadId,
      claimedOffset: claimed,
      confirmedOffset: session.received - chunk.length,
      accepted: true,
      checksumOk: true,
    });
    return new Response(null, {
      status: 204,
      headers: { "upload-offset": String(session.received) },
    });
  }

  private handleComplete(uploadId: string, headers: Headers): Response {
    const session = this.uploads.get(uploadId);
    if (session === undefined) return jsonResponse(404, { code: "NOT_FOUND" });
    if (session.status === "completed") {
      // Idempotent: a retried complete answers with the stored digest.
      return jsonResponse(200, {
        status: "completed",
        upload_id: uploadId,
        reference: session.reference,
        sha256: session.expectedSha256,
      });
    }
    if (session.received !== session.size) {
      return jsonResponse(409, {
        error: `incomplete: ${session.received} of ${session.size}`,
        code: "CONFLICT",
      });
    }
    const declared = headers.get("x-checksum-sha256") ?? session.expectedSha256;
    const actual = sha256Hex(new Uint8Array(session.bytes));
    if (declared !== actual) {
      return jsonResponse(400, {
        error: `checksum mismatch: expected ${declared}, got ${actual}`,
        code: "VALIDATION_FAILED",
      });
    }
    session.status = "completed";
    // Like the real service: the upload stores content-addressed; the
    // document is linked to a COLLECTION only when its job completes.
    return jsonResponse(200, {
      status: "completed",
      upload_id: uploadId,
      reference: session.reference,
      sha256: actual,
      size: session.size,
      deduped: false,
    });
  }

  private handleCreateJob(init: RequestInit | undefined): Response {
    const body = (parseJson(init?.body) ?? {}) as Record<string, unknown>;
    const reference = typeof body["reference"] === "string" ? body["reference"] : "";
    const sourceSha256 = typeof body["sourceSha256"] === "string" ? body["sourceSha256"] : "";
    if (reference === "" || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
      return jsonResponse(400, { error: "reference and sourceSha256 required", code: "VALIDATION_FAILED" });
    }
    const jobId = `job-${this.nextJobId++}`;
    this.jobs.set(jobId, {
      jobId,
      reference,
      sourceSha256,
      statuses: ["queued", "processing", "completed"],
      reads: 0,
      collection: typeof body["collection"] === "string" ? body["collection"] : "default",
    });
    return jsonResponse(201, { jobId, reference, status: "queued", warnings: [] });
  }

  private handleGetJob(jobId: string): Response {
    const job = this.jobs.get(jobId);
    if (job === undefined) return jsonResponse(404, { code: "NOT_FOUND" });
    const index = Math.min(job.reads, job.statuses.length - 1);
    job.reads += 1;
    const status = job.statuses[index] ?? "completed";
    // A completed job links the uploaded content into its collection.
    if (
      status === "completed" &&
      job.collection !== undefined &&
      job.documentStored !== true &&
      job.reference !== "scripted"
    ) {
      this.storeDocument(job.collection, job.reference, job.sourceSha256);
      job.documentStored = true;
    }
    return jsonResponse(200, {
      jobId: job.jobId,
      reference: job.reference,
      status,
      warnings: [],
      sourceSha256: job.sourceSha256,
    });
  }

  private handleDelete(reference: string, headers: Headers): Response {
    if (this.deleteForbidden || !this.whoamiResponse.scopes.includes("extract.delete")) {
      return jsonResponse(403, { error: "missing scope extract.delete", code: "FORBIDDEN" });
    }
    const collection = headers.get("x-collection") ?? "default";
    const bucket = this.documents.get(collection);
    const existed = bucket?.delete(reference) ?? false;
    if (!existed) {
      return jsonResponse(404, { error: "reference not found", code: "NOT_FOUND" });
    }
    return jsonResponse(200, {
      status: "deleted",
      reference,
      collection,
      deleted: 1,
    });
  }
}

function parseJson(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
