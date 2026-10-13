// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  blob,
  type ControlApiError,
  json,
  request,
  streamSse,
  text,
} from "../lib/control-api";

const encoder = new TextEncoder();

function chunkedResponse(chunks: Array<string | Uint8Array>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("control-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
  });

  test("request resolves only explicit backend targets and preserves merged init", async () => {
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://backend.example";
    const fetchMock = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    const response = await request("/v1/items", {
      target: "backend",
      token: "secret",
      signal,
      headers: { "X-Test": "yes", Authorization: "old" },
    });
    await request("/api/session", { target: "same-origin" });

    expect(response.status).toBe(403);
    const [backendUrl, backendInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(backendUrl).toBe("https://backend.example/v1/items");
    expect(backendInit.signal).toBe(signal);
    expect(new Headers(backendInit.headers).get("X-Test")).toBe("yes");
    expect(new Headers(backendInit.headers).get("Authorization")).toBe(
      "Bearer secret",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/session");
  });

  test("json serializes bodies, handles 204, and extracts safe API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "nested failure" } },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(new Response("plain failure", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      json<{ ok: boolean }>("/api/test", {
        method: "POST",
        jsonBody: { value: 1 },
        headers: { "X-Test": "yes" },
      }),
    ).resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"value":1}');
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    await expect(json("/api/empty")).resolves.toBeUndefined();
    await expect(json("/api/fail")).rejects.toMatchObject({
      name: "ControlApiError",
      status: 422,
      message: "nested failure",
    });
    await expect(text("/api/plain-fail")).rejects.toEqual(
      expect.objectContaining({ message: "plain failure", status: 500 }),
    );
  });

  test("text and blob return successful response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("hello"))
        .mockResolvedValueOnce(new Response("binary")),
    );
    await expect(text("/api/text")).resolves.toBe("hello");
    // Under vitest 5 with jsdom, Response.blob() returns a Blob from a different
    // realm/module than the test's global Blob (see vitest-dev/vitest#6741 and
    // #1703). That breaks `toBeInstanceOf(Blob)`, and the returned object's own
    // methods (arrayBuffer/text) are not consistently present across the jsdom
    // and node runtimes. The stable, realm-independent signal is the internal
    // brand exposed via Object.prototype.toString, so assert on that instead.
    const result = await blob("/api/blob");
    expect(Object.prototype.toString.call(result)).toBe("[object Blob]");
  });

  test("streamSse survives UTF-8 chunk boundaries, CRLF, and multiline data", async () => {
    const utf8 = encoder.encode("data: Grüße\r\ndata: zweite Zeile\r\n\r\ndata: [DONE]\r\n\r\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        chunkedResponse([
          utf8.slice(0, 9),
          utf8.slice(9, 11),
          utf8.slice(11, 23),
          utf8.slice(23),
        ]),
      ),
    );
    const callback = vi.fn();
    const events = [];
    for await (const event of streamSse("/events", { onEvent: callback })) {
      events.push(event);
    }
    expect(events).toEqual([{ data: "Grüße\nzweite Zeile" }]);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test("does not split an event when CRLF is divided across chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        chunkedResponse([
          "data: first\r",
          "\ndata: second\r",
          "\n\r",
          "\ndata: [DONE]\r\n\r\n",
        ]),
      ),
    );

    const events = [];
    for await (const event of streamSse("/events")) events.push(event);
    expect(events).toEqual([{ data: "first\nsecond" }]);
  });

  test("streamSse passes AbortSignal through and propagates abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
      ),
    );
    const controller = new AbortController();
    const stream = streamSse("/events", { signal: controller.signal });
    const pending = stream.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("streamSse raises ControlApiError with extracted response detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ message: "stream unavailable" }, { status: 503 }),
      ),
    );
    const stream = streamSse("/events");
    await expect(stream.next()).rejects.toEqual(
      expect.objectContaining<Partial<ControlApiError>>({
        name: "ControlApiError",
        status: 503,
        message: "stream unavailable",
      }),
    );
  });
});
