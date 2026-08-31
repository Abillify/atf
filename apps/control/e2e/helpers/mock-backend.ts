// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E test helper: Mock Backend
 *
 * Intercepts all backend API calls via Playwright's network route API so
 * tests run fully offline without a real backend. Each helper function
 * registers sensible default responses that keep the dashboard functional.
 */

import type { Page } from "@playwright/test";

// Minimal operator JWT (format-only, not cryptographically valid)
export const TEST_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJ0ZXN0LW9wZXJhdG9yIiwiZW1haWwiOiJvcEBleGFtcGxlLmNvbSIsInJvbGUiOiJhZG1pbiIsImV4cCI6OTk5OTk5OTk5OX0." +
  "fakesignature";

export interface MockOptions {
  flows?: Array<{ id: string; name: string }>;
  history?: Array<{
    execution_id: string;
    flow_id: string;
    status: string;
    node_count: number;
    total_latency_ms: number;
    started_at: string;
  }>;
  nodeEvents?: Array<{
    execution_id: string;
    node_id: string;
    status: string;
    start_time: string;
    end_time: string | null;
    latency_ms: number | null;
    prompt?: string;
    response?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
  }>;
}

export async function mockBackend(page: Page, opts: MockOptions = {}): Promise<void> {
  const flows = opts.flows ?? [
    { id: "example-flow", name: "Example Flow" },
    { id: "dispatch", name: "Dispatch Flow" },
  ];

  const history = opts.history ?? [
    {
      execution_id: "exec-aabbccdd-1234",
      flow_id: "example-flow",
      status: "ok",
      node_count: 3,
      total_latency_ms: 450,
      started_at: new Date().toISOString(),
    },
  ];

  const nodeEvents = opts.nodeEvents ?? [
    {
      execution_id: "exec-aabbccdd-1234",
      node_id: "router",
      status: "completed",
      start_time: new Date(Date.now() - 400).toISOString(),
      end_time: new Date(Date.now() - 350).toISOString(),
      latency_ms: 50,
      model: undefined,
    },
    {
      execution_id: "exec-aabbccdd-1234",
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
  ];

  // Auth config
  await page.route("**/monitoring/auth/config", (route) =>
    route.fulfill({ json: { oidcEnabled: false } })
  );

  // Models / flows list
  await page.route("**/v1/models", (route) =>
    route.fulfill({
      json: {
        object: "list",
        data: flows.map((f) => ({
          id: f.id,
          object: "model",
          created: 1714000000,
          owned_by: "atf",
        })),
      },
    })
  );

  // Flows list.
  // NOTE: the backend flows API resolves to the same origin as the app in
  // CI/prod (relative paths), so this glob also matches the Next.js page
  // navigation to "/flows". Let document (navigation) requests through to the
  // real server so the page HTML loads; only mock the XHR/fetch API call.
  await page.route("**/flows", (route) => {
    if (route.request().resourceType() === "document") {
      return route.continue();
    }
    return route.fulfill({
      json: {
        flows: flows.map((f) => ({
          id: f.id,
          name: f.name,
          source: "file",
          nodeCount: 3,
          edgeCount: 2,
        })),
      },
    });
  });

  // Execution history
  await page.route("**/monitoring/history", (route) =>
    route.fulfill({ json: { executions: history } })
  );

  // Node events for a specific execution
  await page.route("**/monitoring/history/**", (route) => {
    route.fulfill({ json: { events: nodeEvents } });
  });

  // Monitoring events (SSE — return empty stream)
  await page.route("**/monitoring/events**", (route) => {
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: ": heartbeat\n\n",
    });
  });

  // Health
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" } })
  );
  await page.route("**/health/ready", (route) =>
    route.fulfill({
      json: {
        status: "ready",
        checks: { database: { status: "unconfigured" }, redis: { status: "unconfigured" }, flows: { status: "ok" } },
      },
    })
  );

  // Metrics
  await page.route("**/metrics", (route) =>
    route.fulfill({ status: 200, body: "# no metrics in test\n" })
  );

  // Monitoring ticket (for SSE auth)
  await page.route("**/monitoring/ticket", (route) =>
    route.fulfill({ json: { ticket: "test-ticket", expires_in: 60, token_type: "ticket" } })
  );

  // Monitoring auth config
  await page.route("**/monitoring/auth/info", (route) =>
    route.fulfill({ json: { role: "admin" } })
  );
}

/**
 * sessionStorage key the AuthProvider reads the session token from.
 * Must stay in sync with `TOKEN_STORAGE_KEY` in
 * `src/lib/auth/AuthProvider.tsx`.
 */
export const TOKEN_STORAGE_KEY = "aiperator_monitoring_token";

/**
 * Sets the operator token in sessionStorage so the AuthProvider
 * treats the test session as authenticated.
 */
export async function setTestToken(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, token }) => {
      sessionStorage.setItem(key, token);
    },
    { key: TOKEN_STORAGE_KEY, token: TEST_TOKEN },
  );
}
