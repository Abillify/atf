// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React from "react";

import {
  AuthProvider,
  BFF_TOKEN_SENTINEL,
  TOKEN_STORAGE_KEY,
} from "../lib/auth/AuthProvider";
import { useAuth } from "../lib/auth/useAuth";
import { extractRoleFromToken } from "../lib/auth/AuthProvider";
import { CONTROL_SESSION_MODE_GLOBAL } from "../lib/client-session-mode";
import * as oidc from "../lib/oidc";
import * as bffClient from "../lib/bff-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/oidc", () => ({
  consumeSessionFromUrl: vi.fn(() => ({ token: null, error: null })),
  getAuthConfig: vi.fn(async () => ({
    enabled: false,
    autoLogin: false,
    required: true,
  })),
  refreshSession: vi.fn(async () => null),
  decodeTokenExpSeconds: vi.fn(() => null),
}));

vi.mock("../lib/bff-client", () => ({
  bffSessionStatus: vi.fn(async () => null),
  bffExchangeToken: vi.fn(async () => null),
  bffClearSession: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Test consumer component
// ---------------------------------------------------------------------------

function AuthConsumer() {
  const { token, role, isAuthenticated, ready } = useAuth();
  return (
    <div>
      <span data-testid="token">{token ?? "none"}</span>
      <span data-testid="role">{role ?? "none"}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="ready">{String(ready)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractRoleFromToken", () => {
  test("returns a valid role from JWT", () => {
    expect(extractRoleFromToken(makeJwt({ role: "admin" }))).toBe("admin");
    expect(extractRoleFromToken(makeJwt({ role: "operator" }))).toBe(
      "operator",
    );
    expect(extractRoleFromToken(makeJwt({ role: "viewer" }))).toBe("viewer");
  });

  test("returns undefined for unknown role", () => {
    expect(
      extractRoleFromToken(makeJwt({ role: "superuser" })),
    ).toBeUndefined();
  });

  test("returns undefined for missing role claim", () => {
    expect(extractRoleFromToken(makeJwt({ sub: "user1" }))).toBeUndefined();
  });

  test("returns undefined for malformed token", () => {
    expect(extractRoleFromToken("not-a-jwt")).toBeUndefined();
  });
});

describe("AuthProvider", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  test("provides unauthenticated state when no token exists", async () => {
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(screen.getByTestId("role").textContent).toBe("none");
    expect(screen.getByTestId("authenticated").textContent).toBe("false");
  });

  test("hydrates token from sessionStorage", async () => {
    const jwt = makeJwt({ role: "operator", exp: 9999999999 });
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, jwt);

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(screen.getByTestId("token").textContent).toBe(jwt);
    expect(screen.getByTestId("role").textContent).toBe("operator");
    expect(screen.getByTestId("authenticated").textContent).toBe("true");
  });

  test("grants admin when auth is not required, even with a stale token lacking a role claim", async () => {
    vi.mocked(oidc.getAuthConfig).mockResolvedValueOnce({
      enabled: false,
      autoLogin: false,
      required: false,
      issuerHost: null,
    });
    // A leftover token from a previous session without a valid `role` claim
    // must not grey out the UI when authentication is disabled.
    const staleJwt = makeJwt({ sub: "user1", exp: 9999999999 });
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, staleJwt);

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(screen.getByTestId("role").textContent).toBe("admin");
    expect(screen.getByTestId("authenticated").textContent).toBe("true");
  });

  test("consumes session token from URL fragment (OIDC handoff)", async () => {
    const jwt = makeJwt({ role: "admin", exp: 9999999999 });
    vi.mocked(oidc.consumeSessionFromUrl).mockReturnValue({
      token: jwt,
      error: null,
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(screen.getByTestId("token").textContent).toBe(jwt);
    expect(screen.getByTestId("role").textContent).toBe("admin");
  });

  test("persists token to sessionStorage when setToken is called", async () => {
    vi.mocked(oidc.consumeSessionFromUrl).mockReturnValue({
      token: null,
      error: null,
    });

    function SetterConsumer() {
      const { setToken, token } = useAuth();
      return (
        <div>
          <span data-testid="token">{token ?? "none"}</span>
          <button
            type="button"
            onClick={() => setToken(makeJwt({ role: "viewer" }))}
          >
            set
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <SetterConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("token").textContent).toBe("none");
    });

    await act(async () => {
      screen.getByRole("button").click();
    });

    expect(screen.getByTestId("token").textContent).not.toBe("none");
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeTruthy();
  });

  test("clearToken removes the token", async () => {
    vi.mocked(oidc.consumeSessionFromUrl).mockReturnValue({
      token: null,
      error: null,
    });
    const jwt = makeJwt({ role: "operator" });
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, jwt);

    function ClearConsumer() {
      const { clearToken, token } = useAuth();
      return (
        <div>
          <span data-testid="token">{token ?? "none"}</span>
          <button type="button" onClick={clearToken}>
            clear
          </button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <ClearConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("token").textContent).toBe(jwt);
    });

    await act(async () => {
      screen.getByRole("button").click();
    });

    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BFF mode (Req. 8.7): the access token stays on the server, the client
// only works with a placeholder sentinel.
// ---------------------------------------------------------------------------

describe("AuthProvider — BFF-Modus", () => {
  function setModeFlag(value: string | undefined): void {
    if (value === undefined) {
      delete (window as unknown as Record<string, unknown>)[
        CONTROL_SESSION_MODE_GLOBAL
      ];
    } else {
      (window as unknown as Record<string, unknown>)[
        CONTROL_SESSION_MODE_GLOBAL
      ] = value;
    }
  }

  beforeEach(() => {
    window.sessionStorage.clear();
    // NOTE: reset/clear must run BEFORE installing the default mock returns,
    // otherwise a later clear in another suite can wipe these defaults.
    vi.clearAllMocks();
    // mockReturnValue survives clearAllMocks — restore the neutral default so a
    // handoff token from an earlier test cannot leak into this suite.
    vi.mocked(oidc.consumeSessionFromUrl).mockReturnValue({
      token: null,
      error: null,
    });
    setModeFlag("bff");
    vi.mocked(bffClient.bffSessionStatus).mockResolvedValue(null);
    vi.mocked(bffClient.bffExchangeToken).mockResolvedValue(null);
    vi.mocked(bffClient.bffClearSession).mockResolvedValue(undefined);
  });

  afterEach(() => {
    window.sessionStorage.clear();
    setModeFlag(undefined);
  });

  test("authenticated session cookie yields sentinel token and role", async () => {
    vi.mocked(bffClient.bffSessionStatus).mockResolvedValue({
      authenticated: true,
      role: "admin",
      expiresAt: 9_999_999_999,
      config: { enabled: true, required: true, issuerHost: null },
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(screen.getByTestId("token").textContent).toBe(BFF_TOKEN_SENTINEL);
    expect(screen.getByTestId("role").textContent).toBe("admin");
    expect(screen.getByTestId("authenticated").textContent).toBe("true");
    // The browser never holds a real token, not even in sessionStorage.
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  test("OIDC handoff token is exchanged for a cookie, never stored", async () => {
    const jwt = makeJwt({ role: "admin", exp: 9999999999 });
    vi.mocked(oidc.consumeSessionFromUrl).mockReturnValue({
      token: jwt,
      error: null,
    });
    vi.mocked(bffClient.bffSessionStatus).mockResolvedValue({
      authenticated: false,
      role: null,
      expiresAt: null,
      config: { enabled: true, required: true, issuerHost: null },
    });
    vi.mocked(bffClient.bffExchangeToken).mockResolvedValue({
      role: "admin",
      expiresAt: 9_999_999_999,
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(bffClient.bffExchangeToken).toHaveBeenCalledWith(jwt);
    expect(screen.getByTestId("token").textContent).toBe(BFF_TOKEN_SENTINEL);
    expect(screen.getByTestId("role").textContent).toBe("admin");
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  test("missing session cookie stays unauthenticated", async () => {
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(screen.getByTestId("authenticated").textContent).toBe("false");
    // No token-mode probe against the backend auth-config endpoint.
    expect(oidc.getAuthConfig).not.toHaveBeenCalled();
  });

  test("clearToken clears the server-side cookie instead of storage", async () => {
    vi.mocked(bffClient.bffSessionStatus).mockResolvedValue({
      authenticated: true,
      role: "operator",
      expiresAt: null,
      config: { enabled: false, required: true, issuerHost: null },
    });

    function ClearConsumer() {
      const { clearToken, token } = useAuth();
      return (
        <div>
          <span data-testid="token">{token ?? "none"}</span>
          <button type="button" onClick={clearToken}>clear</button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <ClearConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("token").textContent).toBe(BFF_TOKEN_SENTINEL);
    });

    await act(async () => {
      screen.getByRole("button").click();
    });

    expect(bffClient.bffClearSession).toHaveBeenCalled();
    expect(screen.getByTestId("token").textContent).toBe("none");
  });
});

describe("useAuth — outside provider", () => {
  test("throws when used without AuthProvider", () => {
    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    function Orphan() {
      useAuth();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(
      /useAuth must be used within an <AuthProvider>/,
    );
    spy.mockRestore();
  });
});
