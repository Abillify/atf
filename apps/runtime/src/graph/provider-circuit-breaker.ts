// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export interface ProviderCircuitSnapshot {
	state: "closed" | "open";
	failure_count: number;
	failure_threshold: number;
	last_transport_error_code?: string;
	open_until?: number;
	cooldown_ms: number;
}

export interface ProviderCircuitBreaker {
	isOpen(provider: string): boolean;
	getState(provider: string): ProviderCircuitSnapshot;
	recordTransportFailure(
		provider: string,
		errorCode?: string,
	): ProviderCircuitSnapshot;
	recordReachable(provider: string): void;
}

export interface ProviderCircuitBreakerOptions {
	failureThreshold?: number;
	cooldownMs?: number;
	now?: () => number;
}

/**
 * The recording half of a breaker. A long-lived instance can consume the
 * reachability signal of many executions without ever deciding anything about
 * them.
 */
export type ProviderCircuitObserver = Pick<
	ProviderCircuitBreaker,
	"recordTransportFailure" | "recordReachable"
>;

interface ProviderCircuitState {
	consecutiveTransportFailures: number;
	lastTransportErrorCode?: string;
	openUntil: number;
}

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 30_000;

export function createProviderCircuitBreaker(
	options: ProviderCircuitBreakerOptions = {},
): ProviderCircuitBreaker {
	const failureThreshold = Math.max(
		1,
		Math.floor(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD),
	);
	const cooldownMs = Math.max(1, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
	const now = options.now ?? Date.now;
	const states = new Map<string, ProviderCircuitState>();

	const snapshot = (
		state?: ProviderCircuitState,
	): ProviderCircuitSnapshot => ({
		state: state !== undefined && state.openUntil > 0 ? "open" : "closed",
		failure_count: state?.consecutiveTransportFailures ?? 0,
		failure_threshold: failureThreshold,
		...(state?.lastTransportErrorCode !== undefined
			? { last_transport_error_code: state.lastTransportErrorCode }
			: {}),
		...(state !== undefined && state.openUntil > 0
			? { open_until: state.openUntil }
			: {}),
		cooldown_ms: cooldownMs,
	});

	const getState = (provider: string): ProviderCircuitSnapshot => {
		const state = states.get(provider);
		if (state === undefined) return snapshot();
		if (state.openUntil > 0 && state.openUntil <= now()) {
			states.delete(provider);
			return snapshot();
		}
		return snapshot(state);
	};

	return {
		isOpen(provider) {
			return getState(provider).state === "open";
		},
		getState,
		recordTransportFailure(provider, errorCode) {
			const recorded = states.get(provider);
			const timestamp = now();
			const current =
				recorded !== undefined &&
				recorded.openUntil > 0 &&
				recorded.openUntil <= timestamp
					? undefined
					: recorded;
			const consecutiveTransportFailures =
				(current?.consecutiveTransportFailures ?? 0) + 1;
			const opened = consecutiveTransportFailures >= failureThreshold;
			const next: ProviderCircuitState = {
				consecutiveTransportFailures,
				...(errorCode !== undefined
					? { lastTransportErrorCode: errorCode }
					: current?.lastTransportErrorCode !== undefined
						? { lastTransportErrorCode: current.lastTransportErrorCode }
						: {}),
				openUntil: opened ? timestamp + cooldownMs : 0,
			};
			states.set(provider, next);
			return snapshot(next);
		},
		recordReachable(provider) {
			states.delete(provider);
		},
	};
}

/**
 * A FLOW-LOCAL breaker that additionally reports every reachability signal to a
 * long-lived `observer`.
 *
 * Two different questions are being asked of one signal, and they need
 * different scopes:
 *
 *   - "should THIS execution still try provider X?" — must stay flow-local, so
 *     one flow hitting a dead endpoint cannot open the circuit for unrelated
 *     flows. Every decision (`isOpen`, `getState`) and therefore every
 *     node diagnostic comes from the local state only.
 *   - "is provider X reachable right now?" — the operator monitoring plane asks
 *     this across the whole process, so it needs state that outlives a single
 *     execution.
 *
 * Teeing the recording side keeps both honest instead of forcing one scope onto
 * the other: sharing a single breaker would have made a failure in one flow
 * skip the provider in the next one.
 */
export function createObservedProviderCircuitBreaker(
	observer: ProviderCircuitObserver,
	options: ProviderCircuitBreakerOptions = {},
): ProviderCircuitBreaker {
	const local = createProviderCircuitBreaker(options);
	return {
		isOpen: (provider) => local.isOpen(provider),
		getState: (provider) => local.getState(provider),
		recordTransportFailure(provider, errorCode) {
			observer.recordTransportFailure(provider, errorCode);
			// The returned snapshot drives diagnostics, so it must be the local one.
			return local.recordTransportFailure(provider, errorCode);
		},
		recordReachable(provider) {
			observer.recordReachable(provider);
			local.recordReachable(provider);
		},
	};
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * The error followed by its wrapped causes, outermost first. Besides the
 * standard `cause`, this follows the AI SDK `RetryError` shape (`lastError`,
 * and the last entry of `errors`): after the SDK's own retries the provider's
 * `APICallError` — and below it the fetch/socket error — sits there, not in
 * `cause`. Bounded and cycle-safe.
 */
function errorChain(error: unknown): Record<string, unknown>[] {
	const chain: Record<string, unknown>[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
		if (seen.has(current)) break;
		seen.add(current);
		const record = errorRecord(current);
		if (record === undefined) break;
		chain.push(record);
		const errors = record.errors;
		current =
			record.cause ??
			record.lastError ??
			(Array.isArray(errors) ? errors[errors.length - 1] : undefined);
	}
	return chain;
}

function errorStatus(error: unknown): number | undefined {
	for (const record of errorChain(error)) {
		for (const key of ["statusCode", "status", "httpStatusCode"]) {
			const status = record[key];
			if (typeof status === "number" && Number.isInteger(status)) return status;
		}
	}
	return undefined;
}

const TRANSPORT_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EPIPE",
	// Bun's fetch reports socket-level failures with its own codes.
	"ConnectionRefused",
	"ConnectionClosed",
	"ConnectionReset",
	"FailedToOpenSocket",
]);

