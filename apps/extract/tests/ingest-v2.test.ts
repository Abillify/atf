// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-v2.test.ts
 *
 * The v2 wrapper for `POST /v1/ingest`.
 *
 * When a database and a Search target are configured, `/v1/ingest` stores the
 * upload in the source store, creates a v2 job, drives it inline for a small
 * document, and returns the historical synchronous shape — now with figure
 * assets stored by the job (so `assets_stored` counts the acked figure crops).
 *
 * The job worker/pipeline is faked here (the `runOneJob` seam): it advances the
 * fake store's job exactly as the real worker + runner + emitter would, so the
 * test needs no model, no poppler and no database.
 */

import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngestV2Handler } from "../src/handlers/ingest-v2.js";
import { createUploadMiddleware } from "../src/upload.js";
import { createFilesystemSourceStore, type SourceStore } from "../src/source-store.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { buildSnapshot } from "../src/jobs/snapshot.js";
import { testLogger } from "./helpers.js";

const PDF = Buffer.from("%PDF-1.7\na small document\n");

const SNAPSHOT = buildSnapshot(
  { extractor: "poppler", renderer: "pdftoppm", visionModel: "test-vlm", renderDpi: 200, figureDpi: 300 },
  {},
);

let storeDir: string;
let sourceStore: SourceStore;
let fakeStore: FakeJobStore;

const noopMetrics = { recordDocument: () => {} };

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "atf-ingestv2-"));
  sourceStore = createFilesystemSourceStore(storeDir);
  fakeStore = createFakeJobStore();
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await rm(storeDir, { recursive: true, force: true });
});

/**
 * Mount `app` on one stable loopback URL for the duration of a test — supertest
 * per-request ephemeral servers churn ports and let foreign local processes
 * answer (see documents.test.ts for the full explanation).
 */
async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A fake "run one job" that finds the single queued job and drives it to a
 * terminal state, staging the given assets and recording a revision, exactly as
 * the real worker + runner + emitter would. `pageCount` decides how large the
 * document looks; `figureAssets` are acked figure crops.
 */
function fakeWorker(options: {
  pageCount?: number;
  figureAssets?: number;
  failedFigures?: number;
  status?: "completed" | "failed";
  revisionId?: string | null;
} = {}) {
  const pageCount = options.pageCount ?? 3;
  const status = options.status ?? "completed";
  const revisionId = options.revisionId === undefined ? "rev-1" : options.revisionId;
  return async (): Promise<boolean> => {
    const claimed = await fakeStore.claimNextJob("fake-worker", 60);
    if (claimed === null) return false;
    await fakeStore.setJobPageCount(claimed.id, pageCount);
    // Stage the page images (variant "page") and figure crops (variant null).
    for (let page = 1; page <= pageCount; page++) {
      await fakeStore.stageAsset({ job_id: claimed.id, asset_id: `page-${page}`, variant: "page" });
    }
    for (let f = 1; f <= (options.figureAssets ?? 0); f++) {
      await fakeStore.stageAsset({ job_id: claimed.id, asset_id: `fig-${f}`, variant: null });
      await fakeStore.setAssetStatus(claimed.id, `fig-${f}`, "acked");
    }
    for (let f = 1; f <= (options.failedFigures ?? 0); f++) {
      const id = `fig-fail-${f}`;
      await fakeStore.stageAsset({ job_id: claimed.id, asset_id: id, variant: null });
      await fakeStore.setAssetStatus(claimed.id, id, "failed");
    }
    if (revisionId !== null) await fakeStore.setJobRevision(claimed.id, revisionId);
    await fakeStore.setJobStatus(claimed.id, status);
    return true;
  };
}

