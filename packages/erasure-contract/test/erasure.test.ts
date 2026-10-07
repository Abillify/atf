// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";

import {
	ERASURE_CONTRACT_ID,
	ErasureRequestSchema,
	ErasureResponseSchema,
	ErasureStoreResultSchema,
	erasureSubjectHash,
} from "../src/erasure.ts";

const REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("ErasureRequestSchema", () => {
	test("accepts a subject request and defaults dryRun/externalIds", () => {
		const parsed = ErasureRequestSchema.parse({
			requestId: REQUEST_ID,
			tenantId: "acme",
			subject: { userId: "u-1" },
			scope: "subject",
		});
		expect(parsed.dryRun).toBe(false);
		expect(parsed.subject?.externalIds).toEqual([]);
		expect(parsed.references).toBeUndefined();
	});

	test("accepts a tenant request without subject", () => {
		const parsed = ErasureRequestSchema.parse({
			requestId: REQUEST_ID,
			tenantId: "acme",
			scope: "tenant",
			dryRun: true,
		});
		expect(parsed.dryRun).toBe(true);
	});

	test("accepts a reference request with references", () => {
		const parsed = ErasureRequestSchema.parse({
			requestId: REQUEST_ID,
			tenantId: "acme",
			scope: "reference",
			references: ["doc-1", "doc-2"],
		});
		expect(parsed.references).toEqual(["doc-1", "doc-2"]);
	});

	test("rejects scope=subject without subject", () => {
		expect(() =>
			ErasureRequestSchema.parse({ requestId: REQUEST_ID, tenantId: "acme", scope: "subject" }),
		).toThrow();
	});

	test("rejects a subject with no identifier at all", () => {
		expect(() =>
			ErasureRequestSchema.parse({
				requestId: REQUEST_ID,
				tenantId: "acme",
				subject: {},
				scope: "subject",
			}),
		).toThrow();
	});

	test("accepts a subject identified only by external id", () => {
		const parsed = ErasureRequestSchema.parse({
			requestId: REQUEST_ID,
			tenantId: "acme",
			subject: { externalIds: ["crm-42"] },
			scope: "subject",
		});
		expect(parsed.subject?.externalIds).toEqual(["crm-42"]);
	});

	test("rejects scope=reference without references", () => {
		expect(() =>
			ErasureRequestSchema.parse({ requestId: REQUEST_ID, tenantId: "acme", scope: "reference" }),
		).toThrow();
		expect(() =>
			ErasureRequestSchema.parse({
				requestId: REQUEST_ID,
				tenantId: "acme",
				scope: "reference",
				references: [],
			}),
		).toThrow();
	});

	test("rejects a non-uuid requestId and empty tenantId", () => {
		expect(() =>
			ErasureRequestSchema.parse({ requestId: "nope", tenantId: "acme", scope: "tenant" }),
		).toThrow();
		expect(() =>
			ErasureRequestSchema.parse({ requestId: REQUEST_ID, tenantId: "", scope: "tenant" }),
		).toThrow();
	});

	test("rejects unknown scopes", () => {
		expect(() =>
			ErasureRequestSchema.parse({ requestId: REQUEST_ID, tenantId: "acme", scope: "everything" }),
		).toThrow();
	});
});

describe("ErasureStoreResultSchema", () => {
	test("accepts ok with counts", () => {
		const r = ErasureStoreResultSchema.parse({ store: "search.chunks", status: "ok", erased: 12 });
		expect(r.error).toBeUndefined();
	});

	test("accepts not_configured with zero", () => {
		const r = ErasureStoreResultSchema.parse({
			store: "extract.uploads",
			status: "not_configured",
			erased: 0,
		});
		expect(r.status).toBe("not_configured");
	});

	test("accepts failed with an error message", () => {
		const r = ErasureStoreResultSchema.parse({
			store: "gate.audit",
			status: "failed",
			erased: 0,
			error: "sink is append-only",
		});
		expect(r.error).toBe("sink is append-only");
	});

	test("rejects negative or fractional counts", () => {
		expect(() =>
			ErasureStoreResultSchema.parse({ store: "s", status: "ok", erased: -1 }),
		).toThrow();
		expect(() =>
			ErasureStoreResultSchema.parse({ store: "s", status: "ok", erased: 1.5 }),
		).toThrow();
	});

	test("rejects unknown statuses", () => {
		expect(() =>
			ErasureStoreResultSchema.parse({ store: "s", status: "skipped", erased: 0 }),
		).toThrow();
	});
});

describe("ErasureResponseSchema", () => {
	test("round-trips a multi-store response", () => {
		const response = {
			requestId: REQUEST_ID,
			service: "search",
			results: [
				{ store: "search.chunks", status: "ok", erased: 40 },
				{ store: "search.identifiers", status: "ok", erased: 3 },
				{ store: "search.stats", status: "not_configured", erased: 0 },
			],
		};
		const parsed = ErasureResponseSchema.parse(response);
		expect(ErasureResponseSchema.safeParse(parsed).success).toBe(true);
		expect(parsed.results).toHaveLength(3);
	});
});

describe("erasureSubjectHash", () => {
	test("is sha256 over tenant|identifier, lowercase hex", () => {
		const hash = erasureSubjectHash("acme", "u-1");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// Independent computation via WebCrypto to pin the format.
		const bytes = new TextEncoder().encode("acme|u-1");
		return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
			const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
			expect(hash).toBe(hex);
		});
	});

	test("differs across tenants and identifiers", () => {
		expect(erasureSubjectHash("acme", "u-1")).not.toBe(erasureSubjectHash("other", "u-1"));
		expect(erasureSubjectHash("acme", "u-1")).not.toBe(erasureSubjectHash("acme", "u-2"));
	});

	test("is stable across calls", () => {
		expect(erasureSubjectHash("acme", "mail@example.org")).toBe(
			erasureSubjectHash("acme", "mail@example.org"),
		);
	});
});

describe("contract identity", () => {
	test("id matches version", () => {
		expect(ERASURE_CONTRACT_ID).toBe("atf-erasure/1.0.0");
	});
});
