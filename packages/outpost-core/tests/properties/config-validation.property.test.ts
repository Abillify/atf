// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 3 (collection-name validation), Property 4 (URL scheme rule) and
 * Property 5 (effective collection per source).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  COLLECTION_PATTERN,
  isExtractUrlAllowed,
  effectiveCollection,
  validateConfig,
} from "../../src/index.js";
import { collectionArb } from "../fakes/config-arb.js";

/** A base configuration that is valid before the field under test is swapped. */
const validBase = {
  extractUrl: "https://extract.example.com",
  allowInsecureLocalhost: false,
  collection: "documents",
  syncIntervalSec: 900,
  mirrorDelete: true,
  deleteThresholdPercent: 50,
  resumableThresholdBytes: 33_554_432,
  maxConcurrentUploads: 4,
  health: { bind: "127.0.0.1", port: 8787 },
  cloudOAuth: {},
  sources: [] as unknown[],
};

// Feature: extract-outpost, Property 3: validation of the collection name
// **Validates: Requirements 1.4**
describe("Property 3: collection name validation", () => {
  const pattern = /^[a-zA-Z][a-zA-Z0-9_]*$/;

  it("accepts exactly the strings matching the pattern (global collection)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 24 }), async (collection) => {
        const result = validateConfig({ ...validBase, collection });
        const matches = pattern.test(collection);
        expect(result.ok).toBe(matches);
        if (!result.ok) {
          // Every rejection names the expected pattern verbatim (1.4).
          const text = result.errors.map((e) => e.message).join("\n");
          expect(text).toContain(COLLECTION_PATTERN);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("accepts exactly the strings matching the pattern (source collection)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 24 }), async (collection) => {
        const result = validateConfig({
          ...validBase,
          sources: [{ type: "local", id: "src1", path: "/srv/docs", watch: false, collection }],
        });
        const matches = pattern.test(collection);
        expect(result.ok).toBe(matches);
        if (!result.ok) {
          const text = result.errors.map((e) => e.message).join("\n");
          expect(text).toContain(COLLECTION_PATTERN);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: extract-outpost, Property 4: URL-Schema-Regel
// **Validates: Requirements 1.5, 1.6**
describe("Property 4: extract URL scheme rule", () => {
  const schemeArb = fc.constantFrom("https", "http", "ftp", "ws", "file", "https+unix");
  const hostArb = fc.constantFrom(
    "example.com",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "LOCALHOST",
    "127.0.0.2",
  );
  const portArb = fc.option(fc.integer({ min: 1, max: 65535 }).map(String), { nil: "" });
  const pathArb = fc.constantFrom("", "/", "/extract", "/a/b?c=1#d");

  it("https always; http only with the flag and a local host", async () => {
    await fc.assert(
      fc.asyncProperty(
        schemeArb,
        hostArb,
        portArb,
        pathArb,
        fc.boolean(),
        async (scheme, host, port, path, flag) => {
          const url = `${scheme}://${host}${port === "" ? "" : `:${port}`}${path}`;
          const result = isExtractUrlAllowed(url, flag);
          // The WHATWG URL parser lowercases the hostname, so the local-host
          // check is case-insensitive by design.
          const lower = host.toLowerCase();
          const hostIsLocal = lower === "localhost" || lower === "127.0.0.1";
          const expected = scheme === "https" || (scheme === "http" && flag && hostIsLocal);
          expect(result.ok).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects anything that is not an absolute URL with a host", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom("", "extract.example.com", "/just/a/path", "://broken", "https://"),
          // Anything without a scheme: `new URL` rejects all of these, and a
          // scheme-less string can never be an absolute URL.
          fc.string({ maxLength: 12 }).filter((s) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)),
        ),
        fc.boolean(),
        async (url, flag) => {
          const result = isExtractUrlAllowed(url, flag);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: extract-outpost, Property 5: Effektive Collection je Source
// **Validates: Requirements 1.8**
describe("Property 5: effective collection per source", () => {
  it("source collection wins, else the global one", async () => {
    await fc.assert(
      fc.asyncProperty(
        collectionArb,
        fc.option(collectionArb, { nil: undefined }),
        async (globalCollection, sourceCollection) => {
          const input = {
            ...validBase,
            collection: globalCollection,
            sources: [
              {
                type: "local",
                id: "src1",
                path: "/srv/docs",
                watch: false,
                ...(sourceCollection !== undefined ? { collection: sourceCollection } : {}),
              },
            ],
          };
          const result = validateConfig(input);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const src = result.value.sources[0];
          expect(src).toBeDefined();
          if (src === undefined) return;
          expect(effectiveCollection(src, result.value)).toBe(
            sourceCollection ?? globalCollection,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
