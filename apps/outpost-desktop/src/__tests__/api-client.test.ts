// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";

import { OutpostApi } from "../api-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OutpostApi", () => {
  test("sends the per-launch bearer token on every request", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return jsonResponse(200, { paused: false, sources: [] });
    }) as unknown as typeof fetch;

    const api = new OutpostApi("http://127.0.0.1:45123", "secret-launch-token", fetchImpl);
    await api.status();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:45123/status");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secret-launch-token");
  });

  test("reports error responses as errors with the server reason", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(409, { code: "already_syncing", reason: "source is syncing" }),
    ) as unknown as typeof fetch;

    const api = new OutpostApi("http://127.0.0.1:45123", "token", fetchImpl);
    await expect(api.sync("docs")).rejects.toThrow("already_syncing: source is syncing");
  });

  test("falls back to the status code when the error body is not JSON", async () => {
    const fetchImpl = mock(async () => new Response("gateway timeout", { status: 504 })) as unknown as typeof fetch;

    const api = new OutpostApi("http://127.0.0.1:45123", "token", fetchImpl);
    await expect(api.pause()).rejects.toThrow("HTTP 504");
  });

  test("posts a JSON body with the content type for config updates", async () => {
    let captured: { method?: string; contentType: string | null; body: string | undefined } = {
      contentType: null,
      body: undefined,
    };
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      captured = {
        method: init?.method,
        contentType: new Headers(init?.headers).get("content-type"),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const api = new OutpostApi("http://127.0.0.1:45123", "token", fetchImpl);
    await api.updateConfig({ sources: [] });

    expect(captured.method).toBe("PUT");
    expect(captured.contentType).toBe("application/json");
    expect(captured.body).toBe(JSON.stringify({ sources: [] }));
  });
});
