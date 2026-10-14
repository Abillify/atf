// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for src/config/index.ts — loadConfig() validation
 *
 * Feature: ai-agent-orchestration-platform, Property 24: Configuration validation for missing required fields
 * Validates: Requirements 10.5, 11.5
 *
 * Note: loadConfig() reads from process.env directly and calls process.exit(1)
 * on invalid configuration. Tests mock process.exit and process.stderr.write
 * to intercept these behaviors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { loadConfig } from "../index.js";

// ---------------------------------------------------------------------------
// Env save/restore helpers
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;
const TEST_FLOWS_DIR = "/tmp/aiperator-config-test-flows";

beforeEach(() => {
  // Deep-copy all env vars so we can fully restore them
  savedEnv = { ...process.env };

  // Remove all config-relevant vars before each test
  delete process.env.PORT;
  delete process.env.FLOWS_DIR;
  delete process.env.MONITORING_TRANSPORT;
  delete process.env.MCP_SCHEMA_COMPATIBILITY_MODE;
  delete process.env.LLM_STREAM_FALLBACK_POLICY;
  delete process.env.LLM_HTTP_KEEP_ALIVE;
  delete process.env.MCP_SERVERS;
  delete process.env.PROVIDERS;
  delete process.env.DEFAULT_LLM;
  delete process.env.PROFILE;
  delete process.env.AUTHN_MODE;
  delete process.env.BYOK_ENABLED;
  delete process.env.BYOK_MODE;
  delete process.env.EXECUTION_TIMEOUT_MS;
  delete process.env.MCP_TX_SECRET;
  delete process.env.MCP_TX_ACTOR_SECRET;
  delete process.env.APP_ENV;
  delete process.env.TRANSACTION_SIGNING_ALG;
  delete process.env.TRANSACTION_SIGNING_KEY;
  delete process.env.INPUT_GUARDRAIL_MODEL_FAIL_MODE;
  delete process.env.INPUT_GUARDRAIL_MAX_CHARS;
  // Keep configuration tests independent of the repository's flows/mcp.yaml.
  // The loader uses ./flows by default, which is intentionally populated in
  // production and would otherwise add real MCP servers to these env tests.
  process.env.FLOWS_DIR = TEST_FLOWS_DIR;
});

