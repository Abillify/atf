// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantsPanel } from "../components/AssistantsPanel";
import { ConfirmProvider } from "../lib/ui";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true, role: "admin" }),
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </QueryClientProvider>,
  );
}

const ASSISTANT_ROW = {
  tenantId: "acme",
  userId: "alice@example.com",
  assistantId: "primary",
  displayName: "Alice's assistant",
  status: "active",
  autonomy: "supervised",
  updatedAt: "2025-01-01T00:00:00Z",
  lastActiveAt: "2025-01-01T00:00:00Z",
  skillCount: 0,
  pendingProposalCount: 0,
};

const ASSISTANT_DETAIL = {
  tenantId: "acme",
  userId: "alice@example.com",
  assistantId: "primary",
  displayName: "Alice's assistant",
  status: "active",
  autonomy: "supervised",
  workspacePath: "/data/assistants/acme/alice/primary",
  createdAt: "2025-01-01T00:00:00Z",
  soul: {
    identity: {},
    directives: {},
    constraints: {},
    revision: 1,
    revisionHash: "hash-1",
  },
  skills: [],
  delegations: [
    {
      issuer: "https://idp.example.com",
      consentedScope: "openid offline_access",
      state: "usable",
    },
  ],
};

const DELEGATIONS_PAGE = {
  total: 1,
  delegations: [
    {
      tenantId: "acme",
      userId: "alice@example.com",
      assistantId: "primary",
      issuer: "https://idp.example.com",
      consentedScope: "openid offline_access",
      grantedAt: "2025-01-01T00:00:00Z",
      refreshFailures: 0,
      revoked: false,
      state: "usable",
    },
  ],
};

/** Routes fetch calls by URL substring to canned JSON responses. */
function mockFetchRouter(routes: Array<{ match: string; body: unknown; ok?: boolean }>): void {
  global.fetch = vi.fn().mockImplementation((input: string) => {
    const url = typeof input === "string" ? input : String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    return Promise.resolve({
      ok: route.ok ?? true,
      status: (route.ok ?? true) ? 200 : 500,
      json: async () => route.body,
    });
  }) as unknown as typeof fetch;
}

