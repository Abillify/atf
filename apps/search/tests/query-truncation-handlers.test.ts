// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * SEARCH_MAX_QUERY_CHARS at every query entry point: an over-long query is cut
 * before it reaches the store, and each surface reports the cut (v1: the
 * `X-Query-Truncated` header; v2, `/v2/retrieve` and the MCP `search` tool:
 * `query_truncated: true`). A query within the limit reports nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import request from "supertest";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAuthMiddleware } from "../src/auth.js";
import { createSearchHandler } from "../src/handlers/search.js";
import { createSearchV2Handler } from "../src/handlers/search-v2.js";
import { createRetrieveV2Handler } from "../src/handlers/retrieve-v2.js";
import { createMcpHandlers } from "../src/handlers/mcp.js";
import type { EmbeddingClient } from "../src/embedding-client.js";
import type { PostgresClient } from "../src/postgres-client.js";

const logger = pino({ level: "silent" });
const MAX = 400;
/** 500 characters of words: cut at the last space before 400. */
const LONG = Array.from({ length: 100 }, (_, i) => `wort${i % 10}`).join(" ").slice(0, 500);
const SHORT = "Wie hoch ist die Miete?";

function fakes() {
  const search = vi.fn(async (_query: string) => ({ ok: true, result: [] }));
  const postgresClient = {
    search,
    recordSearchStat: vi.fn(),
    lookupFigureUnits: vi.fn(async () => ({ ok: true, result: [] })),
    expandUnit: vi.fn(async () => ({ ok: true, result: [] })),
    getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
  } as unknown as PostgresClient & { search: typeof search };
  const embeddingClient = {
    embed: vi.fn(async () => ({ ok: true, result: { vector: [0.1, 0.2] } })),
  } as unknown as EmbeddingClient;
  return { search, postgresClient, embeddingClient };
}

function app(mount: (a: express.Express, f: ReturnType<typeof fakes>) => void) {
  const f = fakes();
  const a = express();
  a.use(express.json());
  a.use(express.text({ type: "text/plain" }));
  mount(a, f);
  return { a, ...f };
}

const auth = { Authorization: "Bearer secret-token" };
const passMetadata: express.RequestHandler = (_req, res, next) => {
  res.locals.metadata = {};
  next();
};

function expectCutQuery(query: string | undefined): void {
  expect(query).toBeDefined();
  expect((query ?? "").length).toBeLessThanOrEqual(MAX);
  expect(LONG.startsWith(query ?? "\u0000")).toBe(true);
}

describe("query truncation · v1 POST /search", () => {
  const build = () =>
    app((a, f) =>
      a.post(
        "/search",
        createAuthMiddleware("secret-token"),
        passMetadata,
        createSearchHandler(f.embeddingClient, f.postgresClient, logger, { maxQueryChars: MAX }),
      ),
    );
  it("cuts a 500-character query and sets X-Query-Truncated", async () => {
    const { a, search } = build();
    const res = await request(a).post("/search").set(auth).set("Content-Type", "text/plain").send(LONG);
    expect(res.status).toBe(200);
    expect(res.headers["x-query-truncated"]).toBe("true");
    expectCutQuery(search.mock.calls[0]?.[0]);
  });
  it("sends no header for a query within the limit", async () => {
    const { a, search } = build();
    const res = await request(a).post("/search").set(auth).set("Content-Type", "text/plain").send(SHORT);
    expect(res.status).toBe(200);
    expect(res.headers["x-query-truncated"]).toBeUndefined();
    expect(search.mock.calls[0]?.[0]).toBe(SHORT);
  });
});

describe("query truncation · POST /v2/search", () => {
  const build = () =>
    app((a, f) =>
      a.post(
        "/v2/search",
        createAuthMiddleware("secret-token"),
        passMetadata,
        createSearchV2Handler(f.embeddingClient, f.postgresClient, logger, { maxQueryChars: MAX }),
      ),
    );
  it("cuts a 500-character query and reports query_truncated", async () => {
    const { a, search } = build();
    const res = await request(a).post("/v2/search").set(auth).send({ query: LONG });
    expect(res.status).toBe(200);
    expect(res.body.query_truncated).toBe(true);
    expectCutQuery(search.mock.calls[0]?.[0]);
  });
  it("omits query_truncated for a query within the limit", async () => {
    const { a } = build();
    const res = await request(a).post("/v2/search").set(auth).send({ query: SHORT });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("query_truncated");
  });
});

describe("query truncation · POST /v2/retrieve", () => {
  it("cuts a 500-character question and reports query_truncated", async () => {
    const { a, search } = app((x, f) =>
      x.post(
        "/v2/retrieve",
        createAuthMiddleware("secret-token"),
        passMetadata,
        createRetrieveV2Handler(f.embeddingClient, f.postgresClient, logger, { maxQueryChars: MAX }),
      ),
    );
    const res = await request(a).post("/v2/retrieve").set(auth).send({ question: LONG });
    expect(res.status).toBe(200);
    expect(res.body.query_truncated).toBe(true);
    for (const call of search.mock.calls) {
      expect((call[0] ?? "").length).toBeLessThanOrEqual(MAX);
    }
  });
});

describe("query truncation · MCP search tool", () => {
  let client: Client;
  let server: Server;
  let closeHandlers: () => void;
  const f = fakes();

  beforeAll(async () => {
    const handlers = createMcpHandlers({
      embeddingClient: f.embeddingClient,
      postgresClient: f.postgresClient,
      sparseClient: null,
      queryCache: null,
      logger,
      maxQueryChars: MAX,
      transactionConfig: {
        enforcement: "off",
        secret: "x".repeat(32),
        issuer: "o",
        audience: "vectorsearch",
        clockToleranceSeconds: 0,
        maxTtlSeconds: 300,
      },
      authzEnforcement: "off",
    } as never);
    closeHandlers = handlers.close;
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as typeof req & { principal: unknown }).principal = { userId: "alice", userGroups: [], source: "jwt" };
      next();
    });
    a.post("/mcp", handlers.post);
    a.get("/mcp", handlers.get);
    a.delete("/mcp", handlers.delete);
    server = await new Promise<Server>((resolve) => {
      const s = a.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    client = new Client({ name: "truncation-test", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeHandlers();
  });

  it("cuts a 500-character query and reports query_truncated", async () => {
    const res = (await client.callTool({ name: "search", arguments: { query: LONG } })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(res.isError).not.toBe(true);
    const body = JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}") as Record<string, unknown>;
    expect(body.query_truncated).toBe(true);
    expectCutQuery(f.search.mock.calls[0]?.[0]);
  });
});
