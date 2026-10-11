// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 24 (retry policy), Property 10 (one-time 401 handling) and
 * Property 11 (request envelope).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildUserAgent,
  ExtractHttpClient,
  MAX_RETRIES,
  OriginGuardError,
  parseRetryAfter,
  ReauthRequiredError,
  retryDecision,
  type RetryOutcome,
} from "../../src/index.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";

// Feature: extract-outpost, Property 24: Retry-Politik
// **Validates: Requirements 8.9, 8.10**
describe("Property 24: retry policy", () => {
  const statusArb = fc.oneof(
    fc.integer({ min: 400, max: 428 }),
    fc.constant(429),
    fc.integer({ min: 430, max: 499 }),
    fc.integer({ min: 500, max: 599 }),
  );
  const outcomeArb: fc.Arbitrary<RetryOutcome> = fc.oneof(
    fc.record({
      kind: fc.constant("http" as const),
      status: statusArb,
      retryAfter: fc.option(
        fc.oneof(
          fc.integer({ min: 0, max: 3600 }).map(String),
          fc
            .integer({ min: 0, max: 3_600_000 })
            .map((ms) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + ms).toUTCString()),
        ),
        { nil: undefined },
      ),
    }),
    fc.constant({ kind: "network" } as const),
  );

  it("retries only 429/5xx/network, at most 5 times", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        outcomeArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (attempt, outcome, r) => {
          const decision = retryDecision(attempt, outcome, 0, () => r);
          const retryable =
            outcome.kind === "network" ||
            (outcome.kind === "http" && (outcome.status === 429 || outcome.status >= 500));
          expect(decision.retry).toBe(retryable && attempt < MAX_RETRIES);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("the backoff ceiling is non-decreasing in the attempt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_RETRIES - 2 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (attempt, r) => {
          const now = Date.UTC(2026, 0, 1);
          const a = retryDecision(attempt, { kind: "network" }, now, () => r);
          const b = retryDecision(attempt + 1, { kind: "network" }, now, () => r);
          expect(a.retry && b.retry).toBe(true);
          if (a.retry && b.retry) expect(b.delayMs).toBeGreaterThanOrEqual(a.delayMs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a valid Retry-After is honoured as a lower bound", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3600 }),
        fc.integer({ min: 0, max: MAX_RETRIES - 1 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (seconds, attempt, r) => {
          const decision = retryDecision(
            attempt,
            { kind: "http", status: 429, retryAfter: String(seconds) },
            0,
            () => r,
          );
          expect(decision.retry).toBe(true);
          if (decision.retry) expect(decision.delayMs).toBeGreaterThanOrEqual(seconds * 1000);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Retry-After as HTTP-date resolves against now", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(30_000);
    const past = new Date(now - 30_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
    expect(parseRetryAfter("42", now)).toBe(42_000);
    expect(parseRetryAfter("gibberish", now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });
});

// Feature: extract-outpost, Property 10: Einmalige 401-Behandlung
// **Validates: Requirements 4.3, 4.4**
describe("Property 10: single 401 handling", () => {
  const responseScriptArb = fc.array(fc.constantFrom(401, 200, 500, 404), {
    minLength: 1,
    maxLength: 6,
  });

  it("at most one refresh and one repeat per logical request", async () => {
    await fc.assert(
      fc.asyncProperty(responseScriptArb, async (script) => {
        const tokens = new FakeTokenProvider();
        let reauth = 0;
        const calls: string[] = [];
        const client = new ExtractHttpClient({
          extractUrl: "https://extract.example.com",
          tokenProvider: tokens,
          version: "0.1.0",
          runtime: "docker",
          onReauthRequired: () => {
            reauth++;
          },
          fetchImpl: (async (_url, init) => {
            calls.push(String(init?.headers ? String((init.headers as Record<string, string>)["authorization"] ?? "") : ""));
            const status = script[calls.length - 1] ?? 200;
            return jsonResponse(status, { ok: status === 200 });
          }) as typeof globalThis.fetch,
        });

        let threw: unknown;
        try {
          await client.request({ url: "/v1/whoami" });
        } catch (error) {
          threw = error;
        }

        // Token refreshes caused by 401: at most one per logical request.
        expect(tokens.forceRefreshCalls).toBeLessThanOrEqual(1);
        // The logical request performs at most 2 network calls.
        expect(calls.length).toBeLessThanOrEqual(2);

        if (script[0] === 401) {
          // Exactly one refresh happened.
          expect(tokens.forceRefreshCalls).toBe(1);
          if (script.length >= 2 && script[1] === 401) {
            // Repeat also 401 → reauth_required, no further attempts.
            expect(threw).toBeInstanceOf(ReauthRequiredError);
            expect(reauth).toBe(1);
            expect(calls.length).toBe(2);
          } else {
            expect(reauth).toBe(0);
            if (script.length >= 2 && script[1] === 200) {
              expect(threw).toBeUndefined();
            }
          }
        } else {
          expect(tokens.forceRefreshCalls).toBe(0);
          expect(reauth).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: extract-outpost, Property 11: request envelope
// **Validates: Requirements 4.1, 14.9, 15.1**
describe("Property 11: request envelope", () => {
  const pathArb = fc.constantFrom("/v1/whoami", "/v2/jobs", "/v2/documents/ref", "/a/b?c=1");

  it("every request carries Bearer, User-Agent and the Extract origin", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 30 }).filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
        pathArb,
        fc.constantFrom("docker" as const, "desktop" as const),
        async (token, path, runtime) => {
          const tokens = new FakeTokenProvider(token);
          const seen: Array<{ url: string; headers: Record<string, string> }> = [];
          const client = new ExtractHttpClient({
            extractUrl: "https://extract.example.com/base",
            tokenProvider: tokens,
            version: "0.1.0",
            runtime,
            fetchImpl: (async (url, init) => {
              seen.push({
                url: String(url),
                headers: (init?.headers ?? {}) as Record<string, string>,
              });
              return jsonResponse(200, {});
            }) as typeof globalThis.fetch,
          });

          await client.request({ url: path });

          expect(seen).toHaveLength(1);
          const req = seen[0];
          if (req === undefined) return;
          expect(new URL(req.url).origin).toBe("https://extract.example.com");
          expect(req.headers["authorization"]).toBe(`Bearer ${token}`);
          expect(req.headers["user-agent"]).toContain("atf-outpost/0.1.0");
          expect(req.headers["user-agent"]).toContain(runtime);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("foreign origins are rejected without any network access", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "https://evil.example.com/v1/whoami",
          "http://extract.example.com/v1",
          "https://extract.example.com.evil.net/x",
          "https://other.example.com:8443/y",
        ),
        async (url) => {
          let networkCalls = 0;
          const client = new ExtractHttpClient({
            extractUrl: "https://extract.example.com",
            tokenProvider: new FakeTokenProvider(),
            version: "0.1.0",
            runtime: "docker",
            fetchImpl: (async () => {
              networkCalls++;
              return jsonResponse(200, {});
            }) as unknown as typeof globalThis.fetch,
          });
          await expect(client.request({ url })).rejects.toBeInstanceOf(OriginGuardError);
          expect(networkCalls).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("the User-Agent contains version, runtime and os/arch", () => {
    const ua = buildUserAgent("1.2.3", "docker");
    expect(ua).toMatch(/^atf-outpost\/1\.2\.3 \(docker; [a-z0-9]+\/[a-z0-9_]+\)$/);
  });
});

function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}