describe("AssistantsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the Estate tab by default and the Revocation Console tab on demand", async () => {
    mockFetchRouter([
      { match: "/admin/assistants?", body: { total: 1, assistants: [ASSISTANT_ROW] } },
      { match: "/admin/identity-broker/delegations", body: DELEGATIONS_PAGE },
    ]);
    renderWithQueryClient(<AssistantsPanel />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument(),
    );
    // The revocation console tab panel exists but is hidden while the estate
    // tab is active (Tabs keeps inactive panels in the DOM, just hidden).
    await waitFor(() =>
      expect(screen.getByText("https://idp.example.com")).not.toBeVisible(),
    );

    fireEvent.click(screen.getByText("Revocation Console"));
    await waitFor(() =>
      expect(screen.getByText("https://idp.example.com")).toBeVisible(),
    );
  });

  test("Revocation Console lists a delegation and revokes it on click", async () => {
    mockFetchRouter([
      { match: "/admin/assistants?", body: { total: 0, assistants: [] } },
      { match: "/admin/identity-broker/delegations", body: DELEGATIONS_PAGE },
      { match: "/delegation?issuer=", body: { revoked: true } },
    ]);
    renderWithQueryClient(<AssistantsPanel />);
    fireEvent.click(screen.getByText("Revocation Console"));

    await waitFor(() =>
      expect(screen.getByText("https://idp.example.com")).toBeInTheDocument(),
    );
    const row = screen.getByText("https://idp.example.com").closest("tr");
    expect(row).not.toBeNull();
    const revokeBtn = within(row as HTMLElement).getByRole("button", {
      name: /Revoke delegation/,
    });
    fireEvent.click(revokeBtn);
    // Nothing is revoked until the confirmation dialog is accepted.
    const dialog = await screen.findByRole("dialog");
    expect(
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("/delegation?"),
      ),
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        calls.some((call) => {
          const url = call[0];
          return (
            typeof url === "string" &&
            url.includes("/admin/assistants/acme/alice%40example.com/primary/delegation") &&
            url.includes("issuer=https%3A%2F%2Fidp.example.com")
          );
        }),
      ).toBe(true);
    });
  });

  test("Revocation Console shows an empty state when nothing matches", async () => {
    mockFetchRouter([
      { match: "/admin/assistants?", body: { total: 0, assistants: [] } },
      { match: "/admin/identity-broker/delegations", body: { total: 0, delegations: [] } },
    ]);
    renderWithQueryClient(<AssistantsPanel />);
    fireEvent.click(screen.getByText("Revocation Console"));
    await waitFor(() =>
      expect(
        screen.getByText(/No delegation grants match this filter/),
      ).toBeInTheDocument(),
    );
  });

  const ORG_SKILL_ROW = {
    id: "org-skill-1",
    tenantId: "acme",
    name: "Summarize invoices",
    triggerLine: "When asked to summarize an invoice PDF",
    body: "1. Extract line items. 2. Sum totals.",
    status: "published",
    summary: "Reliable invoice summarization technique",
    installCount: 3,
    publishedBy: "alice@example.com",
    sourceUserId: "alice@example.com",
    sourceAssistantId: "primary",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  test("Skill Registry tab requires a tenant id before browsing", async () => {
    mockFetchRouter([
      { match: "/admin/assistants?", body: { total: 0, assistants: [] } },
      { match: "/admin/identity-broker/delegations", body: { total: 0, delegations: [] } },
    ]);
    renderWithQueryClient(<AssistantsPanel />);
    fireEvent.click(screen.getByText("Skill Registry"));
    await waitFor(() =>
      expect(
        screen.getByText(/Enter a tenant id to browse its skill catalog/),
      ).toBeInTheDocument(),
    );
  });

  test("Skill Registry tab browses a tenant's catalog and deprecates an entry", async () => {
    mockFetchRouter([
      { match: "/admin/assistants?", body: { total: 0, assistants: [] } },
      { match: "/admin/identity-broker/delegations", body: { total: 0, delegations: [] } },
      { match: "/admin/org-skills?", body: { total: 1, skills: [ORG_SKILL_ROW] } },
      { match: "/deprecate?tenantId=", body: { deprecated: true } },
    ]);
    renderWithQueryClient(<AssistantsPanel />);
    fireEvent.click(screen.getByText("Skill Registry"));

    fireEvent.change(screen.getByLabelText("Tenant id to browse"), {
      target: { value: "acme" },
    });

    await waitFor(() =>
      expect(screen.getByText("Summarize invoices")).toBeInTheDocument(),
    );
    expect(screen.getByText(/installed 3×/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deprecate" }));

    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        calls.some((call) => {
          const url = call[0];
          return (
            typeof url === "string" &&
            url.includes("/admin/org-skills/org-skill-1/deprecate") &&
            url.includes("tenantId=acme")
          );
        }),
      ).toBe(true);
    });
  });

  test("per-assistant detail view shows a Revoke button for a usable delegation", async () => {
    mockFetchRouter([
      { match: "/admin/assistants?", body: { total: 1, assistants: [ASSISTANT_ROW] } },
      { match: "/admin/assistants/acme/alice%40example.com/primary/proposals", body: { proposals: [] } },
      { match: "/admin/assistants/acme/alice%40example.com/primary", body: ASSISTANT_DETAIL },
    ]);
    renderWithQueryClient(<AssistantsPanel />);

    await waitFor(() =>
      expect(screen.getByText("alice@example.com")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("alice@example.com"));

    await waitFor(() =>
      expect(
        screen.getByLabelText(/Revoke delegation for issuer https:\/\/idp\.example\.com/),
      ).toBeInTheDocument(),
    );
  });
});
