// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { OptimizePanel, emptyAdviceMessage, nodesWithCandidates } from "../components/OptimizePanel";
import type { FlowDefinition } from "../types/flow";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ ready: true, isAuthenticated: true }),
}));

const draft: FlowDefinition = {
  id: "n8n",
  name: "n8n",
  nodes: [
    {
      id: "n8n-responder",
      type: "llm",
      llm: { shortcut: "{{vars.model_main}}" },
      config: { routing: { strategy: "balanced", candidates: [{ shortcut: "qwen-lmstudio" }, { shortcut: "sonnet" }] } },
    } as FlowDefinition["nodes"][number],
  ],
  edges: [],
};
const empty = { nodesExamined: 0, qualityDataAvailable: true, recommendations: [] };

describe("emptyAdviceMessage", () => {
  test("Live: points at the canvas when only the draft declares candidates", () => {
    const text = emptyAdviceMessage({
      source: "live",
      advice: empty,
      flowId: "n8n",
      canvasCandidateNodes: nodesWithCandidates(draft),
      canvasLabel: "canvas",
    });
    expect(text).toMatch(/live version of n8n declares no routing candidates — only the canvas does \(n8n-responder\)/);
  });

  test("Canvas: says the canvas has none", () => {
    expect(
      emptyAdviceMessage({ source: "canvas", advice: empty, flowId: "n8n", canvasCandidateNodes: [], canvasLabel: "canvas" }),
    ).toMatch(/^The canvas declares no routing candidates/);
  });
});

describe("OptimizePanel", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderPanel = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OptimizePanel selectedFlowId="n8n" token={null} getCanvasDefinition={() => draft} />
      </QueryClientProvider>,
    );

  test("checks the canvas by default — the definition is posted, results shown", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          nodesExamined: 1,
          qualityDataAvailable: true,
          recommendations: [
            {
              flowId: "n8n",
              nodeId: "n8n-responder",
              currentModel: "bedrock/claude-sonnet-5",
              suggestedModel: "openai/qwen",
              expectedCostSavingPct: 90,
              expectedQualityLossPct: 2,
              source: "model-quality-registry",
            },
          ],
        }),
      ),
    );
    renderPanel();
    expect(screen.getByRole("button", { name: "Canvas" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Check routing recommendations" }));
    await waitFor(() => expect(screen.getByText("openai/qwen")).toBeInTheDocument());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).definition.id).toBe("n8n");
  });

  test("an older runtime without the canvas check says so instead of HTTP 404", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Check routing recommendations" }));
    expect(await screen.findByText(/can't check the canvas yet/)).toBeInTheDocument();
  });

  test("Live explains that only the canvas declares candidates", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(empty)));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    fireEvent.click(screen.getByRole("button", { name: "Check routing recommendations" }));
    await waitFor(() => expect(screen.getByText(/only the canvas does/)).toBeInTheDocument());
    const [, liveInit] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(liveInit?.method).toBeUndefined();
  });
});
