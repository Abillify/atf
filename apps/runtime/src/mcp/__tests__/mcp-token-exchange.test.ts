// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP wrapper × token exchange wiring.
 *
 * Confirms that for a `tokenExchange` server the wrapper forwards the EXCHANGED
 * token (bound to the server's audience) as the `Authorization` bearer, while
 * the per-caller session pool stays keyed on the caller's SUBJECT token; that a
 * session is rebuilt with a fresh exchanged token once its bearer lapses or is
 * rejected with 401; and that a failed exchange fails the call closed rather
 * than forwarding the raw token.
 */

import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpWrapper } from "../wrapper/client.js";
import type { McpServerConfig } from "../../config/index.js";
import type { RequestContext } from "../../types/monitoring.js";
import { TokenExchanger, type FetchLike } from "../../auth/token-exchange.js";

const created: FakeClient[] = [];

class FakeClient {
  lastTransport: unknown = null;
  constructor(_info: unknown) {
    created.push(this);
  }
  async connect(transport: unknown): Promise<void> {
    this.lastTransport = transport;
  }
  getInstructions(): string | undefined {
    return undefined;
  }
  async listTools(): Promise<{ tools: Array<{ name: string; inputSchema: object }> }> {
    return { tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }] };
  }
  authorization(): string | undefined {
    const init = (
      this.lastTransport as { _requestInit?: { headers?: Record<string, string> } } | null
    )?._requestInit;
    return init?.headers?.Authorization;
  }
  async callTool(): Promise<{ content: unknown; isError?: boolean }> {
    return { content: [{ type: "text", text: "ok" }], isError: false };
  }
  async close(): Promise<void> {}
}

const clientFactory = (info: { name: string; version: string }): Client =>
  new FakeClient(info) as unknown as Client;

function exchangerFor(response: () => { access_token: string; expires_in: number }): (
  config: McpServerConfig,
) => TokenExchanger | undefined {
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => response(),
    text: async () => "",
  });
  return (config) => {
    if (config.tokenExchange === undefined) return undefined;
    return new TokenExchanger(
      {
        tokenEndpoint: "https://idp.example/token",
        clientId: "atf-runtime",
        clientSecret: "s",
        audience: config.tokenExchange.audience,
      },
      { fetchImpl: fetch },
    );
  };
}

function mkCtx(over: Partial<RequestContext> = {}): RequestContext {
  return { ssoToken: "user-subject-token", executionId: "e-1", ...over } as RequestContext;
}

const exchangeConfig: McpServerConfig = {
  name: "vectorsearch",
  url: "http://localhost:9/mcp",
  transport: "http",
  forwardAuthToken: true,
  tokenExchange: {
    tokenEndpoint: "https://idp.example/token",
    clientId: "atf-runtime",
    clientSecretEnv: "IGNORED",
    audience: "vectorsearch",
    clientSecret: "resolved",
  },
} as McpServerConfig;

beforeEach(() => {
  created.length = 0;
});

describe("MCP wrapper — token exchange", () => {
  test("forwards the exchanged token as bearer, not the subject token", async () => {
    let n = 0;
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => {
        n += 1;
        return { access_token: `exchanged-${n}`, expires_in: 300 };
      }),
    });
    await wrapper.connect(exchangeConfig);

    await wrapper.callTool("vectorsearch", "t", { query: "hi" }, mkCtx());

    // Exactly one per-caller session was created, and its bearer is the
    // exchanged token — never the caller's raw subject token.
    const withAuth = created.filter((c) => c.authorization() !== undefined);
    expect(withAuth).toHaveLength(1);
    expect(withAuth[0]?.authorization()).toBe("Bearer exchanged-1");
    expect(withAuth[0]?.authorization()).not.toContain("user-subject-token");
  });

  test("reuses one session for repeated calls by the same caller", async () => {
    let n = 0;
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => {
        n += 1;
        return { access_token: `exchanged-${n}`, expires_in: 300 };
      }),
    });
    await wrapper.connect(exchangeConfig);

    await wrapper.callTool("vectorsearch", "t", {}, mkCtx());
    const afterFirst = created.length;
    await wrapper.callTool("vectorsearch", "t", {}, mkCtx());

    // No new session for the second call by the same subject.
    expect(created.length).toBe(afterFirst);
  });

  test("rebuilds the session when its exchanged bearer has lapsed", async () => {
    let n = 0;
    let clock = 1_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const wrapper = createMcpWrapper({
        clientFactory,
        tokenExchangerFactory: exchangerFor(() => {
          n += 1;
          return { access_token: `exchanged-${n}`, expires_in: 300 };
        }),
      });
      await wrapper.connect(exchangeConfig);

      await wrapper.callTool("vectorsearch", "t", {}, mkCtx());
      // Inside the lifetime: the session and its bearer are reused.
      clock += 200_000;
      await wrapper.callTool("vectorsearch", "t", {}, mkCtx());
      // Past expiry minus the 60 s margin, while the caller's subject token is
      // unchanged: the session is rebuilt with a freshly exchanged token.
      clock += 50_000;
      await wrapper.callTool("vectorsearch", "t", {}, mkCtx());
      await wrapper.callTool("vectorsearch", "t", {}, mkCtx());

      const bearers = created.map((c) => c.authorization()).filter((a) => a !== undefined);
      expect(bearers).toEqual(["Bearer exchanged-1", "Bearer exchanged-2"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("re-exchanges and rebuilds the session after the server rejects the bearer", async () => {
    let n = 0;
    const rejectedBearer = "Bearer exchanged-1";
    const originalCallTool = FakeClient.prototype.callTool;
    FakeClient.prototype.callTool = async function (this: FakeClient) {
      if (this.authorization() === rejectedBearer) {
        throw new StreamableHTTPError(401, "Error POSTing to endpoint: unauthorized");
      }
      return { content: [{ type: "text", text: "ok" }], isError: false };
    };
    try {
      const wrapper = createMcpWrapper({
        clientFactory,
        tokenExchangerFactory: exchangerFor(() => {
          n += 1;
          return { access_token: `exchanged-${n}`, expires_in: 300 };
        }),
      });
      await wrapper.connect(exchangeConfig);

      // The rejected call fails (a 401 is not silently retried with another
      // credential), but the session is rebuilt so the caller recovers.
      await expect(wrapper.callTool("vectorsearch", "t", {}, mkCtx())).rejects.toThrow();
      await wrapper.callTool("vectorsearch", "t", {}, mkCtx());

      const bearers = created.map((c) => c.authorization()).filter((a) => a !== undefined);
      // exchanged-1 was still inside its lifetime; only the invalidation on
      // 401 makes the rebuild mint exchanged-2 instead of reusing it.
      expect(bearers).toEqual([rejectedBearer, "Bearer exchanged-2"]);
    } finally {
      FakeClient.prototype.callTool = originalCallTool;
    }
  });

  test("fails the call closed when the exchange fails", async () => {
    const failingFetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_target" }),
      text: async () => "",
    });
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: (config) =>
        config.tokenExchange === undefined
          ? undefined
          : new TokenExchanger(
              {
                tokenEndpoint: "https://idp.example/token",
                clientId: "c",
                clientSecret: "s",
                audience: config.tokenExchange.audience,
              },
              { fetchImpl: failingFetch },
            ),
    });
    await wrapper.connect(exchangeConfig);

    await expect(
      wrapper.callTool("vectorsearch", "t", {}, mkCtx()),
    ).rejects.toThrow(/[Tt]oken exchange/);
  });
});
