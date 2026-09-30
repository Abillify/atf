// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GDrive_Source (requirements 6.6, 6.7, 6.9, 6.10, 8.4).
 *
 * `files.list` per folder (`q='<folder>' in parents and trashed=false`),
 * recursive over folder MIME types, paginated per `pageToken`, shared drives
 * via `supportsAllDrives`. Workspace files (Docs/Sheets/Slides) are exported
 * in the configured format (default PDF); their marker is `revisionId`
 * because `md5Checksum` is absent. Authentication uses the per-source
 * `SourceCredential` from 12.5 — refresh token or service account — and the
 * access token is cached WITHIN one run only. The Extract token never
 * reaches this adapter.
 */

import { Readable } from "node:stream";
import { refreshSourceToken } from "../auth/source-oauth/exchange.js";
import {
  parseServiceAccountKey,
  serviceAccountToken,
} from "../auth/source-oauth/service-account.js";
import { SourceRejectedError } from "./types.js";
import type { SourceCredential } from "../auth/source-oauth/resolve.js";
import { isIncluded } from "./filter.js";
import type { SourceAdapter, SourceFetch, SourceItem } from "./types.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Workspace MIME types that must be exported rather than downloaded. */
export const WORKSPACE_EXPORT_MIME: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.presentation": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.google-apps.spreadsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Configured exportFormat → export mimeType. */
export function exportMimeType(exportFormat: string): string {
  switch (exportFormat) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return WORKSPACE_EXPORT_MIME["application/vnd.google-apps.document"] as string;
    case "xlsx":
      return WORKSPACE_EXPORT_MIME["application/vnd.google-apps.spreadsheet"] as string;
    case "pptx":
      return WORKSPACE_EXPORT_MIME["application/vnd.google-apps.presentation"] as string;
    default:
      return "application/pdf";
  }
}

export interface GdriveSourceOptions {
  id: string;
  folderId: string;
  exportFormat: string;
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface GdriveDeps {
  fetchImpl: SourceFetch;
  credential: Extract<SourceCredential, { kind: "refresh-token" | "service-account" }>;
  /** OAuth client id (refresh flow only). */
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  revisionId?: string;
  modifiedTime?: string;
  size?: string;
}

interface ListPage {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface GdriveSource extends SourceAdapter {
  /** The rotated refresh token after the run, when the provider rotated (6.17). */
  rotatedRefreshToken(): string | undefined;
}

export function createGdriveSource(
  options: GdriveSourceOptions,
  deps: GdriveDeps,
): GdriveSource {
  let accessToken: string | undefined;
  let rotated: string | undefined;

  /** Obtain (once per run) the access token; capture a rotated refresh token. */
  async function ensureToken(): Promise<string> {
    if (accessToken !== undefined) return accessToken;
    if (deps.credential.kind === "service-account") {
      const parsed = parseServiceAccountKey(deps.credential.keyJson);
      if (!parsed.ok) {
        throw new SourceRejectedError(`service-account key invalid: ${parsed.reason}`);
      }
      const result = await serviceAccountToken(parsed.key, deps.fetchImpl, {
        now: deps.now ?? (() => Date.now()),
      });
      if (result.kind === "rejected") {
        throw new SourceRejectedError("service-account assertion rejected");
      }
      accessToken = result.accessToken;
      return accessToken;
    }
    if (deps.clientId === undefined) {
      throw new SourceRejectedError("gdrive oauth client id missing");
    }
    const result = await refreshSourceToken(
      "gdrive",
      {
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
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

  async function listChildren(
    folderId: string,
    pageToken: string | undefined,
    signal: AbortSignal,
  ): Promise<ListPage> {
    const token = await ensureToken();
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields:
        "nextPageToken,files(id,name,mimeType,md5Checksum,revisionId,modifiedTime,size)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const response = await deps.fetchImpl(`${DRIVE_API}/files?${params.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`drive files.list failed with ${response.status}`);
    }
    const body = (await response.json()) as Partial<ListPage>;
    return { files: body.files ?? [], nextPageToken: body.nextPageToken };
  }

  async function* walk(
    folderId: string,
    parentPath: string,
    signal: AbortSignal,
  ): AsyncGenerator<SourceItem> {
    let pageToken: string | undefined;
    do {
      if (Boolean(signal.aborted)) throw new Error("listing aborted");
      const page = await listChildren(folderId, pageToken, signal);
      for (const file of page.files) {
        const displayPath =
          parentPath === "" ? file.name : `${parentPath}/${file.name}`;
        if (file.mimeType === FOLDER_MIME) {
          yield* walk(file.id, displayPath, signal);
          continue;
        }
        if (!isIncluded(displayPath, options.include, options.exclude)) continue;
        const workspace = WORKSPACE_EXPORT_MIME[file.mimeType] !== undefined;
        yield {
          quellId: file.id,
          name: file.name,
          size: Number(file.size ?? "0"),
          modified: new Date(file.modifiedTime ?? 0),
          // Workspace files lack md5Checksum → revisionId is the marker (6.6).
          marker: file.md5Checksum ?? file.revisionId ?? "",
          link: `https://drive.google.com/file/d/${file.id}/view`,
          mimeType: file.mimeType,
          exportAs: workspace ? options.exportFormat : undefined,
          displayPath,
        };
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
  }

  return {
    rotatedRefreshToken: () => rotated,
    list(signal: AbortSignal): AsyncIterable<SourceItem> {
      return walk(options.folderId, "", signal);
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      const token = await ensureToken();
      const id = encodeURIComponent(item.quellId);
      let url: string;
      if (item.exportAs !== undefined) {
        const mime = exportMimeType(item.exportAs);
        url = `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(mime)}&supportsAllDrives=true`;
      } else {
        url = `${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`;
      }
      const response = await deps.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) {
        throw new Error(`drive download/export of ${item.quellId} failed with ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return Readable.from(Buffer.from(bytes));
    },
  };
}
