// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Source abstraction shared by all adapters (requirements 6.1–6.8).
 *
 * `list` yields items and throws on any failure — the listing counts as
 * `complete` only when the iterator finishes without an error; every error
 * (including abort) makes it `incomplete`, which suppresses Mirror_Delete
 * for the run (6.12).
 */

import type { Readable } from "node:stream";

export interface SourceItem {
  /** Relative POSIX path (local) | S3 key | Drive file ID | Dropbox file ID. */
  quellId: string;
  /** Display title. */
  name: string;
  size: number;
  modified: Date;
  /**
   * Change marker: local `${mtimeMs}:${size}`; s3 ETag (unquoted);
   * gdrive `md5Checksum ?? revisionId`; dropbox `content_hash ?? rev`.
   */
  marker: string;
  link?: string;
  mimeType?: string;
  /** GDrive Workspace files: the configured export format (default pdf). */
  exportAs?: string;
  /**
   * Human-readable path used for include/exclude filtering of cloud items
   * (Drive/Dropbox report paths alongside their IDs).
   */
  displayPath?: string;
  /**
   * Per-item access control list supplied by the adapter (e.g. a cloud
   * source mapping native permissions). It takes precedence over the
   * source's configured ACL and replaces it entirely; when absent, the
   * source ACL applies.
   */
  acl?: { allowedUsers: string[]; allowedGroups: string[] };
}

export interface SourceAdapter {
  /** Yields every item; throws on error — clean end means complete. */
  list(signal: AbortSignal): AsyncIterable<SourceItem>;
  /** Opens the item content for upload. */
  open(item: SourceItem, signal: AbortSignal): Promise<Readable>;
}

export type ListingResult =
  | { kind: "complete"; items: SourceItem[] }
  | { kind: "incomplete"; items: SourceItem[]; error: unknown };

/** Drain an adapter's listing into a {@link ListingResult}. */
export async function collectListing(
  adapter: SourceAdapter,
  signal: AbortSignal,
): Promise<ListingResult> {
  const items: SourceItem[] = [];
  try {
    for await (const item of adapter.list(signal)) {
      if (Boolean(signal.aborted)) {
        throw new Error("listing aborted");
      }
      items.push(item);
    }
  } catch (error) {
    return { kind: "incomplete", items, error };
  }
  return { kind: "complete", items };
}

/** Raised when the provider rejects the stored credential (6.18). */
export class SourceRejectedError extends Error {
  constructor(message = "cloud provider rejected the stored credential") {
    super(message);
    this.name = "SourceRejectedError";
  }
}

/** Raised when a source needs authorization before it can be listed (6.18). */
export class SourceNeedsAuthorizationError extends Error {
  constructor(
    readonly sourceId: string,
    readonly reason: "missing" | "rejected",
  ) {
    super(`source ${sourceId} needs authorization (${reason})`);
    this.name = "SourceNeedsAuthorizationError";
  }
}

/**
 * Fetch surface used by the cloud adapters — like the auth `FetchLike` plus
 * `arrayBuffer` for content downloads and an abort signal.
 */
export type SourceFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Response header lookup (e.g. `Retry-After`); optional for fakes. */
  header?(name: string): string | undefined;
}>;
