// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 7 (auth priority), Property 8 (PKCE/state integrity) and
 * Property 9 (proactive token renewal).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import {
  AuthManager,
  codeChallenge,
  generateCodeVerifier,
  generateState,
  loopbackRedirectUri,
  needsRefresh,
  REFRESH_WINDOW_MS,
  selectAuthMethod,
  statesMatch,
  waitForAuthCode,
  type AuthEvent,
  type LoopbackListener,
  type LoopbackRedirect,
} from "../../src/index.js";
import { MemoryCredentialStore } from "../../src/index.js";
import { FakeIdP } from "../fakes/fake-idp.js";
import { testLogger } from "../fakes/test-logger.js";

// Feature: extract-outpost, Property 7: priority of the auth methods
// **Validates: Requirements 2.1, 2.5, 2.6, 2.7, 2.9, 3.6**
describe("Property 7: auth method priority", () => {
  it("api-token > client-credentials > interactive (device/pkce)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("device" as const, "pkce" as const),
        async (apiToken, clientCredentials, interactive) => {
          const method = selectAuthMethod({ apiToken, clientCredentials, interactive });
          if (apiToken) {
            expect(method).toBe("api-token");
          } else if (clientCredentials) {
            expect(method).toBe("client-credentials");
          } else {
            expect(method).toBe(interactive === "device" ? "device-code" : "pkce");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("api-token mode never calls an IdP endpoint and reports auth.failed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        async (token, refreshRounds) => {
          const idp = new FakeIdP();
          const events: AuthEvent[] = [];
          const manager = new AuthManager({
            method: "api-token",
            oidc: { issuer: "https://idp.example.com", clientId: "outpost" },
            store: new MemoryCredentialStore(),
            logger: testLogger(),
            fetchImpl: idp.fetchImpl,
            readApiToken: async () => token,
            onEvent: (e) => events.push(e),
          });

          for (const _ of refreshRounds) {
            if (token === null) {
              await expect(manager.forceRefresh()).rejects.toThrow();
            } else {
              expect(await manager.getAccessToken(0)).toBe(token);
            }
          }

          // No Client-Credentials / Device-Code / PKCE endpoint is ever hit.
          expect(idp.requests).toHaveLength(0);
          if (token === null) {
            // Every failure reports auth.failed with method api-token (2.9).
            expect(events.every((e) => e.type === "failed" && e.method === "api-token")).toBe(
              true,
            );
            expect(events.length).toBe(refreshRounds.length);
          } else {
            expect(events).toHaveLength(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: extract-outpost, Property 8: PKCE and state integrity
// **Validates: Requirements 3.1, 3.2, 3.3**
describe("Property 8: PKCE and state integrity", () => {
  const RFC7636 = /^[A-Za-z0-9\-._~]+$/;

  it("verifier is 43–128 RFC-7636 chars; challenge is base64url(sha256)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 43, max: 128 }), { nil: 43 }),
        async (length) => {
          const verifier = generateCodeVerifier(length ?? 43);
          expect(verifier.length).toBe(length ?? 43);
          expect(verifier).toMatch(RFC7636);
          const expected = createHash("sha256")
            .update(verifier, "ascii")
            .digest("base64url")
            .replace(/=+$/, "");
          expect(codeChallenge(verifier)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("redirect URI host is always 127.0.0.1", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 65535 }), async (port) => {
        const url = new URL(loopbackRedirectUri(port));
        expect(url.hostname).toBe("127.0.0.1");
        expect(url.protocol).toBe("http:");
      }),
      { numRuns: 100 },
    );
  });

  it("a token exchange runs exactly when the sent and received state match", async () => {
    const stateArb = fc.constantFrom(generateState(), generateState(), "attacker-state", "");
    await fc.assert(
      fc.asyncProperty(stateArb, stateArb, async (sent, received) => {
        const listener: LoopbackListener = {
          start: async () => 1234,
          waitForRedirect: async (): Promise<LoopbackRedirect> => ({
            state: received.length === 0 ? null : received,
            code: "auth-code",
            error: null,
          }),
          stop: async () => {},
        };
        const result = await waitForAuthCode(listener, sent);
        if (sent === received && received.length > 0) {
          expect(result).toEqual({ kind: "code", code: "auth-code" });
        } else {
          expect(result.kind).toBe("error");
          // A missing or foreign state always discards the code (3.3).
          if (result.kind === "error") expect(result.reason).toBe("state-mismatch");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("statesMatch agrees with equality and is length-independent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), async (a, b) => {
        expect(statesMatch(a, b)).toBe(a === b);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: extract-outpost, Property 9: Proaktive Token-Erneuerung
// **Validates: Requirements 4.2**
describe("Property 9: proactive token renewal", () => {
  it("needsRefresh is exactly exp - now <= 60s", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: -200_000, max: 200_000 }),
        async (base, delta) => {
          const exp = base;
          const now = base - delta; // delta = exp - now
          expect(needsRefresh(exp, now)).toBe(delta <= REFRESH_WINDOW_MS);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("the provider requests a new token exactly when exp - now <= 60s", async () => {
    const T0 = 1_700_000_000_000; // fixed epoch ms
    const EXPIRES_IN_SEC = 300;
    const exp = T0 + EXPIRES_IN_SEC * 1000;

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -120, max: 480 }).map((s) => s * 1000), async (offset) => {
        const now = exp - offset; // offset = exp - now
        const idp = new FakeIdP({
          tokenResponder: () => ({
            status: 200,
            body: {
              access_token: "access",
              token_type: "Bearer",
              expires_in: EXPIRES_IN_SEC,
              refresh_token: "refresh",
            },
          }),
        });
        const store = new MemoryCredentialStore();
        await store.set("auth:extract:refresh-token", "refresh");
        const manager = new AuthManager({
          method: "device-code",
          oidc: { issuer: "https://idp.example.com", clientId: "outpost" },
          store,
          logger: testLogger(),
          fetchImpl: idp.fetchImpl,
          now: () => T0, // expiry always lands at `exp`
        });

        // Prime the cache with a token expiring at `exp`.
        await manager.getAccessToken(T0);
        const before = idp.tokenRequests().length;

        await manager.getAccessToken(now);
        const after = idp.tokenRequests().length;

        const refreshed = after > before;
        expect(refreshed).toBe(offset <= REFRESH_WINDOW_MS);
      }),
      { numRuns: 100 },
    );
  });
});
