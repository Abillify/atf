// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { Authenticator, AuthError, extractBearer } from "../../src/auth/authenticator.ts";
import type { AuthConfig } from "../../src/config/schema.ts";

const staticConfig = {
  mode: "static",
  static: {
    tokens: [
      {
        token: "good-token",
        subject: "svc",
        username: "service-a",
        scopes: ["query:read"],
        claims: { tenant: "acme" },
      },
    ],
  },
} as unknown as AuthConfig;

describe("extractBearer", () => {
  it("parses a Bearer header case-insensitively", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("bearer xyz")).toBe("xyz");
  });
  it("returns undefined for missing or non-bearer headers", () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer("Basic abc")).toBeUndefined();
  });
});

describe("Authenticator (static)", () => {
  const auth = new Authenticator(staticConfig);

  it("accepts a valid token and builds the context", async () => {
    const ctx = await auth.authenticate("good-token", { "x-test": "1" });
    expect(ctx.method).toBe("static");
    expect(ctx.username).toBe("service-a");
    expect(ctx.subject).toBe("svc");
    expect(ctx.scopes).toEqual(["query:read"]);
    expect(ctx.claims).toEqual({ tenant: "acme" });
    expect(ctx.tenantId).toBe("default");
    expect(ctx.headers["x-test"]).toBe("1");
  });

  it("rejects an invalid token", async () => {
    await expect(auth.authenticate("nope", {})).rejects.toBeInstanceOf(AuthError);
  });
});

describe("Authenticator (oauth misconfig)", () => {
  it("fails clearly when oauth selected but not configured", async () => {
    const cfg = { mode: "oauth" } as unknown as AuthConfig;
    const auth = new Authenticator(cfg);
    await expect(auth.authenticate("whatever", {})).rejects.toBeInstanceOf(AuthError);
  });
});

describe("Authenticator (shared security model)", () => {
  it("returns a consistent anonymous context when disabled", async () => {
    const auth = new Authenticator({ mode: "disabled" } as AuthConfig);
    const ctx = await auth.authenticate(undefined, { "x-tenant-id": "untrusted" });
    expect(ctx).toMatchObject({
      method: "disabled",
      subject: "anonymous",
      username: "anonymous",
      scopes: [],
      claims: {},
      tenantId: "default",
      rawToken: "",
    });
  });

  it("derives tenantId only from configured verified claims and fails closed", async () => {
    const auth = new Authenticator(staticConfig, {
      enabled: true,
      defaultTenantId: "default",
      claimNames: ["tenant"],
    });
    expect((await auth.authenticate("good-token", { "x-tenant-id": "evil" })).tenantId).toBe(
      "acme",
    );

    const missing = new Authenticator(
      {
        mode: "static",
        static: { tokens: [{ token: "t", scopes: [], claims: {} }] },
      } as AuthConfig,
      { enabled: true, defaultTenantId: "default", claimNames: ["tenant"] },
    );
    await expect(missing.authenticate("t", {})).rejects.toMatchObject({ status: 403 });
  });
});