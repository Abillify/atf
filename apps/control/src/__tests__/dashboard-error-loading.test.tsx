// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Component tests for the dashboard-level error boundary and loading skeleton.
 *
 * Req. 12.1 — Render error shows the error view.
 * Req. 12.2 — Loading state shows the skeleton.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

import DashboardError from "../app/(dashboard)/error";
import DashboardLoading from "../app/(dashboard)/loading";

// ---------------------------------------------------------------------------
// DashboardError (Req. 12.1)
// ---------------------------------------------------------------------------

describe("DashboardError — error boundary view", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("renders the error heading", () => {
    const error = new Error("Test render failure");
    render(<DashboardError error={error} reset={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /something went wrong/i }),
    ).toBeDefined();
  });

  test("does not expose the internal error message", () => {
    const error = new Error("Database password leaked in stack");
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.queryByText(error.message)).toBeNull();
    expect(screen.getByText(/unexpected error occurred/i)).toBeDefined();
  });

  test("renders a fallback message when error.message is empty", () => {
    const error = new Error("");
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.getByText(/unexpected error occurred/i)).toBeDefined();
  });

  test("shows the error digest when present", () => {
    const error = Object.assign(new Error("oops"), { digest: "abc123" });
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.getByText(/abc123/)).toBeDefined();
  });

  test("shows request and error correlation IDs independently", () => {
    const error = Object.assign(new Error("oops"), {
      digest: "abc123",
      requestId: "req-456",
    });
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.getByText("Error ID: abc123")).toBeDefined();
    expect(screen.getByText("Request ID: req-456")).toBeDefined();
  });

  test("does not show digest section when digest is absent", () => {
    const error = new Error("no digest");
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.queryByText(/Error ID:/)).toBeNull();
  });

  test("calls reset when 'Try again' button is clicked", () => {
    const reset = vi.fn();
    const error = new Error("click me");
    render(<DashboardError error={error} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("has role=alert for accessibility (Req. 12.1)", () => {
    const error = new Error("a11y check");
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  test("logs the error to console on mount", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("log me");
    render(<DashboardError error={error} reset={() => {}} />);
    expect(consoleSpy).toHaveBeenCalledWith("[DashboardError]", error);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DashboardLoading (Req. 12.2)
// ---------------------------------------------------------------------------

describe("DashboardLoading — loading skeleton", () => {
  test("renders without crashing", () => {
    const { container } = render(<DashboardLoading />);
    expect(container.firstChild).not.toBeNull();
  });

  test("has aria-busy attribute for accessibility (Req. 12.2)", () => {
    render(<DashboardLoading />);
    // The outermost container should signal a busy/loading state
    const busy = document.querySelector("[aria-busy='true']");
    expect(busy).not.toBeNull();
  });

  test("renders skeleton placeholder elements", () => {
    const { container } = render(<DashboardLoading />);
    // At least one animated pulse element should be present
    const pulseEls = container.querySelectorAll(".animate-pulse");
    expect(pulseEls.length).toBeGreaterThan(0);
  });

  test("renders three summary card skeletons", () => {
    const { container } = render(<DashboardLoading />);
    // The card grid contains 3 card wrappers
    const cards = container.querySelectorAll(".grid > div");
    expect(cards.length).toBe(3);
  });

  test("renders multiple content-row skeletons", () => {
    const { container } = render(<DashboardLoading />);
    // The main content area has 5 row skeletons
    const rows = container.querySelectorAll(".space-y-3 > div");
    expect(rows.length).toBe(5);
  });
});
