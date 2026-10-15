// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, afterEach } from "vitest";

import {
  BFF_PROXY_PREFIX,
  authUrl,
  backendBase,
  backendUrl,
} from "./backend-url";
import { CONTROL_SESSION_MODE_GLOBAL } from "./client-session-mode";

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

afterEach(() => {
  setModeFlag(undefined);
  delete process.env["NEXT_PUBLIC_BACKEND_URL"];
});

describe("backendUrl — token mode (default)", () => {
  test("relative paths without a configured backend", () => {
    setModeFlag(undefined);
    expect(backendBase()).toBe("");
    expect(backendUrl("/monitoring/state")).toBe("/monitoring/state");
  });

  test("honours a non-default NEXT_PUBLIC_BACKEND_URL", () => {
    process.env["NEXT_PUBLIC_BACKEND_URL"] = "http://127.0.0.1:4173";
    expect(backendUrl("/flows")).toBe("http://127.0.0.1:4173/flows");
  });

  test("an unrelated window flag value does not enable the proxy", () => {
    setModeFlag("token");
    expect(backendUrl("/flows")).toBe("/flows");
  });
});

describe("backendUrl — BFF mode (Req 8.7)", () => {
  test("rewrites every backend path to the proxy prefix", () => {
    setModeFlag("bff");
    expect(backendBase()).toBe(BFF_PROXY_PREFIX);
    expect(backendUrl("/monitoring/state")).toBe(
      "/api/backend/monitoring/state",
    );
    expect(backendUrl("/flows")).toBe("/api/backend/flows");
  });

  test("the proxy rewrite wins over NEXT_PUBLIC_BACKEND_URL", () => {
    setModeFlag("bff");
    process.env["NEXT_PUBLIC_BACKEND_URL"] = "http://127.0.0.1:4173";
    // The browser must talk to its own origin only — never cross-origin.
    expect(backendUrl("/v1/models")).toBe("/api/backend/v1/models");
  });
});

describe("authUrl — OIDC endpoints bypass the BFF proxy", () => {
  test("stays on the Runtime in BFF mode, where the proxy refuses /monitoring/auth/", () => {
    setModeFlag("bff");
    expect(authUrl("/monitoring/auth/login")).toBe("/monitoring/auth/login");
    process.env["NEXT_PUBLIC_BACKEND_URL"] = "https://runtime.example.test";
    expect(authUrl("/monitoring/auth/logout")).toBe(
      "https://runtime.example.test/monitoring/auth/logout",
    );
  });

  test("matches backendUrl in token mode", () => {
    setModeFlag(undefined);
    expect(authUrl("/monitoring/auth/config")).toBe(
      backendUrl("/monitoring/auth/config"),
    );
  });
});
