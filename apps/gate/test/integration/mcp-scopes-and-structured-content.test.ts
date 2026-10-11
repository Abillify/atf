// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SignJWT } from "jose";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { McpToolDispatcher } from "../../src/mcp/server.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import {
  MemoryInvocationLedger,
  TransactionFabric,
  TRANSACTION_CAPABILITY_TOOL,
} from "../../src/transaction/fabric.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import { connectMcp } from "../helpers/mcp-client.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const ADMIN_TOKEN = "admin-token";
const USER_TOKEN = "user-token";
const PLAIN_TOKEN = "plain-token";
const READ_TOKEN = "read-token";
const WRITE_TOKEN = "write-token";

function config(extra: Record<string, unknown>) {
  return AppConfigSchema.parse({
    server: { port: 3000 },
    auth: {
      mode: "static",
      static: {
        tokens: [
          {
            token: ADMIN_TOKEN,
            username: "admin",
            scopes: ["tools:read", "admin:read"],
          },
          {
            token: USER_TOKEN,
            username: "user",
            scopes: ["tools:read", "admin:read"],
          },
          { token: PLAIN_TOKEN, username: "plain", scopes: [] },
          { token: READ_TOKEN, username: "reader", scopes: ["tools:read"] },
          { token: WRITE_TOKEN, username: "writer", scopes: ["tools:write"] },
        ],
      },
    },
    monitoring: { enabled: true, token: "m" },
    ...extra,
  });
}

describe("MCP integration · per-tool requiredScopes", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const fakeDb = new FakeDb({ main: [{ id: 1 }] });
    handle = await buildApp(
      config({
        tools: [
          {
            name: "admin_report",
            type: "database",
            database: "main",
            query: "select id from x",
            requiredScopes: ["admin:read", "admin:read"],
          },
          {
            name: "authenticated_report",
            type: "database",
            database: "main",
            query: "select id from x",
            scopeCheck: false,
          },
        ],
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "deny", match: { tool: "admin_report", subjects: ["user"] } }],
        },
      }),
      { db: fakeDb },
    );
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("refuses a call from a caller missing the required scope", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, PLAIN_TOKEN);
    const res = await client.callTool({ name: "admin_report", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain("Missing required scope");
    await client.close();
  });

  it("requires the explicit scope without tools:read", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, READ_TOKEN);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "admin_report")).toBe(false);
    const res = await client.callTool({ name: "admin_report", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe(
      "Missing required scope(s): admin:read",
    );
    await client.close();
  });

  it("applies the same policy to user/admin discovery and execution", async () => {
    const user = await connectMcp(`http://127.0.0.1:${port}`, USER_TOKEN);
    expect((await user.listTools()).tools.some((tool) => tool.name === "admin_report")).toBe(false);
    const denied = await user.callTool({ name: "admin_report", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    await user.close();

    const admin = await connectMcp(`http://127.0.0.1:${port}`, ADMIN_TOKEN);
    expect((await admin.listTools()).tools.some((tool) => tool.name === "admin_report")).toBe(true);
    const allowed = await admin.callTool({ name: "admin_report", arguments: {} });
    expect(allowed.isError).toBeFalsy();
    await admin.close();
  });
  it("allows a caller without scopes to list and call a scope-unchecked tool", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, PLAIN_TOKEN);
    expect(
      (await client.listTools()).tools.some((tool) => tool.name === "authenticated_report"),
    ).toBe(true);
    const res = await client.callTool({ name: "authenticated_report", arguments: {} });
    expect(res.isError).toBeFalsy();
    await client.close();
  });
});

describe("MCP integration · tools/list advertises outputSchema + annotations", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const fakeDb = new FakeDb({ main: [{ id: 1 }] });
    handle = await buildApp(
      config({
        tools: [
          { name: "reader", type: "database", database: "main", query: "select 1", access: "read" },
        ],
      }),
      { db: fakeDb },
    );
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("allows every authenticated caller to list and call a tool without requiredScopes", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, PLAIN_TOKEN);
    const tools = await client.listTools();
    const reader = tools.tools.find((tool) => tool.name === "reader")!;
    expect(reader.outputSchema).toBeDefined();
    expect(reader.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await client.callTool({ name: "reader", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});

describe("MCP integration · structuredContent is returned alongside content", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const fakeDb = new FakeDb({ main: [{ id: 1, total: 9 }] });
    handle = await buildApp(
      config({
        tools: [{ name: "orders", type: "database", database: "main", query: "select 1" }],
      }),
      { db: fakeDb },
    );
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("returns structuredContent with rows/rowCount/truncated", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, READ_TOKEN);
    const res = await client.callTool({ name: "orders", arguments: {} });
    expect(res.structuredContent).toBeDefined();
    expect((res.structuredContent as { rowCount: number }).rowCount).toBe(1);
    await client.close();
  });
});

