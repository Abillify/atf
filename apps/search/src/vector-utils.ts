// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Binarize a float32 vector: each element ≥ 0 maps to '1', < 0 maps to '0'.
 * Returns a bitstring compatible with PostgreSQL's `bit(n)` type.
 * Uses sign-based thresholding — the standard approach for binary quantization.
 */
export function toBinaryString(v: number[]): string {
  let s = "";
  for (let i = 0; i < v.length; i++) {
    s += (v[i] as number) >= 0 ? "1" : "0";
  }
  return s;
}

/** L2-normalize a vector in place; returns the same array. */
export function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/** Blend two equal-length vectors: alpha*a + (1-alpha)*b, then L2-normalize. */
export function blendVectors(
  a: number[],
  b: number[],
  alpha: number,
): number[] {
  const result = a.map((ai, i) => alpha * ai + (1 - alpha) * (b[i] as number));
  return l2Normalize(result);
}
