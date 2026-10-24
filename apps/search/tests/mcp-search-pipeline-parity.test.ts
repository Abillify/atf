// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Parity of the MCP `search` tool with `/v2/search` on the shared retrieval
 * pipeline: the query text is normalised before it is embedded (the
 * other search surfaces do this; MCP used to embed the raw string), and the
 * rerank inputs are fitted to the real token budget when a tokenizer is wired.
 * Drives the REAL MCP server through the SDK client against fakes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandlers } from "../src/handlers/mcp.js";

const logger = pino({ level: "silent" });
const principal = { userId: "alice", userGroups: [], source: "jwt" as const };
const instant = new Date("2026-03-01T00:00:00.000Z");

const hit = (id: string, content: string) => ({
  id,
  score: 0.5,
  content,
  metadata: {},
  reference: `${id}#0`,
  base_ref: id,
  created: instant,
  modified: instant,
  valid_from: null,
  effective_valid_from: instant,
});

describe("MCP search tool · pipeline parity with /v2/search", () => {
  let client: Client;
  let server: Server;
  let closeHandlers: () => void;
  const embedded: string[] = [];
  const rerankDocs: string[][] = [];
  const counted: string[] = [];

  beforeAll(async () => {
    const long = "wort ".repeat(2000);
    const handlers = createMcpHandlers({
      embeddingClient: {
        embed: vi.fn(async (text: string) => {
          embedded.push(text);
          return { ok: true, result: { vector: [0.1, 0.2] } };
        }),
      },
      postgresClient: {
        getCollectionAcl: vi.fn(async () => ({
          ok: true,
          result: { allowedUsers: ["alice"], allowedGroups: [] },
        })),
        search: vi.fn(async () => ({
          ok: true,
          result: [hit("a", long), hit("b", long)],
        })),
        resolveDocumentGroups: vi.fn(async () => ({ ok: true, result: new Map() })),
        lookupFigureUnits: vi.fn(async () => ({ ok: true, result: [] })),
      },
      sparseClient: null,
      queryCache: null,
      hydeClient: {
        expand: vi.fn(async () => ({
          ok: true as const,
          result: "Die Miete betraegt 850 Euro netto kalt.",
        })),
      },
      rerankerClient: {
        rerank: vi.fn(async (_q: string, documents: string[]) => {
          rerankDocs.push(documents);
          return {
            ok: true,
            result: documents.map((_d, index) => ({ index, score: 0.9 - index * 0.1 })),
          };
        }),
      },
      // A counter that finds every document far over a 100-token budget.
      tokenCounter: {
        count: vi.fn(async (text: string) => text.length),
        countBatch: vi.fn(async (texts: string[]) => {
          counted.push(...texts);
          return texts.map((t) => t.length);
        }),
        cacheSize: 0,
      },
      logger,
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
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { principal: typeof principal }).principal = principal;
      next();
    });
    app.post("/mcp", handlers.post);
    app.get("/mcp", handlers.get);
    app.delete("/mcp", handlers.delete);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    client = new Client({ name: "parity-test", version: "1" }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeHandlers();
  });

  it("embeds the normalised query, not the raw markdown/URL noise", async () => {
    embedded.length = 0;
    await client.callTool({
      name: "search",
      arguments: {
        query: "## Wie hoch ist die **Miete**? siehe https://example.com/x/y [Link](https://x.y)",
      },
    });
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).not.toContain("##");
    expect(embedded[0]).not.toContain("**");
    expect(embedded[0]).not.toContain("https://");
    expect(embedded[0]).toContain("Wie hoch ist die Miete");
    expect(embedded[0]).toContain("Link");
  });

  it("a query that is only noise is embedded as written, never as an empty string", async () => {
    embedded.length = 0;
    const raw = "https://example.com/only/a/url";
    await client.callTool({ name: "search", arguments: { query: raw } });
    expect(embedded).toEqual([raw]);
  });

  it("embeds the HyDE expansion when the tool asks for it", async () => {
    embedded.length = 0;
    const res = (await client.callTool({
      name: "search",
      arguments: { query: "wie hoch ist die miete", hyde: true },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(res.isError).not.toBe(true);
    expect(embedded).toEqual(["Die Miete betraegt 850 Euro netto kalt."]);
    const payload = JSON.parse(
      res.content.find((c) => c.type === "text")?.text ?? "{}",
    ) as { hyde?: Record<string, unknown> };
    expect(payload.hyde).toMatchObject({
      requested: true,
      available: true,
      applied: true,
      fallbackReason: null,
    });
  });

  it("fits the rerank inputs through the tokenizer when one is wired", async () => {
    rerankDocs.length = 0;
    counted.length = 0;
    const res = (await client.callTool({
      name: "search",
      arguments: { query: "miete", rerank: true },
    })) as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    expect(counted.length).toBeGreaterThan(0);
    expect(rerankDocs).toHaveLength(1);
    expect(rerankDocs[0]).toHaveLength(2);
    // The 10 000-character hits were trimmed before they reached the reranker.
    for (const doc of rerankDocs[0] ?? []) expect(doc.length).toBeLessThan(10_000);
  });
});
