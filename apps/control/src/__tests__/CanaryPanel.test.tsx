// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { CanaryPanel } from "../components/CanaryPanel";
import type { CanaryStatusEntry } from "../types/control";

const entry = (over: Partial<CanaryStatusEntry> = {}): CanaryStatusEntry => ({
  flow: "helpdesk",
  candidate: "helpdesk-v2",
  trafficPercent: 10,
  rolledBack: false,
  stable: { samples: 100, errors: 2, scoreSum: 90, scoreCount: 100 },
  canary: { samples: 30, errors: 1, scoreSum: 27, scoreCount: 30 },
  ...over,
});

describe("CanaryPanel", () => {
  test("empty state when no deployments", () => {
    render(<CanaryPanel deployments={[]} />);
    expect(
      screen.getByText("No canary deployments configured."),
    ).toBeInTheDocument();
  });

  test("renders flow → candidate and traffic share", () => {
    render(<CanaryPanel deployments={[entry()]} />);
    expect(screen.getByText("helpdesk")).toBeInTheDocument();
    expect(screen.getByText("helpdesk-v2")).toBeInTheDocument();
    expect(screen.getByText("10% canary")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  test("shows rolled-back state and 0% traffic", () => {
    render(<CanaryPanel deployments={[entry({ rolledBack: true })]} />);
    expect(screen.getByText("rolled back")).toBeInTheDocument();
    expect(screen.getByText("0% canary")).toBeInTheDocument();
  });

  test("renders per-variant error rate and mean score", () => {
    render(<CanaryPanel deployments={[entry()]} />);
    // stable error rate 2/100 = 2.0%, canary 1/30 ≈ 3.3%
    expect(screen.getByText("2.0%")).toBeInTheDocument();
    expect(screen.getByText("3.3%")).toBeInTheDocument();
    // mean scores 0.900 and 0.900
    expect(screen.getAllByText("0.900").length).toBeGreaterThanOrEqual(1);
  });

  // ── Critical-path: loading state ─────────────────────────────────────────
  test("shows loading indicator when isLoading=true and no deployments", () => {
    render(<CanaryPanel deployments={[]} isLoading={true} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("renders items even when isLoading=true (data takes precedence)", () => {
    render(<CanaryPanel deployments={[entry()]} isLoading={true} />);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByText("helpdesk")).toBeInTheDocument();
  });

  test("shows an error message when error prop is set", () => {
    render(<CanaryPanel deployments={[]} error="Connection refused" />);
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  // ── Critical-path: zero-score variant ─────────────────────────────────────
  test("shows em-dash when no score observations exist", () => {
    render(
      <CanaryPanel
        deployments={[
          entry({
            canary: { samples: 0, errors: 0, scoreSum: 0, scoreCount: 0 },
          }),
        ]}
      />,
    );
    // scoreCount=0 → score renders as "—"
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  // ── Critical-path: multiple deployments ───────────────────────────────────
  test("renders all deployments independently", () => {
    render(
      <CanaryPanel
        deployments={[
          entry({ flow: "flow-a", candidate: "flow-a-v2" }),
          entry({ flow: "flow-b", candidate: "flow-b-v3", trafficPercent: 25 }),
        ]}
      />,
    );
    expect(screen.getByText("flow-a")).toBeInTheDocument();
    expect(screen.getByText("flow-a-v2")).toBeInTheDocument();
    expect(screen.getByText("flow-b")).toBeInTheDocument();
    expect(screen.getByText("25% canary")).toBeInTheDocument();
  });
});
