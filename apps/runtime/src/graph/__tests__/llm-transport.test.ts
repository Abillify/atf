// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, test } from "bun:test";
import {
	type ConnectRetryEvent,
	type ConnectRetryFailedEvent,
	createLlmTransportFetch,
	isolateToolsFromLlmTransportScope,
	type LlmTransportScope,
	runInLlmTransportScope,
} from "../llm-transport.js";

const reset = () =>
	Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

type Call = { via: "primary" | "fresh"; input: unknown; init: RequestInit | undefined };

function harness(
	primaryImpl: (n: number) => Promise<Response>,
	freshImpl: (n: number) => Promise<Response> = () =>
		Promise.resolve(new Response("ok")),
) {
	const calls: Call[] = [];
	let primaryCount = 0;
	let freshCount = 0;
	const primary = ((input: unknown, init?: RequestInit) => {
		calls.push({ via: "primary", input, init });
		primaryCount += 1;
		return primaryImpl(primaryCount);
	}) as unknown as typeof fetch;
	const fresh = ((input: unknown, init?: RequestInit) => {
		calls.push({ via: "fresh", input, init });
		freshCount += 1;
		return freshImpl(freshCount);
	}) as unknown as typeof fetch;
	const transport = createLlmTransportFetch({
		primary,
		fresh,
		provider: "vllm",
		model: "m",
		keepAlive: true,
		delayMs: 1,
	});
	return { calls, transport };
}

function scope() {
	const retries: ConnectRetryEvent[] = [];
	const failures: ConnectRetryFailedEvent[] = [];
	const value: LlmTransportScope = {
		requestCount: 0,
		onConnectRetry: (e) => retries.push(e),
		onConnectRetryFailed: (e) => failures.push(e),
	};
	return { value, retries, failures };
}

const init = (): RequestInit => ({ method: "POST", body: JSON.stringify({ a: 1 }) });

describe("createLlmTransportFetch", () => {
	test("retries a reset before the first byte once on a fresh connection", async () => {
		const { calls, transport } = harness(() => Promise.reject(reset()));
		const s = scope();
		const body = init();
		const res = await runInLlmTransportScope(s.value, async () => {
			await transport("http://x/v1/chat/completions", body).catch(() => undefined);
			return transport("http://x/v1/chat/completions", body);
		});
		expect(await res.text()).toBe("ok");
		expect(calls.map((c) => c.via)).toEqual(["primary", "fresh", "primary", "fresh"]);
		expect(calls[1].init).toBe(body);
		expect(calls[1].input).toBe("http://x/v1/chat/completions");
		expect(s.retries).toHaveLength(2);
		expect(s.retries[1]).toEqual({
			provider: "vllm",
			model: "m",
			requestIndex: 2,
			errorCode: "ECONNRESET",
			retryDelayMs: 1,
			keepAlive: true,
		});
		expect(s.failures).toHaveLength(0);
	});

	test("a second connection failure propagates unchanged", async () => {
		const second = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		const { calls, transport } = harness(
			() => Promise.reject(reset()),
			() => Promise.reject(second),
		);
		const s = scope();
		await expect(
			runInLlmTransportScope(s.value, () => transport("http://x", init())),
		).rejects.toBe(second);
		expect(calls).toHaveLength(2);
		expect(s.failures).toEqual([
			{
				provider: "vllm",
				model: "m",
				requestIndex: 1,
				errorCode: "ECONNRESET",
				retryErrorCode: "EPIPE",
			},
		]);
	});

	test("HTTP error responses are not retried", async () => {
		const { calls, transport } = harness(() =>
			Promise.resolve(new Response("busy", { status: 500 })),
		);
		expect((await transport("http://x", init())).status).toBe(500);
		expect(calls).toHaveLength(1);
	});

	test("timeouts and aborts are not retried", async () => {
		const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
		const abort = new DOMException("aborted", "AbortError");
		for (const error of [timeout, abort]) {
			const { calls, transport } = harness(() => Promise.reject(error));
			await expect(transport("http://x", init())).rejects.toBe(error);
			expect(calls).toHaveLength(1);
		}
	});

	test("an already aborted signal suppresses the retry", async () => {
		const controller = new AbortController();
		const { calls, transport } = harness(() => {
			controller.abort();
			return Promise.reject(reset());
		});
		await expect(
			transport("http://x", { ...init(), signal: controller.signal }),
		).rejects.toThrow("socket hang up");
		expect(calls).toHaveLength(1);
	});

	test("an abort during the pause rejects without a second request", async () => {
		const controller = new AbortController();
		const primary = (() => Promise.reject(reset())) as unknown as typeof fetch;
		let freshCalls = 0;
		const transport = createLlmTransportFetch({
			primary,
			fresh: (() => {
				freshCalls += 1;
				return Promise.resolve(new Response("ok"));
			}) as unknown as typeof fetch,
			provider: "vllm",
			model: "m",
			keepAlive: true,
			delayMs: 1_000,
		});
		const pending = transport("http://x", { ...init(), signal: controller.signal });
		setTimeout(() => controller.abort(), 5);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(freshCalls).toBe(0);
	});

	test("stream bodies are not replayed", async () => {
		const { calls, transport } = harness(() => Promise.reject(reset()));
		const body = new ReadableStream<Uint8Array>();
		await expect(
			transport("http://x", { method: "POST", body, duplex: "half" } as RequestInit),
		).rejects.toThrow("socket hang up");
		expect(calls).toHaveLength(1);
	});

	test("retries without a scope (untraced)", async () => {
		const { calls, transport } = harness(() => Promise.reject(reset()));
		expect(await (await transport("http://x", init())).text()).toBe("ok");
		expect(calls).toHaveLength(2);
	});

	test("a body failing mid-stream is never retried", async () => {
		const { calls, transport } = harness(() =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
							controller.error(reset());
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			),
		);
		const res = await transport("http://x", init());
		await expect(res.text()).rejects.toThrow("socket hang up");
		expect(calls).toHaveLength(1);
	});

	test("diagnostic callbacks that throw do not break the request", async () => {
		const { transport } = harness(() => Promise.reject(reset()));
		const res = await runInLlmTransportScope(
			{
				requestCount: 0,
				onConnectRetry: () => {
					throw new Error("boom");
				},
			},
			() => transport("http://x", init()),
		);
		expect(res.status).toBe(200);
	});
});
describe("isolateToolsFromLlmTransportScope", () => {
	test("nested provider requests from tool executions bypass the outer scope", async () => {
		const outer = scope();
		const nested = harness((n) =>
			n === 1 ? Promise.reject(reset()) : Promise.resolve(new Response("ok")),
		);
		const tools = isolateToolsFromLlmTransportScope({
			nestedLlm: {
				description: "kept",
				execute: async (arg: string) => {
					const res = await nested.transport("http://x", init());
					return `${arg}:${res.status}`;
				},
			},
			noExecute: { description: "client tool" },
		});
		const out = await runInLlmTransportScope(outer.value, () =>
			tools.nestedLlm.execute("a"),
		);
		expect(out).toBe("a:200");
		// The nested request still got its retry, but neither counted nor
		// reported in the outer scope.
		expect(nested.calls.map((c) => c.via)).toEqual(["primary", "fresh"]);
		expect(outer.value.requestCount).toBe(0);
		expect(outer.retries).toEqual([]);
		expect(tools.nestedLlm.description).toBe("kept");
		expect(tools.noExecute).toEqual({ description: "client tool" });
	});
});
