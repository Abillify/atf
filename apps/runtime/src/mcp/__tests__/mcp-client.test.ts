// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Wrapper — Client / Session Handling Tests
 *
 * Exercises the McpWrapper class (connect, reconnect, listTools,
 * getFilteredToolSchema, refreshSchemaIfChanged, callTool, per-caller token
 * sessions, and the session-expiry / connection-error recovery paths) without
 * a real MCP server.
 *
 * Rather than mocking the shared @modelcontextprotocol/sdk modules (which would
 * leak into sibling test files that use the real SDK), the wrapper is given an
 * injected `clientFactory` that returns a fake MCP client. The real transports
 * are still constructed — their constructors are side-effect-free (stdio spawns
 * only in start(), which never runs because the fake client's connect is a
 * no-op) — so the transport-selection code stays covered.
 *
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpWrapper,
  isSessionExpiredError,
  isConnectionError,
  StreamableHTTPError,
  type SchemaCompatibilityReport,
} from "../wrapper/client.js";
import type { McpServerConfig } from "../../config/index.js";
import type { RequestContext } from "../../types/monitoring.js";
import { Stateless2026Client } from "../wrapper/stateless-2026-client.js";
import { serializeEvidenceActionContract } from "../../transaction/evidence-contract.js";

// ---------------------------------------------------------------------------
// Fake MCP client
// ---------------------------------------------------------------------------

interface RawToolLike {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    destructiveHint?: boolean;
  };
  outputSchema?: Record<string, unknown>;
  inputSchema: {
    type: string;
    properties?: Record<string, object>;
    required?: string[];
  };
}

interface Behavior {
  connect: (client: FakeClient) => Promise<void>;
  getInstructions: () => string | undefined;
  /**
   * `client` is the fake client instance serving the request, so a test can
   * distinguish the bootstrap session from a per-caller (bearer) session.
   */
  listTools: (client?: FakeClient) => Promise<{ tools: RawToolLike[] }>;
  callTool: (
    req: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    options?: { signal?: AbortSignal },
    client?: FakeClient,
  ) => Promise<{ content: unknown; isError?: boolean }>;
  close: (client?: FakeClient) => Promise<void>;
}

const created: FakeClient[] = [];
let lastCall: {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: Record<string, unknown>;
} | null = null;

const defaultTool = (name: string): RawToolLike => ({
  name,
  description: `desc-${name}`,
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
});

const behavior: Behavior = {
  connect: async () => {},
  getInstructions: () => undefined,
  listTools: async () => ({ tools: [defaultTool("t")] }),
  callTool: async (req) => {
    lastCall = req;
    return { content: [{ type: "text", text: "ok" }], isError: false };
  },
  close: async () => {},
};

class FakeClient {
  lastTransport: unknown = null;
  constructor(_info: unknown) {
    created.push(this);
  }
  async connect(transport: unknown): Promise<void> {
    this.lastTransport = transport;
    await behavior.connect(this);
  }
  getInstructions(): string | undefined {
    return behavior.getInstructions();
  }
  async listTools(): Promise<{ tools: RawToolLike[] }> {
    return behavior.listTools(this);
  }

  /** The `Authorization` header this client's transport was built with. */
  authorization(): string | undefined {
    const init = (
      this.lastTransport as { _requestInit?: { headers?: Record<string, string> } } | null
    )?._requestInit;
    return init?.headers?.Authorization;
  }
  async callTool(
    req: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    _schema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: unknown; isError?: boolean }> {
    return behavior.callTool(req, options, this);
  }
  async close(): Promise<void> {
    await behavior.close(this);
  }
}

// The wrapper only ever calls the subset of Client methods implemented above.
const clientFactory = (info: { name: string; version: string }): Client =>
  new FakeClient(info) as unknown as Client;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkWrapper(
  options: {
    capabilityTtlMs?: number;
    retryTimeoutMs?: number;
    connectTimeoutMs?: number;
    connectBackoffBaseMs?: number;
    connectBackoffMaxMs?: number;
    schemaTtlMs?: number;
    schemaCompatibilityMode?: "report" | "strict";
    onSchemaCompatibility?: (report: SchemaCompatibilityReport) => void;
    maxTokenClientsPerServer?: number;
    fetchFn?: typeof fetch;
  } = {},
): ReturnType<typeof createMcpWrapper> {
  return createMcpWrapper({ clientFactory, ...options });
}

function mkConfig(over: Partial<McpServerConfig> & { name: string }): McpServerConfig {
  return {
    url: "http://localhost:9999/mcp",
    transport: "http",
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

beforeEach(() => {
  created.length = 0;
  lastCall = null;
  behavior.connect = async () => {};
  behavior.getInstructions = () => undefined;
  behavior.listTools = async () => ({ tools: [defaultTool("t")] });
  behavior.callTool = async (req) => {
    lastCall = req;
    return { content: [{ type: "text", text: "ok" }], isError: false };
  };
  behavior.close = async () => {};
});

// ---------------------------------------------------------------------------
// Error detection helpers
// ---------------------------------------------------------------------------

describe("isSessionExpiredError", () => {
  test("true for StreamableHTTPError with code 404", () => {
    expect(isSessionExpiredError(new StreamableHTTPError(404, "gone"))).toBe(true);
  });

  test("false for StreamableHTTPError with a non-404 code", () => {
    expect(isSessionExpiredError(new StreamableHTTPError(500, "boom"))).toBe(false);
  });

  test("true for a plain Error mentioning 404 and session", () => {
    expect(isSessionExpiredError(new Error("HTTP 404 — session not found"))).toBe(true);
  });

  test("false for a 404 error without the word session", () => {
    expect(isSessionExpiredError(new Error("404 not found"))).toBe(false);
  });

  test("false for a non-Error value", () => {
    expect(isSessionExpiredError("nope")).toBe(false);
  });
});

describe("isConnectionError", () => {
  test.each([
    "connect ECONNREFUSED 127.0.0.1:9999",
    "read ECONNRESET",
    "getaddrinfo ENOTFOUND host",
    "connect ETIMEDOUT",
    "write EPIPE",
    "connection closed",
    "transport disconnected",
    "socket hang up",
    "write after end",
    "process exited unexpectedly",
    "spawn mcp-server ENOENT",
  ])("true for %p", (msg) => {
    expect(isConnectionError(new Error(msg))).toBe(true);
  });

  test("false for an unrelated error", () => {
    expect(isConnectionError(new Error("validation failed"))).toBe(false);
  });

  test("false for a non-Error value", () => {
    expect(isConnectionError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// connect / getInstructions / transports
// ---------------------------------------------------------------------------

describe("connect + getInstructions", () => {
  test("connects an http server and stores non-empty instructions", async () => {
    behavior.getInstructions = () => "Use tenant-scoped queries only.";
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    expect(created).toHaveLength(1);
    expect(created[0]?.lastTransport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(w.getInstructions("srv")).toBe("Use tenant-scoped queries only.");
  });

  test("does not store empty/whitespace instructions", async () => {
    behavior.getInstructions = () => "   ";
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    expect(w.getInstructions("srv")).toBeUndefined();
  });

  test("getInstructions is undefined for an unknown server", () => {
    const w = mkWrapper();
    expect(w.getInstructions("never-connected")).toBeUndefined();
  });

  test("does not expose bootstrap instructions for a forward-auth server", async () => {
    behavior.getInstructions = () => "Admin-only discovery guidance";
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    expect(w.getInstructions("srv")).toBeUndefined();
  });

  test("defers a forward-auth server without static authorization until caller use", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    expect(created).toHaveLength(0);

    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "caller-token" }));
    expect(created).toHaveLength(1);
    expect(created[0]?.authorization()).toBe("Bearer caller-token");
  });

  test("connects a forward-auth bootstrap when static authorization is configured", async () => {
    const w = mkWrapper();
    await w.connect(
      mkConfig({
        name: "srv",
        forwardAuthToken: true,
        headers: { Authorization: "Bearer bootstrap-token" },
      }),
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.authorization()).toBe("Bearer bootstrap-token");
  });

  test("rejects anonymous caller forwarding defensively", async () => {
    const w = mkWrapper();
    await expect(
      w.connect(
        mkConfig({ name: "srv", allowAnonymous: true, forwardAuthToken: true }),
      ),
    ).rejects.toThrow(/cannot combine allowAnonymous=true with forwardAuthToken=true/);
    expect(created).toHaveLength(0);
  });

  test("connects an http server with static headers configured", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", headers: { "X-Api-Key": "secret" } }));
    expect(created[0]?.lastTransport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  test("connects an sse server", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "sse-srv", transport: "sse" }));
    expect(created[0]?.lastTransport).toBeInstanceOf(SSEClientTransport);
  });

  /**
   * Regression: the SSE branch used to ignore `config.headers` (and the
   * per-caller `forwardAuthToken` bearer) completely, so an SSE MCP server
   * behind authentication was unreachable. Headers must land on BOTH legs of
   * the transport — the POST-back channel (`requestInit`) and the long-lived
   * GET event stream (`eventSourceInit.fetch`).
   */
  test("forwards configured headers to an sse server on both legs", async () => {
    // Req 7.2: the wrapper's outbound transport is injectable now — the
    // capture stub goes through fetchFn instead of globalThis.fetch.
    let seen: Record<string, string> | undefined;
    const w = mkWrapper({
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        seen = init?.headers as Record<string, string>;
        return new Response("", { status: 200 });
      }) as typeof fetch,
    });
    await w.connect(
      mkConfig({
        name: "sse-auth",
        transport: "sse",
        headers: { "X-Api-Key": "secret", Authorization: "Bearer static" },
      }),
    );

    const transport = created[0]?.lastTransport as unknown as {
      _requestInit?: { headers?: Record<string, string> };
      _eventSourceInit?: { fetch?: typeof fetch };
    };

    // POST-back channel
    expect(transport._requestInit?.headers).toMatchObject({
      "X-Api-Key": "secret",
      Authorization: "Bearer static",
    });

    // GET event-stream channel: the injected fetch must merge our headers in.
    const wrappedFetch = transport._eventSourceInit?.fetch;
    expect(typeof wrappedFetch).toBe("function");

    await wrappedFetch?.("https://example.test/sse", {
      headers: { Accept: "text/event-stream" },
    });
    expect(seen).toMatchObject({
      Accept: "text/event-stream",
      "X-Api-Key": "secret",
      Authorization: "Bearer static",
    });
  });

  test("does not attach header plumbing to an sse server without headers", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "sse-plain", transport: "sse" }));
    const transport = created[0]?.lastTransport as unknown as {
      _requestInit?: unknown;
      _eventSourceInit?: unknown;
    };
    expect(transport._requestInit).toBeUndefined();
    expect(transport._eventSourceInit).toBeUndefined();
  });

  test("connects a stdio server", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "stdio-srv", transport: "stdio", url: "my-cmd" }));
    expect(created[0]?.lastTransport).toBeInstanceOf(StdioClientTransport);
  });

  test("rejects an unsupported transport", async () => {
    const w = mkWrapper();
    const bad = {
      name: "srv",
      url: "x",
      transport: "ftp",
    } as unknown as McpServerConfig;
    await expect(w.connect(bad)).rejects.toThrow(/Unsupported transport/);
  });
});

