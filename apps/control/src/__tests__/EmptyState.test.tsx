// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, test } from "vitest";
import { EmptyState } from "../lib/ui";

describe("EmptyState (Req 9.9)", () => {
  test("renders title, description and action", () => {
    render(
      <EmptyState
        title="No flows yet."
        description="Create one in Studio."
        action={<button type="button">+ New flow</button>}
      />,
    );
    expect(screen.getByText("No flows yet.")).toBeTruthy();
    expect(screen.getByText("Create one in Studio.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New flow" })).toBeTruthy();
  });

  test("renders an icon without description or action", () => {
    const { container } = render(<EmptyState icon={Inbox} title="All clear." />);
    expect(screen.getByText("All clear.")).toBeTruthy();
    // The icon circle is decorative — hidden from assistive tech.
    const iconWrap = container.querySelector("[aria-hidden]");
    expect(iconWrap).not.toBeNull();
    expect(iconWrap?.querySelector("svg")).not.toBeNull();
  });

  test("omits the icon wrapper when no icon is given", () => {
    const { container } = render(<EmptyState title="Nothing here." />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });
});
