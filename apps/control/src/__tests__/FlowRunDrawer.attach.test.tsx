// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { FlowRunDrawer } from "../components/FlowRunDrawer";
import type { NodeExecutionEvent } from "../types/monitoring";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: undefined, isAuthenticated: true, renewNow: async () => null }),
}));
const monitor = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("../hooks/useMonitoringEvents", () => ({
  useMonitoringEvents: () => ({ events: monitor.events }),
}));
const durable = vi.hoisted(() => ({ events: [] as unknown[], load: vi.fn() }));
vi.mock("../hooks/useExecutionEvents", () => ({
  useExecutionEvents: () => ({ events: durable.events, executionId: "x1", isLoading: false, error: null, load: durable.load }),
}));
vi.mock("../lib/studio-run", () => ({ registerTestRun: vi.fn(), streamChatCompletion: vi.fn() }));

const ev = (node_id: string, status: NodeExecutionEvent["status"], extra: Partial<NodeExecutionEvent> = {}): NodeExecutionEvent => ({
  execution_id: "x1",
  node_id,
  status,
  start_time: "2026-09-25T10:00:00.000Z",
  end_time: status === "running" ? null : "2026-09-25T10:00:01.000Z",
  latency_ms: status === "running" ? null : 1000,
  ...extra,
});
const request = ev("__request__", "completed", { user_prompt: "Where is my order?" });
const response = ev("__response__", "completed", {
  response: JSON.stringify({ choices: [{ message: { content: "On its way." } }] }),
});

beforeEach(() => {
  monitor.events = [];
  durable.events = [];
  durable.load.mockReset();
});

describe("FlowRunDrawer — attached request", () => {
  test("a running request traces on the canvas like a Run & Trace run", async () => {
    durable.events = [request, ev("llm", "running")];
    const onLiveStatesChange = vi.fn();
    render(<FlowRunDrawer flowId="f" onLiveStatesChange={onLiveStatesChange} attachExecutionId="x1" />);
    expect(durable.load).toHaveBeenCalledWith("x1");
    await waitFor(() => expect(screen.getByTestId("attached-run")).toHaveTextContent("still running"));
    expect((screen.getByLabelText("Test prompt") as HTMLInputElement).value).toBe("Where is my order?");
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    // No Stop: the request wasn't started here.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const [states] = onLiveStatesChange.mock.calls.at(-1) as [Map<string, { status: string }>];
    expect(states.get("llm")?.status).toBe("running");
  });

  test("a finished request shows its answer and can be pinned", async () => {
    durable.events = [request, ev("llm", "completed"), response];
    const onPinRun = vi.fn().mockResolvedValue(undefined);
    render(<FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} attachExecutionId="x1" onPinRun={onPinRun} />);
    await waitFor(() => expect(screen.getByText("On its way.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Pin as sample data/ }));
    await waitFor(() => expect(onPinRun).toHaveBeenCalledWith("x1"));
  });

  test("Clear detaches", async () => {
    durable.events = [request, response];
    const onDetach = vi.fn();
    render(<FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} attachExecutionId="x1" onDetach={onDetach} />);
    await waitFor(() => expect(screen.getByText("On its way.")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Clear result and canvas trace"));
    expect(onDetach).toHaveBeenCalled();
    expect(screen.queryByTestId("attached-run")).toBeNull();
  });
});
