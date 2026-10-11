// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Breadcrumbs, buildBreadcrumbs } from "../components/Breadcrumbs";
import { LocaleProvider } from "../lib/i18n";

afterEach(cleanup);

/** Render breadcrumbs in German — the trail labels come from the `de` catalog. */
function renderDe(pathname: string) {
  return render(
    <LocaleProvider initialLocale="de">
      <Breadcrumbs pathname={pathname} />
    </LocaleProvider>,
  );
}

describe("buildBreadcrumbs", () => {
  it("maps a route to its group + page (i18n keys, Req 9.7)", () => {
    expect(buildBreadcrumbs("/graph")).toEqual([
      { labelKey: "nav.group.monitoring" },
      { labelKey: "nav.graph", current: true },
    ]);
    expect(buildBreadcrumbs("/tenants")).toEqual([
      { labelKey: "nav.group.budgeting" },
      { labelKey: "nav.tenants", current: true },
    ]);
  });

  it("matches nested paths", () => {
    expect(buildBreadcrumbs("/flows/helpdesk")).toEqual([
      { labelKey: "nav.group.configuration" },
      { labelKey: "nav.flows", current: true },
    ]);
  });

  it("returns empty for an unknown route", () => {
    expect(buildBreadcrumbs("/nope")).toEqual([]);
  });
});

describe("Breadcrumbs", () => {
  it("renders group + current page with aria-current", () => {
    renderDe("/memory");
    // The accessible name comes from the de catalog (chrome.breadcrumb).
    const nav = screen.getByRole("navigation", { name: /brotkrümel/i });
    expect(nav.textContent).toContain("Recherche & Optimierung");
    expect(nav.textContent).toContain("Memory");
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Memory");
  });

  it("renders nothing for an unknown route", () => {
    const { container } = renderDe("/nope");
    expect(container.firstChild).toBeNull();
  });
});
