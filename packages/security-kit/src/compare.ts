// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * compare.ts
 *
 * Constant-time secret comparison without leaking the input length.
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, which
 * turns the comparison into a length oracle (early return on mismatched
 * lengths). Hashing both operands to a fixed-size digest first removes the
 * length signal entirely: the comparison always runs over exactly 32 bytes and
 * the only observable is "equal" vs. "not equal".
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare two strings in constant time with respect to their content AND
 * length (both are digested first). Returns `false` for unequal inputs,
 * including the empty-vs-empty case only when they truly differ.
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/** Byte-oriented variant of {@link safeEqual}. */
export function safeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
