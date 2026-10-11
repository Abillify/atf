// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, afterEach, vi } from "vitest";

import {
  bffClearSession,
  bffExchangeToken,
  bffSessionStatus,
} from "./bff-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bffSessionStatus", () => {
  test("parses an authenticated status", async () => {
    const fetchFn = vi.fn(
      async () =>
        Response.json({
          mode: "bff",
          authenticated: true,
          role: "operator",
          expiresAt: 123,
          config: { enabled: true, required: false, issuerHost: "id.example" },
        }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    expect(await bffSessionStatus()).toEqual({
      authenticated: true,
      role: "operator",
      expiresAt: 123,
      config: { enabled: true, required: false, issuerHost: "id.example" },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  test("null when the endpoint is absent (token mode)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch,
    );
    expect(await bffSessionStatus()).toBeNull();
  });

  test("null on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("failed");
      }) as unknown as typeof fetch,
    );
    expect(await bffSessionStatus()).toBeNull();
  });

  test("missing required in config stays fail-closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ authenticated: false, config: { enabled: true } }),
      ) as unknown as typeof fetch,
    );
    const status = await bffSessionStatus();
    expect(status?.config).toEqual({
      enabled: true,
      required: true,
      issuerHost: null,
    });
  });
});

describe("bffExchangeToken", () => {
  test("posts the token and returns the sealed claims", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ token: "jwt-token" });
        return Response.json({
          ok: true,
          role: "admin",
          expiresAt: 999,
        });
      },
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    expect(await bffExchangeToken("jwt-token")).toEqual({
      role: "admin",
      expiresAt: 999,
    });
  });

  test("null when the server rejects the exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "session_secret_unconfigured" }, { status: 503 }),
      ) as unknown as typeof fetch,
    );
    expect(await bffExchangeToken("jwt")).toBeNull();
  });

  test("null when ok is not true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false })) as unknown as typeof fetch,
    );
    expect(await bffExchangeToken("jwt")).toBeNull();
  });
});

describe("bffClearSession", () => {
  test("issues a DELETE and never throws", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ ok: true }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    await expect(bffClearSession()).resolves.toBeUndefined();
    const call = (
      fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }
    ).mock.calls[0];
    if (call === undefined) throw new Error("expected the fetch call");
    const init = call[1];
    expect(init.method).toBe("DELETE");
  });

  test("swallows network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("down");
      }) as unknown as typeof fetch,
    );
    await expect(bffClearSession()).resolves.toBeUndefined();
  });
});
