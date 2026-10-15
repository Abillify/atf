// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Answer-level groundedness mini set.
 *
 * Retrieval metrics say whether the right passage was found; they say nothing
 * about whether an answer stays within it. This module scores answers against
 * their retrieval context with the runtime's deterministic lexical Groundedness
 * checker (`checkGroundedness`), so it needs no model call:
 *
 *   - reference mode (default): each item ships a curated grounded and a curated
 *     unsupported candidate. Scoring them checks that the checker separates the
 *     two (a calibration of the gate itself, not of any LLM).
 *   - answers mode (`--answers <file>`): scores answers a live model produced
 *     for the same items (`{ "<item id>": "<answer>" }`). Producing those answers
 *     requires a live model; this repository ships none, so no such numbers are
 *     recorded here ("nicht gemessen").
 *
 * Usage:
 *   bun run scripts/eval/groundedness.ts [--fixture <path>] [--answers <path>]
 */

import { resolve } from "node:path";
import { checkGroundedness } from "../../apps/runtime/src/graph/groundedness.ts";

export type CandidateLabel = "grounded" | "ungrounded";

export interface GroundednessCandidate {
	id: string;
	label: CandidateLabel;
	answer: string;
}

export interface GroundednessItem {
	id: string;
	language: string;
	question: string;
	/** Retrieved passages the answer must stay within. */
	context: string[];
	candidates: GroundednessCandidate[];
}

export interface GroundednessSet {
	version: string;
	description?: string;
	items: GroundednessItem[];
}

export interface CandidateScore {
	id: string;
	label: CandidateLabel;
	score: number;
	passed: boolean;
	/** True when the checker's verdict agrees with the curated label. */
	correct: boolean;
}

export interface ReferenceReport {
	mode: "reference";
	candidates: number;
	/** Share of candidates where `passed` matches the curated label. */
	accuracy: number;
	/** Mean faithfulness score of the grounded candidates. */
	meanGroundedScore: number;
	/** Mean faithfulness score of the unsupported candidates. */
	meanUngroundedScore: number;
	/** Share of unsupported candidates the checker flags (did not pass). */
	unsupportedDetectionRate: number;
	/** Share of grounded candidates wrongly flagged. */
	falseFlagRate: number;
	scores: CandidateScore[];
}

export interface AnswersReport {
	mode: "answers";
	answered: number;
	missing: string[];
	/** Mean faithfulness score over the supplied answers. */
	meanScore: number;
	/** Share of supplied answers that pass the groundedness threshold. */
	passRate: number;
	scores: { id: string; score: number; passed: boolean }[];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
const mean = (values: number[]): number =>
	values.length === 0
		? 0
		: round(values.reduce((sum, v) => sum + v, 0) / values.length);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

/** Parse and validate a groundedness set from an unknown JSON value. */
export function parseGroundednessSet(value: unknown): GroundednessSet {
	if (!isRecord(value)) throw new Error("groundedness set must be an object");
	const version = requireString(value.version, "version");
	if (!Array.isArray(value.items) || value.items.length === 0) {
		throw new Error("items must be a non-empty array");
	}
	const seen = new Set<string>();
	const items = value.items.map((raw, index): GroundednessItem => {
		const path = `items[${index}]`;
		if (!isRecord(raw)) throw new Error(`${path} must be an object`);
		const id = requireString(raw.id, `${path}.id`);
		if (seen.has(id)) throw new Error(`duplicate item id "${id}"`);
		seen.add(id);
		if (!Array.isArray(raw.context) || raw.context.length === 0) {
			throw new Error(`${path}.context must be a non-empty array`);
		}
		const context = raw.context.map((c, i) =>
			requireString(c, `${path}.context[${i}]`),
		);
		if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) {
			throw new Error(`${path}.candidates must be a non-empty array`);
		}
		const candidates = raw.candidates.map(
			(c, i): GroundednessCandidate => {
				const cp = `${path}.candidates[${i}]`;
				if (!isRecord(c)) throw new Error(`${cp} must be an object`);
				const label = c.label;
				if (label !== "grounded" && label !== "ungrounded") {
					throw new Error(`${cp}.label must be "grounded" or "ungrounded"`);
				}
				return {
					id: requireString(c.id, `${cp}.id`),
					label,
					answer: requireString(c.answer, `${cp}.answer`),
				};
			},
		);
		return {
			id,
			language: requireString(raw.language, `${path}.language`),
			question: requireString(raw.question, `${path}.question`),
			context,
			candidates,
		};
	});
	const set: GroundednessSet = { version, items };
	if (value.description !== undefined) {
		set.description = requireString(value.description, "description");
	}
	return set;
}

