// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Image references (`src/graph/image-reference.ts`)
 *
 * A screenshot pasted into the chat arrives as a multimodal part carrying the
 * whole file as a base64 data URL. Two things go wrong with that in a text-only
 * flow: the provider request is rejected because the model has no vision input
 * (see `vision_not_supported` in `handlers/llm.ts`), and the megabytes of
 * base64 are re-sent on every agent-loop step.
 *
 * Instead of dropping the image — which silently loses user input — the bytes
 * are parked in the run-scoped {@link ImageRefRegistry} and the part is replaced
 * by a short, model-readable reference:
 *
 *   [image ref=img-1 type=image/png size=1423KB]
 *
 * The model can quote that reference and hand it to the `inspect_image` tool,
 * which resolves the bytes again and asks a dedicated vision model about them.
 * The image therefore stays reachable for the whole run while the text-only
 * prompt stays small — the reference indirection the media store already applies
 * to *generated* images (`media-store.ts`), turned around for *input* images.
 *
 * Properties guaranteed here:
 *   - Deterministic: the same image keeps the same `img-N` across nodes and
 *     across agent-loop steps, so a quoted reference resolves to what the model
 *     saw rather than to a renumbered one.
 *   - Lossless: a part is replaced only once its bytes are actually stored;
 *     anything that cannot be decoded stays exactly as it was.
 *   - Bounded: the registry evicts the oldest reference past its cap, so a long
 *     paste-heavy session cannot pin memory.
 *
 * No `any` at module boundaries.
 */

import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { MediaStore } from "./media-store.js";
import {
  DEFAULT_MEDIA_MAX_ITEM_BYTES,
  decodeBase64Bytes,
} from "./media-store.js";

const DEFAULT_IMAGE_REF_MAX_TOTAL_BYTES = 134_217_728; // 128 MiB

/** Default tool name models use to look a reference up again. */
export const IMAGE_INSPECTION_TOOL_NAME = "inspect_image";

/** A reference handed to the model, with the metadata it can see. */
export interface ImageRefInfo {
  /** Model-facing handle, e.g. `img-1`. */
  ref: string;
  /** MIME type, e.g. `image/png`. */
  mediaType: string;
  /** Decoded payload size in bytes (never the base64 length). */
  bytes: number;
}

/** Where the model can hand a reference back to get the bytes again. */
export interface ImageRefRegistry {
  /**
   * Stores one image payload and returns its model-facing reference. Registering
   * identical bytes twice returns the same reference. Returns `undefined` when
   * the payload cannot be stored (empty bytes).
   */
  register(data: Uint8Array, mediaType: string): string | undefined;
  /** Resolves a reference (`img-1`) or a raw store id back to its bytes. */
  resolve(ref: string): { data: Uint8Array; mediaType: string } | undefined;
  /** Every live reference in registration order (for prompts and diagnostics). */
  list(): readonly ImageRefInfo[];
}

export interface HashedImageRefRegistryOptions {
  /** Byte store the payloads live in. */
  store: MediaStore;
  /** Maximum live references before the oldest is evicted. Default 32. */
  maxRefs?: number;
  /** Maximum bytes retained by this run. Default 134217728 (128 MiB). */
  maxTotalBytes?: number;
  /** Maximum bytes accepted for one image. Default 26214400 (25 MiB). */
  maxItemBytes?: number;
}

/**
 * Run-scoped image reference registry.
 *
 * Payloads live in the shared {@link MediaStore} (TTL + byte-bounded LRU); this
 * class owns only the `img-N` → store-id mapping and the deterministic
 * content-hash dedupe. It is created once per flow execution so every node and
 * every agent-loop step of a run resolves the same reference to the same image.
 */
