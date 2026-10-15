// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure, deterministic retrieval metrics for the golden-set harness.
 *
 * A single evaluation case is one golden question expanded into three parallel
 * views, because the golden set annotates answers at three granularities:
 *
 *   - page   — the answer lives on one of the expected pages,
 *   - figure — the answer is one of the expected figures,
 *   - overall — page and figure references combined (used for MRR).
 *
 * Recall@k, MRR and nDCG@k are computed the same way as the server-side
 * `retrieval-evaluation.ts`: duplicate references count once, the first relevant
 * rank drives the reciprocal rank, and empty ground truth is skipped rather than
 * scored as a miss. Figure-Hit-Rate is defined separately below.
 */

/** A ranked list of references produced for one question, best first. */
export interface RankedResult {
	/** All references the hit contributes, e.g. document, page(s), figure(s). */
	references: string[];
}

/** The three reference views a hit exposes at rank position `i`. */
export interface RankedHit {
	pageRefs: string[];
	figureRefs: string[];
	/** Raw retrieval score of the hit, when the harness captured one. */
	score?: number;
}

/** One evaluation case: expected references plus the ranked hits. */
export interface EvalCase {
	id: string;
	expectedPageRefs: string[];
	expectedFigureRefs: string[];
	/** Ranked hits, best first. */
	hits: RankedHit[];
	/** Unanswerable question: the correct outcome is "no hit" (abstention). */
	abstain?: boolean;
}

export interface RecallMetrics {
	recallAtK: number;
	mrr: number;
	ndcgAtK: number;
	evaluatedQueries: number;
	skippedQueries: number;
}

const round = (value: number): number => Math.round(value * 1e12) / 1e12;

/**
 * Rank the first position at which any relevant reference appears, and the set
 * of relevant references found within the cutoff. `perRankRefs[i]` is the set of
 * references contributed by the hit at rank `i`.
 */
function scoreRanked(
	perRankRefs: string[][],
	relevant: Set<string>,
	k: number,
): { firstRelevantRank: number | null; hitRefs: Set<string> } {
	const cutoff = Math.max(1, Math.floor(k));
	const hitRefs = new Set<string>();
	let firstRelevantRank: number | null = null;
	for (let rank = 0; rank < Math.min(cutoff, perRankRefs.length); rank++) {
		let rankHasRelevant = false;
		for (const ref of perRankRefs[rank] ?? []) {
			if (relevant.has(ref)) {
				hitRefs.add(ref);
				rankHasRelevant = true;
			}
		}
		if (rankHasRelevant && firstRelevantRank === null) firstRelevantRank = rank;
	}
	return { firstRelevantRank, hitRefs };
}

/**
 * Compute Recall@k / MRR / nDCG@k over a set of cases for one granularity.
 * `select` picks the expected references and the per-rank references for that
 * granularity. All expected references have relevance grade 1.
 */
export function computeRecallMetrics(
	cases: EvalCase[],
	k: number,
	select: (c: EvalCase) => { expected: string[]; perRank: string[][] },
): RecallMetrics {
	let recall = 0;
	let mrr = 0;
	let ndcg = 0;
	let evaluated = 0;
	let skipped = 0;
	const cutoff = Math.max(1, Math.floor(k));

	for (const testCase of cases) {
		const { expected, perRank } = select(testCase);
		const relevant = new Set(expected.map((r) => r.trim()).filter(Boolean));
		if (relevant.size === 0) {
			skipped++;
			continue;
		}
		evaluated++;
		const { firstRelevantRank, hitRefs } = scoreRanked(
			perRank,
			relevant,
			cutoff,
		);
		recall += hitRefs.size / relevant.size;
		if (firstRelevantRank !== null) mrr += 1 / (firstRelevantRank + 1);

		// Graded nDCG with binary relevance: DCG credits the earliest rank that
		// surfaces a not-yet-counted relevant reference.
		const counted = new Set<string>();
		let dcg = 0;
		for (let rank = 0; rank < Math.min(cutoff, perRank.length); rank++) {
			for (const ref of perRank[rank] ?? []) {
				if (relevant.has(ref) && !counted.has(ref)) {
					counted.add(ref);
					dcg += 1 / Math.log2(rank + 2);
				}
			}
		}
		let idcg = 0;
		for (let i = 0; i < Math.min(cutoff, relevant.size); i++) {
			idcg += 1 / Math.log2(i + 2);
		}
		ndcg += idcg === 0 ? 0 : dcg / idcg;
	}

	return {
		recallAtK: evaluated ? round(recall / evaluated) : 0,
		mrr: evaluated ? round(mrr / evaluated) : 0,
		ndcgAtK: evaluated ? round(ndcg / evaluated) : 0,
		evaluatedQueries: evaluated,
		skippedQueries: skipped,
	};
}