/** Score the curated candidates with the runtime checker. Deterministic. */
export function scoreReference(set: GroundednessSet): ReferenceReport {
	const scores: CandidateScore[] = [];
	for (const item of set.items) {
		for (const candidate of item.candidates) {
			const result = checkGroundedness(candidate.answer, item.context);
			scores.push({
				id: candidate.id,
				label: candidate.label,
				score: result.score,
				passed: result.passed,
				correct: result.passed === (candidate.label === "grounded"),
			});
		}
	}
	const grounded = scores.filter((s) => s.label === "grounded");
	const ungrounded = scores.filter((s) => s.label === "ungrounded");
	return {
		mode: "reference",
		candidates: scores.length,
		accuracy: scores.length
			? round(scores.filter((s) => s.correct).length / scores.length)
			: 0,
		meanGroundedScore: mean(grounded.map((s) => s.score)),
		meanUngroundedScore: mean(ungrounded.map((s) => s.score)),
		unsupportedDetectionRate: ungrounded.length
			? round(ungrounded.filter((s) => !s.passed).length / ungrounded.length)
			: 0,
		falseFlagRate: grounded.length
			? round(grounded.filter((s) => !s.passed).length / grounded.length)
			: 0,
		scores,
	};
}

/** Score answers a live model produced, keyed by item id. Deterministic. */
export function scoreAnswers(
	set: GroundednessSet,
	answers: Record<string, string>,
): AnswersReport {
	const scores: AnswersReport["scores"] = [];
	const missing: string[] = [];
	for (const item of set.items) {
		const answer = answers[item.id];
		if (typeof answer !== "string" || answer.trim() === "") {
			missing.push(item.id);
			continue;
		}
		const result = checkGroundedness(answer, item.context);
		scores.push({ id: item.id, score: result.score, passed: result.passed });
	}
	return {
		mode: "answers",
		answered: scores.length,
		missing,
		meanScore: mean(scores.map((s) => s.score)),
		passRate: scores.length
			? round(scores.filter((s) => s.passed).length / scores.length)
			: 0,
		scores,
	};
}

export function renderReport(
	set: GroundednessSet,
	report: ReferenceReport | AnswersReport,
): string {
	const lines = [
		`# Answer-level groundedness — fixture ${set.version}`,
		"",
		"Scorer: runtime lexical groundedness checker (deterministic, no model call).",
		"",
	];
	if (report.mode === "reference") {
		lines.push(
			"Mode: reference candidates. This calibrates the checker; it is not a measurement of any LLM.",
			"",
			"| Metric | Value |",
			"| --- | --- |",
			`| candidates | ${report.candidates} |`,
			`| accuracy vs curated label | ${report.accuracy} |`,
			`| mean score, grounded candidates | ${report.meanGroundedScore} |`,
			`| mean score, unsupported candidates | ${report.meanUngroundedScore} |`,
			`| unsupported-detection rate | ${report.unsupportedDetectionRate} |`,
			`| false-flag rate | ${report.falseFlagRate} |`,
		);
	} else {
		lines.push(
			"Mode: answers from a live model (requires live model to produce).",
			"",
			"| Metric | Value |",
			"| --- | --- |",
			`| answers scored | ${report.answered} / ${set.items.length} |`,
			`| mean faithfulness score | ${report.meanScore} |`,
			`| pass rate | ${report.passRate} |`,
		);
		if (report.missing.length > 0) {
			lines.push("", `Missing answers: ${report.missing.join(", ")}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	const get = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const fixture =
		get("--fixture") ??
		resolve(import.meta.dir, "groundedness", "answer-set.v1.json");
	const set = parseGroundednessSet(await Bun.file(fixture).json());
	const answersPath = get("--answers");
	const report =
		answersPath === undefined
			? scoreReference(set)
			: scoreAnswers(
					set,
					(await Bun.file(answersPath).json()) as Record<string, string>,
				);
	console.log(renderReport(set, report));
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
