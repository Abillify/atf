// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * HyDE expansion cache (P1-S4): the expansion is one LLM round-trip in front
 * of every embedding. An identical query within the TTL is answered from
 * memory (no second call, no second cost), concurrent identical queries share
 * one call, failures are never cached, and the cache is bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createHydeClient } from "../src/hyde-client.js";

const logger = pino({ level: "silent" });
const realFetch = globalThis.fetch;

let calls = 0;
let failNext = false;
let delayMs = 0;

beforeEach(() => {
  calls = 0;
  failNext = false;
  delayMs = 0;
  vi.useRealTimers();
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const query = body.messages.at(-1)?.content ?? "";
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (failNext) {
      failNext = false;
      return new Response("nope", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `Antwort auf ${query}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

function client(extra: { cacheTtlMs?: number; cacheMaxEntries?: number } = {}) {
  return createHydeClient({
    url: "http://hyde.test/v1/chat/completions",
    model: "m",
    logger,
    ...extra,
  });
}

describe("createHydeClient · expansion cache", () => {
  it("answers an identical query from memory within the TTL", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    const first = await hyde.expand("Wie hoch ist die Miete?");
    const second = await hyde.expand("Wie hoch ist die Miete?");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.result).toBe(first.result);
    expect(calls).toBe(1);
  });

  it("a cache hit carries no usage (no second cost)", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    const first = await hyde.expand("q1");
    const hit = await hyde.expand("q1");
    expect(first.ok && first.usage).toBeTruthy();
    expect(hit.ok && hit.usage).toBeFalsy();
  });

  it("does not mix up different queries", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    const a = await hyde.expand("alpha");
    const b = await hyde.expand("beta");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.result).toContain("alpha");
      expect(b.result).toContain("beta");
    }
    expect(calls).toBe(2);
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const hyde = client({ cacheTtlMs: 1000 });
    await hyde.expand("q");
    vi.setSystemTime(Date.now() + 1500);
    await hyde.expand("q");
    expect(calls).toBe(2);
  });

  it("never caches a failure", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    failNext = true;
    const failed = await hyde.expand("q");
    expect(failed.ok).toBe(false);
    const ok = await hyde.expand("q");
    expect(ok.ok).toBe(true);
    const callsAfterRecovery = calls;
    await hyde.expand("q");
    expect(calls).toBe(callsAfterRecovery); // the success IS cached
  });

  it("concurrent identical queries share one call", async () => {
    delayMs = 30;
    const hyde = client({ cacheTtlMs: 60_000 });
    const [a, b, c] = await Promise.all([
      hyde.expand("same"),
      hyde.expand("same"),
      hyde.expand("same"),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("is bounded: the oldest entry is evicted first", async () => {
    const hyde = client({ cacheTtlMs: 60_000, cacheMaxEntries: 2 });
    await hyde.expand("a");
    await hyde.expand("b");
    await hyde.expand("c"); // evicts "a"
    expect(calls).toBe(3);
    await hyde.expand("b");
    await hyde.expand("c");
    expect(calls).toBe(3); // b and c still cached
    await hyde.expand("a");
    expect(calls).toBe(4); // a was evicted
  });

  it("without a TTL the client never caches (previous behaviour)", async () => {
    const hyde = client();
    await hyde.expand("q");
    await hyde.expand("q");
    expect(calls).toBe(2);
  });

  it("same tenant and identical query: one upstream call", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    const first = await hyde.expand("Wie hoch ist die Miete?", "tenant-a");
    const second = await hyde.expand("Wie hoch ist die Miete?", "tenant-a");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.result).toBe(first.result);
    expect(calls).toBe(1);
  });

  it("different tenants asking the same query: two upstream calls", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    await hyde.expand("Wie hoch ist die Miete?", "tenant-a");
    await hyde.expand("Wie hoch ist die Miete?", "tenant-b");
    expect(calls).toBe(2);
  });

  it("without a scope key caching stays effective", async () => {
    const hyde = client({ cacheTtlMs: 60_000 });
    await hyde.expand("Wie hoch ist die Miete?");
    await hyde.expand("Wie hoch ist die Miete?");
    expect(calls).toBe(1);
  });
});
