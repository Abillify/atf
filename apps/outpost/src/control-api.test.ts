// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { hostAllowed, tokenMatches } from "./control-api.js";

describe("Control-API authentication", () => {
  test("accepts only the exact bearer token", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (expected, other) => {
          expect(tokenMatches(expected, expected)).toBe(true);
          fc.pre(other !== expected);
          expect(tokenMatches(other, expected)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("requires the exact loopback host and bound port", () => {
    expect(hostAllowed("127.0.0.1:43123", 43123)).toBe(true);
    expect(hostAllowed("localhost:43123", 43123)).toBe(false);
    expect(hostAllowed("127.0.0.1:43124", 43123)).toBe(false);
    expect(hostAllowed(undefined, 43123)).toBe(false);
  });
});
