// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory Google Drive fake behind a {@link SourceFetch}.
 *
 * Serves the Drive v3 `files.list` endpoint with arbitrary page size and
 * `pageToken` pagination, `files/{id}` downloads, `files/{id}/export` for
 * Workspace files, and the OAuth token endpoint with injectable
 * `invalid_grant` and refresh-token rotation. Counts listing calls so tests
 * can prove a `needs-authorization` source never lists (6.18).
 */

import type { SourceFetch } from "../../src/index.js";

export interface FakeGdriveFile {
  id: string;
  name: string;
  parentId: string | null;
  mimeType: string;
  body?: Uint8Array;
  md5Checksum?: string;
  revisionId?: string;
  modifiedTime?: string;
}

export interface FakeGdriveOptions {
  files?: FakeGdriveFile[];
  pageSize?: number;
  /** Token endpoint answers invalid_grant until re-authorized. */
  rejectRefresh?: boolean;
  /** Rotate the refresh token on the next successful refresh. */
  rotateOnRefresh?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class FakeGdrive {
  readonly files: Map<string, FakeGdriveFile>;
  listCalls = 0;
  downloadCalls = 0;
  exportCalls = 0;
  tokenCalls = 0;
  /** Bearer tokens seen on API calls (asserts the Extract token never appears). */
  seenBearer: (string | undefined)[] = [];
  lastExportMimeType: string | undefined;
  private readonly pageSize: number;
  rejectRefresh: boolean;
  rotateOnRefresh: string | undefined;
  /** Access token issued by the fake token endpoint. */
  accessToken = "gdrive-access-token";
  #failListStatus: number | undefined;
  #failListRemaining = 0;
  #failListNetwork = 0;

  constructor(options: FakeGdriveOptions = {}) {
    this.files = new Map((options.files ?? []).map((f) => [f.id, f]));
    this.pageSize = options.pageSize ?? 1000;
    this.rejectRefresh = options.rejectRefresh ?? false;
    this.rotateOnRefresh = options.rotateOnRefresh;
  }

  addFile(file: FakeGdriveFile): void {
    this.files.set(file.id, file);
  }

  /** All Workspace files exported so far, by id. */
  readonly exported: string[] = [];

  /** Make the next `n` list calls fail with `status`. */
  injectListFailure(status: number, n = 1): void {
    this.#failListStatus = status;
    this.#failListRemaining = n;
  }

  /** Make the next `n` list calls throw a network error. */
  injectListNetworkFailure(n = 1): void {
    this.#failListNetwork = n;
  }

  readonly fetchImpl: SourceFetch = async (url, init) => {
    if (url === TOKEN_URL) {
      this.tokenCalls += 1;
      if (this.rejectRefresh) {
        return jsonResponse(400, { error: "invalid_grant" });
      }
      const body: Record<string, unknown> = {
        access_token: this.accessToken,
        token_type: "Bearer",
        expires_in: 3600,
      };
      if (this.rotateOnRefresh !== undefined) {
        body["refresh_token"] = this.rotateOnRefresh;
        this.rotateOnRefresh = undefined;
      }
      return jsonResponse(200, body);
    }
    this.seenBearer.push(init?.headers?.["authorization"]);
    const parsed = new URL(url);
    if (parsed.pathname === "/drive/v3/files" && init?.method !== "POST") {
      const auth = init?.headers?.["authorization"];
      if (auth !== `Bearer ${this.accessToken}`) {
        return jsonResponse(401, { error: { status: 401, message: "Unauthenticated" } });
      }
      this.listCalls += 1;
      if (this.#failListNetwork > 0) {
        this.#failListNetwork -= 1;
        throw new Error("fake gdrive network failure");
      }
      const failStatus = this.#failListStatus;
      if (failStatus !== undefined && this.#failListRemaining > 0) {
        this.#failListRemaining -= 1;
        if (this.#failListRemaining === 0) this.#failListStatus = undefined;
        return jsonResponse(failStatus, { error: { status: failStatus } });
      }
      const q = parsed.searchParams.get("q") ?? "";
      const match = /^'([^']+)' in parents and trashed=false$/.exec(q);
      const parentId = match?.[1] ?? null;
      const children = [...this.files.values()]
        .filter((f) => f.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name));
      const pageToken = parsed.searchParams.get("pageToken");
      const start = pageToken === null ? 0 : Number(pageToken);
      const page = children.slice(start, start + this.pageSize);
      const hasMore = start + this.pageSize < children.length;
      return jsonResponse(200, {
        ...(hasMore ? { nextPageToken: String(start + this.pageSize) } : {}),
        files: page.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          ...(f.md5Checksum !== undefined ? { md5Checksum: f.md5Checksum } : {}),
          ...(f.revisionId !== undefined ? { revisionId: f.revisionId } : {}),
          modifiedTime: f.modifiedTime ?? "2026-01-01T00:00:00Z",
          ...(f.body !== undefined ? { size: String(f.body.byteLength) } : { size: "0" }),
        })),
      });
    }
    const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(parsed.pathname);
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(parsed.pathname);
    const target = exportMatch?.[1] ?? fileMatch?.[1];
    const file = target !== undefined ? this.files.get(decodeURIComponent(target)) : undefined;
    if (file === undefined) {
      return jsonResponse(404, { error: { status: 404, message: "notFound" } });
    }
    if (exportMatch !== null && exportMatch !== undefined) {
      this.exportCalls += 1;
      this.exported.push(file.id);
      this.lastExportMimeType = parsed.searchParams.get("mimeType") ?? undefined;
      const exportedBody =
        file.body ?? new TextEncoder().encode(`exported:${file.name}:${parsed.searchParams.get("mimeType") ?? ""}`);
      return bytesResponse(200, exportedBody);
    }
    this.downloadCalls += 1;
    if (file.mimeType === FOLDER_MIME) {
      return jsonResponse(400, { error: { status: 400, message: "cannotDownloadFolder" } });
    }
    return bytesResponse(200, file.body ?? new Uint8Array());
  };
}

function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode(text)),
  };
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
