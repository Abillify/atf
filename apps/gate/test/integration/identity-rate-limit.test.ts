// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
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

const TOKEN = "identity-rl-token";

describe("MCP integration · per-identity rate limiting", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const fakeDb = new FakeDb({ main: [{ id: 1 }] });
    const config = AppConfigSchema.parse({
      server: {
        port: 3000,
        rateLimit: {
          // Keep the IP-based limit generous so this test only exercises the
          // per-identity limiter below it.
          max: 1000,
          perIdentity: { enabled: true, windowMs: 60_000, max: 2 },
        },
      },
      auth: {
        mode: "static",
        static: {
          tokens: [
            { token: TOKEN, username: "capped", subject: "capped", scopes: ["tools:read"] },
          ],
        },
      },
      monitoring: { enabled: true, token: "m" },
      tools: [{ name: "t", type: "database", database: "main", query: "select 1" }],
    });
    handle = await buildApp(config, { db: fakeDb });
    ({ server, port } = await listen(handle.app));
  });

  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("rejects calls once the per-identity cap is exceeded, independent of the IP limit", async () => {
    const client = await connectMcp(`http://127.0.0.1:${port}`, TOKEN);
    const first = await client.callTool({ name: "t", arguments: {} });
    const second = await client.callTool({ name: "t", arguments: {} });
    const third = await client.callTool({ name: "t", arguments: {} });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(third.isError).toBe(true);
    expect((third.content as Array<{ text: string }>)[0]!.text).toContain("Rate limit exceeded");
    await client.close();
  });
});