function transportCode(error: unknown): string | undefined {
	for (const record of errorChain(error)) {
		if (typeof record.code === "string" && TRANSPORT_CODES.has(record.code)) {
			return record.code;
		}
	}
	return undefined;
}

/**
 * Socket-level failure wording across Node, Bun and the AI SDK, e.g. Bun's
 * "The socket connection was closed unexpectedly" and the SDK's
 * "Cannot connect to API: …".
 */
const TRANSPORT_MESSAGE =
	/(?:fetch failed|network error|socket hang up|socket closed|socket connection was closed|cannot connect to api|unable to connect|failed to open socket|tls handshake|connection (?:refused|reset|closed)|timed? out)/iu;

function transportMessage(error: unknown): boolean {
	const chain = errorChain(error);
	if (chain.length === 0) return TRANSPORT_MESSAGE.test(String(error));
	return chain.some(
		(record) =>
			typeof record.message === "string" && TRANSPORT_MESSAGE.test(record.message),
	);
}

export function providerTransportErrorCode(
	error: unknown,
	options: { requestTimedOut?: boolean; flowAborted?: boolean } = {},
): string | undefined {
	if (options.flowAborted === true) return undefined;
	if (options.requestTimedOut === true) return "REQUEST_TIMEOUT";

	const status = errorStatus(error);
	if (status !== undefined) {
		return status === 408 || status >= 500 ? `HTTP_${status}` : undefined;
	}
	const code = transportCode(error);
	if (code !== undefined) return code;

	return transportMessage(error) ? "NETWORK_ERROR" : undefined;
}

export function isProviderTransportError(
	error: unknown,
	options: { requestTimedOut?: boolean; flowAborted?: boolean } = {},
): boolean {
	return providerTransportErrorCode(error, options) !== undefined;
}

/**
 * Operator-facing one-line description of a provider failure: the distinct
 * messages along the error chain (outermost first) plus any HTTP status or
 * error code found. Bounded to `maxChars`; meant for server-side diagnostics
 * only, never for the model stream.
 */
export function describeProviderError(error: unknown, maxChars = 400): string {
	const chain = errorChain(error);
	if (chain.length === 0) return String(error).slice(0, maxChars);
	const parts: string[] = [];
	for (const record of chain) {
		// A ZodError's message is its full issue dump; the structured summary
		// from describePromptSchemaIssues replaces it below.
		if (Array.isArray(record.issues)) continue;
		const message =
			typeof record.message === "string" ? redactValidationValue(record.message.trim()) : "";
		const name = typeof record.name === "string" ? record.name : "";
		const text = name !== "" && message !== "" ? `${name}: ${message}` : message || name;
		if (text !== "" && !parts.includes(text)) parts.push(text);
	}
	const status = errorStatus(error);
	const code = chain.find((record) => typeof record.code === "string")?.code;
	const suffix = [
		...(status !== undefined ? [`status=${status}`] : []),
		...(typeof code === "string" ? [`code=${code}`] : []),
	].join(" ");
	const issues = describePromptSchemaIssues(error);
	const issueText =
		issues !== undefined && issues.length > 0
			? ` [schema: ${issues.map(formatPromptSchemaIssue).join("; ")}]`
			: "";
	const description = `${parts.join(" <- ")}${suffix !== "" ? ` (${suffix})` : ""}${issueText}`;
	return description.length > maxChars
		? `${description.slice(0, maxChars - 1)}…`
		: description;
}

