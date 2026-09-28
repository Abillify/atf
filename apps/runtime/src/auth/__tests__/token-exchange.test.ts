// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Token exchange (RFC 8693) tests.
 *
 * The IdP is replaced by an injected `FetchLike` that records every request and
 * returns a scripted response, so the exact wire shape (grant_type, subject
 * token, audience, actor token, client auth) is asserted without a network or a
 * real Authentik. `now` is injected so cache expiry is deterministic.
 */

import { describe, test, expect } from "bun:test";
import {
  TokenExchanger,
  ActorTokenProvider,
  type FetchLike,
  type TokenExchangeConfig,
} from "../token-exchange.js";

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** Builds a FetchLike that records calls and returns queued JSON responses. */
function scriptedFetch(
  responses: Array<{ ok: boolean; status: number; json?: unknown } | ((req: RecordedRequest) => { ok: boolean; status: number; json?: unknown })>,
): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    const req: RecordedRequest = {
      url,
      headers: init.headers,
      body: new URLSearchParams(init.body),
    };
    calls.push(req);
    const entry = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const resolved = typeof entry === "function" ? entry(req) : entry;
    return {
      ok: resolved.ok,
      status: resolved.status,
      json: async () => resolved.json ?? {},
      text: async () => JSON.stringify(resolved.json ?? {}),
    };
  };
  return { fetch, calls };
}

const baseConfig: TokenExchangeConfig = {
  tokenEndpoint: "https://idp.example/application/o/token/",
  clientId: "atf-runtime",
  clientSecret: "s3cr3t",
  audience: "vectorsearch",
  scope: "openid vectorsearch:read",
};

describe("TokenExchanger — impersonation", () => {
  test("sends the RFC 8693 grant with subject token, audience and scope", async () => {
    const { fetch, calls } = scriptedFetch([
      { ok: true, status: 200, json: { access_token: "exchanged-token", expires_in: 300 } },
    ]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch, now: () => 1_000 });

    const result = await ex.exchange("user-login-token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.token).toBe("exchanged-token");
    expect(result.token.delegated).toBe(false);
    expect(result.token.expiresAt).toBe(1_000 + 300_000);

    expect(calls).toHaveLength(1);
    const body = calls[0]?.body;
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(body.get("subject_token")).toBe("user-login-token");
    expect(body.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(body.get("audience")).toBe("vectorsearch");
    expect(body.get("scope")).toBe("openid vectorsearch:read");
    // Impersonation: no actor.
    expect(body.get("actor_token")).toBeNull();
    // Default client auth is client_secret_post.
    expect(body.get("client_id")).toBe("atf-runtime");
    expect(body.get("client_secret")).toBe("s3cr3t");
    // resource must never be sent (Authentik rejects it with invalid_target).
    expect(body.get("resource")).toBeNull();
  });

  test("uses client_secret_basic when configured", async () => {
    const { fetch, calls } = scriptedFetch([
      { ok: true, status: 200, json: { access_token: "t", expires_in: 300 } },
    ]);
    const ex = new TokenExchanger(
      { ...baseConfig, clientAuth: "client_secret_basic" },
      { fetchImpl: fetch },
    );
    await ex.exchange("subject");
    const req = calls[0];
    expect(req?.headers.Authorization).toBe(`Basic ${Buffer.from("atf-runtime:s3cr3t").toString("base64")}`);
    expect(req?.body.get("client_secret")).toBeNull();
  });

  test("caches by subject and coalesces concurrent misses", async () => {
    let mints = 0;
    const fetch: FetchLike = async () => {
      mints += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `t${mints}`, expires_in: 300 }),
        text: async () => "",
      };
    };
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch, now: () => 1_000 });

    const [a, b] = await Promise.all([ex.exchange("same-subject"), ex.exchange("same-subject")]);
    expect(mints).toBe(1);
    expect(a.ok && b.ok && a.token.token === b.token.token).toBe(true);

    // A third call after resolution still hits the cache.
    const c = await ex.exchange("same-subject");
    expect(mints).toBe(1);
    expect(c.ok && c.token.token === "t1").toBe(true);
  });

  test("re-mints once the cached token is inside the expiry margin", async () => {
    let clock = 1_000;
    const { fetch, calls } = scriptedFetch([
      { ok: true, status: 200, json: { access_token: "first", expires_in: 100 } },
      { ok: true, status: 200, json: { access_token: "second", expires_in: 100 } },
    ]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch, now: () => clock });

    const first = await ex.exchange("subject");
    expect(first.ok && first.token.token === "first").toBe(true);

    // Advance past (ttl - margin): 100s ttl, 60s margin → stale after 40s.
    clock += 45_000;
    const second = await ex.exchange("subject");
    expect(second.ok && second.token.token === "second").toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("different subjects do not share a cache entry", async () => {
    const { fetch, calls } = scriptedFetch([
      { ok: true, status: 200, json: { access_token: "a", expires_in: 300 } },
      { ok: true, status: 200, json: { access_token: "b", expires_in: 300 } },
    ]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch, now: () => 1_000 });
    await ex.exchange("subject-a");
    await ex.exchange("subject-b");
    expect(calls).toHaveLength(2);
  });
});

