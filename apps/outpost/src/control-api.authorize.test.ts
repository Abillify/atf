// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Task 20.12: Control API authorization (PKCE via the bridge, SSE
 * result) and the logout sequence (stopAll → flush → token deletion, `source:*`
 * stays). Requirements 3.5, 3.8, 3.9, 6.4, 6.9, 6.10, 13.5, 15.4.
 */

import { describe, expect, test, vi } from "vitest";
import { Scheduler, EXTRACT_AUTH_KEYS, type OutpostConfig } from "@atf/outpost-core";
import { KeychainBridgeStore, type BridgeRequest, type BridgeResponse } from "./keychain-bridge.js";
import { createControlApi } from "./control-api.js";
import type { Runtime } from "./runtime.js";

const NULL_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

interface SetupOptions {
  /** Answer to `loopback.result`; default: hangs (the test delivers it itself). */
  loopbackResult?: Promise<Record<string, string>>;
  /** The provider's token endpoint answer. */
  tokenResponse?: { status: number; body: Record<string, unknown> };
}

function setup(options: SetupOptions = {}) {
  const values = new Map<string, string>([
    ["auth:extract:refresh-token", "extract-refresh"],
    ["auth:extract:api-token", "extract-api"],
    ["source:db:oauth-refresh", "old-refresh"],
  ]);
  const captured: { browserUrl?: string } = {};
  const loopbackResult =
    options.loopbackResult ?? new Promise<Record<string, string>>(() => undefined);

  const transport = async (request: BridgeRequest): Promise<BridgeResponse> => {
    switch (request.op) {
      case "get":
        return { id: request.id, ok: true, value: values.get(request.key ?? "") ?? null };
      case "set":
        values.set(request.key ?? "", request.value ?? "");
        return { id: request.id, ok: true };
      case "delete":
        values.delete(request.key ?? "");
        return { id: request.id, ok: true };
      case "loopback.open":
        return { id: request.id, ok: true, port: 54_321 };
      case "browser.open":
        captured.browserUrl = request.url;
        return { id: request.id, ok: true };
      case "loopback.result":
        return { id: request.id, ok: true, query: await loopbackResult };
    }
  };

  const cfg = {
    extractUrl: "https://extract.example.test",
    cloudOAuth: { dropbox: { appKey: "db-app-key" } },
    sources: [
      { id: "db", type: "dropbox", root: "" },
      { id: "ordner", type: "local", path: "/tmp/ordner" },
    ],
    syncIntervalSec: 0,
    health: { bind: "127.0.0.1", port: 8787 },
  } as unknown as OutpostConfig;

  const scheduler = new Scheduler({
    cfg,
    logger: NULL_LOGGER,
    runSource: async () => ({
      outcome: "ok",
      counters: { new: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 },
      deletePhase: "none",
    }),
    flushSource: async () => undefined,
  });

  const rt = {
    cfg,
    env: {},
    credentialStore: {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    },
    redactor: { register: () => undefined } as never,
    storeFor: async () => ({ state: { items: {} } }),
    authManager: { logout: async () => undefined },
  } as unknown as Runtime;

  const tokenResponse = options.tokenResponse ?? {
    status: 200,
    body: { access_token: "access-token", refresh_token: "new-refresh" },
  };
  const fetchImpl = vi.fn(async () => ({
    status: tokenResponse.status,
    ok: tokenResponse.status >= 200 && tokenResponse.status < 300,
    json: async () => tokenResponse.body,
    text: async () => JSON.stringify(tokenResponse.body),
  })) as never;

  const api = createControlApi({
    rt,
    scheduler,
    bridge: new KeychainBridgeStore(transport),
    ipcToken: "token",
    logger: NULL_LOGGER,
    fetchImpl,
  });

  return { api, values, captured, scheduler };
}

async function call(port: number, path: string, method: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: "Bearer token" },
  });
}

