// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { FlowHealthPanel } from "../components/FlowHealthPanel";
import type {
  FlowHealthEntry,
  FlowLoadFailure,
} from "../hooks/useFlowHealth";

const flow = (over: Partial<FlowHealthEntry> = {}): FlowHealthEntry => ({
  id: "helpdesk",
  source: "file",
  file: "flows/helpdesk.yaml",
  version: "1.2.0",
  digest: "abcdef1234567890",
  shadowsFile: false,
  ...over,
});

const failure = (over: Partial<FlowLoadFailure> = {}): FlowLoadFailure => ({
  file: "flows/broken.yaml",
  reason: "YAML parse error at line 3",
  since: "2026-02-20T10:00:00Z",
  ...over,
});

describe("FlowHealthPanel", () => {
  test("empty state when no flows are served", () => {
    render(<FlowHealthPanel flows={[]} loadFailures={[]} />);
    expect(screen.getByText("No flows are being served.")).toBeInTheDocument();
  });

  test("loading state while first fetch is pending", () => {
    render(<FlowHealthPanel flows={[]} loadFailures={[]} isLoading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("renders flow id, source, file, version and truncated digest", () => {
    render(<FlowHealthPanel flows={[flow()]} loadFailures={[]} />);
    expect(screen.getByText("helpdesk")).toBeInTheDocument();
    expect(screen.getByText("file")).toBeInTheDocument();
    expect(screen.getByText("flows/helpdesk.yaml")).toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
    expect(screen.getByText("abcdef123456")).toBeInTheDocument();
  });

  test("renders database source badge", () => {
    render(
      <FlowHealthPanel
        flows={[
          flow({ source: "db", file: undefined, shadowsFile: true }),
        ]}
        loadFailures={[]}
      />,
    );
    expect(screen.getByText("database")).toBeInTheDocument();
  });

  test("shows shadow hint as text, not only color", () => {
    render(
      <FlowHealthPanel
        flows={[flow({ source: "db", shadowsFile: true })]}
        loadFailures={[]}
      />,
    );
    expect(screen.getByText("shadowing file")).toBeInTheDocument();
  });

  test("no shadow hint for non-shadowing flows", () => {
    render(<FlowHealthPanel flows={[flow()]} loadFailures={[]} />);
    expect(screen.queryByText("shadowing file")).not.toBeInTheDocument();
  });

  test("renders last eval counts and time", () => {
    render(
      <FlowHealthPanel
        flows={[
          flow({
            lastEval: {
              runId: "run-1",
              at: "2026-02-21T08:30:00Z",
              passed: 12,
              failed: 1,
            },
          }),
        ]}
        loadFailures={[]}
      />,
    );
    expect(screen.getByText("12 passed / 1 failed")).toBeInTheDocument();
  });

  test("shows 'no eval yet' when lastEval is missing", () => {
    render(<FlowHealthPanel flows={[flow()]} loadFailures={[]} />);
    expect(screen.getByText("no eval yet")).toBeInTheDocument();
  });

  test("renders load failures with file, reason and since", () => {
    render(
      <FlowHealthPanel flows={[flow()]} loadFailures={[failure()]} />,
    );
    expect(screen.getByText("Load failures")).toBeInTheDocument();
    expect(screen.getByText("flows/broken.yaml")).toBeInTheDocument();
    expect(screen.getByText("YAML parse error at line 3")).toBeInTheDocument();
    expect(screen.getByText(/since /)).toBeInTheDocument();
  });

  test("renders error message from the hook", () => {
    render(
      <FlowHealthPanel
        flows={[]}
        loadFailures={[]}
        error="Unauthorized monitoring access."
      />,
    );
    expect(
      screen.getByText("Unauthorized monitoring access."),
    ).toBeInTheDocument();
  });

  test("table has a caption for accessibility", () => {
    render(<FlowHealthPanel flows={[flow()]} loadFailures={[]} />);
    expect(
      screen.getByText(
        "Served flows with source, version, digest and latest eval",
      ),
    ).toBeInTheDocument();
  });
});
