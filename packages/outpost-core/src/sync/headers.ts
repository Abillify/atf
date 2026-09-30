// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Header and job-body construction (requirements 1.8, 8.1, 8.3, 8.4, 8.5).
 *
 * `buildIngestHeaders` produces the `X-…` headers for `POST /v1/ingest`;
 * `toJobRequest` maps the SAME values onto the `jobRequestSchema` body of
 * `POST /v2/jobs` (the resumable path, 8.5). Non-ASCII values use the
 * `base64:` convention that Extract's `readHeader`/`readListHeader`
 * (`header-utils.ts`) decodes — the very encoder Search uses via
 * `encodeHeaderValue` from `@atf/extract-contract/v1`, so a header written
 * here round-trips through Extract unchanged (Property 20).
 */

import { encodeHeaderValue } from "@atf/extract-contract/v1";
import type { JobRequest } from "@atf/extract-contract/v2";
import { effectiveCollection } from "../config/validate.js";
import type { OutpostConfig, SourceConfig } from "../config/schema.js";
import { deriveReference } from "./reference.js";
import type { SourceItem } from "../sources/types.js";

/** `jobRequestSchema` caps title/filename at 500 and link at 2000 characters. */
const MAX_TITLE_LENGTH = 500;
const MAX_LINK_LENGTH = 2000;

/**
 * Normalize a comma-list value the way Extract's `readListHeader` reads it
 * (trim each entry, drop empties) — so the decoded header equals what was
 * sent and the round-trip is stable.
 */
function normalizeList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value !== "");
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** The provenance label `"<type>:<sourceId>"` sent as `X-Source` (8.1). */
export function sourceLabel(src: SourceConfig): string {
  return `${src.type}:${src.id}`;
}

/**
 * RFC 3339 in UTC with a `Z` offset — the form Extract accepts in
 * `X-Source-Modified` and `sourceModifiedAt`.
 */
export function rfc3339Utc(date: Date): string {
  return date.toISOString();
}

/**
 * Headers for `POST /v1/ingest` (8.1, 8.3, 8.4). Always present:
 * `X-Reference`, `X-Collection` (effective per source, 1.8),
 * `X-Source-Modified` (RFC 3339 UTC), `X-Dedup: auto`, `X-Title`,
 * `X-Source`. Optional — only when configured / provided by the item:
 * `X-Tags`, `X-Metadata` (JSON), `X-Allowed-Users`, `X-Allowed-Groups`,
 * `X-Link`.
 */
export function buildIngestHeaders(
  item: SourceItem,
  src: SourceConfig,
  cfg: OutpostConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-reference": encodeHeaderValue(deriveReference(src.id, item.quellId)),
    "x-collection": effectiveCollection(src, cfg),
    "x-source-modified": rfc3339Utc(item.modified),
    "x-dedup": "auto",
    "x-title": encodeHeaderValue(truncate(item.name, MAX_TITLE_LENGTH)),
    "x-source": encodeHeaderValue(sourceLabel(src)),
  };
  const tags = normalizeList(src.tags);
  if (tags.length > 0) headers["x-tags"] = encodeHeaderValue(tags.join(","));
  const metadata = src.metadata ?? {};
  if (Object.keys(metadata).length > 0) {
    headers["x-metadata"] = encodeHeaderValue(JSON.stringify(metadata));
  }
  const allowedUsers = normalizeList(src.allowedUsers);
  if (allowedUsers.length > 0) {
    headers["x-allowed-users"] = encodeHeaderValue(allowedUsers.join(","));
  }
  const allowedGroups = normalizeList(src.allowedGroups);
  if (allowedGroups.length > 0) {
    headers["x-allowed-groups"] = encodeHeaderValue(allowedGroups.join(","));
  }
  if (item.link !== undefined && item.link !== "") {
    headers["x-link"] = encodeHeaderValue(truncate(item.link, MAX_LINK_LENGTH));
  }
  return headers;
}

/**
 * The `POST /v2/jobs` body for an already-uploaded source (8.5): the same
 * values as the ingest headers, with `sourceSha256` addressing the upload.
 * Validated by the caller against `jobRequestSchema` (`createJob` does).
 */
export function toJobRequest(
  item: SourceItem,
  src: SourceConfig,
  cfg: OutpostConfig,
  sha256: string,
): JobRequest {
  const tags = normalizeList(src.tags);
  const metadata = src.metadata ?? {};
  const allowedUsers = normalizeList(src.allowedUsers);
  const allowedGroups = normalizeList(src.allowedGroups);
  const request: JobRequest = {
    reference: deriveReference(src.id, item.quellId),
    sourceSha256: sha256,
    filename: truncate(item.name, MAX_TITLE_LENGTH),
    collection: effectiveCollection(src, cfg),
    sourceModifiedAt: rfc3339Utc(item.modified),
    dedup: "auto",
    title: truncate(item.name, MAX_TITLE_LENGTH),
    sourceLabel: sourceLabel(src),
  };
  if (tags.length > 0) request.tags = tags;
  if (Object.keys(metadata).length > 0) request.metadata = { ...metadata };
  if (allowedUsers.length > 0) request.allowedUsers = [...allowedUsers];
  if (allowedGroups.length > 0) request.allowedGroups = [...allowedGroups];
  if (item.link !== undefined && item.link !== "") {
    request.link = truncate(item.link, MAX_LINK_LENGTH);
  }
  return request;
}
