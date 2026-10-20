// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs.test.ts
 *
 * The v2 Job API routes (task 1.5, requirements 4.10, 4.11, 4.12): create
 * returns a queued job; status maps progress/cost/eta; pause/resume/cancel/
 * retry-failed/reparse effects; 404 for an unknown id; auth required.
 *
 * The persistence layer is the in-memory fake job store; the source store is a
 * real filesystem one in a temp dir, because create rejects a job whose source
 * is not present.
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { loadTestConfig, stubExtractor, stubVisionClient, testLogger } from "./helpers.js";

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

let storeDir: string;
let tmpUploadDir: string;
let fakeStore: FakeJobStore;
const cleanups: Array<() => void | Promise<void>> = [];

/**
 * Mount `app` on one stable loopback URL for the duration of a test.
 *
 * Supertest creates — and closes — a fresh `http.Server` for every request
 * when handed the Express function, which churns ephemeral ports; the OS can
 * reissue a just-closed port to another local process and the next request is
 * answered by *that* process (observed as foreign statuses no assertion here
 * can explain). High-volume tests share one listening socket instead — same
 * pattern as documents.test.ts.
 */
async function serve(app: ReturnType<typeof createApp>["app"]): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    // Keep-alive sockets would hold close() open indefinitely.
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

async function buildApp(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
): Promise<string> {
  const config = loadTestConfig({
    SOURCE_STORE_DIR: storeDir,
    UPLOAD_TMP_DIR: tmpUploadDir,
    ...configOverrides,
  });
  fakeStore = createFakeJobStore();
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    store: fakeStore,
    sourceStore: createFilesystemSourceStore(storeDir),
    ...overrides,
  });
  cleanups.push(created.cleanup);
  return serve(created.app);
}

/** The real sha256 of the seeded source, so create passes the has() gate. */
let seededSha: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "atf-jobs-store-"));
  tmpUploadDir = await mkdtemp(join(tmpdir(), "atf-jobs-tmp-"));
  const src = createFilesystemSourceStore(storeDir);
  const stored = await src.putStream(Readable.from([Buffer.from("%PDF-1.7\nsource bytes\n")]));
  seededSha = stored.sha256;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  await rm(storeDir, { recursive: true, force: true });
  await rm(tmpUploadDir, { recursive: true, force: true });
});

async function createJob(baseUrl: string, body: Record<string, unknown> = {}) {
  return request(baseUrl)
    .post("/v2/jobs")
    .send({ reference: "tests/handbuch.pdf", sourceSha256: seededSha, ...body });
}

