// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * render.test.ts
 *
 * `POST /v2/render` — on-demand page/region rendering from a stored source
 * (task 3.8, requirements 6.8, 14.4). The acceptance behaviours the task calls
 * for are proven here:
 *
 *   (a) a page and a bbox region render from a stored source, returning PNG
 *       bytes and the actual pixel size in the response headers;
 *   (b) an unknown source is a clean 404;
 *   (c) an over-budget request has its output clamped to the pixel ceiling
 *       (not a gigapixel buffer) and reports it;
 *   (d) the endpoint's own rate limit applies;
 *   (e) rendering identical inputs is byte-stable (deterministic), which is
 *       what lets Search cache the result.
 *
 * The source store is a real filesystem one in a temp dir; the sources are PNG
 * images so the render path exercises the real sharp helpers with no poppler
 * dependency (an image source has no text layer and needs no subprocess), which
 * keeps the test hermetic while still driving `createPageRenderer` → `render` /
 * `renderFigureCrop` for real.
 * TEMP_DIR points at a not-yet-created directory, so the tests never depend on
 * a host `/tmp/atf-extract` and prove the renderer creates its scratch root.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import { createFilesystemSourceStore, type Sha256Hex } from "../src/source-store.js";
import { renderFilename } from "../src/handlers/render.js";
import { loadTestConfig, stubExtractor, stubVisionClient, testLogger } from "./helpers.js";
import { createFakeJobStore } from "./job-store-fake.js";

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

let storeDir: string;
let tmpUploadDir: string;
let scratchParent: string;
const cleanups: Array<() => void> = [];

function toStream(buf: Buffer): Readable {
  return Readable.from([buf]);
}

/** A solid-colour PNG of a given size, used as a stored image source. */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** Store PNG bytes in the source store and return its content address. */
async function storeSource(bytes: Buffer): Promise<Sha256Hex> {
  const store = createFilesystemSourceStore(storeDir);
  const stored = await store.putStream(toStream(bytes));
  return stored.sha256;
}

function buildApp(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
) {
  const config = loadTestConfig({
    SOURCE_STORE_DIR: storeDir,
    UPLOAD_TMP_DIR: tmpUploadDir,
    TEMP_DIR: join(scratchParent, "not-yet-created"),
    ...configOverrides,
  });
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    sourceStore: createFilesystemSourceStore(storeDir),
    ...overrides,
  });
  cleanups.push(created.cleanup);
  return created.app;
}

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "atf-render-store-"));
  tmpUploadDir = await mkdtemp(join(tmpdir(), "atf-render-tmp-"));
  scratchParent = await mkdtemp(join(tmpdir(), "atf-render-scratch-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  await rm(storeDir, { recursive: true, force: true });
  await rm(tmpUploadDir, { recursive: true, force: true });
  await rm(scratchParent, { recursive: true, force: true });
});

describe("POST /v2/render", () => {
  it("(a) renders a whole page from a stored source and returns PNG bytes + size", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(640, 480));

    const res = await request(app)
      .post("/v2/render")
      .send({ source, page: 1 })
      .expect(200);

    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toBeInstanceOf(Buffer);
    // PNG magic bytes prove real image bytes came back.
    expect(res.body.subarray(0, 4).toString("hex")).toBe("89504e47");
    // The whole page is 640×480; the header reports the actual pixel size.
    expect(Number(res.headers["x-render-width"])).toBe(640);
    expect(Number(res.headers["x-render-height"])).toBe(480);
    const decoded = await sharp(res.body).metadata();
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(480);
  });

  it("(a) renders a bbox region crop from a stored source", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(600, 400));

    const res = await request(app)
      .post("/v2/render")
      .send({ source, page: 1, bbox: [0.0, 0.0, 0.5, 0.5] })
      .expect(200);

    expect(res.headers["content-type"]).toBe("image/png");
    // Half the width and half the height of a 600×400 page.
    expect(Number(res.headers["x-render-width"])).toBe(300);
    expect(Number(res.headers["x-render-height"])).toBe(200);
  });

  it("honours targetPixels by resizing the long edge", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(800, 400));

    const res = await request(app)
      .post("/v2/render")
      .send({ source, page: 1, targetPixels: 400 })
      .expect(200);

    // Long edge (800) requested down to 400; aspect kept → 400×200.
    expect(Number(res.headers["x-render-width"])).toBe(400);
    expect(Number(res.headers["x-render-height"])).toBe(200);
    expect(res.headers["x-render-clamped"]).toBe("0");
  });

  it("(b) returns 404 for an unknown source", async () => {
    const app = buildApp();
    const missing = createHash("sha256").update("nope").digest("hex");

    const res = await request(app)
      .post("/v2/render")
      .send({ source: missing, page: 1 })
      .expect(404);

    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("(c) clamps an over-budget targetPixels to the pixel ceiling", async () => {
    // A tiny ceiling makes the clamp observable without a huge source image.
    const app = buildApp({ RENDER_MAX_PIXELS: "10000" }); // 100×100 budget
    const source = await storeSource(await makePng(400, 400));

    const res = await request(app)
      .post("/v2/render")
      .send({ source, page: 1, targetPixels: 5000 })
      .expect(200);

    expect(res.headers["x-render-clamped"]).toBe("1");
    const width = Number(res.headers["x-render-width"]);
    const height = Number(res.headers["x-render-height"]);
    // Never above the ceiling, even though 5000px was requested.
    expect(width * height).toBeLessThanOrEqual(10_000);
  });

  it("validates the request body and page range", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(100, 100));

    await request(app).post("/v2/render").send({ page: 1 }).expect(400);
    await request(app)
      .post("/v2/render")
      .send({ source, page: 99 })
      .expect(400);
  });

  it("(d) applies the render rate limit", async () => {
    const app = buildApp({ RENDER_RATE_LIMIT: "2" });
    const source = await storeSource(await makePng(64, 64));

    await request(app).post("/v2/render").send({ source, page: 1 }).expect(200);
    await request(app).post("/v2/render").send({ source, page: 1 }).expect(200);
    const limited = await request(app).post("/v2/render").send({ source, page: 1 });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
  });

  it("(e) is deterministic: identical inputs yield byte-stable output", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(320, 240));

    const first = await request(app)
      .post("/v2/render")
      .send({ source, page: 1, bbox: [0.1, 0.1, 0.6, 0.7], targetPixels: 200 })
      .expect(200);
    const second = await request(app)
      .post("/v2/render")
      .send({ source, page: 1, bbox: [0.1, 0.1, 0.6, 0.7], targetPixels: 200 })
      .expect(200);

    expect(Buffer.compare(first.body, second.body)).toBe(0);
  });
});