// ---------------------------------------------------------------------------
// listTools + recovery
// ---------------------------------------------------------------------------

describe("listTools", () => {
  test("returns the tool names", async () => {
    behavior.listTools = async () => ({
      tools: [defaultTool("a"), defaultTool("b")],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    expect(await w.listTools("srv")).toEqual(["a", "b"]);
  });

  test("uses caller-specific clients for forward-auth discovery and rejects missing tokens", async () => {
    behavior.listTools = async (client) => ({
      tools: [defaultTool(client?.authorization() === "Bearer tokenA" ? "a-only" : "b-only")],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));

    await expect(w.listTools("srv")).rejects.toThrow(/required auth token/i);
    expect(await w.listTools("srv", { authToken: "tokenA" })).toEqual(["a-only"]);
    expect(await w.listTools("srv", { authToken: "tokenB" })).toEqual(["b-only"]);
  });

  test("holds a token-client lease for an active discovery request", async () => {
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const started = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const closed: FakeClient[] = [];
    behavior.listTools = async (client) => {
      if (client?.authorization() === "Bearer tokenA") {
        activeStarted();
        await activeGate;
      }
      return { tools: [defaultTool("t")] };
    };
    behavior.close = async (client) => {
      if (client !== undefined) closed.push(client);
    };
    const w = mkWrapper({ maxTokenClientsPerServer: 1 });
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));

    const active = w.listTools("srv", { authToken: "tokenA" });
    await started;
    await w.listTools("srv", { authToken: "tokenB" });
    expect(closed).toEqual([]);

    releaseActive();
    await active;
    expect(closed).toHaveLength(1);
    expect(closed[0]?.authorization()).toBe("Bearer tokenA");
  });

  test("throws when the server is not connected", async () => {
    const w = mkWrapper();
    await expect(w.listTools("srv")).rejects.toThrow(/MCP server not found: srv/);
  });

  test("reconnects and retries once on session expiry (404)", async () => {
    let n = 0;
    behavior.listTools = async () => {
      n += 1;
      if (n === 1) throw new StreamableHTTPError(404, "session expired");
      return { tools: [defaultTool("a")] };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    expect(await w.listTools("srv")).toEqual(["a"]);
    // one client from connect + one from reconnect
    expect(created).toHaveLength(2);
  });

  test("reconnects and retries once on a connection error", async () => {
    let n = 0;
    behavior.listTools = async () => {
      n += 1;
      if (n === 1) throw new Error("read ECONNRESET");
      return { tools: [defaultTool("a")] };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    expect(await w.listTools("srv")).toEqual(["a"]);
    expect(created).toHaveLength(2);
  });

  test("rethrows a non-recoverable error without reconnecting", async () => {
    behavior.listTools = async () => {
      throw new Error("boom");
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await expect(w.listTools("srv")).rejects.toThrow("boom");
    expect(created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------

describe("reconnect", () => {
  test("throws for an unknown server", async () => {
    const w = mkWrapper();
    await expect(w.reconnect("srv")).rejects.toThrow(/MCP server not found: srv/);
  });

  test("closes the old client (ignoring close errors) and opens a fresh one", async () => {
    behavior.close = async () => {
      throw new Error("already dead");
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await w.reconnect("srv");
    expect(created).toHaveLength(2);
  });

  test("a failed reconnect keeps the existing working session usable", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const original = created[0];
    expect(original).toBeDefined();

    // The replacement handshake fails (e.g. peer busy → connect timeout).
    behavior.connect = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    };
    await expect(w.reconnect("srv")).rejects.toThrow(/ECONNREFUSED/);

    // Make-before-break: the original client was NOT closed and still serves calls.
    let closedOriginal = false;
    behavior.close = async (client?: FakeClient) => {
      if (client === original) closedOriginal = true;
    };
    const result = await w.callTool("srv", "t", {}, mkCtx());
    expect(result).toBeDefined();
    expect(closedOriginal).toBe(false);
  });

  test("reconnect does not open a shared session for a forward-auth server", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    expect(created).toHaveLength(0);
    await w.reconnect("srv");
    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shared client self-healing (on-demand connect after failed startup/recovery)
// ---------------------------------------------------------------------------

describe("shared client self-healing", () => {
  const hang = (): Promise<void> => new Promise<void>(() => {});
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("startup connect timeout: the next tool call connects on demand without restart", async () => {
    behavior.connect = hang;
    const w = mkWrapper({ connectTimeoutMs: 20, connectBackoffBaseMs: 1 });
    await expect(w.connect(mkConfig({ name: "srv" }))).rejects.toThrow(
      /MCP connect srv timed out after 20ms/,
    );
    expect(created).toHaveLength(1);

    behavior.connect = async () => {};
    await sleep(5);
    const result = await w.callTool("srv", "t", {}, mkCtx());
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(created).toHaveLength(2);
  });

  test("recovery connect timeout: the call fails transiently, the next call heals the client", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    let calls = 0;
    behavior.callTool = async () => {
      calls += 1;
      if (calls === 1) throw new Error("read ECONNRESET");
      return { content: "healed" };
    };
    // retryTimeoutMs ≠ connectTimeoutMs proves the recovery handshake is
    // bounded by the connect timeout, not the per-request retry timeout.
    const w = mkWrapper({
      retryTimeoutMs: 1_000,
      connectTimeoutMs: 20,
      connectBackoffBaseMs: 1,
    });
    await w.connect(mkConfig({ name: "srv" }));

    behavior.connect = hang;
    let failure: unknown;
    try {
      await w.callTool("srv", "t", {}, mkCtx());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out after 20ms/);
    expect((failure as Error).message).toMatch(/MCP server temporarily unavailable/);
    expect((failure as Error).message).not.toMatch(/MCP server not found/);

    behavior.connect = async () => {};
    await sleep(5);
    const result = await w.callTool("srv", "t", {}, mkCtx());
    expect(result.content).toBe("healed");
    // bootstrap + hung recovery + on-demand replacement
    expect(created).toHaveLength(3);
  });

  test("concurrent calls after a failed startup share one on-demand connect", async () => {
    behavior.connect = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    };
    const w = mkWrapper({ connectBackoffBaseMs: 1 });
    await expect(w.connect(mkConfig({ name: "srv" }))).rejects.toThrow(/ECONNREFUSED/);
    expect(created).toHaveLength(1);

    behavior.connect = async () => {
      await sleep(10);
    };
    await sleep(5);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => w.callTool("srv", "t", { i }, mkCtx())),
    );
    expect(results).toHaveLength(5);
    expect(created).toHaveLength(2);
  });

  test("inside the backoff window calls fail fast as temporarily unavailable", async () => {
    behavior.connect = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    };
    const w = mkWrapper({ connectBackoffBaseMs: 10_000 });
    await expect(w.connect(mkConfig({ name: "srv" }))).rejects.toThrow(/ECONNREFUSED/);
    behavior.connect = async () => {};

    await expect(w.callTool("srv", "t", {}, mkCtx())).rejects.toThrow(
      /MCP server temporarily unavailable: srv \(configured but not connected; last connect attempt failed: connect ECONNREFUSED/,
    );
    expect(created).toHaveLength(1);
  });

  test("a failed on-demand connect doubles the backoff window", async () => {
    behavior.connect = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    };
    const w = mkWrapper({ connectBackoffBaseMs: 20, connectBackoffMaxMs: 10_000 });
    await expect(w.connect(mkConfig({ name: "srv" }))).rejects.toThrow(/ECONNREFUSED/);
    await sleep(30);
    await expect(w.callTool("srv", "t", {}, mkCtx())).rejects.toThrow(
      /temporarily unavailable: srv/,
    );
    expect(created).toHaveLength(2);
    // Second failure → 40 ms window; 30 ms later still blocked.
    await sleep(30);
    await expect(w.callTool("srv", "t", {}, mkCtx())).rejects.toThrow(/retry in \d+ ms/);
    expect(created).toHaveLength(2);
  });

  test("an unconfigured server is reported as not configured", async () => {
    const w = mkWrapper();
    await expect(w.callTool("nope", "t", {}, mkCtx())).rejects.toThrow(
      /MCP server not found: nope \(not configured\)/,
    );
  });

  test("a per-server connectTimeoutMs overrides the wrapper default", async () => {
    behavior.connect = async () => {
      await sleep(50);
    };
    const w = mkWrapper({ connectTimeoutMs: 10 });
    await w.connect(mkConfig({ name: "srv", connectTimeoutMs: 500 }));
    const result = await w.callTool("srv", "t", {}, mkCtx());
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("discovery connects on demand after a failed startup", async () => {
    behavior.connect = hang;
    const w = mkWrapper({ connectTimeoutMs: 20, connectBackoffBaseMs: 1 });
    await expect(w.connect(mkConfig({ name: "srv" }))).rejects.toThrow(/timed out/);
    behavior.connect = async () => {};
    await sleep(5);
    expect(await w.listTools("srv")).toEqual(["t"]);
    const schema = await w.getFilteredToolSchema("srv", "t");
    expect(schema).toBeDefined();
    expect(created).toHaveLength(2);
  });

  test("mid-session abort with a rejected recovery handshake → temporarily unavailable, not raw ECONNRESET", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    behavior.callTool = async () => {
      throw new Error("read ECONNRESET");
    };
    const w = mkWrapper({ connectBackoffBaseMs: 1 });
    await w.connect(mkConfig({ name: "srv" }));

    // The peer drops the session; the recovery handshake is reset as well.
    behavior.connect = async () => {
      throw new Error("read ECONNRESET");
    };
    let failure: unknown;
    try {
      await w.callTool("srv", "t", {}, mkCtx());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /^MCP server temporarily unavailable: srv \(configured but not connected; last connect attempt failed: read ECONNRESET/,
    );
    expect(message).not.toMatch(/MCP server not found/);
  });
});

// ---------------------------------------------------------------------------
// reconnect vs. on-demand connect / recovery races
// ---------------------------------------------------------------------------

describe("reconnect single-flight", () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test.each([
    ["reconnect first", true],
    ["callTool first", false],
  ] as const)(
    "without a client, reconnect and an on-demand call share one handshake (%s)",
    async (_label, reconnectFirst) => {
      behavior.connect = async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
      };
      const w = mkWrapper({ connectBackoffBaseMs: 1 });
      await expect(w.connect(mkConfig({ name: "srv" }))).rejects.toThrow(/ECONNREFUSED/);
      expect(created).toHaveLength(1);

      const closed: FakeClient[] = [];
      behavior.close = async (client) => {
        if (client !== undefined) closed.push(client);
      };
      behavior.connect = async () => {
        await sleep(20);
      };
      await sleep(5);
      const reconnect = (): Promise<void> => w.reconnect("srv");
      const call = () => w.callTool("srv", "t", {}, mkCtx());
      if (reconnectFirst) {
        const r = reconnect();
        const c = call();
        await Promise.all([r, c]);
      } else {
        const c = call();
        const r = reconnect();
        await Promise.all([r, c]);
      }
      // bootstrap failure + exactly one shared handshake, no closed loser.
      expect(created).toHaveLength(2);
      expect(closed).toHaveLength(0);
      const served: FakeClient[] = [];
      behavior.callTool = async (_req, _opts, client) => {
        if (client !== undefined) served.push(client);
        return { content: "ok" };
      };
      await w.callTool("srv", "t", {}, mkCtx());
      expect(served[0]).toBe(created[1]);
    },
  );

  test("reconnect with an old client yields to a recovery replacement installed during its handshake", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const original = created[0];
    const closed: FakeClient[] = [];
    behavior.close = async (client) => {
      if (client !== undefined) closed.push(client);
    };
    // Client #1 (reconnect) handshakes slowly, client #2 (recovery) at once.
    behavior.connect = async (client) => {
      if (client === created[1]) await sleep(40);
    };
    const served: FakeClient[] = [];
    behavior.callTool = async (_req, _opts, client) => {
      if (client === original) throw new Error("read ECONNRESET");
      if (client !== undefined) served.push(client);
      return { content: "ok" };
    };

    const reconnecting = w.reconnect("srv");
    await sleep(5);
    // The old session breaks; transport recovery installs client #2.
    await w.callTool("srv", "t", {}, mkCtx());
    expect(created).toHaveLength(3);
    const replacement = created[2];
    expect(served).toEqual([replacement as FakeClient]);

    await reconnecting;
    // The recovery replacement stays; reconnect's own client is closed; the
    // old client was closed exactly once (by the recovery).
    expect(closed.filter((c) => c === created[1])).toHaveLength(1);
    expect(closed.filter((c) => c === original)).toHaveLength(1);
    expect(closed.filter((c) => c === replacement)).toHaveLength(0);
    await w.callTool("srv", "t", {}, mkCtx());
    expect(served.at(-1)).toBe(replacement);
  });
});

// ---------------------------------------------------------------------------
// getFilteredToolSchema
// ---------------------------------------------------------------------------

describe("getFilteredToolSchema", () => {
  test("removes protected + injected params and prunes required", async () => {
    behavior.listTools = async () => ({
      tools: [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              user_token: { type: "string" },
              api_key: { type: "string" },
            },
            required: ["query", "user_token"],
          },
        },
      ],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", injectedParams: { api_key: "static" } }));
    const schema = await w.getFilteredToolSchema("srv", "lookup");
    expect(Object.keys(schema.inputSchema.properties)).toEqual(["query"]);
    expect(schema.inputSchema.required).toEqual(["query"]);
    expect(schema.name).toBe("lookup");
  });

  test("drops required entirely when every required field is protected", async () => {
    behavior.listTools = async () => ({
      tools: [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: { user_token: { type: "string" } },
            required: ["user_token"],
          },
        },
      ],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const schema = await w.getFilteredToolSchema("srv", "lookup");
    expect(schema.inputSchema.required).toBeUndefined();
    expect(Object.keys(schema.inputSchema.properties)).toEqual([]);
  });

  test("partitions forward-auth schema cache and checksums by token", async () => {
    let requests = 0;
    behavior.listTools = async (client) => {
      requests += 1;
      const token = client?.authorization();
      return {
        tools: [
          {
            name: "lookup",
            inputSchema: {
              type: "object",
              properties: {
                [token === "Bearer tokenA" ? "only_a" : "only_b"]: { type: "string" },
              },
            },
          },
        ],
      };
    };
    const w = mkWrapper({ schemaTtlMs: 60_000 });
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));

    const a = await w.getFilteredToolSchema("srv", "lookup", { authToken: "tokenA" });
    const b = await w.getFilteredToolSchema("srv", "lookup", { authToken: "tokenB" });
    const aAgain = await w.getFilteredToolSchema("srv", "lookup", { authToken: "tokenA" });
    expect(a.inputSchema.properties).toEqual({ only_a: { type: "string" } });
    expect(b.inputSchema.properties).toEqual({ only_b: { type: "string" } });
    expect(aAgain.inputSchema.properties).toEqual({ only_a: { type: "string" } });
    // A's fresh cache entry must not satisfy B; A's own entry remains reusable.
    expect(requests).toBe(2);
    await expect(w.getFilteredToolSchema("srv", "lookup")).rejects.toThrow(/required auth token/i);
  });

  test("reconnects and retries once on session expiry", async () => {
    let n = 0;
    behavior.listTools = async () => {
      n += 1;
      if (n === 1) throw new StreamableHTTPError(404, "session expired");
      return { tools: [defaultTool("lookup")] };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const schema = await w.getFilteredToolSchema("srv", "lookup");
    expect(schema.name).toBe("lookup");
    expect(created).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// refreshSchemaIfChanged
// ---------------------------------------------------------------------------

describe("refreshSchemaIfChanged", () => {
  test("returns false when the schema is unchanged, true after it drifts", async () => {
    let variant = 0;
    behavior.listTools = async () => ({
      tools: [
        variant === 0
          ? defaultTool("t")
          : {
              name: "t",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  extra: { type: "number" },
                },
              },
            },
      ],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));

    // Seed the stored checksum via a filtered-schema fetch.
    await w.getFilteredToolSchema("srv", "t");
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(false);

    // Drift the schema — the next refresh must detect the change.
    variant = 1;
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(true);
  });

  test("report mode accepts breaking drift and emits findings", async () => {
    let required = false;
    const reports: SchemaCompatibilityReport[] = [];
    behavior.listTools = async () => ({
      tools: [
        {
          name: "t",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            ...(required ? { required: ["query"] } : {}),
          },
        },
      ],
    });
    const w = mkWrapper({
      schemaCompatibilityMode: "report",
      onSchemaCompatibility: (report) => reports.push(report),
    });
    await w.connect(mkConfig({ name: "srv" }));
    await w.getFilteredToolSchema("srv", "t");

    required = true;
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.diff.breaking.map((finding) => finding.code)).toContain(
      "property-made-required",
    );
  });

  test("strict mode repeatedly rejects breaking drift without replacing accepted state", async () => {
    let required = false;
    const reports: SchemaCompatibilityReport[] = [];
    behavior.listTools = async () => ({
      tools: [
        {
          name: "t",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            ...(required ? { required: ["query"] } : {}),
          },
        },
      ],
    });
    const w = mkWrapper({
      schemaCompatibilityMode: "strict",
      onSchemaCompatibility: (report) => reports.push(report),
    });
    await w.connect(mkConfig({ name: "srv" }));
    await w.getFilteredToolSchema("srv", "t");

    required = true;
    await expect(w.refreshSchemaIfChanged("srv", "t")).rejects.toThrow(
      /Breaking MCP schema change rejected/,
    );
    await expect(w.refreshSchemaIfChanged("srv", "t")).rejects.toThrow(
      /Breaking MCP schema change rejected/,
    );
    expect(reports).toHaveLength(2);

    required = false;
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(false);
  });

  test("strict mode preserves the accepted baseline across explicit reconnect", async () => {
    let required = false;
    behavior.listTools = async () => ({
      tools: [{
        name: "t",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          ...(required ? { required: ["query"] } : {}),
        },
      }],
    });
    const w = mkWrapper({ schemaCompatibilityMode: "strict" });
    await w.connect(mkConfig({ name: "srv" }));
    await w.getFilteredToolSchema("srv", "t");

    required = true;
    await w.reconnect("srv");
    await expect(w.getFilteredToolSchema("srv", "t")).rejects.toThrow(
      /Breaking MCP schema change rejected/,
    );
    // A rejected discovery candidate must not replace the accepted baseline.
    await expect(w.getFilteredToolSchema("srv", "t")).rejects.toThrow(
      /Breaking MCP schema change rejected/,
    );
  });

  test("strict mode preserves the accepted baseline across automatic recovery", async () => {
    let required = false;
    let failNext = false;
    behavior.listTools = async () => {
      if (failNext) {
        failNext = false;
        throw new StreamableHTTPError(404, "session expired");
      }
      return {
        tools: [{
          name: "t",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            ...(required ? { required: ["query"] } : {}),
          },
        }],
      };
    };
    const w = mkWrapper({ schemaCompatibilityMode: "strict" });
    await w.connect(mkConfig({ name: "srv" }));
    await w.getFilteredToolSchema("srv", "t");

    required = true;
    failNext = true;
    await w.listTools("srv");
    await expect(w.getFilteredToolSchema("srv", "t")).rejects.toThrow(
      /Breaking MCP schema change rejected/,
    );
  });

  test("forward-auth recovery invalidates and enforces only the affected schema scope", async () => {
    let requireForA = false;
    let failAOnce = false;
    behavior.listTools = async (client) => {
      const isA = client?.authorization() === "Bearer tokenA";
      if (isA && failAOnce) {
        failAOnce = false;
        throw new StreamableHTTPError(404, "session expired");
      }
      return {
        tools: [{
          name: "t",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            ...(isA && requireForA ? { required: ["query"] } : {}),
          },
        }],
      };
    };
    const w = mkWrapper({ schemaCompatibilityMode: "strict", schemaTtlMs: 60_000 });
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    await w.getFilteredToolSchema("srv", "t", { authToken: "tokenA" });
    await w.getFilteredToolSchema("srv", "t", { authToken: "tokenB" });

    requireForA = true;
    failAOnce = true;
    await w.listTools("srv", { authToken: "tokenA" });
    await expect(
      w.getFilteredToolSchema("srv", "t", { authToken: "tokenA" }),
    ).rejects.toThrow(/Breaking MCP schema change rejected/);
    const tokenB = await w.getFilteredToolSchema("srv", "t", { authToken: "tokenB" });
    expect(tokenB.inputSchema.required).toBeUndefined();
  });

  test("strict mode reports but accepts unknown-only drift", async () => {
    let patterned = false;
    const reports: SchemaCompatibilityReport[] = [];
    behavior.listTools = async () => ({
      tools: [
        {
          name: "t",
          inputSchema: {
            type: "object",
            properties: {
              query: patterned
                ? { type: "string", pattern: "^[a-z]+$" }
                : { type: "string" },
            },
          },
        },
      ],
    });
    const w = mkWrapper({
      schemaCompatibilityMode: "strict",
      onSchemaCompatibility: (report) => reports.push(report),
    });
    await w.connect(mkConfig({ name: "srv" }));
    await w.getFilteredToolSchema("srv", "t");

    patterned = true;
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(true);
    expect(reports[0]?.diff.breaking).toEqual([]);
    expect(reports[0]?.diff.unknown.map((finding) => finding.code)).toContain(
      "pattern-changed",
    );
  });

  test("detects annotation-only drift because it changes retry safety", async () => {
    let readOnly = false;
    behavior.listTools = async () => ({
      tools: [
        {
          ...defaultTool("t"),
          annotations: { readOnlyHint: readOnly },
        },
      ],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await w.getFilteredToolSchema("srv", "t");
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(false);
    readOnly = true;
    expect(await w.refreshSchemaIfChanged("srv", "t")).toBe(true);
  });

  test("throws when the tool is absent from the server", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await expect(w.refreshSchemaIfChanged("srv", "missing")).rejects.toThrow(
      /Tool not found: missing/,
    );
  });
});

