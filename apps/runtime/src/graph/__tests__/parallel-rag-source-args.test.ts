// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit test for the RAG-source argument mapping in the parallel node handler
 * (`createParallelNodeHandler` → `buildRagSourceNode`).
 *
 * Requirement 2.10: the RAG node forwards `filter`, `filter_v2`, `path_prefix`
 * and `hyde` to Search's `vectorsearch/search` tool. This drives the handler
 * with a `ragProfiles` source declaring those fields (in their camelCase profile
 * spelling) and asserts they arrive on the tool call under their snake_case
 * argument names, verbatim.
 */

import { describe, test, expect } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { createParallelNodeHandler } from "../node-handlers.js";
import type { FlowNode } from "../../types/flow.js";
import type { AgentState } from "../graph-engine.js";

function emptyPayload(): { content: unknown } {
	return {
		content: [
			{ type: "text", text: JSON.stringify({ results: [], count: 0 }) },
		],
	};
}

/** Captures the args object of every `vectorsearch/search` call. */
function makeRuntime(
	captured: Array<Record<string, unknown>>,
): import("../exec-runtime.js").ExecRuntime {
	return {
		appConfig: {},
		ctx: { ssoToken: "t", executionId: "e1" },
		onNodeStart: () => {},
		onNodeEnd: async () => {},
		onToolCall: async () => {},
		onToolResult: async () => {},
		onToolError: async () => {},
		onCitations: async () => {},
		metrics: { recordCounter: () => {} },
		mcpWrapper: {
			callTool: async (
				_server: string,
				_tool: string,
				args: Record<string, unknown>,
			) => {
				captured.push(args);
				return emptyPayload();
			},
		},
	} as unknown as import("../exec-runtime.js").ExecRuntime;
}

function runConfig(
	runtime: import("../exec-runtime.js").ExecRuntime,
): Parameters<ReturnType<typeof createParallelNodeHandler>>[1] {
	return { configurable: { runtime } } as unknown as Parameters<
		ReturnType<typeof createParallelNodeHandler>
	>[1];
}

const state = {
	messages: [
		new HumanMessage("Welche Maske gilt für die Antragseingangsbuchung?"),
	],
	classification: {},
	classLabel: "X",
	context: {},
	errors: [],
	toolResults: [],
	citations: [],
	seenDocRefs: [],
} as unknown as AgentState;

describe("parallel RAG source — retrieval-scoping arg pass-through (Req 2.10)", () => {
	test("forwards filter, filter_v2, path_prefix and hyde to vectorsearch/search", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const node: FlowNode = {
			id: "rag-context",
			type: "parallel",
			config: {
				ragProfiles: {
					default: "p",
					profiles: {
						p: [
							{
								collection: "clientdocs",
								limit: 5,
								filter: { product: "acme" },
								filterV2: { page: { range: { gte: 10 } } },
								pathPrefix: "/Unterlagen Teil 1",
								hyde: true,
							},
						],
					},
				},
			},
		};
		const handler = createParallelNodeHandler(node, new Map());
		await handler(state, runConfig(makeRuntime(captured)));

		expect(captured).toHaveLength(1);
		const args = captured[0] as Record<string, unknown>;
		expect(args.filter).toEqual({ product: "acme" });
		expect(args.filter_v2).toEqual({ page: { range: { gte: 10 } } });
		expect(args.path_prefix).toBe("/Unterlagen Teil 1");
		expect(args.hyde).toBe(true);
	});

	test("omits the scoping args when the source does not declare them", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const node: FlowNode = {
			id: "rag-context",
			type: "parallel",
			config: {
				ragProfiles: {
					default: "p",
					profiles: { p: [{ collection: "clientdocs", limit: 5 }] },
				},
			},
		};
		const handler = createParallelNodeHandler(node, new Map());
		await handler(state, runConfig(makeRuntime(captured)));

		expect(captured).toHaveLength(1);
		const args = captured[0] as Record<string, unknown>;
		expect(args).not.toHaveProperty("filter");
		expect(args).not.toHaveProperty("filter_v2");
		expect(args).not.toHaveProperty("path_prefix");
		expect(args).not.toHaveProperty("hyde");
	});
});

describe("parallel RAG source — v2 retrieval params (Req 16.1)", () => {
	test("forwards expand, granularity and include_assets to vectorsearch/search", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const node: FlowNode = {
			id: "rag-context",
			type: "parallel",
			config: {
				ragProfiles: {
					default: "p",
					profiles: {
						p: [
							{
								collection: "clientdocs",
								limit: 5,
								expand: "section",
								granularity: "page",
								includeAssets: "thumbnails",
							},
						],
					},
				},
			},
		};
		const handler = createParallelNodeHandler(node, new Map());
		await handler(state, runConfig(makeRuntime(captured)));

		expect(captured).toHaveLength(1);
		const args = captured[0] as Record<string, unknown>;
		expect(args.expand).toBe("section");
		expect(args.granularity).toBe("page");
		expect(args.include_assets).toBe("thumbnails");
	});

	test("omits the v2 params when a legacy source does not declare them", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const node: FlowNode = {
			id: "rag-context",
			type: "parallel",
			config: {
				ragProfiles: {
					default: "p",
					profiles: { p: [{ collection: "clientdocs", limit: 5 }] },
				},
			},
		};
		const handler = createParallelNodeHandler(node, new Map());
		await handler(state, runConfig(makeRuntime(captured)));

		expect(captured).toHaveLength(1);
		const args = captured[0] as Record<string, unknown>;
		expect(args).not.toHaveProperty("expand");
		expect(args).not.toHaveProperty("granularity");
		expect(args).not.toHaveProperty("include_assets");
	});
});