describe("MCP integration · error results survive a schema-validating client", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const fakeDb = new FakeDb({ main: [{ id: 1 }] });
    handle = await buildApp(
      config({
        tools: [{ name: "guarded", type: "database", database: "main", query: "select 1" }],
        // An approval-gated tool stays discoverable, so the MCP SDK client
        // caches its outputSchema and validates structuredContent on the call.
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "approval", match: { tool: "guarded" } }],
        },
      }),
      { db: fakeDb },
    );
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("reports the real error instead of an output-schema validation failure", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, READ_TOKEN);
    // The tool is advertised with the database success outputSchema, which the
    // SDK client caches and would otherwise apply to the error payload too.
    const listed = (await client.listTools()).tools.find((tool) => tool.name === "guarded");
    expect(listed?.outputSchema).toMatchObject({ required: ["rowCount", "truncated", "rows"] });

    const result = await client.callTool({ name: "guarded", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
      "Approval required for tool 'guarded'",
    );
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });
});

describe("MCP integration · composite subtool requiredScopes", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;

  beforeAll(async () => {
    fakeDb = new FakeDb({ main: [{ id: 1 }] });
    handle = await buildApp(
      config({
        tools: [
          {
            name: "restricted",
            type: "database",
            database: "main",
            query: "select 1",
            access: "write",
            expose: false,
            requiredScopes: ["admin:read"],
          },
          {
            name: "workflow",
            type: "composite",
            steps: [{ id: "restricted", tool: "restricted", arguments: {} }],
          },
        ],
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "deny", match: { tool: "restricted" } }],
        },
      }),
      { db: fakeDb },
    );
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("applies governance to a hidden composite target before database execution", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, READ_TOKEN);
    const res = await client.callTool({ name: "workflow", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain(
      "Policy denied tool 'restricted'",
    );
    expect(fakeDb.calls).toHaveLength(0);
    await client.close();
  });
});

describe("MCP integration · router ask/act scopes and nested protection", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;

  beforeAll(async () => {
    fakeDb = new FakeDb({ main: [{ id: 1 }] });
    const llm = {
      route: async (prompt: string) => ({
        kind: "tool",
        tool: prompt.includes("write") ? "router_writer" : "router_restricted",
        arguments: {},
      }),
    };
    handle = await buildApp(
      config({
        tools: [
          {
            name: "router_restricted",
            type: "database",
            database: "main",
            query: "select 1",
            requiredScopes: ["admin:read"],
          },
          {
            name: "router_writer",
            type: "database",
            database: "main",
            query: "update x set id = 1",
            access: "write",
          },
        ],
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "deny", match: { tool: "router_restricted" } }],
        },
        router: {
          enabled: true,
          mode: "replace",
          name: "ask",
          llm: { baseUrl: "http://127.0.0.1:9/v1" },
        },
      }),
      { db: fakeDb, llm: llm as never },
    );
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("lists both routers for every authenticated caller when no router scopes are configured", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, PLAIN_TOKEN);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ask", "act"]);
    await client.close();
  });

  it("applies governance to a routed hidden target before database execution", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, READ_TOKEN);
    const res = await client.callTool({ name: "ask", arguments: { prompt: "restricted report" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe(
      "Policy denied tool 'router_restricted'.",
    );
    expect(fakeDb.calls).toHaveLength(0);
    await client.close();
  });

  it("allows an authenticated caller to use act and protects its write target", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, PLAIN_TOKEN);
    const res = await client.callTool({ name: "act", arguments: { prompt: "write record" } });
    expect(res.isError).toBeFalsy();
    expect(fakeDb.calls).toHaveLength(1);
    await client.close();
  });
});