// ---------------------------------------------------------------------------
// callTool
// ---------------------------------------------------------------------------

describe("callTool", () => {
  test("refuses a tool without readOnlyHint in a side-effect-free run, never calling it", async () => {
    behavior.listTools = async () => ({
      tools: [
        { ...defaultTool("write"), annotations: { destructiveHint: true } },
        defaultTool("unannotated"),
        { ...defaultTool("read"), annotations: { readOnlyHint: true } },
      ],
    });
    let calls = 0;
    behavior.callTool = async () => {
      calls += 1;
      return { content: "ok" };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const ctx = mkCtx({ suppressSideEffects: true });

    await expect(w.callTool("srv", "write", {}, ctx)).rejects.toThrow(/readOnlyHint/);
    await expect(w.callTool("srv", "unannotated", {}, ctx)).rejects.toThrow(/readOnlyHint/);
    expect(calls).toBe(0);

    await w.callTool("srv", "read", {}, ctx);
    await w.callTool("srv", "write", {}, mkCtx());
    expect(calls).toBe(2);
  });

  test("throws when the SSO token is missing", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await expect(w.callTool("srv", "t", {}, mkCtx({ ssoToken: "" }))).rejects.toThrow(/user_token/);
  });

  test("allows an explicitly anonymous server without forwarding identity arguments", async () => {
    const w = mkWrapper();
    await w.connect(
      mkConfig({ name: "srv", allowAnonymous: true, protectedParams: ["tenant_id"] }),
    );
    await w.callTool(
      "srv",
      "t",
      {
        query: "hello",
        user_token: "attacker-supplied",
        user_email: "attacker@example.test",
        client_id: "attacker",
        tenant_id: "caller-controlled",
      },
      mkCtx({ ssoToken: "", userEmail: "context@example.test", clientId: "context-client" }),
    );
    expect(lastCall?.arguments).toEqual({ query: "hello" });
  });

  test("prepares and consumes an evidence-bound anonymous call without user_token", async () => {
    const w = mkWrapper();
    await w.connect(
      mkConfig({ name: "srv", allowAnonymous: true, protectedParams: ["tenant_id"] }),
    );
    const evidenceContract = serializeEvidenceActionContract({
      schemaVersion: "v1",
      action: { tool: "srv/t", argsHash: "0".repeat(64) },
      evidence: {
        packId: "1".repeat(64),
        retrievedAt: "2026-08-25T00:00:00.000Z",
        items: [
          {
            evidenceId: "2".repeat(64),
            snapshotHash: "3".repeat(64),
            contentHash: "4".repeat(64),
            version: "v1",
            modifiedAt: "2026-08-25T00:00:00.000Z",
          },
        ],
      },
    });

    const prepared = await w.prepareEvidenceActionContract?.(
      "srv",
      "t",
      {
        query: "hello",
        user_token: "attacker-supplied",
        user_email: "attacker@example.test",
        client_id: "attacker",
        tenant_id: "caller-controlled",
      },
      mkCtx({ ssoToken: "" }),
      evidenceContract,
    );
    expect(prepared?.args).toEqual({ query: "hello" });

    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "" }), {
      preparedEvidenceCallId: prepared?.preparedCallId,
      evidenceContract: prepared?.evidenceContract,
    });
    expect(lastCall?.arguments).toEqual({ query: "hello" });
  });

  test("injects protected params and strips caller-supplied protected keys", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const res = await w.callTool(
      "srv",
      "t",
      { query: "hello", user_token: "attacker-supplied" },
      mkCtx({ userEmail: "a@b.de", clientId: "M1" }),
    );
    expect(res.isError).toBe(false);
    expect(lastCall?.arguments).toEqual({
      query: "hello",
      user_token: "sso-abc",
      user_email: "a@b.de",
      client_id: "M1",
    });
  });

  test("does not retry a tool whose annotations are absent", async () => {
    let attempts = 0;
    behavior.callTool = async () => {
      attempts += 1;
      throw new Error("read ECONNRESET");
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await expect(w.callTool("srv", "t", {}, mkCtx())).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(created).toHaveLength(1);
  });

  test("retries read-only tools and keeps one invocation/idempotency ID", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    const ids: unknown[] = [];
    const idempotencyKeys: unknown[] = [];
    let attempts = 0;
    behavior.callTool = async (req) => {
      attempts += 1;
      ids.push(req._meta?.["aiperator/invocationId"]);
      idempotencyKeys.push(req._meta?.["aiperator/idempotencyKey"]);
      if (attempts < 3) throw new Error("temporary transport error");
      return { content: "ok" };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await w.callTool("srv", "t", {}, mkCtx(), { invocationId: "inv-stable" });
    expect(attempts).toBe(3);
    expect(ids).toEqual(["inv-stable", "inv-stable", "inv-stable"]);
    expect(idempotencyKeys).toEqual(["inv-stable", "inv-stable", "inv-stable"]);
  });

  test("shares the three-call budget with connection reconnects and keeps the invocation ID stable", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    const ids: unknown[] = [];
    let attempts = 0;
    behavior.callTool = async (req) => {
      attempts += 1;
      ids.push(req._meta?.["aiperator/invocationId"]);
      throw new Error("read ECONNRESET");
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    await expect(w.callTool("srv", "t", {}, mkCtx())).rejects.toThrow(/failed after 3 attempts/);
    expect(attempts).toBe(3);
    expect(ids[0]).toBeString();
    expect(new Set(ids).size).toBe(1);
    expect(created).toHaveLength(3);
  });

  test("recovers from an expired session within the same three-call budget", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { idempotentHint: true } }],
    });
    const ids: unknown[] = [];
    let attempts = 0;
    behavior.callTool = async (req) => {
      attempts += 1;
      ids.push(req._meta?.["aiperator/invocationId"]);
      if (attempts === 1) throw new Error("404 MCP session expired");
      return { content: "recovered" };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const result = await w.callTool("srv", "t", {}, mkCtx(), {
      invocationId: "session-invocation",
    });
    expect(result.content).toBe("recovered");
    expect(attempts).toBe(2);
    expect(ids).toEqual(["session-invocation", "session-invocation"]);
    expect(created).toHaveLength(2);
  });

  test("reconnects a timed-out half-closed session before the next attempt", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    let attempts = 0;
    behavior.close = async () => await new Promise<void>(() => {});
    behavior.callTool = async (_req, options) => {
      attempts += 1;
      if (attempts === 1) {
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("stale transport aborted")),
            { once: true },
          );
        });
      }
      return { content: "recovered-after-timeout" };
    };
    const w = mkWrapper({ retryTimeoutMs: 10 });
    await w.connect(mkConfig({ name: "srv" }));

    const result = await w.callTool("srv", "t", {}, mkCtx(), {
      invocationId: "timeout-recovery",
    });

    expect(result.content).toBe("recovered-after-timeout");
    expect(attempts).toBe(2);
    expect(created).toHaveLength(2);
  });

  test("deduplicates concurrent recovery for the same failed client", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    let attempts = 0;
    behavior.callTool = async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("read ECONNRESET");
      return { content: "recovered-concurrently" };
    };
    const w = mkWrapper({ retryTimeoutMs: 50 });
    await w.connect(mkConfig({ name: "srv" }));

    const results = await Promise.all([
      w.callTool("srv", "t", { call: 1 }, mkCtx()),
      w.callTool("srv", "t", { call: 2 }, mkCtx()),
    ]);

    expect(results.map((result) => result.content)).toEqual([
      "recovered-concurrently",
      "recovered-concurrently",
    ]);
    expect(created).toHaveLength(2);
  });

  test("preserves annotations on filtered cached tool schemas", async () => {
    const annotations = { readOnlyHint: true, openWorldHint: false };
    behavior.listTools = async () => ({
      tools: [
        {
          ...defaultTool("t"),
          annotations,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              user_token: { type: "string" },
            },
            required: ["query", "user_token"],
          },
        },
      ],
    });
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    const first = await w.getFilteredToolSchema("srv", "t");
    const second = await w.getFilteredToolSchema("srv", "t");
    expect(first.annotations).toEqual(annotations);
    expect(second.annotations).toEqual(annotations);
    expect(first.inputSchema.properties).toEqual({ query: { type: "string" } });
    expect(first.inputSchema.required).toEqual(["query"]);
  });

  test("normalizes caller-supplied string args to Unicode NFC", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv" }));
    // NFD input: "Qualita" + combining diaeresis (U+0308) + "tsmanagement".
    const nfdPath = "/Akte/Unterlagen Qualita\u0308tsmanagement";
    const nested = { list: ["Bu\u0308ro", { ref: nfdPath }] };
    await w.callTool("srv", "t", { path_prefix: nfdPath, nested }, mkCtx());
    const args = lastCall?.arguments ?? {};
    // Forwarded value must be the precomposed NFC form (U+00E4 for "ä").
    const fwdPrefix = args.path_prefix as string;
    expect(fwdPrefix).toBe("/Akte/Unterlagen Qualitätsmanagement");
    expect(fwdPrefix.normalize("NFC")).toBe(fwdPrefix);
    const fwdNested = args.nested as {
      list: [string, { ref: string }];
    };
    expect(fwdNested.list[0]).toBe("Büro".normalize("NFC"));
    expect(fwdNested.list[1].ref).toBe("/Akte/Unterlagen Qualitätsmanagement".normalize("NFC"));
  });

  test("only injects configured params the tool actually declares", async () => {
    behavior.listTools = async () => ({
      tools: [
        {
          name: "t",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              tenant: { type: "string" },
            },
          },
        },
      ],
    });
    const w = mkWrapper();
    await w.connect(
      mkConfig({
        name: "srv",
        injectedParams: { tenant: "{{ctx.clientId}}", ghost: "nope" },
      }),
    );
    await w.callTool("srv", "t", { query: "x" }, mkCtx({ clientId: "M9" }));
    const args = lastCall?.arguments ?? {};
    expect(args.tenant).toBe("M9");
    expect("ghost" in args).toBe(false);
  });

  test("forwardAuthToken uses a per-caller session and does not inject user_token", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    const connectCount = created.length;

    await w.callTool("srv", "t", { query: "hi" }, mkCtx({ ssoToken: "tokenA" }));
    // A new per-caller client is created for this caller's token.
    expect(created.length).toBe(connectCount + 1);
    expect(created[created.length - 1]?.lastTransport).toBeInstanceOf(
      StreamableHTTPClientTransport,
    );
    // user_token must NOT be injected as an argument for forwardAuth servers.
    expect("user_token" in (lastCall?.arguments ?? {})).toBe(false);
  });

  test("reuses the per-caller session for the same token", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    const base = created.length;
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" }));
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" }));
    // Only one extra client despite two calls with the same token.
    expect(created.length).toBe(base + 1);
  });

  test("single-flights parallel cold starts for the same caller token", async () => {
    let releaseConnect!: () => void;
    let connectStarted!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const started = new Promise<void>((resolve) => {
      connectStarted = resolve;
    });
    behavior.connect = async () => {
      connectStarted();
      await connectGate;
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));

    const calls = [
      w.callTool("srv", "t", { call: 1 }, mkCtx({ ssoToken: "tokenA" })),
      w.callTool("srv", "t", { call: 2 }, mkCtx({ ssoToken: "tokenA" })),
    ];
    await started;
    expect(created).toHaveLength(1);
    releaseConnect();
    await Promise.all(calls);
    expect(created).toHaveLength(1);
  });

  test("clears a failed cold-start flight so a later call can retry", async () => {
    let rejectConnect!: (error: Error) => void;
    let connectStarted!: () => void;
    const closed: FakeClient[] = [];
    behavior.close = async (client) => {
      if (client !== undefined) closed.push(client);
    };
    const failedConnect = new Promise<void>((_resolve, reject) => {
      rejectConnect = reject;
    });
    const started = new Promise<void>((resolve) => {
      connectStarted = resolve;
    });
    let fail = true;
    behavior.connect = async () => {
      if (!fail) return;
      connectStarted();
      await failedConnect;
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));

    const first = w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" }));
    const second = w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" }));
    await started;
    expect(created).toHaveLength(1);
    rejectConnect(new Error("connect failed"));
    const failures = await Promise.allSettled([first, second]);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    expect(closed).toEqual([created[0]]);

    fail = false;
    await expect(
      w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" })),
    ).resolves.toMatchObject({ content: expect.anything() });
    expect(created).toHaveLength(2);
  });

  test("stores token pool entries under hashes instead of raw bearer tokens", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "raw-secret-token" }));

    const pool = (
      w as unknown as {
        tokenClients: Map<string, Map<string, unknown>>;
      }
    ).tokenClients.get("srv");
    const keys = [...(pool?.keys() ?? [])];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys).not.toContain("raw-secret-token");
    expect(created[0]?.authorization()).toBe("Bearer raw-secret-token");
  });

  test("defers token-client eviction until an active call releases its lease", async () => {
    let releaseActive!: () => void;
    let activeStarted!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const started = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const closed: FakeClient[] = [];
    behavior.callTool = async (req, _options, client) => {
      if (client?.authorization() === "Bearer tokenA") {
        activeStarted();
        await activeGate;
      }
      return { content: req.arguments };
    };
    behavior.close = async (client) => {
      if (client !== undefined) closed.push(client);
    };
    const w = mkWrapper({ maxTokenClientsPerServer: 1 });
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));

    const active = w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" }));
    await started;
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenB" }));
    expect(closed).toEqual([]);

    releaseActive();
    await active;
    expect(closed).toHaveLength(1);
    expect(closed[0]?.authorization()).toBe("Bearer tokenA");
  });

  test("reconnects the per-caller session after a connection failure for a read-only tool", async () => {
    behavior.listTools = async () => ({
      tools: [{ ...defaultTool("t"), annotations: { readOnlyHint: true } }],
    });
    let n = 0;
    behavior.callTool = async (req) => {
      lastCall = req;
      n += 1;
      if (n === 1) throw new Error("read ECONNRESET");
      return { content: "recovered" };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    const res = await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tokenA" }));
    expect(res.content).toBe("recovered");
  });
});

