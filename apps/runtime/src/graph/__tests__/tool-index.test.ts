// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dynamic tool retrieval — ToolIndex tests (`src/graph/tool-index.ts`)
 *
 * Verifies lazy embedding, concurrency-safe de-duplication, graceful handling
 * of unavailable tools, and cosine-similarity ranking with topK / minScore.
 *
 * Both dependencies (Embedder, McpWrapperService) are injected fakes, so no
 * real embedding model or MCP server is required.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ToolIndex } from "../tool-index.js";
import type { Embedder } from "../semantic-cache.js";
import type { McpWrapperService, FilteredToolSchema } from "../../mcp/mcp-wrapper.js";

// ---------------------------------------------------------------------------
// Fake embedder — a 3-topic one-hot vector so cosine scores are predictable.
// ---------------------------------------------------------------------------

const TOPICS = ["vacation", "invoice", "weather"] as const;

class CountingEmbedder implements Embedder {
  calls = 0;
  async embed(text: string): Promise<number[]> {
    this.calls += 1;
    const t = text.toLowerCase();
    return TOPICS.map((k) => (t.includes(k) ? 1 : 0));
  }
}

// ---------------------------------------------------------------------------
// Fake MCP wrapper — only getFilteredToolSchema is used by ToolIndex.
// ---------------------------------------------------------------------------

class FakeMcp {
  getSchemaCalls = 0;
  readonly schemaCallsByToken = new Map<string, number>();
  readonly resourceCallsByToken = new Map<string, number>();
  readonly resourceTemplateCallsByToken = new Map<string, number>();
  readonly promptCallsByToken = new Map<string, number>();
  readonly resourceResults = new Map<
    string,
    { resources: Array<{ uri: string; name: string; description?: string }>; ttlMs?: number }
  >();
  constructor(
    readonly schemas: Map<string, FilteredToolSchema>,
    readonly failing: Set<string>,
  ) {}
  async getFilteredToolSchema(
    server: string,
    tool: string,
    opts?: { authToken?: string },
  ): Promise<FilteredToolSchema> {
    this.getSchemaCalls += 1;
    const token = opts?.authToken ?? "shared";
    this.schemaCallsByToken.set(token, (this.schemaCallsByToken.get(token) ?? 0) + 1);
    const ref = server === "" ? tool : `${server}/${tool}`;
    const scopedRef = `${token}\u0000${ref}`;
    if (this.failing.has(scopedRef) || this.failing.has(ref)) throw new Error("server down");
    const s = this.schemas.get(scopedRef) ?? this.schemas.get(ref);
    if (s === undefined) throw new Error(`unknown tool: ${ref}`);
    return s;
  }

  async listResources(
    _server: string,
    opts?: { authToken?: string },
  ): Promise<{
    resources: Array<{ uri: string; name: string; description?: string }>;
    ttlMs?: number;
  }> {
    const token = opts?.authToken ?? "shared";
    this.resourceCallsByToken.set(token, (this.resourceCallsByToken.get(token) ?? 0) + 1);
    return this.resourceResults.get(token) ?? { resources: [] };
  }

  async listResourceTemplates(
    _server: string,
    opts?: { authToken?: string },
  ): Promise<{ resourceTemplates: [] }> {
    const token = opts?.authToken ?? "shared";
    this.resourceTemplateCallsByToken.set(
      token,
      (this.resourceTemplateCallsByToken.get(token) ?? 0) + 1,
    );
    return { resourceTemplates: [] };
  }

  async listPrompts(_server: string, opts?: { authToken?: string }): Promise<{ prompts: [] }> {
    const token = opts?.authToken ?? "shared";
    this.promptCallsByToken.set(token, (this.promptCallsByToken.get(token) ?? 0) + 1);
    return { prompts: [] };
  }
}

function schema(
  name: string,
  description: string,
  props: Record<string, unknown>,
  required?: string[],
): FilteredToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: props,
      ...(required !== undefined ? { required } : {}),
    },
  };
}

let embedder: CountingEmbedder;
let mcp: FakeMcp;

