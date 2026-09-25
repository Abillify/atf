// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { DossierPanel } from "../components/DossierPanel";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true, isAuthenticated: true }),
}));

function baseDossier(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-01-15T00:00:00.000Z",
    windowStart: "2025-12-16T00:00:00.000Z",
    windowEnd: "2026-01-15T00:00:00.000Z",
    auditReport: { policy: null },
    auditIntegrity: {
      chainVerification: { valid: true, checked: 12 },
    },
    rtbfEvidence: { totalOperations: 0, totalRecordsErased: 0, operations: [] },
    retentionPosture: { targets: [], policyRetentionRules: [] },
    evalEvidence: [],
    securityPosture: { enabled: false, postureByFlow: {}, recentRuns: [] },
    architecturalGuarantees: [
      { topic: "Tenant isolation", summary: "...", reference: "docs/adr/0005" },
    ],
    ...overrides,
  };
}

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("DossierPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders a valid audit chain and the architectural guarantees", async () => {
    mockFetchOnce(baseDossier());
    render(<DossierPanel />);
    await waitFor(() => expect(screen.getByText(/Verified —/)).toBeInTheDocument());
    expect(screen.getByText("Tenant isolation")).toBeInTheDocument();
  });

  test("shows tamper-detected state distinctly", async () => {
    mockFetchOnce(
      baseDossier({
        auditIntegrity: {
          chainVerification: {
            valid: false,
            checked: 5,
            brokenAt: { id: 3, reason: "hash_mismatch" },
          },
        },
      }),
    );
    render(<DossierPanel />);
    await waitFor(() =>
      expect(screen.getByText(/TAMPER DETECTED/)).toBeInTheDocument(),
    );
  });

  test("renders RTBF evidence operations", async () => {
    mockFetchOnce(
      baseDossier({
        rtbfEvidence: {
          totalOperations: 1,
          totalRecordsErased: 5,
          operations: [
            { at: "2026-01-10T00:00:00.000Z", actor: "admin", action: "compliance.forget", erased: 5 },
          ],
        },
      }),
    );
    render(<DossierPanel />);
    await waitFor(() => expect(screen.getByText("compliance.forget")).toBeInTheDocument());
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  test("renders eval evidence with pass rate", async () => {
    mockFetchOnce(
      baseDossier({
        evalEvidence: [
          { dataset: "ds-a", recordedAt: "2026-01-01T00:00:00.000Z", source: "ci", passRate: 0.9, passed: 9, total: 10 },
        ],
      }),
    );
    render(<DossierPanel />);
    await waitFor(() => expect(screen.getByText("ds-a")).toBeInTheDocument());
    expect(screen.getByText("9/10 passed (90%)")).toBeInTheDocument();
  });

  test("shows a disabled message for security posture when red-team is off", async () => {
    mockFetchOnce(baseDossier());
    render(<DossierPanel />);
    await waitFor(() =>
      expect(
        screen.getByText("Red-team / security posture engine not enabled."),
      ).toBeInTheDocument(),
    );
  });

  test("renders security posture scores when enabled", async () => {
    mockFetchOnce(
      baseDossier({
        securityPosture: {
          enabled: true,
          postureByFlow: { "flow-a": 0.85 },
          recentRuns: [],
        },
      }),
    );
    render(<DossierPanel />);
    await waitFor(() => expect(screen.getByText("flow-a: 85%")).toBeInTheDocument());
  });

  test("shows an error message on fetch failure", async () => {
    mockFetchOnce({}, false);
    render(<DossierPanel />);
    await waitFor(() => expect(screen.getByText("HTTP 500")).toBeInTheDocument());
  });
});
