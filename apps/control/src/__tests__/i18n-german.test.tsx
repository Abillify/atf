// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The dashboard renders in German under the German locale — components read
 * their texts through translate(), which follows the provider's locale.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApprovalsPanel } from "../components/ApprovalsPanel";
import { LocaleProvider, translate } from "../lib/i18n";
import { setActiveLocale } from "../lib/i18n/format";

vi.mock("../lib/auth/useAuth", () => ({ useAuth: () => ({ role: "viewer" }) }));

afterEach(() => setActiveLocale("en"));

describe("German locale", () => {
  test("components render their German texts, placeholders filled", () => {
    render(
      <LocaleProvider initialLocale="de">
        <ApprovalsPanel
          pending={[
            {
              id: "ap-1",
              executionId: "e-1",
              nodeId: "n-1",
              tool: "demo/case_lookup",
              args: {},
              requestedAt: new Date().toISOString(),
            },
          ]}
          onResolve={() => {}}
        />
      </LocaleProvider>,
    );
    expect(screen.getByText("Offene Freigaben")).toBeInTheDocument();
    expect(screen.getByText("wartet auf Freigabe")).toBeInTheDocument();
    expect(screen.getByText("Über diese Anfrage entscheidet ein Operator.")).toBeInTheDocument();
    expect(translate("commandPalette.noMatchesForQuery", { query: "abc" })).toBe(
      "Keine Treffer für „abc“.",
    );
  });

  test("English stays the default", () => {
    render(<ApprovalsPanel pending={[]} onResolve={() => {}} />);
    expect(screen.getByText("No tool calls are awaiting approval.")).toBeInTheDocument();
  });
});
