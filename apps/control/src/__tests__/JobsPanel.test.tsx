// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobsPanel } from "../components/JobsPanel";

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
  }) as unknown as typeof fetch;
}

const COMPLETED_JOB = {
  id: "job-1",
  status: "completed",
  model: "flow-a",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:05.000Z",
  attempt: 1,
  max_attempts: 1,
  result: { choices: [{ message: { content: "the answer" } }] },
};

const RECOVERED_JOB = {
  ...COMPLETED_JOB,
  id: "job-2",
  attempt: 2,
  max_attempts: 3,
};

const FAILED_JOB = {
  id: "job-3",
  status: "failed",
  model: "flow-b",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:05.000Z",
  attempt: 3,
  max_attempts: 3,
  error: "The executing replica stopped responding, and the job had already used its attempts.",
};

describe("JobsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shows a placeholder before any job id is submitted", () => {
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);
    expect(
      screen.getByText("Enter a job id to check its status."),
    ).toBeInTheDocument();
  });

  test("looks up a job by id and renders its status and result", async () => {
    mockFetchOnce(COMPLETED_JOB);
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);

    fireEvent.change(screen.getByLabelText("Job id"), {
      target: { value: "job-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    await waitFor(() => expect(screen.getByText("job-1")).toBeInTheDocument());
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toBeInTheDocument();
    // Not recovered — attempt 1/1, no "recovered" badge.
    expect(screen.queryByText(/recovered —/)).not.toBeInTheDocument();
  });

  test("submitting via Enter key also triggers the lookup", async () => {
    mockFetchOnce(COMPLETED_JOB);
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);
    const input = screen.getByLabelText("Job id");
    fireEvent.change(input, { target: { value: "job-1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("job-1")).toBeInTheDocument());
  });

  test("shows a 'recovered' badge with the attempt count for a retried job", async () => {
    mockFetchOnce(RECOVERED_JOB);
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);
    fireEvent.change(screen.getByLabelText("Job id"), {
      target: { value: "job-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() =>
      expect(screen.getByText(/recovered — attempt 2\/3/)).toBeInTheDocument(),
    );
  });

  test("renders the error message for a failed job", async () => {
    mockFetchOnce(FAILED_JOB);
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);
    fireEvent.change(screen.getByLabelText("Job id"), {
      target: { value: "job-3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() =>
      expect(
        screen.getByText(/already used its attempts/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  test("shows an error message when the job is not found", async () => {
    mockFetchOnce({ error: { message: 'Job "nope" not found.' } }, false);
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);
    fireEvent.change(screen.getByLabelText("Job id"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() =>
      expect(screen.getByText('Job "nope" not found.')).toBeInTheDocument(),
    );
  });

  test("does not submit an empty/whitespace-only job id", () => {
    renderWithQueryClient(<JobsPanel token="test-token" ready={true} />);
    const button = screen.getByRole("button", { name: "Look up" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Job id"), {
      target: { value: "   " },
    });
    expect(button).toBeDisabled();
  });
});
