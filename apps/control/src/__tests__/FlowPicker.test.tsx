// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { FlowPicker } from "../components/FlowPicker";
import type { FlowListEntry } from "../types/flow";

const entry = (id: string, name: string): FlowListEntry => ({
  id, name, source: "file", status: "file", version: 0, hasDraft: false,
  draftDirty: false, editable: false, nodeCount: 1, edgeCount: 0,
});
const flows = [entry("abby-pii", "Abby (PII-Vault)"), entry("contracts", "Contracts"), entry("intake", "Intake")];

describe("FlowPicker", () => {
  test("filters by name or id and picks with the keyboard", () => {
    const onChange = vi.fn();
    render(<FlowPicker flows={flows} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select flow to edit in Builder" }));
    const search = screen.getByLabelText("Search flows");
    fireEvent.change(search, { target: { value: "pii" } });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["+ New flow", "Abby (PII-Vault)abby-piifile"]);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("abby-pii");
  });

  test("offers a new flow and reports no matches", () => {
    const onChange = vi.fn();
    render(<FlowPicker flows={flows} value="contracts" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select flow to edit in Builder" }));
    fireEvent.change(screen.getByLabelText("Search flows"), { target: { value: "zzz" } });
    expect(screen.getByText(/No flow matches/)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("+ New flow"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
