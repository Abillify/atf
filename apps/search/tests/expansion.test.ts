// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the pure small-to-big expansion assembler (task 3.6,
 * Requirement 13.4). The DB half (PostgresClient.expandUnit) is covered by
 * tests/expansion.integration.test.ts against a real PostgreSQL.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
	assembleExpansion,
	parseExpandMode,
	parseBudgetChars,
	clampBudgetChars,
	DEFAULT_EXPAND_BUDGET_CHARS,
	MAX_EXPAND_BUDGET_CHARS,
	type ExpansionUnit,
} from "../src/expansion.js";

const u = (unit_id: string | null, content: string): ExpansionUnit => ({
	unit_id,
	content,
});

describe("assembleExpansion", () => {
	it("concatenates neighbor units in the given reading order", () => {
		const units = [u("a", "prev"), u("b", "hit"), u("c", "next")];
		const out = assembleExpansion({
			mode: "neighbors",
			units,
			budgetChars: 1000,
			hitUnitId: "b",
		});
		// Hit ("b") is deduped; prev then next in reading order.
		expect(out.content).toBe("prev\n\nnext");
		expect(out.unit_count).toBe(2);
		expect(out.truncated).toBe(false);
		expect(out.mode).toBe("neighbors");
	});

	it("assembles a whole section in reading order", () => {
		const units = [
			u("s1", "para one"),
			u("s2", "para two"),
			u("s3", "para three"),
		];
		const out = assembleExpansion({
			mode: "section",
			units,
			budgetChars: 1000,
			hitUnitId: "s2",
		});
		expect(out.content).toBe("para one\n\npara three");
		expect(out.unit_count).toBe(2);
		expect(out.truncated).toBe(false);
	});

	it("assembles a whole page in reading order", () => {
		const units = [u("p1", "top"), u("p2", "middle"), u("p3", "bottom")];
		const out = assembleExpansion({
			mode: "page",
			units,
			budgetChars: 1000,
			hitUnitId: "p2",
		});
		expect(out.content).toBe("top\n\nbottom");
		expect(out.mode).toBe("page");
		expect(out.truncated).toBe(false);
	});

	it("sets truncated=true and drops units once the budget is exhausted", () => {
		const units = [
			u("a", "AAAA"), // 4
			u("b", "BBBB"), // +2 sep +4 = 10
			u("c", "CCCC"), // would be +2 sep +4 = 16 > 12
		];
		const out = assembleExpansion({
			mode: "section",
			units,
			budgetChars: 12,
			hitUnitId: "x", // no hit in set; keep all
		});
		// "AAAA" (4) + "\n\n" (2) + "BBBB" (4) = 10 ≤ 12; "CCCC" would overflow.
		expect(out.content).toBe("AAAA\n\nBBBB");
		expect(out.unit_count).toBe(2);
		expect(out.truncated).toBe(true);
	});

	it("truncated=false when everything fits exactly", () => {
		const units = [u("a", "AAAA"), u("b", "BB")];
		const out = assembleExpansion({
			mode: "section",
			units,
			budgetChars: 8, // 4 + 2 + 2 = 8
		});
		expect(out.content).toBe("AAAA\n\nBB");
		expect(out.truncated).toBe(false);
		expect(out.unit_count).toBe(2);
	});

	it("does not duplicate the hit in its own expansion (by unit_id)", () => {
		const units = [u("a", "before"), u("hit", "the hit text"), u("b", "after")];
		const out = assembleExpansion({
			mode: "neighbors",
			units,
			budgetChars: 1000,
			hitUnitId: "hit",
		});
		expect(out.content).not.toContain("the hit text");
		expect(out.content).toBe("before\n\nafter");
	});

	it("dedupes the hit by content when its unit_id is unknown", () => {
		const units = [
			u(null, "before"),
			u(null, "the hit text"),
			u(null, "after"),
		];
		const out = assembleExpansion({
			mode: "neighbors",
			units,
			budgetChars: 1000,
			hitContent: "the hit text",
		});
		expect(out.content).toBe("before\n\nafter");
	});

	it("hard-truncates a single oversized first unit to the budget", () => {
		const out = assembleExpansion({
			mode: "page",
			units: [u("big", "0123456789")],
			budgetChars: 4,
		});
		expect(out.content).toBe("0123");
		expect(out.content.length).toBe(4);
		expect(out.truncated).toBe(true);
		expect(out.unit_count).toBe(1);
	});

	it("returns empty non-truncated content when only the hit is present", () => {
		const out = assembleExpansion({
			mode: "neighbors",
			units: [u("hit", "only me")],
			budgetChars: 1000,
			hitUnitId: "hit",
		});
		expect(out.content).toBe("");
		expect(out.unit_count).toBe(0);
		expect(out.truncated).toBe(false);
	});

	it("skips empty-content units without counting them", () => {
		const out = assembleExpansion({
			mode: "section",
			units: [u("a", ""), u("b", "kept"), u("c", "")],
			budgetChars: 1000,
		});
		expect(out.content).toBe("kept");
		expect(out.unit_count).toBe(1);
		expect(out.truncated).toBe(false);
	});

	it("never mutates its input units", () => {
		const units = [u("a", "one"), u("b", "two")];
		const snapshot = JSON.stringify(units);
		assembleExpansion({ mode: "section", units, budgetChars: 2 });
		expect(JSON.stringify(units)).toBe(snapshot);
	});

	// ── Property: assembled content never exceeds the budget. ──
	it("property: assembled content length never exceeds budget_chars", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						unit_id: fc.option(fc.string({ minLength: 1, maxLength: 6 }), {
							nil: null,
						}),
						content: fc.string({ maxLength: 30 }),
					}),
					{ maxLength: 12 },
				),
				fc.integer({ min: 1, max: 200 }),
				(units, budgetChars) => {
					const out = assembleExpansion({
						mode: "section",
						units,
						budgetChars,
					});
					expect(out.content.length).toBeLessThanOrEqual(budgetChars);
					// unit_count matches the number of separators + 1 when non-empty.
					if (out.unit_count > 1) {
						expect(out.content).toContain("\n\n");
					}
				},
			),
		);
	});

	// ── Property: when nothing is dropped, truncated is false. ──
	it("property: truncated=false iff all non-empty non-hit units are included in full", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
					minLength: 1,
					maxLength: 8,
				}),
				(contents) => {
					const units = contents.map((c, i) => u(`u${i}`, c));
					// A budget large enough for everything (sum + separators) never truncates.
					const total =
						contents.reduce((s, c) => s + c.length, 0) +
						(contents.length - 1) * 2;
					const out = assembleExpansion({
						mode: "section",
						units,
						budgetChars: total + 10,
					});
					expect(out.truncated).toBe(false);
					expect(out.unit_count).toBe(contents.length);
				},
			),
		);
	});
});

