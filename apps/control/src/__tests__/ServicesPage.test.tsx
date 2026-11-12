// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Review follow-up F2 — the services page.
 *
 * Pins that `/services` renders the configured SERVICE_LINKS with an
 * "Open UI" anchor (new tab, `rel="noopener noreferrer"`), reports the MCP
 * server status, degrades to explained empty states, and refuses to render an
 * anchor for a URL whose scheme is not http(s) — even if such a value somehow
 * reached the UI despite the runtime's startup rejection.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ServicesPage from "../app/(dashboard)/services/page";
import { LocaleProvider } from "../lib/i18n";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true, isAuthenticated: true }),
}));

const SERVICES = {
  services: [
    { name: "Search", kind: "search", url: "https://search.example.com" },
    { name: "Extract", kind: "extract", url: "https://extract.example.com" },
    { name: "Gate", kind: "gate", url: "https://gate.example.com/ui" },
    { name: "Grafana", kind: "other", url: "https://grafana.example.com" },
  ],
  mcp: [
    {
      name: "erp",
      url: "http://erp.internal:4000/mcp",
      transport: "http",
      status: "connected",
    },
    {
      name: "broken",
      url: "http://broken.internal:4000/mcp",
      transport: "sse",
      status: "error",
      error: "connection refused",
    },
  ],
};

function stubFetch(payload: unknown) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function stubFailure(status = 503) {
  global.fetch = vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ error: "unavailable" }),
  })) as unknown as typeof fetch;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ServicesPage />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/services — operator service inventory", () => {
  test("renders every configured service link with a safe new-tab anchor", async () => {
    stubFetch(SERVICES);
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Services" }),
    ).toBeTruthy();

    const openLinks = await screen.findAllByRole("link", { name: /Open UI/ });
    expect(openLinks).toHaveLength(4);
    for (const link of openLinks) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(
      (screen.getByRole("link", {
        name: /Open UI.*Search/,
      }) as HTMLAnchorElement).href,
    ).toContain("search.example.com");
    expect(await screen.findByText("Grafana")).toBeTruthy();
  });

  test("reports the MCP connection status per server", async () => {
    stubFetch(SERVICES);
    renderPage();

    expect(await screen.findByText("erp")).toBeTruthy();
    expect(await screen.findByText("broken")).toBeTruthy();
    expect((await screen.findAllByText("connected")).length).toBeGreaterThan(0);
    expect(await screen.findByText("unreachable")).toBeTruthy();
  });

  test("renders explained empty states when nothing is configured", async () => {
    stubFetch({ services: [], mcp: [] });
    renderPage();

    expect(await screen.findByText("No service links are configured.")).toBeTruthy();
    expect(screen.getByText(/SERVICE_LINKS/)).toBeTruthy();
    expect(screen.getByText("No MCP servers are configured.")).toBeTruthy();
  });

  test("degrades to an explained state when the endpoint is unavailable", async () => {
    stubFailure(404);
    renderPage();

    expect(
      await screen.findByText("The service inventory is unavailable"),
    ).toBeTruthy();
  });

  test("never renders an anchor for a non-http scheme", async () => {
    stubFetch({
      services: [
        { name: "XSS", kind: "other", url: "javascript:alert(1)" },
        { name: "Data", kind: "other", url: "data:text/html,hi" },
        { name: "OK", kind: "search", url: "https://search.example.com" },
      ],
      mcp: [],
    });
    const { container } = renderPage();

    expect(await screen.findByText("XSS")).toBeTruthy();
    // Both dangerous entries (javascript: and data:) are refused.
    expect(screen.getAllByText("Link blocked")).toHaveLength(2);

    const anchors = [
      ...container.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].filter((a) => a.closest('[data-testid="services-links"]') !== null);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.href).toBe("https://search.example.com/");
  });
});
