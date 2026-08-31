// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export interface EvaluationQrel {
  reference: string;
  relevance?: number;
}

export interface EvaluationQuery {
  id: string;
  qrels: EvaluationQrel[];
  retrieved: string[];
}

export interface RetrievalMetrics {
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  evaluatedQueries: number;
  skippedQueries: number;
}

/** Pure, deterministic document-level metrics. Duplicate chunks count once. */
export function calculateRetrievalMetrics(
  queries: EvaluationQuery[],
  k: number,
): RetrievalMetrics {
  let recall = 0;
  let mrr = 0;
  let ndcg = 0;
  let evaluated = 0;
  let skipped = 0;
  const cutoff = Math.max(1, Math.floor(k));

  for (const query of queries) {
    const relevance = new Map<string, number>();
    for (const qrel of query.qrels) {
      const ref = qrel.reference.trim();
      if (!ref) continue;
      relevance.set(ref, Math.max(relevance.get(ref) ?? 0, qrel.relevance ?? 1));
    }
    if (relevance.size === 0) {
      skipped++;
      continue;
    }
    evaluated++;
    const ranked = [...new Set(query.retrieved.map((ref) => ref.trim()).filter(Boolean))].slice(0, cutoff);
    const relevantHits = ranked.filter((ref) => (relevance.get(ref) ?? 0) > 0).length;
    recall += relevantHits / relevance.size;

    const first = ranked.findIndex((ref) => (relevance.get(ref) ?? 0) > 0);
    if (first >= 0) mrr += 1 / (first + 1);

    const dcg = ranked.reduce((sum, ref, index) => {
      const grade = relevance.get(ref) ?? 0;
      return sum + (Math.pow(2, grade) - 1) / Math.log2(index + 2);
    }, 0);
    const idealGrades = [...relevance.values()].sort((a, b) => b - a).slice(0, cutoff);
    const idcg = idealGrades.reduce(
      (sum, grade, index) => sum + (Math.pow(2, grade) - 1) / Math.log2(index + 2),
      0,
    );
    ndcg += idcg === 0 ? 0 : dcg / idcg;
  }

  const rounded = (value: number) => Math.round(value * 1e12) / 1e12;
  return {
    recallAtK: evaluated ? rounded(recall / evaluated) : 0,
    mrr: evaluated ? rounded(mrr / evaluated) : 0,
    ndcgAtK: evaluated ? rounded(ndcg / evaluated) : 0,
    evaluatedQueries: evaluated,
    skippedQueries: skipped,
  };
}

export interface ScoredEvaluationQuery extends EvaluationQuery {
  scores: number[];
}

export interface QueryEvaluationDetail {
  id: string;
  expected: string[];
  retrieved: string[];
  hits: string[];
  misses: string[];
  first_relevant_rank: number | null;
  recall: number;
  scores: number[];
}

export interface ScoreDistribution {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

function scoreDistribution(values: number[]): ScoreDistribution {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p95: null };
  const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
  };
}

export function buildEvaluationReport(queries: ScoredEvaluationQuery[], cutoffs: number[]): {
  metricsByCutoff: Record<string, RetrievalMetrics>;
  queries: QueryEvaluationDetail[];
  scoreStatistics: { relevant: ScoreDistribution; nonrelevant: ScoreDistribution };
} {
  const uniqueCutoffs = [...new Set(cutoffs)].sort((a, b) => a - b);
  const maxCutoff = uniqueCutoffs[uniqueCutoffs.length - 1] ?? 1;
  const relevantScores: number[] = [];
  const nonrelevantScores: number[] = [];
  const details = queries.map((query) => {
    const expected = [...new Set(query.qrels.filter((qrel) => (qrel.relevance ?? 1) > 0).map((qrel) => qrel.reference.trim()).filter(Boolean))];
    const expectedSet = new Set(expected);
    const retrieved = [...new Set(query.retrieved.map((reference) => reference.trim()).filter(Boolean))].slice(0, maxCutoff);
    const hits = retrieved.filter((reference) => expectedSet.has(reference));
    retrieved.forEach((reference, index) => (expectedSet.has(reference) ? relevantScores : nonrelevantScores).push(query.scores[index] ?? Number.NaN));
    const first = retrieved.findIndex((reference) => expectedSet.has(reference));
    return {
      id: query.id,
      expected,
      retrieved,
      hits,
      misses: expected.filter((reference) => !hits.includes(reference)),
      first_relevant_rank: first < 0 ? null : first + 1,
      recall: expected.length === 0 ? 0 : hits.length / expected.length,
      scores: query.scores.slice(0, maxCutoff),
    };
  });
  return {
    metricsByCutoff: Object.fromEntries(uniqueCutoffs.map((cutoff) => [String(cutoff), calculateRetrievalMetrics(queries, cutoff)])),
    queries: details,
    scoreStatistics: { relevant: scoreDistribution(relevantScores), nonrelevant: scoreDistribution(nonrelevantScores) },
  };
}
