// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Differential proof for the canonical-JSON consolidation.
 *
 * Every legacy variant is reproduced here VERBATIM (source in the header of
 * each block) and compared byte-for-byte against the shared mode it was
 * migrated to, over a corpus of edge inputs: mixed-case keys (where
 * `localeCompare` and code-unit sort disagree), `undefined` members at every
 * depth, arrays containing `undefined`, unicode keys, non-finite numbers, and
 * top-level scalars.
 *
 * The ONLY accepted divergence is the top-level-`undefined` edge of the
 * stringify-based variants: the legacy functions return the value `undefined`
 * (typed `string`) there, the shared implementation returns the string
 * `"null"`. No hash-committed call site ever canonicalises a top-level
 * `undefined` (they pass contract objects, bundles, descriptors, or parsed
 * JSON), so the divergence cannot change a committed hash; the shared `"null"`
 * is strictly safer. This is asserted explicitly below rather than hidden.
 */
import { describe, expect, test } from "bun:test";

import {
	canonicalJson,
	canonicalJsonConcat,
	canonicalJsonLocale,
	canonicalJsonLocaleDrops,
	canonicalJsonNull,
	canonicalJsonValue,
	canonicalSetJson,
	canonicalSetJsonValue,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Legacy variants — copied verbatim from their sources at migration time.
// ---------------------------------------------------------------------------

/** packages/erasure-contract/src/receipt.ts (canonicalizeJson + canonicalize) */
function legacyErasureCanonicalizeJson(value: unknown): string {
	return JSON.stringify(legacyErasureCanonicalize(value));
}
function legacyErasureCanonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => legacyErasureCanonicalize(item) ?? null);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) continue;
			out[key] = legacyErasureCanonicalize(item);
		}
		return out;
	}
	return value;
}

