// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Property 7 (design.md §Eigenschaft 7, Req 4.3/4.4): RRF-Monotonie.
 *
 * "Erhöht sich der Rang eines Dokuments in einer Liste bei sonst gleichen
 * Listen, sinkt sein Fusionsscore nicht."
 *
 * The fused score is pure SQL arithmetic, so the property is checked by
 * evaluating the exact expression `buildRrfScoreSql` emits — with rank
 * columns replaced by literal values — on the real PostgreSQL instance
 * (the same engine that will execute it in production, including its
 * division/COALESCE semantics). Self-skips without TEST_POSTGRES_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import pg from "pg";
import { buildRrfScoreSql } from "../src/query-builder.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

describeIfPg("RRF-Monotonie (Property 7, Req 4.3/4.4)", () => {
	let pool: pg.Pool;

	beforeAll(() => {
		pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
	});

	afterAll(async () => {
		await pool.end();
	});

	/** Evaluate the fused-score expression with concrete rank values. */
	async function evalScore(
		rrfK: number,
		missingZero: boolean,
		weights: string[],
		ranks: (number | null)[],
	): Promise<number> {
		const terms = weights.map((weight, i) => ({
			weight,
			rankCol: ranks[i] === null ? "NULL" : String(ranks[i]),
		}));
		const expr = buildRrfScoreSql(rrfK, missingZero, terms);
		const res = await pool.query(`SELECT (${expr})::float8 AS score`);
		return Number(res.rows[0].score);
	}

	it("verbessert ein Rang den Fusionsscore nie (monoton fallend im Rang)", async () => {
		await fc.assert(
			fc.asyncProperty(
			fc.integer({ min: 1, max: 200 }), // rrfK
			fc.boolean(), // missingZero
			fc.array(fc.constantFrom("1", "0.5", "2", "3", "0.1"), {
				minLength: 1,
				maxLength: 4,
			}), // weights per list
			fc.array(fc.integer({ min: 2, max: 500 }), { minLength: 1, maxLength: 4 }), // base ranks
			fc.integer({ min: 0, max: 3 }), // which list improves
			fc.integer({ min: 1, max: 500 }), // candidate improved rank
			async (rrfK, missingZero, weights, baseRanks, listIdxRaw, improvedRaw) => {
				const listIdx = listIdxRaw % weights.length;
				// Align arity: one rank per weight.
				const ranks = weights.map((_, i) => baseRanks[i % baseRanks.length]);
				const improved = Math.min(improvedRaw, ranks[listIdx]); // only improvements
				const before = await evalScore(rrfK, missingZero, weights, ranks);
				const after = await evalScore(rrfK, missingZero, weights, [
					...ranks.slice(0, listIdx),
					improved,
					...ranks.slice(listIdx + 1),
				]);
					expect(after).toBeGreaterThanOrEqual(before - 1e-9);
				}),
				{ numRuns: 150 },
			);
	});

	it("Heben eines fehlenden Ranks (NULL → Zahl) senkt den Score nie", async () => {
		await fc.assert(
			fc.asyncProperty(
			fc.integer({ min: 1, max: 200 }),
			fc.boolean(),
			fc.array(fc.constantFrom("1", "0.5", "2", "3"), { minLength: 1, maxLength: 4 }),
			fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 4 }),
			fc.integer({ min: 0, max: 3 }),
			async (rrfK, missingZero, weights, baseRanks, listIdxRaw) => {
				const listIdx = listIdxRaw % weights.length;
				const ranks = weights.map((_, i) => baseRanks[i % baseRanks.length]);
				const withMissing = ranks.map((r, i) => (i === listIdx ? null : r));
					const before = await evalScore(rrfK, missingZero, weights, withMissing);
					const after = await evalScore(rrfK, missingZero, weights, ranks);
					expect(after).toBeGreaterThanOrEqual(before - 1e-9);
				}),
				{ numRuns: 100 },
			);
	});

	it("RRF_MISSING_ZERO=true: fehlende Listen tragen exakt 0 bei", async () => {
		await fc.assert(
			fc.asyncProperty(
			fc.integer({ min: 1, max: 200 }),
			fc.array(fc.constantFrom("1", "0.5", "2", "3"), { minLength: 2, maxLength: 4 }),
			fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 4 }),
			async (rrfK, weights, baseRanks) => {
				// Only the first list has a rank; every other list is missing.
				const ranks = weights.map((_, i) =>
					i === 0 ? baseRanks[i % baseRanks.length] : null,
				);
					const score = await evalScore(rrfK, true, weights, ranks);
					const expected = Number(weights[0]) * (1 / (rrfK + ranks[0]));
					expect(score).toBeCloseTo(expected, 9);
				}),
				{ numRuns: 60 },
			);
	});

	it("RRF_MISSING_ZERO=false: fehlende Listen tragen das Legacy-Pseudo-Rank 1/(k+1000) bei", async () => {
		await fc.assert(
			fc.asyncProperty(
			fc.integer({ min: 1, max: 200 }),
			fc.array(fc.constantFrom("1", "0.5", "2", "3"), { minLength: 2, maxLength: 4 }),
			fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 4 }),
			async (rrfK, weights, baseRanks) => {
				const ranks = weights.map((_, i) =>
					i === 0 ? baseRanks[i % baseRanks.length] : null,
				);
				const score = await evalScore(rrfK, false, weights, ranks);
					let expected = Number(weights[0]) * (1 / (rrfK + ranks[0]));
					for (let i = 1; i < weights.length; i++) {
						expected += Number(weights[i]) * (1 / (rrfK + 1000));
					}
					expect(score).toBeCloseTo(expected, 9);
				}),
				{ numRuns: 60 },
			);
	});
});
