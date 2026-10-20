// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Lifecycle of the derived-PDF cache (`TEMP_DIR/derived-pdf`): it holds the
 * full content of converted documents, so it must be reachable by document
 * deletion and DSAR erasure, and bounded by age and size.
 *
 *  (a) unit: `removeDerivedPdfsFor` / `evictDerivedPdfs` on a real directory;
 *  (b) HTTP: `DELETE /v2/documents/{reference}` and `POST /v1/erasure` remove
 *      the cached conversions of the sources the erased jobs held;
 *  (c) renderer: a running job's cache file is never evicted from under it.
 */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  derivedPdfCacheDir,
  evictDerivedPdfs,
  isCacheFileName,
  removeDerivedPdfsFor,
  touchDerivedPdf,
} from "../src/jobs/derived-pdf-cache.js";
import { type AppOverrides, createApp } from "../src/index.js";
import {
  loadTestConfig,
  stubExtractor,
  stubSearchClient,
  stubVisionClient,
  testLogger,
} from "./helpers.js";
import { createFakeJobStore } from "./job-store-fake.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const ID1 = "0123456789abcdef";
const ID2 = "fedcba9876543210";

let scratch: string;
let cacheDir: string;
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atf-derived-lifecycle-"));
  cacheDir = derivedPdfCacheDir(scratch);
  await mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await rm(scratch, { recursive: true, force: true });
});

/** Create a cache file of `bytes` bytes last used `ageMs` ago. */
async function cacheFile(
  sha: string,
  identity: string,
  bytes = 10,
  ageMs = 0,
  now = Date.now(),
): Promise<string> {
  const path = join(cacheDir, `${sha}-${identity}.pdf`);
  await writeFile(path, Buffer.alloc(bytes, 1));
  const when = new Date(now - ageMs);
  await utimes(path, when, when);
  return path;
}

async function names(): Promise<string[]> {
  return (await readdir(cacheDir)).sort();
}

describe("removeDerivedPdfsFor", () => {
  it("removes every conversion of the digest, whatever the converter identity", async () => {
    await cacheFile(SHA_A, ID1);
    await cacheFile(SHA_A, ID2);
    await cacheFile(SHA_B, ID1);
    expect(await removeDerivedPdfsFor(cacheDir, [SHA_A])).toBe(2);
    expect(await names()).toEqual([`${SHA_B}-${ID1}.pdf`]);
  });

  it("ignores malformed digests, foreign files and path tricks", async () => {
    const keep = await cacheFile(SHA_A, ID1);
    await writeFile(join(cacheDir, "notes.txt"), "x");
    await writeFile(join(cacheDir, `${SHA_B}.pdf`), "x");
    const removed = await removeDerivedPdfsFor(cacheDir, [
      "../../etc/passwd",
      "A".repeat(64), // upper case is not a digest this cache ever wrote
      "abc",
      "",
    ]);
    expect(removed).toBe(0);
    expect(await names()).toEqual(
      ["notes.txt", `${SHA_A}-${ID1}.pdf`, `${SHA_B}.pdf`].sort(),
    );
    await expect(stat(keep)).resolves.toBeDefined();
  });

  it("is a no-op for a missing cache directory and for an empty digest list", async () => {
    expect(await removeDerivedPdfsFor(join(scratch, "nope"), [SHA_A])).toBe(0);
    expect(await removeDerivedPdfsFor(cacheDir, [])).toBe(0);
  });

  it("only treats files it created as cache files", () => {
    expect(isCacheFileName(`${SHA_A}-${ID1}.pdf`)).toBe(true);
    for (const name of [
      `${SHA_A}.pdf`,
      `${SHA_A}-${ID1}.pdf.tmp`,
      `${SHA_A}-XYZ.pdf`,
      "../x.pdf",
      `${SHA_A}-${ID1}.PDF`,
    ]) {
      expect(isCacheFileName(name)).toBe(false);
    }
  });
});

