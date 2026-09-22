// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Breadcrumbs, buildBreadcrumbs } from "../components/Breadcrumbs";

afterEach(cleanup);

describe("buildBreadcrumbs", () => {
  it("maps a route to its group + page", () => {
    expect(buildBreadcrumbs("/graph")).toEqual([
      { label: "Monitoring" },
      { label: "Live Graph", current: true },
    ]);
    expect(buildBreadcrumbs("/tenants")).toEqual([
      { label: "Budgetierung" },
      { label: "Tenants", current: true },
    ]);
  });

  it("matches nested paths", () => {
    expect(buildBreadcrumbs("/flows/helpdesk")).toEqual([
      { label: "Konfiguration" },
      { label: "Flows", current: true },
    ]);
  });

  it("returns empty for an unknown route", () => {
    expect(buildBreadcrumbs("/nope")).toEqual([]);
  });
});

describe("Breadcrumbs", () => {
  it("renders group + current page with aria-current", () => {
    render(<Breadcrumbs pathname="/memory" />);
    const nav = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(nav.textContent).toContain("Recherche & Optimierung");
    expect(nav.textContent).toContain("Memory");
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Memory");
  });

  it("renders nothing for an unknown route", () => {
    const { container } = render(<Breadcrumbs pathname="/nope" />);
    expect(container.firstChild).toBeNull();
  });
});
