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
        audience: config.tokenExchange.audience ?? "unset",
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
                audience: config.tokenExchange.audience ?? "unset",
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

describe("MCP wrapper — target subject for transaction envelopes", () => {
  const b64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwtWithSub = (sub: string): string =>
    `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub, aud: "vectorsearch" })}.sig`;

  test("returns the exchanged token's subject, not the caller's", async () => {
    let n = 0;
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => {
        n += 1;
        // The target provider uses e-mail subjects; the caller token had a
        // numeric user id. The envelope must follow the target.
        return { access_token: jwtWithSub("user@example.com"), expires_in: 300 };
      }),
    });
    await wrapper.connect(exchangeConfig);

    expect(await wrapper.targetSubject?.("vectorsearch", "user-subject-token")).toBe(
      "user@example.com",
    );
    // The subsequent call reuses the cached exchange (no second IdP round trip).
    await wrapper.callTool("vectorsearch", "t", {}, mkCtx());
    expect(n).toBe(1);
  });

  test("returns undefined for servers that receive the caller token unchanged", async () => {
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => ({ access_token: jwtWithSub("x"), expires_in: 300 })),
    });
    const { tokenExchange: _omit, ...plain } = exchangeConfig;
    await wrapper.connect({ ...plain, name: "plain" } as McpServerConfig);

    expect(await wrapper.targetSubject?.("plain", "user-subject-token")).toBeUndefined();
  });

  test("returns undefined when the exchanged token is not a JWT", async () => {
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => ({ access_token: "opaque", expires_in: 300 })),
    });
    await wrapper.connect(exchangeConfig);

    expect(await wrapper.targetSubject?.("vectorsearch", "user-subject-token")).toBeUndefined();
  });
});

describe("MCP wrapper — tokenExchange.subjectIssuers filter", () => {
  const b64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwtWithClaims = (claims: Record<string, unknown>): string =>
    `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;

  const filteredConfig: McpServerConfig = {
    ...exchangeConfig,
    tokenExchange: {
      ...exchangeConfig.tokenExchange,
      subjectIssuers: ["https://idp.example.com/application/o/app/"],
    },
  } as McpServerConfig;

  test("exchanges tokens whose iss matches subjectIssuers (ignoring trailing slash)", async () => {
    let exchanges = 0;
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => {
        exchanges += 1;
        return { access_token: jwtWithClaims({ sub: "exchanged-sub" }), expires_in: 300 };
      }),
    });
    await wrapper.connect(filteredConfig);

    const authentikToken = jwtWithClaims({
      iss: "https://idp.example.com/application/o/app",
      sub: "authentik-user",
    });
    expect(await wrapper.targetSubject?.("vectorsearch", authentikToken)).toBe("exchanged-sub");
    await wrapper.callTool("vectorsearch", "t", {}, mkCtx({ ssoToken: authentikToken }));

    expect(exchanges).toBe(1);
    const withAuth = created.filter((c) => c.authorization() !== undefined);
    expect(withAuth).toHaveLength(1);
    expect(withAuth[0]?.authorization()).not.toContain(authentikToken);
  });

  test("passes through tokens from non-matching trusted issuers without exchange", async () => {
    let exchanges = 0;
    const wrapper = createMcpWrapper({
      clientFactory,
      tokenExchangerFactory: exchangerFor(() => {
        exchanges += 1;
        return { access_token: "should-not-be-used", expires_in: 300 };
      }),
    });
    await wrapper.connect(filteredConfig);

    const cognitoToken = jwtWithClaims({
      iss: "https://other-idp.example.com/pool",
      sub: "cognito-user",
    });
    expect(await wrapper.targetSubject?.("vectorsearch", cognitoToken)).toBeUndefined();
    await wrapper.callTool("vectorsearch", "t", {}, mkCtx({ ssoToken: cognitoToken }));

    expect(exchanges).toBe(0);
    const withAuth = created.filter((c) => c.authorization() !== undefined);
    expect(withAuth).toHaveLength(1);
    expect(withAuth[0]?.authorization()).toBe(`Bearer ${cognitoToken}`);
  });
});

describe("MCP wrapper — tokenExchange.audienceByOrigin", () => {
  const audiences: string[] = [];
  const perAudienceFactory = (config: McpServerConfig): TokenExchanger | undefined => {
    const tx = config.tokenExchange;
    if (tx?.audience === undefined) return undefined;
    const audience = tx.audience;
    const fetch: FetchLike = async () => {
      audiences.push(audience);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `token-for-${audience}`, expires_in: 300 }),
        text: async () => "",
      };
    };
    return new TokenExchanger(
      { tokenEndpoint: "https://idp.example/token", clientId: "c", clientSecret: "s", audience },
      { fetchImpl: fetch },
    );
  };
  const templated = (audience?: string): McpServerConfig =>
    ({
      name: "abiliware",
      urlTemplate: "{{requestParams.deployment.url}}/mcp",
      urlTemplateAllowedOrigins: ["https://*.abillify.io"],
      transport: "http",
      forwardAuthToken: true,
      tokenExchange: {
        tokenEndpoint: "https://idp.example/token",
        clientId: "atf-token-broker",
        clientSecretEnv: "IGNORED",
        clientSecret: "resolved",
        ...(audience !== undefined ? { audience } : {}),
        audienceByOrigin: {
          "https://a.abillify.io": "erp-a",
          "https://b.abillify.io": "erp-b",
        },
      },
    }) as McpServerConfig;
  const at = (url: string): RequestContext =>
    mkCtx({ requestParams: { deployment: { url } } } as Partial<RequestContext>);

  beforeEach(() => {
    audiences.length = 0;
  });

  test("each origin receives a token minted for its own audience", async () => {
    const wrapper = createMcpWrapper({ clientFactory, tokenExchangerFactory: perAudienceFactory });
    await wrapper.connect(templated());

    await wrapper.callTool("abiliware", "t", {}, at("https://a.abillify.io"));
    await wrapper.callTool("abiliware", "t", {}, at("https://b.abillify.io"));

    expect(audiences).toEqual(["erp-a", "erp-b"]);
    const bearers = created.map((c) => c.authorization()).filter((a) => a !== undefined);
    expect(bearers).toEqual(["Bearer token-for-erp-a", "Bearer token-for-erp-b"]);
  });

  test("an unmapped origin without fallback audience fails closed", async () => {
    const wrapper = createMcpWrapper({ clientFactory, tokenExchangerFactory: perAudienceFactory });
    await wrapper.connect(templated());

    await expect(
      wrapper.callTool("abiliware", "t", {}, at("https://c.abillify.io")),
    ).rejects.toThrow(/no audience configured for origin https:\/\/c\.abillify\.io/);
    expect(audiences).toEqual([]);
    expect(created.some((c) => c.authorization()?.includes("user-subject-token"))).toBe(false);
  });

  test("an unmapped origin uses the fallback audience when one is set", async () => {
    const wrapper = createMcpWrapper({ clientFactory, tokenExchangerFactory: perAudienceFactory });
    await wrapper.connect(templated("erp-default"));

    await wrapper.callTool("abiliware", "t", {}, at("https://c.abillify.io"));
    expect(audiences).toEqual(["erp-default"]);
  });
});
