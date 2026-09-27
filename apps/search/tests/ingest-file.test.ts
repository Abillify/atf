// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the binary-document route (task 1.14).
 *
 * The route no longer proxies Markdown into the local ingest path. It uploads
 * the source to Extract's content-addressed store (open → patch → complete) and
 * starts a v2 job, returning the job id. What matters here is the hand-off: the
 * upload dance is driven correctly, the credential travels, a job is created for
 * the stored source, the caller gets a 202 with the job id — and, crucially, the
 * response no longer advertises `X-Figure-Assets: not-stored`, because the job's
 * emitter now stores figure assets. Failures on the boundary are attributed to
 * the right side (a 415 is the caller's file, a 500 is Extract's problem).
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import pino from "pino";
import {
  CONVERTIBLE_MIME_TYPES,
  createIngestFileHandler,
} from "../src/handlers/ingest-file.js";
import type { ConverterConfig } from "../src/config.js";

const logger = pino({ level: "silent" });

const CONVERTER: ConverterConfig = {
  url: "http://converter.test",
  token: "converter-token",
  timeoutMs: 5_000,
  uploadLimit: "10mb",
};

const PDF = Buffer.from("%PDF-1.7\ncontent\n");
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

/** A record of every call Extract received, for assertions. */
interface ExtractCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Build an app around the handler, with a fetch fake that plays the three-step
 * upload protocol and the job creation. `overrides.on` lets a test replace the
 * response for a given step to exercise failures.
 */
function buildApp(
  overrides: Partial<ConverterConfig> = {},
  on: Partial<{
    open: () => Response;
    patch: () => Response;
    complete: () => Response;
    job: () => Response;
  }> = {},
): { app: express.Express; calls: ExtractCall[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: ExtractCall[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers as Record<string, string>) ?? {};
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, headers, body });

    if (url.endsWith("/v2/uploads") && method === "POST") {
      return on.open?.() ?? new Response(
        JSON.stringify({ status: "open", upload_id: "u-1", reference: "a", offset: 0 }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (/\/v2\/uploads\/[^/]+$/.test(url) && method === "PATCH") {
      return on.patch?.() ?? new Response(null, { status: 204, headers: { "upload-offset": String(PDF.length) } });
    }
    if (/\/v2\/uploads\/[^/]+\/complete$/.test(url) && method === "POST") {
      return on.complete?.() ?? new Response(
        JSON.stringify({ status: "completed", upload_id: "u-1", sha256: PDF_SHA, size: PDF.length }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/v2/jobs") && method === "POST") {
      return on.job?.() ?? new Response(
        JSON.stringify({ jobId: "job-123", status: "queued", reference: "a" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected call", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const app = express();
  app.use((req, _res, next) => {
    (req as Request & { log?: typeof logger }).log = logger;
    next();
  });
  app.post(
    "/ingest-file",
    express.raw({ type: [...CONVERTIBLE_MIME_TYPES], limit: "10mb" }),
    createIngestFileHandler({ converter: { ...CONVERTER, ...overrides }, logger }),
  );
  return { app, calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /ingest-file", () => {
  it("admits every extract-compatible MIME type", () => {
    expect(CONVERTIBLE_MIME_TYPES).toEqual(
      expect.arrayContaining([
        "application/msword",
        "application/vnd.ms-excel",
        "image/tiff",
        "image/bmp",
        "image/webp",
      ]),
    );
  });

  it("uploads the source (open → patch → complete) then starts a job", async () => {
    const { app, calls } = buildApp();

    const response = await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "specs/a.pdf")
      .send(PDF);

    expect(response.status).toBe(202);
    expect(response.body.job_id).toBe("job-123");
    expect(response.body.poll).toBe("/v2/jobs/job-123");

    // The four Extract calls, in order.
    expect(calls.map((c) => `${c.method} ${c.url.replace(CONVERTER.url, "")}`)).toEqual([
      "POST /v2/uploads",
      "PATCH /v2/uploads/u-1",
      "POST /v2/uploads/u-1/complete",
      "POST /v2/jobs",
    ]);

    // The open declares the reference, whole-file digest and size.
    expect(calls[0]?.body).toMatchObject({ reference: "specs/a.pdf", sha256: PDF_SHA, size: PDF.length });
    // The chunk goes to offset 0.
    expect(calls[1]?.headers["upload-offset"]).toBe("0");
    // The job is created for the stored source.
    expect(calls[3]?.body).toMatchObject({ reference: "specs/a.pdf", sourceSha256: PDF_SHA });
  });

  it("forwards the converter credential on every call", async () => {
    const { app, calls } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    for (const call of calls) {
      expect(call.headers.authorization).toBe("Bearer converter-token");
    }
  });

  it("passes the caller's collection to the job", async () => {
    const { app, calls } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Collection", "specs")
      .send(PDF);
    expect(calls[3]?.body).toMatchObject({ collection: "specs" });
  });

  it("passes title, tags, metadata, link, source and identity headers to the job", async () => {
    const { app, calls } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Title", "Pflichtenheft")
      .set("X-Tags", "kunde-a, wms")
      .set("X-Metadata", JSON.stringify({ projekt: "WMS" }))
      .set("X-Link", "https://dms.example/1")
      .set("X-Source", "DMS")
      .set("X-Version", "3.1")
      .set("X-Dedup", "exact")
      .send(PDF);
    expect(calls[3]?.body).toMatchObject({
      title: "Pflichtenheft",
      tags: ["kunde-a", "wms"],
      metadata: { projekt: "WMS" },
      link: "https://dms.example/1",
      sourceLabel: "DMS",
      version: "3.1",
      dedup: "exact",
    });
  });

  it("rejects an X-Metadata that is not a JSON object before uploading", async () => {
    const { app, fetchMock } = buildApp();
    const response = await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Metadata", "nope")
      .send(PDF);
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no longer advertises that figure assets are not stored", async () => {
    // The v2 job's emitter stores figure assets, so the old limitation header
    // must be gone.
    const { app } = buildApp();
    const response = await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(response.headers["x-figure-assets"]).toBeUndefined();
  });

  describe("validation before any work is done", () => {
    it("requires a reference, so no upload is started in vain", async () => {
      const { app, fetchMock } = buildApp();
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .send(PDF);
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/X-Reference header is required/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects an empty body with the supported list", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(Buffer.alloc(0));
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/application\/pdf/);
    });
  });

  describe("failures are attributed to the right side", () => {
    it("passes a 415 upload rejection through, because the caller's file is the problem", async () => {
      const { app, calls } = buildApp({}, {
        open: () => new Response('{"error":"Unsupported file type"}', { status: 415 }),
      });
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(415);
      // No job was created.
      expect(calls.some((c) => c.url.endsWith("/v2/jobs"))).toBe(false);
    });

    it("reports an Extract 500 on the job call as a 502", async () => {
      const { app } = buildApp({}, { job: () => new Response("boom", { status: 500 }) });
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(502);
    });

    it("reports an unreachable Extract as a 502", async () => {
      const { app } = buildApp();
      // Replace fetch entirely so even the open call throws.
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }));
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(502);
      expect(response.body.error).toMatch(/could not be reached/);
    });

    it("reports a timeout as a 504 and names the budget", async () => {
      const { app } = buildApp({ timeoutMs: 20 });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (_url: unknown, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            }),
        ),
      );
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(504);
      expect(response.body.error).toMatch(/did not respond within 20 ms/);
    });
  });

  it("omits the Authorization header when no converter token is set", async () => {
    const { app, calls } = buildApp({ token: null });
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    for (const call of calls) {
      expect(call.headers.authorization).toBeUndefined();
    }
  });
});
