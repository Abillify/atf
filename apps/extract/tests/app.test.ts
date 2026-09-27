// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests over the real middleware chain.
 *
 * The extractor is stubbed in most cases, because the point here is the HTTP
 * contract: which header selects which response mode, what the error taxonomy
 * produces, and that the browser boundary and the machine boundary accept
 * different credentials. The pipeline itself is exercised end to end in
 * `pipeline.test.ts`, which uses a PNG so it needs no external binaries.
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { serializeDocument } from "@atf/extract-contract/v1";
import { createApp, type AppOverrides } from "../src/index.js";
import type { Config } from "../src/config.js";
import { QueueSaturatedError } from "../src/queue.js";
import { visionUnavailable } from "../src/errors.js";
import {
  loadTestConfig,
  stubExtractor,
  stubSearchClient,
  stubVisionClient,
  testCrop,
  testDocument,
  testFigure,
  testLogger,
  testPage,
  type RecordingSearchClient,
} from "./helpers.js";

const PDF_BYTES = Buffer.from("%PDF-1.7\ncontent\n");

/** Health probes must not spawn LibreOffice during a unit test. */
const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

function buildApp(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
): { app: ReturnType<typeof createApp>["app"]; cleanup: () => void; config: Config } {
  const config = loadTestConfig(configOverrides);
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    ...overrides,
  });
  return { ...created, config };
}

interface CallbackReceiver {
  /** Base URL, e.g. `http://127.0.0.1:12345`. */
  url: string;
  /** Request bodies in arrival order. */
  received: string[];
  /** With `hold`, answer the oldest held request with 204. */
  releaseNext: () => void;
  close: () => Promise<void>;
}