describe("evictDerivedPdfs", () => {
  const HOUR = 3_600_000;

  it("drops conversions not used within the age limit and keeps recent ones", async () => {
    const now = Date.now();
    await cacheFile(SHA_A, ID1, 10, 30 * HOUR, now);
    await cacheFile(SHA_B, ID1, 10, 1 * HOUR, now);
    const result = await evictDerivedPdfs(
      cacheDir,
      { maxBytes: 0, maxAgeMs: 24 * HOUR },
      { now },
    );
    expect(result.removedByAge).toBe(1);
    expect(await names()).toEqual([`${SHA_B}-${ID1}.pdf`]);
  });

  it("enforces the size ceiling, least recently used first", async () => {
    const now = Date.now();
    await cacheFile(SHA_A, ID1, 100, 3 * HOUR, now); // oldest
    await cacheFile(SHA_B, ID1, 100, 2 * HOUR, now);
    await cacheFile(SHA_C, ID1, 100, 1 * HOUR, now); // newest
    const result = await evictDerivedPdfs(
      cacheDir,
      { maxBytes: 250, maxAgeMs: 0 },
      { now },
    );
    expect(result.removedBySize).toBe(1);
    expect(result.remainingBytes).toBe(200);
    expect(await names()).toEqual([`${SHA_B}-${ID1}.pdf`, `${SHA_C}-${ID1}.pdf`]);
  });

  it("applies age first, then the size ceiling to what is left", async () => {
    const now = Date.now();
    await cacheFile(SHA_A, ID1, 100, 40 * HOUR, now); // expired
    await cacheFile(SHA_B, ID1, 100, 2 * HOUR, now);
    await cacheFile(SHA_C, ID1, 100, 1 * HOUR, now);
    const result = await evictDerivedPdfs(
      cacheDir,
      { maxBytes: 150, maxAgeMs: 24 * HOUR },
      { now },
    );
    expect(result.removedByAge).toBe(1);
    expect(result.removedBySize).toBe(1);
    expect(await names()).toEqual([`${SHA_C}-${ID1}.pdf`]);
  });

  it("never evicts a pinned file, by age or by size", async () => {
    const now = Date.now();
    const pinned = await cacheFile(SHA_A, ID1, 500, 99 * HOUR, now);
    await cacheFile(SHA_B, ID1, 100, 1 * HOUR, now);
    const result = await evictDerivedPdfs(
      cacheDir,
      { maxBytes: 50, maxAgeMs: 24 * HOUR },
      { now, pinned: new Set([pinned]) },
    );
    expect(await names()).toContain(`${SHA_A}-${ID1}.pdf`);
    // The unpinned newer file is the only victim the size rule may take.
    expect(await names()).not.toContain(`${SHA_B}-${ID1}.pdf`);
    expect(result.remainingBytes).toBe(500);
  });

  it("is unlimited with both limits at 0, and ignores foreign files", async () => {
    const now = Date.now();
    await cacheFile(SHA_A, ID1, 100, 999 * HOUR, now);
    await writeFile(join(cacheDir, "README.txt"), "operator note");
    const result = await evictDerivedPdfs(cacheDir, { maxBytes: 0, maxAgeMs: 0 }, { now });
    expect(result.removedByAge + result.removedBySize).toBe(0);
    expect(await names()).toEqual(["README.txt", `${SHA_A}-${ID1}.pdf`].sort());
    // Even under an aggressive limit a foreign file is not touched.
    await evictDerivedPdfs(cacheDir, { maxBytes: 1, maxAgeMs: 1 }, { now });
    expect(await names()).toEqual(["README.txt"]);
  });

  it("a cache hit refreshes the last-use time (touch) and so postpones eviction", async () => {
    const now = Date.now();
    const old = await cacheFile(SHA_A, ID1, 10, 30 * HOUR, now);
    await touchDerivedPdf(old, new Date(now));
    const result = await evictDerivedPdfs(
      cacheDir,
      { maxBytes: 0, maxAgeMs: 24 * HOUR },
      { now },
    );
    expect(result.removedByAge).toBe(0);
  });

  it("returns an empty result for a missing directory", async () => {
    const result = await evictDerivedPdfs(
      join(scratch, "missing"),
      { maxBytes: 1, maxAgeMs: 1 },
    );
    expect(result).toEqual({ removedByAge: 0, removedBySize: 0, remainingBytes: 0 });
  });
});

// ── HTTP: DELETE /v2/documents and POST /v1/erasure ──────────────────────────

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

async function serve(app: ReturnType<typeof createApp>["app"]): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function buildApp(
  env: Record<string, string | undefined>,
  overrides: AppOverrides,
): Promise<string> {
  const config = loadTestConfig({ TEMP_DIR: scratch, ...env });
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    ...overrides,
  });
  cleanups.push(created.cleanup);
  return serve(created.app);
}

const token = "e".repeat(40);
const tokenEnv = {
  AUTHN_MODE: "token",
  AUTHZ_ENABLED: "true",
  API_TOKEN: token,
  API_SERVICE_SCOPES: "extract.delete,extract.erasure",
};

