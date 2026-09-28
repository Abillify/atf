// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { NodeDiagnosticInput } from "../../types/debug-trace.js";
import type { FlowNode } from "../../types/flow.js";
import type { ExecRuntime } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";
import { createToolNodeHandler } from "../handlers/tool.js";

interface Calls {
	args: Record<string, unknown>[];
	results: unknown[];
	errors: string[];
	diagnostics: NodeDiagnosticInput[];
}

function emptyCalls(): Calls {
	return { args: [], results: [], errors: [], diagnostics: [] };
}

function summaryPage(count: number, total?: number): { content: unknown } {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					summaries: Array.from({ length: count }, (_, index) => ({
						reference: `doc-${index}`,
						title: `Document ${index}`,
						summary: `Summary ${index}`,
					})),
					count,
					...(total !== undefined ? { total } : {}),
				}),
			},
		],
	};
}

function makeRuntime(
	calls: Calls,
	callTool: (args: Record<string, unknown>) => Promise<{
		content: unknown;
		isError?: boolean;
	}>,
): ExecRuntime {
	return {
		appConfig: {},
		ctx: { ssoToken: "token", executionId: "execution-1" },
		onNodeStart: () => {},
		onNodeEnd: async () => {},
		onToolCall: async (_id: string, _tool: string, serializedArgs: string) => {
			calls.args.push(JSON.parse(serializedArgs) as Record<string, unknown>);
		},
		onToolResult: async (_id: string, result: unknown) => {
			calls.results.push(result);
		},
		onToolError: async (_id: string, message: string) => {
			calls.errors.push(message);
		},
		onNodeDiagnostic: (_nodeId: string, diagnostic: NodeDiagnosticInput) => {
			calls.diagnostics.push(diagnostic);
		},
		metrics: { recordCounter: () => {} },
		mcpWrapper: {
			callTool: async (
				_server: string,
				_tool: string,
				args: Record<string, unknown>,
			) => callTool(args),
		},
	} as unknown as ExecRuntime;
}

function runConfig(
	runtime: ExecRuntime,
): Parameters<ReturnType<typeof createToolNodeHandler>>[1] {
	return { configurable: { runtime } } as unknown as Parameters<
		ReturnType<typeof createToolNodeHandler>
	>[1];
}

const state = {
	messages: [new HumanMessage("load documents")],
	classification: {},
	classLabel: "",
	context: {},
	errors: [],
	toolResults: [],
	citations: [],
} as unknown as AgentState;

function node(config?: Record<string, unknown>): FlowNode {
	return {
		id: "documents",
		type: "tool",
		tools: ["vectorsearch/get_summaries"],
		...(config !== undefined ? { config } : {}),
	};
}

