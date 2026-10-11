// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST } from "./route";

const URL_ = "https://control.local/api/telemetry";
const JSON_HEADERS = { "Content-Type": "application/json" };

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body,
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  delete process.env["CONTROL_TELEMETRY_URL"];
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe("POST /api/telemetry", () => {
  test("accepts a same-origin event with 204", async () => {
    const res = await POST(
      post(JSON.stringify({ message: "boom" }), {
        Origin: "https://control.local",
        "Sec-Fetch-Site": "same-origin",
      }),
    );
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalled();
  });
  test("rejects a cross-site Sec-Fetch-Site with 403", async () => {
    const res = await POST(
      post(JSON.stringify({ message: "boom" }), { "Sec-Fetch-Site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(errorSpy).not.toHaveBeenCalled();
  });
  test("rejects a foreign Origin with 403", async () => {
    const res = await POST(
      post(JSON.stringify({ message: "boom" }), {
        Origin: "https://attacker.example",
      }),
    );
    expect(res.status).toBe(403);
  });
  test("rejects a non-JSON content type with 415", async () => {
    const res = await POST(
      new Request(URL_, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ message: "boom" }),
      }),
    );
    expect(res.status).toBe(415);
  });
  test("rejects an oversized body with 413", async () => {
    const res = await POST(post(JSON.stringify({ message: "x".repeat(20_000) })));
    expect(res.status).toBe(413);
  });
  test("rejects invalid JSON with 400", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
  });
  test("rejects a missing message with 400", async () => {
    const res = await POST(post(JSON.stringify({ stack: "s" })));
    expect(res.status).toBe(400);
  });
  test("strips control characters before forwarding (keeps newlines in stack)", async () => {
    vi.stubEnv("CONTROL_TELEMETRY_URL", "https://telemetry.example/ingest");
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(
      post(
        JSON.stringify({
          message: "line\r\nforged\u001b[31m",
          stack: "at a\nat b\u0007",
        }),
      ),
    );
    expect(res.status).toBe(204);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const forwarded = JSON.parse(String(init.body)) as {
      message: string;
      stack: string;
    };
    expect(forwarded.message).toBe("lineforged[31m");
    expect(forwarded.stack).toBe("at a\nat b");
  });
});