export class HashedImageRefRegistry implements ImageRefRegistry {
  private readonly store: MediaStore;
  private readonly maxRefs: number;
  private readonly maxTotalBytes: number;
  private readonly maxItemBytes: number;
  /** storeId → metadata, insertion-ordered so eviction is predictable. */
  private readonly byStoreId = new Map<string, ImageRefInfo>();
  /** SHA-256 of canonical MIME + NUL + bytes → store id. */
  private readonly byHash = new Map<string, string>();
  /**
   * Run-owned copies keep an actively referenced image resolvable even when the
   * shared publication store evicts it for its own TTL/LRU/byte budget. The
   * registry's maxRefs budget remains the explicit lifetime bound for this run.
   */
  private readonly runData = new Map<string, { data: Uint8Array; mediaType: string }>();
  private runBytes = 0;
  /**
   * Monotonic ref counter. Numbering from `byStoreId.size` instead would let a
   * number recycled by eviction be handed to a NEW image while the model still
   * quotes the evicted one for it — the answer would then describe the wrong
   * picture, silently. Refs are cheap; an ambiguity is not.
   */
  private nextRef = 1;

  constructor(options: HashedImageRefRegistryOptions) {
    this.store = options.store;
    this.maxRefs = Math.max(1, options.maxRefs ?? 32);
    this.maxTotalBytes = Math.max(
      1,
      options.maxTotalBytes ?? DEFAULT_IMAGE_REF_MAX_TOTAL_BYTES,
    );
    this.maxItemBytes = Math.min(
      this.maxTotalBytes,
      Math.max(1, options.maxItemBytes ?? DEFAULT_MEDIA_MAX_ITEM_BYTES),
    );
  }

  register(data: Uint8Array, mediaType: string): string | undefined {
    if (data.byteLength === 0 || data.byteLength > this.maxItemBytes) {
      return undefined;
    }
    const canonicalMediaType = mediaType.trim().toLowerCase();
    const hash = createHash("sha256")
      .update(canonicalMediaType)
      .update("\0")
      .update(data)
      .digest("hex");
    const existing = this.byHash.get(hash);
    if (existing !== undefined) {
      const info = this.byStoreId.get(existing);
      if (info !== undefined) {
        // Re-insert so the reused image moves to the fresh end of the LRU.
        this.byStoreId.delete(existing);
        this.byStoreId.set(existing, info);
        return info.ref;
      }
      this.byHash.delete(hash);
    }
    const storeId = this.store.put(data, canonicalMediaType);
    if (storeId === undefined) return undefined;
    const ref = `img-${this.nextRef++}`;
    const copy = new Uint8Array(data);
    this.byStoreId.set(storeId, {
      ref,
      mediaType: canonicalMediaType,
      bytes: copy.byteLength,
    });
    this.runData.set(storeId, { data: copy, mediaType: canonicalMediaType });
    this.runBytes += copy.byteLength;
    this.byHash.set(hash, storeId);
    this.evictIfNeeded();
    return ref;
  }

  resolve(ref: string): { data: Uint8Array; mediaType: string } | undefined {
    const wanted = ref.trim();
    if (wanted === "") return undefined;
    let storeId: string | undefined;
    for (const [id, info] of this.byStoreId) {
      if (id === wanted || info.ref === wanted) {
        storeId = id;
        break;
      }
    }
    if (storeId === undefined) return undefined;
    const resident = this.runData.get(storeId);
    if (resident !== undefined) return resident;
    const stored = this.store.get(storeId);
    if (stored === undefined) {
      // This should only be reachable for registries created before run-owned
      // retention existed; keep the dangling-reference cleanup defensive.
      this.drop(storeId);
      return undefined;
    }
    return stored;
  }

  list(): readonly ImageRefInfo[] {
    return Array.from(this.byStoreId.values());
  }

  private evictIfNeeded(): void {
    while (
      this.byStoreId.size > this.maxRefs ||
      this.runBytes > this.maxTotalBytes
    ) {
      const oldest = this.byStoreId.keys().next();
      if (oldest.done === true) return;
      this.drop(oldest.value);
    }
  }

