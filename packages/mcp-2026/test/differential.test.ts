// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
	clientRequestMeta,
	deadlineSignal,
	jsonRpcErrorBody,
	MCP_2026_PROTOCOL_VERSION,
	paginate,
	PROTOCOL_META_KEY,
	requestMetadata,
	statelessEnvelope,
	statelessRequestBody,
	validateStatelessRequest,
} from "../src/index.ts";

// ─── Verbatim legacy copies (pre-consolidation) ─────────────────────────────

const GATE_VERSION = "2026-07-28";

/** gate `stateless-2026.ts` header() + validation block, verbatim order. */
function legacyGateValidate(
	headers: Record<string, string>,
	body: {
		jsonrpc?: string;
		id?: unknown;
		method?: unknown;
		params?: Record<string, unknown>;
		_meta?: Record<string, unknown>;
	},
): { ok: true; method: string; params: Record<string, unknown> } | { ok: false; code: number; message: string } {
	const header = (name: string) => headers[name]?.trim() || undefined;
	const protocol = header("MCP-Protocol-Version");
	if (body._meta?.["io.modelcontextprotocol/protocolVersion"] !== protocol)
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	if (protocol !== GATE_VERSION)
		return { ok: false, code: -32022, message: "UnsupportedProtocolVersion" };
	const method = typeof body.method === "string" ? body.method : undefined;
	if (!method || header("Mcp-Method") !== method)
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	const params = body.params ?? {};
	const keyed =
		method === "tools/call" ||
		method === "prompts/get" ||
		method === "io.modelcontextprotocol/skills/get" ||
		method === "io.modelcontextprotocol/apps/get";
	const uriMethod = method === "resources/read";
	const key = uriMethod ? params.uri : params.name;
	if ((keyed || uriMethod) && (typeof key !== "string" || header("Mcp-Name") !== key))
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	if (
		method === "io.modelcontextprotocol/approvals/resolve" &&
		(typeof params.requestState !== "string" || header("Mcp-Request-State") !== params.requestState)
	)
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	return { ok: true, method, params };
}

const GATE_NAMED_METHODS = [
	"tools/call",
	"prompts/get",
	"io.modelcontextprotocol/skills/get",
	"io.modelcontextprotocol/apps/get",
] as const;

/** search `mcp.ts` validation block, verbatim order. */
function legacySearchValidate(
	headers: Record<string, string>,
	body: {
		jsonrpc?: unknown;
		id?: unknown;
		method?: unknown;
		params?: Record<string, unknown>;
		_meta?: Record<string, unknown>;
	},
): { ok: true; method: string; params: Record<string, unknown> } | { ok: false; code: number; message: string } {
	const mcp2026Header = (name: string) => {
		const value = headers[name]?.trim();
		return value || undefined;
	};
	const protocol = mcp2026Header("MCP-Protocol-Version");
	if (body._meta?.["io.modelcontextprotocol/protocolVersion"] !== protocol)
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	if (protocol !== GATE_VERSION) return { ok: false, code: -32022, message: "UnsupportedProtocolVersion" };
	const method = typeof body.method === "string" ? body.method : undefined;
	if (body.jsonrpc !== "2.0" || !method || mcp2026Header("Mcp-Method") !== method)
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	const params = body.params ?? {};
	if (
		method === "tools/call" &&
		(typeof params["name"] !== "string" || mcp2026Header("Mcp-Name") !== params["name"])
	)
		return { ok: false, code: -32020, message: "HeaderMismatch" };
	return { ok: true, method, params };
}

/** gate `paginate`, verbatim. */
function legacyGatePaginate<T>(
	items: T[],
	params: Record<string, unknown>,
): { items: T[]; nextCursor?: string } {
	const rawPageSize = params.pageSize;
	const pageSize = rawPageSize === undefined ? 100 : rawPageSize;
	if (
		typeof pageSize !== "number" ||
		!Number.isSafeInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > 1000
	) {
		throw new Error(`pageSize must be an integer between 1 and 1000`);
	}
	const rawCursor = params.cursor;
	if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor))) {
		throw new Error("Invalid pagination cursor");
	}
	const offset = rawCursor === undefined ? 0 : Number(rawCursor);
	if (!Number.isSafeInteger(offset)) throw new Error("Invalid pagination cursor");
	const pageItems = items.slice(offset, offset + pageSize);
	const nextOffset = offset + pageItems.length;
	return {
		items: pageItems,
		...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
	};
}

