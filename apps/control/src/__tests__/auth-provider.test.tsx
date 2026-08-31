// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React from "react";

import { AuthProvider, TOKEN_STORAGE_KEY } from "../lib/auth/AuthProvider";
import { useAuth } from "../lib/auth/useAuth";
import { extractRoleFromToken } from "../lib/auth/AuthProvider";
import * as oidc from "../lib/oidc";

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
          <button onClick={() => setToken(makeJwt({ role: "viewer" }))}>
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
          <button onClick={clearToken}>clear</button>
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
