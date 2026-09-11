// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the binary-document proxy.
 *
 * The interesting behaviour is not the happy path but the hand-off: that the
 * converter's Markdown is written back onto the request in the exact shape the
 * unmodified ingest handler accepts, that provenance survives, and that a
 * converter failure is attributed to the right side of the boundary — a 415 from
 * the converter is the caller's problem and must not be reported as a Search
 * outage.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type RequestHandler } from "express";
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

/** A fictional appliance manual; the fixtures deliberately name no real domain. */
const MARKDOWN = [
  "## Seite 1",
  "",
  "<summary>Die Seite beschreibt die Inbetriebnahme.</summary>",
  "",
  "<figures>",
  '<figure id="p1-f1" bbox="[0.1000, 0.2000, 0.6000, 0.7500]" page="1">Ablaufdiagramm.</figure>',
  "</figures>",
  "",
  "# Einleitung",
  "",
  "![figure_p1-f1]",
].join("\n");

/** What the downstream ingest handler saw. */
interface Captured {
  body: unknown;
  contentType: string | undefined;
  summaryMode: string | undefined;
  metadata: string | undefined;
  collection: string | undefined;
  reference: string | undefined;
}

/**
 * Build an app whose "ingest handler" only records the request.
 *
 * Substituting it is the point: everything after conversion is the real ingest
 * path in production, so what this test needs to prove is the shape handed to it.
 */
function buildApp(overrides: Partial<ConverterConfig> = {}): {
  app: express.Express;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const spyIngest: RequestHandler = (req, res) => {
    captured.push({
      body: req.body,
      contentType: req.headers["content-type"],
      summaryMode: req.headers["x-summary-mode"] as string | undefined,
      metadata: req.headers["x-metadata"] as string | undefined,
      collection: req.headers["x-collection"] as string | undefined,
      reference: req.headers["x-reference"] as string | undefined,
    });
    res.status(200).json({ status: "ok" });
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as Request & { log?: typeof logger }).log = logger;
    next();
  });
  app.post(
    "/ingest-file",
    express.raw({ type: [...CONVERTIBLE_MIME_TYPES], limit: "10mb" }),
    createIngestFileHandler({
      converter: { ...CONVERTER, ...overrides },
      logger,
      ingestHandler: spyIngest,
    }),
  );
  return { app, captured };
}

