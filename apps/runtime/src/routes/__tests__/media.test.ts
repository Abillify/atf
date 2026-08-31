// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the public media-serving route (`GET /media/:id`).
 *
 * The endpoint serves transient generated media by an unguessable id, so the
 * chat stream can reference large images by a short URL instead of inlining a
 * base64 data-URI (which Open WebUI cannot render).
 */

import { describe, test, expect } from "bun:test";
import { createMediaRouter } from "../media.js";
import { InMemoryMediaStore } from "../../graph/media-store.js";

function appWithMedia() {
  const store = new InMemoryMediaStore();
  const router = createMediaRouter(store);
  return { store, router };
}

describe("GET /v1/media/:id", () => {
  test("serves stored bytes with the correct Content-Type", async () => {
    const { store, router } = appWithMedia();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const id = store.put(data, "image/png");

    const res = await router.request(`/v1/media/${id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3, 4, 5]);
  });

  test("resolves the id regardless of the cosmetic extension", async () => {
    const { store, router } = appWithMedia();
    const id = store.put(new Uint8Array([9]), "image/jpeg");

    // No extension and a mismatched extension both resolve to the same id.
    expect((await router.request(`/v1/media/${id}`)).status).toBe(200);
    expect((await router.request(`/v1/media/${id}.jpg`)).status).toBe(200);
  });

  test("returns 404 for an unknown id", async () => {
    const { router } = appWithMedia();
    const res = await router.request(
      "/v1/media/00000000-0000-4000-8000-000000000000.png",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("not_found");
  });
});
