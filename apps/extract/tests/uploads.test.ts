// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * uploads.test.ts
 *
 * The v2 source store and resumable upload path (task 1.4, requirements 4.13,
 * 4.14, 6.2). Three things are proven here, matching the acceptance tests the
 * task calls for:
 *
 *   1. A mid-upload abort followed by a HEAD-driven resume yields the exact
 *      bytes, and the stored source is addressed by its whole-file sha256.
 *   2. A per-chunk checksum mismatch is rejected and rolls back — the confirmed
 *      offset does not move — and a whole-file checksum mismatch at complete
 *      time is refused.
 *   3. A `source_url` pull enforces the SSRF allowlist and refuses link-local /
 *      metadata addresses, reusing the callback controls.
 *
 * The persistence layer is replaced with an in-memory fake implementing only
 * the `uploads` methods the handler touches, so the HTTP contract is exercised
 * without a database. The source store is a real filesystem one in a temp dir,
 * because content-addressing and the atomic commit are the point.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import type { ExtractStore } from "../src/persistence/index.js";
import type { UploadRow } from "../src/persistence/types.js";
import { _sessionPath, pulledFilename } from "../src/handlers/uploads.js";
import type { HostResolver, PinnedRequester } from "../src/handlers/source-url.js";
import type {
  UploadChunkCommit,
  UploadOffsetCommitter,
} from "../src/handlers/upload-session-lock.js";
import { createFilesystemSourceStore, SourceChecksumError } from "../src/source-store.js";
import { loadTestConfig, stubExtractor, stubVisionClient, testLogger } from "./helpers.js";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** An in-memory ExtractStore covering only the resumable-upload surface. */
function inMemoryStore(): ExtractStore {
  const uploads = new Map<string, UploadRow>();
  const unsupported = () => {
    throw new Error("not implemented in the in-memory upload test store");
  };
  return {
    init: async () => {},
    ping: async () => true,
    createJob: unsupported,
    getJob: unsupported,
    listJobs: unsupported,
    setJobStatus: unsupported,
    setJobPageCount: unsupported,
    setJobRevision: unsupported,
    consumeJobTokens: unsupported,
    patchJobConfig: unsupported,
    appendJobWarning: unsupported,
    requeueJob: unsupported,
    claimNextJob: unsupported,
    heartbeat: unsupported,
    getStage: unsupported,
    upsertStage: unsupported,
    listStagesByStatus: unsupported,
    nextRunnablePages: unsupported,
    finishedPageCount: unsupported,
    saveDocpassState: unsupported,
    latestDocpassState: unsupported,
    stageEmitBatch: unsupported,
    setEmitStatus: unsupported,
    updateEmitPayload: unsupported,
    pendingEmitBatches: unsupported,
    allEmitBatches: unsupported,
    stageAsset: unsupported,
    setAssetStatus: unsupported,
    allAssets: unsupported,
    async createUpload(row: Parameters<ExtractStore["createUpload"]>[0]) {
      const now = new Date();
      const upload: UploadRow = {
        upload_id: row.upload_id,
        reference: row.reference,
        expected_sha256: row.expected_sha256 ?? null,
        size: row.size ?? null,
        received_offset: 0,
        status: "open",
        created_at: now,
        updated_at: now,
      };
      uploads.set(row.upload_id, upload);
      return upload;
    },
    async getUpload(id: string) {
      return uploads.get(id) ?? null;
    },
    async updateUploadOffset(id: string, offset: number, status?: string, sha256?: string) {
      const upload = uploads.get(id);
      if (upload === undefined) return null;
      upload.received_offset = offset;
      if (status !== undefined) upload.status = status;
      if (sha256 !== undefined) upload.expected_sha256 = sha256;
      upload.updated_at = new Date();
      return upload;
    },
    withTransaction: unsupported,
    close: async () => {},
  } as unknown as ExtractStore;
}

/**
 * In-memory stand-in for the Postgres row-lock committer: re-checks the offset
 * under a per-session flag, appends, then advances — the same contract as
 * `createPgUploadOffsetCommitter`. `beforeCommit` lets a test move the session
 * "on another replica" between the handler's read and the commit.
 */
