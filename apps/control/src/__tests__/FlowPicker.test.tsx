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
    render(<FlowPicker emptyOption="+ New flow" ariaLabel="Select flow to edit in Builder" flows={flows} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select flow to edit in Builder" }));
    const search = screen.getByLabelText("Search flows");
    fireEvent.change(search, { target: { value: "pii" } });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["+ New flow", "Abby (PII-Vault)abby-piifile"]);
    // The first match is active while searching — Enter picks it directly.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("abby-pii");
  });

  test("lists the flows alphabetically by name, whatever order they arrive in", () => {
    const unsorted = [
      entry("vectorsearch", "Vector Search"),
      entry("abby", "abby"),
      entry("research-2", "Research 10"),
      entry("research-1", "Research 9"),
      entry("abby-pii", "Abby (PII-Vault)"),
    ];
    render(<FlowPicker emptyOption="+ New flow" ariaLabel="Select flow to edit in Builder" flows={unsorted} value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Select flow to edit in Builder" }));
    const names = screen.getAllByRole("option").slice(1).map((o) => o.textContent);
    expect(names).toEqual([
      "abbyabbyfile",
      "Abby (PII-Vault)abby-piifile",
      "Research 9research-1file",
      "Research 10research-2file",
      "Vector Searchvectorsearchfile",
    ]);
  });

  test("offers a new flow and reports no matches", () => {
    const onChange = vi.fn();
    render(<FlowPicker emptyOption="+ New flow" ariaLabel="Select flow to edit in Builder" flows={flows} value="contracts" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Select flow to edit in Builder" }));
    fireEvent.change(screen.getByLabelText("Search flows"), { target: { value: "zzz" } });
    expect(screen.getByText(/No flow matches/)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("+ New flow"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("FlowPicker outside the Studio", () => {
  test("has no empty entry by default and shows the placeholder", () => {
    const onChange = vi.fn();
    render(<FlowPicker flows={[entry("b", "Beta"), entry("a", "Alpha")]} value="" onChange={onChange} placeholder="— select flow —" />);
    expect(screen.getByRole("button", { name: "Select flow" })).toHaveTextContent("— select flow —");
    fireEvent.click(screen.getByRole("button", { name: "Select flow" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Alphaafile", "Betabfile"]);
  });

  test("a filter's empty entry picks the empty value", () => {
    const onChange = vi.fn();
    render(<FlowPicker flows={[{ id: "a", name: "a" }]} value="a" onChange={onChange} emptyOption="All flows" />);
    fireEvent.click(screen.getByRole("button", { name: "Select flow" }));
    fireEvent.mouseDown(screen.getByText("All flows"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
