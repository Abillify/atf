// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * CBOR codec tests (Req 15.3, Property 14).
 *
 * The codec must match the RFC 8949 known-answer vectors, produce canonical
 * (deterministic) output, and reject every non-canonical or malformed input
 * — a permissive decoder would make receipt signatures malleable.
 */

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  CborDecodeError,
  CborEncodeError,
  cborDecode,
  cborEncode,
  cborMap,
  cborTagged,
  type CborValue,
} from "../src/cbor/index.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(s: string): Uint8Array {
  return new Uint8Array(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
}

describe("cborEncode — RFC 8949 Appendix A vectors", () => {
  const vectors: [CborValue, string][] = [
    [0, "00"],
    [1, "01"],
    [10, "0a"],
    [23, "17"],
    [24, "1818"],
    [100, "1864"],
    [1000, "1903e8"],
    [1000000, "1a000f4240"],
    [1000000000000, "1b000000e8d4a51000"],
    [-1, "20"],
    [-1000, "3903e7"],
    ["", "60"],
    ["a", "6161"],
    ["IETF", "6449455446"],
    [new Uint8Array([1, 2, 3, 4]), "4401020304"],
    [true, "f5"],
    [false, "f4"],
    [null, "f6"],
    [[], "80"],
    [[1, 2, 3], "83010203"],
    [
      [
        [1, 2],
        [3, 4],
      ],
      "82820102820304",
    ],
    [{ a: 1, b: [2, 3] }, "a26161016162820203"],
    [1.5, "fb3ff8000000000000"],
    [3.4e9, "1acaa7e200"],
    [18446744073709551615n, "1bffffffffffffffff"],
    [-18446744073709551616n, "3bffffffffffffffff"],
  ];
  for (const [value, want] of vectors) {
    test(`${typeof value === "bigint" ? `${value}n` : JSON.stringify(value)} -> ${want}`, () => {
      expect(hex(cborEncode(value))).toBe(want);
    });
  }
});

describe("cborEncode — determinism", () => {
  test("map keys are emitted in bytewise-lexicographic order", () => {
    expect(hex(cborEncode({ b: 2, a: 1 }))).toBe("a2616101616202");
    expect(hex(cborEncode({ z: 0, a: 0, m: 0, A: 0 }))).toBe(
      hex(cborEncode({ A: 0, a: 0, m: 0, z: 0 })),
    );
  });

  test("integer COSE-style header labels encode canonically", () => {
    // {1: -8, 4: "k-1"} — COSE protected header with integer labels.
    const enc = cborEncode(cborMap([[1, -8], [4, "k-1"]]));
    expect(hex(enc)).toBe("a2012704636b2d31");
  });

  test("duplicate keys are rejected", () => {
    expect(() =>
      cborEncode(cborMap([["a", 1], ["a", 2]])),
    ).toThrow(CborEncodeError);
    expect(() => cborEncode(cborMap([[1, 1], [1, 2]]))).toThrow(CborEncodeError);
  });

  test("NaN and Infinity are rejected", () => {
    expect(() => cborEncode(Number.NaN)).toThrow(CborEncodeError);
    expect(() => cborEncode(Number.POSITIVE_INFINITY)).toThrow(CborEncodeError);
  });
});

describe("cborDecode — canonical-form enforcement", () => {
  const bad: [string, string][] = [
    ["non-shortest head", "1800"],
    ["indefinite array", "9f01ff"],
    ["indefinite map", "bf616101ff"],
    ["duplicate map key", "a2616101616102"],
    ["trailing bytes", "0102"],
    ["NaN half-float", "f97e00"],
    ["break outside indefinite", "ff"],
    ["truncated string", "6361"],
    ["empty input", ""],
  ];
  for (const [name, input] of bad) {
    test(`rejects ${name}`, () => {
      expect(() => cborDecode(fromHex(input))).toThrow(CborDecodeError);
    });
  }

  test("decodes half-floats (f93e00 = 1.5)", () => {
    expect(cborDecode(fromHex("f93e00"))).toBe(1.5);
  });

  test("decodes integer-keyed maps as CborMap", () => {
    const v = cborDecode(fromHex("a2012704636b2d31"));
    expect(v).toEqual({ entries: [[1, -8], [4, "k-1"]] });
  });

  test("preserves tags", () => {
    const v = cborDecode(fromHex("c11a54d9f4c4"));
    expect(v).toEqual({ tag: 1, value: 1423570116 });
  });
});

describe("Property 14: CBOR round-trip (Req 15.3)", () => {
  // Arbitrary for the supported value subset.
  const cborArb: fc.Arbitrary<CborValue> = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: "small" },
      fc.integer({ min: -1000000000, max: 1000000000 }),
      fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n - 1n }),
      fc.boolean(),
      fc.constant(null),
      fc.string({ maxLength: 40 }),
      fc.uint8Array({ maxLength: 40 }),
      fc.array(tie("value"), { maxLength: 5 }),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 10 }),
        tie("value"),
        { maxKeys: 5 },
      ),
    ),
  })).value as fc.Arbitrary<CborValue>;

  test("decode(encode(x)) re-encodes to identical bytes", () => {
    fc.assert(
      fc.property(cborArb, (value) => {
        const encoded = cborEncode(value);
        const decoded = cborDecode(encoded);
        expect(cborEncode(decoded)).toEqual(encoded);
      }),
      { numRuns: 500 },
    );
  });

  test("any single-bit flip in the encoding fails to decode or differs", () => {
    fc.assert(
      fc.property(
        cborArb,
        fc.integer({ min: 0, max: 1023 }),
        fc.integer({ min: 0, max: 7 }),
        (value, byteIdx, bitIdx) => {
          const encoded = cborEncode(value);
          if (byteIdx >= encoded.length) return;
          const mutated = Uint8Array.from(encoded);
          const i = byteIdx % mutated.length;
          mutated[i] = (mutated[i] ?? 0) ^ (1 << bitIdx);
          let decoded: CborValue | undefined;
          try {
            decoded = cborDecode(mutated);
          } catch {
            return; // rejected — acceptable
          }
          // If it decodes, it must not be byte-identical to the original.
          expect(cborEncode(decoded)).not.toEqual(encoded);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("tags round-trip", () => {
    const v = cborTagged(1, 1234567890);
    expect(cborDecode(cborEncode(v))).toEqual(v);
  });
});
