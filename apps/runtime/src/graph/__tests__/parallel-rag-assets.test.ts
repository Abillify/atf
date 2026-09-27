// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the RAG-node v2 asset handling (task 4.1):
 *   - the v2 evidence line carries section path, pages, figure kind and caption
 *     (Requirement 16.4);
 *   - `assets.attach=auto` attaches up to `maxImages` image parts ONLY when the
 *     responder model confirms `visionInput`; otherwise the transcription text
 *     is passed alone (Requirement 16.2);
 *   - `assets.attach=none` (and a legacy source without `assets`) never attach.
 *
 * The runtime is stubbed to return a v2 `search` hit with an `assets[]` array
 * and top-level `section_path`/`pages`, and the parallel node is configured with
 * `maxDocuments` so the fusion path assembles the single RAG context message
 * whose content this test inspects.
 */

import { describe, test, expect } from "bun:test";
import {
	HumanMessage,
	SystemMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import { createParallelNodeHandler } from "../node-handlers.js";
import type { FlowNode } from "../../types/flow.js";
import type { AgentState } from "../graph-engine.js";

/** One v2 search hit with a section path, pages and an attached figure asset. */
function v2HitPayload(): { content: unknown } {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					count: 1,
					results: [
						{
							id: "doc-1#4",
							title: "Wareneingang-Handbuch",
							base_ref: "/Akte/Wareneingang.pdf",
							content: "Die Anmeldung erfolgt über die Maske WE-01.",
							score: 0.9,
							section_path: ["4 Wareneingang", "4.2 Anmeldung"],
							pages: [37, 38],
							assets: [
								{
									asset_id: "asset-12",
									kind: "figure",
									figure_kind: "ui_mask",
									caption: "Abbildung 12 – Anmeldemaske",
									page: 37,
									bbox: [10, 20, 300, 400],
									thumb_url: "https://assets.test/asset-12?variant=thumb",
									url: "https://assets.test/asset-12?variant=preview",
								},
							],
						},
					],
				}),
			},
		],
	};
}

function makeRuntime(): import("../exec-runtime.js").ExecRuntime {
	return {
		appConfig: {},
		ctx: { ssoToken: "t", executionId: "e1" },
		onNodeStart: () => {},
		onNodeEnd: async () => {},
		onNodeIo: () => {},
		onToolCall: async () => {},
		onToolResult: async () => {},
		onToolError: async () => {},
		onCitations: async () => {},
		registerCitations: async (entries: unknown[]) =>
			entries.map((_, i) => i + 1),
		metrics: { recordCounter: () => {} },
		mcpWrapper: {
			callTool: async () => v2HitPayload(),
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
	messages: [new HumanMessage("Welche Maske gilt für die Anmeldung?")],
	classification: {},
	classLabel: "X",
	context: {},
	errors: [],
	toolResults: [],
	citations: [],
	seenDocRefs: [],
} as unknown as AgentState;

/** The assembled RAG SystemMessage (fusion path pushes exactly one). */
function ragMessage(messages: BaseMessage[]): SystemMessage {
	const sys = messages.filter(
		(m): m is SystemMessage => m instanceof SystemMessage,
	);
	const withMarker = sys.find((m) =>
		JSON.stringify(m.content).includes("Anmeldung"),
	);
	expect(withMarker).toBeDefined();
	return withMarker as SystemMessage;
}

function node(assets?: Record<string, unknown>, responderLlm?: unknown): FlowNode {
	return {
		id: "rag-context",
		type: "parallel",
		config: {
			...(responderLlm !== undefined ? { responderLlm } : {}),
			ragProfiles: {
				default: "p",
				maxDocuments: 5,
				profiles: {
					p: [
						{
							collection: "clientdocs",
							limit: 5,
							includeAssets: "refs",
							...(assets !== undefined ? { assets } : {}),
						},
					],
				},
			},
		},
	};
}

describe("RAG node v2 — evidence line (Req 16.4)", () => {
	test("carries section path, pages, figure kind and caption", async () => {
		const handler = createParallelNodeHandler(node(), new Map());
		const out = await handler(state, runConfig(makeRuntime()));
		const text = String(ragMessage(out.messages as BaseMessage[]).content);
		expect(text).toContain("Abschnitt: 4 Wareneingang › 4.2 Anmeldung");
		expect(text).toContain("S. 37–38");
		expect(text).toContain("Abbildungstyp: ui_mask");
		expect(text).toContain("Bildunterschrift: Abbildung 12 – Anmeldemaske");
	});
});

describe("RAG node v2 — asset image attach (Req 16.2)", () => {
	test("attach=auto + responder visionInput=true attaches image parts (max)", async () => {
		const handler = createParallelNodeHandler(
			node(
				{ attach: "auto", maxImages: 4, variant: "preview" },
				{ provider: "bedrock", model: "claude-sonnet-4" },
			),
			new Map(),
		);
		const out = await handler(state, runConfig(makeRuntime()));
		const content = ragMessage(out.messages as BaseMessage[]).content;
		expect(Array.isArray(content)).toBe(true);
		const parts = content as Array<Record<string, unknown>>;
		const images = parts.filter((p) => p.type === "image_url");
		expect(images).toHaveLength(1);
		expect(
			(images[0] as { image_url: { url: string } }).image_url.url,
		).toBe("https://assets.test/asset-12?variant=preview");
	});

	test("attach=auto + responder visionInput=false attaches NO image parts", async () => {
		const handler = createParallelNodeHandler(
			node(
				{ attach: "auto", maxImages: 4, variant: "preview" },
				{ provider: "openai", model: "gpt-3.5-turbo" },
			),
			new Map(),
		);
		const out = await handler(state, runConfig(makeRuntime()));
		const content = ragMessage(out.messages as BaseMessage[]).content;
		// Text-only: content stays a plain string, no image parts.
		expect(typeof content).toBe("string");
		expect(String(content)).toContain("WE-01");
	});

	test("respects maxImages by capping the number of attached parts", async () => {
		const handler = createParallelNodeHandler(
			node(
				{ attach: "always", maxImages: 1, variant: "thumb" },
				{ provider: "openai", model: "gpt-3.5-turbo" },
			),
			new Map(),
		);
		const out = await handler(state, runConfig(makeRuntime()));
		const content = ragMessage(out.messages as BaseMessage[]).content as Array<
			Record<string, unknown>
		>;
		const images = content.filter((p) => p.type === "image_url");
		expect(images).toHaveLength(1);
		// variant=thumb selects the thumbnail URL.
		expect(
			(images[0] as { image_url: { url: string } }).image_url.url,
		).toBe("https://assets.test/asset-12?variant=thumb");
	});

	test("attach=none never attaches, even with a vision responder", async () => {
		const handler = createParallelNodeHandler(
			node(
				{ attach: "none" },
				{ provider: "bedrock", model: "claude-sonnet-4" },
			),
			new Map(),
		);
		const out = await handler(state, runConfig(makeRuntime()));
		const content = ragMessage(out.messages as BaseMessage[]).content;
		expect(typeof content).toBe("string");
	});

	test("legacy source without assets behaves unchanged (text-only, no attach)", async () => {
		const handler = createParallelNodeHandler(node(undefined), new Map());
		const out = await handler(state, runConfig(makeRuntime()));
		const content = ragMessage(out.messages as BaseMessage[]).content;
		expect(typeof content).toBe("string");
		expect(String(content)).toContain("WE-01");
	});
});
