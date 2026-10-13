// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * cbor/index.ts
 *
 * Minimal, deterministic CBOR (RFC 8949) encoder/decoder for decision
 * receipts and COSE_Sign1 (Req 15.3). Pure `Uint8Array`/WebCrypto — no Node
 * APIs — so the same code runs in the Runtime, the services, the Control
 * browser bundle, and the compiled `atf-verify` CLI.
 *
 * Supported subset (deliberately small, signatures must not be malleable):
 *   - unsigned / negative integers (incl. bigint beyond 2^53)
 *   - byte strings and UTF-8 text strings (definite length only)
 *   - arrays and string-keyed maps (definite length only)
 *   - booleans, null
 *   - tags (decode preserves them; encode via {@link CborTagged})
 *   - IEEE-754 double for non-integer finite numbers
 *
 * Determinism: map entries are emitted in bytewise-lexicographic order of
 * their encoded keys (RFC 8949 §4.2.1 core deterministic). Shortest-form
 * integer heads are mandatory on encode; the decoder rejects non-shortest
 * forms and duplicate map keys, so `encode(decode(x)) === x` holds for
 * every canonical input and a signature cannot be silently rewritten.
 */

/** A tagged value: `tag(value)` in CBOR notation. */
export interface CborTagged {
  readonly tag: number;
  readonly value: CborValue;
}

/**
 * A map with arbitrary (integer or string) keys, as COSE headers need
 * (RFC 9052 uses integer labels such as 1 = alg, 4 = kid). The encoder
 * sorts entries by encoded-key bytes; the decoder produces a `CborMap`
 * whenever a decoded map has at least one non-string key.
 */
export interface CborMap {
  readonly entries: readonly (readonly [string | number, CborValue])[];
}

/** All values the codec accepts. */
export type CborValue =
  | null
  | boolean
  | number
  | bigint
  | Uint8Array
  | string
  | readonly CborValue[]
  | { readonly [key: string]: CborValue }
  | CborMap
  | CborTagged;

/** Error thrown for values outside the supported subset. */
export class CborEncodeError extends Error {
  constructor(message: string) {
    super(`cbor: ${message}`);
    this.name = "CborEncodeError";
  }
}

/** Error thrown for malformed or non-canonical input. */
export class CborDecodeError extends Error {
  constructor(message: string) {
    super(`cbor: ${message}`);
    this.name = "CborDecodeError";
  }
}

const MAJOR_UINT = 0;
const MAJOR_NINT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;

/** Maximum nesting depth accepted by the decoder (DoS guard). */
const MAX_DEPTH = 64;

/** Wrap a value in a CBOR tag for encoding. */
export function cborTagged(tag: number, value: CborValue): CborTagged {
  if (!Number.isInteger(tag) || tag < 0) {
    throw new CborEncodeError("tag must be a non-negative integer");
  }
  return { tag, value };
}

/** Build a map with integer or string keys (for COSE headers). */
export function cborMap(
  entries: readonly (readonly [string | number, CborValue])[],
): CborMap {
  return { entries };
}

function isCborMap(v: object): v is CborMap {
  return "entries" in v && Array.isArray((v as CborMap).entries);
}

function isCborTagged(v: object): v is CborTagged {
  return "tag" in v && "value" in v;
}

function writeHead(out: number[], major: number, arg: number | bigint): void {
  const m = major << 5;
  if (typeof arg === "bigint") {
    if (arg < 0n || arg > 0xffffffffffffffffn) {
      throw new CborEncodeError("bigint argument out of uint64 range");
    }
    // Use the shortest head form, matching the number path below.
    if (arg <= BigInt(Number.MAX_SAFE_INTEGER)) {
      writeHead(out, major, Number(arg));
      return;
    }
    out.push(m | 27, ...bytesOfBigUint64(arg));
    return;
  }
  if (!Number.isInteger(arg) || arg < 0) {
    throw new CborEncodeError("head argument must be a non-negative integer");
  }
  if (arg < 24) {
    out.push(m | arg);
  } else if (arg < 0x100) {
    out.push(m | 24, arg);
  } else if (arg < 0x10000) {
    out.push(m | 25, (arg >>> 8) & 0xff, arg & 0xff);
  } else if (arg < 0x100000000) {
    out.push(
      m | 26,
      (arg >>> 24) & 0xff,
      (arg >>> 16) & 0xff,
      (arg >>> 8) & 0xff,
      arg & 0xff,
    );
  } else {
    out.push(m | 27, ...bytesOfUint64(arg));
  }
}

function bytesOfUint64(value: number): number[] {
  const hi = Math.floor(value / 0x100000000);
  const lo = value >>> 0;
  return [
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ];
}

