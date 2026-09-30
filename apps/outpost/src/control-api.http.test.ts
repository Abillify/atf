// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import { request } from "node:http";
import { createControlApi } from "./control-api.js";
import type { Runtime } from "./runtime.js";
import { Scheduler, type OutpostConfig } from "@atf/outpost-core";

const cfg = { sources: [], syncIntervalSec: 900, health: { bind: "127.0.0.1", port: 8787 } } as unknown as OutpostConfig;
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

function httpStatus(port: number, authorization: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/status", headers: { Authorization: authorization, Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function makeApi() {
  const scheduler = new Scheduler({ cfg, logger, runSource: async () => ({ outcome: "ok", counters: { new: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 }, deletePhase: "none" }), flushSource: async () => undefined });
  const rt = {
    cfg,
    credentialStore: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    storeFor: async () => ({ state: { items: {} } }),
    authManager: {},
  } as unknown as Runtime;
  const bridge = {} as never;
  const api = createControlApi({ rt, scheduler, bridge, ipcToken: "correct-token", logger });
  return { api, scheduler };
}

describe("Control-API HTTP authentication", () => {
  test("rejects missing and wrong tokens before routing", async () => {
    const { api } = makeApi();
    const port = await api.listen();
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Host: `127.0.0.1:${port}` } });
      const wrong = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: "Bearer wrong", Host: `127.0.0.1:${port}` } });
      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
    } finally { await api.close(); }
  });

  test("rejects a non-loopback Host and accepts the correct request", async () => {
    const { api } = makeApi();
    const port = await api.listen();
    try {
      expect(await httpStatus(port, "Bearer correct-token", "localhost")).toBe(403);
      expect(await httpStatus(port, "Bearer correct-token", `127.0.0.1:${port}`)).toBe(200);
    } finally { await api.close(); }
  });
});
