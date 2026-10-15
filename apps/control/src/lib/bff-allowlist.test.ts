// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";

import {
  BFF_ALLOWED_PREFIXES,
  BFF_DENIED_PREFIXES,
  isBffPathAllowed,
  normalizeBffPath,
} from "./bff-allowlist";

describe("isBffPathAllowed", () => {
  test("allows dashboard API paths at segment boundaries", () => {
    for (const path of [
      "/flows",
      "/flows/abc-123",
      "/admin/tenants",
      "/admin/tenants/t1/keys",
      "/monitoring/state",
      "/monitoring/events",
      "/monitoring/ticket",
      "/eval/runs",
      "/autopilot/status",
      "/optimizer/jobs",
      "/security/audit",
      "/triggers",
      "/triggers/t1/run",
      "/mcp/servers",
      "/v1/jobs/j1",
      "/v1/models",
      "/v1/models/gpt/retry",
    ]) {
      expect(isBffPathAllowed(path)).toBe(true);
    }
  });

  test("rejects prefixes that only match mid-segment", () => {
    expect(isBffPathAllowed("/flowsXYZ")).toBe(false);
    expect(isBffPathAllowed("/triggersXYZ")).toBe(false);
    expect(isBffPathAllowed("/v1/modelsXYZ")).toBe(false);
    expect(isBffPathAllowed("/mcp/serversXYZ")).toBe(false);
    expect(isBffPathAllowed("/v1/jobsX/y")).toBe(false);
  });

  test("allows Studio test runs and receipt verification", () => {
    for (const path of [
      "/v1/chat/completions",
      "/v1/receipts",
      "/v1/receipts/r-1/proof",
      "/.well-known/atf-receipt-jwks.json",
    ]) {
      expect(isBffPathAllowed(path)).toBe(true);
    }
  });

  test("rejects paths outside the allowlist", () => {
    for (const path of [
      "/",
      "",
      "flows",
      "http://evil.example/admin",
      "/admin",
      "/health",
      "/metrics",
      "/v1/chat",
      "/v1/chat/completionsX",
      "/v1/receiptsX",
      "/.well-known/other.json",
      "/monitoring",
      "/api/internal",
      "//admin/x",
    ]) {
      expect(isBffPathAllowed(path)).toBe(false);
    }
  });

  test("OIDC dance paths stay denied even under an allowed prefix", () => {
    for (const path of [
      "/monitoring/auth/login",
      "/monitoring/auth/callback",
      "/monitoring/auth/logout",
      "/monitoring/auth/refresh",
      "/monitoring/auth/config",
    ]) {
      expect(isBffPathAllowed(path)).toBe(false);
    }
    // The deny list must not spill over to sibling monitoring paths.
    expect(isBffPathAllowed("/monitoring/authz")).toBe(true);
  });

  test("dot-segment traversal cannot escape the allowlist", () => {
    expect(isBffPathAllowed("/admin/../secret")).toBe(false);
    expect(isBffPathAllowed("/monitoring/auth/../state")).toBe(true);
    expect(isBffPathAllowed("/monitoring/state/../../etc/passwd")).toBe(false);
    expect(isBffPathAllowed("/flows/../health")).toBe(false);
    expect(isBffPathAllowed("/./flows")).toBe(true);
  });
});

describe("normalizeBffPath", () => {
  test("returns the normalised path that must be forwarded", () => {
    expect(normalizeBffPath("/flows/abc")).toBe("/flows/abc");
    expect(normalizeBffPath("/./flows")).toBe("/flows");
    expect(normalizeBffPath("/monitoring/auth/../state")).toBe("/monitoring/state");
  });
  test("resolves backslashes and encoded dot segments before matching", () => {
    expect(normalizeBffPath("/admin\\..\\health")).toBeNull();
    expect(normalizeBffPath("/flows/%2e%2e/health")).toBeNull();
    expect(normalizeBffPath("/flows/%2E%2E/admin/tenants")).toBe("/admin/tenants");
  });
  test("keeps encoded separators inside their segment", () => {
    expect(normalizeBffPath("/flows/crm%2Fcancel")).toBe("/flows/crm%2Fcancel");
    expect(normalizeBffPath("/flows/a%5C..%5Chealth")).toBe("/flows/a%5C..%5Chealth");
  });
  test("rejects protocol-relative paths and query/fragment delimiters", () => {
    expect(normalizeBffPath("//flows/x")).toBeNull();
    expect(normalizeBffPath("/flows?x=1")).toBeNull();
    expect(normalizeBffPath("/flows#x")).toBeNull();
  });
});
describe("allowlist contents", () => {
  test("deny entries are subsets of allowed prefixes", () => {
    for (const denied of BFF_DENIED_PREFIXES) {
      const covered = BFF_ALLOWED_PREFIXES.some((prefix) =>
        denied.startsWith(prefix),
      );
      expect(covered).toBe(true);
    }
  });
});