function bytesOfBigUint64(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  for (let i = 0; i < 8; i++) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

function encodeInto(value: CborValue, out: number[], depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new CborEncodeError("maximum nesting depth exceeded");
  }
  if (value === null) {
    out.push(0xf6);
    return;
  }
  if (typeof value === "boolean") {
    out.push(value ? 0xf5 : 0xf4);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CborEncodeError("NaN and Infinity are not encodable");
    }
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
      if (value >= 0) writeHead(out, MAJOR_UINT, value);
      else writeHead(out, MAJOR_NINT, -1 - value);
      return;
    }
    // Non-integer (or beyond safe-integer) numbers use a 64-bit double.
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, value);
    out.push(((MAJOR_SIMPLE << 5) | 27), ...new Uint8Array(buf.buffer));
    return;
  }
  if (typeof value === "bigint") {
    if (value >= 0n) {
      writeHead(out, MAJOR_UINT, value);
    } else {
      writeHead(out, MAJOR_NINT, -1n - value);
    }
    return;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    writeHead(out, MAJOR_TEXT, bytes.length);
    pushBytes(out, bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    writeHead(out, MAJOR_BYTES, value.length);
    pushBytes(out, value);
    return;
  }
  if (Array.isArray(value)) {
    writeHead(out, MAJOR_ARRAY, value.length);
    for (const item of value) encodeInto(item, out, depth + 1);
    return;
  }
  if (typeof value === "object" && isCborTagged(value)) {
    writeHead(out, MAJOR_TAG, value.tag);
    encodeInto(value.value, out, depth + 1);
    return;
  }
  if (typeof value === "object" && isCborMap(value)) {
    encodeMapEntries(
      value.entries.map(([k, v]) => [k, v] as const),
      out,
      depth,
    );
    return;
  }
  if (typeof value === "object") {
    // Deterministic map: sort entries by the bytewise-lexicographic order of
    // their *encoded* keys (RFC 8949 §4.2.1 core deterministic).
    encodeMapEntries(
      Object.entries(value).map(([k, v]) => [k, v] as const),
      out,
      depth,
    );
    return;
  }
  throw new CborEncodeError(`unsupported value of type ${typeof value}`);
}

/** Append bytes to a byte accumulator without hitting argument-count limits. */
function pushBytes(out: number[], bytes: Uint8Array): void {
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out.push(...bytes.subarray(i, i + CHUNK));
  }
}

function encodeMapEntries(
  pairs: readonly (readonly [string | number, CborValue])[],
  out: number[],
  depth: number,
): void {
  const entries: { key: Uint8Array; keyId: string; val: CborValue }[] = [];
  for (const [k, v] of pairs) {
    if (typeof k !== "string" && typeof k !== "number") {
      throw new CborEncodeError("map keys must be strings or integers");
    }
    if (typeof k === "number" && !Number.isInteger(k)) {
      throw new CborEncodeError("integer map keys must be whole numbers");
    }
    const keyOut: number[] = [];
    encodeInto(k, keyOut, depth + 1);
    entries.push({
      key: Uint8Array.from(keyOut),
      keyId: `${typeof k}:${k}`,
      val: v,
    });
  }
  entries.sort((a, b) => compareBytes(a.key, b.key));
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.keyId)) {
      throw new CborEncodeError(`duplicate map key "${e.keyId}"`);
    }
    seen.add(e.keyId);
  }
  writeHead(out, MAJOR_MAP, entries.length);
  for (const e of entries) {
    pushBytes(out, e.key);
    encodeInto(e.val, out, depth + 1);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Encode a value to canonical (deterministic) CBOR bytes. */
export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out, 0);
  return Uint8Array.from(out);
}

class Reader {
  private pos = 0;
  // An explicit field instead of a parameter property: Node's type stripping
  // (the `test:node` suite) rejects parameter properties.
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  readByte(): number {
    const b = this.bytes[this.pos];
    if (b === undefined) throw new CborDecodeError("unexpected end of input");
    this.pos++;
    return b;
  }

