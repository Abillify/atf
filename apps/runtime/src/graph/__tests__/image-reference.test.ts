// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for image references (`src/graph/image-reference.ts`).
 *
 * The contract under test is the one the model depends on: a parked image is
 * reachable again through the same short reference for the whole run, identical
 * bytes never occupy two references, a part is only replaced once its bytes are
 * actually stored, and a remote image (no bytes to park) is left exactly as it
 * was so the vision capability guard still sees it.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import {
  HashedImageRefRegistry,
  IMAGE_INSPECTION_TOOL_NAME,
  decodeImageDataUrl,
  imageReferencePlaceholder,
  inlineImageBytes,
  isImageMediaType,
  offloadInlineImages,
} from "../image-reference.js";
import { InMemoryMediaStore } from "../media-store.js";

/** A tiny deterministic PNG-ish payload — the registry never decodes pixels. */
function pngBytes(seed: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (seed + i) % 251;
  return bytes;
}

function registryWith(options?: {
  maxRefs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxRunBytes?: number;
  maxItemBytes?: number;
  clock?: () => number;
  ttlSeconds?: number;
}): { registry: HashedImageRefRegistry; store: InMemoryMediaStore } {
  const store = new InMemoryMediaStore({
    ...(options?.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    ...(options?.maxTotalBytes !== undefined
      ? { maxTotalBytes: options.maxTotalBytes }
      : {}),
    ...(options?.clock !== undefined ? { clock: options.clock } : {}),
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
  });
  return {
    registry: new HashedImageRefRegistry({
      store,
      ...(options?.maxRefs !== undefined ? { maxRefs: options.maxRefs } : {}),
      ...(options?.maxRunBytes !== undefined
        ? { maxTotalBytes: options.maxRunBytes }
        : {}),
      ...(options?.maxItemBytes !== undefined
        ? { maxItemBytes: options.maxItemBytes }
        : {}),
    }),
    store,
  };
}

describe("HashedImageRefRegistry", () => {
  test("hands out 1-based refs in registration order", () => {
    const { registry } = registryWith();
    expect(registry.register(pngBytes(1), "image/png")).toBe("img-1");
    expect(registry.register(pngBytes(2), "image/png")).toBe("img-2");
    expect(registry.list().map((info) => info.ref)).toEqual(["img-1", "img-2"]);
  });

  test("resolves a ref back to the exact bytes and media type", () => {
    const { registry } = registryWith();
    const bytes = pngBytes(7);
    registry.register(bytes, "image/jpeg");
    const stored = registry.resolve("img-1");
    expect(stored?.mediaType).toBe("image/jpeg");
    expect(Array.from(stored?.data ?? [])).toEqual(Array.from(bytes));
  });

  test("resolves with surrounding whitespace and rejects unknown refs", () => {
    const { registry } = registryWith();
    registry.register(pngBytes(1), "image/png");
    expect(registry.resolve("  img-1  ")).toBeDefined();
    expect(registry.resolve("img-9")).toBeUndefined();
    expect(registry.resolve("   ")).toBeUndefined();
  });

  test("identical bytes reuse one reference (prompt stability across steps)", () => {
    const { registry, store } = registryWith();
    const bytes = pngBytes(3);
    expect(registry.register(bytes, "image/png")).toBe("img-1");
    expect(registry.register(pngBytes(4), "image/png")).toBe("img-2");
    // Same payload again → the ORIGINAL ref, and no second copy in the store.
    expect(registry.register(new Uint8Array(bytes), "image/png")).toBe("img-1");
    // `list()` is insertion-ordered by freshness, so the re-registered image
    // moved to the end (that is what keeps it alive under eviction).
    expect(registry.list().map((info) => info.ref).sort()).toEqual([
      "img-1",
      "img-2",
    ]);
    expect(registry.list().at(-1)?.ref).toBe("img-1");
    expect(store.size()).toBe(2);
  });

  test("rejects an empty payload without consuming a ref", () => {
    const { registry } = registryWith();
    expect(registry.register(new Uint8Array(0), "image/png")).toBeUndefined();
    expect(registry.register(pngBytes(1), "image/png")).toBe("img-1");
  });

  test("evicts the oldest reference past maxRefs", () => {
    const { registry } = registryWith({ maxRefs: 2 });
    registry.register(pngBytes(1), "image/png");
    registry.register(pngBytes(2), "image/png");
    registry.register(pngBytes(3), "image/png");
    expect(registry.list().map((info) => info.ref)).toEqual(["img-2", "img-3"]);
    expect(registry.resolve("img-1")).toBeUndefined();
  });

  test("a re-registered image is not the oldest anymore (LRU touch)", () => {
    const { registry } = registryWith({ maxRefs: 2 });
    registry.register(pngBytes(1), "image/png");
    registry.register(pngBytes(2), "image/png");
    // Refresh img-1, then add a third → img-2 is the oldest and must go.
    expect(registry.register(pngBytes(1), "image/png")).toBe("img-1");
    registry.register(pngBytes(3), "image/png");
    expect(registry.resolve("img-1")).toBeDefined();
    expect(registry.resolve("img-2")).toBeUndefined();
  });

  test("keeps active refs available after the shared store TTL elapses", () => {
    let now = 1_000;
    const { registry } = registryWith({ clock: () => now, ttlSeconds: 5 });
    registry.register(pngBytes(1), "image/png");
    expect(registry.resolve("img-1")).toBeDefined();
    now += 6_000;
    expect(registry.resolve("img-1")).toBeDefined();
    expect(registry.list()).toHaveLength(1);
  });

  test("keeps active refs resolvable when the shared store evicts them", () => {
    const { registry } = registryWith({ maxEntries: 1, maxTotalBytes: 128 });
    const first = pngBytes(1, 64);
    expect(registry.register(first, "image/png")).toBe("img-1");
    expect(registry.register(pngBytes(2, 64), "image/png")).toBe("img-2");
    expect(Array.from(registry.resolve("img-1")?.data ?? [])).toEqual(
      Array.from(first),
    );
    expect(registry.resolve("img-2")).toBeDefined();
  });

  test("rejects an oversized image without consuming a ref", () => {
    const { registry } = registryWith({ maxItemBytes: 63 });
    expect(registry.register(pngBytes(1, 64), "image/png")).toBeUndefined();
    expect(registry.register(pngBytes(2, 63), "image/png")).toBe("img-1");
  });

  test("evicts oldest refs to enforce the per-run byte budget", () => {
    const { registry } = registryWith({ maxRunBytes: 128, maxItemBytes: 128 });
    registry.register(pngBytes(1, 64), "image/png");
    registry.register(pngBytes(2, 64), "image/png");
    registry.register(pngBytes(3, 64), "image/png");
    expect(registry.list().map((info) => info.ref)).toEqual(["img-2", "img-3"]);
    expect(registry.resolve("img-1")).toBeUndefined();
  });

  test("deduplicates only identical bytes with the same canonical MIME type", () => {
    const { registry } = registryWith();
    const bytes = pngBytes(8);
    expect(registry.register(bytes, " IMAGE/PNG ")).toBe("img-1");
    expect(registry.register(bytes, "image/png")).toBe("img-1");
    expect(registry.register(bytes, "image/jpeg")).toBe("img-2");
    expect(registry.resolve("img-1")?.mediaType).toBe("image/png");
    expect(registry.resolve("img-2")?.mediaType).toBe("image/jpeg");
  });

  test("reports decoded bytes, not base64 length", () => {
    const { registry } = registryWith();
    const bytes = pngBytes(9, 90);
    registry.register(bytes, "image/png");
    expect(registry.list()[0]?.bytes).toBe(90);
  });

  test("never reuses a reference number after an eviction", () => {
    const { registry } = registryWith({ maxRefs: 1 });
    expect(registry.register(pngBytes(1), "image/png")).toBe("img-1");
    // img-1 is evicted by the second image; the third must NOT get img-1 back.
    expect(registry.register(pngBytes(2), "image/png")).toBe("img-2");
    expect(registry.resolve("img-1")).toBeUndefined();
    expect(registry.register(pngBytes(3), "image/png")).toBe("img-3");
    expect(registry.list().map((info) => info.ref)).toEqual(["img-3"]);
  });
});

describe("decodeImageDataUrl", () => {
  const base64 = Buffer.from("pixel-data").toString("base64");

  test("splits a base64 image data URL", () => {
    const decoded = decodeImageDataUrl(`data:image/png;base64,${base64}`);
    expect(decoded?.mediaType).toBe("image/png");
    expect(Buffer.from(decoded?.data ?? new Uint8Array()).toString()).toBe(
      "pixel-data",
    );
  });

  test("tolerates parameters and folded whitespace in the payload", () => {
    const decoded = decodeImageDataUrl(
      `data:IMAGE/jpeg;charset=utf-8;base64,${base64.slice(0, 4)}\n${base64.slice(4)}`,
    );
    expect(decoded?.mediaType).toBe("image/jpeg");
    expect(Buffer.from(decoded?.data ?? new Uint8Array()).toString()).toBe(
      "pixel-data",
    );
  });

  test("rejects malformed base64 instead of parking decoder-tolerated garbage", () => {
    for (const payload of ["A", "cGl$ZWw=", "cG=lZWw=", "cGl4ZWw==="]) {
      expect(
        decodeImageDataUrl(`data:image/png;base64,${payload}`),
      ).toBeUndefined();
    }
  });

  test("leaves remote and non-image URLs alone", () => {
    expect(decodeImageDataUrl("https://example.test/a.png")).toBeUndefined();
    expect(
      decodeImageDataUrl(`data:application/pdf;base64,${base64}`),
    ).toBeUndefined();
    expect(decodeImageDataUrl("data:image/png;base64,")).toBeUndefined();
    expect(decodeImageDataUrl("not a url at all")).toBeUndefined();
  });

  test("isImageMediaType accepts the bare and full forms", () => {
    expect(isImageMediaType("image")).toBe(true);
    expect(isImageMediaType("IMAGE/WebP")).toBe(true);
    expect(isImageMediaType("text/plain")).toBe(false);
    expect(isImageMediaType(undefined)).toBe(false);
  });
});

describe("imageReferencePlaceholder", () => {
  test("names the ref and the tool that resolves it", () => {
    const text = imageReferencePlaceholder({
      ref: "img-3",
      mediaType: "image/png",
      bytes: 1_423_000,
    });
    expect(text).toContain("img-3");
    expect(text).toContain("1.4MB");
    expect(text).toContain(`${IMAGE_INSPECTION_TOOL_NAME}(image="img-3"`);
    // The model must be told it cannot see the image, or it will answer anyway.
    expect(text).toContain("not visible to you");
  });
});

/** A user message carrying one inline image part in the given shape. */
function messageWithImage(content: unknown): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "was steht hier?" },
      content as never,
    ],
  } as ModelMessage;
}

