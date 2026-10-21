// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema, McpServerImportSchema } from "../../src/config/schema.ts";
import { defaultAccess, expandMcpServerImports } from "../../src/config/mcp-import.ts";
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

const TOKEN = "upstream-token";
const DOWNSTREAM_TOKEN = "downstream-token";

// ---------------------------------------------------------------------------
// Downstream mcpgate exposes three tools; the import config below filters
// one out, excludes another, and overrides the third's description and a
// fixed parameter.
// ---------------------------------------------------------------------------

describe("mcpServers import · connects a remote MCP server as a backend", () => {
  let downstream: AppHandle;
  let downstreamServer: Server;
  let downstreamPort: number;
  let downstreamDb: FakeDb;

  beforeAll(async () => {
    downstreamDb = new FakeDb({ main: [{ id: 1, name: "widget" }] });
    const downstreamConfig = AppConfigSchema.parse({
      server: { port: 3000 },
      auth: {
        mode: "static",
        static: {
          tokens: [{ token: DOWNSTREAM_TOKEN, username: "ds", scopes: ["tools:read"] }],
        },
      },
      monitoring: { enabled: false },
      tools: [
        {
          name: "list_items",
          type: "database",
          database: "main",
          query: "select * from items where owner = :param.owner and status = :param.status",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              status: { type: "string" },
            },
            required: ["status"],
          },
        },
        {
          name: "delete_item",
          type: "database",
          access: "write",
          database: "main",
          query: "delete from items where id = :param.id",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
        {
          name: "noop",
          type: "inline",
          handler: "datetime",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    downstream = await buildApp(downstreamConfig, { db: downstreamDb });
    const dl = await listen(downstream.app);
    downstreamServer = dl.server;
    downstreamPort = dl.port;
  });

  afterAll(async () => {
    downstreamServer.close();
    await downstream.shutdown();
  });

  function importConfig() {
    return McpServerImportSchema.parse({
      server: { url: `http://127.0.0.1:${downstreamPort}/mcp`, token: DOWNSTREAM_TOKEN },
      prefix: "ds_",
      include: ["list_items", "delete_item"], // "noop" is filtered out
      overrides: [
        {
          name: "list_items",
          description: "Custom description for the imported tool.",
          removeOptions: ["owner"],
          replaceParams: { status: "active" },
        },
        {
          name: "delete_item",
          enabled: false, // skipped entirely despite being in `include`
        },
      ],
    });
  }

  it("discovers downstream tools and applies include/exclude + overrides", async () => {
    const generated = (await expandMcpServerImports([importConfig()], [], globalThis.fetch)) as Array<Record<string, unknown>>;

    // "noop" was never included, "delete_item" was excluded via override.enabled: false.
    expect(generated.map((t) => t.name)).toEqual(["ds_list_items"]);

    const tool = generated[0];
    expect(tool.description).toBe("Custom description for the imported tool.");
    expect(tool.type).toBe("mcp");
    expect(tool.targetTool).toBe("list_items");
    expect(tool.fixedParams).toEqual({ status: "active" });

    const inputSchema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    // `owner` was explicitly removed; `status` is hidden because it's fixed.
    expect(inputSchema.properties).not.toHaveProperty("owner");
    expect(inputSchema.properties).not.toHaveProperty("status");
    expect(inputSchema.required).toEqual([]);
  });

  describe("access level of imported tools", () => {
    const plain = (extra: Record<string, unknown> = {}) =>
      McpServerImportSchema.parse({
        server: { url: `http://127.0.0.1:${downstreamPort}/mcp`, token: DOWNSTREAM_TOKEN },
        prefix: "ds_",
        include: ["list_items", "delete_item", "noop"],
        ...extra,
      });
    const accessOf = (tools: unknown[], name: string): unknown =>
      (tools as Array<Record<string, unknown>>).find((t) => t.name === name)?.access;

    it("takes the level from the downstream server's own annotations", async () => {
      const tools = await expandMcpServerImports([plain()], [], globalThis.fetch);
      // list_items is annotated readOnlyHint:true, delete_item destructive.
      expect(accessOf(tools, "ds_list_items")).toBe("read");
      expect(accessOf(tools, "ds_delete_item")).toBe("write");
    });

    it("an explicit access on the import wins over the annotations", async () => {
      const tools = await expandMcpServerImports([plain({ access: "write" })], [], globalThis.fetch);
      expect(accessOf(tools, "ds_list_items")).toBe("write");
    });

    it("a per-tool override wins over both", async () => {
      const tools = await expandMcpServerImports(
        [plain({ overrides: [{ name: "delete_item", access: "read" }] })],
        [],
        globalThis.fetch,
      );
      expect(accessOf(tools, "ds_delete_item")).toBe("read");
    });

    it("defaultAccess: only an explicit readOnlyHint:true is read; everything else is write", () => {
      expect(defaultAccess({ annotations: { readOnlyHint: true } })).toBe("read");
      expect(defaultAccess({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe("write");
      expect(defaultAccess({ annotations: { readOnlyHint: false } })).toBe("write");
      expect(defaultAccess({ annotations: { destructiveHint: true } })).toBe("write");
      expect(defaultAccess({ annotations: {} })).toBe("write");
      expect(defaultAccess({})).toBe("write");
      expect(defaultAccess({ annotations: { readOnlyHint: "true" } })).toBe("write");
    });
  });
  describe("end-to-end through an upstream mcpgate instance", () => {
    let upstream: AppHandle;
    let upstreamServer: Server;
    let upstreamPort: number;

    beforeAll(async () => {
      const generated = await expandMcpServerImports([importConfig()], [], globalThis.fetch);
      const upstreamConfig = AppConfigSchema.parse({
        server: { port: 3000 },
        auth: {
          mode: "static",
          static: { tokens: [{ token: TOKEN, username: "up", scopes: ["tools:read"] }] },
        },
        monitoring: { enabled: false },
        tools: generated,
      });
      upstream = await buildApp(upstreamConfig, { db: new FakeDb() });
      const ul = await listen(upstream.app);
      upstreamServer = ul.server;
      upstreamPort = ul.port;
    });

    afterAll(async () => {
      upstreamServer.close();
      await upstream.shutdown();
    });

    it("hides the deleted/excluded tool and the fixed parameter from MCP clients", async () => {
      const client = await connectMcpStreamable(`http://127.0.0.1:${upstreamPort}`, TOKEN);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(["ds_list_items"]);
      const schema = tools.tools[0].inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty("owner");
      expect(schema.properties).not.toHaveProperty("status");
      await client.close();
    });

    it("refuses an imported downstream loopback target", async () => {
      const client = await connectMcpStreamable(`http://127.0.0.1:${upstreamPort}`, TOKEN);
      const res = await client.callTool({ name: "ds_list_items", arguments: {} });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text: string }>)[0].text).toContain("outbound address not allowed");
      await client.close();
      expect(downstreamDb.last("main")).toBeUndefined();
    });
  });
});