  private drop(storeId: string): void {
    this.byStoreId.delete(storeId);
    const resident = this.runData.get(storeId);
    if (resident !== undefined) this.runBytes -= resident.data.byteLength;
    this.runData.delete(storeId);
    for (const [hash, mapped] of this.byHash) {
      if (mapped === storeId) this.byHash.delete(hash);
    }
  }
}

/** True for any MIME type the model would perceive as an image. */
export function isImageMediaType(mediaType: unknown): boolean {
  return (
    typeof mediaType === "string" &&
    (mediaType === "image" || mediaType.toLowerCase().startsWith("image/"))
  );
}

/**
 * Splits an inline `data:<mime>;base64,<payload>` URL into its bytes and MIME
 * type. Returns `undefined` for anything that is not a base64 image data URL,
 * so remote (`https://…`) image references are left untouched — there are no
 * bytes here to park, and a text-only model must still fail closed on them.
 */
export function decodeImageDataUrl(
  url: string,
): { data: Uint8Array; mediaType: string } | undefined {
  const match = /^data:([^;,]+)[^,]*;base64,([\s\S]+)$/i.exec(url);
  if (match === null) return undefined;
  const mediaType = (match[1] ?? "application/octet-stream").toLowerCase();
  if (!isImageMediaType(mediaType)) return undefined;
  const payload = match[2] ?? "";
  const data = decodeBase64Bytes(payload);
  return data === undefined ? undefined : { data, mediaType };
}

/** Formats a decoded byte count for the model-facing placeholder line. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** The one line the model sees in place of an offloaded image. */
export function imageReferencePlaceholder(
  info: ImageRefInfo,
  toolName: string = IMAGE_INSPECTION_TOOL_NAME,
): string {
  return (
    `[image ref=${info.ref} type=${info.mediaType} size=${formatBytes(info.bytes)}] ` +
    `The image is not visible to you. Call ${toolName}(image="${info.ref}", ` +
    `question="…") to inspect it, and quote ${info.ref} when you refer to it.`
  );
}

/** True when a content part carries an image the provider would ingest. */
function isImagePart(part: Record<string, unknown>): boolean {
  if (part.type === "image" || part.type === "image_url") return true;
  return part.type === "file" && isImageMediaType(part.mediaType);
}

/**
 * The bytes behind an image part, in whichever shape it arrives: a `data:` URL
 * string, a WHATWG `URL` (what `coreContentToModelMessages` builds), or raw
 * bytes. `bytes` is absent when the part points somewhere remote — there is
 * nothing to park, so callers must leave the part alone.
 */
function imagePayloadOf(
  part: Record<string, unknown>,
): { bytes: Uint8Array; mediaType: string } | undefined {
  const mediaType =
    typeof part.mediaType === "string" ? part.mediaType : "image";
  const raw = part.data ?? part.image ?? part.url;
  let encoded: string | undefined;
  if (typeof raw === "string") encoded = raw;
  else if (raw instanceof URL) encoded = raw.toString();
  else if (raw instanceof Uint8Array) {
    return { bytes: raw, mediaType: mediaType || "image" };
  }
  if (encoded === undefined || !encoded.startsWith("data:")) return undefined;
  const decoded = decodeImageDataUrl(encoded);
  if (decoded === undefined) return undefined;
  return { bytes: decoded.data, mediaType: decoded.mediaType };
}

/** What {@link offloadInlineImages} changed about a message list. */
export interface OffloadInlineImagesResult {
  /** Messages with every inline image replaced by its reference. */
  messages: ModelMessage[];
  /** Number of image parts that were replaced. */
  offloaded: number;
  /** Decoded bytes removed from the prompt across all replaced parts. */
  bytesRemoved: number;
  /** Number of image parts that could not be offloaded (for example remote URLs). */
  unresolved: number;
  /** References created or reused, in the order the images appeared. */
  refs: string[];
}

