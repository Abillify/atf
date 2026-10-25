// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory Dropbox fake behind a {@link SourceFetch}.
 *
 * Serves `files/list_folder` (recursive) with cursor pagination,
 * `files/download` via the `Dropbox-API-Arg` header, and the OAuth token
 * endpoint with injectable `invalid_grant` and rotation. Counts listing
 * calls (6.18 assertions).
 */

import type { SourceFetch } from "../../src/index.js";

export interface FakeDropboxEntry {
  id: string;
  name: string;
  /** Full display path, e.g. "/sync/docs/a.pdf". */
  pathDisplay: string;
  type: "file" | "folder";
  body?: Uint8Array;
  contentHash?: string;
  rev?: string;
  serverModified?: string;
}

export interface FakeDropboxOptions {
  entries?: FakeDropboxEntry[];
  pageSize?: number;
  rejectRefresh?: boolean;
  rotateOnRefresh?: string;
}

const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

export class FakeDropbox {
  readonly entries: FakeDropboxEntry[];
  listCalls = 0;
  continueCalls = 0;
  downloadCalls = 0;
  tokenCalls = 0;
  seenBearer: (string | undefined)[] = [];
  lastDownloadPath: string | undefined;
  accessToken = "dropbox-access-token";
  rejectRefresh: boolean;
  rotateOnRefresh: string | undefined;
  private readonly pageSize: number;

  constructor(options: FakeDropboxOptions = {}) {
    this.entries = [...(options.entries ?? [])];
    this.pageSize = options.pageSize ?? 1000;
    this.rejectRefresh = options.rejectRefresh ?? false;
    this.rotateOnRefresh = options.rotateOnRefresh;
  }

  addEntry(entry: FakeDropboxEntry): void {
    this.entries.push(entry);
  }

  private pageFor(path: string): FakeDropboxEntry[] {
    const normalized = path === "" ? "" : path.replace(/\/+$/, "");
    return this.entries.filter(
      (e) =>
        e.pathDisplay !== normalized &&
        (normalized === "" || e.pathDisplay.startsWith(`${normalized}/`)),
    );
  }

  private entryJson(e: FakeDropboxEntry): Record<string, unknown> {
    return {
      ".tag": e.type,
      id: e.id,
      name: e.name,
      path_lower: e.pathDisplay.toLowerCase(),
      path_display: e.pathDisplay,
      ...(e.type === "file"
        ? {
            size: e.body?.byteLength ?? 0,
            server_modified: e.serverModified ?? "2026-01-01T00:00:00Z",
            ...(e.contentHash !== undefined ? { content_hash: e.contentHash } : {}),
            ...(e.rev !== undefined ? { rev: e.rev } : {}),
          }
        : {}),
    };
  }

  readonly fetchImpl: SourceFetch = async (url, init) => {
    if (url === TOKEN_URL) {
      this.tokenCalls += 1;
      if (this.rejectRefresh) {
        return jsonResponse(400, { error: "invalid_grant" });
      }
      const body: Record<string, unknown> = {
        access_token: this.accessToken,
        token_type: "bearer",
        expires_in: 14400,
      };
      if (this.rotateOnRefresh !== undefined) {
        body["refresh_token"] = this.rotateOnRefresh;
        this.rotateOnRefresh = undefined;
      }
      return jsonResponse(200, body);
    }
    this.seenBearer.push(init?.headers?.["authorization"]);
    const auth = init?.headers?.["authorization"];
    if (auth !== `Bearer ${this.accessToken}`) {
      return jsonResponse(401, { error_summary: "invalid_access_token/." });
    }
    if (url === "https://api.dropboxapi.com/2/files/list_folder") {
      this.listCalls += 1;
      const req = JSON.parse(init?.body ?? "{}") as { path?: string };
      this.#lastPath = req.path ?? "";
      const all = this.pageFor(this.#lastPath);
      const page = all.slice(0, this.pageSize);
      return jsonResponse(200, {
        entries: page.map((e) => this.entryJson(e)),
        cursor: "cursor-1",
        has_more: all.length > this.pageSize,
      });
    }
    if (url === "https://api.dropboxapi.com/2/files/list_folder/continue") {
      this.continueCalls += 1;
      const req = JSON.parse(init?.body ?? "{}") as { cursor?: string };
      const pageNum = Number((req.cursor ?? "cursor-1").split("-")[1] ?? "1");
      // The fake re-derives the full list; the path is not carried in the
      // continue request, so tests keep one folder per fake instance.
      const all = this.pageFor(this.#lastPath);
      const start = pageNum * this.pageSize;
      const page = all.slice(start, start + this.pageSize);
      return jsonResponse(200, {
        entries: page.map((e) => this.entryJson(e)),
        cursor: `cursor-${pageNum + 1}`,
        has_more: start + this.pageSize < all.length,
      });
    }
    if (url === "https://content.dropboxapi.com/2/files/download") {
      this.downloadCalls += 1;
      const arg = JSON.parse(init?.headers?.["Dropbox-API-Arg"] ?? "{}") as { path?: string };
      this.lastDownloadPath = arg.path;
      const entry = this.entries.find((e) => e.pathDisplay === arg.path && e.type === "file");
      if (entry === undefined) {
        return jsonResponse(409, { error_summary: "path/not_found/." });
      }
      return bytesResponse(200, entry.body ?? new Uint8Array());
    }
    return jsonResponse(404, { error_summary: "endpoint_not_found" });
  };

  #lastPath = "";
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
