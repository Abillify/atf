// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/fingerprint.ts
 *
 * The text fingerprint Search compares to recognise a duplicate that arrives
 * as a different file: the same document exported as PDF and as DOCX, printed
 * to PDF twice, or saved with different fonts. Two signals:
 *
 *   textHash  sha256 of the normalised text. Normalisation folds away exactly
 *             what differs between two renderings of the same words:
 *             whitespace and line breaks, hyphenation at line ends, soft
 *             hyphens, Unicode compatibility forms (ligatures, full-width
 *             digits), case, punctuation, and the running page numbers a
 *             format adds or drops ("Seite 3 von 12", a bare "3").
 *   minhash   a 64-slot MinHash over 4-word shingles of the same token stream.
 *             The share of equal slots estimates the Jaccard similarity of two
 *             texts, which survives a changed header, a moved footnote or a
 *             table flattened differently — where textHash differs.
 *
 * Pure and deterministic: the same text always yields the same fingerprint, on
 * every worker, so it can be compared across ingests.
 */

import { createHash } from "node:crypto";

/** MinHash slots. 64 gives a similarity estimate within ~±0.06 at 0.9. */
export const MINHASH_SLOTS = 64;
/** Words per shingle. */
const SHINGLE_WORDS = 4;
/** Below this many tokens a text is too short to fingerprint meaningfully. */
export const MIN_FINGERPRINT_TOKENS = 12;

export interface TextFingerprint {
  textHash: string;
  minhash: number[];
  tokenCount: number;
}

/**
 * Lines that are only page furniture: a bare page number, "Seite 3", "Seite 3
 * von 12", "Page 3 of 12", "- 3 -", "3/12". A converter adds or drops these
 * independently of the content.
 */
const PAGE_NUMBER_LINE =
  /^\s*(?:(?:seite|page|s\.|p\.)\s*)?[-–—]?\s*\d{1,5}\s*[-–—]?\s*(?:(?:von|of|\/)\s*\d{1,5})?\s*$/i;

/** Normalise page texts into the token stream both fingerprints are built from. */
export function fingerprintTokens(pages: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const page of pages) {
    const text = page
      .normalize("NFKC")
      .replace(/­/g, "") // soft hyphen
      .split(/\r?\n/)
      .filter((line) => !PAGE_NUMBER_LINE.test(line))
      .join("\n")
      // A word hyphenated across a line break: "Doku-\nment" → "Dokument".
      .replace(/([\p{L}])-\s*\n\s*([\p{Ll}])/gu, "$1$2")
      .toLowerCase();
    for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) tokens.push(match[0]);
  }
  return tokens;
}

/** FNV-1a 32-bit hash of a string (its UTF-16 code units). */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** MurmurHash3's 32-bit finaliser: a cheap, well-mixed permutation of a hash. */
function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Fixed per-slot seeds, so every worker computes the same signature. */
const SEEDS: readonly number[] = Array.from({ length: MINHASH_SLOTS }, (_, i) =>
  fmix32(Math.imul(i + 1, 0x9e3779b1)),
);

/** MinHash signature over the tokens' shingles, as signed 32-bit integers. */
export function minhashOf(tokens: readonly string[]): number[] {
  const shingles = new Set<number>();
  if (tokens.length < SHINGLE_WORDS) {
    shingles.add(fnv1a(tokens.join(" ")));
  } else {
    for (let i = 0; i + SHINGLE_WORDS <= tokens.length; i++) {
      shingles.add(fnv1a(tokens.slice(i, i + SHINGLE_WORDS).join(" ")));
    }
  }
  const signature = new Array<number>(MINHASH_SLOTS).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let slot = 0; slot < MINHASH_SLOTS; slot++) {
      const h = fmix32(shingle ^ (SEEDS[slot] ?? 0));
      if (h < (signature[slot] ?? 0xffffffff)) signature[slot] = h;
    }
  }
  // Postgres INTEGER is signed: store the same 32 bits as a signed value.
  return signature.map((h) => h | 0);
}

/**
 * The fingerprint of a document's text, or null when it has too little text to
 * compare (a scan without a text layer, a drawing, an empty page).
 */
export function textFingerprint(pages: readonly string[]): TextFingerprint | null {
  const tokens = fingerprintTokens(pages);
  if (tokens.length < MIN_FINGERPRINT_TOKENS) return null;
  return {
    textHash: createHash("sha256").update(tokens.join(" "), "utf8").digest("hex"),
    minhash: minhashOf(tokens),
    tokenCount: tokens.length,
  };
}
