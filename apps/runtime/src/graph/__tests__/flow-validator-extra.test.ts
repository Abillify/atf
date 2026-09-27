// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structured flow validator (`src/graph/flow-validator.ts`)
 *
 * The dry-run validation behind the flow editor and POST /flows/validate.
 * Covers the author-time checks layered on top of the parser's schema check:
 * routing-condition grammar, classifier schema, parallel children, ragProfiles,
 * unknown-tool warnings, and reachability.
 */

import { describe, test, expect } from "bun:test";
import { validateFlow } from "../flow-validator.js";
import type { FlowDefinition } from "../../types/flow.js";

const BAD_EXPR = "a &&& b (((";

function baseFlow(over: Partial<FlowDefinition> = {}): FlowDefinition {
	return {
		id: "f",
		name: "F",
		nodes: [{ id: "n1", type: "llm" }],
		edges: [],
		...over,
	};
}

describe("validateFlow — schema stage", () => {
	test("reports each schema problem of an invalid definition with its path", () => {
		const report = validateFlow({ name: "no id" });
		expect(report.valid).toBe(false);
		const paths = report.errors.map((e) => e.path);
		expect(paths).toContain("id");
		expect(paths).toContain("nodes");
		expect(report.errors.every((e) => e.message.length > 0)).toBe(true);
	});

	test("captures flowId + counts in meta even for an invalid definition", () => {
		const report = validateFlow({
			id: "broken",
			nodes: [{ id: "a" }, { id: "b" }],
			edges: [{ source: "a", target: "b" }],
		});
		expect(report.meta.flowId).toBe("broken");
		expect(report.meta.nodeCount).toBe(2);
		expect(report.meta.edgeCount).toBe(1);
	});

	test("accepts a minimal single-node flow", () => {
		const report = validateFlow(baseFlow());
		expect(report.valid).toBe(true);
		expect(report.errors).toEqual([]);
		expect(report.meta).toEqual({ nodeCount: 1, edgeCount: 0, flowId: "f" });
	});
});

describe("validateFlow — routing conditions", () => {
	test("flags an ungrammatical edge condition", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{ id: "n1", type: "llm" },
					{ id: "n2", type: "llm" },
				],
				edges: [{ source: "n1", target: "n2", conditions: BAD_EXPR }],
			}),
		);
		expect(report.valid).toBe(false);
		expect(report.errors.some((e) => e.path === "edges[0].conditions")).toBe(
			true,
		);
	});

	test("accepts a valid edge condition", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{ id: "n1", type: "llm" },
					{ id: "n2", type: "llm" },
				],
				edges: [
					{
						source: "n1",
						target: "n2",
						conditions: "classification.label == 'a'",
					},
				],
			}),
		);
		expect(report.errors).toEqual([]);
	});
});

describe("validateFlow — node checks", () => {
	test("errors when a classifier node lacks a schema", () => {
		const report = validateFlow(
			baseFlow({ nodes: [{ id: "c", type: "classifier" }] }),
		);
		expect(report.valid).toBe(false);
		expect(
			report.errors.some((e) => /missing classifierSchema/.test(e.message)),
		).toBe(true);
	});

	test("warns when a parallel node has neither children nor ragProfiles", () => {
		const report = validateFlow(
			baseFlow({ nodes: [{ id: "p", type: "parallel" }] }),
		);
		expect(
			report.warnings.some((w) =>
				/no parallelNodes and no ragProfiles/.test(w.message),
			),
		).toBe(true);
	});

	test("errors on an unknown or self-referencing parallel child", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{ id: "p", type: "parallel", parallelNodes: ["ghost", "p"] },
					{ id: "w", type: "llm" },
				],
			}),
		);
		expect(
			report.errors.some((e) => /unknown child "ghost"/.test(e.message)),
		).toBe(true);
		expect(
			report.errors.some((e) => /cannot reference itself/.test(e.message)),
		).toBe(true);
	});

	test("errors on an invalid parallel-child condition", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						parallelNodes: [{ node: "w", condition: BAD_EXPR }],
					},
					{ id: "w", type: "llm" },
				],
			}),
		);
		expect(
			report.errors.some((e) =>
				/child "w" has an invalid condition/.test(e.message),
			),
		).toBe(true);
	});

	test("warns on tool refs unknown to the platform", () => {
		const report = validateFlow(
			baseFlow({ nodes: [{ id: "n1", type: "llm", tools: ["srv/unknown"] }] }),
			new Set(["srv/known"]),
		);
		expect(
			report.warnings.some((w) =>
				/tool "srv\/unknown" is not known/.test(w.message),
			),
		).toBe(true);
	});
});

