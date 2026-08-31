// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
	createProviderCircuitBreaker,
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
});