describe("POST /ui/render · console page preview", () => {
  it("renders through the cookie BFF for a same-origin request", async () => {
    const app = buildApp({}, { store: createFakeJobStore() });
    const source = await storeSource(await makePng(320, 200));

    const res = await request(app)
      .post("/ui/render")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ source, page: 1, targetPixels: 160 })
      .expect(200);

    expect(res.headers["content-type"]).toBe("image/png");
    expect(Number(res.headers["x-render-width"])).toBe(160);
  });

  it("refuses a cross-origin request before rendering", async () => {
    const app = buildApp({}, { store: createFakeJobStore() });
    const source = await storeSource(await makePng(320, 200));

    const res = await request(app)
      .post("/ui/render")
      .set("Origin", "https://attacker.example")
      .send({ source, page: 1 });
    expect(res.status).toBe(403);
  });

  it("is not mounted without the v2 job store", async () => {
    const app = buildApp();
    const res = await request(app).post("/ui/render").set("Sec-Fetch-Site", "same-origin").send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /v2/render · input hardening", () => {
  it("rejects a source that is not a lowercase 64-char hex sha256", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(64, 64));
    for (const bad of [source.toUpperCase(), "../../etc/passwd", "a".repeat(63), `${"a".repeat(63)}g`]) {
      const res = await request(app).post("/v2/render").send({ source: bad, page: 1 });
      expect(res.status, bad).toBe(400);
    }
  });

  it("never passes a path-bearing filename through; renders from the store", async () => {
    const app = buildApp();
    const source = await storeSource(await makePng(64, 48));
    const res = await request(app)
      .post("/v2/render")
      .send({ source, page: 1, filename: "../../../../etc/passwd.png" })
      .expect(200);
    expect(Number(res.headers["x-render-width"])).toBe(64);
  });
});

describe("renderFilename", () => {
  const sha = "b".repeat(64);

  it("keeps only a safe, lower-cased extension of the basename", () => {
    expect(renderFilename(sha, "Report.PDF")).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, "folder/sub/plan.vsdx")).toBe(`${sha}.vsdx`);
    expect(renderFilename(sha, "C:\\Users\\x\\sheet.xlsx")).toBe(`${sha}.xlsx`);
  });

  it("strips every path component, so traversal can never survive", () => {
    for (const name of ["../../etc/passwd", "../x.png/../../y", "/abs/path/file.png", "..\\..\\win.ini"]) {
      const out = renderFilename(sha, name);
      expect(out.startsWith(sha)).toBe(true);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toContain("..");
    }
  });

  it("falls back to <sha>.pdf for a missing, extension-less or unsafe name", () => {
    expect(renderFilename(sha, undefined)).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, "")).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, "noext")).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, ".hidden")).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, "x.p\u0000df")).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, "x.toolongextension1")).toBe(`${sha}.pdf`);
    expect(renderFilename(sha, "x.")).toBe(`${sha}.pdf`);
  });
});