describe("MCP integration · transaction capability scope", () => {
  const transactionFabric = new TransactionFabric(
    {
      enforcement: "optional",
      secret: "integration-test-only-secret",
      algorithms: ["HS256"],
      issuer: "integration-test",
      audience: "integration-test",
      clockToleranceSec: 0,
      maxTtlSec: 60,
    },
    new MemoryInvocationLedger(),
  );
  const registry = {
    list: () => [],
    get: () => undefined,
    requiredScopesOf: () => [],
  };
  const context = (scopes: string[]) => ({
    method: "static" as const,
    subject: "static-user",
    username: "static-user",
    scopes,
    claims: {},
    headers: {},
    rawToken: "not-a-secret",
  });
  const dispatcher = (scopes: string[]) =>
    new McpToolDispatcher(context(scopes), "scope-test", {
      serverConfig: {} as never,
      registry: registry as never,
      bus: new MonitorBus(10),
      transactionFabric,
    });

  it("lists and calls the synthetic capability tool for every authenticated caller", async () => {
    const caller = dispatcher([]);
    expect(caller.listTools().map((tool) => tool.name)).toEqual([TRANSACTION_CAPABILITY_TOOL]);
    expect(
      await caller.preflight({ name: TRANSACTION_CAPABILITY_TOOL }),
    ).toBeUndefined();
    const result = await caller.callTool({ name: TRANSACTION_CAPABILITY_TOOL });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ version: "v1", enforcement: "optional" });
  });
});

describe("MCP integration · transaction abort propagation", () => {
  it("forwards the Fabric abort signal through the dispatcher to the executor", async () => {
    const secret = "dispatcher-abort-test-secret-with-enough-entropy";
    const fabric = new TransactionFabric({
      enforcement: "required",
      secret,
      algorithms: ["HS256"],
      issuer: "integration-test",
      audience: "integration-test",
      clockToleranceSec: 0,
      maxTtlSec: 60,
    });
    let aborted = false;
    const executor = {
      definition: {
        name: "slow_write",
        inputSchema: { type: "object", additionalProperties: false },
      },
      execute: async (_args: unknown, _context: unknown, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
          setTimeout(
            () => resolve({ content: [{ type: "text" as const, text: "late" }] }),
            500,
          ).unref?.();
        }),
    };
    const registry = {
      list: () => [executor.definition],
      get: (name: string) => (name === "slow_write" ? executor : undefined),
      getReal: (name: string) => (name === "slow_write" ? executor : undefined),
      requiredScopesOf: () => [],
      accessOf: () => "write" as const,
    };
    const dispatcher = new McpToolDispatcher(
      {
        method: "static",
        subject: "static-user",
        username: "static-user",
        scopes: [],
        claims: {},
        headers: {},
        rawToken: "not-a-secret",
      },
      "abort-test",
      {
        serverConfig: {} as never,
        registry: registry as never,
        bus: new MonitorBus(10),
        transactionFabric: fabric,
      },
    );
    const now = Math.floor(Date.now() / 1000);
    const transactionToken = await new SignJWT({
      version: "v1",
      iss: "integration-test",
      aud: "integration-test",
      iat: now,
      exp: now + 60,
      jti: crypto.randomUUID(),
      executionId: crypto.randomUUID(),
      invocationId: crypto.randomUUID(),
      scopes: [],
      groups: [],
      budget: { maxDurationMs: 5 },
      delegationChain: [],
      trace: {},
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(secret));

    const result = await dispatcher.callTool({
      name: "slow_write",
      arguments: {},
      _meta: { "transaction/token": transactionToken },
    });

    expect(aborted).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVOCATION_OUTCOME_UNKNOWN", outcome: "outcome_unknown" },
    });
  });
});


it("rejects evidencePackHash as a Transaction Envelope claim", async () => {
  const secret = "evidence-pack-envelope-test-secret-with-enough-entropy";
  const fabric = new TransactionFabric({
    enforcement: "required",
    secret,
    algorithms: ["HS256"],
    issuer: "integration-test",
    audience: "integration-test",
    clockToleranceSec: 0,
    maxTtlSec: 60,
  });
  const now = Math.floor(Date.now() / 1000);
  const transactionToken = await new SignJWT({
    version: "v1",
    iss: "integration-test",
    aud: "integration-test",
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    invocationId: crypto.randomUUID(),
    scopes: [],
    groups: [],
    evidencePackHash: "b".repeat(64),
    budget: {},
    delegationChain: [],
    trace: {},
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
  let called = false;
  const result = await fabric.execute({
    token: transactionToken,
    tool: "write_order",
    args: {},
    requiredScopes: [],
    run: async () => {
      called = true;
      return { content: [{ type: "text", text: "unexpected" }] };
    },
  });
  expect(called).toBe(false);
  expect(result.structuredContent).toMatchObject({
    error: { code: "TRANSACTION_TOKEN_INVALID" },
  });
});