// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import {
	FlowSettingsPanel,
	renameFlowVariable,
} from "../components/NodePropertyPanel";
import {
	convertVar,
	countVarUsages,
	variableValueGroups,
} from "../components/VariablesEditor";
import { insideCalculation } from "../lib/formula";
import type { FlowDefinition } from "../types/flow";
import { FLOW_REFERENCE } from "../../../runtime/src/graph/flow-reference-data";

vi.mock("../lib/auth/useAuth", () => ({
	useAuth: () => ({ token: undefined, ready: true, isAuthenticated: true }),
}));

const flow: FlowDefinition = {
	id: "f",
	name: "F",
	variables: {
		model_worker: "thinking-pool",
		max_tokens: 40576,
		verbose: true,
	},
	nodes: [
		{
			id: "a",
			type: "llm",
			llm: { shortcut: "{{vars.model_worker}}" },
			config: {
				maxTokens: "{{vars.max_tokens}}",
				note: "vars.model_worker_x stays",
			},
		},
	],
	edges: [{ source: "a", target: "a", conditions: "vars.verbose == true" }],
} as unknown as FlowDefinition;

const catalog = {
	common: [],
	types: [],
	tools: [],
	shortcuts: ["fast-pool", "qwen-lmstudio"],
	shortcutInfo: {
		"fast-pool": "pool (fallback): qwen-lmstudio, haiku",
		"qwen-lmstudio": "openai · qwen/qwen3.6-35b-a3b",
	},
	models: ["qwen/qwen3.6-35b-a3b"],
	constants: { budget: 300 },
	publicEnv: { FLOW_PUBLIC_REGION: "eu" },
	reference: FLOW_REFERENCE,
};

function Harness({
	onFlow,
	evaluate,
	initial = flow,
}: {
	onFlow: (f: FlowDefinition) => void;
	evaluate?: (v: Record<string, unknown>) => Promise<{
		values: Record<string, unknown>;
		errors: Array<{ name: string; message: string }>;
	}>;
	initial?: FlowDefinition;
}) {
	const [f, setF] = useState(initial);
	return (
		<FlowSettingsPanel
			flow={f}
			idEditable={false}
			catalog={catalog}
			{...(evaluate ? { evaluateVariables: evaluate } : {})}
			onChange={(next) => {
				setF(next);
				onFlow(next);
			}}
		/>
	);
}

describe("VariablesEditor helpers", () => {
	test("counts references without matching longer names", () => {
		expect(
			countVarUsages(
				["model_worker", "max_tokens"],
				JSON.stringify(flow.nodes),
			),
		).toEqual({ model_worker: 1, max_tokens: 1 });
	});

	test("converts values between types", () => {
		expect(convertVar(12, "string")).toBe("12");
		expect(convertVar("12", "number")).toBe(12);
		expect(convertVar("abc", "number")).toBe(0);
		expect(convertVar("true", "boolean")).toBe(true);
		expect(convertVar("x", "json")).toEqual({});
	});

	test("renaming rewrites references and keeps key order", () => {
		const next = renameFlowVariable(flow, "model_worker", "worker_model");
		expect(Object.keys(next.variables ?? {})).toEqual([
			"worker_model",
			"max_tokens",
			"verbose",
		]);
		expect(Object.keys(next)).toEqual(Object.keys(flow));
		const text = JSON.stringify(next.nodes);
		expect(text).toContain("{{vars.worker_model}}");
		expect(text).toContain("vars.model_worker_x stays");
	});
});

