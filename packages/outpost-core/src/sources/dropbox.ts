// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dropbox_Source (requirements 6.8, 6.9, 8.4).
 *
 * `files/list_folder` with `recursive=true` plus `list_folder/continue`;
 * only entries with `.tag === "file"`. The marker is `content_hash ?? rev`.
 * Authentication uses the per-source refresh token from 12.3/12.5; the
 * access token is cached within one run only. Downloads go to the
 * content endpoint with the `Dropbox-API-Arg` header.
 */

import { Readable } from "node:stream";
import { refreshSourceToken } from "../auth/source-oauth/exchange.js";
import type { SourceCredential } from "../auth/source-oauth/resolve.js";
import { isIncluded } from "./filter.js";
import { SourceRejectedError } from "./types.js";
import type { SourceAdapter, SourceFetch, SourceItem } from "./types.js";

const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";

export interface DropboxSourceOptions {
  id: string;
  /** Folder path inside Dropbox, e.g. "/sync" ("" = root). */
  path: string;
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface DropboxDeps {
  fetchImpl: SourceFetch;
  credential: Extract<SourceCredential, { kind: "refresh-token" }>;
  clientId: string;
  now?: () => number;
}

export interface DropboxSource extends SourceAdapter {
  rotatedRefreshToken(): string | undefined;
}

interface DropboxEntry {
  ".tag": string;
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
  rev?: string;
}

interface ListFolderResponse {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}

export function createDropboxSource(
  options: DropboxSourceOptions,
  deps: DropboxDeps,
): DropboxSource {
  let accessToken: string | undefined;
  let rotated: string | undefined;

  async function ensureToken(): Promise<string> {
    if (accessToken !== undefined) return accessToken;
    const result = await refreshSourceToken(
      "dropbox",
      {
        clientId: deps.clientId,
        refreshToken: deps.credential.token,
      },
      deps.fetchImpl,
    );
    if (result.kind === "rejected") {
      throw new SourceRejectedError();
    }
    if (result.refreshToken !== undefined) rotated = result.refreshToken;
    accessToken = result.accessToken;
    return accessToken;
  }

  async function rpc<T>(
    endpoint: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    const token = await ensureToken();
    const response = await deps.fetchImpl(`${DROPBOX_API}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`dropbox ${endpoint} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async function* walk(signal: AbortSignal): AsyncGenerator<SourceItem> {
    let response = await rpc<ListFolderResponse>(
      "/files/list_folder",
      { path: options.path, recursive: true, limit: 1000 },
      signal,
    );
    for (;;) {
      if (Boolean(signal.aborted)) throw new Error("listing aborted");
      for (const entry of response.entries ?? []) {
        if (entry[".tag"] !== "file") continue;
        if (entry.id === undefined || entry.name === undefined) continue;
        const displayPath = entry.path_display ?? `/${entry.name}`;
        if (!isIncluded(displayPath, options.include, options.exclude)) continue;
        yield {
          quellId: entry.id,
          name: entry.name,
          size: entry.size ?? 0,
          modified: new Date(entry.server_modified ?? 0),
          // 6.8: content_hash, else rev.
          marker: entry.content_hash ?? entry.rev ?? "",
          link: `https://www.dropbox.com/preview${encodeURI(displayPath)}`,
          displayPath,
        };
      }
      if (response.has_more !== true || response.cursor === undefined) break;
      response = await rpc<ListFolderResponse>(
        "/files/list_folder/continue",
        { cursor: response.cursor },
        signal,
      );
    }
  }

  return {
    rotatedRefreshToken: () => rotated,
    list(signal: AbortSignal): AsyncIterable<SourceItem> {
      return walk(signal);
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      const token = await ensureToken();
      const displayPath = item.displayPath ?? `/${item.name}`;
      const response = await deps.fetchImpl(`${DROPBOX_CONTENT}/files/download`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          // The arg header carries the path; the body stays empty.
          "Dropbox-API-Arg": JSON.stringify({ path: displayPath }),
        },
        signal,
      });
      if (!response.ok) {
        throw new Error(`dropbox download of ${item.quellId} failed with ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return Readable.from(Buffer.from(bytes));
    },
  };
}
