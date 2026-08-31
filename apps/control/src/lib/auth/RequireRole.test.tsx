// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RequireRole, hasMinimumRole } from "./RequireRole";
import type { AuthRole } from "./types";

// ---------------------------------------------------------------------------
// Mock useAuth
// ---------------------------------------------------------------------------

let mockRole: AuthRole | undefined = "viewer";

vi.mock("./useAuth", () => ({
  useAuth: () => ({
    token: mockRole ? "fake-token" : undefined,
    role: mockRole,
    isAuthenticated: !!mockRole,
    ready: true,
    setToken: vi.fn(),
    clearToken: vi.fn(),
    renewNow: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// hasMinimumRole unit tests
// ---------------------------------------------------------------------------

describe("hasMinimumRole", () => {
  it("returns false when userRole is undefined", () => {
    expect(hasMinimumRole(undefined, "viewer")).toBe(false);
  });

  it("viewer meets viewer requirement", () => {
    expect(hasMinimumRole("viewer", "viewer")).toBe(true);
  });

  it("viewer does not meet operator requirement", () => {
    expect(hasMinimumRole("viewer", "operator")).toBe(false);
  });

  it("operator meets operator requirement", () => {
    expect(hasMinimumRole("operator", "operator")).toBe(true);
  });

  it("admin meets any requirement", () => {
    expect(hasMinimumRole("admin", "viewer")).toBe(true);
    expect(hasMinimumRole("admin", "operator")).toBe(true);
    expect(hasMinimumRole("admin", "admin")).toBe(true);
  });

  it("operator meets viewer requirement", () => {
    expect(hasMinimumRole("operator", "viewer")).toBe(true);
  });

  it("operator does not meet admin requirement", () => {
    expect(hasMinimumRole("operator", "admin")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RequireRole component tests
// ---------------------------------------------------------------------------

describe("RequireRole", () => {
  beforeEach(() => {
    mockRole = "viewer";
  });

  describe('mode="hide" (default)', () => {
    it("renders children when user has sufficient role", () => {
      mockRole = "operator";
      render(
        <RequireRole role="operator">
          <span>Secret Button</span>
        </RequireRole>,
      );
      expect(screen.getByText("Secret Button")).toBeInTheDocument();
    });

    it("renders nothing when user has insufficient role", () => {
      mockRole = "viewer";
      const { container } = render(
        <RequireRole role="operator">
          <span>Secret Button</span>
        </RequireRole>,
      );
      expect(screen.queryByText("Secret Button")).not.toBeInTheDocument();
      expect(container.innerHTML).toBe("");
    });

    it("renders fallback when user has insufficient role and fallback is provided", () => {
      mockRole = "viewer";
      render(
        <RequireRole role="operator" fallback={<span>No access</span>}>
          <span>Secret Button</span>
        </RequireRole>,
      );
      expect(screen.queryByText("Secret Button")).not.toBeInTheDocument();
      expect(screen.getByText("No access")).toBeInTheDocument();
    });

    it("renders children when user role exceeds required (admin > operator)", () => {
      mockRole = "admin";
      render(
        <RequireRole role="operator">
          <span>Admin Sees This</span>
        </RequireRole>,
      );
      expect(screen.getByText("Admin Sees This")).toBeInTheDocument();
    });
  });

  describe('mode="disable"', () => {
    it("renders children in disabled container when role is insufficient", () => {
      mockRole = "viewer";
      render(
        <RequireRole role="operator" mode="disable">
          <button>Delete</button>
        </RequireRole>,
      );
      const wrapper = screen.getByTestId("require-role-disabled");
      expect(wrapper).toBeInTheDocument();
      expect(wrapper).toHaveAttribute("aria-disabled", "true");
      expect(wrapper).toHaveStyle({ pointerEvents: "none", opacity: "0.5" });
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("renders children normally (no wrapper) when role is sufficient", () => {
      mockRole = "operator";
      render(
        <RequireRole role="operator" mode="disable">
          <button>Delete</button>
        </RequireRole>,
      );
      expect(
        screen.queryByTestId("require-role-disabled"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });

  describe("unauthenticated user (role = undefined)", () => {
    it("hides children when role is undefined", () => {
      mockRole = undefined;
      const { container } = render(
        <RequireRole role="viewer">
          <span>Content</span>
        </RequireRole>,
      );
      expect(screen.queryByText("Content")).not.toBeInTheDocument();
      expect(container.innerHTML).toBe("");
    });

    it("disables children when role is undefined and mode=disable", () => {
      mockRole = undefined;
      render(
        <RequireRole role="viewer" mode="disable">
          <span>Content</span>
        </RequireRole>,
      );
      expect(screen.getByTestId("require-role-disabled")).toBeInTheDocument();
    });
  });
});
