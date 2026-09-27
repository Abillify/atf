// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * render-cache.test.ts
 *
 * The Search-side zoom / full-resolution render-and-cache capability (task 3.8,
 * requirements 6.8, 14.4, 14.5). Proven here with a stubbed Extract client and
 * an in-memory AssetStore, so the HTTP round-trip and the cache semantics are
 * exercised without a live Extract or a database:
 *
 *   (f) a cache MISS calls Extract's `POST /v2/render` and stores the result via
 *       `AssetStore.put`; a second request for the same zoom is served from the
 *       cache with no second render;
 *   (g) the asset's revision row ACL is enforced — the store's ACL result is
 *       propagated, so a caller who cannot see the document never triggers a
 *       render and gets the store's denial.
 */

import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import type {
  AssetScope,
  AssetStore,
  AssetStoreResult,
  GetAssetResult,
  HeadAssetResult,
  PutAssetInput,
  PutAssetResult,
} from "../src/asset-store.js";
import type { AssetVariant } from "../src/asset-variants.js";
import { cacheAssetIdFor, createRenderCache } from "../src/render-cache.js";
import type { ConverterConfig } from "../src/config.js";

const logger = pino({ level: "silent" });

const converter: ConverterConfig = {
  url: "http://extract.test",
  token: "svc-token",
  timeoutMs: 5_000,
  uploadLimit: "50mb",
};

const scope: AccessScope = {
  principal: { source: "service" },
  userId: undefined,
  userGroups: [],
  tenantId: "t1",
  scopes: [],
  service: true,
};

const binding = {
  assetScope: { tenantId: "t1", collection: "documents" } satisfies AssetScope,
  baseAssetId: "page:p37",
  documentReference: "docs/manual.pdf",
  revisionId: "rev-1",
};

/** A PNG-ish body; the store stub does not decode it, so any bytes suffice. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * An in-memory AssetStore keyed by (assetId, variant). `put` stores the `full`
 * variant; `get` enforces an injected ACL decision so the row-ACL path (14.5)
 * is testable without Postgres.
 */
function fakeAssetStore(options: { denied?: boolean } = {}): AssetStore & {
  puts: PutAssetInput[];
} {
  const rows = new Map<string, { mimeType: string; data: Buffer; width: number | null; height: number | null; checksum: string }>();
  const puts: PutAssetInput[] = [];
  const denied = options.denied === true;

  return {
    puts,
    async ensureSchema() {},
    async put(input: PutAssetInput): Promise<AssetStoreResult<PutAssetResult>> {
      puts.push(input);
      rows.set(`${input.assetId}::full`, {
        mimeType: input.mimeType,
        data: input.data,
        width: null,
        height: null,
        checksum: "cksum",
      });
      return { ok: true, result: { assetId: input.assetId, checksum: "cksum", created: true, variants: ["thumb", "preview"] } };
    },
    async get(
      _assetScope: AssetScope,
      assetId: string,
      variant: AssetVariant,
    ): Promise<AssetStoreResult<GetAssetResult | null>> {
      if (denied) {
        // Same shape the real store returns for a failed ACL/tenant check.
        return { ok: false, error: { status: 403, code: "TENANT_REQUIRED", message: "tenant context is required" } };
      }
      const row = rows.get(`${assetId}::${variant}`);
      if (!row) return { ok: true, result: null };
      return {
        ok: true,
        result: { assetId, variant, mimeType: row.mimeType, data: row.data, checksum: row.checksum, width: row.width, height: row.height },
      };
    },
    async head(): Promise<AssetStoreResult<HeadAssetResult>> {
      return { ok: true, result: { exists: false } };
    },
  };
}