describe("DELETE /v2/documents/{reference} removes the cached conversions", () => {
  it("drops the entries of every source the reference's jobs held, and no others", async () => {
    const store = createFakeJobStore();
    await store.createJob({
      id: randomUUID(),
      reference: "docs/a.docx",
      source_sha256: SHA_A,
      collection: "documents",
      status: "completed",
    });
    await store.createJob({
      id: randomUUID(),
      reference: "docs/a.docx",
      source_sha256: SHA_B, // an earlier revision of the same document
      collection: "documents",
      status: "completed",
    });
    await store.createJob({
      id: randomUUID(),
      reference: "docs/other.docx",
      source_sha256: SHA_C,
      collection: "documents",
      status: "completed",
    });
    await cacheFile(SHA_A, ID1);
    await cacheFile(SHA_A, ID2);
    await cacheFile(SHA_B, ID1);
    await cacheFile(SHA_C, ID1);

    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient() });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.docx")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await names()).toEqual([`${SHA_C}-${ID1}.pdf`]);
  });

  it("also cleans up when Search never held the reference (404)", async () => {
    const store = createFakeJobStore();
    await store.createJob({
      id: randomUUID(),
      reference: "docs/failed.docx",
      source_sha256: SHA_A,
      collection: "documents",
      status: "failed",
    });
    await cacheFile(SHA_A, ID1);
    const base = await buildApp(tokenEnv, {
      store,
      searchClient: stubSearchClient({ deleted: 0 }),
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/failed.docx")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(await names()).toEqual([]);
  });

  it("leaves the cache alone when DERIVED_PDF_CACHE is off", async () => {
    const store = createFakeJobStore();
    await store.createJob({
      id: randomUUID(),
      reference: "docs/a.docx",
      source_sha256: SHA_A,
      collection: "documents",
      status: "completed",
    });
    await cacheFile(SHA_A, ID1);
    const base = await buildApp(
      { ...tokenEnv, DERIVED_PDF_CACHE: "false" },
      { store, searchClient: stubSearchClient() },
    );
    await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.docx")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(await names()).toEqual([`${SHA_A}-${ID1}.pdf`]);
  });
});

describe("POST /v1/erasure removes the cached conversions", () => {
  it("reports and removes the entries of the erased jobs' sources", async () => {
    const store = createFakeJobStore();
    await store.createJob({
      id: randomUUID(),
      reference: "docs/a.docx",
      source_sha256: SHA_A,
      created_by_subject: "u1",
      created_by_tenant: "default",
      status: "completed",
    });
    await store.createJob({
      id: randomUUID(),
      reference: "docs/b.docx",
      source_sha256: SHA_B,
      created_by_subject: "someone-else",
      created_by_tenant: "default",
      status: "completed",
    });
    await cacheFile(SHA_A, ID1);
    await cacheFile(SHA_B, ID1);

    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient() });
    const res = await request(base)
      .post("/v1/erasure")
      .set("Authorization", `Bearer ${token}`)
      .send({
        requestId: randomUUID(),
        tenantId: "default",
        subject: { userId: "u1", externalIds: [] },
        scope: "subject",
        dryRun: false,
      });
    expect([200, 207]).toContain(res.status);
    const derived = (res.body.results as Array<{ store: string; erased: number; status: string }>).find(
      (s) => s.store === "extract.derived_pdf_cache",
    );
    expect(derived).toEqual({ store: "extract.derived_pdf_cache", status: "ok", erased: 1 });
    expect(await names()).toEqual([`${SHA_B}-${ID1}.pdf`]);
  });

  it("a dry run reports 0 and removes nothing", async () => {
    const store = createFakeJobStore();
    await store.createJob({
      id: randomUUID(),
      reference: "docs/a.docx",
      source_sha256: SHA_A,
      created_by_subject: "u1",
      created_by_tenant: "default",
      status: "completed",
    });
    await cacheFile(SHA_A, ID1);
    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient() });
    const res = await request(base)
      .post("/v1/erasure")
      .set("Authorization", `Bearer ${token}`)
      .send({
        requestId: randomUUID(),
        tenantId: "default",
        subject: { userId: "u1", externalIds: [] },
        scope: "subject",
        dryRun: true,
      });
    expect([200, 207]).toContain(res.status);
    expect(await names()).toEqual([`${SHA_A}-${ID1}.pdf`]);
  });
});
