// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 20: header and job-body construction
 *
 * **Validates: Requirements 8.1, 8.3, 8.4, 8.5**
 *
 * `buildIngestHeaders` always contains `X-Reference`, `X-Collection`,
 * `X-Source-Modified` (valid RFC 3339 with a time zone), `X-Dedup: auto`,
 * `X-Title` and `X-Source`. The optional headers `X-Tags`, `X-Metadata`,
 * `X-Allowed-Users`, `X-Allowed-Groups` and `X-Link` are present exactly
 * when the matching value is configured or provided by the item.
 * Decoding the header values with the Extract read logic yields the
 * original values, and `toJobRequest` produces the same values as a valid
 * `jobRequestSchema` body.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { jobRequestSchema } from "@atf/extract-contract/v2";
import {
  buildIngestHeaders,
  deriveReference,
  effectiveCollection,
  toJobRequest,
} from "../../src/index.js";
import { itemArb, outpostConfigArb, sourceConfigArb } from "../fakes/sync-arb.js";

/**
 * Reference re-implementation of Extract's `decodeIfBase64` (header-utils.ts):
 * `base64:` prefix → decode as UTF-8, otherwise unchanged.
 */
function decodeIfBase64(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase().startsWith("base64:")) {
    return Buffer.from(value.slice("base64:".length), "base64").toString("utf-8");
  }
  return value;
}

/** Nachbau von Extrakt `readListHeader`: dekodieren, kommatrennen, trimmen. */
function readList(value: string | undefined): string[] {
  const decoded = decodeIfBase64(value);
  if (decoded === undefined) return [];
  return decoded
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const RFC3339_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe("Property 20: header and job-body construction", () => {
  it("mandatory headers are always present and correct", () => {
    fc.assert(
      fc.property(itemArb, sourceConfigArb, outpostConfigArb, (item, src, cfg) => {
        const headers = buildIngestHeaders(item, src, cfg);
        expect(decodeIfBase64(headers["x-reference"])).toBe(deriveReference(src.id, item.quellId));
        expect(headers["x-collection"]).toBe(effectiveCollection(src, cfg));
        expect(headers["x-source-modified"]).toMatch(RFC3339_TZ);
        expect(new Date(String(headers["x-source-modified"])).getTime()).toBe(item.modified.getTime());
        expect(headers["x-dedup"]).toBe("auto");
        expect(headers["x-title"]).toBeDefined();
        expect(headers["x-source"]).toBeDefined();
        expect(decodeIfBase64(headers["x-source"])).toBe(`${src.type}:${src.id}`);
      }),
      { numRuns: 100 },
    );
  });

  it("header values are ASCII or base64:-encoded and round-trip", () => {
    fc.assert(
      fc.property(itemArb, sourceConfigArb, outpostConfigArb, (item, src, cfg) => {
        const headers = buildIngestHeaders(item, src, cfg);
        for (const [name, value] of Object.entries(headers)) {
          // Either printable ASCII or the base64: prefix, never raw Unicode.
          const ok = /^[\x20-\x7E]*$/.test(value) || value.startsWith("base64:");
          expect(ok, `${name}: ${JSON.stringify(value)}`).toBe(true);
        }
        // Round trip against the Extract read logic.
        expect(decodeIfBase64(headers["x-title"])).toBe(item.name.slice(0, 500));
        if (item.link !== undefined) {
          expect(decodeIfBase64(headers["x-link"])).toBe(item.link.slice(0, 2000));
        }
        // Compare like readListHeader: trimmed, empty entries removed.
        const norm = (values: readonly string[] | undefined) =>
          (values ?? []).map((v) => v.trim()).filter((v) => v !== "");
        expect(readList(headers["x-tags"])).toEqual(norm(src.tags));
        expect(readList(headers["x-allowed-users"])).toEqual(norm(src.allowedUsers));
        expect(readList(headers["x-allowed-groups"])).toEqual(norm(src.allowedGroups));
        const metadata = src.metadata ?? {};
        if (Object.keys(metadata).length > 0) {
          expect(JSON.parse(decodeIfBase64(headers["x-metadata"]) as string)).toEqual(metadata);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("optional headers present exactly when configured/provided", () => {
    fc.assert(
      fc.property(itemArb, sourceConfigArb, outpostConfigArb, (item, src, cfg) => {
        const headers = buildIngestHeaders(item, src, cfg);
        const norm = (values: readonly string[] | undefined) =>
          (values ?? []).map((v) => v.trim()).filter((v) => v !== "");
        const tags = norm(src.tags);
        const metadata = src.metadata ?? {};
        const users = norm(src.allowedUsers);
        const groups = norm(src.allowedGroups);
        const link = item.link !== undefined && item.link !== "";
        expect(headers["x-tags"] !== undefined).toBe(tags.length > 0);
        expect(headers["x-metadata"] !== undefined).toBe(Object.keys(metadata).length > 0);
        expect(headers["x-allowed-users"] !== undefined).toBe(users.length > 0);
        expect(headers["x-allowed-groups"] !== undefined).toBe(groups.length > 0);
        expect(headers["x-link"] !== undefined).toBe(link);
      }),
      { numRuns: 100 },
    );
  });

  it("toJobRequest is a valid jobRequestSchema body with the same values", () => {
    fc.assert(
      fc.property(
        itemArb,
        sourceConfigArb,
        outpostConfigArb,
        fc.stringMatching(/^[0-9a-f]{64}$/),
        (item, src, cfg, sha256) => {
          const body = toJobRequest(item, src, cfg, sha256);
          const parsed = jobRequestSchema.safeParse(body);
          expect(parsed.success).toBe(true);
          if (!parsed.success) return;
          const headers = buildIngestHeaders(item, src, cfg);
          expect(body.reference).toBe(decodeIfBase64(headers["x-reference"]));
          expect(body.sourceSha256).toBe(sha256);
          expect(body.collection).toBe(headers["x-collection"]);
          expect(body.sourceModifiedAt).toBe(headers["x-source-modified"]);
          expect(body.dedup).toBe("auto");
          expect(body.title).toBe(decodeIfBase64(headers["x-title"]));
          expect(body.sourceLabel).toBe(decodeIfBase64(headers["x-source"]));
          const norm = (values: readonly string[] | undefined) =>
            (values ?? []).map((v) => v.trim()).filter((v) => v !== "");
          expect(body.tags ?? []).toEqual(norm(src.tags));
          expect(body.metadata ?? {}).toEqual(src.metadata ?? {});
          expect(body.allowedUsers ?? []).toEqual(norm(src.allowedUsers));
          expect(body.allowedGroups ?? []).toEqual(norm(src.allowedGroups));
          expect(body.link).toEqual(
            headers["x-link"] === undefined ? undefined : decodeIfBase64(headers["x-link"]),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
