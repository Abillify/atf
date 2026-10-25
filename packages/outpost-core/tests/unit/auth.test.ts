// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the auth flows: device-flow logging and restart
 * after expiry, the refresh path without a device flow, the 300 s loopback
 * timeout, and logout removing Extract tokens.
 */

import { describe, expect, it } from "vitest";
import {
  AuthManager,
  EXTRACT_AUTH_KEYS,
  EXTRACT_CLIENT_SECRET_KEY,
  EXTRACT_REFRESH_TOKEN_KEY,
  LOOPBACK_TIMEOUT_MS,
  loopbackRedirectUri,
  runDeviceCodeFlow,
  waitForAuthCode,
  type AuthEvent,
  type LoopbackListener,
} from "../../src/index.js";
import { MemoryCredentialStore } from "../../src/index.js";
import { FakeIdP, defaultDeviceCode } from "../fakes/fake-idp.js";
import { parseLines, recordingLogger } from "../fakes/test-logger.js";

/** A clock advanced by the injected sleep, so the device flow is testable. */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  current: () => number;
} {
  let t = 0;
  return {
    now: () => t,
    current: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("Device_Code_Flow", () => {
  it("logs auth.device_code with the verification URL and user code (2.2)", async () => {
    const idp = new FakeIdP();
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const store = new MemoryCredentialStore();

    const result = await runDeviceCodeFlow(
      "https://idp.example.com",
      "outpost",
      [],
      undefined,
      { fetchImpl: idp.fetchImpl, store, logger, sleep: clock.sleep, now: clock.now },
    );

    const events = parseLines(lines);
    const deviceEvent = events.find((e) => e["event"] === "auth.device_code");
    expect(deviceEvent).toBeDefined();
    expect(deviceEvent?.["user_code"]).toBe("USER-0");
    expect(deviceEvent?.["verification_uri"]).toBe("https://idp.example.com/activate");
    expect(deviceEvent?.["verification_uri_complete"]).toContain("USER-0");

    // The refresh token is persisted (2.3).
    expect(result.refreshToken).toBe("refresh-0");
    expect(await store.get(EXTRACT_REFRESH_TOKEN_KEY)).toBe("refresh-0");
  });

  it("requests offline_access scope (4.5)", async () => {
    const idp = new FakeIdP();
    const clock = fakeClock();
    await runDeviceCodeFlow(
      "https://idp.example.com",
      "outpost",
      ["openid"],
      "https://extract.example.com",
      { fetchImpl: idp.fetchImpl, store: new MemoryCredentialStore(), logger: recordingLogger().logger, sleep: clock.sleep, now: clock.now },
    );
    const deviceReq = idp.deviceRequests()[0];
    expect(deviceReq).toBeDefined();
    const scope = deviceReq?.body["scope"] ?? "";
    expect(scope.split(" ")).toContain("offline_access");
    expect(deviceReq?.body["audience"]).toBe("https://extract.example.com");
  });

  it("restarts the flow after the device code expires (2.8)", async () => {
    // Round 0: pending, then expired_token. Round 1: success.
    const idp = new FakeIdP({
      deviceResponses: [defaultDeviceCode(0), defaultDeviceCode(1)],
      tokenResponder: (_params, callIndex) => {
        if (callIndex === 0) return { status: 400, body: { error: "authorization_pending" } };
        if (callIndex === 1) return { status: 400, body: { error: "expired_token" } };
        return {
          status: 200,
          body: { access_token: "a", expires_in: 300, refresh_token: "r-final" },
        };
      },
    });
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const store = new MemoryCredentialStore();

    const result = await runDeviceCodeFlow(
      "https://idp.example.com",
      "outpost",
      [],
      undefined,
      { fetchImpl: idp.fetchImpl, store, logger, sleep: clock.sleep, now: clock.now },
    );

    expect(result.refreshToken).toBe("r-final");
    // Two device authorizations → two auth.device_code log lines (fresh URL).
    const deviceEvents = parseLines(lines).filter((e) => e["event"] === "auth.device_code");
    expect(deviceEvents).toHaveLength(2);
    expect(idp.deviceRequests()).toHaveLength(2);
  });

  it("honours slow_down by increasing the poll interval", async () => {
    const idp = new FakeIdP({
      tokenResponder: (_params, callIndex) => {
        if (callIndex === 0) return { status: 400, body: { error: "slow_down" } };
        return { status: 200, body: { access_token: "a", expires_in: 300, refresh_token: "r" } };
      },
    });
    const clock = fakeClock();
    const sleepTimes: number[] = [];
    await runDeviceCodeFlow("https://idp.example.com", "outpost", [], undefined, {
      fetchImpl: idp.fetchImpl,
      store: new MemoryCredentialStore(),
      logger: recordingLogger().logger,
      sleep: async (ms) => {
        sleepTimes.push(ms);
        await clock.sleep(ms);
      },
      now: clock.now,
    });
    // interval starts at 1 s, slow_down adds 5 s → second poll at 6 s.
    expect(sleepTimes).toEqual([1000, 6000]);
  });
});

describe("AuthManager refresh path", () => {
  it("uses the stored refresh token without a device flow (2.4)", async () => {
    const idp = new FakeIdP();
    const store = new MemoryCredentialStore();
    await store.set(EXTRACT_REFRESH_TOKEN_KEY, "stored-refresh");
    const manager = new AuthManager({
      method: "device-code",
      oidc: { issuer: "https://idp.example.com", clientId: "outpost" },
      store,
      logger: recordingLogger().logger,
      fetchImpl: idp.fetchImpl,
      now: () => 0,
    });

    const token = await manager.getAccessToken(0);
    expect(token).toBe("access-0");
    // Only the token endpoint was hit; the device endpoint was not.
    expect(idp.deviceRequests()).toHaveLength(0);
    expect(idp.tokenRequests()).toHaveLength(1);
    expect(idp.tokenRequests()[0]?.body["grant_type"]).toBe("refresh_token");
    expect(idp.tokenRequests()[0]?.body["refresh_token"]).toBe("stored-refresh");
  });

  it("client-credentials uses the stored client secret (2.5)", async () => {
    const idp = new FakeIdP();
    const store = new MemoryCredentialStore();
    await store.set(EXTRACT_CLIENT_SECRET_KEY, "s3cr3t");
    const manager = new AuthManager({
      method: "client-credentials",
      oidc: { issuer: "https://idp.example.com", clientId: "svc" },
      store,
      logger: recordingLogger().logger,
      fetchImpl: idp.fetchImpl,
      now: () => 0,
    });
    await manager.getAccessToken(0);
    const req = idp.tokenRequests()[0];
    expect(req?.body["grant_type"]).toBe("client_credentials");
    expect(req?.body["client_secret"]).toBe("s3cr3t");
  });

  it("a failed renewal emits reauth_required (4.4)", async () => {
    const idp = new FakeIdP({
      tokenResponder: () => ({ status: 400, body: { error: "invalid_grant" } }),
    });
    const store = new MemoryCredentialStore();
    await store.set(EXTRACT_REFRESH_TOKEN_KEY, "bad");
    const events: AuthEvent[] = [];
    const manager = new AuthManager({
      method: "device-code",
      oidc: { issuer: "https://idp.example.com", clientId: "outpost" },
      store,
      logger: recordingLogger().logger,
      fetchImpl: idp.fetchImpl,
      onEvent: (e) => events.push(e),
    });
    await expect(manager.getAccessToken(0)).rejects.toThrow();
    expect(events).toEqual([
      { type: "reauth_required", method: "device-code", reason: expect.any(String) },
    ]);
  });
});

describe("Loopback timeout (3.7)", () => {
  it("the default timeout is 300 seconds", () => {
    expect(LOOPBACK_TIMEOUT_MS).toBe(300_000);
  });

  it("waitForAuthCode reports a timeout when no redirect arrives", async () => {
    const listener: LoopbackListener = {
      start: async () => 4321,
      waitForRedirect: (timeoutMs) =>
        new Promise((_resolve, reject) => {
          setTimeout(reject, timeoutMs);
        }),
      stop: async () => {},
    };
    const result = await waitForAuthCode(listener, "state", 20);
    expect(result).toEqual({ kind: "error", reason: "timeout" });
  });

  it("the redirect URI uses a dynamic loopback port (3.1)", () => {
    expect(loopbackRedirectUri(0)).toBe("http://127.0.0.1:0/callback");
    expect(loopbackRedirectUri(54321)).toBe("http://127.0.0.1:54321/callback");
  });
});

describe("logout (3.5)", () => {
  it("removes the Extract tokens and keeps source keys", async () => {
    const store = new MemoryCredentialStore();
    for (const key of EXTRACT_AUTH_KEYS) await store.set(key, "value");
    await store.set("source:g:oauth-refresh", "keep-me");
    const manager = new AuthManager({
      method: "device-code",
      oidc: { issuer: "https://idp.example.com", clientId: "outpost" },
      store,
      logger: recordingLogger().logger,
      fetchImpl: new FakeIdP().fetchImpl,
    });
    await manager.logout();
    for (const key of EXTRACT_AUTH_KEYS) expect(await store.get(key)).toBeNull();
    expect(await store.get("source:g:oauth-refresh")).toBe("keep-me");
  });
});
