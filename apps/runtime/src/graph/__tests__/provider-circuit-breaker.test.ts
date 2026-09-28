// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
	createObservedProviderCircuitBreaker,
	createProviderCircuitBreaker,
	describeProviderError,
	isProviderTransportError,
	providerTransportErrorCode,
} from "../provider-circuit-breaker.js";

describe("provider circuit breaker", () => {
	test("exposes failure details while opening and resets after cooldown", () => {
		let now = 1_000;
		const breaker = createProviderCircuitBreaker({
			failureThreshold: 2,
			cooldownMs: 30_000,
			now: () => now,
		});

		expect(
			breaker.recordTransportFailure("openai", "ECONNREFUSED"),
		).toEqual({
			state: "closed",
			failure_count: 1,
			failure_threshold: 2,
			last_transport_error_code: "ECONNREFUSED",
			cooldown_ms: 30_000,
		});
		expect(breaker.isOpen("openai")).toBe(false);
		expect(breaker.recordTransportFailure("openai", "HTTP_503")).toEqual({
			state: "open",
			failure_count: 2,
			failure_threshold: 2,
			last_transport_error_code: "HTTP_503",
			open_until: 31_000,
			cooldown_ms: 30_000,
		});
		expect(breaker.getState("openai")).toMatchObject({
			state: "open",
			open_until: 31_000,
		});
		expect(breaker.isOpen("bedrock")).toBe(false);

		now += 30_001;
		expect(
			breaker.recordTransportFailure("openai", "ECONNRESET"),
		).toEqual({
			state: "closed",
			failure_count: 1,
			failure_threshold: 2,
			last_transport_error_code: "ECONNRESET",
			cooldown_ms: 30_000,
		});
	});

	test("a reachable response resets consecutive failures", () => {
		const breaker = createProviderCircuitBreaker({ failureThreshold: 2 });
		breaker.recordTransportFailure("openai", "ECONNRESET");
		breaker.recordReachable("openai");

		expect(breaker.recordTransportFailure("openai", "ECONNRESET")).toMatchObject(
			{
				state: "closed",
				failure_count: 1,
			},
		);
		expect(breaker.isOpen("openai")).toBe(false);
	});
});

describe("observed provider circuit breaker", () => {
	test("decides flow-locally while the observer accumulates across executions", () => {
		const observer = createProviderCircuitBreaker({ failureThreshold: 2 });

		// Two consecutive "executions", each with its own breaker, each seeing a
		// single transport failure.
		for (const _execution of ["exec-1", "exec-2"]) {
			const perExecution = createObservedProviderCircuitBreaker(observer, {
				failureThreshold: 2,
			});
			expect(
				perExecution.recordTransportFailure("openai", "ECONNREFUSED"),
			).toMatchObject({ state: "closed", failure_count: 1 });
			// One failure never opens a fresh flow-local breaker, so the next
			// execution still tries the provider.
			expect(perExecution.isOpen("openai")).toBe(false);
		}

		// The long-lived observer saw BOTH failures and crossed its threshold —
		// this is what the operator monitoring plane reports.
		expect(observer.getState("openai")).toMatchObject({
			state: "open",
			failure_count: 2,
			last_transport_error_code: "ECONNREFUSED",
		});
	});

	test("a reachable response clears both the local and the observed state", () => {
		const observer = createProviderCircuitBreaker({ failureThreshold: 2 });
		const breaker = createObservedProviderCircuitBreaker(observer, {
			failureThreshold: 2,
		});

		breaker.recordTransportFailure("openai", "ECONNRESET");
		expect(observer.getState("openai")).toMatchObject({ failure_count: 1 });

		breaker.recordReachable("openai");
		expect(observer.getState("openai")).toMatchObject({
			state: "closed",
			failure_count: 0,
		});
		expect(breaker.getState("openai")).toMatchObject({
			state: "closed",
			failure_count: 0,
		});
	});

	test("the observed state never influences a local decision", () => {
		const observer = createProviderCircuitBreaker({ failureThreshold: 1 });
		// Drive the observer wide open before the execution even starts.
		observer.recordTransportFailure("openai", "ECONNREFUSED");
		expect(observer.isOpen("openai")).toBe(true);

		const breaker = createObservedProviderCircuitBreaker(observer, {
			failureThreshold: 2,
		});
		expect(breaker.isOpen("openai")).toBe(false);
		expect(breaker.getState("openai")).toMatchObject({
			state: "closed",
			failure_count: 0,
		});
	});
});

