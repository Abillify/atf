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

describe("cborDecode — prototype-sensitive map keys", () => {
  // Built with JSON.parse so `__proto__` is a real own property; an object
  // literal `{ __proto__: … }` would set the prototype instead.
  const own = (json: string): CborValue => JSON.parse(json) as CborValue;
  const asRecord = (v: CborValue): Record<string, unknown> =>
    v as unknown as Record<string, unknown>;

  test("an own __proto__ key round-trips as an own property", () => {
    const enc = cborEncode(own('{"__proto__":{}}'));
    expect(hex(enc)).toBe("a1695f5f70726f746f5f5fa0");
    const d = cborDecode(enc);
    expect(Object.hasOwn(d as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(d instanceof Object).toBe(true);
    expect(Object.keys(d as object)).toEqual(["__proto__"]);
    expect(cborEncode(d)).toEqual(enc);
  });

  test("a primitive __proto__ value is kept", () => {
    const enc = cborEncode(own('{"__proto__":1,"a":2}'));
    const d = cborDecode(enc);
    expect(Object.getOwnPropertyDescriptor(d, "__proto__")?.value).toBe(1);
    expect(cborEncode(d)).toEqual(enc);
  });

  test("a decoded payload cannot choose the prototype or pollute Object.prototype", () => {
    const enc = cborEncode(own('{"__proto__":{"polluted":1}}'));
    const d = cborDecode(enc);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect("polluted" in (d as object)).toBe(false);
    expect(asRecord(d)["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(cborEncode(d)).toEqual(enc);
  });

  test("a payload-chosen prototype cannot fake tag/entries shape checks", () => {
    const d = cborDecode(
      cborEncode(cborMap([["__proto__", cborMap([["tag", 1], ["value", 2]])]])),
    );
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect("tag" in (d as object)).toBe(false);
    expect("value" in (d as object)).toBe(false);
    expect("entries" in (d as object)).toBe(false);
    expect(({} as Record<string, unknown>)["tag"]).toBeUndefined();
  });

  test("nested __proto__ / constructor / prototype keys round-trip", () => {
    const value = own(
      '{"constructor":{"prototype":{"polluted":1}},"x":{"__proto__":{"constructor":{"__proto__":{}}}},"prototype":[{"__proto__":null}]}',
    );
    const enc = cborEncode(value);
    const d = cborDecode(enc);
    const r = asRecord(d);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(Object.keys(r).sort()).toEqual(["constructor", "prototype", "x"]);
    const ctor = r["constructor"] as Record<string, unknown>;
    expect(Object.hasOwn(ctor, "prototype")).toBe(true);
    const x = r["x"] as Record<string, unknown>;
    expect(Object.hasOwn(x, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
    const inner = Object.getOwnPropertyDescriptor(x, "__proto__")?.value as Record<string, unknown>;
    expect(Object.hasOwn(inner, "constructor")).toBe(true);
    const arr = r["prototype"] as Record<string, unknown>[];
    expect(Object.hasOwn(arr[0] ?? {}, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(cborEncode(d)).toEqual(enc);
  });

  test("keys shadowing other Object.prototype members round-trip", () => {
    const enc = cborEncode({ constructor: 1, toString: 2, hasOwnProperty: 3 });
    const d = cborDecode(enc);
    for (const k of ["constructor", "toString", "hasOwnProperty"]) {
      expect(Object.hasOwn(d as object, k)).toBe(true);
    }
    expect(cborEncode(d)).toEqual(enc);
  });
});

describe("Property 14: CBOR round-trip (Req 15.3)", () => {
  // Arbitrary for the supported value subset.
  const makeCborArb = (key: fc.Arbitrary<string>): fc.Arbitrary<CborValue> =>
    fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.integer({ min: -1000000000, max: 1000000000 }),
        fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n - 1n }),
        fc.boolean(),
        fc.constant(null),
        fc.string({ maxLength: 40 }),
        fc.uint8Array({ maxLength: 40 }),
        fc.array(tie("value"), { maxLength: 5 }),
        // fc.dictionary creates `__proto__` as an own property.
        fc.dictionary(key, tie("value"), { maxKeys: 5 }),
      ),
    })).value as fc.Arbitrary<CborValue>;
  const cborArb = makeCborArb(fc.string({ minLength: 1, maxLength: 10 }));
  // Same subset, but prototype-sensitive keys are generated deterministically.
  const cborArbProtoKeys = makeCborArb(
    fc.oneof(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.constantFrom("__proto__", "constructor", "prototype", "toString", "hasOwnProperty"),
    ),
  );

  const roundTrips = (value: CborValue): void => {
    const encoded = cborEncode(value);
    const decoded = cborDecode(encoded);
    expect(cborEncode(decoded)).toEqual(encoded);
  };

  test("replays recorded counterexample (seed -1886272370, path 357:2:81:81:81)", () => {
    // Originally found by the round-trip property: [{["__proto__"]:{}}].
    // Best-effort: seed/path replay depends on fast-check's generation order
    // and may stop hitting `__proto__` after an upgrade. The explicit tests in
    // "prototype-sensitive map keys" are the authoritative regression.
    fc.assert(fc.property(cborArb, roundTrips), {
      seed: -1886272370,
      path: "357:2:81:81:81",
      endOnFailure: true,
    });
  });

  test("decode(encode(x)) re-encodes to identical bytes", () => {
    fc.assert(fc.property(cborArbProtoKeys, roundTrips), { numRuns: 500 });
  });

  test("decode(encode(x)) re-encodes to identical bytes (plain string keys)", () => {
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
