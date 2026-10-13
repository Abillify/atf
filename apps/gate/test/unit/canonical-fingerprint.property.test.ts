// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { stable } from "../../src/crypto/canonical.ts";
import { approvalArgsFingerprint } from "../../src/mcp/governance.ts";
import { argsFingerprint } from "../../src/tools/pagination-cursor.ts";

/**
 * Property 13 (Req 6.4): Gate fingerprints are computed over a canonical form
 * ordered by UTF-16 code unit, never by `localeCompare`. The digest therefore
 * depends only on the value — not on key insertion order, and not on the ICU
 * collation of the host running the Gate.
 */

// Keys chosen so that code-unit order and ICU `localeCompare` order disagree:
// code units give "B" < "b" and "-" < "a", while `localeCompare` (root locale,
// case-ignored primary level) gives "b" < "B" and "a" < "-".
const ARB_KEYS = ["b", "B", "a", "-", "z", "0", "aa", "Aa"] as const;

const arbLeaf = fc.oneof(
  fc.integer(),
  // JSON has no negative zero (`JSON.stringify(-0) === "0"`), so -0 cannot
  // round-trip and is excluded from the JSON value domain.
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((d) => !Object.is(d, -0)),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
);

/** Recursive JSON object/array value over the safe key alphabet above. */
const arbValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    arbLeaf,
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom(...ARB_KEYS), tie("node"), {
      maxKeys: 5,
    }),
  ),
})).node;

/** Insert the entries of `value` in a shuffled order (same content). */
function withKeyOrder(value: unknown, order: number[]): unknown {
  if (Array.isArray(value)) return value.map((v) => withKeyOrder(v, order));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const shuffled = entries
      .map((entry, i) => ({ entry, sort: order[i % order.length] ?? 0, i }))
      .sort((a, b) => a.sort - b.sort || a.i - b.i)
      .map(({ entry }) => entry);
    return Object.fromEntries(shuffled.map(([k, v]) => [k, withKeyOrder(v, order)]));
  }
  return value;
}

describe("canonical stable() — Property 13: code-unit fingerprints (Req 6.4)", () => {
  it("is deterministic and round-trips through JSON", () => {
    fc.assert(
      fc.property(arbValue, (value) => {
        const first = stable(value);
        expect(stable(value)).toBe(first);
        expect(JSON.parse(first)).toEqual(value);
      }),
      { numRuns: 200 },
    );
  });

  it("ignores key insertion order at every nesting level", () => {
    fc.assert(
      fc.property(arbValue, fc.array(fc.nat({ max: 1000 }), { minLength: 8, maxLength: 8 }), (value, order) => {
        const canonical = stable(value);
        // Repeated reshuffling keeps the canonical form, so the digest is a
        // function of the value alone.
        let permuted = value;
        for (let round = 0; round < 3; round++)
          permuted = withKeyOrder(permuted, order.map((n) => (n + round * 37) % 101));
        expect(stable(permuted)).toBe(canonical);
        expect(argsFingerprint(permuted as Record<string, unknown>)).toBe(
          argsFingerprint(value as Record<string, unknown>),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("orders object keys by UTF-16 code unit, not by localeCompare", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ARB_KEYS), { minLength: 2, maxLength: ARB_KEYS.length }),
        (keys) => {
          const value: Record<string, unknown> = {};
          for (const key of keys) value[key] = 1;
          const byCodeUnit = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const byLocale = [...keys].sort((a, b) => a.localeCompare(b));
          const canonical = stable(value);
          const expected = `{${byCodeUnit.map((k) => `${JSON.stringify(k)}:1`).join(",")}}`;
          expect(canonical).toBe(expected);
          // Whenever the two orders differ, the canonical form must follow the
          // code-unit order — i.e. it must NOT be the locale-sorted form.
          if (byCodeUnit.join() !== byLocale.join())
            expect(canonical).not.toBe(
              `{${byLocale.map((k) => `${JSON.stringify(k)}:1`).join(",")}}`,
            );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("approval and pagination arg fingerprints agree on the canonical form", () => {
    fc.assert(
      fc.property(arbValue, (value) => {
        const args = (
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? value
            : { v: value }
        ) as Record<string, unknown>;
        expect(approvalArgsFingerprint(args)).toBe(argsFingerprint(args));
      }),
      { numRuns: 200 },
    );
  });
});
