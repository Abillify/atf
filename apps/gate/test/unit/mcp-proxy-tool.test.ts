// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, spyOn, test } from "bun:test";
import { TokenExchanger, type FetchLike } from "@atf/security-kit";
import type { AuthContext } from "../../src/auth/context.ts";
import type { McpProxyTool } from "../../src/config/schema.ts";
import { McpProxyToolSchema } from "../../src/config/schema.ts";
import { logger } from "../../src/logger.ts";
import {
  hardPayloadLimitError,
  measureMcpPayloadBytes,
  McpProxyToolExecutor,
} from "../../src/tools/mcp-proxy-tool.ts";
import type { ToolRuntime } from "../../src/tools/types.ts";

const baseTool = {
  name: "downstream",
  type: "mcp" as const,
  server: { url: "https://mcp.example.com" },
  targetTool: "search",
};

describe("complete MCP payload measurement", () => {
  test("measures JSON.stringify output as UTF-8 bytes", () => {
    const result = { content: [{ type: "text", text: "Grüße 👋" }] };
    expect(measureMcpPayloadBytes(result)).toBe(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    );
    expect(measureMcpPayloadBytes(result)).toBeGreaterThan(JSON.stringify(result).length);
  });

  test("includes structured-only and non-text content", () => {
    const small = { structuredContent: { rows: [1] } };
    const large = {
      structuredContent: { rows: [1], detail: "x".repeat(100) },
      content: [{ type: "image", data: "y".repeat(100), mimeType: "image/png" }],
    };
    expect(measureMcpPayloadBytes(large)).toBeGreaterThan(measureMcpPayloadBytes(small));
  });

  test("allows the exact boundary and rejects one byte above it", () => {
    const result = { structuredContent: { tenant: "ä" } };
    const bytes = measureMcpPayloadBytes(result);
    const meta = { server: "https://mcp.example.com", targetTool: "search" };

    expect(hardPayloadLimitError(result, bytes, meta)).toBeUndefined();
    const error = hardPayloadLimitError(result, bytes - 1, meta);
    expect(error).toMatchObject({
      isError: true,
      meta: { source: "mcp", bytes },
    });
    expect(JSON.stringify(error)).not.toContain("tenant");
  });

  test("returns a controlled payload-free error for circular and BigInt results", () => {
    const circular: { self?: unknown; secret: string } = { secret: "do-not-leak" };
    circular.self = circular;
    const meta = { server: "https://mcp.example.com", targetTool: "search" };

    for (const result of [circular, { secret: "do-not-leak", value: 1n }]) {
      const error = hardPayloadLimitError(result, 1024, meta);
      expect(error).toMatchObject({
        isError: true,
        meta: { source: "mcp", payloadMeasurementFailed: true },
      });
      expect(JSON.stringify(error)).not.toContain("do-not-leak");
    }
  });

  test("limit 0 does not serialize circular or BigInt results", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const meta = { server: "https://mcp.example.com", targetTool: "search" };
    expect(hardPayloadLimitError(circular, 0, meta)).toBeUndefined();
    expect(hardPayloadLimitError({ value: 1n }, 0, meta)).toBeUndefined();
  });

  test("limit 0 disables the hard payload guard", () => {
    expect(
      hardPayloadLimitError(
        { structuredContent: { huge: "x".repeat(10_000) } },
        0,
        { server: "https://mcp.example.com", targetTool: "search" },
      ),
    ).toBeUndefined();
  });
});

describe("MCP proxy payload limit schema", () => {
  test("defaults hardPayloadLimitBytes to disabled without changing the text limit", () => {
    const parsed = McpProxyToolSchema.parse(baseTool);
    expect(parsed.hardPayloadLimitBytes).toBe(0);
    expect(parsed.maxResponseBytes).toBe(10 * 1024 * 1024);
  });

  test("coerces a configured nonnegative hard limit", () => {
    expect(
      McpProxyToolSchema.parse({ ...baseTool, hardPayloadLimitBytes: "2048" })
        .hardPayloadLimitBytes,
    ).toBe(2048);
    expect(() =>
      McpProxyToolSchema.parse({ ...baseTool, hardPayloadLimitBytes: -1 }),
    ).toThrow();
  });

  test("keeps maxResponseBytes positive", () => {
    expect(() => McpProxyToolSchema.parse({ ...baseTool, maxResponseBytes: 0 })).toThrow();
  });
});

// ── Req 6.13: RFC 8693 token exchange / deprecated forwardBearerToken ──────

const exchangeConfig = {
  tokenEndpoint: "https://idp.example.com/application/o/token/",
  clientId: "atf-gate",
  clientSecret: "s3cr3t",
  clientSecretEnv: "MCP_DS_SECRET",
  audience: "downstream-mcp",
};

/** Fetch stub returning one scripted JSON response and recording the bodies. */
function stubTokenFetch(
  response: { ok: boolean; status: number; json?: unknown },
  bodies: URLSearchParams[],
): FetchLike {
  return async (_url, init) => {
    bodies.push(new URLSearchParams(init?.body as string));
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json ?? {},
      text: async () => JSON.stringify(response.json ?? {}),
    };
  };
}

