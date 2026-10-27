// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * mcp-nav.test.ts
 *
 * Handler-level tests for the v2 document-navigation MCP tools (task 3.9,
 * Requirements 15.1/15.2/15.3/15.4). They drive the REAL MCP server through the
 * SDK client (so registration, schema, ACL wiring and response shaping are all
 * exercised) against a fake PostgresClient + fake AssetStore + fake RenderCache
 * — no live database or Extract.
 *
 * Coverage:
 *   (a) get_outline    — depth-limited, paginated outline with section ids + pages;
 *   (b) get_section /  — Markdown v2 bounded by max_chars with truncated;
 *       get_pages
 *   (c) get_context    — before/after neighbours via the unit graph;
 *   (d) list_figures   — figures of a range, paginated, filterable by kind;
 *   (e) get_asset      — MCP image content for a variant and a region zoom (via
 *                        the render-cache), and FAIL CLOSED on metadata mismatch;
 *   (f) get_table      — a table's row-groups reassembled across pages;
 *   (g) find_identifier— exact occurrences from vs_identifiers, paginated;
 *   (h) follow_ref     — a unit's referenced figures resolved;
 *   (i) search         — accepts the v2 params (granularity/expand/filters/…);
 *   (j) ACL            — the tools pass the caller's scope to every read; a
 *                        denied scope surfaces no units/assets.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandlers } from "../src/handlers/mcp.js";
import type { AssetStore } from "../src/asset-store.js";
import type { RenderCache } from "../src/render-cache.js";

const logger = pino({ level: process.env.MCP_TEST_LOG_LEVEL ?? "silent" });
const principal = { userId: "alice", userGroups: ["legal"], source: "jwt" as const };

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

function textOf(result: ToolResult): string {
  const part = result.content.find((c) => c.type === "text");
  return part?.text ?? "";
}
function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** The source sha256 the fake store resolves for the asset's revision (server-side truth). */
const SERVER_SHA = "5".repeat(64);
/** Mutable per-test: what lookupRevisionSourceSha256 returns. */
let serverSourceSha: string | null = SERVER_SHA;
/** Captured render-cache targets, to assert the render source is the server-side one. */
const renderTargets: Array<{ sourceSha256: string }> = [];
/** Captured search() argument lists. */
const searchCalls: unknown[][] = [];

/** A fake AssetStore exposing only the methods the nav get_asset tool uses. */
function fakeAssetStore(): AssetStore {
  return {
    ensureSchema: vi.fn(),
    put: vi.fn(),
    head: vi.fn(),
    get: vi.fn(async (_scope, assetId, variant) => {
      if (assetId !== "asset-1") return { ok: true as const, result: null };
      return {
        ok: true as const,
        result: { assetId, variant, mimeType: "image/png", data: PNG, checksum: "ck", width: 10, height: 8 },
      };
    }),
    getMeta: vi.fn(async (_scope, assetId) => {
      if (assetId !== "asset-1") return { ok: true as const, result: null };
      return {
        ok: true as const,
        result: {
          assetId,
          kind: "figure" as const,
          documentReference: "docs/manual.pdf",
          revisionId: "rev-1",
          figureId: "fig-7",
          page: 37,
          bbox: null,
          mimeType: "image/png",
        },
      };
    }),
  } as unknown as AssetStore;
}

/** A fake RenderCache that returns a rendered crop without touching Extract. */
function fakeRenderCache(): RenderCache {
  return {
    cacheAssetId: (base: string) => `${base}@region`,
    getOrRender: vi.fn(async (binding, target) => {
      renderTargets.push(target);
      return {
      ok: true as const,
      result: { assetId: `${binding.baseAssetId}@region`, mimeType: "image/png", data: PNG, width: 256, height: 256, rendered: true },
      };
    }),
  } as unknown as RenderCache;
}

/**
 * A fake PostgresClient wired for the navigation reads. Every method captures
 * the `scope` it was called with so the ACL test can assert the caller's scope
 * is passed through unchanged.
 */
