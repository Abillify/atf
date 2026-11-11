// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: Dashboard Navigation
 *
 * Verifies that the main navigation links render and lead to the correct pages.
 * The backend is fully mocked — no real server required.
 */

import { test, expect } from "@playwright/test";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

test.describe("Dashboard navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("loads the dashboard root and shows the nav bar", async ({ page }) => {
    await page.goto("/graph");
    // Nav bar should contain key links
    await expect(page.getByRole("link", { name: "Live Graph" })).toBeVisible();
    await expect(page.getByRole("link", { name: "History" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Traces" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Security" })).toBeVisible();
  });

  // Review follow-up F1: `/` is the overview, not the graph.
  test("the root redirects to the overview", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/overview$/);
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true }),
    ).toBeVisible();
  });

  test("the overview shows a tile per endpoint and links to its detail page", async ({ page }) => {
    await page.goto("/overview");

    const tiles: Array<{ testId: string; href: string }> = [
      { testId: "tile-readiness", href: "/flows/health" },
      { testId: "tile-approvals", href: "/approvals" },
      { testId: "tile-posture", href: "/posture" },
      { testId: "tile-flow-health", href: "/flows/health" },
      { testId: "tile-providers", href: "/providers" },
      { testId: "tile-mcp", href: "/mcp" },
      { testId: "tile-usage", href: "/cost" },
    ];
    for (const { testId, href } of tiles) {
      const card = page.getByTestId(testId);
      await expect(card).toBeVisible();
      // The tile's own footer link — some tiles also carry data links into the
      // detail page (a flow row, a usage row), which must not confuse the check.
      await expect(card.locator("h2 + a")).toHaveAttribute("href", href);
    }

    // The mock backend serves readiness and the example flows, so those tiles
    // carry data rather than an empty or unavailable state.
    await expect(page.getByText("Ready")).toBeVisible();
    // `example-flow` shows up in the live-flows tile and again in the usage
    // table — both tiles got the mocked payload.
    await expect(page.getByText("example-flow").first()).toBeVisible();
  });

  test("navigates to the Traces page", async ({ page }) => {
    await page.goto("/traces");
    await expect(page.getByRole("heading", { name: /Execution Trace Viewer/i })).toBeVisible();
    await expect(page.getByPlaceholder("Execution ID…")).toBeVisible();
  });

  test("navigates to the History page", async ({ page }) => {
    await page.goto("/history");
    // Some form of heading or table should appear
    const heading = page.getByRole("heading");
    await expect(heading.first()).toBeVisible();
  });

  test("navigates to the Flows page", async ({ page }) => {
    await page.goto("/flows");
    const heading = page.getByRole("heading");
    await expect(heading.first()).toBeVisible();
  });

  test("navigates to the Security page", async ({ page }) => {
    await page.goto("/security");
    const heading = page.getByRole("heading");
    await expect(heading.first()).toBeVisible();
  });
});
