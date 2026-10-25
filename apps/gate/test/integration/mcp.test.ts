// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import { connectMcp, connectMcpStreamable } from "../helpers/mcp-client.ts";
import type { ILlmClient } from "../../src/llm/client.ts";
import { SignJWT } from "jose";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const TOKEN = "integration-token";
const OTHER_TENANT_TOKEN = "integration-token-other-tenant";

function baseConfig(extra: Record<string, unknown>) {
  return AppConfigSchema.parse({
    server: { port: 3000 },
    auth: {
      mode: "static",
      static: {
        tokens: [
          { token: TOKEN, username: "dev-user", scopes: ["tools:read"], claims: { tenant: "acme" } },
          { token: OTHER_TENANT_TOKEN, username: "dev-user", claims: { tenant: "other" } },
        ],
      },
    },
    monitoring: { enabled: true, token: "m" },
    ...extra,
  });
}

const DB_TOOL = {
  name: "my_orders",
  type: "database",
  database: "main",
  query: "SELECT id FROM orders WHERE owner = :ctx.username",
  inputSchema: { type: "object", properties: {}, required: [] },
};

describe("MCP integration · database tool", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;

  beforeAll(async () => {
    fakeDb = new FakeDb({ main: [{ id: 1, total: 9 }] });
    handle = await buildApp(baseConfig({ tools: [DB_TOOL] }), { db: fakeDb });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("rejects /sse without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sse`);
    expect(res.status).toBe(401);
  });

  it("gates the monitor stream behind its token", async () => {
    const noauth = await fetch(`http://127.0.0.1:${port}/monitor/stream`);
    expect(noauth.status).toBe(401);
  });

  it("lists configured tools", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, TOKEN);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("my_orders");
    await client.close();
  });

  it("executes a db tool, binding ctx.username", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, TOKEN);
    const res = await client.callTool({ name: "my_orders", arguments: {} });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0]?.text);
    expect(payload.rowCount).toBe(1);

    const last = fakeDb.last("main");
    expect(last?.sql).toContain("SELECT id FROM orders");
    expect(last?.bindings).toEqual(["dev-user"]);
    await client.close();
  });
});

describe("MCP integration · router (replace mode, mock LLM)", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;

  const fakeLlm = {
    route: async (_prompt: string, _systemPrompt: string, _tools: unknown[], _ctx: unknown) => ({
      kind: "tool",
      tool: "my_orders",
      arguments: {},
    }),
  } as unknown as ILlmClient;

  beforeAll(async () => {
    fakeDb = new FakeDb({ main: [{ id: 7 }] });
    const config = baseConfig({
      tools: [DB_TOOL],
      router: {
        enabled: true,
        mode: "replace",
        name: "ask",
        llm: { baseUrl: "http://127.0.0.1:9/v1" },
      },
    });
    handle = await buildApp(config, { db: fakeDb, llm: fakeLlm });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("exposes only the router tool in replace mode", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, TOKEN);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["ask"]);
    await client.close();
  });

  it("routes a natural-language prompt to the chosen tool", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, TOKEN);
    const res = await client.callTool({ name: "ask", arguments: { prompt: "show my orders" } });
    expect(res.isError).toBeFalsy();
    // The router dispatched to my_orders with the caller's identity bound.
    expect(fakeDb.last("main")?.sql).toContain("SELECT id FROM orders");
    expect(fakeDb.last("main")?.bindings).toEqual(["dev-user"]);
    await client.close();
  });
});

describe("MCP integration · Streamable HTTP transport (/mcp)", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;

  beforeAll(async () => {
    fakeDb = new FakeDb({ main: [{ id: 1, total: 9 }] });
    handle = await buildApp(baseConfig({ tools: [DB_TOOL] }), { db: fakeDb });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("rejects POST /mcp without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("binds GET and DELETE to the session tenant/security context", async () => {
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: {
          authorization: `Bearer ${OTHER_TENANT_TOKEN}`,
          "mcp-session-id": sessionId,
          accept: "application/json, text/event-stream",
        },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("security context does not match session");
    }

    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId },
    });
  });

  it("initializes, lists tools and executes a tool over Streamable HTTP", async () => {
    const client = await connectMcpStreamable(`http://127.0.0.1:${port}`, TOKEN);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("my_orders");

    const res = await client.callTool({ name: "my_orders", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(fakeDb.last("main")?.bindings).toEqual(["dev-user"]);

    await client.close();
  });
});