function inMemoryCommitter(
  store: ExtractStore,
  hooks: { beforeCommit?: (uploadId: string) => Promise<void> } = {},
): UploadOffsetCommitter & { appends: number } {
  const locked = new Set<string>();
  const committer = {
    appends: 0,
    async commitChunk({ uploadId, expectedOffset, newOffset, append }: UploadChunkCommit) {
      await hooks.beforeCommit?.(uploadId);
      if (locked.has(uploadId)) throw new Error("row already locked");
      locked.add(uploadId);
      try {
        const current = await store.getUpload(uploadId);
        if (
          current === null ||
          current.status !== "open" ||
          Number(current.received_offset) !== expectedOffset
        ) {
          return { status: "conflict" as const, current };
        }
        await append();
        committer.appends++;
        const row = await store.updateUploadOffset(uploadId, newOffset);
        if (row === null) throw new Error("vanished");
        return { status: "committed" as const, row };
      } finally {
        locked.delete(uploadId);
      }
    },
  };
  return committer;
}

/** A resolver answering every host with one public documentation address. */
const publicResolver: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

let storeDir: string;
let tmpUploadDir: string;

const cleanups: Array<() => void> = [];

function buildApp(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
) {
  const config = loadTestConfig({
    SOURCE_STORE_DIR: storeDir,
    UPLOAD_TMP_DIR: tmpUploadDir,
    ...configOverrides,
  });
  const store = overrides.store ?? inMemoryStore();
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    sourceStore: createFilesystemSourceStore(storeDir),
    sourceUrlResolver: publicResolver,
    ...overrides,
    store,
    ...(store !== null
      ? { uploadOffsetCommitter: overrides.uploadOffsetCommitter ?? inMemoryCommitter(store) }
      : {}),
  });
  cleanups.push(created.cleanup);
  return created.app;
}

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "atf-src-store-"));
  tmpUploadDir = await mkdtemp(join(tmpdir(), "atf-upload-tmp-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  await rm(storeDir, { recursive: true, force: true });
  await rm(tmpUploadDir, { recursive: true, force: true });
});

// ─── SourceStore unit tests ──────────────────────────────────────────────────

describe("SourceStore (filesystem, content-addressed)", () => {
  it("stores bytes at a path derived from the sha256 and dedupes a re-put", async () => {
    const store = createFilesystemSourceStore(storeDir);
    const bytes = Buffer.from("a durable source document");
    const digest = sha256Hex(bytes);

    const first = await store.putStream(toStream(bytes));
    expect(first.sha256).toBe(digest);
    expect(first.deduped).toBe(false);
    expect(first.path).toContain(digest.slice(0, 2));
    expect(await readFile(first.path)).toEqual(bytes);

    const second = await store.putStream(toStream(bytes));
    expect(second.sha256).toBe(digest);
    expect(second.deduped).toBe(true);
    expect(second.path).toBe(first.path);

    expect(await store.has(digest)).toBe(true);
    expect(await store.locate(digest)).toBe(first.path);
  });

  it("rejects a putStream whose bytes do not match the expected digest", async () => {
    const store = createFilesystemSourceStore(storeDir);
    const wrong = sha256Hex(Buffer.from("something else"));
    await expect(
      store.putStream(toStream(Buffer.from("real bytes")), { expected: wrong }),
    ).rejects.toBeInstanceOf(SourceChecksumError);
    expect(await store.has(wrong)).toBe(false);
  });

  it("enforces the byte ceiling mid-stream", async () => {
    const store = createFilesystemSourceStore(storeDir);
    await expect(
      store.putStream(toStream(Buffer.alloc(1024, 1)), { maxBytes: 512 }),
    ).rejects.toThrow(/limit/);
  });
});

// ─── Console BFF: /ui/uploads ────────────────────────────────────────────────

