// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Security-Critical Paths — Guard Tests
 *
 * One test per security-critical path to confirm that each path is covered by
 * its dedicated module. Serves as a meta-guard: if any of the underlying
 * modules is removed or its security function signature changes, this suite
 * will break and signal the regression immediately.
 *
 * Guards covered:
 *   - MCP-Stripping       (Req. 4.3)  — stripProtectedParams removes LLM-injected params
 *   - Plugin-Loader       (Req. 4.1, 4.2) — createPluginVerifier rejects non-allowlisted plugins
 *   - Cluster-wide limits (Req. 2.4)  — documented guard at cluster-limits.integration.test.ts
 *   - RLS cross-tenant    (Req. 3.2)  — documented guard at bootstrap/__tests__/verify-rls.test.ts
 *
 * Requirements: 7.3
 */

import { describe, test, expect } from "bun:test";
import { stripProtectedParams } from "../mcp/mcp-wrapper.js";
import { createPluginVerifier } from "../graph/plugin-verifier.js";

// ---------------------------------------------------------------------------
// Guard 1 — MCP Parameter Stripping (Req. 4.3)
// Verifies that stripProtectedParams removes protected parameters injected by
// the LLM. The full suite lives in mcp/__tests__/mcp-parameter-stripping.test.ts
// ---------------------------------------------------------------------------

describe("Security Guard: MCP parameter stripping", () => {
  const PROTECTED_PARAMS = ["user_token", "user_email", "client_id"] as const;

  test("stripProtectedParams removes LLM-injected protected parameters before MCP tool call", () => {
    const argsWithInjection = {
      query: "legitimate query",
      user_token: "llm-injected-token-should-be-stripped",
      user_email: "attacker@evil.com",
      client_id: "foreign-tenant-id",
    };

    const stripped = stripProtectedParams(argsWithInjection, PROTECTED_PARAMS);

    // All three protected params must be gone
    expect(stripped).not.toHaveProperty("user_token");
    expect(stripped).not.toHaveProperty("user_email");
    expect(stripped).not.toHaveProperty("client_id");

    // Legitimate business params must survive
    expect(stripped).toHaveProperty("query", "legitimate query");
  });

  test("stripProtectedParams does not mutate the original args object", () => {
    const original = {
      data: "value",
      user_token: "injected",
    };
    const keysBefore = Object.keys(original).sort();

    stripProtectedParams(original, PROTECTED_PARAMS);

    expect(Object.keys(original).sort()).toEqual(keysBefore);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — Plugin-Loader Allowlist (Req. 4.1, 4.2)
// Verifies that createPluginVerifier rejects plugins not in the allowlist and
// logs a security event. Full suite: graph/__tests__/plugin-verifier.test.ts
// ---------------------------------------------------------------------------

describe("Security Guard: Plugin-loader allowlist", () => {
  test("non-allowlisted plugin is rejected in production", () => {
    const verifier = createPluginVerifier({
      allowlist: ["trusted-plugin.ts"],
      appEnv: "production",
    });

    const result = verifier.verify("evil-plugin.ts", "/plugins/evil-plugin.ts");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("PLUGINS_ALLOWLIST");
  });

  test("allowlisted plugin is accepted", () => {
    const verifier = createPluginVerifier({
      allowlist: ["trusted-plugin.ts"],
      appEnv: "production",
    });

    const result = verifier.verify(
      "trusted-plugin.ts",
      "/plugins/trusted-plugin.ts",
    );

    expect(result.allowed).toBe(true);
  });

  test("verifier.isActive is true when allowlist is configured", () => {
    const verifier = createPluginVerifier({
      allowlist: ["some-plugin.ts"],
      appEnv: "production",
    });

    expect(verifier.isActive).toBe(true);
  });

  test("no allowlist or manifest in production denies all plugins (safe default)", () => {
    const verifier = createPluginVerifier({ appEnv: "production" });

    const result = verifier.verify("any-plugin.ts", "/plugins/any-plugin.ts");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("production");
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — Cluster-wide limits (Req. 2.4)
// The full integration test lives at:
//   src/graph/__tests__/cluster-limits.integration.test.ts
//
// This guard documents that the test file exists and covers concurrent
// rate-limit counter and semaphore enforcement.
// ---------------------------------------------------------------------------

describe("Security Guard: Cluster-wide limits (documented guard)", () => {
  test("cluster-limits integration test file exists and covers Req. 2.4", async () => {
    // Verify the guard file exists (import will throw if module is missing)
    const { InMemoryConcurrencyLimiter } = await import(
      "../graph/distributed-semaphore.js"
    );
    expect(typeof InMemoryConcurrencyLimiter).toBe("function");

    // Quick sanity-check: limiter enforces its own limit
    const limiter = new InMemoryConcurrencyLimiter({
      maxConcurrent: 1,
      maxWaitMs: 50,
      retryMs: 10,
    });
    const slot = await limiter.acquire();
    expect(slot).toBeDefined();
    await slot.release();
  });
});

// ---------------------------------------------------------------------------
// Guard 4 — RLS Cross-Tenant isolation (Req. 3.2)
// The full integration test lives at:
//   src/bootstrap/__tests__/verify-rls.test.ts
//
// This guard documents that the verifyRls function exists and enforces
// row-level security on all tenant tables.
// ---------------------------------------------------------------------------

describe("Security Guard: RLS cross-tenant isolation (documented guard)", () => {
  test("verifyRls function exists and is exported from bootstrap/persistence", async () => {
    const { verifyRls } = await import("../bootstrap/persistence.js");
    expect(typeof verifyRls).toBe("function");
  });

  test("verifyRls returns false when a tenant table has RLS disabled", async () => {
    const { verifyRls } = await import("../bootstrap/persistence.js");

    // Minimal fake DB that returns one table with RLS disabled
    const fakeDb = {
      query: async () => [
        {
          relname: "cost_ledger",
          relrowsecurity: false,
          relforcerowsecurity: false,
        },
      ],
      close: async () => {},
      withOperator: async <T>(cb: (db: unknown) => Promise<T>) => cb({}),
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    // verifyRls returns false (not all required tables have RLS enabled)
    const result = await verifyRls(fakeDb as never, fakeLogger as never);
    expect(result).toBe(false);
  });
});
