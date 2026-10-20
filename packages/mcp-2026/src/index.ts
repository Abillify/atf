// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared Model Context Protocol 2026-07-28 stateless-HTTP core.
 *
 * The monorepo speaks the stateless MCP 2026-07-28 profile in three places:
 * the gate's `stateless-2026` router (server), the search service's
 * `createMcp2026Handlers` adapter (server) and the runtime's
 * `Stateless2026Client` (client). All three previously carried their own
 * copies of the protocol constant, header names, JSON-RPC error codes,
 * request validation, pagination and the result envelope, and the copies had
 * already started to drift. This package is the single source of truth for
 * that shared surface.
 *
 * Deliberate divergences between the three endpoints are NOT folded away:
 * the gate's catalog (resources/prompts/skills/apps/tasks/approvals), the
 * search transaction-token extension and authz filtering, and the exact
 * wire error texts (asserted by tests) stay at the call sites. The core
 * exposes them as parameters (e.g. pluggable pagination error factories) so
 * every endpoint keeps its byte-identical responses.
 */

/** The protocol version string negotiated on every stateless request. */
export const MCP_2026_PROTOCOL_VERSION = "2026-07-28";

/** `_meta` member carrying the protocol version inside the JSON-RPC body. */
export const PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";

// ─── Header names ────────────────────────────────────────────────────────────

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
export const MCP_METHOD_HEADER = "Mcp-Method";
export const MCP_NAME_HEADER = "Mcp-Name";
export const MCP_REQUEST_STATE_HEADER = "Mcp-Request-State";
export const MCP_TRANSACTION_ID_HEADER = "Mcp-Transaction-Id";
export const MCP_DEADLINE_HEADER = "Mcp-Deadline";

// ─── JSON-RPC error codes ────────────────────────────────────────────────────

/** Header/body mismatch on the stateless framing (Req: header binding). */
export const JSONRPC_HEADER_MISMATCH = -32020;
/** The peer requested a protocol version this endpoint does not speak. */
export const JSONRPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** A resource / prompt / skill / app / task / approval was not found. */
export const JSONRPC_NOT_FOUND = -32004;
/** A transaction-scoped failure surfaced as a JSON-RPC error. */
export const JSONRPC_TRANSACTION_ERROR = -32001;
/** The transaction deadline has already passed. */
export const JSONRPC_DEADLINE_EXCEEDED = -32008;
/** The dependent service (e.g. the approval signer) is unavailable. */
export const JSONRPC_SERVICE_UNAVAILABLE = -32003;
/** Invalid method parameters. */
export const JSONRPC_INVALID_PARAMS = -32602;
/** Unknown method (or unknown tool). */
export const JSONRPC_METHOD_NOT_FOUND = -32601;
/** JSON-RPC request framing is invalid (e.g. non-POST verbs). */
export const JSONRPC_INVALID_REQUEST = -32600;
/** Uncaught server-side failure. */
export const JSONRPC_INTERNAL_ERROR = -32603;

// ─── JSON-RPC response framing ───────────────────────────────────────────────

export interface JsonRpcErrorBody {
	jsonrpc: "2.0";
	id: unknown;
	error: { code: number; message: string };
}

