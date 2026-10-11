// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tenant resolution precedence for the assistant plane.
 *
 * The header fallback exists only for routers mounted without the platform auth
 * middleware. A verified principal must always win, because a header that could
 * override it would be an authorisation bypass rather than a convenience.
 */
import { describe, expect, test } from "bun:test";
import type { AuthPrincipal } from "../../middleware/auth.js";
import { resolveAssistantCaller } from "../assistant-caller.js";

const headers = (values: Record<string, string>): Headers => new Headers(values);

describe("resolveAssistantCaller tenant resolution", () => {
  test("reads the tenant from X-Tenant-Id", () => {
    const caller = resolveAssistantCaller(headers({ "X-Tenant-Id": "acme" }));
    expect(caller.tenantId).toBe("acme");
  });

  test("still accepts the legacy X-Mandant-Id spelling", () => {
    const caller = resolveAssistantCaller(headers({ "X-Mandant-Id": "acme" }));
    expect(caller.tenantId).toBe("acme");
  });

  test("prefers X-Tenant-Id over the legacy header", () => {
    const caller = resolveAssistantCaller(
      headers({ "X-Tenant-Id": "current", "X-Mandant-Id": "legacy" }),
    );
    expect(caller.tenantId).toBe("current");
  });

  test("a verified principal outranks both headers", () => {
    const principal: AuthPrincipal = {
      method: "token",
      verified: true,
      claims: { sub: "user-1" },
      tenantId: "verified",
    };
    const caller = resolveAssistantCaller(
      headers({ "X-Tenant-Id": "spoofed", "X-Mandant-Id": "spoofed-legacy" }),
      principal,
    );
    expect(caller.tenantId).toBe("verified");
  });

  // Req 7.4: a principal without a tenant (e.g. legacy mode, where unverified
  // claims resolve no tenant) must not have one re-filled from a header — the
  // header fallback exists only for routers mounted without auth middleware.
  test("a principal without a tenant never falls back to the headers", () => {
    const principal: AuthPrincipal = {
      method: "token",
      verified: false,
      claims: {},
    };
    const caller = resolveAssistantCaller(
      headers({ "X-Tenant-Id": "spoofed", "X-Mandant-Id": "spoofed-legacy" }),
      principal,
    );
    expect(caller.tenantId).toBeUndefined();
  });

  test("leaves the tenant unset when neither header nor principal supplies one", () => {
    const caller = resolveAssistantCaller(
      headers({ "X-OpenWebUI-User-Id": "user-1" }),
    );
    expect(caller.tenantId).toBeUndefined();
    expect(caller.userId).toBe("user-1");
  });
});