/** Opens the SSE stream; `next(name)` waits for the named event. */
async function openEvents(port: number): Promise<{
  next: (name: string, timeoutMs?: number) => Promise<unknown>;
  close: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/events`, {
    headers: { Authorization: "Bearer token" },
    signal: controller.signal,
  });
  if (response.body === null) throw new Error("SSE ohne Body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = "";
  const notify: (() => void)[] = [];
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data !== "") events.push({ event, data: JSON.parse(data) as unknown });
      }
      for (const wake of notify.splice(0)) wake();
    }
  };
  void pump().catch(() => undefined);
  const next = async (name: string, timeoutMs = 3_000): Promise<unknown> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find((e) => e.event === name);
      if (found !== undefined) return found.data;
      if (Date.now() > deadline) throw new Error(`SSE-Ereignis ${name} nicht erhalten`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        notify.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return { next, close: () => controller.abort() };
}

/** Waits for the authorization URL and returns its `state`. */
async function authorizeState(captured: { browserUrl?: string }): Promise<string> {
  await vi.waitFor(() => expect(captured.browserUrl).toBeDefined(), { timeout: 3_000 });
  return new URL(captured.browserUrl as string).searchParams.get("state") ?? "";
}

describe("Control API authorization (PKCE via the bridge, SSE)", () => {
  test("202 pending; state mismatch → source.authorization_failed, token unchanged", async () => {
    const { api, values, captured } = setup({
      loopbackResult: Promise.resolve({ code: "auth-code", state: "falscher-state" }),
    });
    const port = await api.listen();
    const events = await openEvents(port);
    try {
      const pending = await call(port, "/sources/db/authorize", "POST");
      expect(pending.status).toBe(202);
      expect(await pending.json()).toEqual({ status: "pending" });
      const failure = await events.next("source.authorization_failed");
      expect(failure).toMatchObject({ sourceId: "db", reason: "state-mismatch" });
      expect(values.get("source:db:oauth-refresh")).toBe("old-refresh");
      expect(captured.browserUrl).toBeDefined();
    } finally {
      events.close();
      await api.close();
    }
  });

  test("erfolgreicher Code-Tausch: source.authorized, Token gespeichert, Trigger", async () => {
    let resolveRedirect: (query: Record<string, string>) => void = () => undefined;
    const { api, values, captured, scheduler } = setup({
      loopbackResult: new Promise((resolve) => {
        resolveRedirect = resolve;
      }),
    });
    const port = await api.listen();
    const events = await openEvents(port);
    try {
      const pending = await call(port, "/sources/db/authorize", "POST");
      expect(pending.status).toBe(202);
      const state = await authorizeState(captured);
      // PKCE parameters must be in the authorization URL (15.2).
      const url = new URL(captured.browserUrl as string);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
      resolveRedirect({ code: "auth-code", state });
      expect(await events.next("source.authorized")).toEqual({ sourceId: "db" });
      expect(values.get("source:db:oauth-refresh")).toBe("new-refresh");
      // credentialChanged triggered a run for the source.
      await vi.waitFor(() => {
        expect(scheduler.status().find((s) => s.sourceId === "db")?.lastRun).toBeDefined();
      });
    } finally {
      events.close();
      await api.close();
    }
  });

  test("409 for a running authorization, 400 local source, 404 unknown", async () => {
    let release: (query: Record<string, string>) => void = () => undefined;
    const { api, captured } = setup({
      loopbackResult: new Promise((resolve) => {
        release = resolve;
      }),
    });
    const port = await api.listen();
    try {
      const first = await call(port, "/sources/db/authorize", "POST");
      expect(first.status).toBe(202);
      const state = await authorizeState(captured);
      const duplicate = await call(port, "/sources/db/authorize", "POST");
      expect(duplicate.status).toBe(409);
      expect((await call(port, "/sources/ordner/authorize", "POST")).status).toBe(400);
      expect((await call(port, "/sources/fehlend/authorize", "POST")).status).toBe(404);
      release({ code: "c", state });
    } finally {
      await api.close();
    }
  });

  test("rejected code exchange: error message without token/provider content", async () => {
    let resolveRedirect: (query: Record<string, string>) => void = () => undefined;
    const { api, values, captured } = setup({
      loopbackResult: new Promise((resolve) => {
        resolveRedirect = resolve;
      }),
      tokenResponse: {
        status: 400,
        body: { error: "invalid_grant", error_description: "super-secret-detail" },
      },
    });
    const port = await api.listen();
    const events = await openEvents(port);
    try {
      expect((await call(port, "/sources/db/authorize", "POST")).status).toBe(202);
      const state = await authorizeState(captured);
      resolveRedirect({ code: "auth-code", state });
      const failure = await events.next("source.authorization_failed");
      const serialized = JSON.stringify(failure);
      expect(failure).toMatchObject({ sourceId: "db" });
      expect(serialized).not.toContain("super-secret-detail");
      expect(serialized).not.toContain("auth-code");
      expect(values.get("source:db:oauth-refresh")).toBe("old-refresh");
    } finally {
      events.close();
      await api.close();
    }
  });
});

describe("Control-API Logout-Sequenz", () => {
  test("stopAll → flush → token deletion; source:* keys stay", async () => {
    const values = new Map<string, string>([
      ["auth:extract:refresh-token", "extract-refresh"],
      ["auth:extract:api-token", "extract-api"],
      ["source:db:oauth-refresh", "cloud-refresh"],
      ["source:db:s3-access-key", "ak"],
    ]);
    const order: string[] = [];
    const cfg = {
      sources: [{ id: "db", type: "dropbox", root: "" }],
      syncIntervalSec: 0,
      health: { bind: "127.0.0.1", port: 8787 },
    } as unknown as OutpostConfig;
    const scheduler = new Scheduler({
      cfg,
      logger: NULL_LOGGER,
      runSource: (_src, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                outcome: "incomplete",
                counters: { new: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 },
                deletePhase: "none",
              }),
            { once: true },
          );
        }),
      flushSource: async (sourceId: string) => {
        order.push(`flush:${sourceId}`);
      },
    });
    const rt = {
      cfg,
      env: {},
      credentialStore: {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => {
          values.set(key, value);
        },
        delete: async (key: string) => {
          values.delete(key);
        },
      },
      redactor: { register: () => undefined } as never,
      storeFor: async () => ({ state: { items: {} } }),
      authManager: {
        logout: async () => {
          order.push("logout");
          for (const key of EXTRACT_AUTH_KEYS) values.delete(key);
        },
      },
    } as unknown as Runtime;
    const api = createControlApi({
      rt,
      scheduler,
      bridge: new KeychainBridgeStore(async (request) => ({ id: request.id, ok: true })),
      ipcToken: "token",
      logger: NULL_LOGGER,
    });
    const port = await api.listen();
    try {
      scheduler.trigger("db");
      await vi.waitFor(() => {
        expect(scheduler.status().find((s) => s.sourceId === "db")?.status).toBe("running");
      });
      const response = await call(port, "/auth/logout", "POST");
      expect(response.status).toBe(204);
      // Order: state flush BEFORE deleting the Extract tokens (3.5).
      expect(order).toEqual(["flush:db", "logout"]);
      // Only EXTRACT_AUTH_KEYS removed, cloud keys unchanged (3.9).
      expect(values.has("auth:extract:refresh-token")).toBe(false);
      expect(values.has("auth:extract:api-token")).toBe(false);
      expect(values.get("source:db:oauth-refresh")).toBe("cloud-refresh");
      expect(values.get("source:db:s3-access-key")).toBe("ak");
      // All sources stopped, no more triggers.
      expect(scheduler.status().every((s) => s.status === "stopped")).toBe(true);
    } finally {
      await api.close();
    }
  });
});
