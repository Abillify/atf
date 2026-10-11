// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.9 — /flows consolidates the flow registry and the Flow Diff Viewer
 * (formerly /flow-diff) into one tabbed page.
 */

import type React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import FlowsPage from "../app/(dashboard)/flows/page";

vi.mock("../lib/auth/useAuth", () => ({
	useAuth: () => ({ token: undefined, ready: true, isAuthenticated: true }),
}));
vi.mock("../components/FlowsTab", () => ({
	FlowsTab: () => <div>flows registry</div>,
	studioHref: (id?: string) => (id ? `/studio?flow=${id}` : "/studio"),
}));
vi.mock("../components/FlowDiffTab", () => ({
	FlowDiffTab: () => <div>flow diff panel</div>,
}));

afterEach(() => vi.restoreAllMocks());

describe("/flows consolidation (Req 9.9)", () => {
	test("shows Registry and Diff tabs, registry active by default", async () => {
		render(<FlowsPage />);
		const tablist = await screen.findByRole("tablist");
		expect(tablist).toBeTruthy();
		expect(
			screen.getByRole("tab", { name: "Registry" }).getAttribute(
				"aria-selected",
			),
		).toBe("true");
		expect(
			screen.getByRole("tab", { name: "Diff" }).getAttribute(
				"aria-selected",
			),
		).toBe("false");
		expect(await screen.findByText("flows registry")).toBeTruthy();
		expect(screen.queryByText("flow diff panel")).toBeNull();
	});

	test("switching to Diff mounts the diff viewer panel", async () => {
		render(<FlowsPage />);
		fireEvent.click(await screen.findByRole("tab", { name: "Diff" }));
		expect(await screen.findByText("flow diff panel")).toBeTruthy();
		expect(screen.queryByText("flows registry")).toBeNull();
	});

	test("?tab=diff deep-link opens the Diff tab directly", async () => {
		window.history.pushState({}, "", "/flows?tab=diff");
		try {
			render(<FlowsPage />);
			expect(await screen.findByText("flow diff panel")).toBeTruthy();
			expect(
				screen.getByRole("tab", { name: "Diff" }).getAttribute(
					"aria-selected",
				),
			).toBe("true");
		} finally {
			window.history.pushState({}, "", "/");
		}
	});
});
