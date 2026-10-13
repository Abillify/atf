// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DensityProvider,
  useDensity,
} from "../lib/theme/DensityProvider";

function Probe() {
  const { density, toggle, setDensity } = useDensity();
  return (
    <div>
      <span data-testid="d">{density}</span>
      <button type="button" onClick={toggle}>toggle</button>
      <button type="button" onClick={() => setDensity("compact")}>set-compact</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-density");
});
afterEach(cleanup);

describe("DensityProvider", () => {
  it("defaults to comfortable and sets data-density on <html>", async () => {
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    expect(screen.getByTestId("d").textContent).toBe("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  it("toggles to compact, persists, and updates <html>", async () => {
    const user = userEvent.setup();
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    await user.click(screen.getByText("toggle"));
    expect(screen.getByTestId("d").textContent).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("aiperator_density")).toBe("compact");
  });

  it("hydrates from a persisted value", async () => {
    localStorage.setItem("aiperator_density", "compact");
    render(
      <DensityProvider>
        <Probe />
      </DensityProvider>,
    );
    // hydration effect runs on mount
    await act(async () => {});
    expect(screen.getByTestId("d").textContent).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
  });
});