/** The exact error envelope every MCP 2026 endpoint emits (`id ?? null`). */
export function jsonRpcErrorBody(id: unknown, code: number, message: string): JsonRpcErrorBody {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// ─── Request validation ──────────────────────────────────────────────────────

/**
 * Reads a request header with the trimming semantics both servers use:
 * whitespace-only values count as absent.
 */
export type HeaderReader = (name: string) => string | undefined;

/** Trim a raw header value to `undefined` when blank. */
export function normalizeHeaderValue(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

interface BodyLike {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface StatelessValidationOptions {
	/**
	 * When true, `body.jsonrpc !== "2.0"` is rejected together with the
	 * method header (search semantics). The gate does not inspect
	 * `jsonrpc` at this point, so it passes false.
	 */
	requireJsonrpc20?: boolean;
	/**
	 * Methods whose `params.name` must equal the `Mcp-Name` header.
	 * The gate keys prompts/skills/apps/tools; search only tools/call.
	 */
	namedMethods?: readonly string[];
	/**
	 * When true, `resources/read` requires `params.uri` to equal the
	 * `Mcp-Name` header (gate semantics).
	 */
	resourcesReadKeyed?: boolean;
	/**
	 * When true, `io.modelcontextprotocol/approvals/resolve` requires
	 * `params.requestState` to equal the `Mcp-Request-State` header
	 * (gate semantics).
	 */
	approvalsResolveKeyed?: boolean;
}

export type StatelessValidation =
	| {
			ok: true;
			protocol: string | undefined;
			method: string;
			params: Record<string, unknown>;
	  }
	| { ok: false; code: number; message: string };

/**
 * Validate the stateless 2026-07-28 framing of a request in the canonical
 * order: `_meta` protocol vs header, supported version, method header,
 * name-keyed methods, approval request-state. The first violation is
 * returned with the code/message the endpoint must emit.
 */
export function validateStatelessRequest(
	getHeader: HeaderReader,
	body: BodyLike,
	options: StatelessValidationOptions = {},
): StatelessValidation {
	const protocol = getHeader(MCP_PROTOCOL_VERSION_HEADER);
	if (body._meta?.[PROTOCOL_META_KEY] !== protocol) {
		return { ok: false, code: JSONRPC_HEADER_MISMATCH, message: "HeaderMismatch" };
	}
	if (protocol !== MCP_2026_PROTOCOL_VERSION) {
		return {
			ok: false,
			code: JSONRPC_UNSUPPORTED_PROTOCOL_VERSION,
			message: "UnsupportedProtocolVersion",
		};
	}
	const method = typeof body.method === "string" ? body.method : undefined;
	if (
		(options.requireJsonrpc20 && body.jsonrpc !== "2.0") ||
		!method ||
		getHeader(MCP_METHOD_HEADER) !== method
	) {
		return { ok: false, code: JSONRPC_HEADER_MISMATCH, message: "HeaderMismatch" };
	}
	const params = body.params ?? {};
	const named = options.namedMethods ?? [];
	const uriMethod = options.resourcesReadKeyed === true && method === "resources/read";
	const key = uriMethod ? params.uri : params.name;
	if (
		(named.includes(method) || uriMethod) &&
		(typeof key !== "string" || getHeader(MCP_NAME_HEADER) !== key)
	) {
		return { ok: false, code: JSONRPC_HEADER_MISMATCH, message: "HeaderMismatch" };
	}
	if (
		options.approvalsResolveKeyed === true &&
		method === "io.modelcontextprotocol/approvals/resolve" &&
		(typeof params.requestState !== "string" ||
			getHeader(MCP_REQUEST_STATE_HEADER) !== params.requestState)
	) {
		return { ok: false, code: JSONRPC_HEADER_MISMATCH, message: "HeaderMismatch" };
	}
	return { ok: true, protocol, method, params };
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export interface PaginateOptions {
	/**
	 * Builds the error thrown for an invalid `pageSize`. The gate throws a
	 * plain `Error`, search a typed `TransactionError` — the message text is
	 * the same on both endpoints.
	 */
	invalidPageSize?: () => Error;
	/** Builds the error thrown for an invalid `cursor`. Same rationale. */
	invalidCursor?: () => Error;
}

/**
 * Offset pagination over an in-memory catalog: numeric string cursors,
 * default page size 100, hard maximum 1000. Returns the page plus the
 * cursor for the next page when more items remain.
 */
export function paginate<T>(
	items: T[],
	params: Record<string, unknown>,
	options: PaginateOptions = {},
): { items: T[]; nextCursor?: string } {
	const pageSizeError =
		options.invalidPageSize ??
		((): Error => new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`));
	const cursorError = options.invalidCursor ?? ((): Error => new Error("Invalid pagination cursor"));
	const rawPageSize = params.pageSize;
	const pageSize = rawPageSize === undefined ? DEFAULT_PAGE_SIZE : rawPageSize;
	if (
		typeof pageSize !== "number" ||
		!Number.isSafeInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > MAX_PAGE_SIZE
	) {
		throw pageSizeError();
	}
	const rawCursor = params.cursor;
	if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor))) {
		throw cursorError();
	}
	const offset = rawCursor === undefined ? 0 : Number(rawCursor);
	if (!Number.isSafeInteger(offset)) throw cursorError();
	const pageItems = items.slice(offset, offset + pageSize);
	const nextOffset = offset + pageItems.length;
	return {
		items: pageItems,
		...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
	};
}

// ─── Result envelope ─────────────────────────────────────────────────────────

/**
 * The stateless result envelope: `resultType: "complete"`, zero TTL,
 * request-scoped caching and the server identity in `_meta`.
 */
export function statelessEnvelope(
	serverInfo: object,
	fields: object,
	responseMeta: object = {},
): Record<string, unknown> {
	return {
		resultType: "complete",
		...fields,
		ttlMs: 0,
		cacheScope: "request",
		_meta: { serverInfo, ...responseMeta },
	};
}

// ─── Request metadata ────────────────────────────────────────────────────────

/**
 * Merge request metadata: body `_meta`, overridden by `params._meta`, with
 * the transport headers `traceparent`, `tracestate`, `Mcp-Transaction-Id`
 * (→ `transaction/id`) and `Mcp-Deadline` (→ `deadlineAt`) filling gaps the
 * bodies left open.
 */
export function requestMetadata(
	getHeader: HeaderReader,
	body: BodyLike,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const meta = {
		...(body._meta ?? {}),
		...((params._meta as Record<string, unknown> | undefined) ?? {}),
	};
	for (const [headerName, metaName] of [
		["traceparent", "traceparent"],
		["tracestate", "tracestate"],
		[MCP_TRANSACTION_ID_HEADER, "transaction/id"],
		[MCP_DEADLINE_HEADER, "deadlineAt"],
	] as const) {
		const value = getHeader(headerName);
		if (value !== undefined && meta[metaName] === undefined) meta[metaName] = value;
	}
	return meta;
}

/**
 * Resolve the deadline metadata (`deadlineAt`,
 * `transaction/deadlineAt` or `io.modelcontextprotocol/deadline`) into an
 * `AbortSignal` that fires at the deadline. Throws on unparseable values.
 */
export function deadlineSignal(meta: Record<string, unknown>): AbortSignal | undefined {
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

// ─── Client-side request building ────────────────────────────────────────────

export interface ClientRequestMeta {
	traceparent?: string;
	transactionId?: string;
	deadline?: string | number;
}

/**
 * Extract the transport-relevant metadata a client mirrors into headers:
 * `traceparent`, `transaction/id` (or `transaction/invocationId`) and
 * `transaction/deadlineAt` (or `io.modelcontextprotocol/deadline`).
 */
export function clientRequestMeta(paramsMeta: Record<string, unknown> | undefined): ClientRequestMeta {
	const traceparent = paramsMeta?.traceparent;
	const transactionId =
		paramsMeta?.["transaction/id"] ?? paramsMeta?.["transaction/invocationId"];
	const deadline =
		paramsMeta?.["transaction/deadlineAt"] ??
		paramsMeta?.["io.modelcontextprotocol/deadline"];
	return {
		...(typeof traceparent === "string" ? { traceparent } : {}),
		...(typeof transactionId === "string" ? { transactionId } : {}),
		...(typeof deadline === "number" || typeof deadline === "string"
			? { deadline }
			: {}),
	};
}

/**
 * Build the JSON-RPC body of a stateless request: the request `_meta` is the
 * caller's metadata with the protocol version stamped in.
 */
export function statelessRequestBody(
	id: number | string,
	method: string,
	params: Record<string, unknown>,
	requestMeta: Record<string, unknown>,
): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id,
		method,
		params,
		_meta: { ...requestMeta, [PROTOCOL_META_KEY]: MCP_2026_PROTOCOL_VERSION },
	};
}
