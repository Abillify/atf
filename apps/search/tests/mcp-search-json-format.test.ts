// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * The MCP `search` tool answers with compact JSON by default and indents it
 * only when `mcpPrettyJson` (SEARCH_MCP_PRETTY_JSON) is set. Drives the REAL
 * MCP server through the SDK client against fakes.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandlers } from "../src/handlers/mcp.js";

const logger = pino({ level: "silent" });
const principal = { userId: "alice", userGroups: [], source: "jwt" as const };
const instant = new Date("2026-03-01T00:00:00.000Z");

async function searchText(mcpPrettyJson: boolean | undefined): Promise<string> {
  const handlers = createMcpHandlers({
    embeddingClient: {
      embed: vi.fn(async () => ({ ok: true, result: { vector: [0.1, 0.2] } })),
    },
    postgresClient: {
      getCollectionAcl: vi.fn(async () => ({
        ok: true,
        result: { allowedUsers: ["alice"], allowedGroups: [] },
      })),
      search: vi.fn(async () => ({
        ok: true,
        result: [
          {
            id: "a",
            score: 0.5,
            content: "Pflichtfeld Lieferant",
            metadata: {},
            reference: "a#0",
            base_ref: "a",
            created: instant,
            modified: instant,
            valid_from: null,
            effective_valid_from: instant,
          },
        ],
      })),
      resolveDocumentGroups: vi.fn(async () => ({ ok: true, result: new Map() })),
      lookupFigureUnits: vi.fn(async () => ({ ok: true, result: [] })),
    },
    sparseClient: null,
    queryCache: null,
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
    ...(mcpPrettyJson === undefined ? {} : { mcpPrettyJson }),
  } as never);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { principal: typeof principal }).principal = principal;
    next();
  });
  app.post("/mcp", handlers.post);
  app.get("/mcp", handlers.get);
  app.delete("/mcp", handlers.delete);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const client = new Client({ name: "json-format-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    const res = (await client.callTool({
      name: "search",
      arguments: { query: "lieferant" },
    })) as { content: Array<{ type: string; text?: string }> };
    return res.content.find((c) => c.type === "text")?.text ?? "";
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    handlers.close();
  }
}

describe("MCP search tool · JSON formatting", () => {
  it("is compact by default", async () => {
    const text = await searchText(undefined);
    expect(text).not.toContain("\n");
    expect(JSON.parse(text).count).toBe(1);
  });

  it("is indented when mcpPrettyJson is set", async () => {
    const text = await searchText(true);
    expect(text).toContain('\n  "results"');
    expect(JSON.parse(text).count).toBe(1);
  });
});