function mkIndex(): ToolIndex {
  const schemas = new Map<string, FilteredToolSchema>([
    [
      "hr/vacation_create",
      schema(
        "vacation_create",
        "Create a vacation request",
        {
          days: { type: "number" },
        },
        ["days"],
      ),
    ],
    [
      "billing/invoice_lookup",
      schema("invoice_lookup", "Look up an invoice", {
        id: { type: "string" },
      }),
    ],
    // A ref with no server ("weather") — exercises splitRef's single-part path
    // and toolEmbeddingText's no-description / no-params / unspaced-name branches.
    ["weather", schema("weather", "", {})],
  ]);
  const failing = new Set<string>(["down/broken"]);
  embedder = new CountingEmbedder();
  mcp = new FakeMcp(schemas, failing);
  return new ToolIndex(embedder, mcp as unknown as McpWrapperService);
}

beforeEach(() => {
  // fresh index per test
});

// ---------------------------------------------------------------------------

describe("ToolIndex.select — guards", () => {
  test("returns [] for a blank query", async () => {
    const idx = mkIndex();
    expect(await idx.select("   ", ["hr/vacation_create"], { topK: 5 })).toEqual([]);
  });

  test("returns [] for an empty pool", async () => {
    const idx = mkIndex();
    expect(await idx.select("vacation", [], { topK: 5 })).toEqual([]);
  });

  test("returns [] when topK is zero", async () => {
    const idx = mkIndex();
    const hits = await idx.select("vacation", ["hr/vacation_create"], {
      topK: 0,
    });
    expect(hits).toEqual([]);
  });
});

describe("ToolIndex.select — ranking", () => {
  test("ranks the semantically closest tool first", async () => {
    const idx = mkIndex();
    const hits = await idx.select(
      "I need to book vacation days",
      ["hr/vacation_create", "billing/invoice_lookup", "weather"],
      { topK: 5 },
    );
    expect(hits[0]?.ref).toBe("hr/vacation_create");
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits[0]?.description).toBe("Create a vacation request");
    expect(hits[0]?.inputSchema?.properties).toHaveProperty("days");
  });

  test("minScore filters out unrelated tools", async () => {
    const idx = mkIndex();
    const hits = await idx.select(
      "vacation",
      ["hr/vacation_create", "billing/invoice_lookup", "weather"],
      { topK: 5, minScore: 0.5 },
    );
    expect(hits.map((h) => h.ref)).toEqual(["hr/vacation_create"]);
  });

  test("topK caps the number of returned hits", async () => {
    const idx = mkIndex();
    const hits = await idx.select(
      "vacation invoice weather",
      ["hr/vacation_create", "billing/invoice_lookup", "weather"],
      { topK: 2 },
    );
    expect(hits).toHaveLength(2);
  });

  test("de-duplicates repeated refs in the pool", async () => {
    const idx = mkIndex();
    const hits = await idx.select("vacation", ["hr/vacation_create", "hr/vacation_create"], {
      topK: 5,
    });
    expect(hits).toHaveLength(1);
  });

  test("omits tools whose schema cannot be fetched", async () => {
    const idx = mkIndex();
    const hits = await idx.select("anything", ["down/broken"], { topK: 5 });
    expect(hits).toEqual([]);
  });
});

describe("ToolIndex.ensure / getDescription", () => {
  test("getDescription is undefined before embedding and set afterwards", async () => {
    const idx = mkIndex();
    expect(idx.getDescription("hr/vacation_create")).toBeUndefined();
    await idx.ensure(["hr/vacation_create"]);
    expect(idx.getDescription("hr/vacation_create")).toBe("Create a vacation request");
  });

  test("does not record a description for a tool with an empty description", async () => {
    const idx = mkIndex();
    await idx.ensure(["weather"]);
    expect(idx.getDescription("weather")).toBeUndefined();
  });

  test("embeds each ref exactly once across repeated ensure calls", async () => {
    const idx = mkIndex();
    await idx.ensure(["hr/vacation_create", "billing/invoice_lookup"]);
    const afterFirst = embedder.calls;
    expect(afterFirst).toBe(2);
    await idx.ensure(["hr/vacation_create", "billing/invoice_lookup"]);
    // No new embeddings — refs are cached.
    expect(embedder.calls).toBe(afterFirst);
  });

  test("concurrent ensure calls de-duplicate in-flight work", async () => {
    const idx = mkIndex();
    const pool = ["hr/vacation_create", "billing/invoice_lookup"];
    await Promise.all([idx.ensure(pool), idx.ensure(pool)]);
    // Each ref embedded once despite the overlapping calls.
    expect(embedder.calls).toBe(2);
    expect(mcp.getSchemaCalls).toBe(2);
  });

  test("does not retry a ref whose schema fetch failed", async () => {
    const idx = mkIndex();
    await idx.ensure(["down/broken"]);
    const firstCalls = mcp.getSchemaCalls;
    await idx.ensure(["down/broken"]);
    // The failed ref is remembered and not re-fetched.
    expect(mcp.getSchemaCalls).toBe(firstCalls);
  });
});

