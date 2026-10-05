// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import {
  FlowEndpointPicker,
  type FlowEndpointPickerFlow,
} from "../components/FlowEndpointPicker";

const flows: FlowEndpointPickerFlow[] = [
  {
    id: "zeta-flow",
    name: "Zeta Flow",
    drafts: [
      { draftId: "default", label: "Default draft" },
      { draftId: "exp-a", label: "Experiment A" },
    ],
  },
  {
    id: "alpha-flow",
    name: "Alpha Flow",
    drafts: [{ draftId: "default", label: "Default draft" }],
  },
];

function openPicker(): void {
  fireEvent.click(screen.getByRole("button", { name: "Source picker" }));
}

function optionRows(): HTMLElement[] {
  return screen.getAllByRole("option");
}

describe("FlowEndpointPicker", () => {
  test("flows are sorted by name; drafts hidden unless showDrafts", () => {
    render(
      <FlowEndpointPicker
        flows={flows}
        value={null}
        onChange={vi.fn()}
        ariaLabel="Source picker"
      />,
    );
    openPicker();
    const search = screen.getByLabelText("Source picker: search flows");
    expect(search).toBeInTheDocument();
    // Sorted by name: Alpha before Zeta; no draft rows.
    expect(optionRows().map((o) => o.textContent)).toEqual([
      "Alpha Flowalpha-flow",
      "Zeta Flowzeta-flow",
    ]);
  });

  test("showDrafts lists each flow's drafts indented under it", () => {
    render(
      <FlowEndpointPicker
        flows={flows}
        value={null}
        onChange={vi.fn()}
        showDrafts
        ariaLabel="Source picker"
      />,
    );
    openPicker();
    const rows = optionRows();
    expect(rows.map((o) => o.textContent)).toEqual([
      "Alpha Flowalpha-flow",
      "Default draftdraft",
      "Zeta Flowzeta-flow",
      "Default draftdraft",
      "Experiment Adraft",
    ]);
    // Draft rows are indented (pl-7), flow rows are not (pl-2).
    expect(rows[0].className).toContain("pl-2");
    expect(rows[1].className).toContain("pl-7");
    expect(rows[2].className).toContain("pl-2");
    expect(rows[3].className).toContain("pl-7");
  });

  test("search filters by flow name; a matching draft label pulls its flow in", () => {
    render(
      <FlowEndpointPicker
        flows={flows}
        value={null}
        onChange={vi.fn()}
        showDrafts
        ariaLabel="Source picker"
      />,
    );
    openPicker();
    fireEvent.change(screen.getByLabelText("Source picker: search flows"), {
      target: { value: "experiment" },
    });
    // Only Zeta Flow (via its "Experiment A" draft) remains.
    expect(optionRows().map((o) => o.textContent)).toEqual([
      "Zeta Flowzeta-flow",
      "Experiment Adraft",
    ]);
  });

  test("picking a draft row reports flowId + draftId", () => {
    const onChange = vi.fn();
    render(
      <FlowEndpointPicker
        flows={flows}
        value={null}
        onChange={onChange}
        showDrafts
        ariaLabel="Source picker"
      />,
    );
    openPicker();
    fireEvent.change(screen.getByLabelText("Source picker: search flows"), {
      target: { value: "experiment" },
    });
    const draftRow = optionRows().find((o) =>
      o.textContent?.includes("Experiment A"),
    );
    expect(draftRow).toBeDefined();
    expect(draftRow?.getAttribute("aria-selected")).toBe("false");
    fireEvent.mouseDown(draftRow as HTMLElement);
    expect(onChange).toHaveBeenCalledWith({
      flowId: "zeta-flow",
      draftId: "exp-a",
    });
  });

  test("picking a flow row reports just the flowId (published)", () => {
    const onChange = vi.fn();
    render(
      <FlowEndpointPicker
        flows={flows}
        value={null}
        onChange={onChange}
        ariaLabel="Source picker"
      />,
    );
    openPicker();
    fireEvent.mouseDown(optionRows()[0]);
    expect(onChange).toHaveBeenCalledWith({ flowId: "alpha-flow" });
  });

  test("button shows the selected flow name and draft label", () => {
    render(
      <FlowEndpointPicker
        flows={flows}
        value={{ flowId: "zeta-flow", draftId: "exp-a" }}
        onChange={vi.fn()}
        showDrafts
        ariaLabel="Source picker"
      />,
    );
    const button = screen.getByRole("button", { name: "Source picker" });
    expect(button.textContent).toContain("Zeta Flow");
    expect(button.textContent).toContain("Experiment A");
  });
});
