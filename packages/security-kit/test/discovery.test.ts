// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Discovery caching contract: single-flight under concurrency, Cache-Control
 * TTL floored at the minimum, and an exponentially growing negative cache so a
 * failing IdP is not hammered.
 */

import { describe, expect, test } from "bun:test";
import {
  createDiscoveryClient,
  DiscoveryError,
  parseMaxAgeMs,
} from "../src/index.js";

const ISSUER = "https://id.example.com/realms/atf";
const DOC = { issuer: ISSUER, jwks_uri: `${ISSUER}/certs` };

function fakeFetch(
  handler: (call: { count: number }) =>
    | { ok: true; body?: unknown; maxAge?: string | null }
    | { ok: false; status: number }
    | { throw: Error },
) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const result = handler({ count: calls });
    if ("throw" in result) throw result.throw;
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        headers: { get: () => null },
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "cache-control" ? (result.maxAge ?? null) : null) },
      json: async () => result.body ?? DOC,
    };
  };
  return { fetchImpl, callCount: () => calls };
}

describe("parseMaxAgeMs", () => {
  test("extracts max-age among directives", () => {
    expect(parseMaxAgeMs("public, max-age=120, private")).toBe(120_000);
    expect(parseMaxAgeMs("no-cache")).toBeUndefined();
    expect(parseMaxAgeMs(null)).toBeUndefined();
    expect(parseMaxAgeMs("max-age=abc")).toBeUndefined();
  });
});

describe("createDiscoveryClient", () => {
  test("discovery URL is the well-known path of the issuer", () => {
    expect(createDiscoveryClient(ISSUER).discoveryUrl).toBe(
      `${ISSUER}/.well-known/openid-configuration`,
    );
    expect(createDiscoveryClient(`${ISSUER}/`).discoveryUrl).toBe(
      `${ISSUER}/.well-known/openid-configuration`,
    );
  });

  test("caches positively for at least the minimum TTL", () => {
    let nowMs = 1_000_000;
    const { fetchImpl, callCount } = fakeFetch(() => ({ ok: true }));
    const client = createDiscoveryClient(ISSUER, {
      fetchImpl,
      now: () => nowMs,
    });
    return (async () => {
      await client.getMetadata();
      nowMs += 4 * 60_000; // still inside the 5-minute floor
      await client.getMetadata();
      expect(callCount()).toBe(1);
      nowMs += 2 * 60_000; // past the floor
      await client.getMetadata();
      expect(callCount()).toBe(2);
    })();
  });

  test("Cache-Control max-age extends the positive TTL beyond the floor", () => {
    let nowMs = 1_000_000;
    const { fetchImpl, callCount } = fakeFetch(() => ({ ok: true, maxAge: "public, max-age=3600" }));
    const client = createDiscoveryClient(ISSUER, { fetchImpl, now: () => nowMs });
    return (async () => {
      await client.getMetadata();
      nowMs += 10 * 60_000; // past the 5-min floor, inside the 60-min max-age
      await client.getMetadata();
      expect(callCount()).toBe(1);
    })();
  });

  test("single-flight: concurrent callers share one request", async () => {
    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const client = createDiscoveryClient(ISSUER, {
      fetchImpl: async () => {
        calls += 1;
        await gate;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => DOC,
        };
      },
    });
    const results = Promise.all([client.getMetadata(), client.getMetadata(), client.getMetadata()]);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the calls start
    expect(calls).toBe(1); // one shared request for three callers
    resolveFirst();
    const documents = await results;
    for (const document of documents) expect(document.issuer).toBe(ISSUER);
  });

  test("negative cache: failure is remembered and backs off exponentially", () => {
    let nowMs = 1_000_000;
    const { fetchImpl, callCount } = fakeFetch(() => ({ ok: false, status: 500 }));
    const client = createDiscoveryClient(ISSUER, { fetchImpl, now: () => nowMs });
    return (async () => {
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      expect(callCount()).toBe(1);
      // Inside the 30 s negative window: no new request, immediate error.
      nowMs += 10_000;
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      expect(callCount()).toBe(1);
      // Window expired (30 s): second attempt, failure count 2 → 60 s window.
      nowMs += 25_000;
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      expect(callCount()).toBe(2);
      nowMs += 61_000; // past the 60 s window opened at t=35 s
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      expect(callCount()).toBe(3);
      // Now the window is 120 s; 100 s later still backed off.
      nowMs += 100_000;
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      expect(callCount()).toBe(3);
    })();
  });

  test("negative TTL is capped at the maximum", () => {
    let nowMs = 1_000_000;
    const { fetchImpl } = fakeFetch(() => ({ ok: false, status: 500 }));
    const client = createDiscoveryClient(ISSUER, { fetchImpl, now: () => nowMs });
    return (async () => {
      // Drive the failure count high enough that 30s * 2^n exceeds 5 min.
      for (let i = 0; i < 8; i++) {
        nowMs += 6 * 60_000;
        await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      }
      // After the last failure the window is capped at 5 min, not 8 * 2^7 * 30s.
      nowMs += 4 * 60_000;
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
    })();
  });

  test("a success resets the back-off", () => {
    let nowMs = 1_000_000;
    let mode: "fail" | "ok" = "fail";
    const { fetchImpl, callCount } = fakeFetch(() =>
      mode === "fail" ? { ok: false, status: 500 } : { ok: true },
    );
    const client = createDiscoveryClient(ISSUER, { fetchImpl, now: () => nowMs });
    return (async () => {
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      nowMs += 31_000;
      mode = "ok";
      await client.getMetadata();
      expect(callCount()).toBe(2);
      // Positive cache now serves; force expiry and confirm no residual back-off.
      nowMs += 6 * 60_000;
      mode = "fail";
      await expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
      nowMs += 31_000;
      mode = "ok";
      await client.getMetadata();
      expect(callCount()).toBe(4);
    })();
  });

  test("rejects a document whose issuer does not match", () => {
    const { fetchImpl } = fakeFetch(() => ({
      ok: true,
      body: { issuer: "https://evil.example.com", jwks_uri: "https://evil.example.com/certs" },
    }));
    const client = createDiscoveryClient(ISSUER, { fetchImpl });
    return expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
  });

  test("rejects a document missing jwks_uri", () => {
    const { fetchImpl } = fakeFetch(() => ({ ok: true, body: { issuer: ISSUER } }));
    const client = createDiscoveryClient(ISSUER, { fetchImpl });
    return expect(client.getMetadata()).rejects.toBeInstanceOf(DiscoveryError);
  });
});
