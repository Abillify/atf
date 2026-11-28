// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Wrapper — urlTemplate session tests.
 *
 * A `urlTemplate` server resolves its endpoint per request from
 * `ctx.requestParams`. These tests pin the security-relevant invariants:
 *   - no shared/bootstrap session is ever created for a templated server;
 *   - sessions are keyed by (caller token, resolved URL), so two deployments
 *     behind one template never share a client;
 *   - discovery and calls fail closed when the request metadata is missing.
 *
 * Same fake-client harness as mcp-client.test.ts (injected clientFactory;
 * real transports are constructed but never started).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpWrapper } from "../wrapper/client.js";
import type { McpServerConfig } from "../../config/index.js";
import type { RequestContext } from "../../types/monitoring.js";

interface RawToolLike {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

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
  async listTools(): Promise<{ tools: RawToolLike[] }> {
    return {
      tools: [
        {
          name: "t",
          description: "desc-t",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    };
  }
  /** The endpoint URL this client's transport was built with. */
  endpoint(): string | undefined {
    const url = (this.lastTransport as { _url?: URL } | null)?._url;
    return url?.toString();
  }
  /** The `Authorization` header this client's transport was built with. */
  authorization(): string | undefined {
    return (
      this.lastTransport as { _requestInit?: { headers?: Record<string, string> } } | null
    )?._requestInit?.headers?.Authorization;
  }
  async callTool(
    req: { name: string; arguments: Record<string, unknown> },
    _schema?: unknown,
    _options?: { signal?: AbortSignal },
  ): Promise<{ content: unknown; isError?: boolean }> {
    lastCalls.push({ client: this, req });
    return { content: [{ type: "text", text: "ok" }], isError: false };
  }
  async close(): Promise<void> {}
}

const created: FakeClient[] = [];
const lastCalls: Array<{ client: FakeClient; req: { name: string; arguments: Record<string, unknown> } }> = [];

const clientFactory = (_info: { name: string; version: string }): Client =>
  new FakeClient(_info) as unknown as Client;

const TEMPLATE = "{{requestParams.deployment.url}}/mcp";

function mkTemplatedConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "abiliware",
    url: undefined,
    urlTemplate: TEMPLATE,
    urlTemplateAllowedOrigins: ["https://tenant-a.example", "https://tenant-b.example", "https://x.example"],
    transport: "http",
    forwardAuthToken: true,
    ...over,
  } as McpServerConfig;
}

function mkCtx(over: Partial<RequestContext> = {}): RequestContext {
  return {
    ssoToken: "sso-abc",
    executionId: "exec-1",
    ...over,
  };
}

function params(url: string): Record<string, unknown> {
  return { deployment: { url } };
}

beforeEach(() => {
  created.length = 0;
  lastCalls.length = 0;
});

describe("urlTemplate — connect()", () => {
  test("never creates a shared session, even with a bootstrap Authorization header", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(
      mkTemplatedConfig({ headers: { Authorization: "Bearer bootstrap" } }),
    );
    expect(created).toHaveLength(0);
  });

  test("static servers still connect eagerly (unchanged)", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect({
      name: "static",
      url: "http://localhost:9999/mcp",
      transport: "http",
    } as McpServerConfig);
    expect(created).toHaveLength(1);
  });
});

describe("urlTemplate — callTool", () => {
  test("resolves the endpoint from requestParams and forwards the caller bearer", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await w.callTool(
      "abiliware",
      "t",
      { query: "hi" },
      mkCtx({ requestParams: params("https://tenant-a.example") }),
    );
    expect(created).toHaveLength(1);
    const client = created[0] as FakeClient;
    expect(client.lastTransport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(client.endpoint()).toBe("https://tenant-a.example/mcp");
    expect(client.authorization()).toBe("Bearer sso-abc");
    // user_token must not be injected for a forwardAuth server.
    expect("user_token" in (lastCalls[0]?.req.arguments ?? {})).toBe(false);
  });

  test("fails closed without the request metadata", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await expect(
      w.callTool("abiliware", "t", { query: "x" }, mkCtx()),
    ).rejects.toThrow(/urlTemplate resolved requestParams\.deployment\.url/);
    expect(created).toHaveLength(0);
  });

  test("two deployments behind one template get two sessions", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await w.callTool(
      "abiliware",
      "t",
      {},
      mkCtx({ requestParams: params("https://tenant-a.example") }),
    );
    await w.callTool(
      "abiliware",
      "t",
      {},
      mkCtx({ requestParams: params("https://tenant-b.example") }),
    );
    expect(created).toHaveLength(2);
    expect(created[0]?.endpoint()).toBe("https://tenant-a.example/mcp");
    expect(created[1]?.endpoint()).toBe("https://tenant-b.example/mcp");
  });

  test("same token + same resolved URL reuses the session", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await w.callTool(
      "abiliware",
      "t",
      {},
      mkCtx({ requestParams: params("https://tenant-a.example") }),
    );
    await w.callTool(
      "abiliware",
      "t",
      {},
      mkCtx({ requestParams: params("https://tenant-a.example") }),
    );
    expect(created).toHaveLength(1);
  });

  test("same resolved URL with a different caller token gets its own session", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await w.callTool(
      "abiliware",
      "t",
      {},
      mkCtx({ ssoToken: "tokenA", requestParams: params("https://x.example") }),
    );
    await w.callTool(
      "abiliware",
      "t",
      {},
      mkCtx({ ssoToken: "tokenB", requestParams: params("https://x.example") }),
    );
    expect(created).toHaveLength(2);
    expect(created[0]?.authorization()).toBe("Bearer tokenA");
    expect(created[1]?.authorization()).toBe("Bearer tokenB");
  });
});

describe("urlTemplate — discovery", () => {
  test("listTools fails closed without requestParams", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await expect(w.listTools("abiliware")).rejects.toThrow(/urlTemplate/);
    expect(created).toHaveLength(0);
  });

  test("listTools resolves the endpoint from requestParams", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    const tools = await w.listTools("abiliware", {
      authToken: "sso-abc",
      requestParams: params("https://tenant-a.example"),
    });
    expect(tools).toEqual(["t"]);
    expect(created[0]?.endpoint()).toBe("https://tenant-a.example/mcp");
  });

  test("getFilteredToolSchema resolves the endpoint from requestParams", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    const schema = await w.getFilteredToolSchema("abiliware", "t", {
      authToken: "sso-abc",
      requestParams: params("https://tenant-a.example"),
    });
    expect(schema.name).toBe("t");
    expect(created[0]?.endpoint()).toBe("https://tenant-a.example/mcp");
  });

  test("getFilteredToolSchema fails closed without requestParams", async () => {
    const w = createMcpWrapper({ clientFactory });
    await w.connect(mkTemplatedConfig());
    await expect(
      w.getFilteredToolSchema("abiliware", "t", { authToken: "sso-abc" }),
    ).rejects.toThrow(/urlTemplate/);
  });
});