/**
 * Replaces every inline (base64) image in a provider-bound message list with a
 * short reference to the bytes parked in `registry`, including images nested in
 * tool results (which is how MCP image content reaches the model).
 *
 * Messages without images are returned by reference — the function is a no-op on
 * ordinary text, which keeps the prompt-cache prefix byte-stable for the
 * overwhelmingly common text-only turn.
 */
export function offloadInlineImages(
  messages: readonly ModelMessage[],
  registry: ImageRefRegistry,
  toolName: string = IMAGE_INSPECTION_TOOL_NAME,
): OffloadInlineImagesResult {
  const result: OffloadInlineImagesResult = {
    messages: [],
    offloaded: 0,
    bytesRemoved: 0,
    unresolved: 0,
    refs: [],
  };

  const offloadParts = (parts: unknown[]): unknown[] => {
    let changed = false;
    const next: unknown[] = [];
    for (const raw of parts) {
      if (raw === null || typeof raw !== "object") {
        next.push(raw);
        continue;
      }
      const part = raw as Record<string, unknown>;
      // Tool results carry their payload one level down; recurse so a tool that
      // returned a screenshot is offloaded the same way as a pasted one.
      if (part.type === "tool-result" && part.output !== null) {
        const output = part.output as Record<string, unknown>;
        if (Array.isArray(output.value)) {
          const nested = offloadParts(output.value);
          if (nested !== output.value) {
            changed = true;
            next.push({ ...part, output: { ...output, value: nested } });
            continue;
          }
        }
        next.push(raw);
        continue;
      }
      if (!isImagePart(part)) {
        next.push(raw);
        continue;
      }
      const payload = imagePayloadOf(part);
      // No decodable bytes (a remote URL, or a provider-resolved reference):
      // leave the part exactly as it is so the vision guard still sees it.
      if (payload === undefined) {
        result.unresolved += 1;
        next.push(raw);
        continue;
      }
      const ref = registry.register(payload.bytes, payload.mediaType);
      if (ref === undefined) {
        result.unresolved += 1;
        next.push(raw);
        continue;
      }
      changed = true;
      result.offloaded += 1;
      result.bytesRemoved += payload.bytes.byteLength;
      if (!result.refs.includes(ref)) result.refs.push(ref);
      next.push({
        type: "text",
        text: imageReferencePlaceholder(
          {
            ref,
            mediaType: payload.mediaType,
            bytes: payload.bytes.byteLength,
          },
          toolName,
        ),
      });
    }
    return changed ? next : parts;
  };

  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      result.messages.push(message);
      continue;
    }
    const nextContent = offloadParts(content);
    result.messages.push(
      nextContent === content
        ? message
        : ({ ...(message as object), content: nextContent } as ModelMessage),
    );
  }
  return result;
}

/**
 * Total decoded size of the inline image payloads a provider request would
 * carry. Base64 is what makes an image prompt expensive, and the encoded string
 * overstates it by a third, so this reports decoded bytes.
 */
export function inlineImageBytes(messages: readonly ModelMessage[]): {
  totalBytes: number;
  maxBytes: number;
  count: number;
} {
  let totalBytes = 0;
  let maxBytes = 0;
  let count = 0;
  const scan = (parts: readonly unknown[]): void => {
    for (const raw of parts) {
      if (raw === null || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      if (
        part.type === "tool-result" &&
        Array.isArray(
          (part.output as Record<string, unknown> | undefined)?.value,
        )
      ) {
        scan((part.output as { value: unknown[] }).value);
        continue;
      }
      if (!isImagePart(part)) continue;
      const payload = imagePayloadOf(part);
      if (payload === undefined) {
        count += 1;
        continue;
      }
      count += 1;
      totalBytes += payload.bytes.byteLength;
      if (payload.bytes.byteLength > maxBytes) {
        maxBytes = payload.bytes.byteLength;
      }
    }
  };
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) scan(content);
  }
  return { totalBytes, maxBytes, count };
}
