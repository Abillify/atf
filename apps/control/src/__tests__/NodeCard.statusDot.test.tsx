// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { NodeState } from "../components/graph/graphUtils";
import { NodeCard } from "../components/graph/NodeRenderer";

function state(status: NodeState["status"]): NodeState {
	return { id: "n", label: "Node", status, latency_ms: null };
}

const dot = (c: HTMLElement) =>
	c.querySelector('[title="pending"], [title="completed"]');

describe("NodeCard status dot", () => {
	test("the compact editor card hides the empty pending dot (it looked like a port)", () => {
		const { container } = render(<NodeCard state={state("pending")} compact />);
		expect(dot(container)).toBeNull();
	});

	test("the compact card still shows run results", () => {
		const { container } = render(
			<NodeCard state={state("completed")} compact />,
		);
		expect(dot(container)).not.toBeNull();
	});

	test("the monitor card keeps the pending dot", () => {
		const { container } = render(<NodeCard state={state("pending")} />);
		expect(dot(container)).not.toBeNull();
	});
});