/** A loopback HTTP server that records callback bodies (optionally holding responses). */
async function startCallbackReceiver(options: { hold?: boolean } = {}): Promise<CallbackReceiver> {
  const received: string[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf-8"));
      if (options.hold) {
        held.push(res);
      } else {
        res.statusCode = 204;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    releaseNext: () => {
      const res = held.shift();
      if (res) {
        res.statusCode = 204;
        res.end();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of held.splice(0)) res.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function app(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
): ReturnType<typeof createApp>["app"] {
  const built = buildApp(configOverrides, overrides);
  cleanups.push(built.cleanup);
  return built.app;
}

describe("GET /health", () => {
  it("is reachable without a credential", async () => {
    const response = await request(app({ AUTHN_MODE: "token", API_TOKEN: "t".repeat(40) })).get(
      "/health",
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.contract).toBe("atf-extract/1.1.0");
  });

  it("reports the queue and the pipeline settings", async () => {
    const response = await request(app({ RENDER_DPI: "150", FIGURE_DPI: "300", MAX_PAGES: "50" })).get(
      "/health",
    );
    expect(response.body.queue).toMatchObject({ active: 0, depth: 0, concurrency: 2 });
    expect(response.body.pipeline).toMatchObject({
      render_dpi: 150,
      figure_dpi: 300,
      max_pages: 50,
    });
  });

  it("is unhealthy when the vision endpoint is down", async () => {
    // A container that cannot reach its model cannot convert anything.
    const response = await request(app({}, { vision: stubVisionClient(false) })).get("/health");
    expect(response.status).toBe(503);
    expect(response.body.dependencies.vision.available).toBe(false);
  });

  it("is unhealthy when poppler is missing", async () => {
    const missing = vi.fn(async (command: string) =>
      command.includes("pdf")
        ? { available: false, error: "ENOENT" }
        : { available: true, version: "stub" },
    );
    const response = await request(app({}, { probeBinary: missing })).get("/health");
    expect(response.status).toBe(503);
    expect(response.body.dependencies.poppler.pdfinfo.available).toBe(false);
  });

  it("degrades rather than fails when only LibreOffice is missing", async () => {
    // LibreOffice is needed for all Word and spreadsheet formats; PDFs and images still work.
    const missing = vi.fn(async (command: string) =>
      command.includes("libreoffice")
        ? { available: false, error: "ENOENT" }
        : { available: true, version: "stub" },
    );
    const response = await request(app({}, { probeBinary: missing })).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.degraded_formats).toEqual(["doc", "docx", "xls", "xlsx"]);
    expect(response.body.supported_types).not.toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.body.supported_types).not.toContain("application/msword");
    expect(response.body.supported_types).not.toContain("application/vnd.ms-excel");
  });

  it("stays healthy when only Search is unreachable", async () => {
    // Taking the container out of rotation because a downstream service is down
    // turns one outage into two.
    const search: RecordingSearchClient = {
      ...stubSearchClient(),
      probe: async () => ({ available: false, error: "connection refused" }),
    };
    const response = await request(
      app({ SEARCH_URL: "http://search.test", SEARCH_TOKEN: "s" }, { searchClient: search }),
    ).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.dependencies.search.available).toBe(false);
  });
});

describe("GET /openapi.json", () => {
  it("is served without a credential so tooling can read it", async () => {
    const response = await request(app({ AUTHN_MODE: "token", API_TOKEN: "t".repeat(40) })).get(
      "/openapi.json",
    );
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.1.0");
    expect(response.body.paths).toHaveProperty("/v1/convert");
  });

  it("omits the ingest path when Search is not configured", async () => {
    const response = await request(app()).get("/openapi.json");
    expect(response.body.paths).not.toHaveProperty("/v1/ingest");
  });

  it("documents the ingest path when Search is configured", async () => {
    const response = await request(
      app({ SEARCH_URL: "http://search.test" }, { searchClient: stubSearchClient() }),
    ).get("/openapi.json");
    expect(response.body.paths).toHaveProperty("/v1/ingest");
  });
});

describe("POST /v1/convert", () => {
  it("accepts a raw body with the document's own Content-Type", async () => {
    const response = await request(app())
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "docs/a.pdf")
      .send(PDF_BYTES);

    expect(response.status).toBe(200);
    expect(response.body.contract).toBe("atf-extract/1.1.0");
    expect(response.body.reference).toBe("docs/a.pdf");
    expect(response.body.markdown).toContain("## Seite 1");
    expect(response.headers["x-extract-contract"]).toBe("atf-extract/1.1.0");
    expect(response.headers["x-page-count"]).toBe("2");
  });

  it("accepts multipart/form-data, which is what the UI sends", async () => {
    const response = await request(app())
      .post("/v1/convert")
      .field("unused", "x")
      .attach("document", PDF_BYTES, { filename: "spec.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(200);
    expect(response.body.pageCount).toBe(2);
  });

  it("returns Markdown for Accept: text/markdown", async () => {
    // This is the shape Search's /ingest-file proxy forwards.
    const response = await request(app())
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("Accept", "text/markdown")
      .send(PDF_BYTES);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/markdown/);
    expect(response.text).toContain("## Seite 1");
    expect(response.text).toContain("<summary>");
  });

  it("defaults the reference to the filename", async () => {
    const seen: string[] = [];
    const response = await request(
      app({}, { extractor: stubExtractor({ onExtract: (input) => seen.push(input.reference) }) }),
    )
      .post("/v1/convert")
      .attach("document", PDF_BYTES, { filename: "bericht.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(200);
    expect(seen).toEqual(["bericht.pdf"]);
  });

  it("omits figure bytes unless they are asked for", async () => {
    const document = testDocument({ pages: [testPage(1, { figures: [testFigure(1, 1)] })] });
    const crops = new Map([["p1-f1", testCrop()]]);

    const withoutData = await request(app({}, { extractor: stubExtractor({ document, crops }) }))
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/handbuch.pdf")
      .send(PDF_BYTES);
    expect(withoutData.body.pages[0].figures[0].dataBase64).toBeUndefined();

    const withData = await request(app({}, { extractor: stubExtractor({ document, crops }) }))
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/handbuch.pdf")
      .set("X-Include-Figure-Data", "true")
      .send(PDF_BYTES);
    expect(withData.body.pages[0].figures[0].dataBase64).toBeTypeOf("string");
  });

  it("rejects an empty request with a usable message", async () => {
    const response = await request(app())
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(Buffer.alloc(0));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(response.body.error).toMatch(/Supported formats/);
  });

  it("rejects a malformed X-Include-Figure-Data", async () => {
    const response = await request(app())
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("X-Include-Figure-Data", "perhaps")
      .send(PDF_BYTES);
    expect(response.status).toBe(400);
  });

  it("refuses an upload over the limit", async () => {
    const response = await request(app({ MAX_UPLOAD_BYTES: "2048" }))
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(Buffer.alloc(4096, 0x41));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("maps a vision failure to 502 and marks it retryable", async () => {
    const response = await request(
      app({}, { extractor: stubExtractor({ error: visionUnavailable("model down") }) }),
    )
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(response.status).toBe(502);
    expect(response.body.code).toBe("VISION_UNAVAILABLE");
    expect(response.body.retryable).toBe(true);
    // The internal message stays in the log; the client gets an id to quote.
    expect(response.body.detail).toBeUndefined();
    expect(response.body.errorId).toBeTypeOf("string");
  });

  it("exposes the internal message only when explicitly configured", async () => {
    const response = await request(
      app(
        { EXPOSE_ERROR_DETAIL: "true" },
        { extractor: stubExtractor({ error: visionUnavailable("model down at /tmp/x") }) },
      ),
    )
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.body.detail).toContain("model down");
  });

  it("answers 503 with Retry-After when the queue is full", async () => {
    const saturated = {
      submit: async () => {
        throw new QueueSaturatedError({ depth: 4, active: 2, concurrency: 2, maxDepth: 4 });
      },
      state: () => ({ depth: 4, active: 2, concurrency: 2, maxDepth: 4 }),
    };
    const response = await request(app({}, { queue: saturated }))
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("QUEUE_SATURATED");
    expect(response.headers["retry-after"]).toBe("30");
  });

  describe("server-sent events", () => {
    it("streams a frame per page and then the envelope", async () => {
      const response = await request(app())
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("Accept", "text/event-stream")
        .send(PDF_BYTES);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/event-stream/);
      // Without this nginx buffers the whole stream, defeating the mode.
      expect(response.headers["x-accel-buffering"]).toBe("no");

      const events = response.text.split("\n\n").filter((frame) => frame.trim() !== "");
      const names = events.map((frame) => /^event: (\S+)/m.exec(frame)?.[1]);
      expect(names).toEqual(["accepted", "queued", "converting", "progress", "progress", "done"]);

      const progressFrame = events.find((frame) => frame.includes("event: progress")) ?? "";
      const firstProgress = JSON.parse(/^data: (.*)$/m.exec(progressFrame)?.[1] ?? "{}");
      expect(firstProgress.page).toBe(1);
      expect(firstProgress.pageCount).toBe(2);
      expect(firstProgress.total).toBe(2);
      expect(firstProgress.tokens).toEqual({ prompt: 1, completion: 2, total: 3 });
      expect(firstProgress.etaSeconds).not.toBeUndefined();
      // The serialized page, so a client can append it verbatim.
      expect(firstProgress.markdown).toContain("## Seite 1");
    });

    it("reports a failure as an error frame rather than a broken stream", async () => {
      const response = await request(
        app({}, { extractor: stubExtractor({ error: visionUnavailable("model down") }) }),
      )
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("Accept", "text/event-stream")
        .send(PDF_BYTES);

      expect(response.status).toBe(200);
      expect(response.text).toContain("event: error");
      expect(response.text).toContain("VISION_UNAVAILABLE");
    });
  });

  describe("asynchronous delivery", () => {
    // Delivery resolves the host and connects to the pinned, validated address
    // over node:http, so the receiver is a real loopback server. Loopback is
    // only reachable because the test allow-lists it explicitly.
    let receiver: CallbackReceiver | undefined;
    afterEach(async () => {
      await receiver?.close();
      receiver = undefined;
    });

    it("returns 202 and posts the result to the callback", async () => {
      receiver = await startCallbackReceiver();

      const response = await request(app({ CALLBACK_ALLOWED_HOSTS: "127.0.0.1" }))
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("X-Callback-URL", `${receiver.url}/done`)
        .send(PDF_BYTES);

      expect(response.status).toBe(202);
      expect(response.body.status).toBe("accepted");
      expect(response.body.job_id).toBeTypeOf("string");

      // Delivery is detached from the response, so wait for the microtask chain.
      const received = receiver.received;
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
      const delivered = JSON.parse(received[0] ?? "");
      expect(delivered.status).toBe("completed");
      expect(delivered.markdown).toContain("## Seite 1");
    });

    it("refuses a loopback callback that is not allow-listed", async () => {
      receiver = await startCallbackReceiver();
      const response = await request(app())
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("X-Callback-URL", `${receiver.url}/done`)
        .send(PDF_BYTES);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/private, loopback or reserved/);
      expect(receiver.received).toHaveLength(0);
    });

    it("emits extract-compatible progress callbacks when explicitly enabled", async () => {
      receiver = await startCallbackReceiver();

      const response = await request(app({ CALLBACK_ALLOWED_HOSTS: "127.0.0.1" }))
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("X-Callback-URL", `${receiver.url}/done`)
        .set("X-Callback-Events", "extract")
        .send(PDF_BYTES);

      expect(response.status).toBe(202);
      const received = receiver.received;
      await vi.waitFor(() => {
        const payload = JSON.parse(received.at(-1) ?? "{}");
        expect(payload.status).toBe("completed");
      });
      const payloads = received.map((body) => JSON.parse(body));
      expect(payloads[0]).toMatchObject({
        type: "queued",
        jobId: response.body.job_id,
        job_id: response.body.job_id,
      });
      expect(payloads.at(-1)).toMatchObject({
        status: "completed",
        job_id: response.body.job_id,
      });
      const progressPayloads = payloads.filter((payload) => payload.type === "progress");
      expect(progressPayloads).toHaveLength(1);
      expect(progressPayloads[0]).toMatchObject({
        page: 2,
        pageCount: 2,
        tokens: { prompt: 2, completion: 4, total: 6 },
        jobId: response.body.job_id,
        job_id: response.body.job_id,
      });
    });

    it("coalesces progress when a callback receiver is slow", async () => {
      // The receiver holds every response until the test releases it.
      receiver = await startCallbackReceiver({ hold: true });

      const response = await request(app({ CALLBACK_ALLOWED_HOSTS: "127.0.0.1" }))
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("X-Callback-URL", `${receiver.url}/done`)
        .set("X-Callback-Events", "extract")
        .send(PDF_BYTES);

      expect(response.status).toBe(202);
      const { received, releaseNext } = receiver;
      await vi.waitFor(() => expect(received).toHaveLength(1));
      releaseNext();
      await vi.waitFor(() => expect(received).toHaveLength(2));
      releaseNext();
      await vi.waitFor(() => expect(received).toHaveLength(3));

      const terminal = JSON.parse(received[2] ?? "{}");
      expect(terminal.status).toBe("completed");
      releaseNext();
    });

    it("refuses a callback outside the allow-list before doing any work", async () => {
      const response = await request(app({ CALLBACK_ALLOWED_HOSTS: "hooks.test" }))
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("X-Callback-URL", "http://attacker.test/collect")
        .send(PDF_BYTES);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not in CALLBACK_ALLOWED_HOSTS/);
    });

    it("refuses a metadata address even with an open allow-list", async () => {
      const response = await request(app())
        .post("/v1/convert")
        .set("Content-Type", "application/pdf")
        .set("X-Callback-URL", "http://169.254.169.254/latest/meta-data/")
        .send(PDF_BYTES);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/link-local or metadata address/);
    });
  });
});