function markdownResponse(body = MARKDOWN, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-extract-contract": "atf-extract/1.0.0",
      "x-page-count": "1",
      "x-figure-count": "1",
      ...headers,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /ingest-file", () => {
  it("asks the converter for Markdown and forwards the credential", async () => {
    const fetchMock = vi.fn(async () => markdownResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { app } = buildApp();

    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "specs/a.pdf")
      .send(PDF);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://converter.test/v1/convert");
    const headers = init.headers as Record<string, string>;
    // Markdown, not the JSON envelope: that string is what gets forwarded.
    expect(headers["accept"]).toBe("text/markdown");
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["authorization"]).toBe("Bearer converter-token");
    expect(headers["x-reference"]).toBe("specs/a.pdf");
  });

  it("hands the ingest path a text/markdown body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
    const { app, captured } = buildApp();

    const response = await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "specs/a.pdf")
      .send(PDF);

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toBe(MARKDOWN);
    expect(captured[0]?.contentType).toBe("text/markdown; charset=utf-8");
    // The caller's routing headers pass through untouched.
    expect(captured[0]?.reference).toBe("specs/a.pdf");
  });

  it("preserves the caller's collection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
    const { app, captured } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Collection", "specs")
      .send(PDF);
    expect(captured[0]?.collection).toBe("specs");
  });

  it("selects embedded summaries, since the converter already produced them", async () => {
    // Regenerating them would pay twice for a worse summary: the converter saw the
    // rendered page, Search only sees text.
    vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
    const { app, captured } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(captured[0]?.summaryMode).toBe("embedded");
  });

  it("does not override an explicit summary mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
    const { app, captured } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .set("X-Summary-Mode", "generate")
      .send(PDF);
    expect(captured[0]?.summaryMode).toBe("generate");
  });

  it("leaves the summary mode alone when the output carries no summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => markdownResponse("## Seite 1\n\nNur Text.")));
    const { app, captured } = buildApp();
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(captured[0]?.summaryMode).toBeUndefined();
  });

  describe("provenance", () => {
    it("records the converter contract in the metadata", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
      const { app, captured } = buildApp();
      await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);

      const metadata = JSON.parse(captured[0]?.metadata ?? "{}");
      expect(metadata.extract_contract).toBe("atf-extract/1.0.0");
      expect(metadata.extract_via).toBe("search/ingest-file");
    });

    it("merges into the caller's metadata without losing it", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
      const { app, captured } = buildApp();
      await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .set("X-Metadata", JSON.stringify({ project_id: "wms" }))
        .send(PDF);

      const metadata = JSON.parse(captured[0]?.metadata ?? "{}");
      expect(metadata.project_id).toBe("wms");
      expect(metadata.extract_contract).toBe("atf-extract/1.0.0");
    });

    it("lets the caller's value win on a conflict", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
      const { app, captured } = buildApp();
      await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .set("X-Metadata", JSON.stringify({ extract_via: "manual" }))
        .send(PDF);
      expect(JSON.parse(captured[0]?.metadata ?? "{}").extract_via).toBe("manual");
    });

    it("base64-encodes the result when a value is not header-safe", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
      const { app, captured } = buildApp();
      await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .set(
          "X-Metadata",
          `base64:${Buffer.from(JSON.stringify({ author: "Prüfautor" })).toString("base64")}`,
        )
        .send(PDF);

      const raw = captured[0]?.metadata ?? "";
      expect(raw).toMatch(/^base64:/);
      const decoded = JSON.parse(Buffer.from(raw.slice(7), "base64").toString("utf-8"));
      expect(decoded.author).toBe("Prüfautor");
      expect(decoded.extract_contract).toBe("atf-extract/1.0.0");
    });

    it("passes invalid caller metadata through untouched", async () => {
      // The ingest handler rejects it with a message about X-Metadata, which is
      // more useful than an error about this route.
      vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
      const { app, captured } = buildApp();
      await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .set("X-Metadata", "{not json")
        .send(PDF);
      expect(captured[0]?.metadata).toBe("{not json");
    });
  });

  it("states that figure images are not stored on this path", async () => {
    // Otherwise the limitation is discovered when someone clicks a figure.
    vi.stubGlobal("fetch", vi.fn(async () => markdownResponse()));
    const { app } = buildApp();
    const response = await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    expect(response.headers["x-figure-assets"]).toBe("not-stored");
    expect(response.headers["x-extract-contract"]).toBe("atf-extract/1.0.0");
  });

  describe("validation before any work is done", () => {
    it("requires a reference, so a conversion is not paid for in vain", async () => {
      const fetchMock = vi.fn(async () => markdownResponse());
      vi.stubGlobal("fetch", fetchMock);
      const { app } = buildApp();

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

  describe("converter failures are attributed to the right side", () => {
    it("passes a 415 through, because the caller's file is the problem", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response('{"error":"Unsupported file type"}', { status: 415 })),
      );
      const { app, captured } = buildApp();

      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);

      expect(response.status).toBe(415);
      expect(response.body.converter_detail).toContain("Unsupported file type");
      // Nothing was indexed.
      expect(captured).toHaveLength(0);
    });

    it("passes a 422 page-limit rejection through", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response('{"error":"too many pages"}', { status: 422 })),
      );
      const { app } = buildApp();
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(422);
    });

    it("reports a converter 500 as a 502, because it is not the caller's fault", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
      const { app } = buildApp();
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(502);
    });

    it("reports an unreachable converter as a 502", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }));
      const { app } = buildApp();
      const response = await request(app)
        .post("/ingest-file")
        .set("Content-Type", "application/pdf")
        .set("X-Reference", "a")
        .send(PDF);
      expect(response.status).toBe(502);
      expect(response.body.error).toMatch(/could not be reached/);
    });

    it("reports a timeout as a 504 and names the budget", async () => {
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
      const { app } = buildApp({ timeoutMs: 20 });
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
    const fetchMock = vi.fn(async () => markdownResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { app } = buildApp({ token: null });
    await request(app)
      .post("/ingest-file")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "a")
      .send(PDF);
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers["authorization"]).toBeUndefined();
  });
});
