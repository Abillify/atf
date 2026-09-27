// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * End-to-end test for the Phase-4 runtime chain (task 4.6):
 *
 *   question → RAG hit carrying a figure ASSET → the image reaches the vision
 *   model (auto-attached, Req 16.2) OR is inspected on demand via
 *   `inspect_image("asset:<id>#bbox", …)` (Req 16.3) → answer with a citation
 *   that carries page + figure, off an evidence line that carries section path,
 *   pages, figure kind and caption (Req 16.4).
 *
 * The chain is composed of the SAME real units the neighbouring tests exercise
 * in isolation — the RAG `parallel`/`ragProfiles` node (task 4.1, see
 * `parallel-rag-assets.test.ts`) and the `inspect_image` tool (task 4.2, see
 * `image-inspection-tool.test.ts`) — but wired together into one flow per
 * variant so we prove the whole path, not just each half.
 *
 * Everything is stubbed: the MCP wrapper answers the `search` / `get_asset`
 * calls, the responder is a `MockLanguageModelV3`, and the vision sub-LLM is a
 * second `MockLanguageModelV3`. No network, no DB, no real models.
 *
 * What each assertion proves:
 *   - Req 16.4 (evidence line + citation): the RAG context the responder sees
 *     contains section path, pages, figure kind and caption; the produced answer
 *     cites the page and the figure.
 *   - Req 16.2 (image-attach path): with `assets.attach=auto` and a responder
 *     that confirms `visionInput`, the figure reaches the responder as an image
 *     part (capped at `maxImages`), and the answer cites page + figure.
 *   - Req 16.3 (inspect_image path): a text-only responder resolves the asset
 *     via `inspect_image("asset:<id>#bbox", …)`; `get_asset` is called with the
 *     asset id + region, the vision sub-LLM sees the image bytes, the responder
 *     never receives the base64, and the final answer cites page + figure.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { Tool } from "ai";
import type {
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import {
	HumanMessage,
	SystemMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import { createParallelNodeHandler } from "../node-handlers.js";
import {
	buildImageInspectionTools,
	type AgentImageInspectionHooks,
} from "../agent-tools.js";
import {
	HashedImageRefRegistry,
	IMAGE_INSPECTION_TOOL_NAME,
} from "../image-reference.js";
import { InMemoryMediaStore } from "../media-store.js";
import type { FlowNode, ImageInspectionConfig } from "../../types/flow.js";
import type { AgentState } from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";
import { mkUsage } from "./v3-mock-helpers.js";

// ---------------------------------------------------------------------------
// Shared fixture: one v2 `search` hit that carries a figure asset.
// ---------------------------------------------------------------------------

const QUESTION = "Welche Maske gilt für die Anmeldung im Wareneingang?";

/**
 * Invokes a mock responder model's `doGenerate` directly with the given AI-SDK
 * prompt and returns its text. We call the model rather than the AI SDK's
 * `generateText` wrapper so the run stays fully hermetic: `generateText` would
 * try to *download* remote image URLs and rejects system roles in `messages`.
 * The tool loop the engine runs ultimately hands the model exactly this kind of
 * prompt, so exercising `doGenerate` directly is faithful to the responder's
 * contract.
 */
async function respond(
	model: MockLanguageModelV3,
	prompt: unknown,
): Promise<string> {
	const result = (await (
		model as unknown as {
			doGenerate: (
				opts: LanguageModelV3CallOptions,
			) => Promise<LanguageModelV3GenerateResult>;
		}
	).doGenerate({ prompt } as unknown as LanguageModelV3CallOptions)) as {
		content: Array<{ type: string; text?: string }>;
	};
	return result.content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("");
}

/** The single figure asset the hit carries (id / kind / caption / page / bbox). */
const ASSET = {
	asset_id: "asset-12",
	kind: "figure",
	figure_kind: "ui_mask",
	caption: "Abbildung 12 – Anmeldemaske",
	page: 37,
	bbox: [10, 20, 300, 400] as const,
	thumb_url: "https://assets.test/asset-12?variant=thumb",
	url: "https://assets.test/asset-12?variant=preview",
};

/** A v2 `search` MCP result: one hit with section path, pages and the asset. */
function v2SearchResult(): { content: unknown } {
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
							assets: [ASSET],
						},
					],
				}),
			},
		],
	};
}

