// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { CitationImpactPanel } from "../components/CitationImpactPanel";
import type {
  CitationImpactAffected,
  CitationImpactReport,
} from "../types/citation-impact";

const affectedRow = (
  over: Partial<CitationImpactAffected> = {},
): CitationImpactAffected => ({
  execution_id: "exec-1",
  flow_id: "risk-assessment",
  flow_version: "v3",
  created_at: "2026-10-01T10:00:00Z",
  chunks: [
    {
      base_ref: "kb-policy",
      chunk_id: "chunk-7",
      status: "changed",
      current_revision: "r9",
    },
  ],
  ...over,
});

const reportFixture = (
  over: Partial<CitationImpactReport> = {},
): CitationImpactReport => ({
  generated_at: "2026-10-24T12:00:00Z",
  since: "2026-07-26T12:00:00Z",
  tenant_id: null,
  summary: {
    executions_checked: 120,
    executions_affected: 2,
    chunks: { current: 40, carried: 5, changed: 3, removed: 1, unknown: 0, unverified: 2 },
  },
  affected: [affectedRow()],
  ...over,
});

const baseProps = () => ({
  report: null,
  affected: [] as CitationImpactAffected[],
  signed: false,
  days: 90 as const,
  onDaysChange: vi.fn(),
  baseRef: "",
  onBaseRefChange: vi.fn(),
});

describe("CitationImpactPanel", () => {
  test("empty state when no execution is affected", () => {
    render(<CitationImpactPanel {...baseProps()} />);
    expect(
      screen.getByText("No answers cite a changed or removed source."),
    ).toBeInTheDocument();
  });

  test("loading state while the first fetch is pending", () => {
    render(<CitationImpactPanel {...baseProps()} isLoading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("summary counters show checked/affected and per-status counts", () => {
    const report = reportFixture();
    render(
      <CitationImpactPanel {...baseProps()} report={report} affected={report.affected} />,
    );
    expect(screen.getByText("Executions checked: 120")).toBeInTheDocument();
    expect(screen.getByText("Affected: 2")).toBeInTheDocument();
    // The changed/removed counters back the table's story.
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  test("affected row links to the trace view of the execution", () => {
    const report = reportFixture();
    render(
      <CitationImpactPanel {...baseProps()} report={report} affected={report.affected} />,
    );
    const link = screen.getByText("exec-1");
    expect(link.closest("a")).toHaveAttribute(
      "href",
      "/traces?execution=exec-1",
    );
    expect(screen.getByText("risk-assessment")).toBeInTheDocument();
    expect(screen.getByText("kb-policy/chunk-7")).toBeInTheDocument();
  });

  test("chunk status is conveyed as badge text", () => {
    const report = reportFixture({
      affected: [
        affectedRow({
          execution_id: "exec-2",
          chunks: [
            { base_ref: "kb-a", chunk_id: "c1", status: "changed" },
            { base_ref: "kb-b", chunk_id: "c2", status: "removed" },
          ],
        }),
      ],
    });
    render(
      <CitationImpactPanel {...baseProps()} report={report} affected={report.affected} />,
    );
    // Once as a summary label, once as the badge in the table row.
    expect(screen.getAllByText("changed")).toHaveLength(2);
    expect(screen.getAllByText("removed")).toHaveLength(2);
    expect(screen.queryByText("now r9")).not.toBeInTheDocument();
  });

  test("signed badge only when the report carries a signature", () => {
    const unsigned = reportFixture();
    const { rerender } = render(
      <CitationImpactPanel
        {...baseProps()}
        report={unsigned}
        affected={unsigned.affected}
        signed={false}
      />,
    );
    expect(screen.queryByText("signed")).not.toBeInTheDocument();
    rerender(
      <CitationImpactPanel
        {...baseProps()}
        report={unsigned}
        affected={unsigned.affected}
        signed
      />,
    );
    expect(screen.getByText("signed")).toBeInTheDocument();
  });

  test("unconfigured citation check shows the hint instead of the raw error", () => {
    render(
      <CitationImpactPanel
        {...baseProps()}
        error="citation check is not configured (CITATION_CHECK_URL)"
      />,
    );
    expect(
      screen.getByText(
        "Citation check is not configured — set CITATION_CHECK_URL on the runtime.",
      ),
    ).toBeInTheDocument();
  });

  test("other errors surface verbatim", () => {
    render(<CitationImpactPanel {...baseProps()} error="HTTP 502" />);
    expect(screen.getByText("HTTP 502")).toBeInTheDocument();
  });

  test("window selector offers 30, 90 and 365 days", () => {
    render(<CitationImpactPanel {...baseProps()} />);
    const select = screen.getByRole("combobox", {
      name: "Reporting window",
    });
    expect(select).toHaveValue("90");
    expect(
      screen.getByRole("option", { name: "Last 30 days" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Last 90 days" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Last 365 days" }),
    ).toBeInTheDocument();
  });
});