  readBytes(n: number): Uint8Array {
    if (n > this.bytes.length - this.pos) {
      throw new CborDecodeError("string length exceeds input");
    }
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Read a head; returns the argument as number when safely representable. */
  readHead(): { major: number; additional: number; arg: number | bigint } {
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (additional < 24) return { major, additional, arg: additional };
    if (additional === 31) {
      throw new CborDecodeError(
        "indefinite-length items are not part of the canonical subset",
      );
    }
    if (additional >= 28 && additional <= 30) {
      throw new CborDecodeError("reserved additional information value");
    }
    // Major type 7 encodes simple values and floats: the argument bytes are
    // float payload, not a head argument — the caller handles them.
    if (major === MAJOR_SIMPLE) {
      if (additional === 31) {
        throw new CborDecodeError("break code outside indefinite length");
      }
      return { major, additional, arg: 0 };
    }
    let width: number;
    if (additional === 24) width = 1;
    else if (additional === 25) width = 2;
    else if (additional === 26) width = 4;
    else width = 8;
    const raw = this.readBytes(width);
    let value = 0;
    for (const b of raw) value = value * 256 + b;
    // Canonical form: the head must use the shortest encoding.
    const minWidth =
      value < 24 ? 0 : value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x100000000 ? 4 : 8;
    if (width !== minWidth) {
      throw new CborDecodeError("non-shortest-form head encoding");
    }
    if (width === 8 && value > Number.MAX_SAFE_INTEGER) {
      let big = 0n;
      for (const b of raw) big = (big << 8n) | BigInt(b);
      return { major, additional, arg: big };
    }
    return { major, additional, arg: value };
  }
}

function decodeItem(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) {
    throw new CborDecodeError("maximum nesting depth exceeded");
  }
  const { major, additional, arg } = r.readHead();
  switch (major) {
    case MAJOR_UINT:
      return arg;
    case MAJOR_NINT:
      return typeof arg === "bigint" ? -1n - arg : -1 - arg;
    case MAJOR_BYTES:
      return typeof arg === "number" ? r.readBytes(arg) : failHugeLength();
    case MAJOR_TEXT: {
      if (typeof arg !== "number") return failHugeLength();
      const bytes = r.readBytes(arg);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new CborDecodeError("invalid UTF-8 in text string");
      }
    }
    case MAJOR_ARRAY: {
      if (typeof arg !== "number") return failHugeLength();
      const items: CborValue[] = [];
      for (let i = 0; i < arg; i++) items.push(decodeItem(r, depth + 1));
      return items;
    }
    case MAJOR_MAP: {
      if (typeof arg !== "number") return failHugeLength();
      const pairs: (readonly [string | number, CborValue])[] = [];
      const seen = new Set<string>();
      let allStrings = true;
      for (let i = 0; i < arg; i++) {
        const key = decodeItem(r, depth + 1);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new CborDecodeError("map keys must be text strings or integers");
        }
        const keyId = `${typeof key}:${key}`;
        if (seen.has(keyId)) {
          throw new CborDecodeError(`duplicate map key "${keyId}"`);
        }
        seen.add(keyId);
        if (typeof key !== "string") allStrings = false;
        pairs.push([key, decodeItem(r, depth + 1)]);
      }
      if (allStrings) {
        const obj: Record<string, CborValue> = {};
        for (const [k, v] of pairs) obj[String(k)] = v;
        return obj;
      }
      return { entries: pairs };
    }
    case MAJOR_TAG: {
      const value = decodeItem(r, depth + 1);
      return { tag: typeof arg === "number" ? arg : Number(arg), value };
    }
    default: {
      // Major type 7: simple values and floats.
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      if (additional === 23) {
        throw new CborDecodeError("undefined is not part of the subset");
      }
      if (additional === 25 || additional === 26 || additional === 27) {
        const raw = r.readBytes(additional === 25 ? 2 : additional === 26 ? 4 : 8);
        const view = new DataView(new ArrayBuffer(8));
        if (additional === 25) {
          const half = ((raw[0] ?? 0) << 8) | (raw[1] ?? 0);
          return decodeHalf(half);
        }
        for (let i = 0; i < raw.length; i++) view.setUint8(i + 8 - raw.length, raw[i] ?? 0);
        const num = additional === 26 ? view.getFloat32(4) : view.getFloat64(0);
        if (!Number.isFinite(num)) {
          throw new CborDecodeError("NaN and Infinity are not decodable");
        }
        return num;
      }
      throw new CborDecodeError(`unsupported simple value ${additional}`);
    }
  }
}

function failHugeLength(): never {
  throw new CborDecodeError("length beyond safe integer");
}

function decodeHalf(half: number): number {
  const exp = (half >> 10) & 0x1f;
  const frac = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) {
    throw new CborDecodeError("NaN and Infinity are not decodable");
  }
  return sign * (frac + 1024) * 2 ** (exp - 25);
}

/** Decode canonical CBOR bytes. Throws on trailing or malformed input. */
export function cborDecode(input: Uint8Array): CborValue {
  const r = new Reader(input);
  const value = decodeItem(r, 0);
  if (!r.done) {
    throw new CborDecodeError("trailing bytes after top-level value");
  }
  return value;
}