/** Mount the handler on a bare app, with the given inline-drive fake. */
async function buildApp(
  runOneJob: (() => Promise<boolean>) | null,
  overrides: {
    syncPageLimit?: number;
    syncTimeoutMs?: number;
    uploadMemoryThresholdBytes?: number;
  } = {},
): Promise<string> {
  const handler = createIngestV2Handler({
    store: fakeStore,
    sourceStore,
    runOneJob,
    logger: testLogger,
    metrics: noopMetrics,
    snapshot: SNAPSHOT,
    defaultCollection: "documents",
    syncPageLimit: overrides.syncPageLimit ?? 50,
    syncTimeoutMs: overrides.syncTimeoutMs ?? 5_000,
  });
  const app = express();
  app.post(
    "/v1/ingest",
    createUploadMiddleware({
      maxUploadBytes: 10_000_000,
      uploadMemoryThresholdBytes:
        overrides.uploadMemoryThresholdBytes ?? 8_388_608,
      tempDir: storeDir,
    }),
    handler,
  );
  // Minimal error middleware mirroring the production one, so a thrown
  // validationError surfaces as a 400 with its code rather than a bare 500.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const e = err as { status?: number; code?: string; message?: string };
      res.status(typeof e.status === "number" ? e.status : 500).json({
        error: e.message ?? "error",
        ...(e.code !== undefined ? { code: e.code } : {}),
      });
    },
  );
  return serve(app);
}

describe("POST /v1/ingest · v2 wrapper", () => {
  it("stores the source, creates a job, and returns a synchronous completed result for a small document", async () => {
    const baseUrl = await buildApp(
      fakeWorker({ pageCount: 3, figureAssets: 2 }),
    );

    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/handbuch.pdf")
      .send(PDF);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.reference).toBe("tests/handbuch.pdf");
    expect(res.body.collection).toBe("documents");
    expect(res.body.page_count).toBe(3);
    expect(res.body.figure_count).toBe(2);
    expect(res.body.assets_stored).toBe(2);
    expect(res.body.assets_failed).toBe(0);
    expect(res.body.revision_id).toBe("rev-1");
    expect(typeof res.body.job_id).toBe("string");

    // The source was stored, and a job was created against it.
    const job = fakeStore.peek(res.body.job_id);
    expect(job?.status).toBe("completed");
    expect(await sourceStore.has(job?.source_sha256 ?? "")).toBe(true);
  });

  it("reports how the requested access list was treated in X-ACL-Applied", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const plain = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(plain.headers["x-acl-applied"]).toBe("none");

    // No identity and no extract.acl.assign: the request is discarded.
    const requested = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "b")
      .set("X-Allowed-Groups", "finance")
      .send(PDF);
    expect(requested.headers["x-acl-applied"]).toBe("service-empty");
  });

  it("honours an explicit collection", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Collection", "specs")
      .send(PDF);
    expect(res.status).toBe(200);
    expect(res.body.collection).toBe("specs");
    expect(fakeStore.peek(res.body.job_id)?.collection).toBe("specs");
  });

  it("reports the acked figure crops as assets_stored and failed ones as assets_failed", async () => {
    const baseUrl = await buildApp(
      fakeWorker({ pageCount: 2, figureAssets: 3, failedFigures: 1 }),
    );
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(res.status).toBe(200);
    // Page images (variant "page") are not counted as figures.
    expect(res.body.figure_count).toBe(4); // 3 acked + 1 failed
    expect(res.body.assets_stored).toBe(3);
    expect(res.body.assets_failed).toBe(1);
  });

  it("streams a spooled multipart upload into the source store and reaps the scratch file", async () => {
    // Requirement 5.9: above the threshold the upload lives on disk, and this
    // handler must hand it to the store disk-to-disk — the durable copy is all
    // the job worker reads from, so the scratch file is gone once stored.
    const large = Buffer.concat([PDF, Buffer.alloc(50_000, 0x42)]);
    const baseUrl = await buildApp(fakeWorker({ pageCount: 1 }), {
      uploadMemoryThresholdBytes: 1024,
    });
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("X-Reference", "gross.pdf")
      .attach("document", large, {
        filename: "gross.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(200);

    const sha256 = createHash("sha256").update(large).digest("hex");
    const storedPath = await sourceStore.locate(sha256);
    expect(storedPath).not.toBeNull();
    expect(await readFile(storedPath ?? "")).toEqual(large);
    await expect(
      readdir(join(storeDir, "uploads")).then((names) => names.length),
    ).resolves.toBe(0);
  });

  it("refuses a collection name Search would reject, before creating a job", async () => {
    const baseUrl = await buildApp(fakeWorker({ pageCount: 1 }));
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a.pdf")
      .set("X-Collection", "atf-ui-smoketest")
      .send(PDF);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/X-Collection/);
  });

  it("requires X-Reference", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .send(PDF);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 202 with the job id when the document is too large for the sync contract", async () => {
    // The fake advances the job past preparing with a page count above the sync
    // ceiling but leaves it non-terminal, so the handler stops waiting inline
    // and answers async with the job id to poll.
    const baseUrl = await buildApp(
      async () => {
        const claimed = await fakeStore.claimNextJob("w", 60);
        if (claimed === null) return false;
        await fakeStore.setJobPageCount(claimed.id, 500);
        await fakeStore.setJobStatus(claimed.id, "processing");
        return true;
      },
      { syncPageLimit: 2 },
    );

    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "big.pdf")
      .send(PDF);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
    expect(typeof res.body.job_id).toBe("string");
    expect(res.body.poll).toBe(`/v2/jobs/${res.body.job_id}`);
  });

  it("returns 502 when the job ends in a failed state", async () => {
    const baseUrl = await buildApp(
      fakeWorker({ status: "failed", revisionId: null }),
    );
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("INGEST_JOB_FAILED");
  });
});

