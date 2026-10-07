// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";

import {
	ERASURE_RECEIPT_TYPE,
	ErasureReceiptPayloadSchema,
	canonicalizeJson,
	type ErasureReceiptPayload,
} from "../src/receipt.ts";

const RECEIPT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function receipt(overrides: Partial<ErasureReceiptPayload> = {}): ErasureReceiptPayload {
	return ErasureReceiptPayloadSchema.parse({
		receiptId: RECEIPT_ID,
		requestId: REQUEST_ID,
		tenantId: "acme",
		scope: "subject",
		subjectHashes: ["a".repeat(64)],
		completedAt: "2026-10-06T12:00:00Z",
		results: [{ store: "search.chunks", status: "ok", erased: 40 }],
		status: "complete",
		...overrides,
	});
}

describe("ErasureReceiptPayloadSchema", () => {
	test("accepts a well-formed receipt", () => {
		const parsed = receipt();
		expect(parsed.status).toBe("complete");
		expect(parsed.subjectHashes).toHaveLength(1);
	});

	test("rejects cleartext subject hashes (must be 64 hex)", () => {
		expect(() => receipt({ subjectHashes: ["user-1"] })).toThrow();
		expect(() => receipt({ subjectHashes: ["A".repeat(64)] })).toThrow(); // uppercase
	});

	test("requires at least one store result", () => {
		expect(() => receipt({ results: [] })).toThrow();
	});

	test("requires a valid completedAt instant", () => {
		expect(() => receipt({ completedAt: "yesterday" })).toThrow();
	});

	test("rejects unknown status values", () => {
		expect(() => receipt({ status: "done" as ErasureReceiptPayload["status"] })).toThrow();
	});
});

describe("canonicalizeJson", () => {
	test("sorts object keys recursively", () => {
		const a = canonicalizeJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
		const b = canonicalizeJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
		expect(a).toBe(b);
		expect(a).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
	});

	test("omits undefined members", () => {
		expect(canonicalizeJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	test("preserves array order", () => {
		expect(canonicalizeJson([2, 1, 3])).toBe("[2,1,3]");
	});

	test("is stable for a receipt payload", () => {
		const payload = receipt();
		const first = canonicalizeJson(payload);
		// Re-parsing through zod (which applies defaults) must not change bytes.
		const again = canonicalizeJson(ErasureReceiptPayloadSchema.parse(payload));
		expect(again).toBe(first);
	});

	test("changing any byte changes the canonical form (signing source)", () => {
		const base = canonicalizeJson(receipt());
		const modified = canonicalizeJson(receipt({ results: [{ store: "x", status: "ok", erased: 41 }] }));
		expect(modified).not.toBe(base);
	});
});

describe("receipt type", () => {
	test("discriminator is fixed", () => {
		expect(ERASURE_RECEIPT_TYPE).toBe("atf-erasure-receipt/1.0.0");
	});
});
