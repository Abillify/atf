// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

type OidcModule = typeof import("../lib/oidc");

const ORIGIN = "https://dash.example.com";

async function loadModule(): Promise<OidcModule> {
  vi.resetModules();
  return import("../lib/oidc");
}

function jsonResponse(obj: unknown, ok = true): Response {
  return new Response(JSON.stringify(obj), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function setLocation(href: string): { assign: ReturnType<typeof vi.fn> } {
  const url = new URL(href);
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign,
    },
  });
  return { assign };
}

describe("oidc BFF client", () => {
  beforeEach(() => {
    window.history.replaceState = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getAuthConfig", () => {
    test("returns disabled when the backend responds with an error", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({}, false),
      ) as unknown as typeof fetch;
      const { getAuthConfig } = await loadModule();
      const cfg = await getAuthConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.autoLogin).toBe(false);
      expect(cfg.required).toBe(true);
    });

    test("reflects enabled + autoLogin from the backend (memoised)", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ enabled: true, autoLogin: true }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const { getAuthConfig } = await loadModule();
      const cfg = await getAuthConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.autoLogin).toBe(true);
      expect(cfg.required).toBe(true);
      // Second call is served from cache — no extra fetch.
      await getAuthConfig();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("does not memoise a failed probe — a later call retries", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, false))
        .mockResolvedValueOnce(jsonResponse({ enabled: true }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const { getAuthConfig } = await loadModule();
      const first = await getAuthConfig();
      expect(first.enabled).toBe(false);
      const second = await getAuthConfig();
      expect(second.enabled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("resolves to disabled when the probe hangs past its timeout", async () => {
      vi.useFakeTimers();
      try {
        // A request that never settles unless the abort signal fires —
        // simulating a hung localhost connection (proxy/extension interception).
        globalThis.fetch = vi.fn(
          (_input: unknown, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ) as unknown as typeof fetch;
        const { getAuthConfig } = await loadModule();
        const pending = getAuthConfig();
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_500);
        const cfg = await pending;
        expect(cfg).toEqual({
          enabled: false,
          autoLogin: false,
          required: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("beginLogin", () => {
    test("navigates to the backend login with the current page as redirect", async () => {
      const { assign } = setLocation(`${ORIGIN}/dashboard?tab=graph`);
      const { beginLogin } = await loadModule();
      beginLogin();
      expect(assign).toHaveBeenCalledTimes(1);
      const target = assign.mock.calls[0][0] as string;
      expect(target).toContain("/monitoring/auth/login?redirect=");
      expect(target).toContain(
        encodeURIComponent(`${ORIGIN}/dashboard?tab=graph`),
      );
    });
  });

  describe("consumeSessionFromUrl", () => {
    test("extracts the session token and strips the fragment", async () => {
      const replace = vi.fn();
      window.history.replaceState = replace;
      setLocation(`${ORIGIN}/#session=abc.def.ghi`);
      const { consumeSessionFromUrl } = await loadModule();
      const { token, error } = consumeSessionFromUrl();
      expect(token).toBe("abc.def.ghi");
      expect(error).toBeNull();
      expect(replace).toHaveBeenCalledTimes(1);
    });

    test("extracts an auth error", async () => {
      window.history.replaceState = vi.fn();
      setLocation(`${ORIGIN}/#auth_error=forbidden`);
      const { consumeSessionFromUrl } = await loadModule();
      const { token, error } = consumeSessionFromUrl();
      expect(token).toBeNull();
      expect(error).toBe("forbidden");
    });

    test("returns nulls when there is no relevant fragment", async () => {
      setLocation(`${ORIGIN}/`);
      const { consumeSessionFromUrl } = await loadModule();
      const { token, error } = consumeSessionFromUrl();
      expect(token).toBeNull();
      expect(error).toBeNull();
    });
  });

  describe("logout", () => {
    test("redirects to the IdP end-session URL when provided", async () => {
      const { assign } = setLocation(`${ORIGIN}/`);
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ endSessionUrl: "https://idp.example.com/logout?x=1" }),
      ) as unknown as typeof fetch;
      const { logout } = await loadModule();
      const redirected = await logout();
      expect(redirected).toBe(true);
      expect(assign).toHaveBeenCalledWith("https://idp.example.com/logout?x=1");
    });

    test("resolves false when there is no end-session URL", async () => {
      setLocation(`${ORIGIN}/`);
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ endSessionUrl: null }),
      ) as unknown as typeof fetch;
      const { logout } = await loadModule();
      expect(await logout()).toBe(false);
    });
  });
});