/** packages/evidence-contract/src/index.ts (canonicalJson) */
function legacyEvidenceCanonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(legacyEvidenceCanonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${legacyEvidenceCanonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** apps/runtime/src/artifacts/analysis-artifacts.ts (stableJson) */
function legacyAnalysisStableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(legacyAnalysisStableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${legacyAnalysisStableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** apps/runtime/src/observability/evidence-bundle.ts (canonicalizeForBundleHash) */
function legacyBundleCanonicalize(value: unknown): string {
	return JSON.stringify(legacyBundleSortKeysDeep(value));
}
function legacyBundleSortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(legacyBundleSortKeysDeep);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = legacyBundleSortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/** apps/runtime/src/observability/audit-log.ts (canonicalJson — structure form) */
function legacyAuditCanonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(legacyAuditCanonicalJson);
	if (value !== null && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(src).sort()) {
			const v = src[key];
			if (v !== undefined) out[key] = legacyAuditCanonicalJson(v);
		}
		return out;
	}
	return value;
}

/** apps/runtime/src/graph/tool-loop-detection.ts (stableStringify) */
function legacyLoopStableStringify(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		return `[${value.map(legacyLoopStableStringify).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${legacyLoopStableStringify(record[key])}`)
		.join(",")}}`;
}

/** apps/gate/src/cache.ts (stableStringify + sortKeys) */
function legacyGateStableStringify(value: unknown): string {
	return JSON.stringify(legacyGateSortKeys(value));
}
function legacyGateSortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(legacyGateSortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = legacyGateSortKeys((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** apps/extract/src/jobs/snapshot.ts (stableStringify) */
function legacyExtractStableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(legacyExtractStableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${legacyExtractStableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

/** apps/runtime/src/graph/agent-harness/loop-coverage-runtime.ts (canonicalize + stringify) */
function legacyCoverageCanonicalize(value: unknown): string {
	const canonicalize = (inner: unknown): unknown => {
		if (Array.isArray(inner)) return inner.map((item) => canonicalize(item));
		if (inner !== null && typeof inner === "object") {
			return Object.fromEntries(
				Object.entries(inner as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue)]),
			);
		}
		return inner;
	};
	return JSON.stringify(canonicalize(value));
}

/** apps/search/src/evidence-pack.ts (canonicalJsonValue + stringify) */
type LegacyCanonicalJsonValue = string | number | boolean | null | LegacyCanonicalJsonValue[] | { [k: string]: LegacyCanonicalJsonValue };
function legacyEvidencePackCanonicalize(value: unknown): string {
	return JSON.stringify(legacyEvidencePackValue(value));
}
function legacyEvidencePackValue(value: unknown): LegacyCanonicalJsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		const normalized = value.map(legacyEvidencePackValue);
		return [
			...new Map(
				normalized
					.map((item) => [JSON.stringify(item), item] as const)
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
			).values(),
		];
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.filter((key) => record[key] !== undefined)
				.sort()
				.map((key) => [key, legacyEvidencePackValue(record[key])]),
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Inputs exercising every documented byte-semantics axis. */
const CORPUS: { label: string; value: unknown }[] = [
	{ label: "empty object", value: {} },
	{ label: "empty array", value: [] },
	{ label: "null", value: null },
	{ label: "true", value: true },
	{ label: "false", value: false },
	{ label: "zero", value: 0 },
	{ label: "negative zero", value: -0 },
	{ label: "number", value: 42.5 },
	{ label: "exponent number", value: 1e21 },
	{ label: "string", value: "hello" },
	{ label: "string with quotes/backslash", value: 'a"b\\c\nd' },
	{ label: "emoji string", value: "\u{1F600} äöü" },
	{ label: "flat unsorted keys", value: { b: 1, a: 2, c: 3 } },
	{ label: "nested unsorted", value: { b: { d: 1, c: 2 }, a: [{ z: 1 }, { y: 2 }] } },
	{ label: "mixed-case keys", value: { B: 1, a: 2, A: 3, b: 4 } },
	{ label: "unicode keys", value: { z: 1, ä: 2, Z: 3, Ä: 4, ß: 5 } },
	{ label: "numeric-like keys", value: { 10: "x", 9: "y", "01": "z" } },
	{ label: "undefined member", value: { a: undefined, b: 1 } },
	{ label: "only undefined member", value: { a: undefined } },
	{ label: "nested undefined member", value: { a: { b: undefined, c: 1 }, d: 2 } },
	{ label: "undefined array item", value: [1, undefined, 3] },
	{ label: "object in array with undefined", value: [{ b: undefined, a: 1 }] },
	{ label: "deeply nested", value: { a: [1, { b: [2, { c: undefined }] }], z: { y: { x: true } } } },
	{ label: "NaN", value: { n: Number.NaN } },
	{ label: "Infinity", value: { i: Number.POSITIVE_INFINITY, j: Number.NEGATIVE_INFINITY } },
	{ label: "array of arrays", value: [[3, 1], [2], []] },
	{ label: "duplicate array items", value: [2, 1, 2, 1, 3] },
	{ label: "duplicate object array items", value: [{ b: 1, a: 2 }, { a: 2, b: 1 }, { c: 3 }] },
	{ label: "empty-key", value: { "": 1 } },
	{ label: "prototype-ish keys", value: { __proto__: 1, constructor: 2, toString: 3 } },
];

// ---------------------------------------------------------------------------
// Differential assertions
// ---------------------------------------------------------------------------

/**
 * Compare a legacy string-returning variant against a shared mode. The only
 * tolerated divergence is top-level `undefined` (legacy: value `undefined`,
 * shared: `"null"`), which no hash-committed call site can produce.
 */
function expectIdentical(
	legacy: (value: unknown) => string,
	shared: (value: unknown) => string,
): void {
	for (const { label, value } of CORPUS) {
		const want = legacy(value);
		const got = shared(value);
		if (want === undefined) {
			// Stringify-based legacy variants return the value `undefined`
			// (not a string) for top-level undefined / functions.
			expect(got, `${label}: shared must fall back to "null"`).toBe("null");
			continue;
		}
		expect(got, `${label}`).toBe(want);
	}
}

describe("canonicalJson (stringify family) ≡ erasure / bundle / gate", () => {
	test("≡ @atf/erasure-contract canonicalizeJson", () => {
		expectIdentical(legacyErasureCanonicalizeJson, canonicalJson);
	});
	test("≡ runtime evidence-bundle canonicalizeForBundleHash", () => {
		expectIdentical(legacyBundleCanonicalize, canonicalJson);
	});
	test("≡ gate cache stableStringify", () => {
		expectIdentical(legacyGateStableStringify, canonicalJson);
	});
	test("top-level undefined: legacy undefined → shared \"null\" (documented)", () => {
		expect(legacyErasureCanonicalizeJson(undefined as unknown as string)).toBeUndefined();
		expect(canonicalJson(undefined)).toBe("null");
	});
});

describe("canonicalJsonConcat (concat family) ≡ extract snapshot", () => {
	test("byte-identical on every corpus input", () => {
		expectIdentical(legacyExtractStableStringify, canonicalJsonConcat);
	});
	test("integer-like keys sort lexicographically (concat family)", () => {
		// The stringify family would emit {"9":…,"10":…} here — engine key
		// enumeration rewrites integer-like keys to numeric order. The concat
		// family keeps the pure lexicographic order of the sorted key list.
		expect(canonicalJsonConcat({ 10: "x", 9: "y", "01": "z" })).toBe('{"01":"z","10":"x","9":"y"}');
		expect(canonicalJson({ 10: "x", 9: "y", "01": "z" })).toBe('{"9":"y","10":"x","01":"z"}');
	});
});

describe("canonicalJsonValue (structure form) ≡ audit-log canonicalJson", () => {
	test("structure equal on every corpus input", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalJsonValue(value), label).toEqual(legacyAuditCanonicalJson(value));
		}
	});
	test("embedded in a fixed-key object, bytes match the audit chain recipe", () => {
		const details = { b: 1, a: undefined, c: { z: [undefined, 1] } };
		const legacy = JSON.stringify({
			id: 7,
			at: "2026-01-01T00:00:00.000Z",
			actor: "u",
			role: null,
			action: "a",
			target: null,
			outcome: "success",
			details: legacyAuditCanonicalJson(details),
		});
		const shared = JSON.stringify({
			id: 7,
			at: "2026-01-01T00:00:00.000Z",
			actor: "u",
			role: null,
			action: "a",
			target: null,
			outcome: "success",
			details: canonicalJsonValue(details),
		});
		expect(shared).toBe(legacy);
	});
});

describe("canonicalJsonLocale ≡ evidence-contract canonicalJson", () => {
	test("byte-identical on every corpus input", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalJsonLocale(value), label).toBe(legacyEvidenceCanonicalJson(value));
		}
	});
	test("top-level undefined → \"null\" on both sides", () => {
		expect(legacyEvidenceCanonicalJson(undefined)).toBe("null");
		expect(canonicalJsonLocale(undefined)).toBe("null");
	});
	test("locale order really differs from code-unit order (modes must stay separate)", () => {
		const value = { B: 1, a: 2 };
		expect(canonicalJsonLocale(value)).toBe('{"a":2,"B":1}');
		expect(canonicalJson(value)).toBe('{"B":1,"a":2}');
	});
});

describe("canonicalJsonLocale ≡ analysis-artifacts stableJson", () => {
	test("byte-identical on every corpus input", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalJsonLocale(value), label).toBe(legacyAnalysisStableJson(value));
		}
	});
	test("top-level undefined → \"null\" on both sides", () => {
		expect(legacyAnalysisStableJson(undefined)).toBe("null");
		expect(canonicalJsonLocale(undefined)).toBe("null");
	});
});

describe("canonicalJsonLocaleDrops ≡ loop-coverage canonicalise", () => {
	test("byte-identical on every corpus input", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalJsonLocaleDrops(value), label).toBe(legacyCoverageCanonicalize(value));
		}
	});
});

describe("canonicalJsonNull ≡ tool-loop-detection stableStringify", () => {
	test("byte-identical on every corpus input", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalJsonNull(value), label).toBe(legacyLoopStableStringify(value));
		}
	});
	test("undefined members become null (differs from default mode)", () => {
		expect(canonicalJsonNull({ a: undefined })).toBe('{"a":null}');
		expect(canonicalJson({ a: undefined })).toBe("{}");
	});
});

describe("canonicalSetJson ≡ search evidence-pack canonicalJsonValue", () => {
	test("byte-identical on every corpus input", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalSetJson(value), label).toBe(legacyEvidencePackCanonicalize(value));
		}
	});
	test("structure form matches too", () => {
		for (const { label, value } of CORPUS) {
			expect(canonicalSetJsonValue(value), label).toEqual(legacyEvidencePackValue(value));
		}
	});
	test("arrays are set-normalised (order-insensitive, de-duplicated)", () => {
		expect(canonicalSetJson([3, 1, 2, 1])).toBe(canonicalSetJson([2, 3, 1]));
		expect(canonicalSetJson([3, 1, 2, 1])).toBe("[1,2,3]");
		// …while the ordered modes keep array order:
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});
	test("non-finite numbers become null", () => {
		expect(canonicalSetJson({ n: Number.NaN })).toBe('{"n":null}');
	});
});

describe("cross-mode sanity", () => {
	test("JSON-safe corpus values round-trip through JSON.parse of the default mode", () => {
		for (const { value } of CORPUS) {
			if (value === null || typeof value !== "object") continue;
			const text = canonicalJson(value);
			expect(typeof text).toBe("string");
			expect(() => JSON.parse(text)).not.toThrow();
		}
	});
	test("key-order independence: insertion order never changes the bytes", () => {
		const a = { alpha: 1, beta: { delta: 2, gamma: 3 } };
		const b = { beta: { gamma: 3, delta: 2 }, alpha: 1 };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJsonLocale(a)).toBe(canonicalJsonLocale(b));
		expect(canonicalJsonNull(a)).toBe(canonicalJsonNull(b));
		expect(canonicalSetJson(a)).toBe(canonicalSetJson(b));
	});
});
