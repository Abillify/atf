// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { BoundaryPanel } from "../components/BoundaryPanel";
import type { PinnedRun } from "../lib/run-samples";

vi.mock("../lib/run-samples", async (orig) => ({
  ...(await orig<typeof import("../lib/run-samples")>()),
  fetchFlowRuns: vi.fn().mockResolvedValue([]),
}));

const pinned: PinnedRun = {
  executionId: "x1",
  flowId: "support",
  startedAt: "2026-09-25T10:00:00.000Z",
  preview: "Where is my order?",
  sample: {
    query: "Where is my order?",
    messageCount: 3,
    context: { userName: "Erika", language: "de", claims: { tier: "gold" } },
  },
  response: "On its way.",
  responseNodeId: "answer",
};
const boundaries = { entryId: "triage", exits: [{ nodeId: "answer", kind: "last" as const }] };
const runs = (p: PinnedRun | null) => ({ flowId: "support", pinned: p, onPin: () => {} });

describe("BoundaryPanel", () => {
  test("Start shows the entry and the pinned request's input", () => {
    const onSelectNode = vi.fn();
    render(<BoundaryPanel kind="start" boundaries={boundaries} runs={runs(pinned)} onSelectNode={onSelectNode} />);
    expect(screen.getByLabelText("Pinned query")).toHaveTextContent("Where is my order?");
    expect(screen.getByText("3 message(s) in the request")).toBeInTheDocument();
    expect(screen.getByText("Erika")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "triage" }));
    expect(onSelectNode).toHaveBeenCalledWith("triage");
  });

  test("End shows the exits and the pinned answer with the node that gave it", () => {
    render(<BoundaryPanel kind="end" boundaries={boundaries} runs={runs(pinned)} />);
    expect(screen.getByText("— no outgoing edge")).toBeInTheDocument();
    expect(screen.getByLabelText("Pinned answer")).toHaveTextContent("On its way.");
    expect(screen.getByText(/Answered by/)).toHaveTextContent("answer");
  });

  test("End explains a pin without a recorded answer", () => {
    const { response: _r, responseNodeId: _n, ...old } = pinned;
    render(<BoundaryPanel kind="end" boundaries={boundaries} runs={runs(old)} />);
    expect(screen.getByText(/pin it\s+again/)).toBeInTheDocument();
  });

  test("the traced run's request and answer are shown too", () => {
    const answer = JSON.stringify({ choices: [{ message: { content: "Live answer" } }] });
    render(
      <BoundaryPanel
        kind="end"
        boundaries={boundaries}
        runs={runs(null)}
        current={{ id: "__response__", label: "Response", status: "completed", response: answer } as never}
      />,
    );
    expect(screen.getByLabelText("Current answer")).toHaveTextContent("Live answer");
    expect(screen.getByText(/Pin a recorded request/)).toBeInTheDocument();
  });
});

describe("BoundaryPanel Start — run input", () => {
  test("shows the traced run's request messages, input values and metadata", async () => {
    const trace = {
      execution_id: "run-7",
      flow_id: "support",
      flow_version: "1.2.3",
      status: "completed",
      started_at: "2026-09-25T10:00:00.000Z",
      finished_at: "2026-09-25T10:00:02.000Z",
      context: { chat_id: "chat-1", session_id: "sess-9", jwt_claims: { tier: "gold" } },
      input_messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Where is my order?" }] },
      ],
    };
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.endsWith("/sample")
              ? { ...pinned, executionId: "run-7", sample: { query: "Where is my order?", messageCount: 2, context: { chatId: "chat-1" } } }
              : trace,
          ),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<BoundaryPanel kind="start" boundaries={boundaries} runs={runs(null)} runExecutionId="run-7" />);
      expect(await screen.findByText("Request — 2 message(s)")).toBeInTheDocument();
      expect(screen.getByLabelText("Message 2 (user)")).toHaveTextContent("Where is my order?");
      expect(await screen.findByLabelText("Current query")).toHaveTextContent("Where is my order?");
      expect(screen.getByText("sess-9")).toBeInTheDocument();
      expect(screen.getByText("1.2.3")).toBeInTheDocument();
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(
        expect.arrayContaining([expect.stringContaining("/monitoring/debug/run-7")]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
