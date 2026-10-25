// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory S3 fake behind a {@link SourceFetch}.
 *
 * Serves `ListObjectsV2` with an arbitrary page size and real
 * `ContinuationToken` pagination, plain object GETs, and fault injection for
 * incomplete listings. Counts listing calls so tests can assert that a
 * `needs-authorization` source never reaches the listing endpoint (6.18).
 */

import type { SourceFetch } from "../../src/index.js";

export interface FakeS3Object {
  key: string;
  body: Uint8Array;
  lastModified?: string;
  /** Override the derived ETag; default is a quoted md5-style hash. */
  etag?: string;
}

export interface FakeS3Options {
  bucket: string;
  objects?: FakeS3Object[];
  /** Page size for ListObjectsV2 (default 1000). */
  pageSize?: number;
  /** Fail the next N list calls with this status (fault injection). */
  failListStatus?: number;
  /** Fail the next N list calls with a thrown network error. */
  failListNetwork?: number;
}

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export class FakeS3 {
  readonly objects: Map<string, FakeS3Object>;
  listCalls = 0;
  getCalls = 0;
  /** Captured Authorization headers of the last requests (SigV4 presence). */
  lastAuthHeader: string | undefined;
  private readonly bucket: string;
  private readonly pageSize: number;
  #failListStatus: number | undefined;
  #failListRemaining = 0;
  #failListNetwork = 0;

  constructor(options: FakeS3Options) {
    this.bucket = options.bucket;
    this.objects = new Map(
      (options.objects ?? []).map((o) => [o.key, { lastModified: "2026-01-01T00:00:00.000Z", ...o }]),
    );
    this.pageSize = options.pageSize ?? 1000;
    this.#failListStatus = options.failListStatus;
    this.#failListRemaining = options.failListStatus !== undefined ? 1 : 0;
    this.#failListNetwork = options.failListNetwork ?? 0;
  }

  addObject(key: string, body: Uint8Array, etag?: string): void {
    this.objects.set(key, {
      key,
      body,
      etag,
      lastModified: "2026-01-01T00:00:00.000Z",
    });
  }

  /** Make the next `n` list calls fail with `status` (5xx → transient). */
  injectListFailure(status: number, n = 1): void {
    this.#failListStatus = status;
    this.#failListRemaining = n;
  }

  /** Make the next `n` list calls throw a network error. */
  injectListNetworkFailure(n = 1): void {
    this.#failListNetwork = n;
  }

  readonly fetchImpl: SourceFetch = async (url, init) => {
    const parsed = new URL(url);
    this.lastAuthHeader = init?.headers?.["authorization"];
    const path = decodeURIComponent(parsed.pathname);
    // Virtual-hosted addressing (bucket.s3[.region].host) carries the bucket
    // in the hostname; path-style carries it as the first path segment.
    const virtualHost =
      parsed.hostname === `${this.bucket}.s3.amazonaws.com` ||
      parsed.hostname.startsWith(`${this.bucket}.`);
    const expectedPath = virtualHost ? "" : `/${this.bucket}`;
    if (parsed.searchParams.get("list-type") === "2") {
      this.listCalls += 1;
      if (this.#failListNetwork > 0) {
        this.#failListNetwork -= 1;
        throw new Error("fake s3 network failure");
      }
      if (this.#failListStatus !== undefined && this.#failListRemaining > 0) {
        this.#failListRemaining -= 1;
        if (this.#failListRemaining === 0) this.#failListStatus = undefined;
        return jsonResponse(this.#failListStatus ?? 500, { Error: { Code: "InternalError" } });
      }
      if (!virtualHost && !path.startsWith(expectedPath)) {
        return jsonResponse(404, { Error: { Code: "NoSuchBucket" } });
      }
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const token = parsed.searchParams.get("continuation-token");
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = token === null ? 0 : Number(token);
      const page = keys.slice(start, start + this.pageSize);
      const truncated = start + this.pageSize < keys.length;
      const encoded = parsed.searchParams.get("encoding-type") === "url";
      const contents = page
        .map((key) => {
          const obj = this.objects.get(key);
          if (obj === undefined) return "";
          const outKey = encoded ? encodeURIComponent(key) : xmlEscape(key);
          const etag = obj.etag ?? `"${hashStub(key)}"`;
          return (
            `<Contents><Key>${outKey}</Key>` +
            `<LastModified>${obj.lastModified ?? ""}</LastModified>` +
            `<ETag>${xmlEscape(etag)}</ETag>` +
            `<Size>${obj.body.byteLength}</Size></Contents>`
          );
        })
        .join("");
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Name>${this.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
        (encoded ? `<EncodingType>url</EncodingType>` : "") +
        `<IsTruncated>${truncated ? "true" : "false"}</IsTruncated>` +
        contents +
        (truncated ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : "") +
        `</ListBucketResult>`;
      return textResponse(200, xml);
    }
    // Object GET.
    this.getCalls += 1;
    const key =
      expectedPath !== "" && path.startsWith(`${expectedPath}/`)
        ? path.slice(expectedPath.length + 1)
        : path.slice(1);
    const obj = this.objects.get(key);
    if (obj === undefined) {
      return jsonResponse(404, { Error: { Code: "NoSuchKey" } });
    }
    return bytesResponse(200, obj.body);
  };
}

/** Deterministic non-cryptographic stub for default ETags. */
function hashStub(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").repeat(4);
}

function textResponse(status: number, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
    arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode(body)),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesResponse(status: number, body: Uint8Array) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => Buffer.from(body).toString("utf8"),
    arrayBuffer: async () => toArrayBuffer(body),
  };
}

function jsonResponse(status: number, body: unknown) {
  return textResponse(status, JSON.stringify(body));
}