describe("/ui/uploads · console upload path", () => {
  it("runs open → PATCH → HEAD → complete through the cookie BFF", async () => {
    const app = buildApp();
    const whole = Buffer.from("console upload bytes");
    const chunkA = whole.subarray(0, 7);
    const chunkB = whole.subarray(7);

    const open = await request(app)
      .post("/ui/uploads")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ reference: "ui/source.pdf", size: whole.length });
    expect(open.status).toBe(201);
    const id: string = open.body.upload_id;

    const first = await request(app)
      .patch(`/ui/uploads/${id}`)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Content-Type", "application/offset+octet-stream")
      .set("Upload-Offset", "0")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(chunkA))
      .send(chunkA);
    expect(first.status).toBe(204);

    const head = await request(app).head(`/ui/uploads/${id}`).set("Sec-Fetch-Site", "same-origin");
    expect(head.status).toBe(200);
    expect(head.headers["upload-offset"]).toBe(String(chunkA.length));

    const second = await request(app)
      .patch(`/ui/uploads/${id}`)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Content-Type", "application/offset+octet-stream")
      .set("Upload-Offset", head.headers["upload-offset"] as string)
      .send(chunkB);
    expect(second.status).toBe(204);

    const done = await request(app)
      .post(`/ui/uploads/${id}/complete`)
      .set("Sec-Fetch-Site", "same-origin")
      .send({});
    expect(done.status).toBe(200);
    expect(done.body.sha256).toBe(sha256Hex(whole));
  });

  it("completes a declared-size session when the store returns BIGINTs as strings", async () => {
    // node-postgres hands BIGINT columns back as strings; `size` must still
    // compare equal to the confirmed offset.
    const base = inMemoryStore();
    const pgShaped = {
      ...base,
      async getUpload(id: string) {
        const row = await base.getUpload(id);
        return row === null
          ? null
          : ({ ...row, size: row.size === null ? null : String(row.size), received_offset: String(row.received_offset) } as unknown as UploadRow);
      },
    } as ExtractStore;
    const app = buildApp({}, { store: pgShaped });
    const whole = Buffer.from("bigint shaped upload");

    const open = await request(app)
      .post("/ui/uploads")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ reference: "ui/bigint.pdf", size: whole.length });
    const id: string = open.body.upload_id;
    const patch = await request(app)
      .patch(`/ui/uploads/${id}`)
      .set("Sec-Fetch-Site", "same-origin")
      .set("Content-Type", "application/offset+octet-stream")
      .set("Upload-Offset", "0")
      .send(whole);
    expect(patch.status).toBe(204);

    const done = await request(app)
      .post(`/ui/uploads/${id}/complete`)
      .set("Sec-Fetch-Site", "same-origin")
      .send({});
    expect(done.status).toBe(200);
    expect(done.body.sha256).toBe(sha256Hex(whole));

    // No digest was declared; a repeated complete still answers idempotently.
    const again = await request(app)
      .post(`/ui/uploads/${id}/complete`)
      .set("Sec-Fetch-Site", "same-origin")
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.sha256).toBe(sha256Hex(whole));
  });

  it("refuses a cross-origin session open", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/ui/uploads")
      .set("Origin", "https://attacker.example")
      .send({ reference: "ui/source.pdf" });
    expect(res.status).toBe(403);
  });
});

// ─── Resumable upload: abort mid-upload and resume via HEAD ──────────────────

describe("POST/PATCH/HEAD/complete · resumable upload", () => {
  it("resumes from the HEAD-reported offset after a mid-upload abort", async () => {
    const app = buildApp();
    const whole = Buffer.from("0123456789abcdefghij"); // 20 bytes
    const wholeDigest = sha256Hex(whole);
    const chunkA = whole.subarray(0, 8);
    const chunkB = whole.subarray(8, 20);

    // Open a session, declaring the whole-file digest and size up front.
    const open = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/big.pdf")
      .send({ sha256: wholeDigest, size: whole.length });
    expect(open.status).toBe(201);
    expect(open.body.status).toBe("open");
    expect(open.body.offset).toBe(0);
    const id: string = open.body.upload_id;

    // First chunk at offset 0.
    const patchA = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(chunkA))
      .send(chunkA);
    expect(patchA.status).toBe(204);
    expect(patchA.headers["upload-offset"]).toBe("8");

    // Simulate an abort: the client lost track and asks HEAD where to resume.
    const head = await request(app).head(`/v2/uploads/${id}`);
    expect(head.status).toBe(200);
    expect(head.headers["upload-offset"]).toBe("8");
    expect(head.headers["upload-status"]).toBe("open");

    // A wrong offset must not silently misplace bytes — it is a 409.
    const wrongOffset = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .send(chunkB);
    expect(wrongOffset.status).toBe(409);
    expect(wrongOffset.headers["upload-offset"]).toBe("8");

    // Resume at the confirmed offset.
    const patchB = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "8")
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(chunkB))
      .send(chunkB);
    expect(patchB.status).toBe(204);
    expect(patchB.headers["upload-offset"]).toBe("20");

    // Complete: the whole-file digest verifies and the source is stored.
    const complete = await request(app).post(`/v2/uploads/${id}/complete`).send({});
    expect(complete.status).toBe(200);
    expect(complete.body.status).toBe("completed");
    expect(complete.body.sha256).toBe(wholeDigest);

    // The stored bytes are exactly the original document.
    const store = createFilesystemSourceStore(storeDir);
    const path = await store.locate(wholeDigest);
    expect(path).not.toBeNull();
    expect(await readFile(path as string)).toEqual(whole);
  });

  it("is idempotent: re-completing a finished session returns the same digest", async () => {
    const app = buildApp();
    const whole = Buffer.from("idempotent-source");
    const digest = sha256Hex(whole);
    const open = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/x.pdf")
      .send({ sha256: digest, size: whole.length });
    const id: string = open.body.upload_id;
    await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .send(whole);
    const first = await request(app).post(`/v2/uploads/${id}/complete`).send({});
    expect(first.status).toBe(200);
    const second = await request(app).post(`/v2/uploads/${id}/complete`).send({});
    expect(second.status).toBe(200);
    expect(second.body.sha256).toBe(digest);
  });
});