describe("parseExpandMode", () => {
	it("returns undefined for absent/empty/none/off", () => {
		expect(parseExpandMode(undefined)).toBeUndefined();
		expect(parseExpandMode("")).toBeUndefined();
		expect(parseExpandMode("  ")).toBeUndefined();
		expect(parseExpandMode("none")).toBeUndefined();
		expect(parseExpandMode("off")).toBeUndefined();
	});

	it("returns the normalized mode for valid values", () => {
		expect(parseExpandMode("neighbors")).toBe("neighbors");
		expect(parseExpandMode("SECTION")).toBe("section");
		expect(parseExpandMode(" Page ")).toBe("page");
	});

	it("returns null for an unrecognized value (→ HTTP 400)", () => {
		expect(parseExpandMode("chapter")).toBeNull();
		expect(parseExpandMode("document")).toBe("document");
		expect(parseExpandMode("chunk")).toBeNull();
		expect(parseExpandMode("everything")).toBeNull();
	});
});

describe("parseBudgetChars", () => {
	it("returns undefined for absent/empty (caller uses the default)", () => {
		expect(parseBudgetChars(undefined)).toBeUndefined();
		expect(parseBudgetChars("")).toBeUndefined();
		expect(DEFAULT_EXPAND_BUDGET_CHARS).toBe(4000);
	});

	it("returns a positive integer for valid values", () => {
		expect(parseBudgetChars("100")).toBe(100);
		expect(parseBudgetChars("8000")).toBe(8000);
	});

	it("returns null for malformed / non-positive values (→ HTTP 400)", () => {
		expect(parseBudgetChars("0")).toBeNull();
		expect(parseBudgetChars("-5")).toBeNull();
		expect(parseBudgetChars("12.5")).toBeNull();
		expect(parseBudgetChars("abc")).toBeNull();
	});
});

describe("budget clamp (MAX_EXPAND_BUDGET_CHARS)", () => {
	it("parseBudgetChars clamps an over-ask to the ceiling", () => {
		expect(parseBudgetChars("999999999")).toBe(MAX_EXPAND_BUDGET_CHARS);
		expect(parseBudgetChars("5000")).toBe(5000);
	});
	it("clampBudgetChars floors, clamps and zeroes invalid values", () => {
		expect(clampBudgetChars(10.7)).toBe(10);
		expect(clampBudgetChars(Number.MAX_SAFE_INTEGER)).toBe(MAX_EXPAND_BUDGET_CHARS);
		expect(clampBudgetChars(Number.NaN)).toBe(0);
		expect(clampBudgetChars(-1)).toBe(0);
	});
	it("assembleExpansion reports and honours the clamped budget", () => {
		const big = "x".repeat(MAX_EXPAND_BUDGET_CHARS + 10);
		const out = assembleExpansion({
			mode: "section",
			units: [{ unit_id: "a", content: big }],
			budgetChars: 10_000_000,
		});
		expect(out.budget_chars).toBe(MAX_EXPAND_BUDGET_CHARS);
		expect(out.content.length).toBe(MAX_EXPAND_BUDGET_CHARS);
		expect(out.truncated).toBe(true);
	});
});
