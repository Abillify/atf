// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { ConfigForm } from "../components/ConfigForm";
import { NodeTypeDocs } from "../components/NodeTypeDocs";
import type { ConfigField, NodeTypeDoc } from "../lib/node-types";

const fields: ConfigField[] = [
  { key: "maxToolSteps", kind: "number", label: "Max tool steps", integer: true, min: 1, description: "Upper bound on model↔tool round trips in one turn. More text." },
  { key: "clientTools", kind: "boolean", label: "Accept client tools", default: true, description: "Whether caller tools are offered to this node." },
  { key: "inputFilter", kind: "enum", label: "Run only for attachments", options: ["attachments", "current-turn-attachments"], description: "Skip unless attachments are present in the conversation." },
  {
    key: "toolResultBudget", kind: "object", label: "Tool result budget", description: "Caps on tool output fed back to the model.",
    fields: [{ key: "perResultChars", kind: "number", label: "Per result (chars)", min: 1000, description: "Max characters kept from one tool result." }],
  },
  { key: "outputSchema", kind: "json", label: "Structured output schema", description: "Makes the node return JSON.", example: { schema: { type: "object" } } },
];
const common: ConfigField[] = [
  { key: "fallbackNodeId", kind: "node-ref", label: "Fallback node", description: "Node executed when this node fails." },
];

function renderForm(value: Record<string, unknown> | undefined) {
  const onChange = vi.fn();
  const onFocusField = vi.fn();
  render(
    <ConfigForm
      fields={fields}
      common={common}
      value={value}
      onChange={onChange}
      nodeIds={["answer", "fallback"]}
      tools={["vectorsearch/search"]}
      shortcuts={["fast-pool"]}
      onFocusField={onFocusField}
    />,
  );
  return { onChange, onFocusField };
}

describe("ConfigForm", () => {
  test("renders a control per field kind and writes typed values", () => {
    const { onChange } = renderForm({ maxToolSteps: 4 });
    fireEvent.change(screen.getByLabelText("Max tool steps"), { target: { value: "8" } });
    expect(onChange).toHaveBeenLastCalledWith({ maxToolSteps: 8 });

    fireEvent.change(screen.getByLabelText("Accept client tools"), { target: { value: "false" } });
    expect(onChange).toHaveBeenLastCalledWith({ maxToolSteps: 4, clientTools: false });
    expect(screen.getByRole("option", { name: "— default (on) —" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Run only for attachments"), { target: { value: "attachments" } });
    expect(onChange).toHaveBeenLastCalledWith({ maxToolSteps: 4, inputFilter: "attachments" });
  });

  test("nested objects edit their sub-keys; node refs offer canvas nodes", () => {
    const { onChange } = renderForm(undefined);
    fireEvent.change(screen.getByLabelText("Per result (chars)"), { target: { value: "5000" } });
    expect(onChange).toHaveBeenLastCalledWith({ toolResultBudget: { perResultChars: 5000 } });
    const fallback = screen.getByLabelText("Fallback node");
    expect(Array.from((fallback as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "answer", "fallback"]);
  });

  test("keeps undocumented keys and lets them be edited as JSON", () => {
    const { onChange } = renderForm({ maxToolSteps: 4, passQueryAsContext: true });
    const other = screen.getByRole("textbox", { name: /Other keys \(1\)/ });
    expect((other as HTMLTextAreaElement).value).toContain("passQueryAsContext");
    fireEvent.change(other, { target: { value: '{"passQueryAsContext": false}' } });
    expect(onChange).toHaveBeenLastCalledWith({ maxToolSteps: 4, passQueryAsContext: false });
  });

  test("reset removes a key; JSON fields can insert their example", () => {
    const { onChange } = renderForm({ maxToolSteps: 4 });
    fireEvent.click(screen.getAllByRole("button", { name: "reset" })[0]!);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Insert example" }));
    expect(onChange).toHaveBeenLastCalledWith({ maxToolSteps: 4, outputSchema: { schema: { type: "object" } } });
  });

  test("reports the focused field for the docs panel", () => {
    const { onFocusField } = renderForm(undefined);
    fireEvent.focus(screen.getByLabelText("Max tool steps"));
    expect(onFocusField).toHaveBeenCalledWith("maxToolSteps");
  });
});

describe("NodeTypeDocs", () => {
  const doc: NodeTypeDoc = {
    type: "llm",
    title: "LLM",
    summary: "Streaming model call.",
    description: "First paragraph with `code`.\n\nSecond paragraph with **bold**.",
    whenToUse: ["Answering"],
    topLevel: [{ key: "llm", usage: "recommended", description: "Model to call." }],
    config: fields,
    examples: [{ title: "Example", yaml: "- id: a\n  type: llm" }],
    notes: ["A note."],
  };

  test("renders the complete reference and highlights the focused field", () => {
    const { container } = render(<NodeTypeDocs doc={doc} common={common} focusedField="clientTools" />);
    expect(screen.getByText("LLM node")).toBeInTheDocument();
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    for (const f of [...fields, ...common]) {
      expect(container.querySelector(`[data-doc-key="${f.key}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-doc-key="clientTools"]')!.className).toContain("border-primary");
    expect(screen.getByText(/Default: true/)).toBeInTheDocument();
    expect(screen.getByText("A note.")).toBeInTheDocument();
  });

  test("renders llm model fields with dotted keys and marks the focused one", () => {
    const llmFields: ConfigField[] = [
      { key: "llm.shortcut", kind: "string", label: "Shortcut", description: "Named model pool to use." },
      {
        key: "llm.parameters",
        kind: "object",
        label: "Parameters",
        description: "Sampling parameters for the call.",
        fields: [{ key: "temperature", kind: "number", label: "Temperature", description: "Sampling temperature." }],
      },
    ];
    const { container } = render(
      <NodeTypeDocs doc={doc} common={common} llmFields={llmFields} focusedField="llm.parameters.temperature" />,
    );
    expect(screen.getByText(/Model selection/)).toBeInTheDocument();
    // Sub-fields carry their parent's dotted prefix so panel focus matches.
    expect(container.querySelector('[data-doc-key="llm.shortcut"]')).not.toBeNull();
    expect(container.querySelector('[data-doc-key="llm.parameters.temperature"]')).not.toBeNull();
    expect(
      container.querySelector('[data-doc-key="llm.parameters.temperature"]')
        ?.className,
    ).toContain("border-primary");
    // Config sub-fields stay bare — the config form reports bare keys.
    expect(container.querySelector('[data-doc-key="perResultChars"]')).not.toBeNull();
  });
});