// ---------------------------------------------------------------------------
// transaction capability discovery
// ---------------------------------------------------------------------------

describe("getTransactionCapabilities", () => {
  test("discovers vectorsearch v1 capabilities without transaction metadata", async () => {
    behavior.listTools = async () => ({
      tools: [defaultTool("transaction_capabilities")],
    });
    behavior.callTool = async (req) => {
      lastCall = req;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schemaVersion: "v1",
              issuer: "vectorsearch",
              audiences: ["vectorsearch"],
              enforcement: "required",
              token: { algorithm: "HS256" },
              features: { idempotency: true, budgets: true },
              maxTokenTtlSeconds: 60,
            }),
          },
        ],
      };
    };
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "vectorsearch" }));

    expect(await w.getTransactionCapabilities?.("vectorsearch")).toMatchObject({
      protocol: "v1",
      issuer: "vectorsearch",
      enforcement: "required",
    });
    expect(lastCall).toEqual({ name: "transaction_capabilities", arguments: {} });
    expect(lastCall?._meta).toBeUndefined();
  });

  test("normalizes mcpgate capabilities and caches the result per server", async () => {
    let capabilityCalls = 0;
    behavior.listTools = async () => ({
      tools: [defaultTool("mcpgate_transaction_capabilities")],
    });
    behavior.callTool = async (req) => {
      lastCall = req;
      capabilityCalls += 1;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              version: "v1",
              enforcement: "optional",
              signingAlgorithms: ["HS256"],
              idempotency: { replayCommittedResults: true },
              budgets: ["maxToolCalls"],
            }),
          },
        ],
      };
    };
    const w = mkWrapper({ capabilityTtlMs: 60_000 });
    await w.connect(mkConfig({ name: "mcpgate" }));

    expect(await w.getTransactionCapabilities?.("mcpgate")).toMatchObject({
      protocol: "v1",
      issuer: "mcpgate",
      features: { idempotency: true, budgets: true },
    });
    expect(await w.getTransactionCapabilities?.("mcpgate")).toMatchObject({
      protocol: "v1",
    });
    expect(capabilityCalls).toBe(1);
  });

  test("negative-caches a legacy peer without invoking an unknown tool", async () => {
    let calls = 0;
    behavior.listTools = async () => ({ tools: [defaultTool("legacy_tool")] });
    behavior.callTool = async (req) => {
      calls += 1;
      lastCall = req;
      return { content: [] };
    };
    const w = mkWrapper({ capabilityTtlMs: 60_000 });
    await w.connect(mkConfig({ name: "legacy" }));

    expect(await w.getTransactionCapabilities?.("legacy")).toBeUndefined();
    expect(await w.getTransactionCapabilities?.("legacy")).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("discovers on the caller session for a forwardAuthToken peer", async () => {
    // Production shape: the peer authenticates the MCP transport per caller, so
    // the bootstrap session sees no capability tool while the caller's does.
    behavior.listTools = async (client) => ({
      tools:
        client?.authorization() === "Bearer caller-token"
          ? [defaultTool("transaction_capabilities")]
          : [defaultTool("search")],
    });
    behavior.callTool = async (req) => {
      lastCall = req;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schemaVersion: "v1",
              issuer: "vectorsearch",
              audiences: ["vectorsearch"],
              enforcement: "required",
              token: { algorithm: "HS256" },
            }),
          },
        ],
      };
    };
    const w = mkWrapper({ capabilityTtlMs: 60_000 });
    await w.connect(mkConfig({ name: "vectorsearch", forwardAuthToken: true }));

    // Without the caller token, discovery legitimately finds nothing…
    expect(await w.getTransactionCapabilities?.("vectorsearch")).toBeUndefined();
    // …and that negative result must not poison the caller's own lookup.
    expect(
      await w.getTransactionCapabilities?.("vectorsearch", {
        authToken: "caller-token",
      }),
    ).toMatchObject({ protocol: "v1", enforcement: "required" });
  });

  test("keeps one caller's discovery result out of another caller's cache", async () => {
    behavior.listTools = async (client) => ({
      tools:
        client?.authorization() === "Bearer allowed"
          ? [defaultTool("transaction_capabilities")]
          : [defaultTool("search")],
    });
    behavior.callTool = async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            schemaVersion: "v1",
            signingAlgorithms: ["HS256"],
          }),
        },
      ],
    });
    const w = mkWrapper({ capabilityTtlMs: 60_000 });
    await w.connect(mkConfig({ name: "peer", forwardAuthToken: true }));

    expect(await w.getTransactionCapabilities?.("peer", { authToken: "allowed" })).toMatchObject({
      protocol: "v1",
    });
    expect(await w.getTransactionCapabilities?.("peer", { authToken: "other" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// per-caller session eviction
// ---------------------------------------------------------------------------

describe("token-client eviction", () => {
  test("evicts the least-recently-used session beyond the cap", async () => {
    const w = mkWrapper();
    await w.connect(mkConfig({ name: "srv", forwardAuthToken: true }));
    const base = created.length; // 1 (bootstrap connection)

    // Fill exactly to the cap (500 distinct callers).
    for (let i = 0; i < 500; i++) {
      await w.callTool("srv", "t", {}, mkCtx({ ssoToken: `tok-${i}` }));
    }
    expect(created.length).toBe(base + 500);

    // The 501st distinct caller triggers eviction of the oldest (tok-0).
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tok-500" }));
    const afterOverflow = created.length;
    expect(afterOverflow).toBe(base + 501);

    // A still-cached caller reuses its session (no new client).
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tok-500" }));
    expect(created.length).toBe(afterOverflow);

    // The evicted caller must be rebuilt (a fresh client is created).
    await w.callTool("srv", "t", {}, mkCtx({ ssoToken: "tok-0" }));
    expect(created.length).toBe(afterOverflow + 1);
  });
});

describe("Stateless2026Client result _meta (content-trust label)", () => {
  test("a complete result carries the server's _meta through to the caller", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const result =
        body.method === "server/discover"
          ? {}
          : {
              resultType: "complete",
              content: [{ type: "text", text: "rows" }],
              _meta: { "io.atf/content-trust": { content_trust: "untrusted", source: "database" } },
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new Stateless2026Client(
        mkConfig({ name: "native", profile: "2026-07-28", forwardAuthToken: true }),
        "bearer",
        globalThis.fetch,
      );
      await client.connect();
      const result = await client.callTool({ name: "orders", arguments: {} });
      expect(result._meta).toEqual({
        "io.atf/content-trust": { content_trust: "untrusted", source: "database" },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
describe("Stateless2026Client approvals", () => {
  test("resolves approval and repeats the exact call with only the approval token added", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> =
      [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({
        method: body.method,
        params: body.params,
        headers: new Headers(init?.headers),
      });
      const result =
        body.method === "server/discover"
          ? {}
          : body.method === "tools/call" &&
              requests.filter((r) => r.method === "tools/call").length === 1
            ? {
                resultType: "input_required",
                inputRequests: [
                  {
                    type: "approval",
                    requestState: "state-7",
                    title: "Confirm",
                    message: "Review",
                    fields: [{ name: "amount", label: "Betrag", value: 10 }],
                  },
                ],
              }
            : body.method === "io.modelcontextprotocol/approvals/resolve"
              ? { approvalToken: "token-1" }
              : { resultType: "complete", content: [{ type: "text", text: "ok" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      // Req 7.2: the client's transport is injectable — pass the stub
      // installed above instead of relying on globalThis.fetch.
      const client = new Stateless2026Client(
        mkConfig({
          name: "native",
          profile: "2026-07-28",
          forwardAuthToken: true,
        }),
        "same-bearer",
        globalThis.fetch,
      );
      await client.connect();
      const input = {
        name: "pay",
        arguments: { amount: 10, label: "é" },
        _meta: { "transaction/invocationId": "inv-1", custom: "stable" },
      };
      const first = await client.callTool(input);
      expect(first.resultType).toBe("input_required");
      const final = await client.resolveApproval(input, "state-7", {
        decision: "approved",
        approver: "alice",
      });
      expect(final?.resultType).toBe("complete");
      const calls = requests.filter((r) => r.method === "tools/call");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.arguments).toEqual(calls[0]?.params.arguments);
      expect(calls[1]?.params._meta).toEqual({
        ...(calls[0]?.params._meta as Record<string, unknown>),
        "io.modelcontextprotocol/approvalToken": "token-1",
      });
      const resolve = requests.find(
        (r) => r.method === "io.modelcontextprotocol/approvals/resolve",
      );
      expect(resolve?.params).toMatchObject({
        requestState: "state-7",
        decision: "approved",
        approver: "alice",
      });
      expect(resolve?.headers.get("authorization")).toBe("Bearer same-bearer");
      expect(resolve?.headers.get("mcp-request-state")).toBe("state-7");
      expect(resolve?.headers.get("mcp-name")).toBeNull();
      expect(calls[1]?.headers.get("authorization")).toBe("Bearer same-bearer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not retry tools/call when approval is denied", async () => {
    let toolCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "tools/call") toolCalls++;
      const result =
        body.method === "server/discover"
          ? {}
          : body.method === "tools/call"
            ? { resultType: "input_required", inputRequests: [] }
            : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new Stateless2026Client(
        mkConfig({ name: "native", profile: "2026-07-28" }),
        undefined,
        globalThis.fetch,
      );
      await client.connect();
      const input = { name: "pay", arguments: { amount: 10 } };
      await client.callTool(input);
      expect(await client.resolveApproval(input, "opaque", { decision: "denied" })).toBeUndefined();
      expect(toolCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Stateless2026Client resource and task APIs", () => {
  test("discovers and lists cacheable tools, resources, templates, and prompts", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      headers: Headers;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({
        method: body.method,
        params: body.params,
        headers: new Headers(init?.headers),
      });
      const result =
        {
          "server/discover": { instructions: "Use the documented API." },
          "tools/list": {
            tools: [
              {
                name: "search",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
            nextCursor: "tools-next",
            ttlMs: 500,
            cacheScope: "private",
          },
          "resources/list": {
            resources: [{ uri: "docs://guide", name: "Guide" }],
            nextCursor: "resources-next",
            ttlMs: 100,
            cacheScope: "public",
          },
          "resources/templates/list": {
            resourceTemplates: [{ uriTemplate: "docs://{slug}", name: "Document" }],
          },
          "prompts/list": {
            prompts: [{ name: "summarize", description: "Summarizes input" }],
            nextCursor: "prompts-next",
          },
        }[body.method] ?? {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new Stateless2026Client(
        mkConfig({
          name: "native",
          profile: "2026-07-28",
          forwardAuthToken: true,
        }),
        "caller-token",
        globalThis.fetch,
      );
      await client.connect();
      expect(client.getInstructions()).toBe("Use the documented API.");
      expect(await client.listTools({ cursor: "tools-start" })).toEqual({
        tools: [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        nextCursor: "tools-next",
        ttlMs: 500,
        cacheScope: "private",
      });
      expect(await client.listResources({ cursor: "resources-start" })).toEqual({
        resources: [{ uri: "docs://guide", name: "Guide" }],
        nextCursor: "resources-next",
        ttlMs: 100,
        cacheScope: "public",
      });
      expect(await client.listResourceTemplates()).toEqual({
        resourceTemplates: [{ uriTemplate: "docs://{slug}", name: "Document" }],
      });
      expect(await client.listPrompts()).toEqual({
        prompts: [{ name: "summarize", description: "Summarizes input" }],
        nextCursor: "prompts-next",
      });
      expect(requests.find((request) => request.method === "tools/list")).toMatchObject({
        params: { cursor: "tools-start" },
      });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer caller-token");
      expect(requests[0]?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads resources and prompts and preserves request metadata headers", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> =
      [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({
        method: body.method,
        params: body.params,
        headers: new Headers(init?.headers),
      });
      const result =
        body.method === "resources/read"
          ? { contents: [{ uri: "docs://guide", text: "Hello" }], ttlMs: 250 }
          : { description: "Prompt description", messages: [{ role: "user", content: "Hello" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new Stateless2026Client(
        mkConfig({ name: "native", profile: "2026-07-28" }),
        undefined,
        globalThis.fetch,
      );
      expect(await client.readResource("docs://guide")).toEqual({
        contents: [{ uri: "docs://guide", text: "Hello" }],
        ttlMs: 250,
      });
      expect(await client.getPrompt("summarize", { language: "de" })).toEqual({
        description: "Prompt description",
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(requests[0]).toMatchObject({
        method: "resources/read",
        params: { uri: "docs://guide" },
      });
      expect(requests[0]?.headers.get("mcp-name")).toBe("docs://guide");
      expect(requests[1]).toMatchObject({
        method: "prompts/get",
        params: { name: "summarize", arguments: { language: "de" } },
      });
      expect(requests[1]?.headers.get("mcp-name")).toBe("summarize");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses task operations and polls a task tool call to completion", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let taskReads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method: body.method, params: body.params });
      let result: Record<string, unknown>;
      switch (body.method) {
        case "io.modelcontextprotocol/tasks/get":
          taskReads++;
          result =
            taskReads === 1
              ? { task: { state: "working", statusMessage: "Running" } }
              : taskReads === 2
                ? {
                    task: {
                      taskId: "task-1",
                      state: "completed",
                      result: { content: [{ type: "text", text: "done" }] },
                    },
                  }
                : { task: { taskId: "task-1", state: "completed" } };
          break;
        case "io.modelcontextprotocol/tasks/update":
          result = { task: { state: "working", statusMessage: "Updated" } };
          break;
        case "io.modelcontextprotocol/tasks/cancel":
          result = { task: { taskId: "task-1", state: "cancelled" } };
          break;
        default:
          result = { resultType: "task", task: { taskId: "task-1", state: "working" } };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new Stateless2026Client(
        mkConfig({
          name: "native",
          profile: "2026-07-28",
          taskPollingIntervalMs: 0,
          taskPollingMaxAttempts: 3,
        }),
        undefined,
        globalThis.fetch,
      );
      expect(await client.getTask("task-1")).toEqual({
        task: { taskId: "task-1", state: "working", statusMessage: "Running" },
      });
      expect(await client.updateTask("task-1", { answer: "yes" })).toEqual({
        task: { taskId: "task-1", state: "working", statusMessage: "Updated" },
      });
      expect(await client.cancelTask("task-1")).toEqual({
        task: { taskId: "task-1", state: "cancelled" },
      });
      expect(await client.callTool({ name: "long-running" })).toEqual({
        content: [{ type: "text", text: "done" }],
        resultType: "complete",
      });
      expect(
        requests.filter((request) => request.method === "io.modelcontextprotocol/tasks/get"),
      ).toHaveLength(2);
      expect(
        requests.find((request) => request.method === "io.modelcontextprotocol/tasks/update"),
      ).toMatchObject({
        params: { taskId: "task-1", input: { answer: "yes" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