describe("POST /v1/ingest · identity headers and duplicates", () => {
  it("stores X-Version, X-Source-Modified and X-Dedup on the job", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/v.pdf")
      .set("X-Version", "3.1")
      .set("X-Source-Modified", "2025-01-02T03:04:05+01:00")
      .set("X-Dedup", "exact")
      .send(PDF);
    expect(res.status).toBe(200);
    const job = fakeStore.peek(res.body.job_id);
    expect(job?.config).toMatchObject({ version: "3.1", sourceModifiedAt: "2025-01-02T03:04:05+01:00", dedup: "exact" });
  });

  it("stores X-Title, X-Tags, X-Metadata, X-Link and X-Source on the job (contract 2.2)", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/attrs.pdf")
      .set("X-Title", "Spezifikation")
      .set("X-Tags", "kunde-a, alpha")
      .set("X-Metadata", JSON.stringify({ projekt: "Alpha" }))
      .set("X-Link", "https://dms.example/1")
      .set("X-Source", "DMS")
      .send(PDF);
    expect(res.status).toBe(200);
    const job = fakeStore.peek(res.body.job_id);
    expect(job?.config).toMatchObject({
      title: "Spezifikation",
      tags: ["kunde-a", "alpha"],
      metadata: { projekt: "Alpha" },
      link: "https://dms.example/1",
      sourceLabel: "DMS",
    });
  });

  it("rejects an X-Metadata that is not a JSON object", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const res = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/attrs.pdf")
      .set("X-Metadata", "[1,2]")
      .send(PDF);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed X-Source-Modified or X-Dedup", async () => {
    const baseUrl = await buildApp(fakeWorker());
    const bad = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/v.pdf")
      .set("X-Source-Modified", "yesterday")
      .send(PDF);
    expect(bad.status).toBe(400);
    const badDedup = await request(baseUrl)
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/v.pdf")
      .set("X-Dedup", "maybe")
      .send(PDF);
    expect(badDedup.status).toBe(400);
  });

  it("answers a skipped duplicate with status skipped and duplicate_of", async () => {
    const worker = async (): Promise<boolean> => {
      const claimed = await fakeStore.claimNextJob("fake-worker", 60);
      if (claimed === null) return false;
      await fakeStore.patchJobConfig(claimed.id, {
        identity: {
          requestedReference: "tests/dup.docx",
          canonicalReference: "tests/dup.pdf",
          decision: "duplicate",
          registered: true,
          complete: true,
          duplicateOf: { reference: "tests/dup.pdf", sourceId: "j0", match: "similar", similarity: 0.99 },
        },
      });
      await fakeStore.setJobStatus(claimed.id, "completed");
      return true;
    };
    const res = await request(await buildApp(worker))
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/dup.docx")
      .send(PDF);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "skipped",
      reason: "duplicate",
      reference: "tests/dup.docx",
      resolved_reference: "tests/dup.pdf",
      duplicate_of: { reference: "tests/dup.pdf", match: "similar" },
    });
  });
});