afterEach(() => {
  // Restore original env
  // First remove any keys that were added during the test
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  // Then restore the saved values
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------------------
// Helpers to mock process.exit and process.stderr.write
// ---------------------------------------------------------------------------

/** Runs loadConfig() with mocked exit/stderr, expecting it to call exit(1). */
function expectConfigFailure(envOverrides?: Record<string, string>): {
  stderrOutput: string[];
} {
  if (envOverrides) {
    Object.assign(process.env, envOverrides);
  }

  const stderrOutput: string[] = [];
  let exitCode: number | undefined;

  const originalExit = process.exit.bind(process);
  const originalStderr = process.stderr.write.bind(process.stderr);

  (process as NodeJS.Process).exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  process.stderr.write = (chunk: unknown) => {
    stderrOutput.push(String(chunk));
    return true;
  };

  try {
    loadConfig();
    // If we get here, loadConfig() didn't call exit — unexpected
    throw new Error("loadConfig() did not call process.exit");
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.startsWith("process.exit(")) {
      throw err; // Re-throw unexpected errors
    }
  } finally {
    (process as NodeJS.Process).exit = originalExit;
    process.stderr.write = originalStderr;
  }

  expect(exitCode).toBe(1);
  return { stderrOutput };
}

/** Runs loadConfig() expecting success, returns the config. */
function expectConfigSuccess(envOverrides?: Record<string, string>) {
  if (envOverrides) {
    Object.assign(process.env, envOverrides);
  }
  return loadConfig();
}

// ---------------------------------------------------------------------------
// Unit Tests — valid configurations
// ---------------------------------------------------------------------------

describe("loadConfig() — valid configurations", () => {
  test("succeeds with empty env (all defaults)", () => {
    const config = expectConfigSuccess();
    expect(config.port).toBe(3000);
    expect(config.flowsDir).toBe(TEST_FLOWS_DIR);
    expect(config.monitoringTransport).toBe("sse");
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpSchemaCompatibilityMode).toBe("report");
    expect(config.llmStreamFallbackPolicy).toBe("legacy");
    expect(config.defaultLlm).toBeUndefined();
    expect(config.executionTimeoutMs).toBe(120_000);
    expect(config.strictIdentityHeaders).toBe(false);
    expect(config.rateLimitPreAuthPerMinute).toBe(0);
    expect(config.rateLimitPostAuthPerMinute).toBe(0);
  });

  test("parses strict identity and additive rate-limit env values", () => {
    const config = expectConfigSuccess({
      STRICT_IDENTITY_HEADERS: "1",
      RATE_LIMIT_PRE_AUTH_PER_MINUTE: "17",
      RATE_LIMIT_POST_AUTH_PER_MINUTE: "23",
    });
    expect(config.strictIdentityHeaders).toBe(true);
    expect(config.rateLimitPreAuthPerMinute).toBe(17);
    expect(config.rateLimitPostAuthPerMinute).toBe(23);
  });

  // Requirement 7.9: API_KEY_PEPPER enables peppered HMAC-SHA-256 key hashing.
  test("API_KEY_PEPPER is undefined by default and passed through when set", () => {
    expect(expectConfigSuccess().apiKeyPepper).toBeUndefined();
    expect(
      expectConfigSuccess({ API_KEY_PEPPER: "s3cret-pepper" }).apiKeyPepper,
    ).toBe("s3cret-pepper");
    // Blank/whitespace counts as unset — the legacy SHA-256 form stays active.
    expect(
      expectConfigSuccess({ API_KEY_PEPPER: "   " }).apiKeyPepper,
    ).toBeUndefined();
  });

  // Requirement 7.11: asymmetric transaction-token signing configuration.
  test("TRANSACTION_SIGNING_ALG/KEY are parsed into the config (Req 7.11)", () => {
    expect(expectConfigSuccess().transactionSigningAlg).toBeUndefined();
    expect(expectConfigSuccess().transactionSigningKey).toBeUndefined();
    const config = expectConfigSuccess({
      TRANSACTION_SIGNING_ALG: "ES256",
      // Synthetic PEM, assembled so the public-tree scanner does not flag it.
      TRANSACTION_SIGNING_KEY: [
        "-----BEGIN",
        "PRIVATE KEY-----\nabc\n-----END",
      ].join(" "),
    });
    expect(config.transactionSigningAlg).toBe("ES256");
    expect(config.transactionSigningKey).toContain("BEGIN PRIVATE KEY");
    expect(
      expectConfigSuccess({ TRANSACTION_SIGNING_ALG: "EdDSA" })
        .transactionSigningAlg,
    ).toBe("EdDSA");
    // Blank PEM counts as unset.
    expect(
      expectConfigSuccess({ TRANSACTION_SIGNING_KEY: "   " })
        .transactionSigningKey,
    ).toBeUndefined();
  });

  test("invalid TRANSACTION_SIGNING_ALG is rejected at startup (Req 7.11)", () => {
    const { stderrOutput } = expectConfigFailure({
      TRANSACTION_SIGNING_ALG: "RS512",
    });
    expect(stderrOutput.join("\n")).toContain("TRANSACTION_SIGNING_ALG");
  });

  // Requirement 7.5: the input-guardrail fail mode defaults to `open` in
  // Development and `closed` in Production, with an explicit override.
  test("input guardrail fail mode defaults to open outside production", () => {
    expect(expectConfigSuccess().inputGuardrailModelFailMode).toBe("open");
    expect(
      expectConfigSuccess({ APP_ENV: "development" })
        .inputGuardrailModelFailMode,
    ).toBe("open");
  });

  test("input guardrail fail mode defaults to closed in production", () => {
    expect(
      expectConfigSuccess({ APP_ENV: "production" })
        .inputGuardrailModelFailMode,
    ).toBe("closed");
  });

  test("input guardrail fail mode explicit override wins over APP_ENV", () => {
    expect(
      expectConfigSuccess({
        APP_ENV: "production",
        INPUT_GUARDRAIL_MODEL_FAIL_MODE: "open",
      }).inputGuardrailModelFailMode,
    ).toBe("open");
    expect(
      expectConfigSuccess({
        APP_ENV: "development",
        INPUT_GUARDRAIL_MODEL_FAIL_MODE: "closed",
      }).inputGuardrailModelFailMode,
    ).toBe("closed");
  });

  test("rejects an invalid input guardrail fail mode", () => {
    const { stderrOutput } = expectConfigFailure({
      INPUT_GUARDRAIL_MODEL_FAIL_MODE: "lenient",
    });
    expect(stderrOutput.join("\n")).toContain(
      "INPUT_GUARDRAIL_MODEL_FAIL_MODE",
    );
  });

  // Requirement 12.4: migrations run at boot outside production by default;
  // production defaults to dedicated migration Jobs (`bun run migrate`).
  test("migrateOnStart defaults to true outside production", () => {
    expect(expectConfigSuccess().migrateOnStart).toBe(true);
    expect(expectConfigSuccess({ APP_ENV: "development" }).migrateOnStart).toBe(
      true,
    );
  });

  test("migrateOnStart defaults to false in production", () => {
    expect(expectConfigSuccess({ APP_ENV: "production" }).migrateOnStart).toBe(
      false,
    );
  });

  test("MIGRATE_ON_START explicit override wins over APP_ENV", () => {
    expect(
      expectConfigSuccess({ APP_ENV: "production", MIGRATE_ON_START: "true" })
        .migrateOnStart,
    ).toBe(true);
    expect(
      expectConfigSuccess({
        APP_ENV: "development",
        MIGRATE_ON_START: "false",
      }).migrateOnStart,
    ).toBe(false);
  });

  // Requirement 7.6: classifier character budget for chunked classification.
  test("input guardrail max chars defaults to 8000 and parses overrides", () => {
    expect(expectConfigSuccess().inputGuardrailMaxChars).toBe(8000);
    expect(
      expectConfigSuccess({ INPUT_GUARDRAIL_MAX_CHARS: "12000" })
        .inputGuardrailMaxChars,
    ).toBe(12000);
  });

  test("parses strict MCP schema compatibility mode", () => {
    expect(
      expectConfigSuccess({ MCP_SCHEMA_COMPATIBILITY_MODE: "strict" })
        .mcpSchemaCompatibilityMode,
    ).toBe("strict");
  });

  test("parses every LLM stream fallback policy", () => {
    for (const policy of [
      "legacy",
      "report",
      "explicit",
      "disabled",
    ] as const) {
      expect(
        expectConfigSuccess({ LLM_STREAM_FALLBACK_POLICY: policy })
          .llmStreamFallbackPolicy,
      ).toBe(policy);
    }
  });

  test("LLM_HTTP_KEEP_ALIVE defaults to true and accepts false/0", () => {
    expect(expectConfigSuccess().llmHttpKeepAlive).toBe(true);
    expect(expectConfigSuccess({ LLM_HTTP_KEEP_ALIVE: "true" }).llmHttpKeepAlive).toBe(true);
    expect(expectConfigSuccess({ LLM_HTTP_KEEP_ALIVE: "false" }).llmHttpKeepAlive).toBe(false);
    expect(expectConfigSuccess({ LLM_HTTP_KEEP_ALIVE: "0" }).llmHttpKeepAlive).toBe(false);
  });
  test("rejects an invalid LLM stream fallback policy", () => {
    const { stderrOutput } = expectConfigFailure({
      LLM_STREAM_FALLBACK_POLICY: "permissive",
    });
    expect(stderrOutput.join("\n")).toContain("LLM_STREAM_FALLBACK_POLICY");
  });

  test("STRICT_IDENTITY_HEADERS keeps boolish false semantics", () => {
    expect(
      expectConfigSuccess({ STRICT_IDENTITY_HEADERS: "false" })
        .strictIdentityHeaders,
    ).toBe(false);
    expect(
      expectConfigSuccess({ STRICT_IDENTITY_HEADERS: "unexpected" })
        .strictIdentityHeaders,
    ).toBe(false);
  });

  test("rejects an invalid MCP schema compatibility mode", () => {
    const { stderrOutput } = expectConfigFailure({
      MCP_SCHEMA_COMPATIBILITY_MODE: "enforce",
    });
    expect(stderrOutput.join("\n")).toContain("MCP_SCHEMA_COMPATIBILITY_MODE");
  });

  test("accepts the bounded six-hour execution timeout", () => {
    const config = expectConfigSuccess({
      EXECUTION_TIMEOUT_MS: "21600000",
    });
    expect(config.executionTimeoutMs).toBe(21_600_000);
  });

  test("succeeds with PORT=8080", () => {
    const config = expectConfigSuccess({ PORT: "8080" });
    expect(config.port).toBe(8080);
  });

  test("succeeds with FLOWS_DIR=/custom/flows", () => {
    const config = expectConfigSuccess({ FLOWS_DIR: "/custom/flows" });
    expect(config.flowsDir).toBe("/custom/flows");
  });

  test("succeeds with MONITORING_TRANSPORT=sse", () => {
    const config = expectConfigSuccess({ MONITORING_TRANSPORT: "sse" });
    expect(config.monitoringTransport).toBe("sse");
  });

  test("succeeds with MONITORING_TRANSPORT=websocket", () => {
    const config = expectConfigSuccess({ MONITORING_TRANSPORT: "websocket" });
    expect(config.monitoringTransport).toBe("websocket");
  });

  test("succeeds with MCP_SERVERS as empty JSON array", () => {
    const config = expectConfigSuccess({ MCP_SERVERS: "[]" });
    expect(config.mcpServers).toEqual([]);
  });

  test("succeeds with valid MCP_SERVERS JSON", () => {
    const servers = JSON.stringify([
      { name: "my-mcp", url: "http://localhost:4000", transport: "http" },
    ]);
    const config = expectConfigSuccess({ MCP_SERVERS: servers });
    expect(config.mcpServers).toHaveLength(1);
    const server0 = config.mcpServers[0];
    if (server0 === undefined) throw new Error("expected an mcp server entry");
    expect(server0.name).toBe("my-mcp");
  });

  test("accepts a per-server connectTimeoutMs within bounds", () => {
    const servers = JSON.stringify([
      {
        name: "slow-mcp",
        url: "http://localhost:4000",
        transport: "http",
        connectTimeoutMs: 15000,
      },
    ]);
    const config = expectConfigSuccess({ MCP_SERVERS: servers });
    expect(config.mcpServers[0]?.connectTimeoutMs).toBe(15000);
  });

  test("rejects a per-server connectTimeoutMs below 500 ms", () => {
    const servers = JSON.stringify([
      {
        name: "slow-mcp",
        url: "http://localhost:4000",
        transport: "http",
        connectTimeoutMs: 100,
      },
    ]);
    expectConfigFailure({ MCP_SERVERS: servers });
  });

  test("accepts allowAnonymous only with explicitly disabled authentication", () => {
    const servers = JSON.stringify([
      {
        name: "open-mcp",
        url: "http://localhost:4000",
        transport: "http",
        allowAnonymous: true,
      },
    ]);
    const config = expectConfigSuccess({
      AUTHN_MODE: "disabled",
      MCP_SERVERS: servers,
    });
    expect(config.mcpServers[0]?.allowAnonymous).toBe(true);
  });

  test("succeeds with valid DEFAULT_LLM JSON (openai)", () => {
    const llm = JSON.stringify({ provider: "openai", model: "gpt-4o" });
    const config = expectConfigSuccess({ DEFAULT_LLM: llm });
    expect(config.defaultLlm?.provider).toBe("openai");
    expect(config.defaultLlm?.model).toBe("gpt-4o");
  });

  test("succeeds with valid DEFAULT_LLM JSON (google)", () => {
    const llm = JSON.stringify({ provider: "google", model: "gemini-1.5-pro" });
    const config = expectConfigSuccess({ DEFAULT_LLM: llm });
    expect(config.defaultLlm?.provider).toBe("google");
  });

  test("succeeds with valid DEFAULT_LLM JSON (ollama)", () => {
    const llm = JSON.stringify({ provider: "ollama", model: "llama3" });
    const config = expectConfigSuccess({ DEFAULT_LLM: llm });
    expect(config.defaultLlm?.provider).toBe("ollama");
  });

  test("loads endpoints and credentials from PROVIDERS", () => {
    const config = expectConfigSuccess({
      PROVIDERS: JSON.stringify([
        {
          name: "gpuvllm",
          protocol: "openai",
          url: "http://vllm:8000/v1",
          apiKey: "sk-test",
        },
        {
          name: "localollama",
          protocol: "ollama",
          url: "http://localhost:11434",
        },
      ]),
    });
    expect(config.providers).toEqual([
      {
        name: "gpuvllm",
        protocol: "openai",
        url: "http://vllm:8000/v1",
        apiKey: "sk-test",
      },
      {
        name: "localollama",
        protocol: "ollama",
        url: "http://localhost:11434",
      },
    ]);
  });

  test("rejects a DEFAULT_LLM provider that names no configured instance", () => {
    // expectConfigFailure already asserts exit(1).
    const { stderrOutput } = expectConfigFailure({
      PROVIDERS: JSON.stringify([
        { name: "gpuvllm", protocol: "openai", url: "http://vllm:8000/v1" },
      ]),
      // A typo in the endpoint name must fail at startup, not at first call.
      DEFAULT_LLM: JSON.stringify({ provider: "gpuvllmm", model: "m" }),
    });
    expect(stderrOutput.join("")).toContain("Unknown LLM provider");
  });

  test("loads file-based MCP servers and lets environment entries override matching names", () => {
    const flowsDir = mkdtempSync(join(tmpdir(), "aiperator-mcp-"));
    try {
      writeFileSync(
        join(flowsDir, "mcp.yaml"),
        `servers:
  - name: file-only
    url: http://file-only.test
    transport: http
  - name: shared
    url: http://file-shared.test
    transport: http
`,
      );

      const config = expectConfigSuccess({
        FLOWS_DIR: flowsDir,
        MCP_SERVERS: JSON.stringify([
          { name: "shared", url: "http://env-shared.test", transport: "sse" },
          { name: "env-only", url: "http://env-only.test", transport: "http" },
        ]),
      });

      expect(config.mcpServers).toEqual([
        { name: "file-only", url: "http://file-only.test", transport: "http" },
        { name: "shared", url: "http://env-shared.test", transport: "sse" },
        { name: "env-only", url: "http://env-only.test", transport: "http" },
      ]);
    } finally {
      rmSync(flowsDir, { recursive: true, force: true });
    }
  });

  test("ignores malformed and schema-invalid file-based MCP configurations", () => {
    for (const content of ["servers: [", "servers:\n  - name: missing-url"]) {
      const flowsDir = mkdtempSync(join(tmpdir(), "aiperator-mcp-"));
      const originalStderr = process.stderr.write.bind(process.stderr);
      try {
        writeFileSync(join(flowsDir, "mcp.yaml"), content);
        process.stderr.write = () => true;

        expect(expectConfigSuccess({ FLOWS_DIR: flowsDir }).mcpServers).toEqual(
          [],
        );
      } finally {
        process.stderr.write = originalStderr;
        rmSync(flowsDir, { recursive: true, force: true });
      }
    }
  });

  test("applies the selected PROFILE and reports it in the config", () => {
    const config = expectConfigSuccess({ PROFILE: "dev" });
    expect(config.profile).toBe("dev");
    expect(config.appEnv).toBe("development");
  });

  test("unknown PROFILE causes exit(1) and explains the invalid profile", () => {
    const { stderrOutput } = expectConfigFailure({ PROFILE: "not-a-profile" });
    expect(stderrOutput.join(" ")).toContain("Unknown PROFILE");
  });

  test("BYOK_MODE=required implicitly enables BYOK bootstrap", () => {
    const config = expectConfigSuccess({
      BYOK_ENABLED: "false",
      BYOK_MODE: "required",
    });
    expect(config.byokMode).toBe("required");
    expect(config.byokEnabled).toBe(true);
  });

  test("succeeds with PORT boundary values 1 and 65535", () => {
    expect(expectConfigSuccess({ PORT: "1" }).port).toBe(1);
    expect(expectConfigSuccess({ PORT: "65535" }).port).toBe(65535);
  });

  test("RERANK_BATCH_SIZE maps to rerankBatchSize and stays undefined when unset", () => {
    delete process.env.RERANK_BATCH_SIZE;
    expect(expectConfigSuccess().rerankBatchSize).toBeUndefined();
    expect(
      expectConfigSuccess({ RERANK_BATCH_SIZE: "16" }).rerankBatchSize,
    ).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — invalid configurations
// ---------------------------------------------------------------------------

describe("loadConfig() — invalid configurations call process.exit(1)", () => {
  test("non-numeric PORT causes exit(1) and mentions PORT in stderr", () => {
    const { stderrOutput } = expectConfigFailure({ PORT: "not-a-number" });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("PORT");
  });

  test("PORT=0 (below min) causes exit(1) and mentions PORT in stderr", () => {
    const { stderrOutput } = expectConfigFailure({ PORT: "0" });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("PORT");
  });

  test("RERANK_BATCH_SIZE=0 causes exit(1) and mentions RERANK_BATCH_SIZE", () => {
    const { stderrOutput } = expectConfigFailure({ RERANK_BATCH_SIZE: "0" });
    expect(stderrOutput.join(" ")).toContain("RERANK_BATCH_SIZE");
  });
  test("PORT=65536 (above max) causes exit(1) and mentions PORT in stderr", () => {
    const { stderrOutput } = expectConfigFailure({ PORT: "65536" });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("PORT");
  });

  test("execution timeout above six hours causes exit(1)", () => {
    const { stderrOutput } = expectConfigFailure({
      EXECUTION_TIMEOUT_MS: "21600001",
    });
    expect(stderrOutput.join(" ")).toContain("EXECUTION_TIMEOUT_MS");
  });

  test("invalid MONITORING_TRANSPORT causes exit(1) and mentions MONITORING_TRANSPORT in stderr", () => {
    const { stderrOutput } = expectConfigFailure({
      MONITORING_TRANSPORT: "grpc",
    });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("MONITORING_TRANSPORT");
  });

  test("MONITORING_TRANSPORT=polling (invalid) causes exit(1)", () => {
    const { stderrOutput } = expectConfigFailure({
      MONITORING_TRANSPORT: "polling",
    });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("MONITORING_TRANSPORT");
  });

  test("malformed MCP_SERVERS JSON causes exit(1) and mentions MCP_SERVERS in stderr", () => {
    const { stderrOutput } = expectConfigFailure({ MCP_SERVERS: "not-json" });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("MCP_SERVERS");
  });

  test("MCP_SERVERS with invalid object inside JSON array causes exit(1)", () => {
    // Missing required 'name' field
    const invalid = JSON.stringify([
      { url: "http://localhost:4000", transport: "http" },
    ]);
    const { stderrOutput } = expectConfigFailure({ MCP_SERVERS: invalid });
    const combined = stderrOutput.join(" ");
    expect(combined.length).toBeGreaterThan(0);
  });

  test("MCP_SERVERS with invalid transport type causes exit(1)", () => {
    const invalid = JSON.stringify([
      { name: "s", url: "http://x", transport: "ws" }, // 'ws' not in enum
    ]);
    const { stderrOutput } = expectConfigFailure({ MCP_SERVERS: invalid });
    const combined = stderrOutput.join(" ");
    expect(combined.length).toBeGreaterThan(0);
  });

  test("rejects allowAnonymous unless AUTHN_MODE is explicitly disabled", () => {
    const server = JSON.stringify([
      {
        name: "open-mcp",
        url: "http://localhost:4000",
        transport: "http",
        allowAnonymous: true,
      },
    ]);

    for (const authnMode of [undefined, "token", "oidc", "token_or_oidc"] as const) {
      if (authnMode === undefined) delete process.env.AUTHN_MODE;
      const { stderrOutput } = expectConfigFailure({
        ...(authnMode === undefined ? {} : { AUTHN_MODE: authnMode }),
        MCP_SERVERS: server,
      });
      expect(stderrOutput.join(" ")).toContain("requires AUTHN_MODE=disabled");
    }
  });

  test("rejects allowAnonymous combined with forwardAuthToken", () => {
    const { stderrOutput } = expectConfigFailure({
      AUTHN_MODE: "disabled",
      MCP_SERVERS: JSON.stringify([
        {
          name: "invalid-mcp",
          url: "http://localhost:4000",
          transport: "http",
          allowAnonymous: true,
          forwardAuthToken: true,
        },
      ]),
    });
    expect(stderrOutput.join(" ")).toContain(
      "cannot combine allowAnonymous=true with forwardAuthToken=true",
    );
  });

  test("malformed DEFAULT_LLM JSON causes exit(1) and mentions DEFAULT_LLM in stderr", () => {
    const { stderrOutput } = expectConfigFailure({
      DEFAULT_LLM: "{invalid-json}",
    });
    const combined = stderrOutput.join(" ");
    expect(combined).toContain("DEFAULT_LLM");
  });

  test("DEFAULT_LLM with invalid provider causes exit(1)", () => {
    const invalid = JSON.stringify({ provider: "cohere", model: "command-r" });
    const { stderrOutput } = expectConfigFailure({ DEFAULT_LLM: invalid });
    // Should fail — 'anthropic' is not in the allowed enum
    const combined = stderrOutput.join(" ");
    expect(combined.length).toBeGreaterThan(0);
  });

  test("DEFAULT_LLM missing model field causes exit(1)", () => {
    const invalid = JSON.stringify({ provider: "openai" });
    expectConfigFailure({ DEFAULT_LLM: invalid });
  });

  test("DEFAULT_LLM with empty model string causes exit(1)", () => {
    const invalid = JSON.stringify({ provider: "openai", model: "" });
    expectConfigFailure({ DEFAULT_LLM: invalid });
  });
});

// ---------------------------------------------------------------------------
// Property 24 — PBT: invalid env var combinations always cause exit(1)
// Feature: ai-agent-orchestration-platform, Property 24: Configuration validation for missing required fields
// Validates: Requirements 10.5, 11.5
// ---------------------------------------------------------------------------

describe("Property 24: Config validation — invalid values always cause exit(1) with stderr output", () => {
  /**
   * Arbitrary: generates a string that Zod's numeric coercion does NOT accept
   * as an integer in [1, 65535]. Either non-numeric, fractional, or
   * out-of-range.
   */
  const invalidPort = fc.oneof(
    // Strings outside the schema's Number(...) coercion contract
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => {
      const port = Number(s);
      return !Number.isInteger(port) || port < 1 || port > 65535;
    }),
    // Explicit out-of-range numbers improve boundary-case frequency
    fc.oneof(
      fc.constant("0"),
      fc.integer({ min: 65536, max: 99999 }).map(String),
    ),
  );

  /**
   * Arbitrary: generates a string that is NOT in the set ["sse", "websocket"].
   */
  const invalidMonitoringTransport = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => s !== "sse" && s !== "websocket" && s.trim() !== "");

  /**
   * Arbitrary: generates strings that are not valid JSON arrays.
   */
  const invalidJsonString = fc.oneof(
    // Plain text (not JSON, and not whitespace-only which would trim to "")
    fc.string({ minLength: 1, maxLength: 20 }).filter(
      (s) =>
        s.trim() !== "" &&
        (() => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        })(),
    ),
    // Valid JSON but not an array (for MCP_SERVERS)
    fc.constant("{}"),
    fc.constant('"a string"'),
    fc.constant("42"),
    fc.constant("true"),
  );

  /**
   * Arbitrary: generates JSON strings for DEFAULT_LLM with an invalid provider.
   */
  const invalidDefaultLlmProvider = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        ![
          "openai",
          "google",
          "ollama",
          "azure",
          "bedrock",
          "anthropic",
        ].includes(s),
    )
    .map((provider) => JSON.stringify({ provider, model: "some-model" }));

  test("invalid PORT always causes exit(1) and stderr output", () => {
    fc.assert(
      fc.property(invalidPort, (port) => {
        process.env.PORT = port;

        const stderrOutput: string[] = [];
        let exitCode: number | undefined;

        const origExit = process.exit.bind(process);
        const origStderr = process.stderr.write.bind(process.stderr);

        (process as NodeJS.Process).exit = ((code?: number) => {
          exitCode = code;
          throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;

        process.stderr.write = (chunk: unknown) => {
          stderrOutput.push(String(chunk));
          return true;
        };

        let threw = false;
        try {
          loadConfig();
        } catch (err) {
          if ((err as Error).message.startsWith("process.exit(")) {
            threw = true;
          } else {
            (process as NodeJS.Process).exit = origExit;
            process.stderr.write = origStderr;
            throw err;
          }
        } finally {
          (process as NodeJS.Process).exit = origExit;
          process.stderr.write = origStderr;
          delete process.env.PORT;
        }

        if (!threw) {
          throw new Error(
            `Expected process.exit(1) for PORT="${port}" but loadConfig() returned successfully`,
          );
        }

        expect(exitCode).toBe(1);
        expect(stderrOutput.join(" ")).toContain("PORT");
      }),
      { numRuns: 100 },
    );
  });

  test("invalid MONITORING_TRANSPORT always causes exit(1) and mentions MONITORING_TRANSPORT in stderr", () => {
    fc.assert(
      fc.property(invalidMonitoringTransport, (transport) => {
        process.env.MONITORING_TRANSPORT = transport;

        const stderrOutput: string[] = [];
        let exitCode: number | undefined;

        const origExit = process.exit.bind(process);
        const origStderr = process.stderr.write.bind(process.stderr);

        (process as NodeJS.Process).exit = ((code?: number) => {
          exitCode = code;
          throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;

        process.stderr.write = (chunk: unknown) => {
          stderrOutput.push(String(chunk));
          return true;
        };

        let threw = false;
        try {
          loadConfig();
        } catch (err) {
          if ((err as Error).message.startsWith("process.exit(")) {
            threw = true;
          } else {
            (process as NodeJS.Process).exit = origExit;
            process.stderr.write = origStderr;
            throw err;
          }
        } finally {
          (process as NodeJS.Process).exit = origExit;
          process.stderr.write = origStderr;
          delete process.env.MONITORING_TRANSPORT;
        }

        if (!threw) {
          throw new Error(
            `Expected process.exit(1) for MONITORING_TRANSPORT="${transport}" but loadConfig() returned successfully`,
          );
        }

        expect(exitCode).toBe(1);
        expect(stderrOutput.join(" ")).toContain("MONITORING_TRANSPORT");
      }),
      { numRuns: 100 },
    );
  });

  test("malformed MCP_SERVERS JSON always causes exit(1) and mentions MCP_SERVERS in stderr", () => {
    fc.assert(
      fc.property(invalidJsonString, (mcpServers) => {
        process.env.MCP_SERVERS = mcpServers;

        const stderrOutput: string[] = [];
        let exitCode: number | undefined;

        const origExit = process.exit.bind(process);
        const origStderr = process.stderr.write.bind(process.stderr);

        (process as NodeJS.Process).exit = ((code?: number) => {
          exitCode = code;
          throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;

        process.stderr.write = (chunk: unknown) => {
          stderrOutput.push(String(chunk));
          return true;
        };

        let threw = false;
        try {
          loadConfig();
        } catch (err) {
          if ((err as Error).message.startsWith("process.exit(")) {
            threw = true;
          } else {
            (process as NodeJS.Process).exit = origExit;
            process.stderr.write = origStderr;
            throw err;
          }
        } finally {
          (process as NodeJS.Process).exit = origExit;
          process.stderr.write = origStderr;
          delete process.env.MCP_SERVERS;
        }

        if (!threw) {
          throw new Error(
            `Expected process.exit(1) for MCP_SERVERS="${mcpServers}" but loadConfig() returned successfully`,
          );
        }

        expect(exitCode).toBe(1);
        expect(stderrOutput.join(" ")).toContain("MCP_SERVERS");
      }),
      { numRuns: 100 },
    );
  });

  test("invalid DEFAULT_LLM provider always causes exit(1)", () => {
    fc.assert(
      fc.property(invalidDefaultLlmProvider, (defaultLlm) => {
        process.env.DEFAULT_LLM = defaultLlm;

        const stderrOutput: string[] = [];
        let exitCode: number | undefined;

        const origExit = process.exit.bind(process);
        const origStderr = process.stderr.write.bind(process.stderr);

        (process as NodeJS.Process).exit = ((code?: number) => {
          exitCode = code;
          throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;

        process.stderr.write = (chunk: unknown) => {
          stderrOutput.push(String(chunk));
          return true;
        };

        let threw = false;
        try {
          loadConfig();
        } catch (err) {
          if ((err as Error).message.startsWith("process.exit(")) {
            threw = true;
          } else {
            (process as NodeJS.Process).exit = origExit;
            process.stderr.write = origStderr;
            throw err;
          }
        } finally {
          (process as NodeJS.Process).exit = origExit;
          process.stderr.write = origStderr;
          delete process.env.DEFAULT_LLM;
        }

        if (!threw) {
          throw new Error(
            `Expected process.exit(1) for DEFAULT_LLM="${defaultLlm}" but loadConfig() returned successfully`,
          );
        }

        expect(exitCode).toBe(1);
        expect(stderrOutput.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  test("any combination of invalid values causes exit(1) with stderr output", () => {
    // Arbitrary: pick one invalid field from any of the configurable vars
    const invalidEnvEntry = fc.oneof(
      invalidPort.map((v) => ({ PORT: v })),
      invalidMonitoringTransport.map((v) => ({ MONITORING_TRANSPORT: v })),
      invalidJsonString.map((v) => ({ MCP_SERVERS: v })),
      invalidDefaultLlmProvider.map((v) => ({ DEFAULT_LLM: v })),
    );

    fc.assert(
      fc.property(invalidEnvEntry, (envEntry) => {
        const keys = Object.keys(envEntry) as (keyof typeof envEntry)[];
        for (const key of keys) {
          process.env[key] = envEntry[key as keyof typeof envEntry];
        }

        const stderrOutput: string[] = [];
        let exitCode: number | undefined;

        const origExit = process.exit.bind(process);
        const origStderr = process.stderr.write.bind(process.stderr);

        (process as NodeJS.Process).exit = ((code?: number) => {
          exitCode = code;
          throw new Error(`process.exit(${code})`);
        }) as typeof process.exit;

        process.stderr.write = (chunk: unknown) => {
          stderrOutput.push(String(chunk));
          return true;
        };

        let threw = false;
        try {
          loadConfig();
        } catch (err) {
          if ((err as Error).message.startsWith("process.exit(")) {
            threw = true;
          } else {
            (process as NodeJS.Process).exit = origExit;
            process.stderr.write = origStderr;
            throw err;
          }
        } finally {
          (process as NodeJS.Process).exit = origExit;
          process.stderr.write = origStderr;
          for (const key of keys) {
            delete process.env[key];
          }
        }

        if (!threw) {
          throw new Error(
            `Expected process.exit(1) but loadConfig() returned successfully for env: ${JSON.stringify(envEntry)}`,
          );
        }

        expect(exitCode).toBe(1);
        expect(stderrOutput.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Token exchange (RFC 8693) loader wiring
// ---------------------------------------------------------------------------

describe("loadConfig() — token exchange", () => {
  const server = (extra: Record<string, unknown>) =>
    JSON.stringify([
      {
        name: "vectorsearch",
        url: "http://localhost:9/mcp",
        transport: "http",
        ...extra,
      },
    ]);

  const tokenExchange = {
    tokenEndpoint: "https://idp.example/application/o/token/",
    clientId: "atf-runtime",
    clientSecretEnv: "MCP_TX_SECRET",
    audience: "vectorsearch",
  };

  test("resolves clientSecretEnv to the concrete secret", () => {
    const config = expectConfigSuccess({
      MCP_TX_SECRET: "the-secret",
      MCP_SERVERS: server({ forwardAuthToken: true, tokenExchange }),
    });
    const srv = config.mcpServers.find((s) => s.name === "vectorsearch");
    expect(srv?.tokenExchange?.clientSecret).toBe("the-secret");
  });

  test("fails when tokenExchange is set without forwardAuthToken", () => {
    const { stderrOutput } = expectConfigFailure({
      MCP_TX_SECRET: "the-secret",
      MCP_SERVERS: server({ tokenExchange }),
    });
    expect(stderrOutput.join("")).toContain("forwardAuthToken");
  });

  test("fails when the secret env var is unset", () => {
    const { stderrOutput } = expectConfigFailure({
      MCP_SERVERS: server({ forwardAuthToken: true, tokenExchange }),
    });
    expect(stderrOutput.join("")).toContain("MCP_TX_SECRET");
  });

  test("fails when tokenExchange is combined with allowAnonymous", () => {
    process.env.AUTHN_MODE = "disabled";
    const { stderrOutput } = expectConfigFailure({
      MCP_TX_SECRET: "the-secret",
      MCP_SERVERS: server({ forwardAuthToken: true, allowAnonymous: true, tokenExchange }),
    });
    // Either the anonymous/forwardAuth conflict or the anonymous/exchange
    // conflict fires first; both are correct rejections.
    expect(stderrOutput.length).toBeGreaterThan(0);
  });

  test("resolves the actor client secret for a delegation config", () => {
    const config = expectConfigSuccess({
      MCP_TX_SECRET: "the-secret",
      MCP_TX_ACTOR_SECRET: "actor-secret",
      MCP_SERVERS: server({
        forwardAuthToken: true,
        tokenExchange: {
          ...tokenExchange,
          actor: {
            grant: "client_credentials",
            clientId: "atf-actor",
            clientSecretEnv: "MCP_TX_ACTOR_SECRET",
          },
        },
      }),
    });
    const srv = config.mcpServers.find((s) => s.name === "vectorsearch");
    expect(srv?.tokenExchange?.actor?.clientSecret).toBe("actor-secret");
  });

  test("rejects a tokenExchange with neither tokenEndpoint nor issuer", () => {
    const { stderrOutput } = expectConfigFailure({
      MCP_TX_SECRET: "the-secret",
      MCP_SERVERS: server({
        forwardAuthToken: true,
        tokenExchange: { clientId: "c", clientSecretEnv: "MCP_TX_SECRET", audience: "a" },
      }),
    });
    expect(stderrOutput.join("")).toContain("MCP_SERVERS");
  });
});
