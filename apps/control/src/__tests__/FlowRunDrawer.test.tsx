// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { FlowRunDrawer } from "../components/FlowRunDrawer";
import type { FlowDefinition } from "../types/flow";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: undefined, isAuthenticated: true, renewNow: async () => null }),
}));
const monitor = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("../hooks/useMonitoringEvents", () => ({
  useMonitoringEvents: () => ({ events: monitor.events }),
}));

const run = vi.hoisted(() => ({
  register: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("../lib/studio-run", () => ({
  registerTestRun: run.register,
  streamChatCompletion: run.stream,
}));

const canvas: FlowDefinition = { id: "f", name: "F", nodes: [], edges: [] };

function renderDrawer(extra: Partial<Parameters<typeof FlowRunDrawer>[0]> = {}) {
  render(
    <FlowRunDrawer
      flowId="f"
      onLiveStatesChange={() => {}}
      getDefinition={() => canvas}
      {...extra}
    />,
  );
  fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
}

beforeEach(() => {
  monitor.events = [];
  run.register.mockReset();
  run.stream.mockReset();
  run.stream.mockImplementation(async function* () {
    yield { kind: "content", text: "hello" };
  });
});

describe("FlowRunDrawer", () => {
  test("reasoning streams in an open Thinking block and collapses when the answer starts", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    run.stream.mockImplementation(async function* () {
      yield { kind: "reasoning", text: "Ich prüfe das. " };
      yield { kind: "reasoning", text: "Noch ein Gedanke." };
      yield { kind: "content", text: "Die Antwort." };
    });
    render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} />,
    );
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Die Antwort.")).toBeInTheDocument());
    const thinking = screen.getByTestId("thinking");
    // Auto-collapsed once the answer began, but the trail is kept and reopenable.
    expect(thinking).toBeInTheDocument();
    expect(screen.queryByText(/Ich prüfe das\. Noch ein Gedanke\./)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText(/Ich prüfe das\. Noch ein Gedanke\./)).toBeInTheDocument();
  });

  test("a manual toggle from the previous run does not suppress auto-collapse in the next run", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    run.stream.mockImplementation(async function* () {
      yield { kind: "reasoning", text: "Gedanke 1. " };
      yield { kind: "content", text: "Antwort 1." };
    });
    render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} />,
    );
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Antwort 1.")).toBeInTheDocument());
    // Open the trail by hand — this marks the run as user-toggled.
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText(/Gedanke 1\./)).toBeInTheDocument();

    // Second run: the fresh trail must auto-open and auto-collapse again,
    // even though the user toggled it during the first run.
    run.stream.mockImplementation(async function* () {
      yield { kind: "reasoning", text: "Gedanke 2. " };
      yield { kind: "content", text: "Antwort 2." };
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Antwort 2.")).toBeInTheDocument());
    // Collapsed again: the new trail is hidden until reopened.
    expect(screen.queryByText(/Gedanke 2\./)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    expect(screen.getByText(/Gedanke 2\./)).toBeInTheDocument();
    expect(screen.queryByText(/Gedanke 1\./)).toBeNull();
  });

  test("the answer previewed on the reasoning channel is not duplicated in Thinking", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    // Mirrors the runtime: narration + the answer are streamed live as
    // reasoning, then the same answer arrives again as content.
    run.stream.mockImplementation(async function* () {
      yield { kind: "reasoning", text: "Ich prüfe das. " };
      yield { kind: "reasoning", text: "Die Antwort." };
      yield { kind: "content", text: "Die Antwort." };
    });
    render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} />,
    );
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("Die Antwort.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    // Thinking keeps the narration only — the answer is not repeated there.
    expect(screen.getByText(/Ich prüfe das\./)).toBeInTheDocument();
    const thinking = screen.getByTestId("thinking");
    expect(thinking.textContent).not.toContain("Die Antwort.");
  });

  test("images attached to the prompt are forwarded to the stream", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} />,
    );
    const file = new File(["AAAA"], "screenshot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Attach images to the test prompt"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByAltText("screenshot.png")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    const args = run.stream.mock.calls[0] as unknown as [string, string, string, undefined, string[]];
    expect(args[4]?.[0]).toMatch(/^data:image\/png;base64,/);
    // Removing the attachment clears it again.
    fireEvent.click(screen.getByLabelText("Remove screenshot.png"));
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
  });

  test("runs the canvas under the throwaway model the runtime returns", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    renderDrawer();
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    expect(run.register).toHaveBeenCalledWith(null, canvas);
    expect(run.stream.mock.calls[0]![1]).toBe("f@studio-1");
  });

  test("an unchanged canvas runs the live flow under its real id", async () => {
    renderDrawer({ canvasIsLive: true });
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    expect(run.register).not.toHaveBeenCalled();
    expect(run.stream.mock.calls[0]![1]).toBe("f");
  });

  test("an unchanged canvas still registers a test run when the flow isn't live", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    renderDrawer({ canvasIsLive: true, liveAvailable: false });
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    expect(run.stream.mock.calls[0]![1]).toBe("f@studio-1");
  });

  test("falls back to the live flow on a runtime without test runs, and says so", async () => {
    run.register.mockResolvedValue({ ok: false, unsupported: true });
    renderDrawer();
    await waitFor(() => expect(screen.getByText(/ran the LIVE version/)).toBeInTheDocument());
    expect(run.stream.mock.calls[0]![1]).toBe("f");
  });

  test("reports validation errors instead of running a broken canvas", async () => {
    const report = { valid: false, errors: [{ path: "nodes", message: "bad" }], warnings: [], meta: { nodeCount: 0, edgeCount: 0 } };
    run.register.mockResolvedValue({ ok: false, error: "The canvas has validation errors", validation: report });
    const onValidationFailed = vi.fn();
    renderDrawer({ onValidationFailed });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("validation errors"));
    expect(onValidationFailed).toHaveBeenCalledWith(report);
    expect(run.stream).not.toHaveBeenCalled();
  });

  test("Live runs the flow id directly and eval cases are saved with an expected answer", async () => {
    const onSaveEvalCase = vi.fn().mockResolvedValue(undefined);
    render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} onSaveEvalCase={onSaveEvalCase} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    expect(run.register).not.toHaveBeenCalled();
    expect(run.stream.mock.calls[0]![1]).toBe("f");

    fireEvent.click(screen.getByRole("button", { name: "Save as eval case…" }));
    const expected = screen.getByLabelText("Expected answer") as HTMLTextAreaElement;
    expect(expected.value).toBe("hello");
    fireEvent.change(expected, { target: { value: "Hallo!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save eval case" }));
    await waitFor(() => expect(screen.getByText("Saved to the eval dataset.")).toBeInTheDocument());
    expect(onSaveEvalCase).toHaveBeenCalledWith("hi", "f", { content: "hello" }, "Hallo!");
  });

  test("a just-saved eval case can be removed again", async () => {
    const onSaveEvalCase = vi.fn().mockResolvedValue("case-9");
    const onDeleteEvalCase = vi.fn().mockResolvedValue(undefined);
    render(
      <FlowRunDrawer
        flowId="f"
        onLiveStatesChange={() => {}}
        onSaveEvalCase={onSaveEvalCase}
        onDeleteEvalCase={onDeleteEvalCase}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save as eval case…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save eval case" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("Eval case removed.")).toBeInTheDocument());
    expect(onDeleteEvalCase).toHaveBeenCalledWith("case-9");
  });

  test("a failed eval-case save is shown, not reported as saved", async () => {
    const onSaveEvalCase = vi.fn().mockRejectedValue(new Error("Missing required fields: expected"));
    render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} onSaveEvalCase={onSaveEvalCase} />,
    );
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save as eval case…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save eval case" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not saved: Missing required fields"));
    expect(screen.queryByText("Saved to the eval dataset.")).not.toBeInTheDocument();
  });

  test("a finished run can be pinned as sample data for the expression builder", async () => {
    run.register.mockResolvedValue({ ok: true, model: "f@studio-1" });
    const onPinRun = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} onPinRun={onPinRun} />,
    );
    fireEvent.change(screen.getByLabelText("Test prompt"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    // The monitoring stream reports the execution this run started.
    monitor.events = [
      {
        execution_id: "exec-42",
        node_id: "triage",
        status: "completed",
        start_time: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    rerender(
      <FlowRunDrawer flowId="f" onLiveStatesChange={() => {}} getDefinition={() => canvas} onPinRun={onPinRun} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Pin as sample data/ }));
    await waitFor(() => expect(screen.getByText(/Pinned as sample data/)).toBeInTheDocument());
    expect(onPinRun).toHaveBeenCalledWith("exec-42");
  });
});
