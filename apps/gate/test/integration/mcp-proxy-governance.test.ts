// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Trust-proxy mode, tool side (ADR 0038, §5 / blueprint gate-mcp-proxy): an
 * MCP client points at the Gate instead of at the MCP server behind it. The
 * Gate imports the downstream tools with their annotations, requires a scope
 * for every imported tool, and lets a policy rule ask for approval on write
 * tools. A caller without the scope neither sees nor calls a tool; a caller
 * with it passes authorization and reaches the outbound guard (which, in this
 * test, refuses the loopback downstream — the guard is the last step before
 * the wire, so reaching it proves the call was authorised).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema, McpServerImportSchema } from "../../src/config/schema.ts";
import { expandMcpServerImports } from "../../src/config/mcp-import.ts";
import { validateOutboundUrl } from "../../src/tools/outbound.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import { connectMcpStreamable } from "../helpers/mcp-client.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const DOWNSTREAM_TOKEN = "downstream-token";
const WITH_SCOPE = "caller-with-crm-scope";
const WITHOUT_SCOPE = "caller-without-crm-scope";

describe("Gate as governed MCP proxy", () => {
  let downstream: AppHandle;
  let downstreamServer: Server;
  let upstream: AppHandle;
  let upstreamServer: Server;
  let upstreamPort: number;
  let generated: Array<Record<string, unknown>>;

  beforeAll(async () => {
    downstream = await buildApp(
      AppConfigSchema.parse({
        server: { port: 3000 },
        auth: {
          mode: "static",
          static: { tokens: [{ token: DOWNSTREAM_TOKEN, username: "ds", scopes: [] }] },
        },
        monitoring: { enabled: false },
        tools: [
          {
            name: "contact_lookup",
            type: "database",
            database: "main",
            query: "select * from contacts where id = :param.id",
            annotations: { readOnlyHint: true, title: "Look up a contact" },
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          {
            name: "contact_delete",
            type: "database",
            database: "main",
            access: "write",
            query: "delete from contacts where id = :param.id",
            annotations: { destructiveHint: true },
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
        ],
      }),
      { db: new FakeDb({ main: [] }) },
    );
    const dl = await listen(downstream.app);
    downstreamServer = dl.server;

    generated = (await expandMcpServerImports(
      [
        McpServerImportSchema.parse({
          server: { url: `http://127.0.0.1:${dl.port}/mcp`, token: DOWNSTREAM_TOKEN },
          prefix: "crm_",
          requiredScopes: ["crm:use"],
        }),
      ],
      [],
      globalThis.fetch,
    )) as Array<Record<string, unknown>>;

    upstream = await buildApp(
      AppConfigSchema.parse({
        server: { port: 3000 },
        auth: {
          mode: "static",
          static: {
            tokens: [
              { token: WITH_SCOPE, username: "alex", scopes: ["crm:use"] },
              { token: WITHOUT_SCOPE, username: "sam", scopes: [] },
            ],
          },
        },
        monitoring: { enabled: false },
        policies: {
          defaultEffect: "allow",
          rules: [{ effect: "approval", match: { access: "write" } }],
          approval: { secret: "approval-secret-for-tests-0123456789" },
        },
        tools: generated,
      }),
      { db: new FakeDb() },
    );
    const ul = await listen(upstream.app);
    upstreamServer = ul.server;
    upstreamPort = ul.port;
  });

  afterAll(async () => {
    upstreamServer.close();
    downstreamServer.close();
    await upstream.shutdown();
    await downstream.shutdown();
  });

  it("imports the downstream annotations and the required scope", () => {
    const lookup = generated.find((t) => t.name === "crm_contact_lookup");
    const del = generated.find((t) => t.name === "crm_contact_delete");
    // The downstream Gate completes the hints itself; the import keeps them all.
    expect(lookup?.annotations).toMatchObject({ title: "Look up a contact", readOnlyHint: true });
    expect(lookup?.access).toBe("read");
    expect(del?.annotations).toMatchObject({ destructiveHint: true });
    expect(del?.access).toBe("write");
    expect(lookup?.requiredScopes).toEqual(["crm:use"]);
  });

  it("a caller without the scope sees no tool and cannot call one", async () => {
    const client = await connectMcpStreamable(`http://127.0.0.1:${upstreamPort}`, WITHOUT_SCOPE);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual([]);
      const res = await client.callTool({ name: "crm_contact_lookup", arguments: { id: "1" } });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/scope/i);
    } finally {
      await client.close();
    }
  });

  it("a caller with the scope sees both tools, annotated, and passes authorization", async () => {
    const client = await connectMcpStreamable(`http://127.0.0.1:${upstreamPort}`, WITH_SCOPE);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "crm_contact_delete",
        "crm_contact_lookup",
      ]);
      const lookup = tools.tools.find((t) => t.name === "crm_contact_lookup");
      expect(lookup?.annotations?.readOnlyHint).toBe(true);
      const res = await client.callTool({ name: "crm_contact_lookup", arguments: { id: "1" } });
      // Authorised; the loopback downstream is then refused by the outbound guard.
      expect(JSON.stringify(res.content)).toContain("outbound address not allowed");
    } finally {
      await client.close();
    }
  });

  it("a write tool asks for approval instead of running", async () => {
    const client = await connectMcpStreamable(`http://127.0.0.1:${upstreamPort}`, WITH_SCOPE);
    try {
      const res = await client.callTool({ name: "crm_contact_delete", arguments: { id: "1" } });
      expect(JSON.stringify(res)).not.toContain("outbound address not allowed");
      expect(JSON.stringify(res)).toMatch(/approval/i);
    } finally {
      await client.close();
    }
  });
});

describe("allowPrivateAddress for a downstream MCP server", () => {
  it("opens only private ranges for the exact configured host, never loopback", async () => {
    expect(await validateOutboundUrl("http://10.1.2.3/mcp", [], [])).toContain("not allowed");
    expect(await validateOutboundUrl("http://10.1.2.3/mcp", [], ["10.1.2.3"])).toBeNull();
    expect(await validateOutboundUrl("http://127.0.0.1/mcp", [], ["127.0.0.1"])).toContain(
      "not allowed",
    );
    const parsed = McpServerImportSchema.parse({
      server: { url: "http://crm-mcp.internal/mcp", allowPrivateAddress: true },
    });
    expect(parsed.server.allowPrivateAddress).toBe(true);
  });
});
