// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Review follow-up F1 — the operator overview.
 *
 * Three things matter here and each has its own test:
 *
 * 1. the tiles render from mocked runtime payloads and link to the right detail
 *    page (the overview is only useful if a tile is a door, not a dead end);
 * 2. an empty deployment renders the explained empty states rather than blanks;
 * 3. a tile whose endpoint answers 403 / 404 / 503 degrades to an `EmptyState`
 *    and never takes the rest of the page down with it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import OverviewPage from "../app/(dashboard)/overview/page";
import { LocaleProvider } from "../lib/i18n";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true, isAuthenticated: true }),
}));

const READY = {
  status: "ready",
  checks: {
    database: { status: "ok" },
    redis: { status: "ok" },
    flows: { status: "ok" },
  },
};

const APPROVALS = {
  pending: [
    {
      id: "ap-1",
      executionId: "e-1",
      nodeId: "n-1",
      tool: "demo/case_lookup",
      args: {},
      requestedAt: new Date().toISOString(),
    },
    {
      id: "ap-2",
      executionId: "e-2",
      nodeId: "n-2",
      tool: "demo/send_email",
      args: {},
      requestedAt: new Date().toISOString(),
    },
  ],
  resolved: [],
};

const FLOW_HEALTH = {
  generatedAt: new Date().toISOString(),
  flows: [
    { id: "claims-triage", source: "file", version: "7", shadowsFile: false },
    { id: "contract-scan", source: "db", version: "3", shadowsFile: true },
  ],
  loadFailures: [],
};

const POSTURE = {
  generatedAt: new Date().toISOString(),
  operationalProfile: "production",
  preset: null,
  status: "warn",
  summary: { ok: 28, warn: 2, fail: 0 },
  checks: [],
  productionGate: { fatal: [], warnings: [] },
};

const PROVIDERS = {
  providers: [
    {
      name: "primary",
      configured: true,
      models: ["gpt-4o"],
      status: { state: "closed", failure_count: 0 },
      calls: 12,
      errors: 0,
      tokens: 4200,
    },
    {
      name: "backup",
      configured: false,
      models: [],
      calls: 0,
      errors: 0,
      tokens: 0,
    },
  ],
  pools: [],
  global: { queueDepth: 1, activeExecutions: 2 },
};

const MCP = {
  servers: [
    {
      id: "s-1",
      name: "CRM",
      url: "https://crm.example/mcp",
      status: "connected",
      tools: [{ name: "lookup", description: "", authorized: true }],
    },
  ],
};

const USAGE = {
  usage: [
    {
      execution_id: "e-1",
      flow_id: "claims-triage",
      model: "gpt-4o",
      total_tokens: 1200,
      cost: 0.004,
      duration_ms: 2100,
      created_at: new Date().toISOString(),
    },
  ],
};

/**
 * Serves `payloads` by URL substring. A number answers with that status, the
 * string `"throw"` fails the transport, anything else is returned as JSON.
 * An unmatched path answers 404, so a typo in a tile path surfaces as a
 * missing tile instead of a silently empty one.
 */
