// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/canonical-json — the ONE canonical-JSON implementation of the monorepo.
 *
 * Before this package existed, the monorepo carried five hand-rolled
 * canonical-JSON variants whose outputs feed SECURITY- and DURABILITY-bound
 * hashes (signed erasure receipts, the Runtime audit chain, evidence-bundle
 * HMACs, action-contract hashes, tool-authz policy hashes, cache keys). Their
 * byte semantics were NOT interchangeable, so they cannot simply be replaced
 * by one function without changing already-committed hashes. This package
 * unifies them behind a single recursive core with explicitly named,
 * documented modes; every former variant maps onto exactly one mode, and the
 * differential test (`test/differential.test.ts`) proves byte-identity against
 * the original implementations on edge inputs.
 *
 * The hash-committed call sites fall into TWO byte families, which differ on
 * one subtle input class — object keys that look like array indices
 * (`{"9": …, "10": …}`):
 *
 *  - **stringify family** — canonicalise into an intermediate object, then
 *    `JSON.stringify`. The JS engine enumerates integer-like keys first in
 *    ascending numeric order, so `{10:"x",9:"y","01":"z"}` serialises as
 *    `{"9":"y","10":"x","01":"z"}` no matter how the keys were sorted.
 *  - **concat family** — build the JSON text directly from the sorted key
 *    list, so the order is purely lexicographic:
 *    `{"01":"z","10":"x","9":"y"}`.
 *
 * Both families are exposed; every call site keeps the family its committed
 * hashes were produced with (the differential test proves byte-identity).
 * The modes (differences are ONLY in serializer, key order and `undefined`
 * handling — everything else is shared):
 *
 * | mode | serializer | key order | `undefined` member | used by |
 * | ---- | ---------- | --------- | ------------------ | ------- |
 * | {@link canonicalJson} | stringify | UTF-16 code-unit (`Array#sort()`) | dropped | erasure receipts, evidence bundles, audit chain, gate cache keys |
 * | {@link canonicalJsonValue} | structure form of {@link canonicalJson} | — | dropped | audit chain (embedded in a fixed-key object) |
 * | {@link canonicalJsonConcat} | concat | UTF-16 code-unit | dropped | Extract pipeline/prompt hashes |
 * | {@link canonicalJsonNull} | concat | UTF-16 code-unit | serialised as `null` | Runtime tool-loop detection (ephemeral) |
 * | {@link canonicalJsonLocale} | concat | `localeCompare` | serialised as `null` | evidence action contracts (signed/verified wire hashes — order frozen by issuance) |
 * | {@link canonicalJsonLocaleDrops} | stringify | `localeCompare` | dropped | Runtime coverage-search keys |
 * | {@link canonicalSetJson} | stringify | UTF-16 code-unit | dropped | Search evidence-pack hashes: ADDITIONALLY de-duplicates and sorts ARRAY elements (set normalisation of evidence arrays — intentional, never merge with the modes above) |
 *
 * Input domain: JSON-safe values (the output of `JSON.parse`, or objects built
 * from contract schemas). Values with `toJSON()`, functions, symbols, `-0` or
 * non-finite numbers are not part of any hash-committed call site; where they
 * appear they follow `JSON.stringify`'s own coercion (non-finite → `null`).
 */

/** Key comparison used when canonicalising object keys. */
export type CanonicalKeyOrder = "codeunit" | "locale";

/** What happens to object members whose value is `undefined`. */
export type CanonicalUndefinedHandling = "drop" | "null";

export interface CanonicalizeOptions {
	/**
	 * `"codeunit"` — `Array#sort()` default (UTF-16 code-unit order; matches
	 * byte order for the ASCII key sets of the ATF contracts).
	 * `"locale"` — `String#localeCompare`, the historical comparator of the
	 * evidence action-contract family. NOT interchangeable with `"codeunit"`
	 * for keys that differ in case or accents (e.g. `"B"` vs `"a"` sort in
	 * opposite orders), which is exactly why it survives as an explicit mode.
	 */
	keyOrder?: CanonicalKeyOrder;
	/**
	 * `"drop"` — omit members whose value is `undefined` (what
	 * `JSON.stringify` does anyway; the erasure/audit/bundle/cache family).
	 * `"null"` — serialise them as `null` (the action-contract family's
	 * hand-rolled concatenation emitted `"key":null`).
	 */
	undefinedAs?: CanonicalUndefinedHandling;
}

/**
 * Recursive canonical structure: object keys sorted at every depth, arrays
 * kept in order (JSON arrays are ordered data; Postgres `jsonb` preserves
 * array order too). The returned value is safe to `JSON.stringify` — with
 * `undefinedAs: "drop"` the stringify output equals the canonical bytes of
 * {@link canonicalJson}.
 */
export function canonicalizeValue(value: unknown, options: CanonicalizeOptions = {}): unknown {
	const { keyOrder = "codeunit", undefinedAs = "drop" } = options;
	if (Array.isArray(value)) {
		return value.map((item) => {
			const canonical = canonicalizeValue(item, options);
			// `undefined` array items become `null` in the `"null"` mode (the
			// hand-rolled variants emitted `null` there); in `"drop"` mode they
			// stay `undefined` and `JSON.stringify` normalises them to `null`
			// anyway — but the STRUCTURE returned by `canonicalJsonValue` must
			// keep `null` items as `null`, so only `undefined` is rewritten.
			return canonical === undefined && undefinedAs === "null" ? null : canonical;
		});
	}
	if (value !== null && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const keys = Object.keys(src);
		keys.sort(keyOrder === "locale" ? (a, b) => a.localeCompare(b) : undefined);
		const out: Record<string, unknown> = {};
		for (const key of keys) {
			const item = src[key];
			if (item === undefined) {
				if (undefinedAs === "null") out[key] = null;
				continue;
			}
			out[key] = canonicalizeValue(item, options);
		}
		return out;
	}
	return value;
}