function fakePg(capturedScopes: unknown[]): Record<string, unknown> {
  const capture = <T>(value: T) => (...args: unknown[]) => {
    capturedScopes.push(args[1]);
    return Promise.resolve(value);
  };
  return {
    getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
    // search: exercised for the v2-params test.
    lookupRevisionSourceSha256: vi.fn(async () => ({ ok: true, result: serverSourceSha })),
    search: vi.fn(async (...args: unknown[]) => {
      searchCalls.push(args);
      capturedScopes.push(args[4]);
      return { ok: true, result: [] };
    }),
    expandUnit: vi.fn(async () => ({ ok: true, result: [] })),
    lookupFigureUnits: vi.fn(async (...args: unknown[]) => {
      capturedScopes.push(args[1]);
      return { ok: true, result: [{ figure_id: "fig-7", asset_id: "asset-1", figure_kind: "process", caption: "Ablauf", page: 37, bbox: null }] };
    }),
    getOutline: capture({
      ok: true,
      result: {
        entries: [
          { unit_id: "s1", section_id: "sec-1", section_path: ["1 Einleitung"], depth: 1, heading: "1 Einleitung", page_start: 1, page_end: 3 },
          { unit_id: "s2", section_id: "sec-2", section_path: ["2 Antragseingang"], depth: 1, heading: "2 Antragseingang", page_start: 4, page_end: 40 },
        ],
        total: 5,
      },
    }),
    getSectionUnits: capture({
      ok: true,
      result: [
        { unit_id: "c1", unit_type: "chunk", content: "## 2 Antragseingang\n\nText A", section_id: "sec-2", section_path: ["2 Antragseingang"], page_start: 4, page_end: 4, figure_kind: null, table_id: null, metadata: {} },
        { unit_id: "c2", unit_type: "chunk", content: "Text B ".repeat(200), section_id: "sec-2", section_path: ["2 Antragseingang"], page_start: 5, page_end: 5, figure_kind: null, table_id: null, metadata: {} },
      ],
    }),
    getPageUnits: capture({
      ok: true,
      result: [
        { unit_id: "p1", unit_type: "chunk", content: "Seite 4 Inhalt", section_id: "sec-2", section_path: ["2 Antragseingang"], page_start: 4, page_end: 4, figure_kind: null, table_id: null, metadata: {} },
      ],
    }),
    getContextUnits: capture({
      ok: true,
      result: {
        before: [{ unit_id: "b1", unit_type: "chunk", content: "prev", section_id: "sec-2", section_path: [], page_start: 4, page_end: 4, figure_kind: null, table_id: null, metadata: {} }],
        unit: { unit_id: "u1", unit_type: "chunk", content: "center", section_id: "sec-2", section_path: [], page_start: 4, page_end: 4, figure_kind: null, table_id: null, metadata: {} },
        after: [{ unit_id: "a1", unit_type: "chunk", content: "next", section_id: "sec-2", section_path: [], page_start: 5, page_end: 5, figure_kind: null, table_id: null, metadata: {} }],
      },
    }),
    listFigureUnits: capture({
      ok: true,
      result: {
        figures: [{ figure_id: "fig-7", asset_id: "asset-1", figure_kind: "process", caption: "Ablauf", page: 37, bbox: null }],
        total: 3,
      },
    }),
    getTableUnits: capture({
      ok: true,
      result: {
        units: [
          { unit_id: "t1", unit_type: "table", content: "| A | B |\n|---|---|\n| 1 | 2 |", section_id: null, section_path: [], page_start: 10, page_end: 10, figure_kind: null, table_id: "tbl-1", metadata: {} },
          { unit_id: "t2", unit_type: "table", content: "| 3 | 4 |", section_id: null, section_path: [], page_start: 11, page_end: 11, figure_kind: null, table_id: "tbl-1", metadata: {} },
        ],
        total: 2,
      },
    }),
    getUnitById: capture({
      ok: true,
      result: { unit_id: "u1", unit_type: "chunk", content: "See figure fig-7", section_id: "sec-2", section_path: [], page_start: 4, page_end: 4, figure_kind: null, table_id: null, metadata: { base_ref: "docs/manual.pdf", figure_refs: ["fig-7"] } },
    }),
    findIdentifierOccurrences: capture({
      ok: true,
      result: {
        occurrences: [
          { value_norm: "WE01A", unit_id: "u9", page: 12, kind: "code", reference: "docs/manual.pdf#9", base_ref: "docs/manual.pdf", section_path: ["2 Antragseingang"], excerpt: "… WE-01/A …" },
        ],
        total: 4,
      },
    }),
  };
}