describe("ToolIndex token scopes", () => {
  test("partitions schemas, descriptions, and embeddings by token without changing hit refs", async () => {
    const idx = mkIndex();
    const ref = "hr/vacation_create";
    mcp.schemas.set(
      `token-a\u0000${ref}`,
      schema("vacation_create", "Vacation for token A", { leave: { type: "string" } }),
    );
    mcp.schemas.set(
      `token-b\u0000${ref}`,
      schema("vacation_create", "Invoice for token B", { invoice: { type: "string" } }),
    );

    const aHits = await idx.select("vacation", [ref], { topK: 1, authToken: "token-a" });
    const bHits = await idx.select("invoice", [ref], { topK: 1, authToken: "token-b" });

    expect(aHits[0]).toMatchObject({ ref, description: "Vacation for token A" });
    expect(aHits[0]?.inputSchema?.properties).toHaveProperty("leave");
    expect(bHits[0]).toMatchObject({ ref, description: "Invoice for token B" });
    expect(bHits[0]?.inputSchema?.properties).toHaveProperty("invoice");
    expect(idx.getDescription(ref, { authToken: "token-a" })).toBe("Vacation for token A");
    expect(idx.getDescription(ref, { authToken: "token-b" })).toBe("Invoice for token B");
  });

  test("deduplicates concurrent work within a token but not across tokens", async () => {
    const idx = mkIndex();
    const ref = "hr/vacation_create";
    await Promise.all([
      idx.ensure([ref], { authToken: "token-a" }),
      idx.ensure([ref], { authToken: "token-a" }),
      idx.ensure([ref], { authToken: "token-b" }),
    ]);

    expect(mcp.schemaCallsByToken.get("token-a")).toBe(1);
    expect(mcp.schemaCallsByToken.get("token-b")).toBe(1);
  });

  test("does not let a failed token scope block another token", async () => {
    const idx = mkIndex();
    const ref = "hr/vacation_create";
    mcp.failing.add(`token-a\u0000${ref}`);

    await idx.ensure([ref], { authToken: "token-a" });
    await idx.ensure([ref], { authToken: "token-b" });
    await idx.ensure([ref], { authToken: "token-a" });

    expect(mcp.schemaCallsByToken.get("token-a")).toBe(1);
    expect(mcp.schemaCallsByToken.get("token-b")).toBe(1);
    expect(idx.getDescription(ref, { authToken: "token-b" })).toBe("Create a vacation request");
  });

  test("partitions capability discovery and TTL by token while forwarding auth", async () => {
    const idx = mkIndex();
    mcp.resourceResults.set("token-a", {
      resources: [{ uri: "aiperator://a", name: "vacation", description: "Vacation resource" }],
      ttlMs: 60_000,
    });
    mcp.resourceResults.set("token-b", {
      resources: [{ uri: "aiperator://b", name: "invoice", description: "Invoice resource" }],
      ttlMs: 60_000,
    });

    const [aHits, bHits] = await Promise.all([
      idx.selectCapabilities("vacation", ["docs"], {
        topK: 5,
        authToken: "token-a",
        kinds: ["resource"],
      }),
      idx.selectCapabilities("invoice", ["docs"], {
        topK: 5,
        authToken: "token-b",
        kinds: ["resource"],
      }),
    ]);
    await idx.selectCapabilities("vacation", ["docs"], {
      topK: 5,
      authToken: "token-a",
      kinds: ["resource"],
    });

    expect(aHits).toMatchObject([
      { ref: "docs#resource:aiperator://a", description: "Vacation resource" },
    ]);
    expect(bHits).toMatchObject([
      { ref: "docs#resource:aiperator://b", description: "Invoice resource" },
    ]);
    expect(mcp.resourceCallsByToken.get("token-a")).toBe(1);
    expect(mcp.resourceCallsByToken.get("token-b")).toBe(1);
    expect(mcp.resourceTemplateCallsByToken.get("token-a")).toBe(1);
    expect(mcp.resourceTemplateCallsByToken.get("token-b")).toBe(1);
    expect(mcp.promptCallsByToken.get("token-a")).toBe(1);
    expect(mcp.promptCallsByToken.get("token-b")).toBe(1);
  });
});
