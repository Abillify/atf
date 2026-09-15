// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Media store (`src/graph/media-store.ts`)
 *
 * Generated images (and other media) produced by the `generate_image` media
 * tool or by native image-generation models arrive as base64 payloads that can
 * be 1 MB+. Inlining them into the chat stream as a markdown data-URI does not
 * render in Open WebUI — its markdown renderer rejects over-long data-URIs
 * ("Chunk too big") and, when streamed, aiohttp aborts the SSE line at the
 * 131072-byte limit. See open-webui/open-webui#16976.
 *
 * Instead, the produced bytes are kept here under an unguessable id and served
 * over a short HTTP URL (`/media/<id>.<ext>`) that the client embeds as a
 * normal markdown image. The store is in-memory, bounded (LRU) and TTL'd with
 * an injectable clock for deterministic tests.
 *
 * SECURITY: the `/media/:id` endpoint is unauthenticated (the browser loads the
 * image without the API bearer token), so the id IS the capability — it must be
 * unguessable (a v4 UUID) and entries are short-lived. Only bytes the backend
 * itself generated are ever stored, and there is no enumeration/listing.
 *
 * DURABILITY: entries live in process memory and expire after the TTL. Re-opening
 * an old conversation after expiry shows a broken image; persist to disk/object
 * storage if long-term media retention is required.
 */

export const DEFAULT_MEDIA_MAX_ITEM_BYTES = 26_214_400; // 25 MiB

/**
 * Strictly decodes standard base64, accepting folded whitespace and omitted
 * terminal padding but rejecting malformed alphabets, padding and lengths.
 */
export function decodeBase64Bytes(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s+/gu, "");
  if (compact === "" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    return undefined;
  }
  const unpadded = compact.replace(/=+$/u, "");
  if (unpadded.length % 4 === 1) return undefined;
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const decoded = new Uint8Array(Buffer.from(padded, "base64"));
  if (decoded.byteLength === 0) return undefined;
  return Buffer.from(decoded).toString("base64").replace(/=+$/u, "") === unpadded
    ? decoded
    : undefined;
}

/** A stored media payload. */
export interface StoredMedia {
  /** Raw media bytes. */
  data: Uint8Array;
  /** MIME type, e.g. "image/jpeg". */
  mediaType: string;
}

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

export interface MediaStore {
  /** Stores media bytes, or rejects an empty/oversized payload. */
  put(data: Uint8Array, mediaType: string): string | undefined;
  /** Retrieves stored media by id, or undefined when missing/expired. */
  get(id: string): StoredMedia | undefined;
}

interface Entry {
  data: Uint8Array;
  mediaType: string;
  expiresAt: number;
  touched: number;
}

export interface InMemoryMediaStoreOptions {
  /** Entry TTL in seconds. Default 86400 (24h). */
  ttlSeconds?: number;
  /** Max entries before LRU eviction. Default 100. */
  maxEntries?: number;
  /** Max total bytes retained before LRU eviction. Default 134217728 (128 MiB). */
  maxTotalBytes?: number;
  /** Max bytes accepted for one item. Default 26214400 (25 MiB). */
  maxItemBytes?: number;
  clock?: Clock;
}

/**
 * In-memory media store with TTL + LRU eviction bounded by both entry count and
 * total bytes, so a burst of large images cannot grow memory without limit.
 */
export class InMemoryMediaStore implements MediaStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxItemBytes: number;
  private readonly clock: Clock;
  private totalBytes = 0;
  private seq = 0;

  constructor(options: InMemoryMediaStoreOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlSeconds ?? 86_400) * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.maxTotalBytes = Math.max(1, options.maxTotalBytes ?? 134_217_728);
    this.maxItemBytes = Math.min(
      this.maxTotalBytes,
      Math.max(1, options.maxItemBytes ?? DEFAULT_MEDIA_MAX_ITEM_BYTES),
    );
    this.clock = options.clock ?? Date.now;
  }

  put(data: Uint8Array, mediaType: string): string | undefined {
    if (data.byteLength === 0 || data.byteLength > this.maxItemBytes) {
      return undefined;
    }
    const id = crypto.randomUUID();
    this.entries.set(id, {
      data,
      mediaType,
      expiresAt: this.clock() + this.ttlMs,
      touched: ++this.seq,
    });
    this.totalBytes += data.byteLength;
    this.evictIfNeeded();
    return id;
  }

  get(id: string): StoredMedia | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (this.clock() > entry.expiresAt) {
      this.delete(id);
      return undefined;
    }
    entry.touched = ++this.seq;
    return { data: entry.data, mediaType: entry.mediaType };
  }

  /** Current entry count (diagnostics/tests). */
  size(): number {
    return this.entries.size;
  }

  private delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.totalBytes -= entry.data.byteLength;
    this.entries.delete(id);
  }

  private evictIfNeeded(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxTotalBytes
    ) {
      let lruId: string | undefined;
      let lruTouched = Infinity;
      for (const [k, e] of this.entries) {
        if (e.touched < lruTouched) {
          lruTouched = e.touched;
          lruId = k;
        }
      }
      if (lruId === undefined) break;
      this.delete(lruId);
    }
  }
}

/**
 * Maps a MIME type to a sensible file extension for the public media URL. The
 * extension is cosmetic (the route ignores it) but helps clients/CDNs infer the
 * type. Falls back to the subtype after `/`, stripped of any `+suffix`.
 */
export function mediaExtension(mediaType: string): string {
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  const lower = mediaType.toLowerCase();
  if (known[lower] !== undefined) return known[lower];
  const subtype = lower.split("/")[1] ?? "bin";
  return subtype.split("+")[0]?.replace(/[^a-z0-9]/g, "") || "bin";
}
