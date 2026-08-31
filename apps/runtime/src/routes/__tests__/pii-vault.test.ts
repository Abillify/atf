// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the PII vault status route (`src/routes/pii-vault.ts`).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createPiiVaultRouter } from "../pii-vault.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

const viewerAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [{ token: "viewer-tok", role: "viewer" }],
});

describe("GET /admin/pii-vault/status", () => {
  it("reports enabled + durable + explicit types", async () => {
    const app = new Hono();
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: true,
        durable: true,
        piiTypes: ["email", "phone"],
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/pii-vault/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      durable: boolean;
      piiTypes: string[] | string;
      detectors: string[];
      multimodalMode: string;
    };
    expect(body).toEqual({
      enabled: true,
      durable: true,
      piiTypes: ["email", "phone"],
      detectors: ["regex (legacy sync)"],
      multimodalMode: "off",
    });
  });

  it("reports the active multimodal mode when configured (ADR-0016)", async () => {
    const app = new Hono();
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: true,
        durable: true,
        piiTypes: [],
        multimodalMode: "block",
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/pii-vault/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as { multimodalMode: string };
    expect(body.multimodalMode).toBe("block");
  });

  it("reports 'all' when no explicit type subset is configured", async () => {
    const app = new Hono();
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: true,
        durable: false,
        piiTypes: [],
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/pii-vault/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as { piiTypes: string };
    expect(body.piiTypes).toBe("all");
  });

  it("reports the active detector backends when configured (ADR-0015)", async () => {
    const app = new Hono();
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: true,
        durable: true,
        piiTypes: [],
        detectors: ["regex", "ner"],
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/pii-vault/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as { detectors: string[] };
    expect(body.detectors).toEqual(["regex", "ner"]);
  });

  it("reports disabled when the vault is off", async () => {
    const app = new Hono();
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: false,
        durable: false,
        piiTypes: [],
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/pii-vault/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const app = new Hono();
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: true,
        durable: true,
        piiTypes: [],
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/pii-vault/status");
    expect(res.status).toBe(401);
  });
});
