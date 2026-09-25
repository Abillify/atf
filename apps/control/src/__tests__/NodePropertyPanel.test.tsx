// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { NodePropertyPanel } from "../components/NodePropertyPanel";
import type { FlowNode } from "../types/flow";

function renderPanel(node: FlowNode) {
  const onNodeChange = vi.fn();
  render(
    <NodePropertyPanel
      node={node}
      edge={null}
      onNodeChange={onNodeChange}
      onDeleteNode={vi.fn()}
      onEdgeChange={vi.fn()}
      onDeleteEdge={vi.fn()}
    />,
  );
  return onNodeChange;
}

describe("NodePropertyPanel", () => {
  test("edits node config as JSON and ignores invalid input", () => {
    const onNodeChange = renderPanel({
      id: "answer",
      type: "llm",
      llm: { provider: "vllm-a", model: "m" },
      config: { maxToolSteps: 4 },
    });
    const editor = screen.getByRole("textbox", { name: /Node config/ });
    fireEvent.change(editor, { target: { value: "{ bad" } });
    expect(onNodeChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid JSON — not applied/)).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '{"maxToolSteps": 8}' } });
    expect(onNodeChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: { maxToolSteps: 8 } }),
    );
  });

  test("shows a named provider instance instead of coercing it to a protocol", () => {
    renderPanel({
      id: "answer",
      type: "llm",
      llm: { provider: "vllm-a", model: "m" },
    });
    expect(screen.getByLabelText("Provider")).toHaveValue("vllm-a");
  });

  test("keeps conditional parallel children intact", () => {
    renderPanel({
      id: "fan",
      type: "parallel",
      parallelNodes: ["a", { node: "b", condition: "x == 1" }],
    });
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(
      (screen.getByRole("textbox", { name: /Children/ }) as HTMLTextAreaElement).value,
    ).toContain('"condition": "x == 1"');
  });

  test("model parameters keep unknown keys when a known one changes", () => {
    const onNodeChange = renderPanel({
      id: "answer",
      type: "llm",
      llm: {
        provider: "openai",
        model: "m",
        parameters: { temperature: 0.2, chatTemplateKwargs: { thinking: false } },
      },
    });
    fireEvent.change(screen.getByLabelText("Max tokens"), {
      target: { value: "512" },
    });
    expect(onNodeChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({
          parameters: {
            temperature: 0.2,
            maxTokens: 512,
            chatTemplateKwargs: { thinking: false },
          },
        }),
      }),
    );
  });

  test("editing a shortcut node never invents provider/model", () => {
    const onNodeChange = renderPanel({
      id: "answer",
      type: "llm",
      llm: { shortcut: "{{vars.model_fast}}" } as FlowNode["llm"],
    });
    expect(screen.getByLabelText("Shortcut")).toHaveValue("{{vars.model_fast}}");
    fireEvent.change(screen.getByLabelText("Temperature"), {
      target: { value: "0.3" },
    });
    expect(onNodeChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        llm: { shortcut: "{{vars.model_fast}}", parameters: { temperature: 0.3 } },
      }),
    );
  });

  test("keeps a {{vars.*}} placeholder in a numeric field", () => {
    const onNodeChange = renderPanel({
      id: "answer",
      type: "llm",
      llm: {
        shortcut: "fast-pool",
        parameters: { maxTokens: "{{vars.max_tokens_responder}}" as unknown as number },
      } as FlowNode["llm"],
    });
    const maxTokens = screen.getByLabelText("Max tokens");
    expect(maxTokens).toHaveValue("{{vars.max_tokens_responder}}");
    fireEvent.change(maxTokens, { target: { value: "{{vars.max_tokens_small}}" } });
    expect(onNodeChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({
          parameters: { maxTokens: "{{vars.max_tokens_small}}" },
        }),
      }),
    );
  });
});
