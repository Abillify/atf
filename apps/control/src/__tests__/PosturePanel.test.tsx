// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { PosturePanel } from "../components/PosturePanel";
import type { PostureCheck } from "../types/posture";

const check = (over: Partial<PostureCheck> = {}): PostureCheck => ({
  id: "evidence_key",
  area: "evidence",
  status: "ok",
  message: "EVIDENCE_SIGNING_KEY (Ed25519) is configured.",
  ...over,
});

describe("PosturePanel", () => {
  test("empty state when the runtime reports no checks", () => {
    render(<PosturePanel checks={[]} />);
    expect(
      screen.getByText("The runtime reports no governance checks."),
    ).toBeInTheDocument();
  });

  test("loading state while the first fetch is pending", () => {
    render(<PosturePanel checks={[]} isLoading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("renders each check with its status badge text and explanation", () => {
    render(
      <PosturePanel
        checks={[
          check(),
          check({
            id: "egress_guard",
            area: "egress",
            status: "warn",
            message: "EGRESS_ALLOWED_HOSTS is empty.",
          }),
          check({
            id: "anchors",
            area: "audit",
            status: "fail",
            message: "No evidence signing key is configured.",
          }),
        ]}
      />,
    );
    expect(screen.getByText("evidence_key")).toBeInTheDocument();
    expect(screen.getByText("egress_guard")).toBeInTheDocument();
    expect(screen.getByText("anchors")).toBeInTheDocument();
    expect(
      screen.getByText("EVIDENCE_SIGNING_KEY (Ed25519) is configured."),
    ).toBeInTheDocument();
    expect(screen.getByText("EGRESS_ALLOWED_HOSTS is empty.")).toBeInTheDocument();
    expect(
      screen.getByText("No evidence signing key is configured."),
    ).toBeInTheDocument();
    // Status is conveyed as text, never color alone.
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("warn")).toBeInTheDocument();
    expect(screen.getByText("fail")).toBeInTheDocument();
  });

  test("groups checks by area with one header per area", () => {
    const { container } = render(
      <PosturePanel
        checks={[
          check({ id: "evidence_key" }),
          check({ id: "receipts", area: "receipts" }),
          check({ id: "retention", area: "receipts", status: "warn" }),
        ]}
      />,
    );
    // Each area gets one spanning group header row (th scope="colgroup").
    const groupHeaders = container.querySelectorAll('th[scope="colgroup"]');
    expect(
      Array.from(groupHeaders).map((h) => h.textContent?.trim()),
    ).toEqual(["evidence", "receipts"]);
  });

  test("header row uses scoped column headers", () => {
    const { container } = render(<PosturePanel checks={[check()]} />);
    const cols = container.querySelectorAll("thead th");
    expect(cols.length).toBe(3);
    for (const col of cols) {
      expect(col.getAttribute("scope")).toBe("col");
    }
  });

  test("shows the overall status and the operational profile", () => {
    render(
      <PosturePanel
        checks={[check(), check({ id: "egress", status: "warn" })]}
        status="warn"
        operationalProfile="production"
      />,
    );
    expect(screen.getByText("profile production")).toBeInTheDocument();
    // One badge per warn check plus the overall warn badge in the header.
    expect(screen.getAllByText("warn")).toHaveLength(2);
  });

  test("renders error message from the hook", () => {
    render(<PosturePanel checks={[]} error="Unauthorized posture access." />);
    expect(
      screen.getByText("Unauthorized posture access."),
    ).toBeInTheDocument();
  });

  test("table has a caption for accessibility", () => {
    render(
      <PosturePanel
        checks={[check()]}
        generatedAt="2026-02-21T08:30:00Z"
      />,
    );
    expect(
      screen.getByText(/Governance controls active right now, grouped by area/),
    ).toBeInTheDocument();
  });
});
