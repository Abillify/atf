// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test (0.16.1): a flow file that mixes an `llm.shortcut` with
 * `{{vars.*}}` placeholders must still register the PLACEHOLDER form.
 *
 * Before the fix, `validateFlowSource` validated the raw template without
 * expanding shortcuts; a raw `{ shortcut: ... }` lacks provider/model and
 * fails the LlmConfig schema, so the loader silently fell back to the fully
 * baked defaults clone — every per-request `variables` override was dead
 * (sm-tutor's `collection` always resolved to its default).
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyFlowVariables } from "../normalize.js";
import { createFlowParserService } from "../../flow-parser.js";

let tmpDir: string | undefined;

afterEach(() => {
	if (tmpDir !== undefined) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

/** `openai` is a built-in protocol name — no PROVIDERS registry needed. */
function writeShortcuts(dir: string): void {
	fs.writeFileSync(
		path.join(dir, "model-shortcuts.json"),
		JSON.stringify({
			engines: { local: { provider: "openai" } },
			modelPresets: {
				one: { model: "test/model-one" },
				two: { model: "test/model-two" },
			},
			shortcuts: {
				chat: { engine: "local", model: "one" },
				other: { engine: "local", model: "two" },
			},
		}),
	);
}

/** Mirrors the sm-tutor shape: shortcut on the answer node, vars elsewhere. */
function writeTutorFlow(dir: string): void {
	fs.writeFileSync(
		path.join(dir, "tutor-flow.json"),
		JSON.stringify({
			id: "tutor-flow",
			name: "Tutor",
			variables: { collection: "default_collection" },
			nodes: [
				{
					id: "gather",
					type: "retrieval",
					config: { collection: "{{vars.collection}}", topK: 4 },
				},
				{ id: "answer", type: "llm", llm: { shortcut: "chat" } },
			],
			edges: [{ source: "gather", target: "answer" }],
		}),
	);
}

describe("validateFlowSource keeps variables overridable", () => {
	test("registers the placeholder form when a shortcut is present", async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-placeholder-"));
		writeShortcuts(tmpDir);
		writeTutorFlow(tmpDir);

		const service = createFlowParserService(tmpDir);
		await service.start();
		const flow = service.getRegistry().get("tutor-flow");
		await service.stop();

		expect(flow).toBeDefined();
		if (flow === undefined) return;

		// The shortcut IS expanded (load-time indirection)…
		const answer = flow.nodes.find((n) => n.id === "answer");
		expect(answer?.llm).toMatchObject({
			provider: "openai",
			model: "test/model-one",
		});

		// …but the variable placeholder SURVIVES (this is the bug fix: before,
		// the baked clone with "default_collection" was registered).
		const gather = flow.nodes.find((n) => n.id === "gather");
		expect((gather?.config as Record<string, unknown>)?.collection).toBe(
			"{{vars.collection}}",
		);
	});

	test("per-request variables override reaches the registered flow", async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-placeholder-"));
		writeShortcuts(tmpDir);
		writeTutorFlow(tmpDir);

		const service = createFlowParserService(tmpDir);
		await service.start();
		const flow = service.getRegistry().get("tutor-flow");
		await service.stop();
		if (flow === undefined) throw new Error("tutor-flow not registered");

		const overridden = applyFlowVariables(flow, {
			collection: "sm_fam_MARKER",
		});
		const gather = overridden.nodes.find((n) => n.id === "gather");
		expect((gather?.config as Record<string, unknown>)?.collection).toBe(
			"sm_fam_MARKER",
		);

		// Without an override the declared default applies.
		const plain = applyFlowVariables(flow);
		const plainGather = plain.nodes.find((n) => n.id === "gather");
		expect((plainGather?.config as Record<string, unknown>)?.collection).toBe(
			"default_collection",
		);
	});

	test("falls back to baked defaults when the shortcut name is a placeholder", async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowparser-placeholder-"));
		writeShortcuts(tmpDir);
		// sm-answer-grade shape: the shortcut name itself comes from a variable.
		// The template form cannot expand that (shortcuts resolve before request
		// variables), so the baked form is registered instead — still valid,
		// just not overridable for THAT field.
		fs.writeFileSync(
			path.join(tmpDir, "grade-flow.json"),
			JSON.stringify({
				id: "grade-flow",
				name: "Grade",
				variables: { model_main: "other" },
				nodes: [
					{
						id: "grade",
						type: "llm",
						llm: { shortcut: "{{vars.model_main}}" },
					},
				],
				edges: [],
			}),
		);

		const service = createFlowParserService(tmpDir);
		await service.start();
		const flow = service.getRegistry().get("grade-flow");
		await service.stop();

		expect(flow).toBeDefined();
		expect(flow?.nodes[0]?.llm).toMatchObject({
			provider: "openai",
			model: "test/model-two",
		});
	});
});
