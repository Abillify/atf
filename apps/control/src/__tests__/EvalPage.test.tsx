// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import EvalPage from "../app/(dashboard)/eval/page";

vi.mock("../lib/auth/useAuth", () => ({
	useAuth: () => ({ token: undefined, ready: true, isAuthenticated: true, role: "admin" }),
}));
vi.mock("../components/EvalRunsPanel", () => ({ EvalRunsPanel: () => null }));

const sampleCase = {
	id: "case-1",
	flowId: "helpdesk",
	prompt: "Where is my invoice?",
	createdBy: "anonymous",
	tenantId: "default",
	createdAt: "2026-01-01T00:00:00Z",
};

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<EvalPage />
		</QueryClientProvider>,
	);
}

function mockBackend(deleteResponse: { status: number; body?: unknown }) {
	let cases = [sampleCase];
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		if (init?.method === "DELETE") {
			if (deleteResponse.status < 300) cases = [];
			return {
				ok: deleteResponse.status < 300,
				status: deleteResponse.status,
				json: async () => deleteResponse.body ?? {},
			};
		}
		return { ok: true, status: 200, json: async () => ({ cases }) };
	});
	global.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

afterEach(() => vi.restoreAllMocks());

describe("EvalPage delete", () => {
	test("asks for confirmation before deleting, then removes the case", async () => {
		const fetchMock = mockBackend({
			status: 200,
			body: { id: "case-1", removed: true },
		});
		renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Delete eval case case-1" }),
		);
		expect(
			fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
		).toBe(false);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Confirm delete of eval case case-1",
			}),
		);
		await waitFor(() =>
			expect(screen.getByText(/No eval cases found/)).toBeTruthy(),
		);
		const del = fetchMock.mock.calls.find(
			([, init]) => init?.method === "DELETE",
		);
		expect(del?.[0]).toContain("/eval/cases/case-1");
	});

	test("cancel disarms the row without deleting", async () => {
		const fetchMock = mockBackend({ status: 200 });
		renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Delete eval case case-1" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			screen.getByRole("button", { name: "Delete eval case case-1" }),
		).toBeTruthy();
		expect(
			fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
		).toBe(false);
	});

	test("shows the backend's error message when the delete fails", async () => {
		mockBackend({
			status: 403,
			body: { error: { message: "Missing permission monitoring:write" } },
		});
		renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Delete eval case case-1" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Confirm delete of eval case case-1",
			}),
		);
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Missing permission monitoring:write",
		);
	});
});