async function connect(handlers: { post: express.RequestHandler; get: express.RequestHandler; delete: express.RequestHandler }): Promise<{ client: Client; server: Server; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as typeof req & { principal: typeof principal }).principal = principal; next(); });
  app.post("/mcp", handlers.post);
  app.get("/mcp", handlers.get);
  app.delete("/mcp", handlers.delete);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const client = new Client({ name: "nav-test", version: "1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

describe("MCP navigation tools (task 3.9)", () => {
  const capturedScopes: unknown[] = [];
  let client: Client;
  let closeHandlers: () => void;
  let closeConn: () => Promise<void>;

  beforeAll(async () => {
    const handlers = createMcpHandlers({
      embeddingClient: { embed: vi.fn(async () => ({ ok: true, result: { vector: [0.1, 0.2] } })) },
      postgresClient: fakePg(capturedScopes),
      sparseClient: null,
      queryCache: null,
      logger,
      assetStore: fakeAssetStore(),
      renderCache: fakeRenderCache(),
      transactionConfig: { enforcement: "off", secret: "x".repeat(32), issuer: "o", audience: "vectorsearch", clockToleranceSeconds: 0, maxTtlSeconds: 300 },
      authzEnforcement: "off",
    } as never);
    closeHandlers = handlers.close;
    const conn = await connect(handlers);
    client = conn.client;
    closeConn = conn.close;
  });

  afterAll(async () => {
    await closeConn();
    closeHandlers();
  });

  it("(a) get_outline returns a depth-limited, paginated outline with section ids + pages", async () => {
    const res = (await client.callTool({ name: "get_outline", arguments: { reference: "docs/manual.pdf", depth: 1, limit: 2, offset: 0 } })) as ToolResult;
    const doc = jsonOf(res);
    expect(doc.total).toBe(5);
    expect(doc.truncated).toBe(true); // 0 + 2 < 5
    const entries = doc.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ section_id: "sec-1", heading: "1 Einleitung", page_start: 1, page_end: 3 });
  });

  it("(b) get_section returns Markdown v2 bounded by max_chars with truncated", async () => {
    const res = (await client.callTool({ name: "get_section", arguments: { reference: "docs/manual.pdf", section_id: "sec-2", max_chars: 500 } })) as ToolResult;
    const doc = jsonOf(res);
    expect(doc.section_id).toBe("sec-2");
    expect(String(doc.markdown)).toContain("## 2 Antragseingang");
    expect(doc.truncated).toBe(true); // second unit is ~1400 chars, over the 500 cap
    expect(String(doc.markdown).length).toBeLessThanOrEqual(600);
  });

  it("(b) get_pages returns Markdown v2 and a summary format", async () => {
    const md = jsonOf((await client.callTool({ name: "get_pages", arguments: { reference: "docs/manual.pdf", from: 4, to: 4 } })) as ToolResult);
    expect(md.format).toBe("markdown");
    expect(String(md.markdown)).toContain("Seite 4 Inhalt");

    const sum = jsonOf((await client.callTool({ name: "get_pages", arguments: { reference: "docs/manual.pdf", from: 4, to: 4, format: "summary" } })) as ToolResult);
    expect(sum.format).toBe("summary");
    expect(String(sum.summary)).toContain("[p4]");
  });

  it("(c) get_context returns before/after neighbours via the unit graph", async () => {
    const doc = jsonOf((await client.callTool({ name: "get_context", arguments: { unit_id: "u1", before: 1, after: 1 } })) as ToolResult);
    expect((doc.before as unknown[]).length).toBe(1);
    expect((doc.after as unknown[]).length).toBe(1);
    expect((doc.unit as Record<string, unknown>).unit_id).toBe("u1");
  });

  it("(d) list_figures lists figures of a range, paginated, filterable by kind", async () => {
    const res = (await client.callTool({ name: "list_figures", arguments: { reference: "docs/manual.pdf", from_page: 1, to_page: 40, kind: "process", limit: 1, offset: 0 } })) as ToolResult;
    const doc = jsonOf(res);
    expect(doc.total).toBe(3);
    expect(doc.truncated).toBe(true); // 0 + 1 < 3
    const figures = doc.figures as Array<Record<string, unknown>>;
    expect(figures[0]).toMatchObject({ figure_id: "fig-7", asset_id: "asset-1", figure_kind: "process" });
  });

  it("(e) get_asset returns MCP image content for a variant", async () => {
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", variant: "preview" } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const image = res.content.find((c) => c.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(PNG.toString("base64"));
  });

  it("(e) get_asset renders a region zoom via the render-cache from the SERVER-SIDE source", async () => {
    renderTargets.length = 0;
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", region: [0.1, 0.1, 0.6, 0.7], target_pixels: 1024 } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    // The render source is the asset revision's own sha256, not a caller value.
    expect(renderTargets[0]?.sourceSha256).toBe(SERVER_SHA);
    const meta = jsonOf(res);
    expect(meta.asset_id).toBe("asset-1@region");
    expect(meta.region).toEqual([0.1, 0.1, 0.6, 0.7]);
    const image = res.content.find((c) => c.type === "image");
    expect(image?.data).toBe(PNG.toString("base64"));
  });

  it("(e) get_asset accepts a caller source_sha256 only when it matches the server-side one", async () => {
    renderTargets.length = 0;
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", region: [0.1, 0.1, 0.6, 0.7], source_sha256: SERVER_SHA.toUpperCase() } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(renderTargets[0]?.sourceSha256).toBe(SERVER_SHA);
  });

  it("(e) get_asset FAILS CLOSED when the caller's source_sha256 differs — no render, no image", async () => {
    renderTargets.length = 0;
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", region: [0.1, 0.1, 0.6, 0.7], source_sha256: "a".repeat(64) } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === "image")).toBe(false);
    expect(renderTargets).toHaveLength(0);
  });

  it("(e) get_asset FAILS CLOSED when the revision has no resolvable source", async () => {
    renderTargets.length = 0;
    serverSourceSha = null;
    try {
      const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", region: [0.1, 0.1, 0.6, 0.7], source_sha256: "a".repeat(64) } })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(res.content.some((c) => c.type === "image")).toBe(false);
      expect(renderTargets).toHaveLength(0);
    } finally {
      serverSourceSha = SERVER_SHA;
    }
  });

  it("(e) get_asset rejects a malformed source_sha256 at the schema", async () => {
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", region: [0.1, 0.1, 0.6, 0.7], source_sha256: "../../x" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === "image")).toBe(false);
  });

  it("(e) get_asset FAILS CLOSED on an expected-document mismatch — no image", async () => {
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", expected_document_reference: "docs/OTHER.pdf" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === "image")).toBe(false);
    expect(textOf(res)).toContain("No authorized image asset");
  });

  it("(e) get_asset tolerates a #unit: suffix on expected_document_reference (hit refs are suffixed)", async () => {
    // v2 units store `${reference}#unit:${unitId}` and hits expose that form;
    // a model copying a hit's reference must not be denied the asset.
    const res = (await client.callTool({
      name: "get_asset",
      arguments: {
        asset_id: "asset-1",
        expected_document_reference:
          "docs/manual.pdf#unit:e8091f11a5c24b0e9d1f0a2b3c4d5e6f",
      },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
  });

  it("(e) get_asset still FAILS CLOSED for a different reference carrying a #unit: suffix", async () => {
    const res = (await client.callTool({
      name: "get_asset",
      arguments: {
        asset_id: "asset-1",
        expected_document_reference:
          "docs/OTHER.pdf#unit:e8091f11a5c24b0e9d1f0a2b3c4d5e6f",
      },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === "image")).toBe(false);
    expect(textOf(res)).toContain("No authorized image asset");
  });

  it("(e) get_asset FAILS CLOSED on an expected-figure mismatch — no image", async () => {
    const res = (await client.callTool({ name: "get_asset", arguments: { asset_id: "asset-1", expected_figure_id: "fig-999" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === "image")).toBe(false);
  });

  it("(f) get_table reassembles a table's row-groups across pages by table_id", async () => {
    const doc = jsonOf((await client.callTool({ name: "get_table", arguments: { table_id: "tbl-1" } })) as ToolResult);
    expect(doc.table_id).toBe("tbl-1");
    expect(doc.row_groups).toBe(2);
    expect(String(doc.markdown)).toContain("| 1 | 2 |");
    expect(String(doc.markdown)).toContain("| 3 | 4 |");
    expect(doc.pages).toMatchObject({ from: 10, to: 11 });
  });

  it("(g) find_identifier returns exact occurrences from vs_identifiers, paginated", async () => {
    const doc = jsonOf((await client.callTool({ name: "find_identifier", arguments: { value: "WE-01/A", limit: 1, offset: 0 } })) as ToolResult);
    expect(doc.value_norm).toBe("WE01A"); // normalized: upper-case, separators dropped
    expect(doc.total).toBe(4);
    expect(doc.truncated).toBe(true);
    const occ = doc.occurrences as Array<Record<string, unknown>>;
    expect(occ[0]).toMatchObject({ unit_id: "u9", page: 12, base_ref: "docs/manual.pdf" });
  });

  it("(h) follow_ref resolves a unit's referenced figures", async () => {
    const doc = jsonOf((await client.callTool({ name: "follow_ref", arguments: { unit_id: "u1" } })) as ToolResult);
    expect((doc.unit as Record<string, unknown>).unit_id).toBe("u1");
    const figures = (doc.references as { figures: Array<Record<string, unknown>> }).figures;
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ figure_id: "fig-7", asset_id: "asset-1" });
  });

  it("search: a reranked minScore is not applied to retrieval scores when reranking is unavailable", async () => {
    // No reranker is configured here, so rerank:true falls back to retrieval
    // scores; comparing them with a cross-encoder threshold would be arbitrary.
    const res = (await client.callTool({
      name: "search",
      arguments: { query: "Anmeldung", rerank: true, minScore: 0.3, hybrid: true },
    })) as ToolResult;
    if (res.isError) throw new Error(`search errored: ${textOf(res)}`);
    const doc = jsonOf(res) as {
      score_scale?: string;
      score_filter?: { applied: boolean; skipped?: string };
      abstention?: { skipped?: string; threshold_scale?: string; abstain: boolean };
    };
    expect(doc.score_scale).toBe("rrf");
    expect(doc.score_filter).toMatchObject({ applied: false, skipped: "scale_mismatch" });
    expect(doc.abstention).toMatchObject({ skipped: "scale_mismatch", threshold_scale: "rerank", abstain: false });
  });

  it("(i) search accepts the v2 params (expand/budget_chars/group_by_section) without error", async () => {
    // The MCP `search` tool exposes the task-13.3 v2 params; they flow through
    // the shared v1/v2 search path (expansion + section grouping).
    const res = (await client.callTool({
      name: "search",
      arguments: {
        query: "Anmeldung",
        expand: "section",
        budget_chars: 4000,
        group_by_section: true,
      },
    })) as ToolResult;
    if (res.isError) throw new Error(`search errored: ${textOf(res)}`);
    const doc = jsonOf(res);
    expect(doc).toHaveProperty("results");
  });

  it("every tool declares readOnlyHint; only ingest and delete_document may write", async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    for (const tool of tools.tools) {
      const writes = tool.name === "ingest" || tool.name === "delete_document";
      expect({ name: tool.name, readOnlyHint: tool.annotations?.readOnlyHint }).toEqual({
        name: tool.name,
        readOnlyHint: !writes,
      });
    }
    for (const name of ["search", "get_outline", "get_section", "get_document"]) {
      expect(tools.tools.some((t) => t.name === name)).toBe(true);
    }
  });

  it("(i) the search tool advertises the v2 params in its schema", async () => {
    const tools = await client.listTools();
    const search = tools.tools.find((t) => t.name === "search");
    if (search === undefined) throw new Error("search tool not registered");
    const schema = search.inputSchema as { properties?: Record<string, unknown> };
    const props = schema.properties ?? {};
    for (const p of [
      "expand", "budget_chars", "group_by_section", "filter_v2", "path_prefix", "hyde", "rerank",
      "granularity", "include_assets", "group_by", "pages", "unit_type", "figure_kind",
      "section_prefix", "identifier", "identifier_search",
    ]) {
      expect(props).toHaveProperty(p);
    }
  });

  it("(i) search: legacy calls keep the identifier list OFF; v2 params switch it on", async () => {
    searchCalls.length = 0;
    await client.callTool({ name: "search", arguments: { query: "Maske WE-01/A" } });
    expect((searchCalls[0]?.[20] as { identifierList?: boolean } | undefined)?.identifierList).not.toBe(true);

    searchCalls.length = 0;
    const res = (await client.callTool({
      name: "search",
      arguments: {
        query: "Maske",
        granularity: "chunk",
        include_assets: "refs",
        group_by: "section",
        pages: [37, 38],
        figure_kind: "ui_mask",
        section_prefix: ["4 Antragseingang"],
        identifier: "we-01/a",
        expand: "none",
      },
    })) as ToolResult;
    if (res.isError) throw new Error(`search errored: ${textOf(res)}`);
    const args = searchCalls[0] ?? [];
    expect(args[20]).toEqual({ identifierList: true, identifiers: ["we-01/a"] });
    const filter = args[5] as Record<string | symbol, unknown>;
    const unitKey = Object.getOwnPropertySymbols(filter).find((k) => String(k).includes("unit"));
    expect(unitKey).toBeDefined();
    expect(filter[unitKey as symbol]).toMatchObject({
      unitType: "chunk",
      figureKind: "ui_mask",
      pageStart: 37,
      pageEnd: 38,
      sectionPrefix: ["4 Antragseingang"],
    });
  });

  it("(i) search: identifier_search=false keeps the list off even in v2 mode", async () => {
    searchCalls.length = 0;
    await client.callTool({ name: "search", arguments: { query: "WE01", granularity: "chunk", identifier_search: false } });
    expect(searchCalls[0]?.[20]).toBeUndefined();
  });

  it("(i) search: an invalid v2 filter is a tool error", async () => {
    const res = (await client.callTool({ name: "search", arguments: { query: "x", pages: [9, 2] } })) as ToolResult;
    expect(res.isError).toBe(true);
  });

  it("(j) ACL: every navigation read receives the caller's tenant-scoped principal", async () => {
    await client.callTool({ name: "get_outline", arguments: { reference: "docs/manual.pdf" } });
    // Every captured scope carries the acting user; none is a wildcard/no-principal.
    expect(capturedScopes.length).toBeGreaterThan(0);
    for (const scope of capturedScopes) {
      const s = scope as { userId?: string; principal?: { source?: string } } | undefined;
      expect(s).toBeDefined();
      expect(s?.userId).toBe("alice");
    }
  });
});