describe("validateFlow — ragProfiles on a parallel node", () => {
	test("validates select/default/source references and conditions", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						config: {
							ragProfiles: {
								select: [
									{ when: BAD_EXPR, use: "known" },
									{ when: "classification.label == 'x'", use: "missing" },
								],
								default: "alsoMissing",
								shared: [{ collection: "docs", when: BAD_EXPR }],
								profiles: {
									known: [
										{ collection: "kb", when: "classification.label == 'y'" },
									],
								},
							},
						},
					},
				],
			}),
		);
		expect(report.valid).toBe(false);
		const msgs = report.errors.map((e) => e.message).join("\n");
		expect(msgs).toMatch(/invalid profile-select condition/);
		expect(msgs).toMatch(/references unknown profile "missing"/);
		expect(msgs).toMatch(/default references unknown profile "alsoMissing"/);
		expect(msgs).toMatch(/invalid source condition/);
	});

	test("a well-formed ragProfiles plan produces no errors", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						config: {
							ragProfiles: {
								select: [{ when: "classification.label == 'x'", use: "known" }],
								default: "known",
								profiles: {
									known: [
										{ collection: "kb", when: "classification.label == 'y'" },
									],
								},
							},
						},
					},
				],
			}),
		);
		expect(report.errors).toEqual([]);
	});

	test("accepts a source declaring filter/filter_v2/path_prefix/hyde (Req 2.10)", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						config: {
							ragProfiles: {
								default: "known",
								profiles: {
									known: [
										{
											collection: "kb",
											filter: { product: "acme" },
											filterV2: { page: { range: { gte: 10 } } },
											pathPrefix: "/Unterlagen Teil 1",
											hyde: true,
										},
									],
								},
							},
						},
					},
				],
			}),
		);
		expect(report.errors).toEqual([]);
	});

	test("accepts a source declaring the v2 fields expand/granularity/include_assets/assets (Req 16.1)", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						config: {
							ragProfiles: {
								default: "known",
								profiles: {
									known: [
										{
											collection: "kb",
											expand: "section",
											granularity: "page",
											includeAssets: "thumbnails",
											assets: {
												attach: "auto",
												maxImages: 4,
												variant: "preview",
											},
										},
									],
								},
							},
						},
					},
				],
			}),
		);
		expect(report.errors).toEqual([]);
	});

	test("rejects an invalid v2 enum value (expand)", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						config: {
							ragProfiles: {
								default: "known",
								profiles: {
									known: [{ collection: "kb", expand: "sideways" }],
								},
							},
						},
					},
				],
			}),
		);
		expect(report.valid).toBe(false);
		expect(report.errors.some((e) => e.path.includes("expand"))).toBe(true);
	});

	test("rejects an invalid assets.attach value", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{
						id: "p",
						type: "parallel",
						config: {
							ragProfiles: {
								default: "known",
								profiles: {
									known: [{ collection: "kb", assets: { attach: "maybe" } }],
								},
							},
						},
					},
				],
			}),
		);
		expect(report.valid).toBe(false);
		expect(report.errors.some((e) => e.path.includes("attach"))).toBe(true);
	});
});

describe("validateFlow — reachability", () => {
	test("warns when no start edge exists and every node is a target", () => {
		const report = validateFlow(
			baseFlow({
				nodes: [
					{ id: "n1", type: "llm" },
					{ id: "n2", type: "llm" },
				],
				edges: [
					{ source: "n1", target: "n2" },
					{ source: "n2", target: "n1" },
				],
			}),
		);
		expect(
			report.warnings.some((w) => /entry point is ambiguous/.test(w.message)),
		).toBe(true);
	});
});
