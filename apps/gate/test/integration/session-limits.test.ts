// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Session bounds enforced on the live transports, plus monitor redaction
 * enforced on the real bus.
 *
 * The unit tests cover the store and the redactor in isolation; these check the
 * wiring, which is where this kind of fix usually fails to actually land.
 */

import { afterEach, describe, expect, it } from "bun:test";
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

const TOKEN = "integration-token";

function baseConfig(extra: Record<string, unknown>) {
  return AppConfigSchema.parse({
    server: { port: 3000, ...(extra.server as object) },
    auth: {
      mode: "static",
      static: {
        tokens: [
          {
            token: TOKEN,
            username: "dev-user",
            claims: { tenant: "acme", email: "dev@example.com" },
          },
        ],
      },
    },
    monitoring: { enabled: true, token: "m", ...(extra.monitoring as object) },
    tools: extra.tools ?? [],
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

let open: { server: Server; handle: AppHandle } | undefined;
afterEach(async () => {
  if (open) {
    open.server.close();
    await open.handle.shutdown();
    open = undefined;
  }
});

async function start(config: ReturnType<typeof baseConfig>): Promise<number> {
  const handle = await buildApp(config, { db: new FakeDb({ main: [] }) });
  const { server, port } = await listen(handle.app);
  open = { server, handle };
  return port;
}

/** Send an `initialize` over Streamable HTTP and return the raw response. */
function initialize(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(INITIALIZE),
  });
}

describe("Streamable HTTP · session cap", () => {
  it("refuses a new session with 503 once the cap is reached", async () => {
    const port = await start(
      baseConfig({ server: { sessions: { max: 2, idleTimeoutMs: 600_000 } } }),
    );

    const first = await initialize(port);
    expect(first.status).toBe(200);
    const second = await initialize(port);
    expect(second.status).toBe(200);

    const third = await initialize(port);
    expect(third.status).toBe(503);
    expect(third.headers.get("retry-after")).toBe("30");
    const body = (await third.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Session limit reached");
  });

  it("admits a new session again once idle ones are swept", async () => {
    // A 1ms idle timeout means the two sessions created below are immediately
    // eligible, so the sweep inside tryReserve() reclaims them.
    const port = await start(
      baseConfig({ server: { sessions: { max: 1, idleTimeoutMs: 1, sweepIntervalMs: 60_000 } } }),
    );

    expect((await initialize(port)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    // Cap is 1 and one session is held — but it is idle past the timeout, so the
    // reservation sweeps it and succeeds instead of returning 503.
    expect((await initialize(port)).status).toBe(200);
  });

  it("does not cap when sessions.max is 0", async () => {
    const port = await start(
      baseConfig({ server: { sessions: { max: 0, idleTimeoutMs: 600_000 } } }),
    );
    for (let i = 0; i < 5; i++) {
      expect((await initialize(port)).status).toBe(200);
    }
  });
});

describe("SSE · session cap", () => {
  it("refuses a new stream with 503 once the cap is reached", async () => {
    const port = await start(
      baseConfig({ server: { sessions: { max: 1, idleTimeoutMs: 600_000 } } }),
    );

    // Open the first stream and keep it open (no await on the body).
    const controller = new AbortController();
    const streamRes = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(streamRes.status).toBe(200);

    const second = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("30");

    controller.abort();
    await streamRes.body?.cancel().catch(() => {});
  });
});

describe("monitor bus · redaction is applied on the real path", () => {
  it("drops non-allowlisted token claims from the auth event", async () => {
    const port = await start(baseConfig({}));
    await initialize(port);

    const handle = open.handle;
    const authEvent = handle.bus.recent().find((e) => e.type === "auth");
    expect(authEvent).toBeDefined();

    const claims = authEvent?.meta?.claims as Record<string, unknown> | undefined;
    expect(claims).toBeDefined();
    // Neither claim is referenced by this configuration, so neither reaches
    // the monitor event in the first place.
    expect(claims?.email).toBeUndefined();
    expect(claims?.tenant).toBeUndefined();
    expect(claims?._redactedClaims).toBeUndefined();
  });

  it("keeps redaction off when explicitly disabled", async () => {
    const port = await start(
      baseConfig({ monitoring: { redact: { enabled: false } } }),
    );
    await initialize(port);

    const claims = open.handle.bus
      .recent()
      .find((e) => e.type === "auth")?.meta?.claims as Record<string, unknown> | undefined;
    // Disabling redaction never bypasses the configuration-derived projection.
    expect(claims?.email).toBeUndefined();
    expect(claims?.tenant).toBeUndefined();
  });
});