describe("render-cache · cacheAssetIdFor", () => {
  const src = "0123456789abcdef".repeat(4);
  it("keys a full render and a region crop distinctly, with the target pixels and source", () => {
    expect(cacheAssetIdFor("page:p37", { sourceSha256: src, page: 37 })).toBe(
      "page:p37@s0123456789abcdef:full",
    );
    expect(
      cacheAssetIdFor("page:p37", { sourceSha256: src, page: 37, targetPixels: 2048 }),
    ).toBe("page:p37@s0123456789abcdef:full.p2048");
    expect(
      cacheAssetIdFor("page:p37", { sourceSha256: src, page: 37, bbox: [0.1, 0.2, 0.5, 0.6] }),
    ).toBe("page:p37@s0123456789abcdef:region:0.1000,0.2000,0.5000,0.6000");
  });

  it("never collides across regions, target pixels or sources of the same base asset", () => {
    const ids = new Set([
      cacheAssetIdFor("page:p1", { sourceSha256: src, page: 1, bbox: [0.1, 0.1, 0.5, 0.5] }),
      cacheAssetIdFor("page:p1", { sourceSha256: src, page: 1, bbox: [0.1, 0.1, 0.5, 0.6] }),
      cacheAssetIdFor("page:p1", { sourceSha256: src, page: 1, bbox: [0.1, 0.1, 0.5, 0.5], targetPixels: 1024 }),
      cacheAssetIdFor("page:p1", { sourceSha256: src, page: 1, bbox: [0.1, 0.1, 0.5, 0.5], targetPixels: 2048 }),
      cacheAssetIdFor("page:p1", { sourceSha256: "f".repeat(64), page: 1, bbox: [0.1, 0.1, 0.5, 0.5] }),
      cacheAssetIdFor("page:p1", { sourceSha256: src, page: 1 }),
    ]);
    expect(ids.size).toBe(6);
  });
});
describe("render-cache · getOrRender (task 3.8, Req 6.8/14.4/14.5)", () => {
  it("(f) renders on a cache miss, caches it, and serves from cache on the second call", async () => {
    const store = fakeAssetStore();
    const fetchImpl = vi.fn(async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/png", "x-render-width": "512", "x-render-height": "384" },
      }),
    ) as unknown as typeof fetch;
    const cache = createRenderCache({ converter, assetStore: store, logger, fetchImpl });

    const target = { sourceSha256: "a".repeat(64), page: 37, bbox: [0.1, 0.1, 0.6, 0.7] as const, targetPixels: 1024 };

    // First call: miss → render → cache.
    const first = await cache.getOrRender(binding, target, scope);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.rendered).toBe(true);
    expect(first.result.data.equals(PNG)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The render request carried the source, page and bbox.
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://extract.test/v2/render");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ source: "a".repeat(64), page: 37, bbox: [0.1, 0.1, 0.6, 0.7], targetPixels: 1024 });
    // It was cached as a `tile` (region) asset variant with the bbox.
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]?.kind).toBe("tile");
    expect(store.puts[0]?.assetId).toBe(cacheAssetIdFor(binding.baseAssetId, target));
    expect(store.puts[0]?.bbox).toEqual([0.1, 0.1, 0.6, 0.7]);
    expect(store.puts[0]?.revisionId).toBe("rev-1");

    // Second call: pure cache read, no further render.
    const second = await cache.getOrRender(binding, target, scope);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.rendered).toBe(false);
    expect(second.result.data.equals(PNG)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1 — served from cache
  });

  it("caches a full-page render as a `page` asset", async () => {
    const store = fakeAssetStore();
    const fetchImpl = vi.fn(async () =>
      new Response(PNG, { status: 200, headers: { "x-render-width": "800", "x-render-height": "600" } }),
    ) as unknown as typeof fetch;
    const cache = createRenderCache({ converter, assetStore: store, logger, fetchImpl });

    const res = await cache.getOrRender(binding, { sourceSha256: "b".repeat(64), page: 5 }, scope);
    expect(res.ok).toBe(true);
    expect(store.puts[0]?.kind).toBe("page");
    expect(store.puts[0]?.bbox).toBeNull();
  });

  it("(g) enforces the asset's revision row ACL: a denied read never renders", async () => {
    const store = fakeAssetStore({ denied: true });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const cache = createRenderCache({ converter, assetStore: store, logger, fetchImpl });

    const res = await cache.getOrRender(binding, { sourceSha256: "c".repeat(64), page: 1 }, scope);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.status).toBe(403);
    // The ACL denial short-circuits before any render or cache write.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.puts).toHaveLength(0);
  });

  it("fails closed on a malformed source digest before any read or render", async () => {
    const store = fakeAssetStore();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const cache = createRenderCache({ converter, assetStore: store, logger, fetchImpl });
    for (const bad of ["x", "A".repeat(64), "../../etc/passwd"]) {
      const res = await cache.getOrRender(binding, { sourceSha256: bad, page: 1 }, scope);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error.status).toBe(400);
      expect(res.error.code).toBe("INVALID_SOURCE_SHA256");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.puts).toHaveLength(0);
  });
  it("surfaces a 404 from Extract (unknown source) as a miss-shaped error", async () => {
    const store = fakeAssetStore();
    const fetchImpl = vi.fn(async () => new Response("no source", { status: 404 })) as unknown as typeof fetch;
    const cache = createRenderCache({ converter, assetStore: store, logger, fetchImpl });

    const res = await cache.getOrRender(binding, { sourceSha256: "d".repeat(64), page: 1 }, scope);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.status).toBe(404);
    expect(store.puts).toHaveLength(0);
  });
});