describe("MCP integration · Agent Transaction Fabric v1 _meta path", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;
  const secret = "0123456789abcdef0123456789abcdef";
  const previous = {
    enforcement: process.env.MCPGATE_TRANSACTION_ENFORCEMENT,
    secret: process.env.MCPGATE_TRANSACTION_HS256_SECRET,
    issuer: process.env.MCPGATE_TRANSACTION_ISSUER,
    audience: process.env.MCPGATE_TRANSACTION_AUDIENCE,
  };

  beforeAll(async () => {
    process.env.MCPGATE_TRANSACTION_ENFORCEMENT = "required";
    process.env.MCPGATE_TRANSACTION_HS256_SECRET = secret;
    process.env.MCPGATE_TRANSACTION_ISSUER = "aiperator";
    process.env.MCPGATE_TRANSACTION_AUDIENCE = "mcpgate";
    fakeDb = new FakeDb({ main: [{ id: 42 }] });
    handle = await buildApp(baseConfig({ tools: [DB_TOOL] }), { db: fakeDb });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
    for (const [key, value] of Object.entries({
      MCPGATE_TRANSACTION_ENFORCEMENT: previous.enforcement,
      MCPGATE_TRANSACTION_HS256_SECRET: previous.secret,
      MCPGATE_TRANSACTION_ISSUER: previous.issuer,
      MCPGATE_TRANSACTION_AUDIENCE: previous.audience,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("processes an aiperator token from params._meta and replays the committed result", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      version: "v1",
      iss: "aiperator",
      aud: "mcpgate",
      iat: now,
      exp: now + 60,
      jti: "task-8-mcp-jti",
      executionId: "task-8-exec",
      invocationId: "task-8-mcp-invocation",
      scopes: ["tools:read"],
      groups: [],
      budget: { maxRetrievalDocuments: 7 },
      delegationChain: [],
      trace: { deadlineAt: Date.now() + 10_000 },
    };
    const transactionToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .sign(new TextEncoder().encode(secret));
    const client = await connectMcpStreamable(`http://127.0.0.1:${port}`, TOKEN);
    const request = {
      name: "my_orders",
      arguments: {},
      _meta: { "aiperator/transactionToken": transactionToken },
    };
    expect((await client.callTool(request)).isError).toBeFalsy();
    expect((await client.callTool(request)).isError).toBeFalsy();
    expect(fakeDb.calls).toHaveLength(1);
    const capability = await client.callTool({
      name: "mcpgate_transaction_capabilities",
      arguments: {},
    });
    expect(capability.structuredContent).toMatchObject({
      version: "v1",
      tokenMetaKey: "transaction/token",
      tokenMetaAliases: ["aiperator/transactionToken"],
    });
    await client.close();
  });
});

describe("MCP integration · native stateless 2026-07-28 HTTP", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;

  const request = (
    method: string,
    params: Record<string, unknown> = {},
    options: {
      token?: string;
      protocol?: string;
      methodHeader?: string;
      nameHeader?: string;
      metaProtocol?: string;
    } = {},
  ) =>
    fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token ?? TOKEN}`,
        "content-type": "application/json",
        "MCP-Protocol-Version": options.protocol ?? "2026-07-28",
        "Mcp-Method": options.methodHeader ?? method,
        ...(method === "tools/call"
          ? { "Mcp-Name": options.nameHeader ?? String(params.name) }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
        _meta: { "io.modelcontextprotocol/protocolVersion": options.metaProtocol ?? "2026-07-28" },
      }),
    });

  beforeAll(async () => {
    fakeDb = new FakeDb({ main: [{ id: 5, total: 11 }] });
    handle = await buildApp(baseConfig({ tools: [DB_TOOL] }), { db: fakeDb });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("discovers only implemented capabilities and rejects non-POST methods", async () => {
    const response = await request("server/discover");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result).toMatchObject({
      resultType: "complete",
      serverInfo: { name: "mcpgate", version: "0.20.0" },
      protocolVersion: "2026-07-28",
      service: {
        name: "mcpgate",
        version: "0.20.0",
        endpoint: "/mcp/v2026",
        transport: "stateless-http",
      },
      features: {
        pagination: { cursor: true, defaultPageSize: 100, maxPageSize: 1000 },
        structuredResults: true,
        inputRequired: true,
        requestMetadata: ["transaction", "trace", "deadline"],
      },
      capabilities: { tools: { list: true, call: true } },
      _meta: { serverInfo: { name: "mcpgate", version: "0.20.0" } },
    });
    expect(JSON.stringify(body)).not.toContain("subscriptions");
    expect((await fetch(`http://127.0.0.1:${port}/mcp/v2026`)).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/mcp/v2026`, { method: "DELETE" })).status).toBe(
      405,
    );
  });

  it("validates protocol, method, and tool-name headers", async () => {
    const mismatch = await request("tools/list", {}, { methodHeader: "server/discover" });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: { code: -32020, message: "HeaderMismatch" },
    });

    const protocolMismatch = await request("tools/list", {}, { protocol: "2027-01-01" });
    expect(protocolMismatch.status).toBe(400);
    expect(await protocolMismatch.json()).toMatchObject({
      error: { code: -32020, message: "HeaderMismatch" },
    });

    const unsupported = await request(
      "tools/list",
      {},
      { protocol: "2027-01-01", metaProtocol: "2027-01-01" },
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({
      error: { code: -32022, message: "UnsupportedProtocolVersion" },
    });

    const nameMismatch = await request(
      "tools/call",
      { name: "my_orders", arguments: {} },
      { nameHeader: "other" },
    );
    expect(nameMismatch.status).toBe(400);
    expect(await nameMismatch.json()).toMatchObject({ error: { code: -32020 } });

    const unknown = await request("resources/list");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: -32601 } });
  });

  it("authenticates every stateless request and executes repeated tool calls", async () => {
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthenticated.status).toBe(401);

    const events = handle.bus.recent();
    const rejected = await request("tools/call", { name: "my_orders", arguments: {} }, { token: "rejected-token" });
    expect(rejected.status).toBe(401);
    const authFailure = handle.bus.recent().slice(events.length).find((event) => event.type === "auth_failure");
    expect(authFailure).toMatchObject({ tool: "my_orders", meta: { tokenFingerprint: expect.any(String) } });
    expect(authFailure?.username).toBeUndefined();

    const listed = await request("tools/list");
    const listBody = (await listed.json()) as {
      result: { tools: Array<{ name: string }>; ttlMs: number; cacheScope: string };
    };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(
      [...listBody.result.tools.map((tool) => tool.name)].sort(),
    );
    expect(listBody.result).toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "request",
    });
    const authEvent = handle.bus.recent().slice(events.length).find((event) => event.type === "auth");
    expect(authEvent).toMatchObject({
      username: "dev-user",
      authMethod: "static",
      status: "ok",
      // Monitor events expose only scopes referenced by the active configuration.
      meta: { scopes: [], transport: "stateless-http" },
    });

    for (let index = 0; index < 2; index++) {
      const response = await request("tools/call", { name: "my_orders", arguments: {} });
      expect(response.status).toBe(200);
      const callBody = (await response.json()) as {
        result: { resultType: string; isError?: boolean };
      };
      expect(callBody.result.resultType).toBe("complete");
      expect(callBody.result.isError).not.toBe(true);
    }
    expect(fakeDb.calls).toHaveLength(2);
    expect(fakeDb.last("main")?.bindings).toEqual(["dev-user"]);
  });
});

