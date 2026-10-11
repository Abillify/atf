// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: Operations pages — Studio, Approvals, Autopilot, Canary, Tenants.
 *
 * Req 9.10: Control ships end-to-end coverage for its five core operator
 * surfaces. The backend is fully mocked (mock-backend helper) so the specs
 * run without a live Runtime; the wire shapes below mirror the real
 * contracts asserted by integration/system/control-runtime-contract.test.ts.
 */

import { test, expect } from "@playwright/test";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

// ---------------------------------------------------------------------------
// Fixtures — shapes match apps/control/src/types + the Runtime routes.
// ---------------------------------------------------------------------------

const PENDING_APPROVAL = {
  id: "appr-1",
  executionId: "exec-aabbccdd-1234",
  nodeId: "tool-node",
  tool: "send_email",
  args: { to: "customer@example.com", subject: "Hello" },
  requestedAt: new Date().toISOString(),
};

const CANARY_DEPLOYMENTS = {
  deployments: [
    {
      flow: "dispatch",
      candidate: "dispatch-v2",
      trafficPercent: 25,
      rolledBack: false,
      stable: { samples: 100, errors: 2, scoreSum: 82, scoreCount: 100 },
      canary: { samples: 20, errors: 0, scoreSum: 17, scoreCount: 20 },
    },
  ],
};

const AUTOPILOT_RUNS = {
  runs: [
    {
      id: "run-1",
      flowId: "dispatch",
      trigger: "manual",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "done",
      bypassRate: 0.04,
      optimizerRunId: "opt-1",
      canaryRegistered: true,
      promotedVersion: 3,
    },
  ],
};

const AUTOPILOT_CONFIG = {
  requireHumanApproval: true,
  maxAutoPromotionsPerWindow: 2,
  driftWindowMs: 86_400_000,
};

const TENANTS = {
  tenants: [
    {
      id: "t-acme-0001",
      name: "Acme GmbH",
      plan: "pro",
      dailyBudget: 25,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "t-beta-0002",
      name: "Beta AG",
      plan: "free",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

test.describe("Studio", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("loads the builder and offers the mocked flows in the picker", async ({ page }) => {
    await page.goto("/studio");
    await expect(
      page.getByRole("heading", { name: "Studio", exact: true })
    ).toBeVisible();

    // The flow picker is populated from GET /flows (mocked by mockBackend).
    const picker = page.getByRole("button", {
      name: "Select flow to edit in Builder",
    });
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(
      page.getByRole("option", { name: /Dispatch Flow/ })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

test.describe("Approvals", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("shows a pending approval and resolves it with a POST", async ({ page }) => {
    let pending = [PENDING_APPROVAL];
    const resolveRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

    await page.route("**/monitoring/approvals", (route) =>
      route.fulfill({ json: { pending, resolved: [] } })
    );
    await page.route("**/monitoring/approvals/**", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      resolveRequests.push({
        url: route.request().url(),
        body: route.request().postDataJSON() as Record<string, unknown>,
      });
      pending = [];
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto("/approvals");
    await expect(page.getByText("Pending approvals")).toBeVisible();
    await expect(page.getByText("awaiting approval")).toBeVisible();
    await expect(page.getByText("send_email")).toBeVisible();
    await expect(page.getByText("customer@example.com")).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).click();

    // The resolve call must hit the real wire contract:
    // POST /monitoring/approvals/{id} with { approved, by }.
    await expect.poll(() => resolveRequests.length).toBe(1);
    expect(resolveRequests[0]?.url).toContain("/monitoring/approvals/appr-1");
    expect(resolveRequests[0]?.body).toMatchObject({ approved: true });

    // After resolution the queue empties into the EmptyState.
    await expect(
      page.getByText("No tool calls are awaiting approval.")
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

test.describe("Autopilot", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("renders governance badges and run history", async ({ page }) => {
    await page.route("**/autopilot/config", (route) =>
      route.fulfill({ json: { config: AUTOPILOT_CONFIG } })
    );
    await page.route("**/autopilot/runs**", (route) =>
      route.fulfill({ json: AUTOPILOT_RUNS })
    );

    await page.goto("/autopilot");
    await expect(
      page.getByRole("heading", { name: /Continuous Safety & Quality Autopilot/ })
    ).toBeVisible();

    // Governance from GET /autopilot/config.
    await expect(page.getByText("Human approval required")).toBeVisible();
    await expect(page.getByText(/drift-guard: max 2 auto-promotion/)).toBeVisible();

    // Run row from GET /autopilot/runs.
    await expect(page.getByText("dispatch").first()).toBeVisible();
    await expect(page.getByText("→ v3")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh autopilot runs" })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------

test.describe("Canary", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("lists an active canary rollout with traffic share", async ({ page }) => {
    await page.route("**/monitoring/canary", (route) =>
      route.fulfill({ json: CANARY_DEPLOYMENTS })
    );

    await page.goto("/canary");
    await expect(page.getByText(/Canary rollouts/)).toBeVisible();
    await expect(page.getByText("dispatch").first()).toBeVisible();
    await expect(page.getByText("dispatch-v2").first()).toBeVisible();
    await expect(page.getByText("25% canary")).toBeVisible();
    await expect(page.getByText("active").first()).toBeVisible();
  });

  test("shows the setup hint when no canaries exist", async ({ page }) => {
    await page.route("**/monitoring/canary", (route) =>
      route.fulfill({ json: { deployments: [] } })
    );

    await page.goto("/canary");
    await expect(
      page.getByText("No canary deployments configured.")
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

test.describe("Tenants", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
    await page.route("**/admin/tenants", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({ json: TENANTS });
    });
    await page.route("**/admin/tenants/*/keys", (route) =>
      route.fulfill({ json: { keys: [] } })
    );
    await page.route("**/admin/tenants/*/usage/summary", (route) =>
      route.fulfill({
        json: {
          summary: {
            tenantId: "t-acme-0001",
            from: new Date().toISOString(),
            totalRequests: 42,
            totalCost: 1.23,
            totalTokens: 9000,
          },
        },
      })
    );
    await page.route("**/admin/tenants/*/provider-keys", (route) =>
      route.fulfill({ json: { providerKeys: [] } })
    );
  });

  test("lists tenants, filters by search, and expands details", async ({ page }) => {
    await page.goto("/tenants");
    await expect(
      page.getByRole("heading", { name: "Tenant Administration" })
    ).toBeVisible();

    await expect(page.getByText("Acme GmbH")).toBeVisible();
    await expect(page.getByText("Beta AG")).toBeVisible();
    await expect(page.getByText("pro").first()).toBeVisible();

    // Search filter narrows the list client-side.
    await page.getByPlaceholder("Search by name or ID…").fill("Acme");
    await expect(page.getByText("Acme GmbH")).toBeVisible();
    await expect(page.getByText("Beta AG")).toHaveCount(0);

    // Expanding a row opens the detail tabs.
    await page.getByRole("button", { expanded: false }).first().click();
    await expect(page.getByRole("tab", { name: "API Keys" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Usage" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "BYOK Keys" })).toBeVisible();
  });
});