describe("TokenExchanger — fail-closed", () => {
  test("a 4xx grant rejection is terminal, never a fallback to the subject token", async () => {
    const { fetch } = scriptedFetch([{ ok: false, status: 400, json: { error: "invalid_target" } }]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch });
    const result = await ex.exchange("subject");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(false);
    expect(result.detail).toContain("invalid_target");
    // The subject token must never leak into the failure detail.
    expect(result.detail).not.toContain("subject");
  });

  test("a 5xx is transient", async () => {
    const { fetch } = scriptedFetch([{ ok: false, status: 503 }]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch });
    const result = await ex.exchange("subject");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(true);
  });

  test("an empty subject token is rejected without a request", async () => {
    const { fetch, calls } = scriptedFetch([{ ok: true, status: 200 }]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch });
    const result = await ex.exchange("");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a missing access_token in a 200 response is a terminal failure", async () => {
    const { fetch } = scriptedFetch([{ ok: true, status: 200, json: { token_type: "Bearer" } }]);
    const ex = new TokenExchanger(baseConfig, { fetchImpl: fetch });
    const result = await ex.exchange("subject");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(false);
  });
});

describe("TokenExchanger — delegation (act)", () => {
  const delegatingConfig: TokenExchangeConfig = {
    ...baseConfig,
    actor: {
      grant: "client_credentials",
      clientId: "atf-actor",
      clientSecret: "actor-secret",
    },
  };

  test("mints an actor token then sends actor_token on the exchange", async () => {
    const { fetch, calls } = scriptedFetch([
      // First call: actor client_credentials.
      { ok: true, status: 200, json: { access_token: "actor-token", expires_in: 3600 } },
      // Second call: the exchange itself.
      { ok: true, status: 200, json: { access_token: "delegated-token", expires_in: 300 } },
    ]);
    const ex = new TokenExchanger(delegatingConfig, { fetchImpl: fetch, now: () => 1_000 });

    const result = await ex.exchange("user-login-token");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.token).toBe("delegated-token");
    expect(result.token.delegated).toBe(true);

    expect(calls).toHaveLength(2);
    const actorReq = calls[0]?.body;
    expect(actorReq.get("grant_type")).toBe("client_credentials");
    expect(actorReq.get("client_id")).toBe("atf-actor");

    const exchangeReq = calls[1]?.body;
    expect(exchangeReq.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(exchangeReq.get("actor_token")).toBe("actor-token");
    expect(exchangeReq.get("actor_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(exchangeReq.get("subject_token")).toBe("user-login-token");
  });

  test("a failed actor mint fails the exchange closed (no silent impersonation)", async () => {
    const { fetch, calls } = scriptedFetch([{ ok: false, status: 401, json: { error: "unauthorized_client" } }]);
    const ex = new TokenExchanger(delegatingConfig, { fetchImpl: fetch });
    const result = await ex.exchange("subject");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("actor token");
    // No exchange request was attempted after the actor mint failed.
    expect(calls).toHaveLength(1);
  });

  test("the actor token is reused across exchanges", async () => {
    let actorMints = 0;
    const fetch: FetchLike = async (_url, init) => {
      const body = new URLSearchParams(init.body);
      if (body.get("grant_type") === "client_credentials") {
        actorMints += 1;
        return { ok: true, status: 200, json: async () => ({ access_token: "actor", expires_in: 3600 }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: "ex", expires_in: 300 }), text: async () => "" };
    };
    const ex = new TokenExchanger(delegatingConfig, { fetchImpl: fetch, now: () => 1_000 });
    await ex.exchange("subject-1");
    await ex.exchange("subject-2");
    expect(actorMints).toBe(1);
  });
});

describe("ActorTokenProvider", () => {
  test("caches the actor token until the expiry margin", async () => {
    let clock = 0;
    const { fetch, calls } = scriptedFetch([
      { ok: true, status: 200, json: { access_token: "a1", expires_in: 100 } },
      { ok: true, status: 200, json: { access_token: "a2", expires_in: 100 } },
    ]);
    const provider = new ActorTokenProvider(
      { grant: "client_credentials", clientId: "c", clientSecret: "s" },
      "https://idp.example/application/o/token/",
      { fetchImpl: fetch, now: () => clock },
    );
    const first = await provider.token();
    expect(first.ok && first.token.token === "a1").toBe(true);
    // Still fresh well before the margin.
    const cached = await provider.token();
    expect(cached.ok && cached.token.token === "a1").toBe(true);
    expect(calls).toHaveLength(1);
    // Past the margin → re-mint.
    clock += 45_000;
    const refreshed = await provider.token();
    expect(refreshed.ok && refreshed.token.token === "a2").toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("TokenExchanger — construction", () => {
  test("rejects a config without a token endpoint or issuer", () => {
    expect(
      () =>
        new TokenExchanger({
          clientId: "c",
          clientSecret: "s",
          audience: "a",
        }),
    ).toThrow(/tokenEndpoint or issuer/);
  });

  test("resolves the token endpoint from an issuer via the resolver", async () => {
    const { fetch, calls } = scriptedFetch([
      { ok: true, status: 200, json: { access_token: "t", expires_in: 300 } },
    ]);
    const ex = new TokenExchanger(
      { issuer: "https://idp.example", clientId: "c", clientSecret: "s", audience: "a" },
      {
        fetchImpl: fetch,
        endpointResolver: async () => "https://idp.example/application/o/token/",
      },
    );
    await ex.exchange("subject");
    expect(calls[0]?.url).toBe("https://idp.example/application/o/token/");
  });
});
