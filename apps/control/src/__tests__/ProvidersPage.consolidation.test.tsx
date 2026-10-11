// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.9 — /providers consolidates monitoring and the provider test bench
 * (formerly /provider-testing) into one tabbed page.
 */

import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import ProvidersPage from "../app/(dashboard)/providers/page";

vi.mock("../lib/auth/useAuth", () => ({
	useAuth: () => ({ token: undefined, ready: true, isAuthenticated: true }),
}));
vi.mock("../components/ProviderTestingPanel", () => ({
	ProviderTestingPanel: () => <div>test bench panel</div>,
}));

function mockBackend() {
	const fetchMock = vi.fn(async (url: string) => {
		if (url.includes("/admin/provider-keys")) {
			return { ok: true, status: 200, json: async () => ({ keys: [] }) };
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({
				providers: [],
				pools: [],
				global: { queueDepth: 0, activeExecutions: 0 },
			}),
		};
	});
	global.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProvidersPage />
		</QueryClientProvider>,
	);
}

afterEach(() => vi.restoreAllMocks());

describe("/providers consolidation (Req 9.9)", () => {
	test("shows Monitoring and Test bench tabs, monitoring active by default", async () => {
		mockBackend();
		renderPage();
		const tablist = await screen.findByRole("tablist");
		expect(tablist).toBeTruthy();
		const monitoring = screen.getByRole("tab", { name: "Monitoring" });
		const testing = screen.getByRole("tab", { name: "Test bench" });
		expect(monitoring.getAttribute("aria-selected")).toBe("true");
		expect(testing.getAttribute("aria-selected")).toBe("false");
		expect(
			await screen.findByRole("heading", { name: "Provider Monitoring" }),
		).toBeTruthy();
		expect(screen.queryByText("test bench panel")).toBeNull();
	});

	test("switching to Test bench mounts the provider test bench panel", async () => {
		mockBackend();
		renderPage();
		fireEvent.click(
			await screen.findByRole("tab", { name: "Test bench" }),
		);
		expect(await screen.findByText("test bench panel")).toBeTruthy();
		expect(
			screen.queryByRole("heading", { name: "Provider Monitoring" }),
		).toBeNull();
	});
});