/** A base64 data URL for the given deterministic bytes. */
function dataUrl(bytes: Uint8Array, mediaType = "image/png"): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("offloadInlineImages", () => {
  test("replaces a base64 data URL with a reference and removes the bytes", () => {
    const { registry } = registryWith();
    const url = dataUrl(pngBytes(1));
    const messages = [messageWithImage({ type: "image", image: url })];
    const result = offloadInlineImages(messages, registry);

    expect(result.offloaded).toBe(1);
    expect(result.refs).toEqual(["img-1"]);
    expect(result.bytesRemoved).toBe(64);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain(url);
    expect(serialized).toContain("img-1");
    // The parked bytes are still there for the tool to resolve.
    expect(registry.resolve("img-1")).toBeDefined();
  });

  test("handles a WHATWG URL part and raw bytes", () => {
    const { registry } = registryWith();
    const result = offloadInlineImages(
      [
        messageWithImage({
          type: "file",
          data: new URL(dataUrl(pngBytes(2))),
          mediaType: "image/png",
        }),
        messageWithImage({
          type: "image",
          image: pngBytes(3),
          mediaType: "image/png",
        }),
      ],
      registry,
    );
    expect(result.offloaded).toBe(2);
    expect(result.refs).toEqual(["img-1", "img-2"]);
    expect(JSON.stringify(result.messages)).not.toContain("base64");
  });


  test("offloads an image nested inside a tool result", () => {
    const { registry } = registryWith();
    const url = dataUrl(pngBytes(4));
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "screenshot",
            output: {
              type: "json",
              value: [
                { type: "text", text: "captured" },
                { type: "image", image: url },
              ],
            },
          },
        ],
      } as unknown as ModelMessage,
    ];
    const result = offloadInlineImages(messages, registry);
    expect(result.offloaded).toBe(1);
    expect(JSON.stringify(result.messages)).not.toContain(url);
    expect(JSON.stringify(result.messages)).toContain("img-1");
  });

  test("keeps a remote image untouched so the vision guard still applies", () => {
    const { registry } = registryWith();
    const message = messageWithImage({
      type: "image",
      image: "https://example.test/remote.png",
    });
    const result = offloadInlineImages([message], registry);
    expect(result.offloaded).toBe(0);
    expect(result.messages[0]).toBe(message);
    expect(registry.list()).toHaveLength(0);
  });

  test("is identity-stable on a text-only prompt (prompt-cache prefix)", () => {
    const { registry } = registryWith();
    const messages = [
      { role: "system", content: "du bist ein Assistent" },
      { role: "user", content: "hallo" },
      { role: "user", content: [{ type: "text", text: "und nochmal" }] },
    ] as ModelMessage[];
    const result = offloadInlineImages(messages, registry);
    expect(result.offloaded).toBe(0);
    // Identity, not an equal copy: the untouched turn stays byte-identical.
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[2]).toBe(messages[2]);
  });

  test("the same image in two turns keeps one reference", () => {
    const { registry } = registryWith();
    const image = { type: "image", image: dataUrl(pngBytes(5)) };
    const first = offloadInlineImages([messageWithImage(image)], registry);
    const second = offloadInlineImages([messageWithImage(image)], registry);
    expect(first.refs).toEqual(["img-1"]);
    expect(second.refs).toEqual(["img-1"]);
    expect(registry.list()).toHaveLength(1);
  });

  test("does not mutate the caller's messages", () => {
    const { registry } = registryWith();
    const url = dataUrl(pngBytes(6));
    const message = messageWithImage({ type: "image", image: url });
    offloadInlineImages([message], registry);
    const content = (message as { content: unknown[] }).content;
    expect(JSON.stringify(content[1])).toContain(url);
  });
});

