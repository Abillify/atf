// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Reranker-backed summary triage (`coverageQueue.summaryTriage`).
 *
 * Pins the fail-closed contract: deterministic decisions only on a complete
 * score set, rank-based cuts, exclusions only with rank AND score AND summary
 * length, every reranker problem → no scores and no decisions, and global
 * discovery (path B) can always reopen a rerank exclusion. Also pins variant 3:
 * score-ordered Stage-1 batches and freeze, unchanged ledger order without
 * scores.
 */
import { describe, expect, test } from "bun:test";
import {
	applyCoverageReport,
	type CoverageLedger,
	type CoverageQueueConfig,
	coverageSummary,
	coverageVerificationManifest,
	freezeCoverageCandidates,
	markCoverageDiscoveryCompleted,
	nextCoverageAssignment,
	promoteCoverageSearchHits,
	reopenCoverageFromCritique,
	seedCoverageLedger,
} from "../agent-harness/coverage.js";
import {
	applySummaryRerankDecisions,
	applySummaryTriageRerank,
	buildSummaryRerankQueries,
	resolveSummaryTriageConfig,
	scoreCoverageSummaries,
	summaryRerankText,
} from "../agent-harness/coverage-rerank.js";
import { parseHarnessConfig } from "../agent-harness/types.js";
import { HarnessConfigSchema } from "../flow-parser/validate.js";
import { RerankError, type Reranker } from "../reranker.js";

const SOURCE = "vectorsearch/get_summaries";
const LONG = "Ausführliche Zusammenfassung mit genug Inhalt, um als belastbare Summary zu gelten — deutlich über achtzig Zeichen.";

const ref = (i: number) => `/Ordner/Dokument-${String(i).padStart(3, "0")}.pdf/0`;

function seed(n: number, summary: (i: number) => string = () => LONG): CoverageLedger {
	return seedCoverageLedger(
		[
			{
				tool_call_id: "seed",
				tool_name: SOURCE,
				result: {
					summaries: Array.from({ length: n }, (_, i) => ({
						reference: ref(i),
						title: `Dokument ${i}`,
						summary: summary(i),
					})),
					count: n,
					total: n,
				},
				execution_time_seconds: 0,
			},
		],
		SOURCE,
	);
}

/** Fake reranker: score per document index taken from `scoreOf(index, query)`. */
function fakeReranker(
	scoreOf: (index: number, query: string) => number,
	calls: Array<{ query: string; size: number }> = [],
): Reranker {
	return {
		rerank: async () => [],
		rerankOrThrow: async (query, documents) => {
			calls.push({ query, size: documents.length });
			return documents.map((text, index) => {
				const match = /Dokument (\d+)/.exec(text);
				return { index, score: scoreOf(Number(match?.[1] ?? index), query) };
			});
		},
	};
}

const stagedConfig = (over: Partial<CoverageQueueConfig> = {}): CoverageQueueConfig => ({
	enabled: true,
	mode: "staged",
	sourceTool: SOURCE,
	batchSize: 5,
	maxOriginalsPerBatch: 1,
	assignmentCharBudget: 100000,
	documentWindowChars: 18000,
	markers: { start: "<C>", end: "</C>" },
	searchDiscovery: {
		rounds: 1,
		maxAttemptsPerRound: 2,
		maxHitsPerPass: 5,
		maxCandidates: 200,
	},
	...over,
});

const hybrid = resolveSummaryTriageConfig({
	mode: "hybrid",
	rerankOrder: true,
	acceptTopK: 0.07,
	excludeBelowRank: 0.35,
	excludeMaxScore: 0.01,
	queries: ["user"],
});

