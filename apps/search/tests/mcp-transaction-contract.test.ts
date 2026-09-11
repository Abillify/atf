// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import request from "supertest";
import { createMcpHandlers, createMcp2026Handlers } from "../src/handlers/mcp.js";

const secret = "0123456789abcdef0123456789abcdef";
const logger = pino({ level: process.env.MCP_TEST_LOG_LEVEL ?? "silent" });
const principal = { userId: "alice", userGroups: ["legal"], source: "jwt" as const };

async function issue(userId = "alice", invocationId = "task-8-vector-invocation", scopes = ["retrieve"], executionId = "task-8-exec") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    version: "v1", iss: "orchestrator", aud: "vectorsearch", iat: now, exp: now + 60,
    jti: `task-8-contract-${invocationId}`, executionId, invocationId, userId,
    scopes, groups: ["legal"], budget: { maxRetrievalDocuments: 7 },
    delegationChain: [], trace: { traceId: "task-8-trace", deadlineAt: Date.now() + 10_000 },
  }).setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).sign(new TextEncoder().encode(secret));
}

describe("vectorsearch real MCP transaction _meta contract", () => {
  let server: Server;
  let client: Client;
  let closeHandlers: () => void;
  const deleteDocument = vi.fn(async () => ({ ok: true, result: { deleted: 1 } }));

  beforeAll(async () => {
    const handlers = createMcpHandlers({
      embeddingClient: { embed: vi.fn() },
      postgresClient: {
        getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
        delete: deleteDocument,
      }, sparseClient: null, queryCache: null, logger,
      transactionConfig: { enforcement: "required", secret, issuer: "orchestrator", audience: "vectorsearch", clockToleranceSeconds: 0, maxTtlSeconds: 300 },
      authzEnforcement: "off",
    } as never);
    closeHandlers = handlers.close;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as typeof req & { principal: typeof principal }).principal = principal; next(); });
    app.post("/mcp", handlers.post);
    app.get("/mcp", handlers.get);
    app.delete("/mcp", handlers.delete);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    client = new Client({ name: "task-8-test", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    closeHandlers();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("returns capabilities without a transaction token so orchestrators can negotiate v1", async () => {
    const result = await client.callTool({ name: "transaction_capabilities", arguments: {} });
    const document = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(document).toMatchObject({
      schemaVersion: "v1",
      service: "vectorsearch",
      enforcement: "required",
      token: {
        locations: ["params._meta[transaction/token]", "X-Transaction-Token"],
        compatibilityAliases: ["params._meta[aiperator/transactionToken]"],
        algorithm: "HS256",
        issuer: "orchestrator",
        audience: "vectorsearch",
      },
    });
    expect(document.budgets).toEqual(["maxDurationMs", "maxRetrievalDocuments"]);
    expect(document.idempotency).toMatchObject({ supported: true, committedReplay: true, durability: "single-process" });
  });

  it("replays a committed write without executing it twice", async () => {
    const transactionToken = await issue("alice", "delete-replay", ["delete"]);
    const request = { name: "delete_document", arguments: { reference: "doc-1" }, _meta: { "transaction/token": transactionToken } };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first).toEqual(second);
    expect(deleteDocument).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict when an invocation is reused with a different payload", async () => {
    const transactionToken = await issue("alice", "delete-mismatch", ["write"]);
    await client.callTool({ name: "delete_document", arguments: { reference: "doc-a" }, _meta: { "transaction/token": transactionToken } });
    const conflict = await client.callTool({ name: "delete_document", arguments: { reference: "doc-b" }, _meta: { "transaction/token": transactionToken } });
    expect(conflict.isError).toBe(true);
    expect((conflict.content as Array<{ text: string }>)[0]!.text).toContain("IDEMPOTENCY_KEY_MISMATCH");
  });

  it("denies write calls without a write/tool-specific scope", async () => {
    const denied = await client.callTool({ name: "delete_document", arguments: { reference: "doc-denied" }, _meta: { "transaction/token": await issue("alice", "delete-denied", ["read"]) } });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0]!.text).toContain("TOOL_SCOPE_DENIED");
  });

  it("serves stateless 2026 discovery and the shared paginated tool catalog", async () => {
    const handlers = createMcp2026Handlers({
      embeddingClient: { embed: vi.fn() },
      postgresClient: {
        getCollectionAcl: vi.fn(async () => ({ ok: true, result: { allowedUsers: ["alice"], allowedGroups: [] } })),
        delete: deleteDocument,
      }, sparseClient: null, queryCache: null, logger,
      transactionConfig: { enforcement: "required", secret, issuer: "orchestrator", audience: "vectorsearch", clockToleranceSeconds: 0, maxTtlSeconds: 300 },
      authzEnforcement: "off",
      serviceName: "vectorsearch-internal",
      serviceVersion: "2026.1",
    } as never);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as typeof req & { principal: typeof principal }).principal = principal; next(); });
    app.post(handlers.path, handlers.post);
    app.get(handlers.path, handlers.get);

    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    const discover = await request(app).post(handlers.path)
      .set("MCP-Protocol-Version", "2026-07-28").set("Mcp-Method", "server/discover")
      .send({ jsonrpc: "2.0", id: 1, method: "server/discover", _meta: meta });
    expect(discover.status).toBe(200);
    expect(discover.body.result).toMatchObject({
      resultType: "complete",
      serverInfo: { name: "vectorsearch-internal", version: "2026.1", protocolVersion: "2026-07-28" },
      capabilities: { tools: { list: true, call: true, pagination: true } },
      extensions: {
        "io.modelcontextprotocol/transaction": {
          schemaVersion: "v1",
          tokenLocations: ["params._meta[transaction/token]", "X-Transaction-Token"],
        },
      },
    });

    const list = await request(app).post(handlers.path)
      .set("MCP-Protocol-Version", "2026-07-28").set("Mcp-Method", "tools/list")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { pageSize: 1 }, _meta: meta });
    expect(list.status).toBe(200);
    expect(list.body.result.resultType).toBe("complete");
    expect(list.body.result.tools).toHaveLength(1);
    expect(list.body.result.nextCursor).toBe("1");

    const fullList = await request(app).post(handlers.path)
      .set("MCP-Protocol-Version", "2026-07-28").set("Mcp-Method", "tools/list")
      .send({ jsonrpc: "2.0", id: 22, method: "tools/list", params: { pageSize: 100 }, _meta: meta });
    const tools = fullList.body.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    for (const name of ["search", "retrieve_evidence", "verified_evidence_pack"]) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema.properties).toHaveProperty("valid_at");
    }
    expect(tools.find((tool) => tool.name === "ingest")?.inputSchema.properties).toMatchObject({
      valid_from: expect.any(Object),
      version_mode: expect.any(Object),
    });

    const mismatch = await request(app).post(handlers.path)
      .set("MCP-Protocol-Version", "2026-07-28").set("Mcp-Method", "tools/call").set("Mcp-Name", "other")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: {} }, _meta: meta });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.message).toBe("HeaderMismatch");
  });

  it("fails a protected real MCP request before dispatch on principal mismatch", async () => {
    await expect(
      client.callTool({
        name: "delete_document",
        arguments: { reference: "doc-principal-mismatch" },
        _meta: {
          "transaction/token": await issue(
            "mallory",
            "mismatch-invocation",
            ["delete"],
          ),
        },
      }),
    ).rejects.toThrow();
  });
});
