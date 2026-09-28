// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { FlowMultiSelect } from "../components/FlowMultiSelect";

const names = new Map([
  ["casework", "Casework – Files"],
  ["abby", "Abby"],
]);

describe("FlowMultiSelect", () => {
  test("lists flows by name, sorted, and searches name or id", () => {
    const onChange = vi.fn();
    render(<FlowMultiSelect label="Flows" options={["casework", "zeta", "abby"]} names={names} value={[]} onChange={onChange} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
      "Abbyabby",
      "Casework – Filescasework",
      "zeta",
    ]);
    fireEvent.change(screen.getByLabelText("Flows: search flows"), { target: { value: "files" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(["casework"]);
  });
});