/**
 * The default mode (stringify family): recursively key-sorted (code-unit
 * order), `undefined` members dropped, no insignificant whitespace.
 * Byte-identical to the former `canonicalizeJson` of `@atf/erasure-contract`,
 * `canonicalizeForBundleHash` (Runtime evidence bundles), and
 * `stableStringify` of the Gate cache. This is the exact byte source for
 * signed erasure receipts, evidence-bundle HMACs, audit chain hashes,
 * tool-authz policy hashes, and gate cache keys.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalizeValue(value)) ?? "null";
}

/**
 * Object form of {@link canonicalJson} for call sites that embed the
 * canonical structure inside a larger fixed-key object before stringifying
 * (the Runtime audit chain builds `{id, at, actor, …, details}` around it).
 * Byte-identical to the internal `canonicalJson` of the Runtime audit log.
 */
export function canonicalJsonValue(value: unknown): unknown {
	return canonicalizeValue(value);
}

/**
 * Concat-family core: builds the JSON text directly from the sorted key list
 * instead of going through `JSON.stringify` of an intermediate object. Kept
 * separate from {@link canonicalizeValue} because the two families differ on
 * integer-like keys (see the module header) — merging them would change
 * committed hashes.
 */
function concatCanonicalize(value: unknown, keyOrder: CanonicalKeyOrder, undefinedAs: CanonicalUndefinedHandling): string {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		return `[${value.map((item) => concatCanonicalize(item, keyOrder, undefinedAs)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	keys.sort(keyOrder === "locale" ? (a, b) => a.localeCompare(b) : undefined);
	const parts: string[] = [];
	for (const key of keys) {
		const item = record[key];
		if (item === undefined) {
			if (undefinedAs === "null") parts.push(`${JSON.stringify(key)}:null`);
			continue;
		}
		parts.push(`${JSON.stringify(key)}:${concatCanonicalize(item, keyOrder, undefinedAs)}`);
	}
	return `{${parts.join(",")}}`;
}

/**
 * Code-unit-ordered concat mode with `undefined` members dropped — the frozen
 * semantics of `stableStringify` in the Extract pipeline snapshot
 * (pipelineHash / promptHash resume keys).
 */
export function canonicalJsonConcat(value: unknown): string {
	return concatCanonicalize(value, "codeunit", "drop");
}

/**
 * Code-unit-ordered concat mode with `undefined` serialised as `null` — the
 * frozen semantics of `stableStringify` in the Runtime tool-loop detector.
 * Its hashes are ephemeral (in-process loop detection only, never persisted),
 * but the mode keeps them stable across the consolidation so an in-flight
 * detection window cannot be defeated by a deploy.
 */
export function canonicalJsonNull(value: unknown): string {
	return concatCanonicalize(value, "codeunit", "null");
}

/**
 * Locale-ordered concat mode with `undefined` serialised as `null` — the
 * frozen byte semantics of `canonicalJson` in `@atf/evidence-contract`. Its
 * output feeds `actionContractHash` values that are issued, transmitted
 * between Gate / Runtime / Search, verified against previously recorded
 * digests, and stored in audit events. Changing the comparator or serializer
 * would silently invalidate every already-issued contract hash, so this mode
 * exists verbatim; do NOT "clean up" into the default mode.
 */
export function canonicalJsonLocale(value: unknown): string {
	return concatCanonicalize(value, "locale", "null");
}

/**
 * Locale-ordered stringify mode with `undefined` members dropped — the
 * historical semantics of the Runtime coverage-search key canonicalisation
 * (`localeCompare` sort feeding a `JSON.stringify`, which drops `undefined`
 * members). Keys of these args are schema-controlled lower-case, so the
 * comparator is irrelevant in practice; the mode exists to keep the bytes
 * stable across the consolidation.
 */
export function canonicalJsonLocaleDrops(value: unknown): string {
	return JSON.stringify(canonicalizeValue(value, { keyOrder: "locale", undefinedAs: "drop" })) ?? "null";
}

/** Canonical JSON-safe scalar accepted by {@link canonicalSetJson}. */
export type CanonicalSetScalar = string | number | boolean | null;

/**
 * Set-normalising mode: like {@link canonicalJson} (code-unit key order,
 * `undefined` dropped) but arrays are treated as SETS — elements are
 * canonicalised, de-duplicated (by their serialized form) and sorted. This is
 * the exact semantics of `canonicalJsonValue` in the Search evidence pack,
 * where evidence item arrays must hash the same regardless of retrieval
 * order. Non-finite numbers become `null` (JSON coercion). NEVER merge this
 * mode into the ordered ones: dropping array order is a deliberate
 * normalisation, not a bug.
 */
export function canonicalSetJson(value: unknown): string {
	return JSON.stringify(canonicalizeSet(value));
}

/**
 * Structure form of {@link canonicalSetJson} for call sites that embed the
 * normalised value in a larger object before hashing (the Search evidence pack
 * canonicalises its `filter` on its own and merges it into the pack).
 */
export function canonicalSetJsonValue(value: unknown): unknown {
	return canonicalizeSet(value);
}

function canonicalizeSet(value: unknown): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? value : null;
		default:
			break;
	}
	if (Array.isArray(value)) {
		const normalized = value.map(canonicalizeSet);
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
				.map((key) => [key, canonicalizeSet(record[key])]),
		);
	}
	return null;
}
