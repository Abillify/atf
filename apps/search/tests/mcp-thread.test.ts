// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * mcp-thread.test.ts
 *
 * The `get_thread` MCP tool against a fake PostgresClient: a message reference
 * resolves to its thread, the messages come back chronologically with their
 * own references, `path_prefix` keeps messages of other folders out, and a
 * thread larger than `max_chars` pages with `offset`/`next_offset`.
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

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const jsonOf = (r: ToolResult): Record<string, unknown> => JSON.parse(r.content.find((c) => c.type === "text")?.text ?? "{}");
const textOf = (r: ToolResult): string => r.content.find((c) => c.type === "text")?.text ?? "";

const THREAD = { id: "thread-1", kind: "email_thread", title: "WE-Maske" };
const MEMBERS = ["/A/mail/1.eml", "/A/mail/2.eml", "/B/mail/3.eml"];
const BODY: Record<string, string> = {
  "/A/mail/1.eml": "Anforderung WE-01: Pflichtfeld Lieferant.",
  "/A/mail/2.eml": "Ja, passt.",
  "/B/mail/3.eml": "Weitergeleitet an Team B.",
  "/A/notes.pdf": "Kein Thread.",
};

function fakePg(): Record<string, unknown> {
  return {
    getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
    getDocument: vi.fn(async (_c: string, _s: unknown, reference: string, options?: { maxChars?: number }) => {
      const body = BODY[reference];
      if (body === undefined) return { ok: true, result: null };
      const max = options?.maxChars ?? 40_000;
      return {
        ok: true,
        result: { reference, title: "WE-Maske", content: body.slice(0, max), truncated: body.length > max, totalChars: body.length },
      };
    }),
    resolveDocumentGroups: vi.fn(async (_c: string, _s: unknown, refs: string[]) => {
      const map = new Map<string, typeof THREAD>();
      for (const r of refs) if (MEMBERS.includes(r)) map.set(r, THREAD);
      return { ok: true, result: map };
    }),
    listThreadMembers: vi.fn(async (_c: string, _s: unknown, id: string) => ({
      ok: true,
      result: id === THREAD.id ? MEMBERS : [],
    })),
  };
}

describe("MCP get_thread", () => {
  let client: Client;
  let server: Server;
  let closeHandlers: () => void;

  beforeAll(async () => {
    const handlers = createMcpHandlers({
      embeddingClient: { embed: vi.fn() },
      postgresClient: fakePg(),
      sparseClient: null,
      queryCache: null,
      logger,
      transactionConfig: { enforcement: "off", secret: "x".repeat(32), issuer: "o", audience: "vectorsearch", clockToleranceSeconds: 0, maxTtlSeconds: 300 },
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
    client = new Client({ name: "thread-test", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeHandlers();
  });

  const call = async (args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name: "get_thread", arguments: args })) as ToolResult;

  it("resolves a message reference to its thread and returns every message in order", async () => {
    const doc = jsonOf(await call({ reference: "/A/mail/2.eml" }));
    expect(doc.thread_id).toBe("thread-1");
    expect(doc.subject).toBe("WE-Maske");
    expect((doc.messages as Array<{ reference: string }>).map((m) => m.reference)).toEqual(MEMBERS);
    expect(doc.truncated).toBe(false);
    expect(doc.next_offset).toBeUndefined();
  });

  it("path_prefix keeps the messages of other folders out and counts them", async () => {
    const doc = jsonOf(await call({ reference: "thread-1", path_prefix: "/A" }));
    expect((doc.messages as Array<{ reference: string }>).map((m) => m.reference)).toEqual(["/A/mail/1.eml", "/A/mail/2.eml"]);
    expect(doc.outside_prefix).toBe(1);
    expect(doc.total).toBe(2);
  });

  it("pages a thread larger than max_chars with offset / next_offset", async () => {
    // 1000 is the minimum budget; the first message alone is shorter, so pin a
    // budget that the first two messages exhaust by growing message 1.
    BODY["/A/mail/1.eml"] = "x".repeat(1500);
    try {
      const first = jsonOf(await call({ reference: "thread-1", max_chars: 1000 }));
      expect((first.messages as unknown[]).length).toBe(1);
      expect(first.truncated).toBe(true);
      expect(first.next_offset).toBe(1);
      const second = jsonOf(await call({ reference: "thread-1", max_chars: 1000, offset: 1 }));
      expect((second.messages as Array<{ reference: string }>).map((m) => m.reference)).toEqual(["/A/mail/2.eml", "/B/mail/3.eml"]);
      expect(second.offset).toBe(1);
      expect(second.truncated).toBe(false);
    } finally {
      BODY["/A/mail/1.eml"] = "Anforderung WE-01: Pflichtfeld Lieferant.";
    }
  });

  it("refuses a document that is not part of a thread", async () => {
    const res = await call({ reference: "/A/notes.pdf" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not part of an e-mail thread");
  });
});