describe("FlowSettingsPanel variables table", () => {
	test("shows one typed row per variable with its usage", () => {
		render(<Harness onFlow={() => {}} />);
		expect(
			(screen.getByLabelText("Value of model_worker") as HTMLInputElement)
				.value,
		).toBe("thinking-pool");
		expect(
			(screen.getByLabelText("Type of max_tokens") as HTMLSelectElement).value,
		).toBe("number");
		expect(
			(screen.getByLabelText("Value of verbose") as HTMLInputElement).checked,
		).toBe(true);
		expect(screen.getAllByText(/used 1×/)).toHaveLength(3);
	});

	test("edits a value, adds a variable and renames on blur", () => {
		let last: FlowDefinition = flow;
		render(<Harness onFlow={(f) => (last = f)} />);
		fireEvent.change(screen.getByLabelText("Value of max_tokens"), {
			target: { value: "1024" },
		});
		expect(last.variables?.["max_tokens"]).toBe(1024);

		fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
		expect(last.variables?.["var_1"]).toBe("");

		const name = screen.getByLabelText("Variable name model_worker");
		fireEvent.change(name, { target: { value: "worker" } });
		fireEvent.blur(name);
		expect(last.variables?.["worker"]).toBe("thinking-pool");
		expect(JSON.stringify(last.nodes)).toContain("{{vars.worker}}");
	});

	test("rejects an invalid or duplicate name", () => {
		let last: FlowDefinition = flow;
		render(<Harness onFlow={(f) => (last = f)} />);
		const name = screen.getByLabelText("Variable name model_worker");
		fireEvent.change(name, { target: { value: "max_tokens" } });
		expect(screen.getByText("Name already in use.")).toBeTruthy();
		fireEvent.blur(name);
		expect(last.variables).toBe(flow.variables);
		fireEvent.change(name, { target: { value: "1bad" } });
		expect(screen.getByText(/must not start with a digit/)).toBeTruthy();
	});

	test("asks before deleting a referenced variable", () => {
		let last: FlowDefinition = flow;
		render(<Harness onFlow={(f) => (last = f)} />);
		fireEvent.click(
			screen.getByRole("button", { name: "Delete variable verbose" }),
		);
		expect(screen.getByRole("alert").textContent).toContain("Still used 1×");
		fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
		expect(last.variables).not.toHaveProperty("verbose");
	});

	test("ƒx opens the expression builder; a shortcut replaces the value", () => {
		let last: FlowDefinition = flow;
		render(<Harness onFlow={(f) => (last = f)} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open the expression builder for Value of model_worker",
			}),
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Model shortcuts")).toBeTruthy();
		expect(
			within(dialog).getByText("openai · qwen/qwen3.6-35b-a3b"),
		).toBeTruthy();
		expect(
			within(dialog).getByText("Constants"),
		).toBeTruthy();
		expect(
			within(dialog).getByRole("toolbar", { name: "Calculation operators" }),
		).toBeTruthy();
		fireEvent.click(within(dialog).getByText("fast-pool"));
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
		expect(last.variables?.model_worker).toBe("fast-pool");
	});

	test("the ƒx offers other variables, constants, env, node results and calculations", () => {
		const groups = variableValueGroups(
			catalog,
			flow.variables ?? {},
			"model_worker",
			[
				{
					id: "triage",
					type: "classifier",
					classifierSchema: {
						classKey: "route",
						schema: { type: "object", properties: { route: { type: "string" } } },
					},
				},
			] as never,
		);
		const titles = groups.map((g) => g.title);
		expect(titles).toEqual(
			expect.arrayContaining([
				"Flow variables",
				"Constants",
				"Environment",
				"Node results",
				"Request & user",
				"Calculation",
				"Model shortcuts",
				"Models",
			]),
		);
		const byTitle = (t: string) => groups.find((g) => g.title === t);
		expect(byTitle("Flow variables")?.symbols.map((x) => x.path)).not.toContain(
			"vars.model_worker",
		);
		expect(byTitle("Constants")?.symbols[0]).toMatchObject({
			insert: "{{const.budget}}",
			calcInsert: "const.budget",
		});
		expect(byTitle("Environment")?.symbols[0]?.insert).toBe("{{env.FLOW_PUBLIC_REGION}}");
		// Node results are grouped per node; in a variable they are allowed
		// (rendered where the variable is used).
		const nodeField = byTitle("Node results")?.symbols[0];
		expect(nodeField).toMatchObject({
			path: "node.triage.classification.route",
			section: "triage (classifier)",
		});
		expect(nodeField?.unavailable).toBeUndefined();
		// Without constants/env the groups explain how to get them.
		const bare = variableValueGroups(undefined, {}, undefined);
		expect(bare.find((g) => g.title === "Constants")?.symbols[0]?.unavailable).toMatch(
			/constants.yaml/,
		);
	});

	test("inside a calculation the builder inserts a reference bare", () => {
		expect(insideCalculation("{{= 1 + ", 8)).toBe(true);
		expect(insideCalculation("{{= 1 }} and ", 13)).toBe(false);
		let last: FlowDefinition = flow;
		render(<Harness onFlow={(f) => (last = f)} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open the expression builder for Value of model_worker",
			}),
		);
		const dialog = screen.getByRole("dialog");
		const area = within(dialog).getByLabelText(
			"Variable model_worker",
		) as HTMLTextAreaElement;
		fireEvent.change(area, { target: { value: "{{= 2 *  }}" } });
		area.setSelectionRange(8, 8);
		fireEvent.click(within(dialog).getByText("{{const.budget}}"));
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
		expect(last.variables?.model_worker).toBe("{{= 2 * const.budget }}");
	});

	test("a number opens the builder too and shows the runtime result", async () => {
		let last: FlowDefinition = flow;
		const evaluate = vi.fn(async (v: Record<string, unknown>) => ({
			values: { ...v, max_tokens: 20288 },
			errors: [],
		}));
		render(<Harness onFlow={(f) => (last = f)} evaluate={evaluate} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open the expression builder for Value of max_tokens",
			}),
		);
		const dialog = screen.getByRole("dialog");
		const area = within(dialog).getByLabelText(
			"Variable max_tokens",
		) as HTMLTextAreaElement;
		expect(area.value).toBe("40576");
		fireEvent.change(area, { target: { value: "{{= 40576 / 2 }}" } });
		await waitFor(() => expect(within(dialog).getByText("20288")).toBeTruthy());
		expect(evaluate.mock.calls.at(-1)?.[0]).toMatchObject({
			max_tokens: "{{= 40576 / 2 }}",
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
		expect(last.variables?.max_tokens).toBe("{{= 40576 / 2 }}");
	});

	test("formula values show the runtime's result or error", async () => {
		const evaluate = vi.fn(async () => ({
			values: { half: 150, broken: "{{env.SECRET}}" },
			errors: [{ name: "broken", message: "env.SECRET is not readable" }],
		}));
		render(
			<Harness
				onFlow={() => {}}
				evaluate={evaluate}
				initial={{
					...flow,
					variables: {
						half: "{{= const.budget / 2 }}",
						broken: "{{env.SECRET}}",
						plain: 1,
					},
				}}
			/>,
		);
		await waitFor(() => expect(screen.getByText("150")).toBeTruthy());
		expect(screen.getByText(/env.SECRET is not readable/)).toBeTruthy();
		expect(evaluate).toHaveBeenCalledTimes(1);
	});
});