function authContext(rawToken: string): AuthContext {
  return {
    method: "oauth",
    subject: "user-1",
    username: "user-1",
    scopes: [],
    claims: {},
    tenantId: "default",
    headers: {},
    rawToken,
  };
}

/** Runtime whose allow-list refuses everything — keeps tests off the network. */
const blockedRuntime = {
  db: {},
  bus: {},
  outboundAllowedHosts: ["elsewhere.example"],
} as unknown as ToolRuntime;

function executorFor(
  server: Record<string, unknown>,
  exchanger?: TokenExchanger,
  runtime: ToolRuntime = blockedRuntime,
): McpProxyToolExecutor {
  const cfg = McpProxyToolSchema.parse({
    ...baseTool,
    server: { url: "https://mcp.example.com", ...server },
  }) as McpProxyTool;
  return new McpProxyToolExecutor(cfg, runtime, exchanger);
}

describe("MCP proxy token exchange schema (Req 6.13)", () => {
  test("parses a server tokenExchange block", () => {
    const parsed = McpProxyToolSchema.parse({
      ...baseTool,
      server: {
        url: "https://mcp.example.com",
        tokenExchange: {
          tokenEndpoint: "https://idp.example.com/token",
          clientId: "atf-gate",
          clientSecretEnv: "MCP_DOWNSTREAM_SECRET",
          audience: "downstream-mcp",
        },
      },
    });
    expect(parsed.server.tokenExchange?.audience).toBe("downstream-mcp");
    expect(parsed.server.tokenExchange?.clientSecret).toBeUndefined();
  });

  test("requires tokenEndpoint or issuer", () => {
    expect(() =>
      McpProxyToolSchema.parse({
        ...baseTool,
        server: {
          url: "https://mcp.example.com",
          tokenExchange: {
            clientId: "atf-gate",
            clientSecretEnv: "S",
            audience: "a",
          },
        },
      }),
    ).toThrow(/tokenEndpoint or issuer/);
  });
});

describe("MCP proxy executor token selection (Req 6.13)", () => {
  test("a failed exchange fails the call closed — no fallback token", async () => {
    const bodies: URLSearchParams[] = [];
    const exchanger = new TokenExchanger(exchangeConfig, {
      fetchImpl: stubTokenFetch(
        { ok: false, status: 400, json: { error: "invalid_grant" } },
        bodies,
      ),
    });
    const executor = executorFor({ tokenExchange: exchangeConfig }, exchanger);

    const result = await executor.execute({}, authContext("caller-login-token"));

    expect(result.isError).toBe(true);
    expect(result.meta).toMatchObject({ tokenExchangeFailed: true, transient: false });
    expect(result.content[0]?.text).toContain("token exchange failed");
    // The subject token went to the IdP and the call ended there — the
    // downstream URL was never contacted (the allow-list would have blocked it).
    expect(bodies[0]?.get("subject_token")).toBe("caller-login-token");
  });

  test("a successful exchange proceeds past token selection", async () => {
    const bodies: URLSearchParams[] = [];
    const exchanger = new TokenExchanger(exchangeConfig, {
      fetchImpl: stubTokenFetch(
        { ok: true, status: 200, json: { access_token: "minted", expires_in: 300 } },
        bodies,
      ),
    });
    const executor = executorFor({ tokenExchange: exchangeConfig }, exchanger);

    const result = await executor.execute({}, authContext("caller-login-token"));

    // The allow-list blocks the downstream call afterwards, proving the flow
    // continued with the exchanged token instead of failing closed.
    expect(result.meta).toMatchObject({ blocked: true });
    expect(result.meta?.tokenExchangeFailed).toBeUndefined();
  });

  test("tokenExchange without a resolved secret refuses the call", async () => {
    // AppConfig built directly (loader never ran): clientSecret stays unset,
    // so no exchanger exists. Falling through to forward/static token would
    // reintroduce the audience problem — the call must be refused instead.
    const executor = executorFor({
      tokenExchange: {
        tokenEndpoint: exchangeConfig.tokenEndpoint,
        clientId: exchangeConfig.clientId,
        clientSecretEnv: exchangeConfig.clientSecretEnv,
        audience: exchangeConfig.audience,
      },
    });

    const result = await executor.execute({}, authContext("caller-login-token"));

    expect(result.isError).toBe(true);
    expect(result.meta).toMatchObject({ tokenExchangeFailed: true });
    expect(result.content[0]?.text).toContain("client secret was never resolved");
  });

  test("deprecated forwardBearerToken warns once and forwards the raw token", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const executor = executorFor({ forwardBearerToken: true });
      const first = await executor.execute({}, authContext("caller-login-token"));
      const second = await executor.execute({}, authContext("caller-login-token"));

      // Blocked by the allow-list after token selection — the point is the
      // deprecation warning, logged exactly once per executor.
      expect(first.meta).toMatchObject({ blocked: true });
      expect(second.meta).toMatchObject({ blocked: true });
      const deprecations = warn.mock.calls.filter(([msg]) =>
        String(msg).includes("deprecated forwardBearerToken"),
      );
      expect(deprecations).toHaveLength(1);
      expect(deprecations[0]?.[1]).toMatchObject({ tool: "downstream" });
    } finally {
      warn.mockRestore();
    }
  });
});
