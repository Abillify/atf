// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test, vi } from "vitest";
import { KeychainBridgeStore } from "./keychain-bridge.js";
import { createControlApi } from "./control-api.js";
import type { Runtime } from "./runtime.js";
import { Scheduler, SecretRedactor, type OutpostConfig } from "@atf/outpost-core";

// Placeholder PEM envelope without key material; only the structure is parsed.
const PEM_LABEL = "PRIVATE KEY";
const serviceAccount = JSON.stringify({ type: "service_account", client_email: "outpost@example.test", private_key: `-----BEGIN ${PEM_LABEL}-----\nkey\n-----END ${PEM_LABEL}-----` });

function setup() {
  const values = new Map<string, string>([["source:drive:oauth-refresh", "keep-me"]]);
  let failSecret = false;
  const store = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { if (failSecret && key.endsWith("s3-secret-key")) throw new Error("keychain failure"); values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
  const cfg = {
    sources: [
      { id: "drive", type: "gdrive", folderId: "folder", auth: "service-account" },
      { id: "s3", type: "s3", bucket: "bucket", credentials: "default" },
    ],
    syncIntervalSec: 900,
    health: { bind: "127.0.0.1", port: 8787 },
  } as unknown as OutpostConfig;
  const scheduler = new Scheduler({ cfg, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never, runSource: async () => ({ outcome: "ok", counters: { new: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 }, deletePhase: "none" }), flushSource: async () => undefined });
  const logout = vi.fn(async () => undefined);
  const rt = { cfg, credentialStore: store, redactor: new SecretRedactor(), storeFor: async () => ({ state: { items: {} } }), authManager: { logout } } as unknown as Runtime;
  const bridge = new KeychainBridgeStore(async () => ({ id: 1, ok: true }));
  return { values, logout, setFail: (value: boolean) => { failSecret = value; }, api: createControlApi({ rt, scheduler, bridge, ipcToken: "token", logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never }) };
}

async function call(port: number, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: "Bearer token", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Control-API static credentials", () => {
  test("stores and removes service-account credentials without echoing secrets", async () => {
    const { api, values } = setup();
    const port = await api.listen();
    try {
      const put = await call(port, "/sources/drive/credentials", "PUT", { kind: "gdrive-service-account", keyJson: serviceAccount });
      expect(put.status).toBe(204);
      expect(await values.get("source:drive:gdrive-sa")).toBe(serviceAccount);
      const status = await call(port, "/status", "GET");
      expect(await status.text()).not.toContain(serviceAccount);
      const remove = await call(port, "/sources/drive/credentials", "DELETE");
      expect(remove.status).toBe(204);
      expect(values.get("source:drive:gdrive-sa")).toBeUndefined();
      expect(values.get("source:drive:oauth-refresh")).toBe("keep-me");
    } finally { await api.close(); }
  });

  test("rolls back the S3 access key when the secret write fails", async () => {
    const { api, values, setFail } = setup();
    setFail(true);
    const port = await api.listen();
    try {
      const response = await call(port, "/sources/s3/credentials", "PUT", { kind: "s3-access-key", accessKeyId: "ACCESS123", secretAccessKey: "SECRET123" });
      expect(response.status).toBe(502);
      expect(values.get("source:s3:s3-access-key")).toBeUndefined();
      expect(values.get("source:s3:s3-secret-key")).toBeUndefined();
    } finally { await api.close(); }
  });

  test("rejects authorization for a service-account source and runs logout", async () => {
    const { api, logout } = setup();
    const port = await api.listen();
    try {
      const notAuthorizable = await call(port, "/sources/drive/authorize", "POST");
      const unknown = await call(port, "/sources/missing/authorize", "POST");
      const loggedOut = await call(port, "/auth/logout", "POST");
      expect(notAuthorizable.status).toBe(400);
      expect(unknown.status).toBe(404);
      expect(loggedOut.status).toBe(204);
      expect(logout).toHaveBeenCalledOnce();
    } finally { await api.close(); }
  });
});