describe("deterministic tool pagination", () => {
	test("treats MCP isError results as tool errors without exposing or accumulating payloads", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(node());
		const out = await handler(
			state,
			runConfig(
				makeRuntime(calls, async () => ({
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								message: "sk-secret-canary at https://private.internal/mcp",
								rawRequest: "SECRET_REQUEST_DATA",
							}),
						},
					],
				})),
			),
		);

		expect(out.toolResults).toEqual([]);
		expect(out.messages).toEqual([]);
		expect(calls.results).toEqual([]);
		expect(calls.errors).toEqual(["MCP tool reported an error"]);
		expect(out.errors).toHaveLength(1);
		expect(out.errors?.[0]?.type).toBe("tool_error");
		for (const secret of [
			"SECRET_REQUEST_DATA",
			"sk-secret-canary",
			"https://private.internal/mcp",
		]) {
			expect(JSON.stringify(out.errors)).not.toContain(secret);
			expect(JSON.stringify(calls.errors)).not.toContain(secret);
		}
	});

	test("redacts thrown MCP transport errors", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(node());
		const secret = "sk-secret-canary at https://private.internal/transport";
		const out = await handler(
			state,
			runConfig(
				makeRuntime(calls, async () => {
					throw new Error(secret);
				}),
			),
		);

		expect(calls.errors).toEqual(["Tool execution failed."]);
		expect(out.errors?.[0]?.message).toContain("Tool execution failed.");
		expect(JSON.stringify({ calls, errors: out.errors })).not.toContain(secret);
	});

	test("classifies a thrown peer denial structurally in a diagnostic", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(node());
		await handler(
			state,
			runConfig(
				makeRuntime(calls, async () => {
					throw new Error(
						"MCP 2026 tools/call failed (HTTP 403): TRANSACTION_IDENTITY_MISMATCH",
					);
				}),
			),
		);

		expect(calls.errors).toEqual(["Tool execution failed."]);
		const diagnostic = calls.diagnostics.find(
			(entry) => entry.code === "tool_execution_failed",
		);
		expect(diagnostic?.details).toMatchObject({
			tool: "vectorsearch/get_summaries",
			error_name: "Error",
			http_status: 403,
			error_code: "TRANSACTION_IDENTITY_MISMATCH",
		});
		expect(JSON.stringify(diagnostic)).not.toContain("tools/call failed");
	});

	test("reports missing or invalid total after a successful page", async () => {
		for (const total of [undefined, -1, 1.5, Number.NaN]) {
			const calls = emptyCalls();
			const handler = createToolNodeHandler(
				node({ paginate: { "vectorsearch/get_summaries": {} } }),
			);
			const out = await handler(
				state,
				runConfig(makeRuntime(calls, async () => summaryPage(1, total))),
			);

			expect(calls.args).toHaveLength(1);
			expect(calls.results).toHaveLength(1);
			expect(out.toolResults).toHaveLength(1);
			expect(out.errors?.[0]?.type).toBe("tool_error");
			expect(calls.diagnostics).toHaveLength(1);
			expect(calls.diagnostics[0]?.level).toBe("error");
			expect(calls.diagnostics[0]?.code).toBe("pagination_total_missing");
		}
	});

	test("reports an empty page before total as incomplete pagination", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(
			node({ paginate: { "vectorsearch/get_summaries": {} } }),
		);
		const out = await handler(
			state,
			runConfig(makeRuntime(calls, async () => summaryPage(0, 3))),
		);

		expect(calls.args).toHaveLength(1);
		expect(out.toolResults).toHaveLength(1);
		expect(out.errors?.[0]?.type).toBe("tool_error");
		expect(calls.diagnostics).toHaveLength(1);
		expect(calls.diagnostics[0]?.code).toBe("pagination_incomplete");
		expect(calls.diagnostics[0]?.details).toEqual({
			fetched: 0,
			total: 3,
			page: 1,
			pageSize: 200,
			offset: 0,
		});
	});

	test("advances short pages by their actual count and honors the initial offset", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(
			node({
				args: { offset: 5, limit: 4 },
				paginate: { "vectorsearch/get_summaries": {} },
			}),
		);
		const out = await handler(
			state,
			runConfig(
				makeRuntime(calls, async (args) => {
					if (args.offset === 5) return summaryPage(2, 8);
					if (args.offset === 7) return summaryPage(1, 8);
					throw new Error(`unexpected offset ${String(args.offset)}`);
				}),
			),
		);

		expect(calls.args.map((args) => args.offset)).toEqual([5, 7]);
		expect(calls.args.map((args) => args.limit)).toEqual([4, 4]);
		expect(out.toolResults).toHaveLength(2);
		expect(out.errors).toEqual([]);
		expect(calls.diagnostics).toEqual([]);
	});

	test("emits pagination_incomplete when maxPages is reached", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(
			node({
				args: { limit: 3 },
				paginate: { "vectorsearch/get_summaries": { maxPages: 2 } },
			}),
		);
		const out = await handler(
			state,
			runConfig(makeRuntime(calls, async () => summaryPage(1, 10))),
		);

		expect(calls.args.map((args) => args.offset)).toEqual([0, 1]);
		expect(out.toolResults).toHaveLength(2);
		expect(out.errors?.[0]?.type).toBe("tool_error");
		expect(calls.diagnostics).toHaveLength(1);
		expect(calls.diagnostics[0]?.code).toBe("pagination_incomplete");
		expect(calls.diagnostics[0]?.details).toEqual({
			fetched: 2,
			total: 10,
			maxPages: 2,
			pageSize: 3,
		});
	});

	test("uses safe defaults for invalid pageSize, offset, and maxPages", async () => {
		const calls = emptyCalls();
		const handler = createToolNodeHandler(
			node({
				args: { offset: -4, limit: 0 },
				paginate: { "vectorsearch/get_summaries": { maxPages: 1.5 } },
			}),
		);
		const out = await handler(
			state,
			runConfig(makeRuntime(calls, async () => summaryPage(1, 3))),
		);

		expect(calls.args.map((args) => args.offset)).toEqual([0, 1, 2]);
		expect(calls.args.map((args) => args.limit)).toEqual([200, 200, 200]);
		expect(out.toolResults).toHaveLength(3);
		expect(out.errors).toEqual([]);
		expect(calls.diagnostics).toEqual([]);
	});
});