describe("config", () => {
	test("defaults: absent → llm with default shares", () => {
		expect(resolveSummaryTriageConfig(undefined)).toEqual({
			mode: "llm",
			rerankOrder: true,
			acceptTopK: 0.07,
			excludeBelowRank: 0.35,
			excludeMaxScore: 0.01,
			queries: ["user"],
		});
		const parsed = parseHarnessConfig({
			allowlist: ["w"],
			coverageQueue: { enabled: true, sourceTool: SOURCE, summaryTriage: {} },
		});
		expect(parsed.coverageQueue?.summaryTriage?.mode).toBe("llm");
		expect(parsed.coverageQueue?.summaryTriage?.queries).toEqual(["user"]);
		const absent = parseHarnessConfig({
			allowlist: ["w"],
			coverageQueue: { enabled: true, sourceTool: SOURCE },
		});
		expect(absent.coverageQueue?.summaryTriage).toBeUndefined();
	});

	test("hybrid with explicit values is kept", () => {
		const parsed = parseHarnessConfig({
			allowlist: ["w"],
			coverageQueue: {
				enabled: true,
				sourceTool: SOURCE,
				summaryTriage: {
					mode: "hybrid",
					rerankOrder: false,
					acceptTopK: 0.1,
					excludeBelowRank: 0.5,
					excludeMaxScore: 0.02,
					queries: ["user", "{{node.x.classification.imageContext}}"],
				},
			},
		});
		expect(parsed.coverageQueue?.summaryTriage).toEqual({
			mode: "hybrid",
			rerankOrder: false,
			acceptTopK: 0.1,
			excludeBelowRank: 0.5,
			excludeMaxScore: 0.02,
			queries: ["user", "{{node.x.classification.imageContext}}"],
		});
	});

	test("unknown mode and unresolved {{vars}} placeholder → parser llm, zod rejects", () => {
		for (const mode of ["auto", "{{vars.coverageSummaryTriageMode}}"]) {
			const raw = {
				allowlist: ["w"],
				coverageQueue: { enabled: true, sourceTool: SOURCE, summaryTriage: { mode } },
			};
			expect(parseHarnessConfig(raw).coverageQueue?.summaryTriage?.mode).toBe("llm");
			expect(HarnessConfigSchema.safeParse(raw).success).toBe(false);
		}
	});

	test("acceptTopK ≥ excludeBelowRank → zod error, parser llm with defaults", () => {
		const raw = {
			allowlist: ["w"],
			coverageQueue: {
				enabled: true,
				sourceTool: SOURCE,
				summaryTriage: { mode: "hybrid", acceptTopK: 0.5, excludeBelowRank: 0.4 },
			},
		};
		const result = HarnessConfigSchema.safeParse(raw);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain("acceptTopK must be below");
		const parsed = parseHarnessConfig(raw).coverageQueue?.summaryTriage;
		expect(parsed?.mode).toBe("llm");
		expect(parsed?.acceptTopK).toBe(0.07);
		// Out-of-range share also degrades to llm.
		expect(
			parseHarnessConfig({
				allowlist: ["w"],
				coverageQueue: {
					enabled: true,
					sourceTool: SOURCE,
					summaryTriage: { mode: "hybrid", acceptTopK: 1.5 },
				},
			}).coverageQueue?.summaryTriage?.mode,
		).toBe("llm");
	});

	test("queries capped at 6 by the parser, zod rejects 7", () => {
		const queries = Array.from({ length: 7 }, (_, i) => `q${i}`);
		const raw = {
			allowlist: ["w"],
			coverageQueue: {
				enabled: true,
				sourceTool: SOURCE,
				summaryTriage: { mode: "llm", queries },
			},
		};
		expect(parseHarnessConfig(raw).coverageQueue?.summaryTriage?.queries).toHaveLength(6);
		expect(HarnessConfigSchema.safeParse(raw).success).toBe(false);
	});
});