describe("inlineImageBytes", () => {
  test("counts decoded bytes and the largest payload", () => {
    const small = dataUrl(pngBytes(1, 100));
    const large = dataUrl(pngBytes(2, 900));
    const totals = inlineImageBytes([
      messageWithImage({ type: "image", image: small }),
      messageWithImage({ type: "image", image: large }),
    ]);
    expect(totals.count).toBe(2);
    expect(totals.totalBytes).toBe(1_000);
    expect(totals.maxBytes).toBe(900);
    // Base64 would have overstated this by a third — that is the point.
    expect(totals.totalBytes).toBeLessThan(small.length + large.length);
  });

  test("counts a remote image but contributes no bytes", () => {
    const totals = inlineImageBytes([
      messageWithImage({ type: "image", image: "https://example.test/a.png" }),
    ]);
    expect(totals.count).toBe(1);
    expect(totals.totalBytes).toBe(0);
  });

  test("is zero for a text-only prompt", () => {
    const totals = inlineImageBytes([
      { role: "user", content: "hallo" },
    ] as ModelMessage[]);
    expect(totals).toEqual({ totalBytes: 0, maxBytes: 0, count: 0 });
  });

  test("sees an image nested in a tool result", () => {
    const url = dataUrl(pngBytes(7, 128));
    const totals = inlineImageBytes([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "screenshot",
            output: { type: "json", value: [{ type: "image", image: url }] },
          },
        ],
      } as unknown as ModelMessage,
    ]);
    expect(totals).toEqual({ totalBytes: 128, maxBytes: 128, count: 1 });
  });
});
