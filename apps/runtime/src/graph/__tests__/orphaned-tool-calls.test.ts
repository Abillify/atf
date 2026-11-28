// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for {@link removeOrphanedToolCalls} and the threaded-history
 * fingerprint tolerance that prevents the poisoned-thread duplication.
 *
 * The production regression these guard (passthrough client tools, 2026-11):
 * a passthrough (client-executed) tool call is persisted with `args: {}`
 * (DLP strips them), but the client replays the same call with its real
 * arguments. The strict fingerprint differed, so `reconcileThreadedHistory`
 * appended the whole client transcript instead of just the new tool result —
 * leaving TWO assistant messages sharing ONE tool-call id, only the second
 * followed by its result. `convertToLanguageModelPrompt` (ai@7) requires each
 * `tool-call` part to be answered immediately and threw
 * `AI_MissingToolResultsError` on every subsequent turn of the thread.
 */

import { describe, test, expect } from "bun:test";
import {
	AIMessage,
	HumanMessage,
	ToolMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import type { ModelMessage } from "ai";
import { removeOrphanedToolCalls } from "../exec-runtime.js";
import { reconcileThreadedHistory } from "../graph-engine/history-contract.js";

function callMsg(id: string, text = ""): ModelMessage {
	return {
		role: "assistant",
		content: [
			...(text === "" ? [] : [{ type: "text", text }]),
			{ type: "tool-call", toolCallId: id, toolName: "ui_tool", input: {} },
		],
	} as unknown as ModelMessage;
}

function resultMsg(id: string, value = "ok"): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				toolName: "ui_tool",
				output: { type: "text", value },
			},
		],
	} as unknown as ModelMessage;
}

function toolCallIds(m: ModelMessage): string[] {
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	return (m.content as Array<{ type: string; toolCallId?: string }>)
		.filter((p) => p.type === "tool-call")
		.map((p) => p.toolCallId ?? "");
}

describe("removeOrphanedToolCalls", () => {
	test("a valid call/result pair passes through by identity", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "frage" } as ModelMessage,
			callMsg("c1"),
			resultMsg("c1"),
		];
		const out = removeOrphanedToolCalls(messages);
		expect(out.messages).toBe(messages);
		expect(out.removedToolCalls).toBe(0);
		expect(out.removedToolResults).toBe(0);
	});

	test("drops the duplicate tool-call whose result does not follow it (poisoned thread)", () => {
		// Exactly the checkpoint shape from production: the persisted call (args
		// stripped) followed by replayed system/user messages, then the client's
		// copy of the same call with its result.
		const messages: ModelMessage[] = [
			{ role: "user", content: "Fasse Kontakt zusammen" } as ModelMessage,
			callMsg("VwyHtQ1X"),
			{ role: "system", content: "[ctx]" } as ModelMessage,
			{ role: "user", content: "Fasse Kontakt zusammen" } as ModelMessage,
			callMsg("VwyHtQ1X"),
			resultMsg("VwyHtQ1X"),
		];
		const out = removeOrphanedToolCalls(messages);
		expect(out.removedToolCalls).toBe(1);
		// The call without an immediately-following result is gone; the one that
		// owns the result survives, adjacency intact.
		const calls = out.messages.filter((m) => toolCallIds(m).length > 0);
		expect(calls.length).toBe(1);
		const idx = out.messages.indexOf(calls[0] as ModelMessage);
		expect(out.messages[idx + 1]?.role).toBe("tool");
	});

	test("drops a tool-call with no result at all, keeping the assistant text", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "frage" } as ModelMessage,
			callMsg("c1", "Ich schaue nach."),
		];
		const out = removeOrphanedToolCalls(messages);
		expect(out.removedToolCalls).toBe(1);
		const assistant = out.messages[1];
		expect(assistant?.role).toBe("assistant");
		expect(toolCallIds(assistant as ModelMessage)).toEqual([]);
	});

	test("drops an assistant message left empty after its only call is removed", () => {
		const messages: ModelMessage[] = [callMsg("c1")];
		const out = removeOrphanedToolCalls(messages);
		expect(out.messages.length).toBe(0);
	});

	test("drops an orphaned tool result whose call was removed", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "x" } as ModelMessage,
			resultMsg("gone"),
		];
		const out = removeOrphanedToolCalls(messages);
		expect(out.removedToolResults).toBe(1);
		expect(out.messages.find((m) => m.role === "tool")).toBeUndefined();
	});

	test("each id is consumed once: two calls, one result keeps only the adjacent call", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "x" } as ModelMessage,
			callMsg("dup"),
			resultMsg("dup"),
			{ role: "user", content: "y" } as ModelMessage,
			callMsg("dup"),
		];
		const out = removeOrphanedToolCalls(messages);
		expect(out.removedToolCalls).toBe(1);
		const callIdx = out.messages
			.map((m) => toolCallIds(m).length > 0)
			.indexOf(true);
		expect(out.messages[callIdx + 1]?.role).toBe("tool");
		// The trailing call (no result) was the one removed.
		expect(out.messages[out.messages.length - 1]?.role).toBe("user");
	});

	test("is idempotent", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "frage" } as ModelMessage,
			callMsg("c1"),
			{ role: "system", content: "[ctx]" } as ModelMessage,
			callMsg("c1"),
			resultMsg("c1"),
		];
		const first = removeOrphanedToolCalls(messages);
		const second = removeOrphanedToolCalls(first.messages);
		expect(second.messages).toBe(first.messages);
		expect(second.removedToolCalls).toBe(0);
		expect(second.removedToolResults).toBe(0);
	});

	test("string-content messages are untouched", () => {
		const messages: ModelMessage[] = [
			{ role: "system", content: "sys" } as ModelMessage,
			{ role: "user", content: "hi" } as ModelMessage,
			{ role: "assistant", content: "hallo" } as ModelMessage,
		];
		const out = removeOrphanedToolCalls(messages);
		expect(out.messages).toBe(messages);
	});
});

