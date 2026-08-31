// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { LlmClient } from "../../src/llm/client.ts";
import { LlmConfigSchema } from "../../src/config/schema.ts";
import type { AuthContext } from "../../src/auth/context.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";

const CTX: AuthContext = { username: "dev-user", method: "static" } as AuthContext;

/** A tiny HTTP server that records the last request body and returns a canned completion. */
function startFakeOpenAi(): Promise<{ server: Server; port: number; lastBody: () => Record<string, unknown> }> {
  let last: Record<string, unknown> = {};
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        last = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, lastBody: () => last });
    });
  });
}

const TOOLS: ToolDefinition[] = [
  { name: "list_orders", description: "List orders", inputSchema: { type: "object", properties: {} } },
];

describe("LlmClient.route · OpenAI-compatible request body", () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it("includes tools + tool_choice when candidate tools exist", async () => {
    const fake = await startFakeOpenAi();
    server = fake.server;
    const client = new LlmClient(
      LlmConfigSchema.parse({ provider: "openai", baseUrl: `http://127.0.0.1:${fake.port}` }),
    );

    await client.route("show my orders", "", TOOLS, CTX);

    const body = fake.lastBody();
    expect(body.stream).toBe(false);
    expect(body.tools).toBeDefined();
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.tool_choice).toBe("auto");
  });

  it("omits tools + tool_choice entirely when there are no candidate tools", async () => {
    // OpenAI's API (and several compatible servers) reject `tools: []` outright
    // with "Invalid 'tools': empty array" — this happens for the `ask` router
    // when no read-access tools are configured, so the field must be omitted,
    // not sent empty.
    const fake = await startFakeOpenAi();
    server = fake.server;
    const client = new LlmClient(
      LlmConfigSchema.parse({ provider: "openai", baseUrl: `http://127.0.0.1:${fake.port}` }),
    );

    await client.route("hello", "", [], CTX);

    const body = fake.lastBody();
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });
});
