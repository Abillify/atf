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

function errorRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function errorStatus(error: unknown): number | undefined {
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
		if (seen.has(current)) break;
		seen.add(current);
		const record = errorRecord(current);
		if (record === undefined) break;
		for (const key of ["statusCode", "status", "httpStatusCode"]) {
			const status = record[key];
			if (typeof status === "number" && Number.isInteger(status)) return status;
		}
		current = record.cause;
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
]);

function transportCode(error: unknown): string | undefined {
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
		if (seen.has(current)) break;
		seen.add(current);
		const record = errorRecord(current);
		if (record === undefined) break;
		if (typeof record.code === "string" && TRANSPORT_CODES.has(record.code)) {
			return record.code;
		}
		current = record.cause;
	}
	return undefined;
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

	const message = error instanceof Error ? error.message : String(error);
	return /(?:fetch failed|network error|socket hang up|socket closed|tls handshake|connection (?:refused|reset)|timed? out)/iu.test(
		message,
	)
		? "NETWORK_ERROR"
		: undefined;
}

export function isProviderTransportError(
	error: unknown,
	options: { requestTimedOut?: boolean; flowAborted?: boolean } = {},
): boolean {
	return providerTransportErrorCode(error, options) !== undefined;
}