// ─── Checksum failures ───────────────────────────────────────────────────────

describe("checksum enforcement", () => {
  it("rejects a per-chunk checksum mismatch and leaves the offset unmoved", async () => {
    const app = buildApp();
    const chunk = Buffer.from("this chunk is fine");
    const open = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/c.pdf")
      .send({});
    const id: string = open.body.upload_id;

    const bad = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(Buffer.from("a different chunk")))
      .send(chunk);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");

    // The offset was rolled back to 0, so the client can re-send.
    const head = await request(app).head(`/v2/uploads/${id}`);
    expect(head.headers["upload-offset"]).toBe("0");

    // Re-sending with the right checksum succeeds at the same offset.
    const good = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(chunk))
      .send(chunk);
    expect(good.status).toBe(204);
    expect(good.headers["upload-offset"]).toBe(String(chunk.length));
  });

  it("refuses a whole-file checksum mismatch at complete time", async () => {
    const app = buildApp();
    const whole = Buffer.from("the actual bytes");
    const lie = sha256Hex(Buffer.from("not these bytes"));
    const open = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/m.pdf")
      .send({ sha256: lie, size: whole.length });
    const id: string = open.body.upload_id;
    await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .send(whole);
    const complete = await request(app).post(`/v2/uploads/${id}/complete`).send({});
    expect(complete.status).toBe(400);
    expect(complete.body.code).toBe("VALIDATION_FAILED");
    // The corrupted source was never committed to the store.
    const store = createFilesystemSourceStore(storeDir);
    expect(await store.has(lie)).toBe(false);
  });
});

// ─── source_url SSRF allowlist ───────────────────────────────────────────────