describe("scoring/decisions", () => {
	test("score is the maximum over queries; ties keep ledger order", async () => {
		const reranker = fakeReranker((i, query) =>
			query === "a" ? (i === 2 ? 0.9 : 0.1) : i === 0 ? 0.95 : 0.1,
		);
		const texts = [0, 1, 2, 3].map((i) =>
			summaryRerankText({ ref: ref(i), title: `Dokument ${i}`, summary: LONG }),
		);
		const result = await scoreCoverageSummaries(texts, ["a", "b"], reranker);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.scores).toEqual([0.95, 0.1, 0.9, 0.1]);
		const ledger = seed(4);
		const decided = applySummaryRerankDecisions(ledger, result.scores, {
			...hybrid,
			mode: "llm",
		});
		expect(decided.ledger.documents.map((d) => d.rerankRank)).toEqual([1, 3, 2, 4]);
		// llm mode: scores only, no status change.
		expect(decided.ledger.documents.every((d) => d.status === "open")).toBe(true);
		expect(decided.accepted + decided.excluded).toBe(0);
	});

	test("summaryRerankText: title + last ref segment + summary; segment dropped when equal to title", () => {
		expect(summaryRerankText({ ref: "/a/Spec.pdf/4. Kapitel", title: "Spec", summary: "S" })).toBe(
			"Spec — 4. Kapitel\nS",
		);
		expect(summaryRerankText({ ref: "/a/Spec", title: "spec", summary: "S" })).toBe("spec\nS");
	});

	test("hybrid N=100: top 7 accepted, low tail with tiny score excluded, gray stays open, short summary never excluded", () => {
		// Document i gets score descending by index: doc 0 best.
		const scores = Array.from({ length: 100 }, (_, i) =>
			i < 50 ? 0.9 - i * 0.01 : i === 80 ? 0.02 : 0.0001,
		);
		const ledger = seed(100, (i) => (i === 90 ? "kurz" : LONG));
		const decided = applySummaryRerankDecisions(ledger, scores, hybrid);
		expect(decided.acceptCut).toBe(7);
		expect(decided.excludeCut).toBe(35);
		const doc = (i: number) => decided.ledger.documents[i];
		expect(doc(2)?.status).toBe("summary-reviewed");
		expect(doc(2)?.triageDecision).toBe("possibly_relevant");
		expect(doc(2)?.triageSource).toBe("rerank");
		expect(doc(2)?.reason).toBe("Rerank-Rang 3/100, Score 0.880 (Top-7, deterministische Aufnahme)");
		expect(doc(2)?.candidateReasons).toEqual(["Summary-Rerank: Rang 3/100"]);
		expect(doc(7)?.status).toBe("open");
		// Rank > 35 but score ≥ excludeMaxScore stays in the gray zone.
		expect(doc(40)?.status).toBe("open");
		expect(doc(80)?.status).toBe("open");
		// Rank > 35 with score < 0.01 is excluded with a reason.
		expect(doc(60)?.status).toBe("excluded");
		expect(doc(60)?.triageDecision).toBe("irrelevant");
		expect(doc(60)?.reason).toContain("unterhalb der Ausschlussgrenze");
		expect(doc(60)?.reason).toContain("per globaler Discovery wieder öffenbar");
		expect(doc(60)?.windows).toEqual([]);
		expect(doc(60)?.totalChars).toBeUndefined();
		// Short summary is never excluded by the reranker.
		expect(doc(90)?.status).toBe("open");
		expect(decided.accepted).toBe(7);
		expect(decided.accepted + decided.excluded + decided.gray).toBe(100);
	});

	test("rerank mode: all non-accepted excluded except short summaries", () => {
		const scores = Array.from({ length: 30 }, (_, i) => 1 - i / 30);
		const ledger = seed(30, (i) => (i === 20 ? "" : LONG));
		const decided = applySummaryRerankDecisions(ledger, scores, { ...hybrid, mode: "rerank" });
		expect(decided.acceptCut).toBe(3);
		expect(decided.accepted).toBe(3);
		expect(decided.excluded).toBe(26);
		expect(decided.ledger.documents[20]?.status).toBe("open");
		expect(decided.ledger.documents[10]?.reason).toContain("Modus rerank");
	});

	const userQuery = { userText: "Gibt es einen NIO-Arbeitsplatz?", resolveTemplate: () => "" };

	test.each([
		["reranker_not_configured", undefined],
		[
			"reranker_error",
			{
				rerank: async () => [],
				rerankOrThrow: async () => {
					throw new RerankError("http", "HTTP 422", { status: 422 });
				},
			} satisfies Reranker,
		],
		[
			"incomplete_scores",
			{
				rerank: async () => [],
				rerankOrThrow: async (_q: string, docs: string[]) =>
					docs.slice(1).map((_, index) => ({ index, score: 0.5 })),
			} satisfies Reranker,
		],
		[
			"timeout",
			{
				rerank: async () => [],
				rerankOrThrow: () => new Promise<never>(() => {}),
			} satisfies Reranker,
		],
	] as const)("fallback %s: no scores, no status change, warn diagnostic", async (reason, reranker) => {
		const ledger = seed(30);
		const outcome = await applySummaryTriageRerank({
			ledger,
			config: hybrid,
			reranker,
			...userQuery,
			deadlineMs: 10,
		});
		expect(outcome.diagnostic?.code).toBe("summary_triage_rerank_fallback");
		expect(outcome.diagnostic?.level).toBe("warn");
		expect(outcome.diagnostic?.details?.reason).toBe(reason);
		expect(outcome.ledger.documents).toEqual(ledger.documents);
		expect(outcome.ledger.summaryRerank?.status).toBe("fallback");
		expect(outcome.status).toContain("all summaries go to LLM triage");
		if (reason === "reranker_error") expect(outcome.diagnostic?.details?.status).toBe(422);
	});

	test("lenient-only reranker returning [] is a failure, not an empty ranking", async () => {
		const ledger = seed(30);
		const outcome = await applySummaryTriageRerank({
			ledger,
			config: hybrid,
			reranker: { rerank: async () => [] },
			...userQuery,
		});
		expect(outcome.diagnostic?.details?.reason).toBe("reranker_error");
		expect(outcome.ledger.documents).toEqual(ledger.documents);
	});

	test("no query and too few documents fall back without calling the reranker", async () => {
		const calls: Array<{ query: string; size: number }> = [];
		const reranker = fakeReranker(() => 0.5, calls);
		const noQuery = await applySummaryTriageRerank({
			ledger: seed(30),
			config: hybrid,
			reranker,
			userText: "   ",
			resolveTemplate: () => "",
		});
		expect(noQuery.diagnostic?.details?.reason).toBe("no_query");
		const tooFew = await applySummaryTriageRerank({
			ledger: seed(19),
			config: hybrid,
			reranker,
			...userQuery,
		});
		expect(tooFew.diagnostic?.details?.reason).toBe("too_few_documents");
		expect(tooFew.ledger.documents.every((d) => d.rerankScore === undefined)).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("unexpected exception inside the pass becomes reranker_error", async () => {
		const outcome = await applySummaryTriageRerank({
			ledger: seed(30),
			config: hybrid,
			reranker: fakeReranker(() => 0.5),
			userText: "frage",
			resolveTemplate: () => {
				throw new Error("boom");
			},
		});
		// Template errors only drop that query; the user query still scores.
		expect(outcome.diagnostic?.code).toBe("summary_triage_rerank_scored");
	});

	test("2500 documents → every reranker call gets ≤ 1000 texts", async () => {
		const calls: Array<{ query: string; size: number }> = [];
		const outcome = await applySummaryTriageRerank({
			ledger: seed(2500),
			config: { ...hybrid, mode: "llm" },
			reranker: fakeReranker((i) => i / 2500, calls),
			...userQuery,
		});
		expect(calls.map((c) => c.size)).toEqual([1000, 1000, 500]);
		expect(outcome.diagnostic?.code).toBe("summary_triage_rerank_scored");
		expect(outcome.diagnostic?.details?.reranker_calls).toBe(3);
	});

	test("empty imageContext template → only the user query", () => {
		const built = buildSummaryRerankQueries(
			["user", "{{node.fds-image-transcribe.classification.imageContext}}"],
			{ userText: "  Frage  mit Leerraum ", resolveTemplate: () => "" },
		);
		expect(built).toEqual({ queries: ["Frage mit Leerraum"], sources: ["user"] });
		const withImage = buildSummaryRerankQueries(["user", "tpl", "tpl2"], {
			userText: "Frage",
			resolveTemplate: (t) => (t === "tpl" ? "Bildkontext" : "frage"),
		});
		// Duplicate (case-insensitive) dropped.
		expect(withImage).toEqual({
			queries: ["Frage", "Bildkontext"],
			sources: ["user", "template:1"],
		});
	});

	test("llm mode without reranker: no diagnostic, ledger untouched", async () => {
		const ledger = seed(30);
		const outcome = await applySummaryTriageRerank({
			ledger,
			config: undefined,
			reranker: undefined,
			...userQuery,
		});
		expect(outcome).toEqual({ ledger });
	});

	test("llm mode with rerankOrder false: reranker is not called", async () => {
		const calls: Array<{ query: string; size: number }> = [];
		const ledger = seed(30);
		const outcome = await applySummaryTriageRerank({
			ledger,
			config: { ...hybrid, mode: "llm", rerankOrder: false },
			reranker: fakeReranker(() => 0.5, calls),
			...userQuery,
		});
		expect(outcome).toEqual({ ledger });
		expect(calls).toHaveLength(0);
	});

	test("hybrid success: scored diagnostic with counts and latency, summary suffix", async () => {
		const outcome = await applySummaryTriageRerank({
			ledger: seed(40),
			config: hybrid,
			reranker: fakeReranker((i) => (i < 20 ? 0.9 - i * 0.01 : 0.0001)),
			...userQuery,
		});
		expect(outcome.diagnostic).toMatchObject({
			level: "info",
			code: "summary_triage_rerank_scored",
			details: { mode: "hybrid", document_count: 40, accepted: 3, accept_cut: 3, exclude_cut: 14 },
		});
		expect(typeof outcome.diagnostic?.details?.latency_ms).toBe("number");
		expect(outcome.ledger.summaryRerank).toMatchObject({ status: "scored", accepted: 3, excluded: 20, gray: 17 });
		expect(coverageSummary(outcome.ledger)).toContain("summary rerank: 3 accepted, 20 excluded");
		expect(outcome.status).toContain("40 scored");
	});
});

describe("ordering/pfad-b", () => {
	const config = stagedConfig();

	test("Stage-1 batches follow rerank rank; without ranks ledger order", () => {
		const plain = seed(10);
		expect(nextCoverageAssignment(plain, config)?.documents.map((d) => d.ref)).toEqual(
			[0, 1, 2, 3, 4].map(ref),
		);
		const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
		const ranked = applySummaryRerankDecisions(plain, scores, { ...hybrid, mode: "llm" }).ledger;
		expect(nextCoverageAssignment(ranked, config)?.documents.map((d) => d.ref)).toEqual(
			[9, 8, 7, 6, 5].map(ref),
		);
	});

	const reviewed = (ledger: CoverageLedger): CoverageLedger =>
		markCoverageDiscoveryCompleted(
			{
				...ledger,
				documents: ledger.documents.map((d) => ({ ...d, status: "summary-reviewed" as const })),
			},
			[{ query: "q", hybrid: true, hyde: false, groupByDocument: true, resultRefs: [] }],
		);

	test("freeze: promotedBySearch first, then score desc; lowest go to overflow", () => {
		let ledger = applySummaryRerankDecisions(seed(4), [0.9, 0.1, 0.5, 0.3], {
			...hybrid,
			mode: "llm",
		}).ledger;
		ledger = reviewed(ledger);
		ledger = {
			...ledger,
			documents: ledger.documents.map((d) =>
				d.ref === ref(1) ? { ...d, promotedBySearch: true } : d,
			),
		};
		const frozen = freezeCoverageCandidates(ledger, 2);
		expect(frozen.frozenRefs).toEqual([ref(1), ref(0)]);
		expect(frozen.overflowRefs).toEqual([ref(2), ref(3)]);
	});

	test("freeze without scores keeps ledger order (regression)", () => {
		const ledger = reviewed(seed(4));
		const frozen = freezeCoverageCandidates(
			{
				...ledger,
				documents: ledger.documents.map((d) =>
					d.ref === ref(3) ? { ...d, promotedBySearch: true } : d,
				),
			},
			2,
		);
		expect(frozen.frozenRefs).toEqual([ref(0), ref(1)]);
		expect(frozen.overflowRefs).toEqual([ref(2), ref(3)]);
	});

	const excludedByRerank = (): CoverageLedger => {
		const scores = Array.from({ length: 30 }, (_, i) => (i < 10 ? 0.9 - i * 0.01 : 0.0001));
		return applySummaryRerankDecisions(seed(30), scores, hybrid).ledger;
	};

	test.each([
		["initial discovery", 0],
		["expansion generation", 1],
	] as const)("path B (%s): discovery hit reopens a rerank exclusion for original review", (_label, generation) => {
		const base = excludedByRerank();
		const target = base.documents[25];
		expect(target?.status).toBe("excluded");
		expect(target?.triageSource).toBe("rerank");
		const ledger: CoverageLedger = {
			...base,
			discoveryGeneration: generation,
			phase: generation === 0 ? "initial-discovery" : "expansion-discovery",
		};
		const promoted = promoteCoverageSearchHits(
			ledger,
			[
				{
					query: "NIO-Arbeitsplatz",
					hybrid: true,
					hyde: false,
					groupByDocument: true,
					resultRefs: [`${ref(25)}_chunk_4`],
				},
			],
			5,
		);
		const reopened = promoted.ledger.documents[25];
		expect(promoted.promotedRefs).toEqual([ref(25)]);
		expect(reopened?.status).toBe("summary-reviewed");
		expect(reopened?.promotedBySearch).toBe(true);
		expect(reopened?.reason?.startsWith(
			"Reopened for original review by global discovery (previously: Rerank-Rang",
		)).toBe(true);
	});

	test("verifier critique reopens a rerank exclusion into LLM summary triage", () => {
		const base = excludedByRerank();
		// Settle the open gray zone and accepted docs so only the reopened ref is pending.
		const settled: CoverageLedger = {
			...base,
			documents: base.documents.map((d, i) =>
				i === 25 ? d : { ...d, status: "reviewed" as const },
			),
		};
		const reopened = reopenCoverageFromCritique(settled, `Bitte ${ref(25)} prüfen`, config);
		expect(reopened.reopenedRefs).toEqual([ref(25)]);
		expect(reopened.ledger.documents[25]?.status).toBe("open");
		expect(reopened.ledger.documents[25]?.triageSource).toBeUndefined();
		const next = nextCoverageAssignment(reopened.ledger, config);
		expect(next?.mode).toBe("summary");
		expect(next?.documents.map((d) => d.ref)).toEqual([ref(25)]);
	});

	test("an LLM summary report clears triageSource", () => {
		const ledger = excludedByRerank();
		const assignment = {
			id: "coverage-1",
			mode: "summary" as const,
			documents: [{ ref: ref(0), title: "Dokument 0", summary: LONG, windows: [] }],
		};
		const applied = applyCoverageReport(ledger, assignment, {
			assignmentId: "coverage-1",
			documents: [{ ref: ref(0), decision: "relevant", reason: "LLM: passt" }],
		});
		expect(ledger.documents[0]?.triageSource).toBe("rerank");
		expect(applied.ledger.documents[0]?.triageSource).toBeUndefined();
		expect(applied.ledger.documents[0]?.triageDecision).toBe("relevant");
		expect(applied.ledger.documents[0]?.rerankRank).toBe(1);
	});

	test("verifier manifest exposes triageSource (detailed + compact) and rerankRank (detailed)", () => {
		const ledger = excludedByRerank();
		const detailed = coverageVerificationManifest(ledger, config);
		expect(detailed).toContain('"triageSource":"rerank"');
		expect(detailed).toContain('"rerankRank":1');
		const compactBudget = detailed.length - 1;
		const compact = coverageVerificationManifest(ledger, config, compactBudget);
		expect(compact).toContain('"triageSource":"rerank"');
		expect(compact).not.toContain('"rerankRank"');
	});
});
describe("triageSource provenance after path B and freeze overflow", () => {
	const config = stagedConfig();
	const excludedByRerank = (): CoverageLedger => {
		const scores = Array.from({ length: 30 }, (_, i) => (i < 10 ? 0.9 - i * 0.01 : 0.0001));
		return applySummaryRerankDecisions(seed(30), scores, hybrid).ledger;
	};
	const manifestDocument = (ledger: CoverageLedger, docRef: string): Record<string, unknown> | undefined => {
		const manifest = coverageVerificationManifest(ledger, config);
		const payload = JSON.parse(manifest.split("\n").at(-1) ?? "{}") as {
			documents: Array<Record<string, unknown>>;
		};
		return payload.documents.find((document) => document.ref === docRef);
	};
	const hit = (docRef: string) => ({
		query: "NIO-Arbeitsplatz",
		hybrid: true as const,
		hyde: false,
		groupByDocument: true,
		resultRefs: [docRef],
	});

	test("a path-B reopened rerank exclusion drops triageSource (ledger + manifest)", () => {
		const base = excludedByRerank();
		expect(base.documents[25]?.triageSource).toBe("rerank");
		const promoted = promoteCoverageSearchHits(base, [hit(ref(25))], 5);
		const reopened = promoted.ledger.documents[25];
		expect(reopened?.status).toBe("summary-reviewed");
		expect(reopened?.promotedBySearch).toBe(true);
		expect(reopened?.triageSource).toBeUndefined();
		// Measurements stay.
		expect(reopened?.rerankRank).toBeDefined();
		const entry = manifestDocument(promoted.ledger, ref(25));
		expect(entry).toBeDefined();
		expect(entry?.triageSource).toBeUndefined();
	});

	test("a rerank admission that is also promoted keeps triageSource rerank", () => {
		const base = excludedByRerank();
		expect(base.documents[0]?.status).toBe("summary-reviewed");
		const promoted = promoteCoverageSearchHits(base, [hit(ref(0))], 5);
		expect(promoted.ledger.documents[0]?.promotedBySearch).toBe(true);
		expect(promoted.ledger.documents[0]?.triageSource).toBe("rerank");
		expect(manifestDocument(promoted.ledger, ref(0))?.triageSource).toBe("rerank");
	});

	test("freeze overflow of a rerank admission drops triageSource (ledger + manifest)", () => {
		const base = excludedByRerank();
		const admitted = base.documents.filter((d) => d.triageSource === "rerank" && d.status === "summary-reviewed");
		expect(admitted.length).toBeGreaterThan(1);
		const frozen = freezeCoverageCandidates(base, 1);
		expect(frozen.frozenRefs).toEqual([ref(0)]);
		expect(frozen.overflowRefs.length).toBeGreaterThan(0);
		for (const overflowRef of frozen.overflowRefs) {
			const document = frozen.ledger.documents.find((d) => d.ref === overflowRef);
			expect(document?.status).toBe("excluded");
			expect(document?.triageSource).toBeUndefined();
			expect(manifestDocument(frozen.ledger, overflowRef)?.triageSource).toBeUndefined();
		}
		// The frozen candidate keeps its rerank admission.
		expect(frozen.ledger.documents[0]?.triageSource).toBe("rerank");
	});
});
describe("rerank pass abort, deadline and backend pinning", () => {
	const docs = (n: number) => Array.from({ length: n }, (_, i) => `Dokument ${i}\n${LONG}`);
	/** Reranker that honours the call signal and never answers on its own. */
	function hangingReranker(signals: AbortSignal[], answerFirst = 0): Reranker {
		return {
			rerank: async () => [],
			rerankOrThrow: (_query, documents, _topN, options) => {
				const signal = options?.signal as AbortSignal;
				signals.push(signal);
				if (signals.length <= answerFirst) {
					return Promise.resolve(documents.map((_, index) => ({ index, score: 0.5 })));
				}
				return new Promise((_, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new RerankError("aborted", "aborted by caller")),
						{ once: true },
					);
				});
			},
		};
	}

	test("pass deadline aborts the in-flight reranker request → timeout", async () => {
		const signals: AbortSignal[] = [];
		const result = await scoreCoverageSummaries(docs(5), ["q"], hangingReranker(signals), {
			deadlineMs: 50,
		});
		expect(result).toMatchObject({ ok: false, reason: "timeout" });
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
	});

	test("execution abort after the first chunk → fallback aborted, no further calls", async () => {
		const signals: AbortSignal[] = [];
		const execution = new AbortController();
		const pending = scoreCoverageSummaries(docs(25), ["q"], hangingReranker(signals, 1), {
			chunkSize: 10,
			signal: execution.signal,
		});
		await Bun.sleep(10);
		expect(signals).toHaveLength(2);
		execution.abort();
		const result = await pending;
		expect(result).toMatchObject({ ok: false, reason: "aborted", calls: 2 });
		expect(signals[1]?.aborted).toBe(true);
		await Bun.sleep(10);
		expect(signals).toHaveLength(2);
	});

	test("applySummaryTriageRerank reports reason aborted for an aborted execution", async () => {
		const execution = new AbortController();
		execution.abort();
		const outcome = await applySummaryTriageRerank({
			ledger: seed(25),
			config: hybrid,
			reranker: hangingReranker([]),
			userText: "Frage",
			resolveTemplate: () => "",
			signal: execution.signal,
		});
		expect(outcome.diagnostic?.details?.reason).toBe("aborted");
		expect(outcome.ledger.documents.every((d) => d.rerankScore === undefined)).toBe(true);
	});

	test("pinned session failing in chunk 2 → reranker_error, no mixed scores in the ledger", async () => {
		let pinnedCalls = 0;
		let unpinnedCalls = 0;
		const chain: Reranker = {
			rerank: async () => [],
			rerankOrThrow: async (_q, documents) => {
				unpinnedCalls += 1;
				return documents.map((_, index) => ({ index, score: 0.9 }));
			},
			pinBackend: () => ({
				rerank: async () => [],
				rerankOrThrow: async (_q, documents) => {
					pinnedCalls += 1;
					if (pinnedCalls === 2) throw new RerankError("http", "pinned backend down", { status: 503 });
					return documents.map((_, index) => ({ index, score: 0.5 }));
				},
			}),
		};
		const outcome = await applySummaryTriageRerank({
			ledger: seed(25),
			config: hybrid,
			reranker: chain,
			userText: "Frage",
			resolveTemplate: () => "",
			chunkSize: 10,
		});
		expect(outcome.diagnostic?.details?.reason).toBe("reranker_error");
		expect(pinnedCalls).toBe(2);
		expect(unpinnedCalls).toBe(0);
		expect(outcome.ledger.documents.every((d) => d.rerankScore === undefined)).toBe(true);
	});
});