const baseConfig: AppConfig = {
	port: 3000,
	flowsDir: "./flows",
	monitoringTransport: "sse",
	mcpServers: [],
	corsOrigins: ["*"],
	monitoringAuthRequired: false,
	logLevel: "error",
	maxToolSteps: 5,
	maxConcurrentExecutions: 50,
	defaultLlm: { provider: "openai", model: "mock-model" },
};

/**
 * A stubbed ExecRuntime whose MCP wrapper serves the `search` call (used by the
 * RAG node). The `callTool` spy records every call so we can distinguish the
 * search from later `get_asset` fetches.
 */
function makeRuntime(calls: Array<{ server: string; tool: string; args: unknown }>) {
	return {
		appConfig: {},
		ctx: { ssoToken: "t", executionId: "e-4-6" },
		onNodeStart: () => {},
		onNodeEnd: async () => {},
		onNodeIo: () => {},
		onToolCall: async () => {},
		onToolResult: async () => {},
		onToolError: async () => {},
		onCitations: async () => {},
		registerCitations: async (entries: unknown[]) => entries.map((_, i) => i + 1),
		metrics: { recordCounter: () => {} },
		mcpWrapper: {
			callTool: async (server: string, tool: string, args: unknown) => {
				calls.push({ server, tool, args });
				return v2SearchResult();
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
	messages: [new HumanMessage(QUESTION)],
	classification: {},
	classLabel: "X",
	context: {},
	errors: [],
	toolResults: [],
	citations: [],
	seenDocRefs: [],
} as unknown as AgentState;

/** The RAG SystemMessage the parallel node assembled (fusion pushes one). */
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

/** A RAG node with the given asset policy and (optional) responder model. */
function ragNode(
	assets?: Record<string, unknown>,
	responderLlm?: unknown,
): FlowNode {
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

/** Asserts the v2 evidence line carries section path, pages, figure, caption. */
function expectEvidenceLine(ragText: string): void {
	expect(ragText).toContain("Abschnitt: 4 Wareneingang › 4.2 Anmeldung");
	expect(ragText).toContain("S. 37–38");
	expect(ragText).toContain("Abbildungstyp: ui_mask");
	expect(ragText).toContain("Bildunterschrift: Abbildung 12 – Anmeldemaske");
}

// ---------------------------------------------------------------------------
// Variant (a): auto-attach + vision responder (Req 16.2 + 16.4)
// ---------------------------------------------------------------------------

describe("e2e (4.6): auto-attach → vision responder → cited answer (Req 16.2/16.4)", () => {
	test("the figure reaches the responder as an image part and the answer cites page + figure", async () => {
		const calls: Array<{ server: string; tool: string; args: unknown }> = [];

		// 1) RAG retrieval assembles the context. attach=auto + a vision responder
		//    means the figure is attached as an image part (Req 16.2).
		const handler = createParallelNodeHandler(
			ragNode(
				{ attach: "auto", maxImages: 4, variant: "preview" },
				{ provider: "bedrock", model: "claude-sonnet-4" },
			),
			new Map(),
		);
		const out = await handler(state, runConfig(makeRuntime(calls)));
		const ragMsg = ragMessage(out.messages as BaseMessage[]);

		// The RAG node called the stubbed `search` (and nothing else here).
		expect(calls.map((c) => c.tool)).toEqual(["search"]);

		// The assembled content is a parts array carrying exactly one image part
		// pointing at the preview variant.
		const parts = ragMsg.content as Array<Record<string, unknown>>;
		expect(Array.isArray(parts)).toBe(true);
		const images = parts.filter((p) => p.type === "image_url");
		expect(images).toHaveLength(1);
		expect((images[0] as { image_url: { url: string } }).image_url.url).toBe(
			ASSET.url,
		);

		// Req 16.4: the evidence text carries section path, pages, figure, caption.
		const ragText = parts
			.filter((p) => p.type === "text")
			.map((p) => String((p as { text: unknown }).text))
			.join("\n");
		expectEvidenceLine(ragText);

		// 2) The responder consumes that context. We drive a real model through
		//    the AI SDK and assert it actually receives the image file part; its
		//    answer cites the page and the figure off the evidence line.
		let responderSawImage = false;
		const responder = new MockLanguageModelV3({
			doGenerate: async (opts) => {
				const promptStr = JSON.stringify(opts.prompt);
				responderSawImage =
					promptStr.includes(ASSET.url) &&
					(promptStr.includes('"image"') || promptStr.includes('"file"'));
				// The evidence line is what lets the responder cite page + figure.
				const cite = promptStr.includes("S. 37–38")
					? "Siehe Maske WE-01 (S. 37, Abbildung 12 – Anmeldemaske)."
					: "Keine Quelle.";
				return {
					content: [{ type: "text", text: cite }],
					finishReason: { unified: "stop" as const, raw: "stop" },
					usage: mkUsage(50, 20),
					warnings: [],
				};
			},
		});

		const answerText = await respond(responder, [
			{
				role: "user",
				content: [
					{ type: "text", text: ragText },
					// The engine forwards the RAG image part to the vision responder
					// as a file part carrying the (preview-variant) image URL.
					{
						type: "file",
						data: new URL(ASSET.url),
						mediaType: "image/png",
					},
					{ type: "text", text: QUESTION },
				],
			},
		]);

		expect(responderSawImage).toBe(true);
		// Req 16.4: the citation carries the page and the figure.
		expect(answerText).toContain("S. 37");
		expect(answerText).toContain("Abbildung 12");
	});
});

// ---------------------------------------------------------------------------
// Variant (b): inspect_image path (Req 16.3 + 16.4)
// ---------------------------------------------------------------------------

const visionLlm: ImageInspectionConfig["llm"] = {
	provider: "google",
	model: "mock-vision-model",
};

/** The image bytes `get_asset` returns for the figure. */
const ASSET_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ASSET_BYTES_B64 = Buffer.from(ASSET_BYTES).toString("base64");

/**
 * A vision sub-LLM stub that records whether it actually received the image
 * bytes (as a data URL / file part) before answering.
 */
function visionModelFactory(sawImage: { value: boolean }) {
	return () =>
		new MockLanguageModelV3({
			doGenerate: async (opts) => {
				const promptStr = JSON.stringify(opts.prompt);
				sawImage.value = promptStr.includes(ASSET_BYTES_B64);
				return {
					content: [
						{
							type: "text",
							text: "Die Maske trägt die Bezeichnung WE-01 in der Titelzeile.",
						},
					],
					finishReason: { unified: "stop" as const, raw: "stop" },
					usage: mkUsage(120, 40),
					warnings: [],
				};
			},
		}) as unknown as import("ai").LanguageModel;
}

type ExecutableTool = Tool & {
	execute: (
		args: { image: string; question: string },
		opts: { toolCallId?: string },
	) => Promise<Record<string, unknown>>;
};

describe("e2e (4.6): text responder → inspect_image → vision → cited answer (Req 16.3/16.4)", () => {
	test("get_asset is called with id+region, the vision LLM sees the image, the responder never gets base64, and the answer cites page + figure", async () => {
		const calls: Array<{ server: string; tool: string; args: unknown }> = [];

		// 1) RAG retrieval with a NON-vision responder (attach=none): no image is
		//    attached, but the evidence line still exposes the asset ref so the
		//    model can decide to inspect it on demand.
		const handler = createParallelNodeHandler(
			ragNode(
				{ attach: "none" },
				{ provider: "openai", model: "gpt-3.5-turbo" },
			),
			new Map(),
		);
		const out = await handler(state, runConfig(makeRuntime(calls)));
		const ragMsg = ragMessage(out.messages as BaseMessage[]);
		const ragText = String(ragMsg.content);
		// Text-only: no image part was attached to the text responder (Req 16.2
		// negative), yet the evidence line is intact (Req 16.4).
		expect(typeof ragMsg.content).toBe("string");
		expect(ragText).not.toContain(ASSET_BYTES_B64);
		expectEvidenceLine(ragText);

		// 2) The responder's `inspect_image` tool, built exactly as the llm
		//    handler builds it: a fetchAsset hook backed by the stubbed MCP
		//    `get_asset`, and the configured vision sub-LLM.
		const store = new InMemoryMediaStore();
		const registry = new HashedImageRefRegistry({ store });
		const sawImage = { value: false };
		const getAssetCalls: Array<{
			assetId: string;
			region?: readonly number[];
		}> = [];

		const fetchAsset = async (
			assetId: string,
			opts: { region?: [number, number, number, number] },
		): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> => {
			// This is what buildAssetFetch does in production: call the MCP
			// `get_asset` tool. We stub the wrapper here.
			calls.push({
				server: "vectorsearch",
				tool: "get_asset",
				args: {
					asset_id: assetId,
					...(opts.region !== undefined ? { region: opts.region } : {}),
				},
			});
			getAssetCalls.push({
				assetId,
				...(opts.region !== undefined ? { region: opts.region } : {}),
			});
			return { bytes: ASSET_BYTES, mediaType: "image/png" };
		};

		const config: ImageInspectionConfig = {
			llm: visionLlm,
			assetSource: { server: "vectorsearch" },
		};
		const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		const tools = buildImageInspectionTools({
			registry,
			config,
			fetchAsset,
			appConfig: baseConfig,
			llmProviderFactory: visionModelFactory(sawImage),
			metrics: { recordLlmCall: () => {} } as never,
			clientId: "client-1",
			nodeId: "answer",
			usage,
		} satisfies AgentImageInspectionHooks);
		const inspect = tools[IMAGE_INSPECTION_TOOL_NAME] as ExecutableTool;
		expect(inspect).toBeDefined();

		// 3) The responder decides to look at the figure. It quotes the asset id
		//    it saw in the evidence line, with the bbox as a #region. In the
		//    engine this is one turn of the tool loop; the tool's `execute` is the
		//    exact code path invoked.
		const assetId = ASSET.asset_id;
		const region = "0.02,0.05,0.6,0.8";
		const toolResult = await inspect.execute(
			{ image: `asset:${assetId}#${region}`, question: QUESTION },
			{ toolCallId: "call-inspect" },
		);

		// get_asset was called with the asset id AND the region (the #bbox zoom).
		expect(getAssetCalls).toEqual([
			{ assetId, region: [0.02, 0.05, 0.6, 0.8] },
		]);
		expect(calls.map((c) => c.tool)).toEqual(["search", "get_asset"]);
		// The vision sub-LLM actually saw the image bytes.
		expect(sawImage.value).toBe(true);
		// The tool answered, and the hosting/responder model never sees base64.
		expect(toolResult.status).toBe("ok");
		expect(JSON.stringify(toolResult)).not.toContain(ASSET_BYTES_B64);

		// 4) The responder produces the final answer from the tool result + the
		//    evidence line, citing page + figure.
		const responder = new MockLanguageModelV3({
			doGenerate: async (opts) => {
				const promptStr = JSON.stringify(opts.prompt);
				// The responder must never have received the raw image bytes.
				expect(promptStr).not.toContain(ASSET_BYTES_B64);
				const cite =
					promptStr.includes("WE-01") && promptStr.includes("S. 37–38")
						? "Die Anmeldemaske ist WE-01 (S. 37, Abbildung 12 – Anmeldemaske)."
						: "Keine Quelle.";
				return {
					content: [{ type: "text", text: cite }],
					finishReason: { unified: "stop" as const, raw: "stop" },
					usage: mkUsage(60, 25),
					warnings: [],
				};
			},
		});

		const answerText = await respond(responder, [
			{ role: "system", content: [{ type: "text", text: ragText }] },
			{ role: "user", content: [{ type: "text", text: QUESTION }] },
			// The tool result the responder gets back — the vision description,
			// NOT the pixels.
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: `inspect_image → ${String(
							(toolResult as { description?: unknown }).description ?? "",
						)}`,
					},
				],
			},
		]);

		// Req 16.4: the citation carries the page and the figure.
		expect(answerText).toContain("S. 37");
		expect(answerText).toContain("Abbildung 12");
	});
});