describe("POST /v2/jobs · create", () => {
  it("creates a queued job and echoes it as the wire Job", async () => {
    const baseUrl = await buildApp();
    const res = await createJob(baseUrl);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.jobId).toMatch(/[0-9a-f-]{36}/);
    expect(res.body.reference).toBe("tests/handbuch.pdf");
    expect(res.headers.location).toBe(`/v2/jobs/${res.body.jobId}`);
    // The snapshot was frozen onto the row.
    const row = fakeStore.peek(res.body.jobId);
    expect(row?.pipeline_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the document ACL narrowed to the caller", async () => {
    const baseUrl = await buildApp();
    const anonymous = await createJob(baseUrl);
    expect(fakeStore.peek(anonymous.body.jobId)?.config.acl).toEqual({ allowedUsers: [], allowedGroups: [] });

    // A service token asserting the uploading user, as the runtime calls it.
    const asserting = await buildApp({ API_TOKEN: "svc-token", AUTHN_MODE: "token" });
    const res = await request(asserting)
      .post("/v2/jobs")
      .set("Authorization", "Bearer svc-token")
      .set("X-User", "anna")
      .set("X-Groups", "team,sales")
      .send({
        reference: "tests/privat.pdf",
        sourceSha256: seededSha,
        allowedUsers: ["anna", "mallory"],
        allowedGroups: ["team", "admins"],
      });
    expect(res.status).toBe(201);
    expect(fakeStore.peek(res.body.jobId)?.config.acl).toEqual({ allowedUsers: ["anna"], allowedGroups: ["team"] });
  });

  it("stores the document attributes Search puts on every unit (contract 2.2)", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl).post("/v2/jobs").send({
      reference: "tests/attrs.pdf",
      sourceSha256: seededSha,
      title: "Pflichtenheft",
      tags: ["kunde-a"],
      metadata: { projekt: "WMS" },
      link: "https://dms.example/1",
      sourceLabel: "DMS",
    });
    expect(res.status).toBe(201);
    expect(fakeStore.peek(res.body.jobId)?.config).toMatchObject({
      title: "Pflichtenheft",
      tags: ["kunde-a"],
      metadata: { projekt: "WMS" },
      link: "https://dms.example/1",
      sourceLabel: "DMS",
    });
  });

  it("stores the pages window normalised, ready for the runner (contract 2.4)", async () => {
    const baseUrl = await buildApp();
    const cases: [string, unknown][] = [
      ["3-10", { from: 3, to: 10 }],
      ["5-", { from: 5 }],
      ["-8", { to: 8 }],
      ["7", { from: 7, to: 7 }],
    ];
    for (const [pages, expected] of cases) {
      const res = await createJob(baseUrl, { pages });
      expect(res.status).toBe(201);
      expect(fakeStore.peek(res.body.jobId)?.config.pages).toEqual(expected);
    }
    // No selection → null, as before.
    const all = await createJob(baseUrl);
    expect(fakeStore.peek(all.body.jobId)?.config.pages).toBeNull();
  });
  it("rejects a pages list or reversed window up front instead of silently ignoring it", async () => {
    const baseUrl = await buildApp();
    for (const pages of ["1-10,15", "10-3", "0", "alle"]) {
      const res = await createJob(baseUrl, { pages });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(res.body)).toContain("contiguous window");
    }
  });
  it("rejects a job whose source is not stored", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl)
      .post("/v2/jobs")
      .send({ reference: "tests/x.pdf", sourceSha256: "b".repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a malformed request body", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl).post("/v2/jobs").send({ reference: "" });
    expect(res.status).toBe(400);
  });

  it("honours resume_policy, priority, token budget and callback", async () => {
    const baseUrl = await buildApp();
    const res = await createJob(baseUrl, {
      resumePolicy: "continue",
      priority: 5,
      tokenBudget: 1000,
      callbackUrl: "https://hooks.example.com/done",
    });
    expect(res.status).toBe(201);
    const row = fakeStore.peek(res.body.jobId);
    expect(row?.resume_policy).toBe("continue");
    expect(row?.priority).toBe(5);
    expect(Number(row?.token_budget)).toBe(1000);
    expect(row?.callback_url).toBe("https://hooks.example.com/done");
  });
});