class LegacyTransactionError extends Error {
	constructor(
		readonly status: number,
		readonly body: { code: string },
		message: string,
	) {
		super(message);
	}
}

/** search `mcp2026Page`, verbatim (typed errors instead of plain Error). */
function legacySearchPage<T>(
	items: T[],
	params: Record<string, unknown>,
): { items: T[]; nextCursor?: string } {
	const size = params["pageSize"] ?? 100;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > 1000) {
		throw new LegacyTransactionError(400, { code: "INVALID_PAGE_SIZE" }, "pageSize must be an integer between 1 and 1000");
	}
	const rawCursor = params["cursor"];
	if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor))) {
		throw new LegacyTransactionError(400, { code: "INVALID_CURSOR" }, "Invalid pagination cursor");
	}
	const offset = rawCursor === undefined ? 0 : Number(rawCursor);
	if (!Number.isSafeInteger(offset)) {
		throw new LegacyTransactionError(400, { code: "INVALID_CURSOR" }, "Invalid pagination cursor");
	}
	const page = items.slice(offset, offset + size);
	const next = offset + page.length;
	return { items: page, ...(next < items.length ? { nextCursor: String(next) } : {}) };
}

/** gate `envelope`, verbatim. */
const legacyEnvelope = (serverInfo: object, fields: object, responseMeta: object = {}) => ({
	resultType: "complete",
	...fields,
	ttlMs: 0,
	cacheScope: "request",
	_meta: { serverInfo, ...responseMeta },
});

/** gate `requestMetadata`, verbatim. */
function legacyRequestMetadata(
	headers: Record<string, string>,
	body: { _meta?: Record<string, unknown> },
	params: Record<string, unknown>,
): Record<string, unknown> {
	const header = (name: string) => headers[name]?.trim() || undefined;
	const meta = {
		...(body._meta ?? {}),
		...((params._meta as Record<string, unknown> | undefined) ?? {}),
	};
	for (const [headerName, metaName] of [
		["traceparent", "traceparent"],
		["tracestate", "tracestate"],
		["Mcp-Transaction-Id", "transaction/id"],
		["Mcp-Deadline", "deadlineAt"],
	] as const) {
		const value = header(headerName);
		if (value !== undefined && meta[metaName] === undefined) meta[metaName] = value;
	}
	return meta;
}

/** gate `deadlineSignal`, verbatim. */
function legacyDeadlineSignal(meta: Record<string, unknown>): AbortSignal | undefined {
	const raw =
		meta.deadlineAt ??
		meta["transaction/deadlineAt"] ??
		meta["io.modelcontextprotocol/deadline"];
	if (raw === undefined) return undefined;
	const deadline =
		typeof raw === "number"
			? raw
			: /^\d+$/.test(String(raw))
				? Number(raw)
				: Date.parse(String(raw));
	if (!Number.isFinite(deadline)) throw new Error("Invalid deadline metadata");
	return AbortSignal.timeout(Math.max(0, deadline - Date.now()));
}

/** runtime client header/body building, verbatim. */
function legacyClientRequest(
	method: string,
	params: Record<string, unknown>,
	id: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"MCP-Protocol-Version": GATE_VERSION,
		"Mcp-Method": method,
	};
	const requestMeta =
		params._meta !== null && typeof params._meta === "object" && !Array.isArray(params._meta)
			? (params._meta as Record<string, unknown>)
			: undefined;
	const traceparent = requestMeta?.["traceparent"];
	if (typeof traceparent === "string") headers.traceparent = traceparent;
	const transactionId =
		requestMeta?.["transaction/id"] ?? requestMeta?.["transaction/invocationId"];
	if (typeof transactionId === "string") headers["Mcp-Transaction-Id"] = transactionId;
	const deadline =
		requestMeta?.["transaction/deadlineAt"] ??
		requestMeta?.["io.modelcontextprotocol/deadline"];
	if (typeof deadline === "number" || typeof deadline === "string") {
		headers["Mcp-Deadline"] = String(deadline);
	}
	const body = {
		jsonrpc: "2.0",
		id,
		method,
		params,
		_meta: {
			...requestMeta,
			["io.modelcontextprotocol/protocolVersion"]: GATE_VERSION,
		},
	};
	return { headers, body };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const V = MCP_2026_PROTOCOL_VERSION;
