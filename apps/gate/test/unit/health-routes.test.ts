// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Gate health probes. An instance whose `auth.mode` is `disabled` answers every
 * request anonymously; both probes say so (`auth: "disabled"`), so it cannot be
 * mistaken for a protected one (P0-1).
 */
import { afterEach, describe, expect, it } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installHealthRoutes } from "../../src/server/health-routes.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(authDisabled: boolean | undefined): Promise<string> {
  const app = express();
  installHealthRoutes(app, {
    db: { names: () => [], healthcheck: async () => undefined },
    toolCount: () => 3,
    transactionLedger: { backing: "memory" },
    ...(authDisabled !== undefined ? { authDisabled } : {}),
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server?.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("Gate health probes · auth signal", () => {
  it("both probes carry auth: disabled while authentication is off", async () => {
    const base = await serve(true);
    expect(((await (await fetch(`${base}/healthz`)).json()) as { auth?: string }).auth).toBe("disabled");
    expect(((await (await fetch(`${base}/readyz`)).json()) as { auth?: string }).auth).toBe("disabled");
  });

  it("adds nothing when authentication is on (or the flag is absent)", async () => {
    for (const flag of [false, undefined]) {
      const base = await serve(flag);
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok" });
      expect(await (await fetch(`${base}/readyz`)).json()).not.toHaveProperty("auth");
      server?.close();
    }
  });
});
