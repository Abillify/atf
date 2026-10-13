// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Metadata parser tests for vectorsearch-api
 *
 * Validates: Requirements 3.1–3.5, 13.6, 13.7
 */

import * as fc from "fast-check";
import {
  parseMetadataHeader,
  encodeBase64,
  decodeBase64,
} from "../src/metadata.js";

// ---------------------------------------------------------------------------
// Task 4.2 — Unit tests
// ---------------------------------------------------------------------------

describe("parseMetadataHeader — unit tests", () => {
  it("parses plain JSON from X-Metadata header", () => {
    const result = parseMetadataHeader('{"client":"acme"}');
    expect(result).toEqual({ metadata: { client: "acme" } });
  });

  it("parses Base64-encoded JSON when value has base64: prefix", () => {
    const result = parseMetadataHeader(
      "base64:" + encodeBase64('{"client":"acme"}'),
    );
    expect(result).toEqual({ metadata: { client: "acme" } });
  });

  it("returns empty metadata object when header is missing (no error)", () => {
    const result = parseMetadataHeader(undefined);
    expect(result).toEqual({ metadata: {} });
    expect(result.error).toBeUndefined();
  });

  it("returns empty metadata object when header is empty string (no error)", () => {
    const result = parseMetadataHeader("");
    expect(result).toEqual({ metadata: {} });
    expect(result.error).toBeUndefined();
  });

  it("returns error with status 400 for invalid JSON", () => {
    const result = parseMetadataHeader("not-json");
    expect(result.error).toBeDefined();
    expect(result.error.status).toBe(400);
  });

  it("returns error with status 400 for JSON array (not an object)", () => {
    const result = parseMetadataHeader("[1,2,3]");
    expect(result.error).toBeDefined();
    expect(result.error.status).toBe(400);
  });

  it("preserves all known metadata fields: id, s3key, client, property, viewers", () => {
    const input = {
      id: "doc-123",
      s3key: "bucket/path/file.md",
      client: "acme",
      property: "prop-456",
      viewers: ["alice", "bob"],
    };
    const result = parseMetadataHeader(JSON.stringify(input));
    expect(result.error).toBeUndefined();
    expect(result.metadata).toEqual(input);
  });

  it("preserves unknown/arbitrary extra fields", () => {
    const input = {
      client: "acme",
      customField: "custom-value",
      anotherField: 42,
      nested: { key: "value" },
    };
    const result = parseMetadataHeader(JSON.stringify(input));
    expect(result.error).toBeUndefined();
    expect(result.metadata).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// Task 4.3 — Property 1: Metadata JSON Round-Trip
// **Validates: Requirements 3.1, 13.6**
// ---------------------------------------------------------------------------

// JSON-safe number generator: excludes -0, NaN, Infinity (not representable in JSON)
const jsonSafeNumber = fc.oneof(
  fc.integer({ min: 1, max: 2147483647 }),
  fc.integer({ min: -2147483648, max: -1 }),
  fc.constant(0),
  fc
    .double({ noNaN: true, noDefaultInfinity: true, noNegativeZero: true })
    .filter((n) => n !== 0 || Object.is(n, 0)),
);

describe("Property 1: Metadata JSON Round-Trip", () => {
  /**
   * For any valid JSON object used as metadata, serializing it to a JSON string
   * and parsing it back should produce an object deeply equal to the original.
   *
   * Tag: Feature: vectorsearch-api, Property 1: Metadata JSON Round-Trip
   *
   * Note: fc.object() is constrained to JSON-safe leaf values (no undefined)
   * because JSON.stringify converts undefined to null, breaking deep equality.
   * -0 is excluded because JSON.stringify(-0) === "0", so -0 cannot survive
   * a JSON round-trip.
   */
  it("round-trips any JSON object through JSON.stringify and parseMetadataHeader", () => {
    fc.assert(
      fc.property(
        fc.object({
          values: [
            fc.string(),
            jsonSafeNumber,
            fc.boolean(),
            fc.constant(null),
          ],
        }),
        (obj) => {
          const result = parseMetadataHeader(JSON.stringify(obj));
          expect(result.error).toBeUndefined();
          expect(result.metadata).toEqual(obj);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 4.4 — Property 2: Base64 Encode/Decode Round-Trip
// **Validates: Requirements 3.2, 13.7**
// ---------------------------------------------------------------------------

describe("Property 2: Base64 Metadata Encode/Decode Round-Trip", () => {
  /**
   * For any string (including non-ASCII, Unicode, special chars),
   * decodeBase64(encodeBase64(x)) === x.
   *
   * Tag: Feature: vectorsearch-api, Property 2: Base64 Metadata Encode/Decode Round-Trip
   */
  it("round-trips any ASCII string through encodeBase64 and decodeBase64", () => {
    fc.assert(
      fc.property(fc.string(), (str) => {
        expect(decodeBase64(encodeBase64(str))).toBe(str);
      }),
      { numRuns: 100 },
    );
  });

  it("round-trips any Unicode string through encodeBase64 and decodeBase64", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (str) => {
        expect(decodeBase64(encodeBase64(str))).toBe(str);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 4.5 — Property 3: Invalid JSON Metadata Rejected
// **Validates: Requirements 3.4**
// ---------------------------------------------------------------------------

describe("Property 3: Invalid JSON Metadata Rejected", () => {
  /**
   * For any string that is not valid JSON, parseMetadataHeader should return
   * an error (status 400), never a successful parse.
   *
   * Tag: Feature: vectorsearch-api, Property 3: Invalid JSON Metadata Rejected
   */
  it("rejects any non-JSON string with status 400", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => {
          // Empty string is treated as missing header (returns empty metadata, no error)
          // so exclude it — it's not "invalid JSON", it's "no header"
          if (s === "") return false;
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        }),
        (str) => {
          const result = parseMetadataHeader(str);
          expect(result.error).toBeDefined();
          expect(result.error.status).toBe(400);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 4.6 — Property 4: Arbitrary Metadata Fields Accepted
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

describe("Property 4: Arbitrary Metadata Fields Accepted", () => {
  /**
   * For any JSON object (regardless of which fields it contains), the metadata
   * parser should accept it without error and preserve all fields.
   *
   * Tag: Feature: vectorsearch-api, Property 4: Arbitrary Metadata Fields Accepted
   */
  it("accepts any JSON object without error and preserves all fields", () => {
    fc.assert(
      fc.property(
        fc.object({
          // Exclude -0: JSON.stringify converts -0 to "0", so -0 cannot survive
          // a JSON round-trip. -0 is not representable in JSON.
          values: [
            fc.string(),
            jsonSafeNumber,
            fc.boolean(),
            fc.constant(null),
          ],
        }),
        (obj) => {
          const result = parseMetadataHeader(JSON.stringify(obj));
          expect(result.error).toBeUndefined();
          expect(result.metadata).toEqual(obj);
        },
      ),
      { numRuns: 100 },
    );
  });
});
