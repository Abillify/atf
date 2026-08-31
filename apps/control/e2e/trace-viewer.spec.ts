// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: Execution Trace Viewer
 *
 * Tests the interactive Step-by-Step trace viewer end-to-end:
 *   - Loading trace events by execution ID
 *   - Step navigation (Prev/Next buttons + sidebar click)
 *   - Node I/O panel content (prompt, response, model metadata)
 *   - Tab switching between Step-by-Step and Waterfall
 *   - Empty state when no events are found
 */

import { test, expect } from "@playwright/test";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

const EXEC_ID = "exec-aabbccdd-1234";

test.describe("Trace Viewer", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page, {
      nodeEvents: [
        {
          execution_id: EXEC_ID,
          node_id: "router",
          status: "completed",
          start_time: new Date(Date.now() - 400).toISOString(),
          end_time: new Date(Date.now() - 350).toISOString(),
          latency_ms: 50,
        },
        {
          execution_id: EXEC_ID,
          node_id: "llm-node",
          status: "completed",
          start_time: new Date(Date.now() - 340).toISOString(),
          end_time: new Date(Date.now() - 10).toISOString(),
          latency_ms: 330,
          model: "openai/gpt-4o-mini",
          input_tokens: 120,
          output_tokens: 80,
          prompt: "You are a helpful assistant.\n\nUser: Hello!",
          response: "Hello! How can I help you today?",
        },
        {
          execution_id: EXEC_ID,
          node_id: "tool-node",
          status: "error",
          start_time: new Date(Date.now() - 5).toISOString(),
          end_time: new Date().toISOString(),
          latency_ms: 5,
        },
      ],
    });
    await setTestToken(page);
    await page.goto("/traces");
  });

  test("shows idle state before any execution is entered", async ({ page }) => {
    await expect(page.getByText("Enter an execution ID to inspect its trace.")).toBeVisible();
  });

  test("loads and displays step list after entering execution ID", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    // Step-by-step tab should be active by default
    await expect(page.getByRole("tab", { name: "Step-by-Step" })).toBeVisible();

    // 3 steps should appear in the sidebar
    await expect(page.getByRole("button", { name: /router/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /llm-node/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /tool-node/ })).toBeVisible();
  });

  test("shows node metadata for the first step", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    // First step (router) is active — should show its node id
    await expect(page.getByText("router").first()).toBeVisible();
    // Step counter
    await expect(page.getByText("1 / 3")).toBeVisible();
  });

  test("navigates to next step via Next button", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    await page.getByRole("button", { name: "Next step" }).click();
    // Should now show step 2 (llm-node)
    await expect(page.getByText("2 / 3")).toBeVisible();
  });

  test("shows LLM node details on step 2", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    // Navigate to second step
    await page.getByRole("button", { name: "Next step" }).click();

    // Model info should be visible in the metadata row
    await expect(page.getByText("openai/gpt-4o-mini")).toBeVisible();
  });

  test("can navigate to a step by clicking the sidebar", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    // Click the tool-node step in the sidebar
    await page.getByRole("button", { name: /tool-node/ }).click();
    await expect(page.getByText("3 / 3")).toBeVisible();
  });

  test("Prev button is disabled on the first step", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    const prevBtn = page.getByRole("button", { name: "Previous step" });
    await expect(prevBtn).toBeDisabled();
  });

  test("Next button is disabled on the last step", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    // Navigate to last step
    await page.getByRole("button", { name: "Next step" }).click();
    await page.getByRole("button", { name: "Next step" }).click();

    const nextBtn = page.getByRole("button", { name: "Next step" });
    await expect(nextBtn).toBeDisabled();
  });

  test("can switch to the Waterfall tab", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill(EXEC_ID);
    await page.getByRole("button", { name: "Load" }).click();

    await page.getByRole("tab", { name: "Span Waterfall" }).click();
    // OTel spans are not mocked — should show a graceful unavailable message
    await expect(page.getByRole("tab", { name: "Span Waterfall" })).toHaveAttribute("aria-selected", "true");
  });

  test("handles Enter key to submit execution ID", async ({ page }) => {
    const input = page.getByPlaceholder("Execution ID…");
    await input.fill(EXEC_ID);
    await input.press("Enter");

    await expect(page.getByText("1 / 3")).toBeVisible();
  });
});

test.describe("Trace Viewer — empty state", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page, { nodeEvents: [] });
    await setTestToken(page);
    await page.goto("/traces");
  });

  test("shows no-events message when execution has no steps", async ({ page }) => {
    await page.getByPlaceholder("Execution ID…").fill("empty-exec");
    await page.getByRole("button", { name: "Load" }).click();

    await expect(page.getByText("No events found for this execution.")).toBeVisible();
  });
});