describe("POST /v1/ingest", () => {
  const searchEnv = { SEARCH_URL: "http://search.test", SEARCH_TOKEN: "s", SEARCH_COLLECTION: "specs" };

  it("is not mounted when Search is not configured", async () => {
    const response = await request(app())
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF_BYTES);
    expect(response.status).toBe(404);
  });

  it("converts and forwards the canonical Markdown", async () => {
    const search = stubSearchClient();
    const document = testDocument();
    const response = await request(
      app(searchEnv, { searchClient: search, extractor: stubExtractor({ document }) }),
    )
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/handbuch.pdf")
      .send(PDF_BYTES);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      reference: "tests/handbuch.pdf",
      collection: "specs",
      page_count: 2,
    });
    expect(search.calls).toHaveLength(1);
    expect(search.calls[0]?.markdown).toBe(serializeDocument(document));
  });

  it("requires a reference, because it is the row key in Search", async () => {
    // Defaulting it to a filename would make two uploads of "scan.pdf" from
    // different sources overwrite each other.
    const response = await request(app(searchEnv, { searchClient: stubSearchClient() }))
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/X-Reference is required/);
  });

  it("honours an explicit collection", async () => {
    const search = stubSearchClient();
    await request(app(searchEnv, { searchClient: search }))
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Collection", "other")
      .send(PDF_BYTES);
    expect(search.calls[0]?.collection).toBe("other");
  });

  it("passes the chunking and structure overrides through to Search", async () => {
    const search = stubSearchClient();
    await request(app(searchEnv, { searchClient: search }))
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Chunk-Size", "512")
      .set("X-Chunk-Overlap", "64")
      .set("X-Breakpoint-Percentile", "80")
      .set("X-Late-Chunking-Alpha", "0.5")
      .set("X-Context-Prefix-Size", "0")
      .set("X-Chapter-Split-Max-Chunks", "25")
      .set("X-Document-Structure", "off")
      .set("X-Summary-Mode", "generate")
      .set("X-Quantization", "binary")
      .set("X-Semantic-Chunking", "true")
      .set("X-Summarize", "true")
      .set("X-FTS-Language", "german")
      .send(PDF_BYTES);
    const options = search.calls[0]?.options;
    expect(options?.chunkSize).toBe(512);
    expect(options?.chunkOverlap).toBe(64);
    expect(options?.breakpointPercentile).toBe(80);
    expect(options?.lateChunkingAlpha).toBe(0.5);
    expect(options?.contextPrefixSize).toBe(0);
    expect(options?.chapterSplitMaxChunks).toBe(25);
    expect(options?.documentStructure).toBe("off");
    expect(options?.summaryMode).toBe("generate");
    expect(options?.quantization).toBe("binary");
    expect(options?.semanticChunking).toBe(true);
    expect(options?.summarize).toBe(true);
    expect(options?.ftsLanguage).toBe("german");
  });

  it("rejects an out-of-range override rather than passing it on", async () => {
    const response = await request(app(searchEnv, { searchClient: stubSearchClient() }))
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Breakpoint-Percentile", "150")
      .send(PDF_BYTES);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/X-Breakpoint-Percentile/);
  });

  it("rejects malformed metadata rather than passing it on", async () => {
    const response = await request(app(searchEnv, { searchClient: stubSearchClient() }))
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Metadata", "[1,2,3]")
      .send(PDF_BYTES);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/X-Metadata must be a JSON object/);
  });

  it("reports partially stored crops without failing the ingest", async () => {
    // The document is already indexed and its figure descriptions are retrievable;
    // only the image is missing.
    const document = testDocument({ pages: [testPage(1, { figures: [testFigure(1, 1)] })] });
    const response = await request(
      app(searchEnv, {
        searchClient: stubSearchClient({ assetsFailed: 1 }),
        extractor: stubExtractor({ document, crops: new Map([["p1-f1", testCrop()]]) }),
      }),
    )
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/handbuch.pdf")
      .send(PDF_BYTES);

    expect(response.status).toBe(200);
    expect(response.body.assets_failed).toBe(1);
  });

  it("maps a Search rejection to 502", async () => {
    const { ingestFailed } = await import("../src/errors.js");
    const response = await request(
      app(searchEnv, { searchClient: stubSearchClient({ error: ingestFailed("Search said no") }) }),
    )
      .post("/v1/ingest")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF_BYTES);

    expect(response.status).toBe(502);
    expect(response.body.code).toBe("INGEST_FAILED");
  });
});

