// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette, type CommandItem } from "../lib/ui/CommandPalette";

const items: CommandItem[] = [
  { id: "/studio", label: "Studio", hint: "Build flows", group: "Recherche & Optimierung" },
  { id: "/memory", label: "Memory", hint: "Long-term memory", group: "Recherche & Optimierung" },
  { id: "/graph", label: "Live Graph", hint: "Real-time", group: "Monitoring" },
  { id: "/tenants", label: "Tenants", hint: "Billing units", group: "Budgetierung" },
];

afterEach(cleanup);

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    render(
      <CommandPalette open={false} onClose={() => {}} items={items} onSelect={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a combobox + grouped options when open", () => {
    render(
      <CommandPalette open onClose={() => {}} items={items} onSelect={() => {}} />,
    );
    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBe(items.length);
    // group headers present
    expect(screen.getByText("Monitoring")).toBeTruthy();
    expect(screen.getByText("Budgetierung")).toBeTruthy();
  });

  it("filters options as the user types", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette open onClose={() => {}} items={items} onSelect={() => {}} />,
    );
    await user.type(screen.getByRole("combobox"), "tenants");
    const opts = screen.getAllByRole("option");
    expect(opts.length).toBe(1);
    expect(opts[0]!.textContent).toContain("Tenants");
  });

  it("shows a no-match message", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette open onClose={() => {}} items={items} onSelect={() => {}} />,
    );
    await user.type(screen.getByRole("combobox"), "zzzzzz");
    expect(screen.queryAllByRole("option").length).toBe(0);
    expect(screen.getByText(/no matches/i)).toBeTruthy();
  });

  it("selects the active option with Enter (keyboard nav)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette open onClose={onClose} items={items} onSelect={onSelect} />,
    );
    const input = screen.getByRole("combobox");
    await user.type(input, "memory");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "/memory" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the active option with ArrowDown and marks aria-selected", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette open onClose={() => {}} items={items} onSelect={() => {}} />,
    );
    const input = screen.getByRole("combobox");
    // aria-activedescendant points at some option initially
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    await user.keyboard("{ArrowDown}");
    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.length).toBe(1);
  });

  it("selects on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CommandPalette open onClose={() => {}} items={items} onSelect={onSelect} />,
    );
    await user.click(screen.getByText("Live Graph"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "/graph" }),
    );
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette open onClose={onClose} items={items} onSelect={() => {}} />,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
