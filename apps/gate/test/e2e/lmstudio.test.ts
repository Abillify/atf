// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import { connectMcp } from "../helpers/mcp-client.ts";

// Live test against a local LM Studio. Opt in with MCPGATE_LLM_E2E=1 so the
// normal suite never depends on the network or a loaded model.
const ENABLED = process.env.MCPGATE_LLM_E2E === "1";
const LLM_BASE = process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1";
const TOKEN = "e2e-token";
const LLM_TIMEOUT_MS = 180_000;
const MCP_TIMEOUT_MS = LLM_TIMEOUT_MS + 10_000;
const TEST_TIMEOUT_MS = MCP_TIMEOUT_MS + 10_000;

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

async function discoverModel(): Promise<string | undefined> {
  try {
    const res = await fetch(`${LLM_BASE}/models`);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return json.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

const PARKING_TOOL = {
  name: "parking_status",
  type: "database",
  database: "warp",
  description:
    "List parking-space bookings between two dates. Arguments: from and to (YYYY-MM-DD).",
  query:
    'SELECT parking_space, name FROM status WHERE begin::date >= :param.from::date AND "end"::date <= :param.to::date',
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date YYYY-MM-DD" },
      to: { type: "string", description: "End date YYYY-MM-DD" },
    },
    required: ["from", "to"],
  },
};

const ORDERS_TOOL = {
  name: "list_my_orders",
  type: "database",
  database: "main",
  description: "List the authenticated user's online shop orders. No arguments.",
  query: "SELECT id FROM orders WHERE owner = :ctx.username",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const maybe = ENABLED ? describe : describe.skip;

maybe("E2E · LM Studio routing", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  let fakeDb: FakeDb;
  let model: string | undefined;

  beforeAll(async () => {
    model = await discoverModel();
    fakeDb = new FakeDb({
      warp: [{ parking_space: "P_9", name: "Belegt" }],
      main: [{ id: 1 }],
    });
    const config = AppConfigSchema.parse({
      server: { port: 3000 },
      auth: { mode: "static", static: { tokens: [{ token: TOKEN, username: "dev-user" }] } },
      monitoring: { enabled: false },
      tools: [PARKING_TOOL, ORDERS_TOOL],
      router: {
        enabled: true,
        mode: "replace",
        name: "ask",
        llm: {
          baseUrl: LLM_BASE,
          model: model ?? "local-model",
          temperature: 0,
          timeoutMs: LLM_TIMEOUT_MS,
        },
        systemPrompt: {
          text:
            "Route the user's request to the correct tool and fill its arguments. " +
            "Dates must be ISO YYYY-MM-DD. Today is 2026-06-18.",
        },
      },
    });
    handle = await buildApp(config, { db: fakeDb });
    ({ server, port } = await listen(handle.app));
    console.log(`[e2e] LM Studio model: ${model ?? "(discovery failed)"}`);
  });

  afterAll(async () => {
    server?.close();
    await handle?.shutdown();
  });

  it(
    "routes a parking question to parking_status with correct date args",
    async () => {
      expect(model, "LM Studio not reachable / no model loaded").toBeDefined();
      const client = await connectMcp(`http://127.0.0.1:${port}`, TOKEN);
      const res = await client.callTool(
        {
          name: "ask",
          arguments: {
            prompt: "Which parking spaces are booked between 2026-06-22 and 2026-06-26?",
          },
        },
        undefined,
        { timeout: MCP_TIMEOUT_MS },
      );
      await client.close();

      console.log("[e2e] tool dispatched:", JSON.stringify(fakeDb.last()));
      expect(res.isError).toBeFalsy();
      const call = fakeDb.last();
      expect(call?.database).toBe("warp");
      expect(call?.bindings).toEqual(["2026-06-22", "2026-06-26"]);
    },
    TEST_TIMEOUT_MS,
  );
});
