// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `get_documents` lists the other parts of a split document as `siblings`
 * (declared via `metadata.split_of`; never guessed), and the group id of a
 * part depends on its folder and its `split_of`.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandlers } from "../src/handlers/mcp.js";
import { folderOf, splitGroupId, splitOfValue } from "../src/document-identity.js";

const logger = pino({ level: "silent" });
const principal = { userId: "alice", userGroups: [], source: "jwt" as const };
const instant = new Date("2026-03-01T00:00:00.000Z");

const doc = (reference: string, metadata: Record<string, unknown>) => ({
  reference,
  title: reference,
  link: null,
  source: null,
  metadata,
  tags: [],
  chunks: 1,
  content: "Text",
  modified: instant,
});

describe("splitGroupId", () => {
  it("is shared by parts of one folder with the same split_of", () => {
    const a = splitGroupId("/specs/a.pdf", { split_of: "spec-1" });
    expect(a).toMatch(/^split:[0-9a-f]{32}$/);
    expect(splitGroupId("/specs/b.pdf", { split_of: "spec-1" })).toBe(a);
  });

  it("differs by folder and by split_of", () => {
    const a = splitGroupId("/specs/a.pdf", { split_of: "spec-1" });
    expect(splitGroupId("/other/a.pdf", { split_of: "spec-1" })).not.toBe(a);
    expect(splitGroupId("/specs/a.pdf", { split_of: "spec-2" })).not.toBe(a);
  });

  it("is undefined without a usable split_of or without a folder (no guessing)", () => {
    expect(splitGroupId("/specs/a.pdf", undefined)).toBeUndefined();
    expect(splitGroupId("/specs/a.pdf", {})).toBeUndefined();
    expect(splitGroupId("/specs/a.pdf", { split_of: "" })).toBeUndefined();
    expect(splitGroupId("/specs/a.pdf", { split_of: "   " })).toBeUndefined();
    expect(splitGroupId("/specs/a.pdf", { split_of: 7 })).toBeUndefined();
    expect(splitGroupId("a.pdf", { split_of: "spec-1" })).toBeUndefined();
  });

  it("folderOf cuts at the last slash", () => {
    expect(folderOf("/a/b/c.pdf")).toBe("/a/b");
    expect(folderOf("c.pdf")).toBe("");
    expect(splitOfValue({ split_of: " x " })).toBe("x");
  });
});

describe("get_documents · siblings", () => {
  async function callGetDocuments(documents: ReturnType<typeof doc>[], siblings: Record<string, unknown>) {
    const getSplitSiblings = vi.fn(async () => ({ ok: true, result: siblings }));
    const handlers = createMcpHandlers({
      embeddingClient: { embed: vi.fn() },
      postgresClient: {
        getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
        getDocumentsByPrefix: vi.fn(async () => ({
          ok: true,
          result: { documents, total: documents.length, truncated: false },
        })),
        getSplitSiblings,
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
    const client = new Client({ name: "split-test", version: "1" }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const res = (await client.callTool({ name: "get_documents", arguments: { path_prefix: "/specs" } })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const body = JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}") as {
        documents: Array<Record<string, unknown>>;
      };
      return { documents: body.documents, getSplitSiblings };
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      handlers.close();
    }
  }

  it("adds siblings to a part of a split document", async () => {
    const siblings = [
      { base_ref: "/specs/a.pdf", title: "A", order: 1 },
      { base_ref: "/specs/c.pdf", title: "C", order: 3 },
    ];
    const { documents, getSplitSiblings } = await callGetDocuments(
      [doc("/specs/b.pdf", { split_of: "spec-1", split_order: 2 }), doc("/specs/plain.pdf", {})],
      { "/specs/b.pdf": siblings },
    );
    expect(documents[0]?.siblings).toEqual(siblings);
    expect(documents[1]).not.toHaveProperty("siblings");
    // Only the declared part is looked up.
    expect(getSplitSiblings).toHaveBeenCalledWith(
      "documents",
      expect.anything(),
      [{ reference: "/specs/b.pdf", splitOf: "spec-1" }],
      {},
    );
  });

  it("does not look anything up when no document declares split_of", async () => {
    const { documents, getSplitSiblings } = await callGetDocuments([doc("/specs/plain.pdf", {})], {});
    expect(documents[0]).not.toHaveProperty("siblings");
    expect(getSplitSiblings).not.toHaveBeenCalled();
  });
});