describe("GET /v2/jobs/{id} · status", () => {
  it("returns 404 for an unknown id", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl).get("/v2/jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("maps progress, cost and eta from the stage checkpoints", async () => {
    const baseUrl = await buildApp();
    const created = await createJob(baseUrl);
    const id = created.body.jobId;

    // Simulate a running job three pages into vision1 of four.
    await fakeStore.setJobStatus(id, "processing");
    const row = fakeStore.peek(id);
    if (row === undefined) throw new Error("expected a job row");
    row.page_count = 4;
    row.tokens_used = 1234;
    row.cost_usd = 0.42;
    row.created_at = new Date(Date.now() - 60_000); // one minute elapsed
    for (const page of [1, 2, 3]) {
      await fakeStore.upsertStage("page", {
        job_id: id,
        page,
        stage: "vision1",
        input_hash: "h",
        status: "done",
      });
    }
    await fakeStore.upsertStage("page", { job_id: id, page: 4, stage: "vision1", input_hash: "h", status: "pending" });

    const res = await request(baseUrl).get(`/v2/jobs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processing");
    expect(res.body.progress.vision1).toEqual({ done: 3, total: 4, failed: 0 });
    expect(res.body.pageCount).toBe(4);
    expect(res.body.tokensUsed).toBe(1234);
    expect(res.body.costUsd).toBeCloseTo(0.42);
    // eta is a non-negative number for a partially-complete running job.
    expect(typeof res.body.etaSeconds).toBe("number");
    expect(res.body.etaSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /v2/jobs · list (requirement 18.6)", () => {
  it("returns jobs newest-first through toJobView", async () => {
    const baseUrl = await buildApp();
    // Create three jobs with strictly increasing created_at so the order is
    // deterministic (the fake store stamps created_at from its clock).
    const first = (await createJob(baseUrl, { reference: "a" })).body.jobId;
    fakeStore.advance(1000);
    const second = (await createJob(baseUrl, { reference: "b" })).body.jobId;
    fakeStore.advance(1000);
    const third = (await createJob(baseUrl, { reference: "c" })).body.jobId;

    const res = await request(baseUrl).get("/v2/jobs");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);
    expect(res.body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([third, second, first]);
    // Each row is the wire Job shape, without the heavy per-stage progress join.
    expect(res.body.jobs[0].reference).toBe("c");
    expect(res.body.jobs[0].status).toBe("queued");
    expect(res.body.jobs[0].progress).toBeUndefined();
    expect(res.body.jobs[0].etaSeconds).toBeUndefined();
  });

  it("paginates with limit and offset", async () => {
    const baseUrl = await buildApp();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await createJob(baseUrl, { reference: `job-${i}` })).body.jobId);
      fakeStore.advance(1000);
    }
    // Newest-first: ids[4], ids[3], ids[2], ids[1], ids[0].
    const page1 = await request(baseUrl).get("/v2/jobs?limit=2&offset=0");
    expect(page1.body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([ids[4], ids[3]]);
    const page2 = await request(baseUrl).get("/v2/jobs?limit=2&offset=2");
    expect(page2.body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([ids[2], ids[1]]);
    const page3 = await request(baseUrl).get("/v2/jobs?limit=2&offset=4");
    expect(page3.body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([ids[0]]);
  });

  it("clamps a bad limit to the allowed range and defaults", async () => {
    const baseUrl = await buildApp();
    await createJob(baseUrl);
    const tooBig = await request(baseUrl).get("/v2/jobs?limit=9999");
    expect(tooBig.body.limit).toBe(100);
    const zero = await request(baseUrl).get("/v2/jobs?limit=0");
    expect(zero.body.limit).toBe(1);
    const junk = await request(baseUrl).get("/v2/jobs?limit=abc&offset=-3");
    expect(junk.body.limit).toBe(25);
    expect(junk.body.offset).toBe(0);
  });

  it("requires the read scope when auth is enabled", async () => {
    const baseUrl = await buildApp({
      AUTHN_MODE: "token",
      AUTHZ_ENABLED: "true",
      TENANT_ISOLATION_ENABLED: "false",
      API_TOKEN: "secret-token",
      API_SERVICE_SCOPES: "extract.convert,extract.ingest",
    });
    const noAuth = await request(baseUrl).get("/v2/jobs");
    expect(noAuth.status).toBe(401);

    // A token whose service scopes lack extract.admin cannot read the list.
    const forbidden = await request(baseUrl)
      .get("/v2/jobs")
      .set("Authorization", "Bearer secret-token");
    expect(forbidden.status).toBe(403);
  });
});

describe("mutations · pause / resume / cancel", () => {
  it("pauses then resumes a queued job", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;

    const paused = await request(baseUrl).post(`/v2/jobs/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("paused");

    const resumed = await request(baseUrl).post(`/v2/jobs/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("queued");
  });

  it("cancels a job and refuses to resume it afterwards", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;

    const cancelled = await request(baseUrl).post(`/v2/jobs/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");

    const resume = await request(baseUrl).post(`/v2/jobs/${id}/resume`);
    expect(resume.status).toBe(409);
  });

  it("pausing an already-paused job is an idempotent 200", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    await request(baseUrl).post(`/v2/jobs/${id}/pause`);
    const again = await request(baseUrl).post(`/v2/jobs/${id}/pause`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("paused");
  });

  it("returns 404 for a mutation on an unknown job", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl).post("/v2/jobs/00000000-0000-0000-0000-000000000000/pause");
    expect(res.status).toBe(404);
  });
});

