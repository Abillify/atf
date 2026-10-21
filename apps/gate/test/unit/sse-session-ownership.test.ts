// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Someone who learned an SSE session id but cannot authenticate as its owner
 * must not be able to end that session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("SSE session ownership", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const config = AppConfigSchema.parse({
      server: { port: 3000 },
      auth: {
        mode: "static",
        static: {
          tokens: [
            { token: "owner-token", subject: "owner", username: "owner", scopes: ["tools:read"] },
            { token: "other-token", subject: "other", username: "other", scopes: ["tools:read"] },
          ],
        },
      },
      monitoring: { enabled: true, token: "m" },
      tools: [],
    });
    handle = await buildApp(config, { db: new FakeDb({}) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  async function openSession(): Promise<{ sessionId: string; abort: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { authorization: "Bearer owner-token", accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (let i = 0; i < 20 && reader; i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      const match = /sessionId=([\w-]+)/.exec(buffer);
      if (match?.[1]) return { sessionId: match[1], abort: () => controller.abort() };
    }
    controller.abort();
    throw new Error("no endpoint event received");
  }

  const post = (sessionId: string, token: string) =>
    fetch(`http://127.0.0.1:${port}/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

  it("a bad token or another identity is refused but does not close the session", async () => {
    const { sessionId, abort } = await openSession();
    try {
      expect((await post(sessionId, "wrong-token")).status).toBe(401);
      expect((await post(sessionId, "other-token")).status).toBe(403);
      // The owner can still use the session: it was not deleted.
      expect((await post(sessionId, "owner-token")).status).not.toBe(404);
    } finally {
      abort();
    }
  });
});