describe("source_url pull · SSRF protection", () => {
  it("refuses a link-local / metadata address regardless of allowlist", async () => {
    const app = buildApp();
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      const res = await request(app)
        .post("/v2/uploads")
        .set("X-Reference", "tests/pull.pdf")
        .send({ source_url: url });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
  });

  it("refuses a host outside SOURCE_URL_ALLOWED_HOSTS", async () => {
    const app = buildApp({ SOURCE_URL_ALLOWED_HOSTS: "storage.example.com" });
    const res = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "https://evil.example.net/doc.pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SOURCE_URL_ALLOWED_HOSTS/);
  });

  it("refuses a non-http(s) scheme and a URL with credentials", async () => {
    const app = buildApp();
    const scheme = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "file:///etc/passwd" });
    expect(scheme.status).toBe(400);

    const creds = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "https://user:pass@storage.example.com/doc.pdf" });
    expect(creds.status).toBe(400);
  });

  it("pulls an allowlisted source and stores it content-addressed", async () => {
    const body = Buffer.from("%PDF-1.7\npulled source\n");
    const digest = sha256Hex(body);
    const calls: Array<{ url: string; address: string }> = [];
    const app = buildApp(
      { SOURCE_URL_ALLOWED_HOSTS: "storage.example.com" },
      { sourceUrlRequest: fakeRequester(calls, () => okResponse(body)) },
    );
    const res = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "https://storage.example.com/doc.pdf", sha256: digest });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("completed");
    expect(res.body.sha256).toBe(digest);
    // The request was pinned to the address the resolver validated.
    expect(calls).toEqual([
      { url: "https://storage.example.com/doc.pdf", address: "93.184.216.34" },
    ]);
    const store = createFilesystemSourceStore(storeDir);
    const stored = await store.locate(digest);
    expect(stored).not.toBeNull();
    expect(await readFile(stored as string)).toEqual(body);
  });
  it("rejects a pulled body whose sha256 does not match the declared one", async () => {
    const body = Buffer.from("pulled but wrong");
    const lie = sha256Hex(Buffer.from("expected something else"));
    const app = buildApp(
      { SOURCE_URL_ALLOWED_HOSTS: "storage.example.com" },
      { sourceUrlRequest: fakeRequester([], () => okResponse(body)) },
    );
    const res = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "https://storage.example.com/doc.pdf", sha256: lie });
    expect(res.status).toBe(400);
  });
  it("refuses literal private, loopback, CGNAT and mapped addresses", async () => {
    const calls: Array<{ url: string; address: string }> = [];
    const app = buildApp({}, { sourceUrlRequest: fakeRequester(calls, () => okResponse(Buffer.from("x"))) });
    for (const url of [
      "http://127.0.0.1/doc.pdf",
      "http://10.1.2.3/doc.pdf",
      "http://172.20.0.5/doc.pdf",
      "http://192.168.1.10/doc.pdf",
      "http://100.64.0.1/doc.pdf",
      "http://0.0.0.0/doc.pdf",
      "http://[::1]/doc.pdf",
      "http://[fd00::1]/doc.pdf",
      "http://[fe80::1]/doc.pdf",
      "http://[::ffff:127.0.0.1]/doc.pdf",
      "http://[::ffff:10.0.0.1]/doc.pdf",
    ]) {
      const res = await request(app)
        .post("/v2/uploads")
        .set("X-Reference", "tests/pull.pdf")
        .send({ source_url: url });
      expect(res.status, url).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
    expect(calls).toEqual([]);
  });
  it("refuses an allowlisted host whose DNS answer contains a private address", async () => {
    const calls: Array<{ url: string; address: string }> = [];
    const app = buildApp(
      { SOURCE_URL_ALLOWED_HOSTS: "storage.example.com" },
      {
        sourceUrlResolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ],
        sourceUrlRequest: fakeRequester(calls, () => okResponse(Buffer.from("x"))),
      },
    );
    const res = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "https://storage.example.com/doc.pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolves to a private/);
    expect(calls).toEqual([]);
  });
  it("re-resolves every redirect hop and refuses a rebinding to a private address", async () => {
    const calls: Array<{ url: string; address: string }> = [];
    const answers = new Map<string, string>([
      ["storage.example.com", "93.184.216.34"],
      ["cdn.example.com", "169.254.169.254"],
    ]);
    const app = buildApp(
      {},
      {
        sourceUrlResolver: async (host) => [{ address: answers.get(host) ?? "203.0.113.9", family: 4 }],
        sourceUrlRequest: fakeRequester(calls, () =>
          redirectResponse("https://cdn.example.com/doc.pdf"),
        ),
      },
    );
    const res = await request(app)
      .post("/v2/uploads")
      .set("X-Reference", "tests/pull.pdf")
      .send({ source_url: "https://storage.example.com/doc.pdf" });
    expect(res.status).toBe(400);
    // Only the first hop was ever connected; the redirect target was refused
    // after its own DNS check, before any connection.
    expect(calls).toEqual([
      { url: "https://storage.example.com/doc.pdf", address: "93.184.216.34" },
    ]);
  });
});
// ─── concurrent PATCH / checksum-before-write ────────────────────────────────
describe("PATCH serialisation and checksum-before-write", () => {
  async function openSession(app: ReturnType<typeof buildApp>): Promise<string> {
    const open = await request(app).post("/v2/uploads").set("X-Reference", "tests/p.pdf").send({});
    expect(open.status).toBe(201);
    return open.body.upload_id as string;
  }
  it("refuses a second PATCH on the same session while one is in flight", async () => {
    const memory = inMemoryStore();
    let entered!: () => void;
    const firstInCommit = new Promise<void>((resolve) => (entered = resolve));
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const committer = inMemoryCommitter(memory, {
      beforeCommit: async () => {
        entered();
        await gate;
      },
    });
    const app = buildApp({}, { store: memory, uploadOffsetCommitter: committer });
    const id = await openSession(app);
    const chunk = Buffer.from("first chunk bytes");
    const patch = () =>
      request(app)
        .patch(`/v2/uploads/${id}`)
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(chunk);
    // The first PATCH is parked inside the commit, holding the session lock.
    const first = patch().then((res) => res);
    await firstInCommit;
    const second = await patch();
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/in progress/);
    unblock();
    expect((await first).status).toBe(204);
    const head = await request(app).head(`/v2/uploads/${id}`);
    expect(head.headers["upload-offset"]).toBe(String(chunk.length));
    // The session file holds the chunk exactly once.
    expect(await readFile(_sessionPath(tmpUploadDir, id))).toEqual(chunk);
    expect(committer.appends).toBe(1);
  });
  it("never writes a chunk with a bad checksum into the session file", async () => {
    const memory = inMemoryStore();
    const committer = inMemoryCommitter(memory);
    const app = buildApp({}, { store: memory, uploadOffsetCommitter: committer });
    const id = await openSession(app);
    const bad = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(Buffer.from("other")))
      .send(Buffer.from("payload"));
    expect(bad.status).toBe(400);
    // The committer (and so the append) was never reached.
    expect(committer.appends).toBe(0);
    expect((await stat(_sessionPath(tmpUploadDir, id))).size).toBe(0);
    // No scratch chunk file is left behind.
    expect((await readdir(tmpUploadDir)).filter((f) => f.endsWith(".chunk"))).toEqual([]);
  });
  it("answers 409 without appending when another replica moved the offset", async () => {
    const memory = inMemoryStore();
    const committer = inMemoryCommitter(memory, {
      // Simulate a different replica confirming 5 bytes between this PATCH's
      // read of the session and its commit.
      beforeCommit: async (uploadId) => {
        await memory.updateUploadOffset(uploadId, 5);
      },
    });
    const app = buildApp({}, { store: memory, uploadOffsetCommitter: committer });
    const id = await openSession(app);
    const res = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("late chunk"));
    expect(res.status).toBe(409);
    expect(res.headers["upload-offset"]).toBe("5");
    expect(committer.appends).toBe(0);
    expect((await stat(_sessionPath(tmpUploadDir, id))).size).toBe(0);
  });
  it("drops a torn tail left by a crashed append before appending", async () => {
    const app = buildApp();
    const id = await openSession(app);
    const first = Buffer.from("AAAA");
    await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .send(first);
    // A crash after writing but before the offset advance leaves garbage.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(_sessionPath(tmpUploadDir, id), "garbage");
    const second = Buffer.from("BBBB");
    const res = await request(app)
      .patch(`/v2/uploads/${id}`)
      .set("Upload-Offset", "4")
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Checksum-Sha256", sha256Hex(second))
      .send(second);
    expect(res.status).toBe(204);
    expect(await readFile(_sessionPath(tmpUploadDir, id))).toEqual(Buffer.from("AAAABBBB"));
  });
});
// ─── helpers ─────────────────────────────────────────────────────────────────

