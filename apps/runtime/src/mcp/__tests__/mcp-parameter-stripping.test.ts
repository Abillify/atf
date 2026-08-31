// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Parameter Stripping — Unit Tests
 *
 * Verifies that LLM-injected protected parameters (user_token, user_email,
 * client_id) are STRIPPED from outgoing tool call args, and that only
 * system-injected values from RequestContext are forwarded.
 *
 * Validates: Requirements 4.3, 4.4, 7.3
 */

import { describe, test, expect } from "bun:test";
import { stripProtectedParams, injectProtectedParams } from "../mcp-wrapper.js";
import type { RequestContext } from "../../types/monitoring.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTECTED_PARAMS = ["user_token", "user_email", "client_id"] as const;

// ---------------------------------------------------------------------------
// Tests: stripProtectedParams removes LLM-injected protected parameters
// ---------------------------------------------------------------------------

describe("MCP Parameter Stripping — LLM-injected protected params are removed", () => {
  test("strips user_token injected by LLM from tool call args", () => {
    const args = {
      query: "select * from users",
      user_token: "malicious-llm-injected-token",
    };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).not.toHaveProperty("user_token");
    expect(stripped).toHaveProperty("query", "select * from users");
  });

  test("strips user_email injected by LLM from tool call args", () => {
    const args = {
      message: "Hello world",
      user_email: "attacker@evil.com",
    };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).not.toHaveProperty("user_email");
    expect(stripped).toHaveProperty("message", "Hello world");
  });

  test("strips client_id injected by LLM from tool call args", () => {
    const args = {
      document_id: "doc-123",
      client_id: "foreign-tenant-id",
    };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).not.toHaveProperty("client_id");
    expect(stripped).toHaveProperty("document_id", "doc-123");
  });

  test("strips ALL protected params when LLM injects all three", () => {
    const args = {
      query: "search term",
      limit: 10,
      user_token: "llm-injected-token",
      user_email: "llm-injected@attack.com",
      client_id: "llm-injected-tenant",
    };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).not.toHaveProperty("user_token");
    expect(stripped).not.toHaveProperty("user_email");
    expect(stripped).not.toHaveProperty("client_id");
    expect(stripped).toEqual({ query: "search term", limit: 10 });
  });

  test("preserves all non-protected params unchanged", () => {
    const args = {
      query: "test",
      limit: 5,
      offset: 0,
      format: "json",
      user_token: "injected",
    };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).toEqual({
      query: "test",
      limit: 5,
      offset: 0,
      format: "json",
    });
  });

  test("does not mutate the original args object", () => {
    const args = {
      query: "test",
      user_token: "injected",
      user_email: "injected@test.com",
    };
    const originalKeys = Object.keys(args).sort();

    stripProtectedParams(args, PROTECTED_PARAMS);

    expect(Object.keys(args).sort()).toEqual(originalKeys);
  });

  test("returns empty object when all args are protected params", () => {
    const args = {
      user_token: "tok",
      user_email: "e@e.com",
      client_id: "t-1",
    };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).toEqual({});
  });

  test("returns all args unchanged when no protected params are present", () => {
    const args = { query: "hello", limit: 20, verbose: true };

    const stripped = stripProtectedParams(args, PROTECTED_PARAMS);

    expect(stripped).toEqual(args);
  });
});

// ---------------------------------------------------------------------------
// Tests: End-to-end strip + inject ensures system values override LLM values
// ---------------------------------------------------------------------------

describe("MCP Parameter Stripping — system-injected values replace LLM-injected values", () => {
  const systemContext: RequestContext = {
    ssoToken: "real-system-sso-token-xyz",
    executionId: "exec-abc-123",
    userEmail: "real-user@company.com",
    clientId: "real-tenant-42",
  };

  test("LLM-injected user_token is replaced by system ssoToken", () => {
    const llmArgs = {
      query: "search",
      user_token: "fake-llm-token",
      user_email: "fake@attacker.com",
      client_id: "fake-tenant",
    };

    // Step 1: Strip LLM-injected protected params
    const stripped = stripProtectedParams(llmArgs, PROTECTED_PARAMS);

    // Step 2: Inject real values from RequestContext
    const final = injectProtectedParams(stripped, systemContext);

    // Verify: system values are used, NOT LLM-injected values
    expect(final.user_token).toBe("real-system-sso-token-xyz");
    expect(final.user_email).toBe("real-user@company.com");
    expect(final.client_id).toBe("real-tenant-42");

    // Verify: legitimate args are preserved
    expect(final.query).toBe("search");
  });

  test("strip then inject roundtrip preserves legitimate args", () => {
    const llmArgs = {
      document_id: "doc-999",
      action: "retrieve",
      page: 2,
      user_token: "injected-by-llm",
    };

    const stripped = stripProtectedParams(llmArgs, PROTECTED_PARAMS);
    const final = injectProtectedParams(stripped, systemContext);

    expect(final.document_id).toBe("doc-999");
    expect(final.action).toBe("retrieve");
    expect(final.page).toBe(2);
    expect(final.user_token).toBe("real-system-sso-token-xyz");
  });

  test("with no LLM injection, system values are still injected correctly", () => {
    const cleanArgs = { query: "hello", limit: 10 };

    const stripped = stripProtectedParams(cleanArgs, PROTECTED_PARAMS);
    const final = injectProtectedParams(stripped, systemContext);

    expect(final.user_token).toBe("real-system-sso-token-xyz");
    expect(final.user_email).toBe("real-user@company.com");
    expect(final.client_id).toBe("real-tenant-42");
    expect(final.query).toBe("hello");
    expect(final.limit).toBe(10);
  });

  test("LLM cannot override system values even with matching key names", () => {
    const llmArgs = {
      user_token: "ATTACKER_TOKEN_THAT_SHOULD_NEVER_REACH_MCP_SERVER",
      user_email: "ATTACKER_EMAIL_THAT_SHOULD_NEVER_REACH_MCP_SERVER",
      client_id: "ATTACKER_TENANT_THAT_SHOULD_NEVER_REACH_MCP_SERVER",
      legitimate_param: "this is fine",
    };

    const stripped = stripProtectedParams(llmArgs, PROTECTED_PARAMS);
    const final = injectProtectedParams(stripped, systemContext);

    // None of the attacker values should survive
    expect(final.user_token).not.toBe(
      "ATTACKER_TOKEN_THAT_SHOULD_NEVER_REACH_MCP_SERVER",
    );
    expect(final.user_email).not.toBe(
      "ATTACKER_EMAIL_THAT_SHOULD_NEVER_REACH_MCP_SERVER",
    );
    expect(final.client_id).not.toBe(
      "ATTACKER_TENANT_THAT_SHOULD_NEVER_REACH_MCP_SERVER",
    );

    // System values are used instead
    expect(final.user_token).toBe("real-system-sso-token-xyz");
    expect(final.user_email).toBe("real-user@company.com");
    expect(final.client_id).toBe("real-tenant-42");
    expect(final.legitimate_param).toBe("this is fine");
  });
});