describe("MCP integration · stateless governance, primitives, and tasks", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let governanceDb: FakeDb;
  const governanceRows: unknown[] = [{ id: 7, total: 11 }];

  const scopedToken = "stateless-scoped";
  const otherTenantToken = "stateless-other-tenant";
  const unscopedToken = "stateless-unscoped";

  const request = (token: string, method: string, params: Record<string, unknown> = {}) => {
    const named =
      method === "tools/call" ||
      method === "prompts/get" ||
      method === "io.modelcontextprotocol/skills/get" ||
      method === "io.modelcontextprotocol/apps/get";
    const key = method === "resources/read" ? params.uri : params.name;
    const requestState = method === "io.modelcontextprotocol/approvals/resolve" ? params.requestState : undefined;
    return fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...((named || method === "resources/read") && typeof key === "string"
          ? { "Mcp-Name": key }
          : {}),
        ...(typeof requestState === "string" ? { "Mcp-Request-State": requestState } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    });
  };

  beforeAll(async () => {
    const asyncTool = { ...DB_TOOL, name: "async_orders", requiredScopes: ["orders:read"] };
    const approvedTool = { ...DB_TOOL, name: "approved_orders", access: "write" };
    const approvalLookup = {
      ...DB_TOOL,
      name: "approved_orders_lookup",
      expose: false,
      requiredScopes: ["orders:read"],
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    };
    const config = AppConfigSchema.parse({
      server: { port: 3000 },
      tenantIsolation: {
        enabled: true,
        defaultTenantId: "default",
        claimNames: ["tenant", "tid", "client_id"],
      },
      auth: {
        mode: "static",
        static: {
          tokens: [
            {
              token: scopedToken,
              subject: "shared-subject",
              username: "dev-user",
              scopes: ["tools:read", "tools:write", "orders:read"],
              claims: { tenant: "acme" },
            },
            {
              token: otherTenantToken,
              subject: "shared-subject",
              username: "dev-user",
              scopes: ["tools:read", "orders:read"],
              claims: { tenant: "other" },
            },
            {
              token: unscopedToken,
              subject: "unscoped",
              username: "unscoped",
              claims: { tenant: "acme" },
            },
          ],
        },
      },
      monitoring: { enabled: true, token: "m" },
      tools: [asyncTool, approvedTool, approvalLookup],
      policies: {
        defaultEffect: "allow",
        approval: { secret: "integration-approval-secret", ttlMs: 300_000, maxPending: 10 },
        rules: [{
          effect: "approval",
          match: { tool: "approved_orders" },
          approval: {
            title: "Approve order",
            message: "Approve order {{args.id}} for {{lookup.total}}?",
            lookup: { tool: "approved_orders_lookup", arguments: { id: "{{args.id}}" } },
          },
        }],
      },
      resources: [
        {
          uri: "mcpgate://orders/runbook",
          name: "orders-runbook",
          text: "Inspect before mutating.",
          requiredScopes: ["orders:read"],
        },
      ],
      prompts: [
        {
          name: "summarize-orders",
          message: "Summarize {{customer}}",
          requiredScopes: ["orders:read"],
        },
      ],
      skills: [
        {
          name: "order-safety",
          instructions: "Inspect first.",
          requiredScopes: ["orders:read"],
        },
      ],
      apps: [
        {
          name: "orders-ui",
          resourceUri: "ui://orders/main",
          requiredScopes: ["orders:read"],
        },
      ],
      tasks: { asyncTools: ["async_orders"], ttlMs: 60_000, maxEntries: 10 },
    });
    governanceDb = new FakeDb({ main: governanceRows });
    handle = await buildApp(config, { db: governanceDb });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("filters tools and all configured primitives by caller scopes", async () => {
    const scopedTools = (await (await request(scopedToken, "tools/list")).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const unscopedTools = (await (await request(unscopedToken, "tools/list")).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(scopedTools.result.tools.map((tool) => tool.name)).toContain("async_orders");
    expect(unscopedTools.result.tools.map((tool) => tool.name)).not.toContain("async_orders");

    for (const [method, field] of [
      ["resources/list", "resources"],
      ["prompts/list", "prompts"],
      ["io.modelcontextprotocol/skills/list", "skills"],
      ["io.modelcontextprotocol/apps/list", "apps"],
    ] as const) {
      const visible = (await (await request(scopedToken, method)).json()) as {
        result: Record<string, unknown[]>;
      };
      const hidden = (await (await request(unscopedToken, method)).json()) as {
        result: Record<string, unknown[]>;
      };
      expect(visible.result[field]).toHaveLength(1);
      expect(hidden.result[field]).toHaveLength(0);
    }
  });

  it("enriches, resolves, tenant-binds and consumes an approval exactly once", async () => {
    const response = await request(scopedToken, "tools/call", {
      name: "approved_orders",
      arguments: { id: 7 },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { resultType: string; inputRequests: Array<Record<string, unknown>>; task?: unknown };
    };
    expect(body.result.resultType).toBe("input_required");
    expect(body.result.inputRequests).toHaveLength(1);
    expect(body.result.inputRequests[0]).toMatchObject({
      type: "approval",
      title: "Approve order",
      message: "Approve order 7 for 11?",
    });
    expect(body.result.inputRequests[0]).not.toHaveProperty("subject");
    expect(body.result.inputRequests[0]).not.toHaveProperty("argsFingerprint");
    expect(body.result.task).toBeUndefined();
    const requestState = String(body.result.inputRequests[0]?.requestState);

    const crossTenant = await request(otherTenantToken, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "approved",
    });
    expect(crossTenant.status).toBe(404);

    const resolved = await request(scopedToken, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "approved",
      approver: "operator@example.test",
    });
    const resolvedBody = (await resolved.json()) as { result: { approvalToken: string } };
    expect(resolved.status).toBe(200);
    expect(resolvedBody.result.approvalToken).toBeString();

    const callsBeforeExecution = governanceDb.calls.length;
    const approved = await request(scopedToken, "tools/call", {
      name: "approved_orders",
      arguments: { id: 7 },
      _meta: { "io.modelcontextprotocol/approvalToken": resolvedBody.result.approvalToken },
    });
    expect(((await approved.json()) as { result: { isError?: boolean } }).result.isError).not.toBe(true);
    expect(governanceDb.calls.length).toBe(callsBeforeExecution + 1);

    const replay = await request(scopedToken, "tools/call", {
      name: "approved_orders",
      arguments: { id: 7 },
      _meta: { "io.modelcontextprotocol/approvalToken": resolvedBody.result.approvalToken },
    });
    expect(((await replay.json()) as { result: { resultType: string } }).result.resultType).toBe("input_required");
    expect(governanceDb.calls.length).toBe(callsBeforeExecution + 2); // replay performs enrichment only, never the write
  });

  it("runs the approval lookup tool through the dispatcher, so it is audited", async () => {
    const before = handle.bus.recent().length;
    const response = await request(scopedToken, "tools/call", {
      name: "approved_orders",
      arguments: { id: 7 },
    });
    expect(response.status).toBe(200);
    const events = handle.bus.recent().slice(before);
    const lookupEvents = events.filter((event) => event.tool === "approved_orders_lookup");
    expect(lookupEvents.map((event) => event.type)).toContain("tool_call");
  });

  it("fails closed when approval enrichment finds no matching record", async () => {
    governanceRows.length = 0;
    try {
      const response = await request(scopedToken, "tools/call", {
        name: "approved_orders",
        arguments: { id: 404 },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: -32603, message: "Approval lookup returned no matching result" },
      });
    } finally {
      governanceRows.push({ id: 7, total: 11 });
    }
  });

  it("binds task reads to both subject and tenant", async () => {
    const started = (await (
      await request(scopedToken, "tools/call", { name: "async_orders", arguments: {} })
    ).json()) as { result: { resultType: string; task: { taskId: string } } };
    expect(started.result.resultType).toBe("task");

    const own = await request(scopedToken, "io.modelcontextprotocol/tasks/get", {
      taskId: started.result.task.taskId,
    });
    expect(own.status).toBe(200);

    const crossTenant = await request(otherTenantToken, "io.modelcontextprotocol/tasks/get", {
      taskId: started.result.task.taskId,
    });
    expect(crossTenant.status).toBe(404);
  });
});