/**
 * The AI SDK's `TypeValidationError` message embeds the complete rejected
 * value (`Value: [...full prompt...]`) followed by the raw Zod issue dump.
 * Both are dropped: the prompt must never reach diagnostics, and its length
 * pushed the actual cause past the diagnostic truncation limit.
 */
function redactValidationValue(message: string): string {
	const index = message.indexOf("Value:");
	if (index < 0 || !/type validation failed/iu.test(message)) return message;
	return message.slice(0, index).replace(/[\s:]+$/u, "");
}

/** One structural prompt-schema violation; carries no prompt content. */
export interface PromptSchemaIssue {
	/** JSON path into the rejected value, e.g. `[5, "content", 0, "output", "type"]`. */
	path: Array<string | number>;
	code: string;
	message: string;
	/** Role of the offending message when the path points into a message array. */
	role?: string;
}

const MAX_PROMPT_SCHEMA_ISSUES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function mismatchesDiscriminator(branch: unknown): boolean {
	return (
		Array.isArray(branch) &&
		branch.some(
			(issue) =>
				isRecord(issue) &&
				issue.code === "invalid_value" &&
				Array.isArray(issue.path) &&
				issue.path.length === 1 &&
				(issue.path[0] === "role" || issue.path[0] === "type"),
		)
	);
}

/**
 * Flattens Zod union issues into leaf issues with absolute paths. Union
 * branches for the wrong role (`expected "system"` on a tool message) are
 * noise; the deepest leaves are the branch that almost matched.
 */
function leafIssues(
	issues: unknown,
	prefix: Array<string | number>,
	out: PromptSchemaIssue[],
	depth = 0,
): void {
	if (!Array.isArray(issues) || depth > 12 || out.length > 200) return;
	for (const raw of issues) {
		if (!isRecord(raw)) continue;
		const path = [
			...prefix,
			...(Array.isArray(raw.path)
				? raw.path.filter(
						(p): p is string | number => typeof p === "string" || typeof p === "number",
					)
				: []),
		];
		const rawBranches = raw.errors ?? raw.unionErrors;
		if (Array.isArray(rawBranches) && rawBranches.length > 0) {
			const branches = rawBranches.map((branch) =>
				isRecord(branch) && !Array.isArray(branch) ? branch.issues : branch,
			);
			// Drop branches rejected on a literal discriminator (`role`/`type`):
			// they describe a different message/part kind, not the near miss.
			const relevant = branches.filter((branch) => !mismatchesDiscriminator(branch));
			for (const branch of relevant.length > 0 ? relevant : branches) {
				leafIssues(branch, path, out, depth + 1);
			}
			continue;
		}
		out.push({
			path,
			code: typeof raw.code === "string" ? raw.code : "invalid",
			message: typeof raw.message === "string" ? raw.message.slice(0, 160) : "Invalid input",
		});
	}
}

/**
 * Extracts the most specific Zod issues behind an AI SDK prompt validation
 * failure (`AI_InvalidPromptError` <- `AI_TypeValidationError` <- ZodError).
 * Returns undefined for any other error. Only paths, codes, Zod messages and
 * message roles are reported — never message content.
 */
export function describePromptSchemaIssues(error: unknown): PromptSchemaIssue[] | undefined {
	const chain = errorChain(error);
	const zod = chain.find((record) => Array.isArray(record.issues));
	if (zod === undefined) return undefined;
	const validated = chain.find((record) => "value" in record)?.value;
	const all: PromptSchemaIssue[] = [];
	leafIssues(zod.issues, [], all);
	if (all.length === 0) return [];
	const maxDepth = Math.max(...all.map((issue) => issue.path.length));
	const seen = new Set<string>();
	const deepest: PromptSchemaIssue[] = [];
	for (const issue of all) {
		if (issue.path.length !== maxDepth) continue;
		const key = `${issue.path.join(".")}|${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const index = issue.path[0];
		const message =
			Array.isArray(validated) && typeof index === "number" ? validated[index] : undefined;
		const role = isRecord(message) && typeof message.role === "string" ? message.role : undefined;
		deepest.push(role !== undefined ? { ...issue, role } : issue);
		if (deepest.length >= MAX_PROMPT_SCHEMA_ISSUES) break;
	}
	return deepest;
}

export function formatPromptSchemaIssue(issue: PromptSchemaIssue): string {
	const path = issue.path
		.map((segment, i) =>
			typeof segment === "number" ? `[${segment}]` : i === 0 ? segment : `.${segment}`,
		)
		.join("");
	return `${issue.role !== undefined ? `${issue.role} ` : ""}${path || "<root>"}: ${issue.message}`;
}