describe("reconcileThreadedHistory — replayed passthrough tool calls", () => {
	test("a client replay whose tool-call args differ from the persisted (DLP-stripped) call is matched, not appended", () => {
		const persisted: BaseMessage[] = [
			new HumanMessage("Fasse Kontakt zusammen"),
			new AIMessage({
				content: "",
				tool_calls: [{ id: "c1", name: "abiliware/open_page", args: {} }],
			}),
		];
		// The client replays the same call WITH the real arguments plus the result.
		const incoming: BaseMessage[] = [
			new HumanMessage("Fasse Kontakt zusammen"),
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "c1",
						name: "abiliware/open_page",
						args: { page: "identity", term: "Mustermann, Max" },
					},
				],
			}),
			new ToolMessage({ content: "done", tool_call_id: "c1" }),
		];

		const result = reconcileThreadedHistory(persisted, incoming);

		// Only the tool result is new — the transcript is NOT duplicated.
		expect(result.messages.length).toBe(1);
		expect(result.messages[0]?._getType()).toBe("tool");
		expect(result.dropped).toBe(2);
	});

	test("a different tool-call NAME still breaks the match (loose key stays discriminating)", () => {
		const persisted: BaseMessage[] = [
			new AIMessage({
				content: "",
				tool_calls: [{ id: "c1", name: "srv/a", args: {} }],
			}),
		];
		const incoming: BaseMessage[] = [
			new AIMessage({
				content: "",
				tool_calls: [{ id: "c1", name: "srv/b", args: { x: 1 } }],
			}),
		];
		const result = reconcileThreadedHistory(persisted, incoming);
		expect(result.messages.length).toBe(1);
		expect(result.dropped).toBe(0);
	});

	test("still idempotent for a plain full-history client", () => {
		let persisted: BaseMessage[] = [];
		const transcript: BaseMessage[] = [
			new HumanMessage("Frage"),
			new AIMessage("Antwort"),
			new HumanMessage("Follow-up"),
		];
		for (let i = 0; i < 3; i++) {
			const result = reconcileThreadedHistory(persisted, transcript);
			persisted = [...persisted, ...result.messages];
		}
		expect(persisted.length).toBe(3);
	});
});
