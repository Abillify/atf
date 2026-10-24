// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * The optional decomposition model client: prompt shape, answer validation,
 * failure degradation and the tenant-bound cache. The chat-completions server
 * is a fetch stub; nothing here talks to a network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDecomposeClient } from "../src/decompose-client.js";

const logger = pino({ level: "silent" });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (body: unknown) => { status?: number; json: unknown }) {
  const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ body, headers });
    const res = handler(body);
    return new Response(JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const completion = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 40, completion_tokens: 10 },
});

function client(overrides: Parameters<typeof createDecomposeClient>[0] = {}) {
  return createDecomposeClient({
    url: "https://models.example.test/v1/chat/completions",
    model: "test-decomposer",
    logger,
    ...overrides,
  });
}

describe("createDecomposeClient", () => {
  it("asks with the fixed system prompt and the question as the user message", async () => {
    const calls = stubFetch(() => ({ json: completion('["Pflichtfelder Maske M-2", "Rechte Benutzer"]') }));
    const parts = await client().decompose(
      "Welche Pflichtfelder hat die Maske M-2 und welche Rechte braucht der Benutzer dafür?",
      4,
    );
    expect(parts).toEqual(["Pflichtfelder Maske M-2", "Rechte Benutzer"]);
    const messages = calls[0]?.body["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toBe(
      "Split the user's question into at most 4 short, self-contained search queries that together cover it. " +
        "Keep the user's language and identifiers verbatim. Answer with a JSON array of strings only.",
    );
    expect(messages[1]?.role).toBe("user");
    expect(calls[0]?.body["model"]).toBe("test-decomposer");
    expect(calls[0]?.body["max_tokens"]).toBe(200);
  });

  it("sends the bearer token when configured", async () => {
    const calls = stubFetch(() => ({ json: completion('["ein Teil hier"]') }));
    await client({ token: "sekret" }).decompose("Eine Frage hier?", 4);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer sekret");
  });

  it("caps the parts at maxSubqueries and removes duplicates", async () => {
    stubFetch(() => ({
      json: completion('["erste Teile", "zweite Teile", "erste Teile", "dritte Teile"]'),
    }));
    const parts = await client({ cacheTtlMs: 0 }).decompose("Eine lange Frage?", 2);
    expect(parts).toEqual(["erste Teile", "zweite Teile"]);
  });

  it("rejects an answer that is not an array of usable strings", async () => {
    for (const content of [
      "das ist kein JSON",
      '{"parts": ["a"]}',
      "[]",
      '["zu"]',
      '["ok Teil", 7]',
      `[${JSON.stringify("x".repeat(201))}]`,
    ]) {
      stubFetch(() => ({ json: completion(content) }));
      const parts = await client({ cacheTtlMs: 0 }).decompose("Eine Frage?", 4);
      expect(parts, content).toBeUndefined();
    }
  });

  it("degrades to undefined on an HTTP error, invalid JSON or an unreachable server", async () => {
    stubFetch(() => ({ status: 503, json: { error: "overloaded" } }));
    expect(await client({ cacheTtlMs: 0 }).decompose("Eine Frage?", 4)).toBeUndefined();

    globalThis.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await client({ cacheTtlMs: 0 }).decompose("Eine Frage?", 4)).toBeUndefined();

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await client({ cacheTtlMs: 0 }).decompose("Eine Frage?", 4)).toBeUndefined();
  });

  it("gives up after the timeout", async () => {
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    const parts = await client({ timeoutMs: 20, cacheTtlMs: 0 }).decompose("Eine Frage?", 4);
    expect(parts).toBeUndefined();
  });

  it("caches per tenant: a second identical call is free, another tenant pays", async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => {
      count += 1;
      return new Response(JSON.stringify(completion('["gleiche Teile"]')), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const c = client({ cacheTtlMs: 60_000 });
    expect(await c.decompose("Eine Frage?", 4, "tenant-a")).toEqual(["gleiche Teile"]);
    expect(await c.decompose("Eine Frage?", 4, "tenant-a")).toEqual(["gleiche Teile"]);
    expect(count).toBe(1);
    expect(await c.decompose("Eine Frage?", 4, "tenant-b")).toEqual(["gleiche Teile"]);
    expect(count).toBe(2);
    // A different sub-query limit is a different answer, even for one tenant.
    expect(await c.decompose("Eine Frage?", 3, "tenant-a")).toEqual(["gleiche Teile"]);
    expect(count).toBe(3);
  });

  it("does not cache unusable answers", async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => {
      count += 1;
      const content = count === 1 ? "kein json" : '["jetzt korrekt"]';
      return new Response(JSON.stringify(completion(content)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const c = client({ cacheTtlMs: 60_000 });
    expect(await c.decompose("Eine Frage?", 4, "tenant-a")).toBeUndefined();
    expect(await c.decompose("Eine Frage?", 4, "tenant-a")).toEqual(["jetzt korrekt"]);
    expect(count).toBe(2);
  });
});