function stubFetch(payloads: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [path, payload] of Object.entries(payloads)) {
      if (!url.includes(path)) continue;
      if (payload === "throw") throw new Error("connection refused");
      if (typeof payload === "number") {
        return { ok: false, status: payload, json: async () => ({ error: "denied" }) };
      }
      return { ok: true, status: 200, json: async () => payload };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** `payloads` with one endpoint removed, so that tile answers 404. */
function withoutEndpoint(path: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ALL_ENDPOINTS).filter(([key]) => key !== path),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <OverviewPage />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

const ALL_ENDPOINTS: Record<string, unknown> = {
  "/health/ready": READY,
  "/monitoring/approvals": APPROVALS,
  "/monitoring/flow-health": FLOW_HEALTH,
  "/monitoring/posture": POSTURE,
  "/monitoring/providers": PROVIDERS,
  "/mcp/servers": MCP,
  "/monitoring/usage": USAGE,
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/overview — operator start page", () => {
  test("renders every tile from the existing runtime endpoints", async () => {
    const fetchMock = stubFetch(ALL_ENDPOINTS);
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Overview" }),
    ).toBeTruthy();

    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(await screen.findByText("2 awaiting a decision")).toBeTruthy();
    expect(await screen.findByText("demo/case_lookup")).toBeTruthy();
    expect(await screen.findByText("Warnings")).toBeTruthy();
    expect(await screen.findByText("28 passed, 2 warnings, 0 failing")).toBeTruthy();
    // `claims-triage` appears twice — in the flow-health tile and in the newest
    // usage row — which is itself a check that both tiles got data.
    expect((await screen.findAllByText("claims-triage")).length).toBeGreaterThan(1);
    expect(await screen.findByText("primary")).toBeTruthy();
    expect(await screen.findByText("CRM")).toBeTruthy();
    expect(await screen.findByText("backup")).toBeTruthy();

    // No endpoint outside the seven the page documents is contacted.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => url.startsWith("/"))).toBe(true);
    for (const path of Object.keys(ALL_ENDPOINTS)) {
      expect(urls.some((url) => url.includes(path))).toBe(true);
    }
  });

  test("each tile links to its detail page", async () => {
    stubFetch(ALL_ENDPOINTS);
    renderPage();
    await screen.findByTestId("tile-usage");

    const expected: Record<string, string> = {
      readiness: "/flows/health",
      approvals: "/approvals",
      posture: "/posture",
      "flow-health": "/flows/health",
      providers: "/providers",
      mcp: "/mcp",
      usage: "/cost",
    };
    for (const [testId, href] of Object.entries(expected)) {
      const card = screen.getByTestId(`tile-${testId}`);
      const link = card.querySelector("a");
      expect(link?.getAttribute("href")).toBe(href);
    }
    // A usage row opens its trace through the query deep link the traces page
    // reads (`/traces?execution=<id>`); there is no `/traces/<id>` route.
    const rowLink = (await screen.findAllByTestId("usage-row"))[0]?.querySelector("a");
    expect(rowLink?.getAttribute("href")).toBe("/traces?execution=e-1");
  });

  test("an empty deployment renders the explained empty states", async () => {
    stubFetch({
      "/health/ready": READY,
      "/monitoring/approvals": { pending: [], resolved: [] },
      "/monitoring/flow-health": { generatedAt: "", flows: [], loadFailures: [] },
      "/monitoring/posture": POSTURE,
      "/monitoring/providers": {
        providers: [],
        pools: [],
        global: { queueDepth: 0, activeExecutions: 0 },
      },
      "/mcp/servers": { servers: [] },
      "/monitoring/usage": { usage: [] },
    });
    renderPage();

    expect(await screen.findByText("Nothing is waiting for a decision.")).toBeTruthy();
    expect(screen.getByText("No flow is loaded on this replica.")).toBeTruthy();
    expect(screen.getByText("No MCP server is registered.")).toBeTruthy();
    expect(screen.getByText("No execution has been recorded yet.")).toBeTruthy();
    // The providers payload is an object, so its empty state comes from the
    // tile body rather than the shared array check.
    expect(screen.getByText("No model provider is configured.")).toBeTruthy();
    // A rendered page is not an error page.
    expect(screen.queryByText("Currently unreachable")).toBeNull();
  });

  test("a 403 on one tile explains itself and leaves the others working", async () => {
    stubFetch({ ...ALL_ENDPOINTS, "/monitoring/posture": 403 });
    renderPage();

    expect(
      await screen.findByText("You do not have permission to see this."),
    ).toBeTruthy();
    // The rest of the page still renders.
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText("CRM")).toBeTruthy();
  });

  test("a 404 says the feature is not part of this deployment", async () => {
    stubFetch(withoutEndpoint("/mcp/servers"));
    renderPage();

    expect(
      await screen.findByText("Not available in this deployment"),
    ).toBeTruthy();
    expect(await screen.findByText("Ready")).toBeTruthy();
  });

  test("a 503 from readiness is reported, not thrown", async () => {
    stubFetch({ ...ALL_ENDPOINTS, "/health/ready": 503 });
    renderPage();

    expect(await screen.findByText("Currently unreachable")).toBeTruthy();
    expect(screen.getByText("The endpoint answered with 503.")).toBeTruthy();
    expect(await screen.findByText("CRM")).toBeTruthy();
  });

  test("a transport failure falls back to the unreachable explanation", async () => {
    stubFetch({ ...ALL_ENDPOINTS, "/monitoring/usage": "throw" });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("The endpoint answered with no response.")).toBeTruthy(),
    );
    expect(screen.getByText("CRM")).toBeTruthy();
  });

  test("shows more than the visible rows as a count", async () => {
    stubFetch({
      ...ALL_ENDPOINTS,
      "/monitoring/approvals": {
        pending: Array.from({ length: 6 }, (_, i) => ({
          id: `ap-${i}`,
          executionId: `e-${i}`,
          nodeId: `n-${i}`,
          tool: `demo/tool_${i}`,
          args: {},
          requestedAt: new Date().toISOString(),
        })),
        resolved: [],
      },
    });
    renderPage();

    expect(await screen.findByText("+2 more")).toBeTruthy();
    // Four of six are listed, the fifth is not.
    expect(screen.getByText("demo/tool_3")).toBeTruthy();
    expect(screen.queryByText("demo/tool_4")).toBeNull();
  });

  test("renders in German under the German locale", async () => {
    stubFetch(ALL_ENDPOINTS);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LocaleProvider initialLocale="de">
          <OverviewPage />
        </LocaleProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Übersicht" }),
    ).toBeTruthy();
    expect(await screen.findByText("Bereit")).toBeTruthy();
  });
});