describe("retry-failed", () => {
  it("resets only the failed units to pending and re-queues the job", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    // Job ran to completion with one failed page.
    await fakeStore.setJobStatus(id, "completed");
    await fakeStore.upsertStage("page", { job_id: id, page: 1, stage: "vision1", input_hash: "h", status: "done" });
    await fakeStore.upsertStage("page", { job_id: id, page: 2, stage: "vision1", input_hash: "h", status: "failed", error: "boom" });

    const res = await request(baseUrl).post(`/v2/jobs/${id}/retry-failed`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.retriedUnits).toBe(1);

    // The failed unit is back to pending; the done one is untouched.
    const stillFailed = await fakeStore.listStagesByStatus("page", id, "failed");
    expect(stillFailed).toHaveLength(0);
    const done = await fakeStore.listStagesByStatus("page", id, "done");
    expect(done).toHaveLength(1);
  });

  it("refuses retry on an actively running job", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    await fakeStore.setJobStatus(id, "processing");
    const res = await request(baseUrl).post(`/v2/jobs/${id}/retry-failed`);
    expect(res.status).toBe(409);
  });
});

describe("reparse", () => {
  it("flags the job for a parse-only run and re-queues it", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    await fakeStore.setJobStatus(id, "completed");

    const res = await request(baseUrl).post(`/v2/jobs/${id}/reparse`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.reparse).toBe(true);
    const config = (fakeStore.peek(id)?.config ?? {}) as Record<string, unknown>;
    expect(config.reparse).toBe(true);
  });

  it("refuses reparse while the job is still processing", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    await fakeStore.setJobStatus(id, "processing");
    const res = await request(baseUrl).post(`/v2/jobs/${id}/reparse`);
    expect(res.status).toBe(409);
  });
});

describe("GET /v2/jobs/{id}/figures", () => {
  it("lists the figure blocks of the staged page records in page order", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    const page = (n: number, blocks: unknown[]) => ({
      job_id: id,
      seq: n,
      digest: `d${n}`,
      page_from: n,
      page_to: n,
      payload: { type: "page", page: n, record: { page: n, blocks } },
    });
    await fakeStore.stageEmitBatch(page(2, [
      { id: "p2-fb1", page: 2, type: "figure", figureId: "p2-f1", kind: "chart", description: "Balken", bbox: [0.1, 0.2, 0.5, 0.6] },
    ]) as never);
    await fakeStore.stageEmitBatch(page(1, [
      { id: "p1-b1", page: 1, type: "paragraph", text: "x" },
      { id: "p1-fb1", page: 1, type: "figure", figureId: "p1-f1", kind: "photo", caption: "Abb. 1", description: "Foto" },
    ]) as never);

    const res = await request(baseUrl).get(`/ui/jobs/${id}/figures`);
    expect(res.status).toBe(200);
    expect(res.body.sourceSha256).toBe(seededSha);
    expect(res.body.figures).toEqual([
      { figureId: "p1-f1", page: 1, kind: "photo", caption: "Abb. 1", description: "Foto" },
      { figureId: "p2-f1", page: 2, bbox: [0.1, 0.2, 0.5, 0.6], kind: "chart", description: "Balken" },
    ]);
  });

  it("is a 404 for an unknown job", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl).get("/v2/jobs/00000000-0000-4000-8000-000000000000/figures");
    expect(res.status).toBe(404);
  });
});