describe("authentication boundaries", () => {
  const token = "t".repeat(40);
  const tokenEnv = { AUTHN_MODE: "token", API_TOKEN: token };

  it("refuses an unauthenticated conversion", async () => {
    const response = await request(app(tokenEnv))
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("accepts the configured bearer token", async () => {
    const response = await request(app(tokenEnv))
      .post("/v1/convert")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(200);
  });

  it("rejects a wrong token of the same length", async () => {
    const response = await request(app(tokenEnv))
      .post("/v1/convert")
      .set("Authorization", `Bearer ${"x".repeat(40)}`)
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(401);
  });

  it("does not accept a browser cookie as an API credential", async () => {
    // Letting a cookie authenticate /v1/* would turn a CSRF into a document upload.
    const response = await request(app({ ...tokenEnv, MONITOR_TOKEN: token }))
      .post("/v1/convert")
      .set("Cookie", `session_token=${token}`)
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(401);
  });

  it("requires a verified session on the UI boundary", async () => {
    const response = await request(app(tokenEnv))
      .post("/ui/convert")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/OIDC web session/);
  });

  it("guards the UI boundary against cross-origin mutations", async () => {
    // Without this, any page on the internet can make a logged-in operator's
    // browser upload a document.
    const response = await request(app())
      .post("/ui/convert")
      .set("Origin", "https://attacker.example")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Cross-origin UI mutation denied/);
  });

  it("allows a same-origin UI mutation", async () => {
    const response = await request(app())
      .post("/ui/convert")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);
    expect(response.status).toBe(200);
  });

  it("serves the UI when authentication is disabled", async () => {
    const response = await request(app()).get("/");
    expect(response.status).toBe(200);
    expect(response.text).toContain("ATF Extract");
  });

  it("shows a login page instead of the UI when a monitor token is set", async () => {
    const response = await request(app({ ...tokenEnv, MONITOR_TOKEN: token })).get("/");
    expect(response.status).toBe(200);
    expect(response.text).toContain("Anmelden");
    expect(response.text).not.toContain("Dokument konvertieren");
  });
});

describe("GET /metrics", () => {
  it("exposes the conversion-specific series", async () => {
    const application = app();
    await request(application)
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    const response = await request(application).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.text).toContain("extract_http_requests_total");
    expect(response.text).toContain("extract_documents_total");
    expect(response.text).toContain("extract_queue_depth");
    expect(response.text).toContain("extract_vision_truncations_total");
  });

  it("labels by route template, never by raw path", async () => {
    // A metric labelled by document reference would grow one series per file.
    const application = app();
    await request(application)
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "very/specific/document.pdf")
      .send(PDF_BYTES);

    const response = await request(application).get("/metrics");
    expect(response.text).toContain('route="/v1/convert"');
    expect(response.text).not.toContain("very/specific");
  });
});


