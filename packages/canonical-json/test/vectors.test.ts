// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Byte-level test vectors (`../test-vectors.json`, described in `../SPEC.md`):
 * every string mode must produce exactly the recorded bytes. A change here is
 * a change of committed hashes — never edit an expected value to make a test
 * pass; add a new mode instead.
 */
import { describe, expect, test } from "bun:test";
import vectorFile from "../test-vectors.json" with { type: "json" };
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

const MODES: Record<string, (value: unknown) => string> = {
	canonicalJson,
	canonicalJsonConcat,
	canonicalJsonNull,
	canonicalJsonLocale,
	canonicalJsonLocaleDrops,
	canonicalSetJson,
};

/** Rebuild the JS value a vector input stands for (`undefined`, non-finite numbers). */
function revive(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(revive);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length === 1 && record.$undefined === true) return undefined;
		if (keys.length === 1 && typeof record.$nonFinite === "string") return Number(record.$nonFinite);
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, revive(item)]));
	}
	return value;
}

type Vector = { name: string; input: unknown; expected: Record<string, string> };
const vectors = vectorFile.vectors as Vector[];

describe("canonical-json test vectors", () => {
	test("there are at least 20 vectors for every mode", () => {
		expect(vectors.length).toBeGreaterThanOrEqual(20);
		for (const mode of Object.keys(MODES)) {
			expect(vectors.filter((vector) => typeof vector.expected[mode] === "string").length).toBeGreaterThanOrEqual(20);
		}
	});

	for (const [mode, fn] of Object.entries(MODES)) {
		describe(mode, () => {
			for (const vector of vectors) {
				test(vector.name, () => {
					expect(fn(revive(vector.input))).toBe(vector.expected[mode] as string);
				});
			}
		});
	}

	test("the structure forms stringify to the string modes", () => {
		for (const vector of vectors) {
			const input = revive(vector.input);
			expect(JSON.stringify(canonicalJsonValue(input)) ?? "null").toBe(vector.expected.canonicalJson as string);
			expect(JSON.stringify(canonicalSetJsonValue(input))).toBe(vector.expected.canonicalSetJson as string);
		}
	});
});