describe("UI job overview proxy · /ui/jobs (requirement 18.6)", () => {
  it("lists jobs through the cookie-authenticated BFF path", async () => {
    const baseUrl = await buildApp();
    await createJob(baseUrl, { reference: "ui/a" });
    const res = await request(baseUrl).get("/ui/jobs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(res.body.jobs.some((j: { reference: string }) => j.reference === "ui/a")).toBe(true);
  });

  it("reads a job's detail through the BFF path", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    const res = await request(baseUrl).get(`/ui/jobs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(id);
  });

  it("creates a job through the BFF with a filename and returns the extended view", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl)
      .post("/ui/jobs")
      .set("Sec-Fetch-Site", "same-origin")
      .send({
        reference: "ui/handbuch",
        sourceSha256: seededSha,
        filename: "../../etc/Handbuch.docx",
        collection: "manuals",
        visibility: "on_commit",
        resumePolicy: "continue",
        priority: 3,
      });
    expect(res.status).toBe(201);
    // Only the basename is kept; it types the source for the runner.
    expect(res.body.sourceFilename).toBe("Handbuch.docx");
    expect(res.body.sourceSha256).toBe(seededSha);
    expect(res.body.collection).toBe("manuals");
    expect(res.body.visibility).toBe("on_commit");
    expect(res.body.resumePolicy).toBe("continue");
    expect(res.body.priority).toBe(3);

    const detail = await request(baseUrl).get(`/ui/jobs/${res.body.jobId}`);
    expect(detail.body.sourceFilename).toBe("Handbuch.docx");
  });

  it("answers 404, not 500, for an id that is not a UUID", async () => {
    const baseUrl = await buildApp();
    expect((await request(baseUrl).get("/ui/jobs/undefined")).status).toBe(404);
    const resume = await request(baseUrl)
      .post("/ui/jobs/undefined/resume")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ resumePolicy: "continue" });
    expect(resume.status).toBe(404);
  });

  it("refuses a collection name Search would reject", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl)
      .post("/ui/jobs")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ reference: "ui/x.pdf", sourceSha256: seededSha, collection: "atf-ui-smoketest" });
    expect(res.status).toBe(400);
  });

  it("refuses a cross-origin job creation", async () => {
    const baseUrl = await buildApp();
    const res = await request(baseUrl)
      .post("/ui/jobs")
      .set("Origin", "https://attacker.example")
      .send({ reference: "ui/x.pdf", sourceSha256: seededSha });
    expect(res.status).toBe(403);
  });

  it("drives a pause action through the BFF only for a same-origin request", async () => {
    const baseUrl = await buildApp();
    const id = (await createJob(baseUrl)).body.jobId;
    // Cross-origin cookie mutation is refused by the CSRF guard.
    const crossOrigin = await request(baseUrl)
      .post(`/ui/jobs/${id}/pause`)
      .set("Origin", "https://attacker.example");
    expect(crossOrigin.status).toBe(403);

    // Same-origin passes the guard and applies the action.
    const sameOrigin = await request(baseUrl)
      .post(`/ui/jobs/${id}/pause`)
      .set("Sec-Fetch-Site", "same-origin");
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body.status).toBe("paused");
  });
});

describe("auth", () => {
  it("requires a credential when auth is enabled", async () => {
    // Enable token auth; without the header, create is rejected before it runs.
    const baseUrl = await buildApp({
      AUTHN_MODE: "token",
      AUTHZ_ENABLED: "true",
      TENANT_ISOLATION_ENABLED: "false",
      API_TOKEN: "secret-token",
    });
    const noAuth = await request(baseUrl)
      .post("/v2/jobs")
      .send({ reference: "tests/handbuch.pdf", sourceSha256: seededSha });
    expect(noAuth.status).toBe(401);

    const withAuth = await request(baseUrl)
      .post("/v2/jobs")
      .set("Authorization", "Bearer secret-token")
      .send({ reference: "tests/handbuch.pdf", sourceSha256: seededSha });
    expect(withAuth.status).toBe(201);
  });
});
