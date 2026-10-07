// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * base64url.ts
 *
 * Padding-correct base64url codec without Node or browser APIs, so the same
 * implementation runs in the Runtime, the services, and the Control browser
 * bundle (exported through `@atf/security-kit/browser`).
 *
 * Decoding is strict: invalid characters, wrong length, and incorrect or
 * over-long padding are rejected rather than silently accepted, because a
 * permissive decoder is a signature-malleability vector (two byte strings
 * decoding to the same payload).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reverse lookup: ASCII code → 6-bit value, -1 for invalid. */
const REVERSE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  const code = ALPHABET.charCodeAt(i);
  if (code !== undefined) REVERSE[code] = i;
}

/** Encode bytes as unpadded base64url (JWK/JWS convention). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[(b0 >>> 2) & 0x3f];
    if (b1 === undefined) {
      out += ALPHABET[(b0 << 4) & 0x3f];
    } else {
      out += ALPHABET[((b0 << 4) | (b1 >>> 4)) & 0x3f];
      if (b2 === undefined) {
        out += ALPHABET[(b1 << 2) & 0x3f];
      } else {
        out += ALPHABET[((b1 << 2) | (b2 >>> 6)) & 0x3f];
        out += ALPHABET[b2 & 0x3f];
      }
    }
  }
  return out;
}

/** Encode and include canonical `=` padding (for formats that require it). */
export function base64UrlEncodePadded(bytes: Uint8Array): string {
  const bare = base64UrlEncode(bytes);
  const remainder = bytes.length % 3;
  if (remainder === 0) return bare;
  return bare + "=".repeat(3 - remainder);
}

/**
 * Decode base64url with or without padding. Throws on any invalid character,
 * a length that cannot encode whole bytes (a lone trailing symbol), or padding
 * that is misplaced, over-long, or carries non-zero leftover bits.
 */
export function base64UrlDecode(input: string): Uint8Array {
  // Strip canonical trailing padding, then reject any remaining '=' inside.
  let text = input;
  let padding = 0;
  while (text.endsWith("=") && padding < 2) {
    text = text.slice(0, -1);
    padding++;
  }
  if (text.includes("=")) {
    throw new Error("base64url: invalid padding position");
  }
  if (text.length % 4 === 1) {
    throw new Error("base64url: length cannot encode whole bytes");
  }
  const symbols = text.length % 4; // 0, 2 or 3
  if (symbols === 0 && padding > 0) {
    // Padding on a multiple-of-4 length is only valid when the padded
    // characters were actually needed (leftover bits must be zero).
    throw new Error("base64url: unnecessary padding");
  }
  const byteLength = Math.floor((text.length * 6) / 8);
  const out = new Uint8Array(byteLength);
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (REVERSE[code] ?? -1) : -1;
    if (value === -1) {
      throw new Error(`base64url: invalid character at position ${i}`);
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (acc >>> bits) & 0xff;
      if (index < byteLength) out[index] = byte;
      index++;
    }
  }
  // The final partial group must not carry set leftover bits: 2 symbols leave
  // 4 bits, 3 symbols leave 2 bits. Otherwise two inputs decode identically.
  const leftoverBits = symbols === 2 ? 4 : symbols === 3 ? 2 : 0;
  if (leftoverBits > 0 && (acc & ((1 << leftoverBits) - 1)) !== 0) {
    throw new Error("base64url: non-zero leftover bits");
  }
  return out;
}

/** Decode a UTF-8 string encoded as base64url. */
export function base64UrlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64UrlDecode(input));
}

/** Encode a UTF-8 string as base64url. */
export function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(new TextEncoder().encode(value));
}