describe("summaryTriage config diagnostics", () => {
	const parse = (summaryTriage: Record<string, unknown>) =>
		parseHarnessConfig({
			allowlist: ["w"],
			coverageQueue: { enabled: true, sourceTool: SOURCE, summaryTriage },
		}).coverageQueue?.summaryTriage;

	test("invalid input → mode llm with configError naming the fields", () => {
		const parsed = parse({ mode: "bogus" });
		expect(parsed?.mode).toBe("llm");
		expect(parsed?.configError).toContain("invalid mode 'bogus'");
		const order = parse({ mode: "hybrid", acceptTopK: 0.5, excludeBelowRank: 0.4 });
		expect(order?.configError).toBe("acceptTopK >= excludeBelowRank");
	});

	test("valid input carries no configError", () => {
		expect(parse({ mode: "hybrid", excludeBelowRank: 0.5 })?.configError).toBeUndefined();
		expect(parse({})?.configError).toBeUndefined();
	});

	test("applySummaryTriageRerank emits summary_triage_config_invalid even without reranker", async () => {
		const outcome = await applySummaryTriageRerank({
			ledger: seed(25),
			config: parse({ mode: "bogus" }),
			reranker: undefined,
			userText: "Frage",
			resolveTemplate: () => "",
		});
		expect(outcome.configDiagnostic).toMatchObject({
			level: "warn",
			code: "summary_triage_config_invalid",
		});
		expect(outcome.diagnostic).toBeUndefined();
	});
});
