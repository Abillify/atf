// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * An unexpected tool failure must not hand internal details (driver messages,
 * hosts, SQL) to the MCP client: the client gets a reference, the full text
 * stays in the log and the monitor stream.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import type { QueryRunner } from "../../src/db/manager.ts";
import { FakeDb } from "../helpers/fake-db.ts";

const INTERNAL = "connect ECONNREFUSED 10.0.0.5:5432 (db-internal.example.test)";

class FailingDb extends FakeDb {
  override get(_name: string): QueryRunner {
    return {
      raw: async () => {
        throw new Error(INTERNAL);
      },
    };
  }
}

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("tool failure responses", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const config = AppConfigSchema.parse({
      server: { port: 3000 },
      auth: {
        mode: "static",
        static: {
          tokens: [{ token: "t-error", subject: "u", username: "u", scopes: ["tools:read"] }],
        },
      },
      monitoring: { enabled: true, token: "m" },
      tools: [
        {
          name: "list_orders",
          type: "database",
          database: "main",
          query: "SELECT id FROM orders",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    handle = await buildApp(config, { db: new FailingDb({ main: [] }) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("returns a reference instead of the internal message, and keeps the text in the monitor", async () => {
    const before = handle.bus.recent().length;
    const response = await fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: "Bearer t-error",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_orders",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_orders", arguments: {} },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    });
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const text = body.result.content[0]?.text ?? "";
    expect(body.result.isError).toBe(true);
    expect(text).toMatch(/^Tool execution failed \(reference [\w-]+\)$/);
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("db-internal");

    const errors = handle.bus.recent().slice(before).filter((event) => event.type === "error");
    expect(errors.some((event) => event.message?.includes("ECONNREFUSED"))).toBe(true);
  });
});
