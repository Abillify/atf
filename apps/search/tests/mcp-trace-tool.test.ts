// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * The MCP `trace` tool end to end through the real MCP server and SDK client,
 * against a fake store: only hits that contain the identifier itself count
 * as occurrences (the lexical list ORs its tokens), and the activity event
 * never carries the identifier the caller searched for.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandlers } from "../src/handlers/mcp.js";
import { offActivity, onActivity, type ActivityEvent } from "../src/activity-emitter.js";
import { identifierMatcher } from "../src/traceability.js";

const logger = pino({ level: "silent" });
const principal = { userId: "alice", userGroups: [], source: "jwt" as const };
const instant = new Date("2026-03-01T00:00:00.000Z");
const IDENTIFIER = "WE-01/A";

const hit = (id: string, content: string, section: string) => ({
  id,
  score: 0.5,
  content,
  metadata: {},
  reference: `richtlinie.pdf#unit:${id}`,
  base_ref: "richtlinie.pdf",
  evidence: { reference: `richtlinie.pdf#unit:${id}`, root_document_id: "richtlinie.pdf", section_path: [section] },
  created: instant,
  modified: instant,
  valid_from: null,
  effective_valid_from: instant,
});

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (r: ToolResult): string => r.content.find((c) => c.type === "text")?.text ?? "";

describe("identifierMatcher", () => {
  const matches = identifierMatcher(IDENTIFIER);
  it("accepts the identifier with the separators normalisation ignores", () => {
    expect(matches("Bezug ist WE-01/A.")).toBe(true);
    expect(matches("bezug ist we 01 a")).toBe(true);
    expect(matches("(WE01A)")).toBe(true);
  });
  it("rejects partial token matches of the OR list", () => {
    expect(matches("Siehe WE-01/B")).toBe(false);
    expect(matches("Anlage A und WE-01")).toBe(false);
    expect(matches("WE-01/AB")).toBe(false);
    expect(matches("XWE-01/A")).toBe(false);
  });
  it("matches nothing for an identifier without letters or digits", () => {
    expect(identifierMatcher("/-/")("anything")).toBe(false);
  });
});

describe("MCP tool trace", () => {
  let client: Client;
  let server: Server;
  let closeHandlers: () => void;
  const searchLimits: number[] = [];
  const baseHits = [
    hit("u1", "Diese Richtlinie gilt; Bezug ist WE-01/A.", "1 Anwendung"),
    hit("u2", "Für den Sonderfall gilt WE-01/B.", "2 Sonderfall"),
    hit("u3", "Siehe Anlage A zu WE-01 der Vorfassung.", "3 Anlagen"),
  ];
  /** Mutable per-test: what the fake lexical lookup returns, per call (a, then b). */
  let fakeLookup: (callIndex: number) => ReturnType<typeof hit>[] = () => baseHits;

  beforeAll(async () => {
    const handlers = createMcpHandlers({
      embeddingClient: { embed: vi.fn() },
      postgresClient: {
        getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
        search: vi.fn(async (_query: string, _vector: number[], limit: number) => {
          searchLimits.push(limit);
          return { ok: true, result: fakeLookup(searchLimits.length - 1) };
        }),
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
    client = new Client({ name: "trace-test", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeHandlers();
  });

  it("counts only hits that contain the identifier and keeps it out of the activity stream", async () => {
    const events: ActivityEvent[] = [];
    const listener = (e: ActivityEvent) => {
      if ((e.detail as { tool?: string } | undefined)?.tool === "trace") events.push(e);
    };
    onActivity(listener);
    try {
      const res = (await client.callTool({
        name: "trace",
        arguments: {
          identifier: IDENTIFIER,
          valid_at_a: "2025-03-01T00:00:00Z",
          valid_at_b: "2025-07-01T00:00:00Z",
          limit: 10,
        },
      })) as ToolResult;
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(textOf(res)) as {
        unchanged_count: number;
        added: unknown[];
        removed: unknown[];
        truncated: boolean;
      };
      // The fake returns the same three hits at both instants; only u1 holds
      // the identifier, so exactly one occurrence is unchanged.
      expect(body.unchanged_count).toBe(1);
      expect(body.added).toEqual([]);
      expect(body.removed).toEqual([]);
      // Three hits stay far below the fetch window, so the result is complete.
      expect(body.truncated).toBe(false);
      // The lookup over-fetches to make room for the filtered partial hits.
      expect(searchLimits).toEqual([40, 40]);
      // Compact JSON by default (SEARCH_MCP_PRETTY_JSON off).
      expect(textOf(res)).not.toContain("\n");
    } finally {
      offActivity(listener);
    }
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(IDENTIFIER);
    expect(serialized).not.toContain("WE-01");
    expect(events[0]?.summary).toContain(`identifier[${IDENTIFIER.length} chars]`);
  });

  it("reports truncated when an instant fills the lookup window, keeping the counts it found", async () => {
    // 40 filler hits (none holding the identifier) on top of the three real
    // ones, truncated to the fetch window of 40: the window is full, so more
    // matches may exist beyond the cap even though only u1 survives the
    // identifier filter.
    const fillers = Array.from({ length: 40 }, (_unused, i) =>
      hit(`f${i}`, `Fülltreffer ${i} ohne jeden Bezug.`, `Füllabschnitt ${i}`),
    );
    fakeLookup = () => [...baseHits, ...fillers].slice(0, 40);
    searchLimits.length = 0;
    try {
      const res = (await client.callTool({
        name: "trace",
        arguments: {
          identifier: IDENTIFIER,
          valid_at_a: "2025-03-01T00:00:00Z",
          valid_at_b: "2025-07-01T00:00:00Z",
          limit: 10,
        },
      })) as ToolResult;
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(textOf(res)) as { unchanged_count: number; truncated: boolean };
      expect(body.truncated).toBe(true);
      // The occurrences actually found stay correct — truncated marks the
      // result as possibly incomplete, not as wrong.
      expect(body.unchanged_count).toBe(1);
    } finally {
      fakeLookup = () => baseHits;
    }
  });

  it("reports truncated when only the first instant hits the lookup cap", async () => {
    const fillers = Array.from({ length: 40 }, (_unused, i) =>
      hit(`f${i}`, `Fülltreffer ${i} ohne jeden Bezug.`, `Füllabschnitt ${i}`),
    );
    fakeLookup = (callIndex) => (callIndex === 0 ? [...baseHits, ...fillers].slice(0, 40) : baseHits);
    searchLimits.length = 0;
    try {
      const res = (await client.callTool({
        name: "trace",
        arguments: {
          identifier: IDENTIFIER,
          valid_at_a: "2025-03-01T00:00:00Z",
          valid_at_b: "2025-07-01T00:00:00Z",
          limit: 10,
        },
      })) as ToolResult;
      expect(res.isError).not.toBe(true);
      const body = JSON.parse(textOf(res)) as { truncated: boolean };
      expect(body.truncated).toBe(true);
    } finally {
      fakeLookup = () => baseHits;
    }
  });
});