const reader = (headers: Record<string, string>) => (name: string) =>
	headers[name]?.trim() || undefined;

const validGateHeaders = {
	"MCP-Protocol-Version": V,
	"Mcp-Method": "tools/call",
	"Mcp-Name": "search",
};
const validGateBody = {
	jsonrpc: "2.0" as const,
	id: 1,
	method: "tools/call",
	params: { name: "search" },
	_meta: { [PROTOCOL_META_KEY]: V },
};

// ─── Protocol constants ──────────────────────────────────────────────────────

describe("protocol constants", () => {
	test("version and meta key match the wire", () => {
		expect(MCP_2026_PROTOCOL_VERSION).toBe("2026-07-28");
		expect(PROTOCOL_META_KEY).toBe("io.modelcontextprotocol/protocolVersion");
	});
});

// ─── Gate validation ─────────────────────────────────────────────────────────

describe("validateStatelessRequest · gate semantics", () => {
	const gateOptions = {
		namedMethods: GATE_NAMED_METHODS,
		resourcesReadKeyed: true,
		approvalsResolveKeyed: true,
	};
	const cases: Array<[string, Record<string, string>, Record<string, unknown>]> = [
		["valid", validGateHeaders, validGateBody],
		[
			"missing protocol header",
			{ "Mcp-Method": "tools/call", "Mcp-Name": "search" },
			validGateBody,
		],
		[
			"meta protocol missing",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/call", "Mcp-Name": "search" },
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } },
		],
		[
			"meta protocol differs",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/call", "Mcp-Name": "search" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "search" },
				_meta: { [PROTOCOL_META_KEY]: "2025-06-18" },
			},
		],
		[
			"unsupported version",
			{ "MCP-Protocol-Version": "2025-06-18", "Mcp-Method": "tools/call", "Mcp-Name": "search" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "search" },
				_meta: { [PROTOCOL_META_KEY]: "2025-06-18" },
			},
		],
		[
			"method header missing",
			{ "MCP-Protocol-Version": V, "Mcp-Name": "search" },
			validGateBody,
		],
		[
			"method header differs",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/list", "Mcp-Name": "search" },
			validGateBody,
		],
		[
			"body method not a string",
			{ "MCP-Protocol-Version": V },
			{ jsonrpc: "2.0", id: 1, method: 42, _meta: { [PROTOCOL_META_KEY]: V } },
		],
		[
			"name header missing for tools/call",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/call" },
			validGateBody,
		],
		[
			"name header differs for tools/call",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/call", "Mcp-Name": "other" },
			validGateBody,
		],
		[
			"params.name not a string",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/call", "Mcp-Name": "search" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: 7 },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"resources/read uri mismatch",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "resources/read", "Mcp-Name": "other" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "resources/read",
				params: { uri: "atf://x" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"resources/read uri match",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "resources/read", "Mcp-Name": "atf://x" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "resources/read",
				params: { uri: "atf://x" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"prompts/get name match",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "prompts/get", "Mcp-Name": "p1" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "prompts/get",
				params: { name: "p1" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"skills/get name mismatch",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "io.modelcontextprotocol/skills/get", "Mcp-Name": "a" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "io.modelcontextprotocol/skills/get",
				params: { name: "b" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"apps/get name match",
			{
				"MCP-Protocol-Version": V,
				"Mcp-Method": "io.modelcontextprotocol/apps/get",
				"Mcp-Name": "app",
			},
			{
				jsonrpc: "2.0",
				id: 1,
				method: "io.modelcontextprotocol/apps/get",
				params: { name: "app" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"approvals/resolve state match",
			{
				"MCP-Protocol-Version": V,
				"Mcp-Method": "io.modelcontextprotocol/approvals/resolve",
				"Mcp-Request-State": "req-1",
			},
			{
				jsonrpc: "2.0",
				id: 1,
				method: "io.modelcontextprotocol/approvals/resolve",
				params: { requestState: "req-1", decision: "approved" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"approvals/resolve state mismatch",
			{
				"MCP-Protocol-Version": V,
				"Mcp-Method": "io.modelcontextprotocol/approvals/resolve",
				"Mcp-Request-State": "req-2",
			},
			{
				jsonrpc: "2.0",
				id: 1,
				method: "io.modelcontextprotocol/approvals/resolve",
				params: { requestState: "req-1", decision: "approved" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"approvals/resolve state missing",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "io.modelcontextprotocol/approvals/resolve" },
			{
				jsonrpc: "2.0",
				id: 1,
				method: "io.modelcontextprotocol/approvals/resolve",
				params: { decision: "denied" },
				_meta: { [PROTOCOL_META_KEY]: V },
			},
		],
		[
			"whitespace-only headers count as absent",
			{ "MCP-Protocol-Version": "  ", "Mcp-Method": "tools/call", "Mcp-Name": "search" },
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" }, _meta: {} },
		],
		[
			"unkeyed method ignores name header",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/list" },
			{ jsonrpc: "2.0", id: 1, method: "tools/list", _meta: { [PROTOCOL_META_KEY]: V } },
		],
		[
			"jsonrpc member absent is fine for gate",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/list" },
			{ id: 1, method: "tools/list", _meta: { [PROTOCOL_META_KEY]: V } },
		],
	];
	for (const [name, headers, body] of cases) {
		test(name, () => {
			const legacy = legacyGateValidate(headers, body as never);
			const shared = validateStatelessRequest(reader(headers), body as never, gateOptions);
			if (legacy.ok !== shared.ok) {
				expect(shared.ok).toBe(legacy.ok);
				return;
			}
			if (!legacy.ok && !shared.ok) {
				expect(shared.code).toBe(legacy.code);
				expect(shared.message).toBe(legacy.message);
			}
			if (legacy.ok && shared.ok) {
				expect(shared.method).toBe(legacy.method);
				expect(shared.params).toEqual(legacy.params);
			}
		});
	}
});

// ─── Search validation ───────────────────────────────────────────────────────

describe("validateStatelessRequest · search semantics", () => {
	const searchOptions = { requireJsonrpc20: true, namedMethods: ["tools/call"] };
	const cases: Array<[string, Record<string, string>, Record<string, unknown>]> = [
		["valid", validGateHeaders, validGateBody],
		["jsonrpc absent", validGateHeaders, { id: 1, method: "tools/call", params: { name: "search" }, _meta: { [PROTOCOL_META_KEY]: V } }],
		["jsonrpc wrong", validGateHeaders, { jsonrpc: "1.0", id: 1, method: "tools/call", params: { name: "search" }, _meta: { [PROTOCOL_META_KEY]: V } }],
		[
			"prompts/get is not keyed by search",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "prompts/get" },
			{ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "p" }, _meta: { [PROTOCOL_META_KEY]: V } },
		],
		[
			"resources/read is not keyed by search",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "resources/read" },
			{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "u" }, _meta: { [PROTOCOL_META_KEY]: V } },
		],
		[
			"approvals/resolve is not keyed by search",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "io.modelcontextprotocol/approvals/resolve" },
			{ jsonrpc: "2.0", id: 1, method: "io.modelcontextprotocol/approvals/resolve", params: { requestState: "s" }, _meta: { [PROTOCOL_META_KEY]: V } },
		],
		[
			"meta protocol mismatch",
			{ "MCP-Protocol-Version": V, "Mcp-Method": "tools/list" },
			{ jsonrpc: "2.0", id: 1, method: "tools/list", _meta: { [PROTOCOL_META_KEY]: "nope" } },
		],
		[
			"unsupported version",
			{ "MCP-Protocol-Version": "2025-03-26", "Mcp-Method": "tools/list" },
			{ jsonrpc: "2.0", id: 1, method: "tools/list", _meta: { [PROTOCOL_META_KEY]: "2025-03-26" } },
		],
	];
	for (const [name, headers, body] of cases) {
		test(name, () => {
			const legacy = legacySearchValidate(headers, body as never);
			const shared = validateStatelessRequest(reader(headers), body as never, searchOptions);
			if (legacy.ok !== shared.ok) {
				expect(shared.ok).toBe(legacy.ok);
				return;
			}
			if (!legacy.ok && !shared.ok) {
				expect(shared.code).toBe(legacy.code);
				expect(shared.message).toBe(legacy.message);
			}
			if (legacy.ok && shared.ok) {
				expect(shared.method).toBe(legacy.method);
				expect(shared.params).toEqual(legacy.params);
			}
		});
	}
});

// ─── Pagination ──────────────────────────────────────────────────────────────

describe("paginate", () => {
	const items = Array.from({ length: 25 }, (_, i) => i);
	const pageCases: Array<[string, Record<string, unknown>]> = [
		["defaults", {}],
		["explicit size", { pageSize: 10 }],
		["cursor", { pageSize: 10, cursor: "10" }],
		["last partial page", { pageSize: 10, cursor: "20" }],
		["beyond end", { pageSize: 10, cursor: "30" }],
		["max size", { pageSize: 1000 }],
		["size zero", { pageSize: 0 }],
		["size too big", { pageSize: 1001 }],
		["size negative", { pageSize: -1 }],
		["size float", { pageSize: 1.5 }],
		["size string", { pageSize: "10" }],
		["cursor non-numeric", { cursor: "abc" }],
		["cursor negative", { cursor: "-1" }],
		["cursor number not string", { cursor: 5 }],
		["cursor huge", { cursor: "99999999999999999999" }],
	];
	for (const [name, params] of pageCases) {
		test(`gate · ${name}`, () => {
			const run = (fn: () => unknown) => {
				try {
					return { ok: true, value: fn() };
				} catch (err) {
					return { ok: false, message: (err as Error).message };
				}
			};
			const legacy = run(() => legacyGatePaginate(items, params));
			const shared = run(() => paginate(items, params));
			expect(shared).toEqual(legacy);
		});
		test(`search · ${name}`, () => {
			const run = (fn: () => unknown) => {
				try {
					return { ok: true, value: fn() };
				} catch (err) {
					const e = err as LegacyTransactionError;
					return { ok: false, code: e.body?.code, message: e.message, status: e.status };
				}
			};
			const legacy = run(() => legacySearchPage(items, params));
			const shared = run(() =>
				paginate(items, params, {
					invalidPageSize: (): never => {
						throw new LegacyTransactionError(400, { code: "INVALID_PAGE_SIZE" }, "pageSize must be an integer between 1 and 1000");
					},
					invalidCursor: (): never => {
						throw new LegacyTransactionError(400, { code: "INVALID_CURSOR" }, "Invalid pagination cursor");
					},
				}),
			);
			expect(shared).toEqual(legacy);
		});
	}

	test("empty catalog", () => {
		expect(paginate([], {})).toEqual({ items: [] });
	});
});

// ─── Envelope / metadata / deadline ──────────────────────────────────────────

describe("statelessEnvelope", () => {
	test("matches the gate envelope", () => {
		const serverInfo = { name: "gate", version: "1.0.0" };
		expect(statelessEnvelope(serverInfo, { tools: [] })).toEqual(
			legacyEnvelope(serverInfo, { tools: [] }),
		);
		expect(
			statelessEnvelope(serverInfo, { a: 1 }, { traceparent: "00-x-y-01" }),
		).toEqual(legacyEnvelope(serverInfo, { a: 1 }, { traceparent: "00-x-y-01" }));
	});
});

describe("requestMetadata", () => {
	const metaCases: Array<[string, Record<string, string>, Record<string, unknown>, Record<string, unknown>]> = [
		["empty", {}, {}, {}],
		[
			"headers fill gaps",
			{ traceparent: "tp", tracestate: "ts", "Mcp-Transaction-Id": "tx", "Mcp-Deadline": "123" },
			{},
			{},
		],
		[
			"body meta wins over headers",
			{ traceparent: "tp", "Mcp-Transaction-Id": "tx" },
			{ _meta: { traceparent: "body-tp" } },
			{},
		],
		[
			"params meta wins over body meta",
			{ traceparent: "tp" },
			{ _meta: { traceparent: "body-tp", "transaction/id": "body-tx" } },
			{ _meta: { traceparent: "params-tp" } },
		],
		[
			"params meta merges arbitrary keys",
			{},
			{ _meta: { a: 1 } },
			{ _meta: { b: 2 } },
		],
	];
	for (const [name, headers, body, params] of metaCases) {
		test(name, () => {
			expect(requestMetadata(reader(headers), body as never, params)).toEqual(
				legacyRequestMetadata(headers, body as never, params),
			);
		});
	}
});

describe("deadlineSignal", () => {
	test("absent metadata yields no signal", () => {
		expect(deadlineSignal({})).toBeUndefined();
		expect(legacyDeadlineSignal({})).toBeUndefined();
	});
	test("numeric epoch ms", () => {
		const at = Date.now() + 60_000;
		expect(deadlineSignal({ deadlineAt: at })?.aborted).toBe(
			legacyDeadlineSignal({ deadlineAt: at })?.aborted,
		);
	});
	test("numeric string epoch ms", () => {
		const at = String(Date.now() + 60_000);
		expect(deadlineSignal({ "transaction/deadlineAt": at })?.aborted).toBe(
			legacyDeadlineSignal({ "transaction/deadlineAt": at })?.aborted,
		);
	});
	test("ISO string", () => {
		const at = new Date(Date.now() + 60_000).toISOString();
		expect(deadlineSignal({ "io.modelcontextprotocol/deadline": at })?.aborted).toBe(
			legacyDeadlineSignal({ "io.modelcontextprotocol/deadline": at })?.aborted,
		);
	});
	test("past deadline yields an aborted signal", async () => {
		const signal = deadlineSignal({ deadlineAt: Date.now() - 1_000 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(signal?.aborted).toBe(true);
	});
	test("garbage throws on both", () => {
		expect(() => deadlineSignal({ deadlineAt: "not-a-date" })).toThrow(
			"Invalid deadline metadata",
		);
		expect(() => legacyDeadlineSignal({ deadlineAt: "not-a-date" })).toThrow(
			"Invalid deadline metadata",
		);
	});
});

// ─── Client request building ─────────────────────────────────────────────────

describe("client request building", () => {
	const clientCases: Array<[string, string, Record<string, unknown>]> = [
		["bare", "tools/list", {}],
		[
			"traceparent",
			"tools/call",
			{ name: "t", _meta: { traceparent: "00-a-b-01" } },
		],
		[
			"transaction id",
			"tools/call",
			{ name: "t", _meta: { "transaction/id": "tx-1" } },
		],
		[
			"invocation id fallback",
			"tools/call",
			{ name: "t", _meta: { "transaction/invocationId": "inv-1" } },
		],
		[
			"deadline number",
			"tools/call",
			{ name: "t", _meta: { "transaction/deadlineAt": 1234567890123 } },
		],
		[
			"deadline string",
			"tools/call",
			{ name: "t", _meta: { "io.modelcontextprotocol/deadline": "2026-01-01T00:00:00Z" } },
		],
		[
			"arbitrary meta passes through",
			"tools/call",
			{ name: "t", _meta: { custom: { nested: true } } },
		],
	];
	for (const [name, method, params] of clientCases) {
		test(name, () => {
			const legacy = legacyClientRequest(method, params, 7);
			const requestMeta =
				params._meta !== null && typeof params._meta === "object" && !Array.isArray(params._meta)
					? (params._meta as Record<string, unknown>)
					: undefined;
			const meta = clientRequestMeta(requestMeta);
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/json",
				"MCP-Protocol-Version": MCP_2026_PROTOCOL_VERSION,
				"Mcp-Method": method,
			};
			if (meta.traceparent !== undefined) headers.traceparent = meta.traceparent;
			if (meta.transactionId !== undefined) headers["Mcp-Transaction-Id"] = meta.transactionId;
			if (meta.deadline !== undefined) headers["Mcp-Deadline"] = String(meta.deadline);
			const body = statelessRequestBody(7, method, params, requestMeta ?? {});
			expect(headers).toEqual(legacy.headers);
			expect(body).toEqual(legacy.body);
		});
	}
});

// ─── Error envelope ──────────────────────────────────────────────────────────

describe("jsonRpcErrorBody", () => {
	test("nulls a missing id", () => {
		expect(jsonRpcErrorBody(undefined, -32600, "Method not allowed")).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "Method not allowed" },
		});
	});
	test("keeps a present id", () => {
		expect(jsonRpcErrorBody(3, -32020, "HeaderMismatch")).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32020, message: "HeaderMismatch" },
		});
	});
});
