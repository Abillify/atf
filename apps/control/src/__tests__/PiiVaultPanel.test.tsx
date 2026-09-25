// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { PiiVaultPanel } from "../components/PiiVaultPanel";

const auth = vi.hoisted(() => ({
  current: {
    token: "test-token" as string | undefined,
    ready: true,
    isAuthenticated: true,
  },
}));

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => auth.current,
}));

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("PiiVaultPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    auth.current = { token: "test-token", ready: true, isAuthenticated: true };
  });

  test("loads without a token when operator auth is open (AUTHN_MODE=disabled)", async () => {
    auth.current = { token: undefined, ready: true, isAuthenticated: true };
    mockFetchOnce({ enabled: false, durable: false, piiTypes: "all" });
    render(<PiiVaultPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Disabled\./)).toBeInTheDocument(),
    );
  });

  test("shows loading state initially", () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;
    render(<PiiVaultPanel />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("shows the disabled state when the vault is off", async () => {
    mockFetchOnce({ enabled: false, durable: false, piiTypes: "all" });
    render(<PiiVaultPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Disabled\./)).toBeInTheDocument(),
    );
    expect(screen.getByText("PII_VAULT_ENABLED=true")).toBeInTheDocument();
  });

  test("shows active + durable status with explicit types", async () => {
    mockFetchOnce({ enabled: true, durable: true, piiTypes: ["email", "phone"] });
    render(<PiiVaultPanel />);
    await waitFor(() => expect(screen.getByText("✓ Active")).toBeInTheDocument());
    expect(screen.getByText("durable, encrypted")).toBeInTheDocument();
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("phone")).toBeInTheDocument();
  });

  test("shows the in-memory warning when active but not durable", async () => {
    mockFetchOnce({ enabled: true, durable: false, piiTypes: "all" });
    render(<PiiVaultPanel />);
    await waitFor(() => expect(screen.getByText("✓ Active")).toBeInTheDocument());
    expect(screen.getByText("in-memory, per-replica")).toBeInTheDocument();
    expect(screen.getByText(/per-replica and/)).toBeInTheDocument();
    expect(screen.getByText("all types")).toBeInTheDocument();
  });

  test("shows an error message on fetch failure", async () => {
    mockFetchOnce({}, false);
    render(<PiiVaultPanel />);
    await waitFor(() => expect(screen.getByText("HTTP 500")).toBeInTheDocument());
  });
});
