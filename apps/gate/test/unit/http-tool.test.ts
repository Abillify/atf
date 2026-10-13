// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { HttpToolExecutor } from "../../src/tools/http-tool.ts";
import { HttpToolSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import type { DbProvider } from "../../src/db/manager.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "s",
  username: "alice",
  scopes: [],
  claims: { tenant: "acme" },
  headers: {},
  rawToken: "t",
};

const noDb = {} as DbProvider;
const runtime = { db: noDb, bus: new MonitorBus(), outboundFetch: ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch };

interface FetchCall {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function mockFetch(handler: (call: FetchCall) => Response): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function tool(extra: Record<string, unknown>) {
  return HttpToolSchema.parse({ name: "h", type: "http", ...extra });
}

describe("HttpToolExecutor", () => {
  it("interpolates url + headers and returns the JSON body", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, who: "x" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const exec = new HttpToolExecutor(
      tool({
        request: {
          method: "GET",
          url: "https://1.1.1.1/users/:param.id",
          headers: { "X-User": ":ctx.username" },
        },
      }),
      runtime,
    );
    const res = await exec.execute({ id: "42" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(calls[0].url).toBe("https://1.1.1.1/users/42");
    expect((calls[0].init.headers as Record<string, string>)["X-User"]).toBe("alice");
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, who: "x" });
  });

  it("sends a JSON body with type-preserving token substitution", async () => {
    mockFetch(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const exec = new HttpToolExecutor(
      tool({
        request: {
          method: "POST",
          url: "https://1.1.1.1/orders",
          body: { qty: ":param.qty", by: ":ctx.username" },
        },
      }),
      runtime,
    );
    await exec.execute({ qty: 5 }, ctx);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ qty: 5, by: "alice" });
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("applies a jsonPath pipeline step", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: { items: [1, 2, 3] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const exec = new HttpToolExecutor(
      tool({
        request: { method: "GET", url: "https://1.1.1.1/x" },
        pipeline: [{ type: "jsonPath", expression: "$.data.items" }],
      }),
      runtime,
    );
    const res = await exec.execute({}, ctx);
    expect(JSON.parse(res.content[0].text)).toEqual([1, 2, 3]);
  });

  it("applies a field pipeline step with array indexing", async () => {
    mockFetch(() => new Response(JSON.stringify({ rows: [{ id: 7 }, { id: 8 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const exec = new HttpToolExecutor(
      tool({
        request: { method: "GET", url: "https://1.1.1.1/x" },
        pipeline: [{ type: "field", path: "rows[1].id" }],
      }),
      runtime,
    );
    const res = await exec.execute({}, ctx);
    expect(res.content[0].text).toBe("8");
  });

  it("returns isError for a non-2xx response", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    const exec = new HttpToolExecutor(
      tool({ request: { method: "GET", url: "https://1.1.1.1/x" } }),
      runtime,
    );
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("HTTP 500");
  });

  it("reports a network failure as an error result", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const exec = new HttpToolExecutor(
      tool({ request: { method: "GET", url: "https://1.1.1.1/x" } }),
      runtime,
    );
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("ECONNREFUSED");
  });
});