describe("provider transport error classification", () => {
	test("accepts network causes, request timeout, 408, and 5xx", () => {
		expect(
			isProviderTransportError(
				new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }),
			),
		).toBe(true);
		expect(
			isProviderTransportError(new Error("aborted"), { requestTimedOut: true }),
		).toBe(true);
		expect(isProviderTransportError({ statusCode: 408 })).toBe(true);
		expect(isProviderTransportError({ status: 503 })).toBe(true);
	});

	test("extracts a stable diagnostic code", () => {
		expect(
			providerTransportErrorCode(
				new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }),
			),
		).toBe("ECONNREFUSED");
		expect(
			providerTransportErrorCode(new Error("aborted"), {
				requestTimedOut: true,
			}),
		).toBe("REQUEST_TIMEOUT");
		expect(providerTransportErrorCode({ status: 503 })).toBe("HTTP_503");
		expect(providerTransportErrorCode(new Error("network error"))).toBe(
			"NETWORK_ERROR",
		);
	});

	test("rejects auth, request, conflict, quota, and flow-abort failures", () => {
		for (const status of [400, 401, 403, 404, 409, 422, 429]) {
			expect(isProviderTransportError({ status })).toBe(false);
		}
		expect(
			isProviderTransportError(
				new Error("fetch failed", { cause: { code: "ECONNRESET" } }),
				{ flowAborted: true },
			),
		).toBe(false);
	});
	test("classifies Bun socket failures wrapped in an AI SDK RetryError", () => {
		// Shape observed in production: RetryError("Failed after 3 attempts…")
		// → lastError APICallError("Cannot connect to API: …") → Bun socket error.
		const socketError = Object.assign(
			new Error("The socket connection was closed unexpectedly."),
			{ code: "ConnectionClosed" },
		);
		const apiCallError = new Error(
			"Cannot connect to API: The socket connection was closed unexpectedly.",
			{ cause: socketError },
		);
		const retryError = Object.assign(
			new Error("Failed after 3 attempts. Last error: Cannot connect to API"),
			{ lastError: apiCallError, errors: [apiCallError, apiCallError, apiCallError] },
		);
		expect(providerTransportErrorCode(retryError)).toBe("ConnectionClosed");
		// The LLM handler wraps stream errors once more.
		expect(
			providerTransportErrorCode(
				new Error("LLM provider stream failed.", { cause: retryError }),
			),
		).toBe("ConnectionClosed");
		// Without a code, the Bun/SDK wording alone is recognised.
		expect(
			providerTransportErrorCode(
				new Error("Cannot connect to API: The socket connection was closed unexpectedly."),
			),
		).toBe("NETWORK_ERROR");
	});
	test("keeps a wrapped 4xx non-transport", () => {
		const badRequest = Object.assign(new Error("context length exceeded"), {
			statusCode: 400,
		});
		const retryError = Object.assign(new Error("Failed after 1 attempts."), {
			lastError: badRequest,
		});
		expect(providerTransportErrorCode(retryError)).toBeUndefined();
	});
	test("describes the provider error chain for operators", () => {
		const cause = Object.assign(new Error("socket closed"), { code: "ConnectionClosed" });
		const described = describeProviderError(
			new Error("LLM provider stream failed.", {
				cause: Object.assign(new Error("Bad Request"), { statusCode: 400, cause }),
			}),
		);
		expect(described).toContain("LLM provider stream failed.");
		expect(described).toContain("Bad Request");
		expect(described).toContain("status=400");
		expect(described).toContain("code=ConnectionClosed");
		expect(describeProviderError(new Error("x".repeat(1_000))).length).toBeLessThanOrEqual(400);
	});
});