/** A Node Readable emitting the whole buffer in one chunk. */
function toStream(buf: Buffer): Readable {
  return Readable.from([buf]);
}

/** A 200 response streaming `body`, for a fake pinned requester. */
function okResponse(body: Buffer) {
  return {
    status: 200,
    header: (name: string) =>
      name.toLowerCase() === "content-length" ? String(body.length) : undefined,
    body: Readable.from([body]),
  };
}
/** A 302 response pointing at `location`. */
function redirectResponse(location: string) {
  return {
    status: 302,
    header: (name: string) => (name.toLowerCase() === "location" ? location : undefined),
    body: Readable.from([]),
  };
}
/** A pinned requester that records (url, pinned address) and serves `respond()`. */
function fakeRequester(
  calls: Array<{ url: string; address: string }>,
  respond: () => ReturnType<typeof okResponse>,
): PinnedRequester {
  return async (url, pinned) => {
    calls.push({ url: url.toString(), address: pinned.address });
    return respond();
  };
}

describe("pulledFilename", () => {
  it("keeps a URL filename that carries an extension", () => {
    expect(pulledFilename("https://example.com/docs/Handbuch%20v2.pdf", "application/octet-stream")).toBe("Handbuch v2.pdf");
  });
  it("types an extensionless URL from a supported Content-Type", () => {
    expect(pulledFilename("https://example.com/wiki/seite", "text/html; charset=utf-8")).toBe("seite.html");
    expect(pulledFilename("https://example.com/", "application/pdf")).toBe("source.pdf");
  });
  it("gives up when neither the URL nor the type says anything", () => {
    expect(pulledFilename("https://example.com/download", "application/octet-stream")).toBeUndefined();
    expect(pulledFilename("https://example.com/download", undefined)).toBeUndefined();
  });
});