/** Page-level metrics: relevance is defined over expected page references. */
export function pageMetrics(cases: EvalCase[], k: number): RecallMetrics {
	return computeRecallMetrics(cases, k, (c) => ({
		expected: c.expectedPageRefs,
		perRank: c.hits.map((h) => h.pageRefs),
	}));
}

/** Figure-level metrics: relevance is defined over expected figure references. */
export function figureMetrics(cases: EvalCase[], k: number): RecallMetrics {
	return computeRecallMetrics(cases, k, (c) => ({
		expected: c.expectedFigureRefs,
		perRank: c.hits.map((h) => h.figureRefs),
	}));
}

/**
 * Overall MRR over the union of expected page and figure references — the
 * "reciprocal rank of the first correct hit at any granularity" the design asks
 * for. Returns the MRR component only.
 */
export function overallMrr(cases: EvalCase[], k: number): number {
	return computeRecallMetrics(cases, k, (c) => ({
		expected: [...c.expectedPageRefs, ...c.expectedFigureRefs],
		perRank: c.hits.map((h) => [...h.pageRefs, ...h.figureRefs]),
	})).mrr;
}

/**
 * Figure-Hit-Rate: of the questions that expect a figure, the fraction for
 * which at least one expected figure is retrieved within `k`. Questions that
 * expect no figure are ignored. Returns `{ rate, figureQuestions, hits }`.
 */
export function figureHitRate(
	cases: EvalCase[],
	k: number,
): { rate: number; figureQuestions: number; hits: number } {
	const cutoff = Math.max(1, Math.floor(k));
	let figureQuestions = 0;
	let hits = 0;
	for (const testCase of cases) {
		const relevant = new Set(
			testCase.expectedFigureRefs.map((r) => r.trim()).filter(Boolean),
		);
		if (relevant.size === 0) continue;
		figureQuestions++;
		const found = testCase.hits
			.slice(0, cutoff)
			.some((hit) => hit.figureRefs.some((ref) => relevant.has(ref)));
		if (found) hits++;
	}
	return {
		rate: figureQuestions ? round(hits / figureQuestions) : 0,
		figureQuestions,
		hits,
	};
}

export interface AbstentionMetrics {
	/** Questions with `abstain: true` (expected outcome: no hit). */
	abstainQuestions: number;
	/** Questions with an expected answer. */
	answerableQuestions: number;
	/** Cases for which the system returned no hit at the cutoff. */
	abstained: number;
	/** Abstain questions the system correctly left unanswered. */
	correctAbstentions: number;
	/** Of all abstentions, the share that was on an abstain question. */
	abstentionPrecision: number;
	/** Of the abstain questions, the share that was left unanswered. */
	abstentionRecall: number;
	/** Of the abstain questions, the share that still got a hit (1 − recall). */
	falseAnswerRate: number;
	/** Of the answerable questions, the share that got no hit (over-abstention). */
	falseAbstentionRate: number;
}

/**
 * Abstention metrics. A case counts as *answered* when at least one of the top
 * `k` hits exists (and, when `minScore` is given, carries a score ≥ `minScore`;
 * a hit without a captured score then does not count). Cases that neither
 * expect an answer nor are marked `abstain` are ignored. Without a score gate a
 * ranked retriever almost always returns a hit, so abstention recall is only
 * meaningful when a score threshold (or an empty result) models "no answer".
 */
export function abstentionMetrics(
	cases: EvalCase[],
	k: number,
	minScore?: number,
): AbstentionMetrics {
	const cutoff = Math.max(1, Math.floor(k));
	let abstainQuestions = 0;
	let answerableQuestions = 0;
	let abstained = 0;
	let correctAbstentions = 0;
	let falseAbstentions = 0;
	for (const testCase of cases) {
		const answerable =
			testCase.expectedPageRefs.length > 0 ||
			testCase.expectedFigureRefs.length > 0;
		if (testCase.abstain !== true && !answerable) continue;
		const answered = testCase.hits
			.slice(0, cutoff)
			.some(
				(hit) =>
					minScore === undefined ||
					(hit.score !== undefined && hit.score >= minScore),
			);
		if (testCase.abstain === true) {
			abstainQuestions++;
			if (!answered) {
				abstained++;
				correctAbstentions++;
			}
		} else {
			answerableQuestions++;
			if (!answered) {
				abstained++;
				falseAbstentions++;
			}
		}
	}
	return {
		abstainQuestions,
		answerableQuestions,
		abstained,
		correctAbstentions,
		abstentionPrecision: abstained ? round(correctAbstentions / abstained) : 0,
		abstentionRecall: abstainQuestions
			? round(correctAbstentions / abstainQuestions)
			: 0,
		falseAnswerRate: abstainQuestions
			? round((abstainQuestions - correctAbstentions) / abstainQuestions)
			: 0,
		falseAbstentionRate: answerableQuestions
			? round(falseAbstentions / answerableQuestions)
			: 0,
	};
}
