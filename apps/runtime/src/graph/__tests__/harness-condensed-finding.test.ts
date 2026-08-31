// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit test for `condensedFindingText` (agent-harness loop.ts).
 *
 * This is the `carryForward: "condensed"` chokepoint: only the text it returns
 * survives into the shared context (and, via the researcher's citations, into
 * the final answer). The previous `lastAiAnswerText` kept ONLY the last AI
 * message, so findings — and the source `[n]` they carry — split across several
 * assistant turns were silently dropped. `condensedFindingText` keeps them all.
 */

import { describe, expect, test } from "bun:test";
import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import {
	applyCoverageReport,
	coverageCompletionStatus,
	coverageEvidenceFromToolResult,
	coverageSearchEvidenceFromToolResult,
	coverageSummary,
	coverageVerificationManifest,
	hasRequiredHybridSearchEvidence,
	isCoverageTerminal,
	markCoverageAssignmentIssued,
	markCoverageDiscoveryCompleted,
	mergeCoverageEvidence,
	nextCoverageAssignment,
	novelCoverageSearchEvidence,
	parseCoverageReport,
	promoteCoverageSearchHits,
	renderCoverageAssignment,
	reopenCoverageFromCritique,
	seedCoverageLedger,
} from "../agent-harness/coverage.js";
import {
	budgetHarnessMessages,
	capCondensedFinding,
	collapseDuplicateLines,
	condensedFindingText,
	coverageToolKind,
	finalAiAnswerText,
} from "../agent-harness/loop.js";

describe("condensedFindingText", () => {
	test("concatenates EVERY non-empty AI answer, not just the last", () => {
		const msgs = [
			new SystemMessage("system prompt"),
			new HumanMessage("recherchiere Ordner X"),
			// Interim finding BEFORE a tool call — must not be lost.
			new AIMessage("Befund 1: Kuendigung am 03.03.2024 [7]."),
			// Tool-call-only assistant turn (empty text) — skipped.
			new AIMessage({ content: "", tool_calls: [] }),
			new ToolMessage({ content: "raw doc dump", tool_call_id: "t1" }),
			// Final finding after the tool call.
			new AIMessage("Befund 2: Frist laeuft am 17.03.2024 ab [7][12]."),
		];

		const out = condensedFindingText(msgs);
		// BOTH findings survive (the old lastAiAnswerText would drop Befund 1).
		expect(out).toContain("Befund 1: Kuendigung am 03.03.2024 [7].");
		expect(out).toContain("Befund 2: Frist laeuft am 17.03.2024 ab [7][12].");
		// Preserved in order, joined by a blank line.
		expect(out.indexOf("Befund 1")).toBeLessThan(out.indexOf("Befund 2"));
		// The source [n] the answer needs are carried through verbatim.
		expect(out).toContain("[7]");
		expect(out).toContain("[12]");
	});

	test("handles array (multi-part) content and ignores non-AI messages", () => {
		const msgs = [
			new HumanMessage("frage"),
			new AIMessage({
				content: [
					{ type: "text", text: "Teil A [1]." },
					{ type: "text", text: " Teil B [2]." },
				],
			}),
		];
		const out = condensedFindingText(msgs);
		expect(out).toBe("Teil A [1]. Teil B [2].");
	});

	test("returns empty string when the worker produced no text", () => {
		const msgs = [
			new HumanMessage("frage"),
			new AIMessage({ content: "", tool_calls: [] }),
			new ToolMessage({ content: "result", tool_call_id: "t1" }),
		];
		expect(condensedFindingText(msgs)).toBe("");
	});

	test("returns the final non-empty AI turn for strict coverage parsing", () => {
		const interimReport = '<COVERAGE>{"assignmentId":"old"}</COVERAGE>';
		const finalReport = '<COVERAGE>{"assignmentId":"final"}</COVERAGE>';
		const msgs = [
			new AIMessage(`Zwischenbefund.\n${interimReport}`),
			new ToolMessage({ content: "tool result", tool_call_id: "t1" }),
			new AIMessage(finalReport),
		];
		expect(finalAiAnswerText(msgs)).toBe(finalReport);
		expect(condensedFindingText(msgs)).toContain(interimReport);
	});

	test("drops a byte-identical assistant turn (reasoning-copy + answer-copy)", () => {
		// Trace fbf8500d: a thinking model restated its ENTIRE findings block in
		// both channels, so the same substantial block reached the synthesizer
		// twice — the repetition-loop trigger. The whole-turn dedup collapses it.
		const block =
			"ABGEDECKT: Zentrale Beispieldokumente [96][10][90]\n" +
			"- Betroffene Testperson: Alice Example, geb. 01.01.1990 [96].";
		const msgs = [
			new HumanMessage("was ist passiert?"),
			new AIMessage(block),
			new AIMessage(block),
		];
		const out = condensedFindingText(msgs);
		// The substantial bullet appears exactly once.
		const occurrences =
			out.split(
				"- Betroffene Testperson: Alice Example, geb. 01.01.1990 [96].",
			).length - 1;
		expect(occurrences).toBe(1);
	});

	test("collapses repeated substantial lines across differently-framed turns", () => {
		// Same bullets, different intro lines (reasoning intro vs. answer intro) —
		// the whole-turn dedup misses it, collapseDuplicateLines catches the lines.
		const bullet =
			"- Der Vorfall betraf synthetische Datensätze des Example Service Center [10].";
		const msgs = [
			new HumanMessage("frage"),
			new AIMessage(`Ich habe die Dokumente gelesen.\n${bullet}`),
			new AIMessage(`Zusammenfassung der Befunde:\n${bullet}`),
		];
		const out = condensedFindingText(msgs);
		expect(out.split(bullet).length - 1).toBe(1);
		// Both distinct (short) intro lines survive.
		expect(out).toContain("Ich habe die Dokumente gelesen.");
		expect(out).toContain("Zusammenfassung der Befunde:");
	});
});

describe("collapseDuplicateLines", () => {
	test("keeps the first occurrence of a repeated substantial line, drops the rest", () => {
		const line =
			"- Es wurde ein Strafantrag wegen unbefugter Weitergabe gestellt [96].";
		const out = collapseDuplicateLines([line, line, line].join("\n"));
		expect(out).toBe(line);
	});

	test("does not dedupe short/structural lines", () => {
		// Short bullets/headers under the length threshold recur legitimately.
		const text = "- a\n- b\n- a\n- b";
		expect(collapseDuplicateLines(text)).toBe(text);
	});

	test("preserves order and unique substantial lines", () => {
		const a =
			"- Betroffene Testperson: Alice Example, geb. 01.01.1990 [96].";
		const b = "- Verarbeitungskontext: Example Service Center ab 03.01.2023 [97].";
		const out = collapseDuplicateLines([a, b, a].join("\n"));
		expect(out).toBe([a, b].join("\n"));
	});
});

describe("capCondensedFinding", () => {
	test("returns text within the limit unchanged", () => {
		const text = "kurzer Befund [7].";
		expect(capCondensedFinding(text, 4000)).toBe(text);
	});

	test("truncates over-long findings and appends a visible marker", () => {
		const text = "x".repeat(5000);
		const out = capCondensedFinding(text, 4000);
		expect(out.length).toBe(4000 + "\n[…gekuerzt]".length);
		expect(out.startsWith("x".repeat(4000))).toBe(true);
		expect(out.endsWith("[…gekuerzt]")).toBe(true);
	});

	test("bounds a degenerate repeated worker output (context-explosion guard)", () => {
		// Simulates the trace: a worker that emitted the same block thousands of
		// times. Without the cap this whole blob would be carried forward per
		// iteration and overflow the next node's context window.
		const blob = "ABGEDECKT: LfDI-Beschluss [85][88]. ".repeat(2000);
		const out = capCondensedFinding(blob, 4000);
		expect(out.length).toBeLessThanOrEqual(4000 + "\n[…gekuerzt]".length);
	});
});

describe("budgetHarnessMessages", () => {
	test("preserves every finding role while enforcing one aggregate budget", () => {
		const messages = [
			new HumanMessage("U".repeat(1000)),
			new AIMessage("A".repeat(1000)),
			new AIMessage("B".repeat(1000)),
		];
		const bounded = budgetHarnessMessages(messages, 600);
		const texts = bounded.map((message) => String(message.content));

		expect(bounded).toHaveLength(3);
		expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(
			600,
		);
		expect(bounded.map((message) => message._getType())).toEqual([
			"human",
			"ai",
			"ai",
		]);
		expect(texts[0]).toStartWith("U");
		expect(texts[1]).toStartWith("A");
		expect(texts[2]).toStartWith("B");
		expect(texts.every((text) => text.endsWith("[…context budgeted]"))).toBe(
			true,
		);
	});

	test("never exceeds a remainder smaller than the truncation marker", () => {
		const bounded = budgetHarnessMessages([new AIMessage("abcdef")], 1);
		expect(bounded).toHaveLength(1);
		expect(String(bounded[0]?.content)).toBe("a");
	});
});

describe("search-driven discovery (second retrieval path)", () => {
	const config = {
		enabled: true,
		sourceTool: "vectorsearch/get_summaries",
		batchSize: 2,
		maxOriginalsPerBatch: 1,
		assignmentCharBudget: 1000,
		documentWindowChars: 1000,
		hybridSearch: {
			minDistinctQueries: 2,
			requireHydeVariants: true,
			requireGroupedResults: true,
		},
		searchDiscovery: {
			rounds: 2,
			maxAttemptsPerRound: 2,
			maxHitsPerPass: 2,
		},
		markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
	} as const;

	const seed = () =>
		seedCoverageLedger(
			[
				{
					tool_call_id: "seed",
					tool_name: config.sourceTool,
					result: {
						summaries: [
							{ reference: "/A", title: "A", summary: "Summary A" },
							{ reference: "/B", title: "B", summary: "Summary B" },
						],
						count: 2,
						total: 2,
					},
					execution_time_seconds: 0,
				},
			],
			config.sourceTool,
		);

	const pass = (query: string, refs: string[], hyde = false) => ({
		query,
		hybrid: true as const,
		hyde,
		groupByDocument: true,
		resultRefs: refs,
	});
	const firstRound = () => [
		pass("Aktenzeichen 123 und Frist 03.03.2024", ["/A"]),
		pass("juristischer Fristbeginn und Zugang", ["/B"], true),
	];

	const completeFirstDiscovery = (ledger = seed()) => {
		const assignment = nextCoverageAssignment(ledger, config);
		if (assignment === undefined || assignment.mode !== "discovery") {
			throw new Error("missing discovery assignment");
		}
		return markCoverageDiscoveryCompleted(
			markCoverageAssignmentIssued(ledger, assignment),
			firstRound(),
		);
	};

	test("issues a discovery assignment BEFORE any summary triage", () => {
		const ledger = seed();
		const first = nextCoverageAssignment(ledger, config);
		if (first === undefined) throw new Error("missing discovery assignment");
		expect(first.mode).toBe("discovery");
		expect(first.documents).toEqual([]);
		// Only a successfully completed round allows normal triage to proceed.
		const afterFirst = markCoverageDiscoveryCompleted(
			markCoverageAssignmentIssued(ledger, first),
			firstRound(),
		);
		expect(nextCoverageAssignment(afterFirst, config)?.mode).toBe("summary");
	});

	test("counts only successful discovery and keeps assignment ids monotone", () => {
		let ledger = seed();
		const discovery = nextCoverageAssignment(ledger, config);
		if (discovery === undefined) throw new Error("missing discovery");
		expect(discovery.id).toBe("coverage-1");
		ledger = markCoverageAssignmentIssued(ledger, discovery);
		expect(ledger.discoveryAttempts).toBe(1);
		expect(ledger.discoveryRounds).toBe(0);
		ledger = markCoverageDiscoveryCompleted(ledger, firstRound());
		const summary = nextCoverageAssignment(ledger, config);
		if (summary === undefined) throw new Error("missing summary");
		expect(summary.id).toBe("coverage-2");
		ledger = markCoverageAssignmentIssued(ledger, summary);
		expect(ledger.assignmentsIssued).toBe(2);
	});

	test("requires globally new query perspectives in every discovery round", () => {
		const afterFirst = completeFirstDiscovery();
		expect(afterFirst.discoveryRounds).toBe(1);
		expect(afterFirst.discoverySearches).toEqual(firstRound());

		const replayed = firstRound().map((item) => ({
			...item,
			query: `  ${item.query.toLocaleUpperCase()}  `,
		}));
		const noNovelEvidence = novelCoverageSearchEvidence(afterFirst, replayed);
		expect(noNovelEvidence).toEqual([]);
		expect(
			hasRequiredHybridSearchEvidence(noNovelEvidence, config.hybridSearch),
		).toBe(false);
		expect(
			markCoverageDiscoveryCompleted(afterFirst, noNovelEvidence)
				.discoveryRounds,
		).toBe(1);

		const secondRound = [
			pass("Vertragswortlaut Sonderkündigung Klausel 8", ["/A"]),
			pass(
				"Wirksamkeit außerordentliche Beendigung Voraussetzungen",
				["/B"],
				true,
			),
		];
		const novel = novelCoverageSearchEvidence(afterFirst, secondRound);
		expect(hasRequiredHybridSearchEvidence(novel, config.hybridSearch)).toBe(
			true,
		);
		const completed = markCoverageDiscoveryCompleted(afterFirst, novel);
		expect(completed.discoveryRounds).toBe(2);
		expect(completed.discoverySearches).toHaveLength(4);
	});

	test("exposes global discovery provenance to assignments and verification", () => {
		const ledger = completeFirstDiscovery();
		const assignment = {
			id: "coverage-next",
			mode: "discovery" as const,
			documents: [],
		};
		const rendered = renderCoverageAssignment(assignment, config, ledger);
		expect(rendered).toContain("QUERIES ALREADY USED");
		expect(rendered).toContain(firstRound()[0]?.query ?? "missing query");
		expect(rendered).toContain("genuinely NEW wording and perspective");

		const manifest = coverageVerificationManifest(ledger);
		const payload = JSON.parse(manifest.split("\n").at(-1) ?? "null") as {
			discoverySearches: Array<{
				resultRefs: string[];
				resultRefCount: number;
			}>;
		};
		expect(payload.discoverySearches[1]).toMatchObject({
			resultRefs: ["/B"],
			resultRefCount: 1,
		});
	});

	test("keeps a 329-document verifier manifest complete below the flow budget", () => {
		const summaries = Array.from({ length: 329 }, (_, index) => ({
			reference: `/doc-${String(index).padStart(3, "0")}`,
			title: `Document ${index}`,
			summary: "summary",
		}));
		const ledger = seedCoverageLedger(
			[
				{
					tool_call_id: "seed-329",
					tool_name: "vectorsearch/get_summaries",
					result: { summaries, count: 329, total: 329 },
					execution_time_seconds: 0,
				},
			],
			"vectorsearch/get_summaries",
		);
		ledger.documents = ledger.documents.map((document) => ({
			...document,
			status: "excluded" as const,
			reason: `Konkreter Ausschlussgrund fuer ${document.ref}: ${"x".repeat(2000)}`,
		}));

		const manifest = coverageVerificationManifest(ledger);
		const payload = JSON.parse(manifest.split("\n").at(-1) ?? "null") as {
			total: number;
			documents: Array<{ ref: string; reason: string }>;
		};
		expect(manifest.length).toBeLessThan(180000);
		expect(payload.total).toBe(329);
		expect(payload.documents).toHaveLength(329);
		expect(new Set(payload.documents.map((document) => document.ref)).size).toBe(
			329,
		);
		expect(payload.documents.every((document) => document.reason.length <= 257)).toBe(
			true,
		);
	});

	test("keeps every document status within the assembled verifier budget", () => {
		const summaries = Array.from({ length: 329 }, (_, index) => ({
			reference: `/long-ref-${String(index).padStart(3, "0")}-${"r".repeat(120)}`,
			title: `Document ${index}`,
			summary: "summary",
		}));
		const ledger = seedCoverageLedger(
			[
				{
					tool_call_id: "seed",
					tool_name: "vectorsearch/get_summaries",
					result: { summaries, count: 329, total: 329 },
					execution_time_seconds: 0,
				},
			],
			"vectorsearch/get_summaries",
		);
		ledger.documents = ledger.documents.map((document) => ({
			...document,
			status: "excluded" as const,
			reason: "reason ".repeat(1000),
			candidateReasons: Array.from({ length: 20 }, () =>
				"candidate ".repeat(500),
			),
			windows: Array.from({ length: 100 }, (_, index) => ({
				offset: index * 10,
				end: index * 10 + 10,
			})),
			searches: Array.from({ length: 20 }, () =>
				pass("query ".repeat(500), [document.ref], true),
			),
		}));
		const requestChars = 70_000;
		const maxContextChars = 180_000;
		const manifest = coverageVerificationManifest(
			ledger,
			config,
			maxContextChars - requestChars - 256,
		);
		const payload = JSON.parse(manifest.split("\n").at(-1) ?? "null") as {
			documents: Array<{ ref: string; status: string }>;
		};
		expect(requestChars + manifest.length + 256).toBeLessThanOrEqual(
			maxContextChars,
		);
		expect(payload.documents).toHaveLength(329);
		expect(
			new Set(payload.documents.map((document) => document.ref)).size,
		).toBe(329);
		expect(
			payload.documents.every((document) => document.status === "excluded"),
		).toBe(true);
	});

	test("exposes configured discovery and hybrid requirements to verification", () => {
		const manifest = coverageVerificationManifest(
			completeFirstDiscovery(),
			config,
		);
		const payload = JSON.parse(manifest.split("\n").at(-1) ?? "null") as {
			requiredDiscoveryRounds: number;
			hybridSearchRequirements: unknown;
		};
		expect(payload.requiredDiscoveryRounds).toBe(2);
		expect(payload.hybridSearchRequirements).toEqual(config.hybridSearch);
	});

	test("renders only bounded sanitized gaps plus run and verification status", () => {
		const secret = "RAW-SUMMARY-MUST-NOT-LEAK";
		const ledger = seed();
		ledger.documents = ledger.documents.map((document, index) => ({
			...document,
			title: `private-title-${index}`,
			summary: secret,
			reason: `private verifier prose ${index}`,
		}));
		const status = coverageCompletionStatus(ledger, config, {
			partial: true,
			verified: false,
			stopReason: "verification-failed",
			maxGapItems: 1,
		});
		const payload = JSON.parse(status.split("\n").at(-1) ?? "null") as {
			coverageComplete: boolean;
			runComplete: boolean;
			verified: boolean;
			stopReason: string;
			gaps: Array<{ kind?: string }>;
			omittedGapCount: number;
		};

		expect(payload).toMatchObject({
			coverageComplete: false,
			runComplete: false,
			verified: false,
			stopReason: "verification-failed",
		});
		expect(payload.gaps.slice(0, 3).map((gap) => gap.kind)).toEqual([
			"discovery-rounds-open",
			"run-stopped-partial",
			"verification-not-confirmed",
		]);
		expect(payload.gaps[3]?.kind).toBe("summary-triage-open");
		expect(payload.omittedGapCount).toBeGreaterThan(0);
		expect(status).not.toContain(secret);
		expect(status).not.toContain("private-title");
		expect(status).not.toContain("private verifier prose");
	});

	test("failed or evidenceless discovery exhausts bounded attempts fail-closed", () => {
		let ledger = seed();
		for (
			let attempt = 0;
			attempt < config.searchDiscovery.maxAttemptsPerRound;
			attempt += 1
		) {
			const assignment = nextCoverageAssignment(ledger, config);
			if (assignment === undefined)
				throw new Error("attempt missing too early");
			ledger = markCoverageAssignmentIssued(ledger, assignment);
		}
		expect(ledger.discoveryRounds).toBe(0);
		expect(ledger.discoveryAttempts).toBe(2);
		expect(nextCoverageAssignment(ledger, config)).toBeUndefined();
		expect(isCoverageTerminal(ledger, config)).toBe(false);
	});

	test("a discovery assignment asks for search passes and forbids a report", () => {
		const ledger = seed();
		const discovery = nextCoverageAssignment(ledger, config);
		if (discovery === undefined) throw new Error("missing discovery");
		const rendered = renderCoverageAssignment(discovery, config, ledger);
		expect(rendered).toContain("SEARCH DISCOVERY");
		expect(rendered).toContain("hyde=false");
		expect(rendered).toContain("hyde=true");
		expect(rendered).toContain("Emit NO <COVERAGE> block");
	});

	test("search hits promote an untriaged document into original review", () => {
		const ledger = completeFirstDiscovery();
		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("Frist 03.03.2024", ["/B"])],
			config.searchDiscovery.maxHitsPerPass,
		);
		expect(promoted.promotedRefs).toEqual(["/B"]);
		const assignment = nextCoverageAssignment(promoted.ledger, config);
		expect(assignment?.mode).toBe("original");
		expect(assignment?.documents.map((document) => document.ref)).toEqual([
			"/B",
		]);
	});

	test("reopens a document excluded on summary evidence alone", () => {
		let ledger = completeFirstDiscovery();
		ledger = {
			...ledger,
			documents: ledger.documents.map((document) =>
				document.ref === "/A"
					? { ...document, status: "excluded" as const, reason: "Sachfremd" }
					: document,
			),
		};
		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("Aktenzeichen 123", ["/A"])],
			config.searchDiscovery.maxHitsPerPass,
		);
		expect(promoted.promotedRefs).toEqual(["/A"]);
		const reopened = promoted.ledger.documents.find(
			(document) => document.ref === "/A",
		);
		expect(reopened?.status).toBe("summary-reviewed");
		expect(reopened?.promotedBySearch).toBe(true);
		expect(reopened?.reason).toContain("Sachfremd");
	});

	test("a search hit wins over a summary exclusion from the same outcome", () => {
		let ledger = completeFirstDiscovery();
		const summary = nextCoverageAssignment(ledger, config);
		if (summary === undefined || summary.mode !== "summary") {
			throw new Error("missing summary assignment");
		}
		ledger = markCoverageAssignmentIssued(ledger, summary);
		const parsed = parseCoverageReport(
			`<COVERAGE>{"assignmentId":"${summary.id}","documents":[{"ref":"/A","decision":"excluded","reason":"Summary wirkt sachfremd"},{"ref":"/B","decision":"excluded","reason":"Summary wirkt sachfremd"}]}</COVERAGE>`,
			summary,
			config.markers,
		);
		if (parsed === undefined) throw new Error("missing summary report");
		ledger = applyCoverageReport(ledger, summary, parsed.report).ledger;
		expect(
			ledger.documents.find((document) => document.ref === "/A")?.status,
		).toBe("excluded");

		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("exakter Treffer im Original", ["/A"])],
			config.searchDiscovery.maxHitsPerPass,
		);
		expect(promoted.promotedRefs).toEqual(["/A"]);
		expect(
			promoted.ledger.documents.find((document) => document.ref === "/A")
				?.status,
		).toBe("summary-reviewed");
		expect(nextCoverageAssignment(promoted.ledger, config)?.mode).toBe(
			"original",
		);
	});

	test("never re-promotes a document already read in the original (loop guard)", () => {
		let ledger = completeFirstDiscovery();
		ledger = {
			...ledger,
			documents: ledger.documents.map((document) =>
				document.ref === "/A"
					? {
							...document,
							status: "excluded" as const,
							reason: "Nach Originalpruefung irrelevant",
							totalChars: 10,
							modified: "v1",
							windows: [{ offset: 0, end: 10 }],
						}
					: { ...document, status: "reviewed" as const, reason: "gelesen" },
			),
		};
		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("beliebig", ["/A", "/B"])],
			config.searchDiscovery.maxHitsPerPass,
		);
		expect(promoted.promotedRefs).toEqual([]);
	});

	test("only the top-ranked hits per pass are eligible", () => {
		const ledger = completeFirstDiscovery();
		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("viele Treffer", ["/A", "/B"])],
			1,
		);
		expect(promoted.promotedRefs).toEqual(["/A"]);
	});

	test("a settled dossier is not terminal while a discovery round is owed", () => {
		const settled = {
			...seed(),
			documents: seed().documents.map((document) => ({
				...document,
				status: "excluded" as const,
				reason: "triage",
			})),
		};
		// Without discovery configured this is the end (unchanged behaviour).
		expect(isCoverageTerminal(settled)).toBe(true);
		// With discovery owed, the run must continue and search after all.
		expect(isCoverageTerminal(settled, config)).toBe(false);
		expect(nextCoverageAssignment(settled, config)?.mode).toBe("discovery");

		const exhausted = {
			...settled,
			discoveryRounds: config.searchDiscovery.rounds,
		};
		expect(isCoverageTerminal(exhausted, config)).toBe(true);
		expect(nextCoverageAssignment(exhausted, config)).toBeUndefined();
	});
});

describe("coverageToolKind", () => {
	// Regression: an llm worker reports the AI SDK key ("vectorsearch__search"),
	// not the ref ("vectorsearch/search"). Matching only the slash form recorded
	// NO evidence for the researcher at all, so no original could ever be
	// accepted as reviewed.
	test("classifies both the tool ref and the sanitized AI SDK key", () => {
		expect(coverageToolKind("vectorsearch/get_document")).toBe("document");
		expect(coverageToolKind("vectorsearch__get_document")).toBe("document");
		expect(coverageToolKind("vectorsearch/search")).toBe("search");
		expect(coverageToolKind("vectorsearch__search")).toBe("search");
	});

	test("tolerates the numeric suffix appended on key collision", () => {
		expect(coverageToolKind("vectorsearch__get_document_2")).toBe("document");
		expect(coverageToolKind("vectorsearch__search_3")).toBe("search");
	});

	test("does not treat folder reads or unrelated tools as coverage evidence", () => {
		// get_documents reads a whole folder and yields no window ledger, so it
		// must never satisfy the gap-free original requirement.
		expect(coverageToolKind("vectorsearch__get_documents")).toBeUndefined();
		expect(coverageToolKind("vectorsearch__get_summaries")).toBeUndefined();
		expect(coverageToolKind("vectorsearch__find_folders")).toBeUndefined();
		expect(coverageToolKind("base__datetime")).toBeUndefined();
	});
});

describe("plannerless coverage queue", () => {
	const config = {
		enabled: true,
		sourceTool: "vectorsearch/get_summaries",
		batchSize: 2,
		maxOriginalsPerBatch: 1,
		assignmentCharBudget: 1000,
		documentWindowChars: 1000,
		markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
	} as const;

	const seed = (total = 2) =>
		seedCoverageLedger(
			[
				{
					tool_call_id: "seed",
					tool_name: config.sourceTool,
					result: {
						summaries: [
							{ reference: "/A", title: "A", summary: "Summary A" },
							{ reference: "/B", title: "B", summary: "Summary B" },
						],
						count: 2,
						total,
					},
					execution_time_seconds: 0,
				},
			],
			config.sourceTool,
		);

	const triageReport = (assignmentId: string) =>
		`<COVERAGE>{"assignmentId":"${assignmentId}","documents":[{"ref":"/A","decision":"relevant","reason":"Fristbezug"},{"ref":"/B","decision":"excluded","reason":"Sachfremde Rechnung"}]}</COVERAGE>`;

	test("fails closed when unique summary refs do not match total", () => {
		expect(() => seed(3)).toThrow("Coverage seed incomplete");
	});

	test("keeps a summary while truncating a long title to the assignment budget", () => {
		const ledger = seedCoverageLedger(
			[
				{
					tool_call_id: "long-seed",
					tool_name: config.sourceTool,
					result: {
						summaries: [
							{
								reference: "/A",
								title: "T".repeat(2000),
								summary: "S".repeat(2000),
							},
						],
						count: 1,
						total: 1,
					},
					execution_time_seconds: 0,
				},
			],
			config.sourceTool,
		);
		const assignment = nextCoverageAssignment(ledger, config);
		const document = assignment?.documents[0];
		if (document === undefined) throw new Error("missing budgeted assignment");
		expect(document.title.endsWith("…")).toBe(true);
		expect(document.title.length).toBeLessThanOrEqual(512);
		expect(document.summary.length).toBeGreaterThanOrEqual(256);
		expect(document.summary).toBe("S".repeat(document.summary.length));
		expect(
			document.ref.length +
				document.title.length +
				64 +
				document.summary.length,
		).toBeLessThanOrEqual(config.assignmentCharBudget);
	});

	test("includes accumulated original window state in the document budget", () => {
		const ledger = seed();
		// A summary long enough to consume the whole budget on its own: only an
		// accounting that reserves the rendered window state can stay in budget.
		ledger.documents = ledger.documents.map((document) =>
			document.ref === "/A"
				? {
						...document,
						status: "summary-reviewed" as const,
						summary: "S".repeat(4000),
						totalChars: 800,
						modified: "v1",
						windows: Array.from({ length: 40 }, (_, index) => ({
							offset: index * 20,
							end: index * 20 + 10,
						})),
					}
				: document,
		);
		const assignment = nextCoverageAssignment(ledger, config);
		const document = assignment?.documents[0];
		if (assignment === undefined || document === undefined) {
			throw new Error("missing original assignment");
		}
		expect(assignment.mode).toBe("original");
		const rendered = renderCoverageAssignment(assignment, config, ledger);
		const statePrefix = "RUNTIME WINDOW STATE: ";
		const stateLine = rendered
			.split("\n")
			.find((line) => line.startsWith(statePrefix));
		if (stateLine === undefined)
			throw new Error("missing rendered window state");
		const windowState = stateLine.slice(statePrefix.length);
		// The rendered state must be substantial, otherwise the assertion below
		// would hold even without budgeting it.
		expect(windowState.length).toBeGreaterThan(256);
		expect(document.summary.length).toBeGreaterThanOrEqual(256);
		expect(
			document.ref.length +
				document.title.length +
				64 +
				document.summary.length +
				windowState.length,
		).toBeLessThanOrEqual(config.assignmentCharBudget);
	});

	test("does not blindly assign an extremely long ref that cannot fit", () => {
		const longRef = `/${"R".repeat(900)}`;
		const ledger = seedCoverageLedger(
			[
				{
					tool_call_id: "long-ref-seed",
					tool_name: config.sourceTool,
					result: {
						summaries: [
							{
								reference: longRef,
								title: "Title",
								summary: "S".repeat(500),
							},
						],
						count: 1,
						total: 1,
					},
					execution_time_seconds: 0,
				},
			],
			config.sourceTool,
		);
		expect(nextCoverageAssignment(ledger, config)).toBeUndefined();
		expect(isCoverageTerminal(ledger, config)).toBe(false);
	});

	test("requires a non-empty reason for every report decision", () => {
		const ledger = seed();
		const triage = nextCoverageAssignment(ledger, config);
		if (triage === undefined) throw new Error("missing triage assignment");
		expect(
			parseCoverageReport(
				`<COVERAGE>{"assignmentId":"${triage.id}","documents":[{"ref":"/A","decision":"relevant","reason":""},{"ref":"/B","decision":"excluded","reason":"irrelevant"}]}</COVERAGE>`,
				triage,
				config.markers,
			),
		).toBeUndefined();
	});

	test("accepts a strict partial report and reassigns only omitted refs", () => {
		let ledger = seed();
		const triage = nextCoverageAssignment(ledger, config);
		if (triage === undefined) throw new Error("missing triage assignment");
		const parsed = parseCoverageReport(
			`<COVERAGE>{"assignmentId":"${triage.id}","documents":[{"ref":"/A","decision":"excluded","reason":"Sachfremde Rechnung"}]}</COVERAGE>`,
			triage,
			config.markers,
		);
		if (parsed === undefined) throw new Error("partial report did not parse");
		ledger = applyCoverageReport(ledger, triage, parsed.report).ledger;
		expect(
			ledger.documents.map((document) => [document.ref, document.status]),
		).toEqual([
			["/A", "excluded"],
			["/B", "open"],
		]);
		const remainder = nextCoverageAssignment(ledger, config);
		expect(remainder?.mode).toBe("summary");
		expect(remainder?.documents.map((document) => document.ref)).toEqual([
			"/B",
		]);
	});

	test("rejects empty, duplicate, foreign, and reasonless partial reports", () => {
		const ledger = seed();
		const triage = nextCoverageAssignment(ledger, config);
		if (triage === undefined) throw new Error("missing triage assignment");
		const reports = [
			`<COVERAGE>{"assignmentId":"${triage.id}","documents":[]}</COVERAGE>`,
			`<COVERAGE>{"assignmentId":"${triage.id}","documents":[{"ref":"/A","decision":"relevant","reason":"Frist"},{"ref":"/A","decision":"excluded","reason":"Doppelt"}]}</COVERAGE>`,
			`<COVERAGE>{"assignmentId":"${triage.id}","documents":[{"ref":"/C","decision":"relevant","reason":"Fremd"}]}</COVERAGE>`,
			`<COVERAGE>{"assignmentId":"${triage.id}","documents":[{"ref":"/A","decision":"relevant","reason":"   "}]}</COVERAGE>`,
		];
		for (const report of reports) {
			expect(
				parseCoverageReport(report, triage, config.markers),
			).toBeUndefined();
		}
	});

	test("renders only the authoritative assignment refs without a global next list", () => {
		const ledger = seed();
		const triage = nextCoverageAssignment(ledger, config);
		if (triage === undefined) throw new Error("missing triage assignment");
		const rendered = renderCoverageAssignment(triage, config, ledger);
		expect(rendered).toContain(
			"AUTHORITATIVE DOCUMENTS IN THIS ASSIGNMENT (2 total)",
		);
		expect(coverageSummary(ledger)).not.toContain("; next:");
		expect(rendered).not.toContain("; next:");
	});

	test("accepts only successful distinct grouped hybrid search variants", () => {
		const exact = coverageSearchEvidenceFromToolResult(
			JSON.stringify({
				query: "Aktenzeichen 123 Frist 03.03.2024",
				hybrid: true,
				hyde: false,
				group_by_document: true,
			}),
			{
				content: [
					{
						type: "text",
						text: JSON.stringify({
							results: [
								{ base_ref: "/A" },
								{ base_ref: "/A" },
								{ reference: "/B" },
							],
						}),
					},
				],
			},
		);
		const conceptual = coverageSearchEvidenceFromToolResult(
			JSON.stringify({
				query: "juristischer Fristbeginn und Zugang",
				hybrid: true,
				hyde: true,
				group_by_document: true,
			}),
			{ results: [{ base_ref: "/A" }] },
		);
		if (exact === undefined || conceptual === undefined) {
			throw new Error("missing search evidence");
		}
		expect(exact.resultRefs).toEqual(["/A", "/B"]);
		const requirements = {
			minDistinctQueries: 2,
			requireHydeVariants: true,
			requireGroupedResults: true,
		};
		expect(hasRequiredHybridSearchEvidence([exact], requirements)).toBe(false);
		expect(
			hasRequiredHybridSearchEvidence([exact, conceptual], requirements),
		).toBe(true);
		expect(
			coverageSearchEvidenceFromToolResult(
				JSON.stringify({ query: "dense only", hybrid: false }),
				{ results: [] },
			),
		).toBeUndefined();
	});

	test("parses MCP root-array text parts for search evidence", () => {
		const evidence = coverageSearchEvidenceFromToolResult(
			JSON.stringify({
				query: "Aktenzeichen 123 Frist 03.03.2024",
				hybrid: true,
				hyde: false,
				group_by_document: true,
			}),
			[
				{
					type: "text",
					text: JSON.stringify({ results: [{ base_ref: "/A" }] }),
				},
				{ type: "text", text: "Zitier-Hinweis: Quellen genau prüfen." },
			],
		);

		expect(evidence?.resultRefs).toEqual(["/A"]);
	});

	test("assigns a relevant summary for original review in the following batch", () => {
		let ledger = seed();
		const triage = nextCoverageAssignment(ledger, config);
		expect(triage?.mode).toBe("summary");
		if (triage === undefined) throw new Error("missing triage assignment");
		const parsed = parseCoverageReport(
			`finding\n${triageReport(triage.id)}`,
			triage,
			config.markers,
		);
		if (parsed === undefined) throw new Error("report did not parse");
		ledger = applyCoverageReport(ledger, triage, parsed.report).ledger;
		const original = nextCoverageAssignment(ledger, config);
		expect(original?.mode).toBe("original");
		expect(original?.documents.map((document) => document.ref)).toEqual(["/A"]);
	});

	test("rejects reviewed until runtime-observed windows cover the full original", () => {
		let ledger = seed();
		const triage = nextCoverageAssignment(ledger, config);
		if (triage === undefined) throw new Error("missing triage assignment");
		const parsedTriage = parseCoverageReport(
			triageReport(triage.id),
			triage,
			config.markers,
		);
		if (parsedTriage === undefined) throw new Error("missing triage report");
		ledger = applyCoverageReport(ledger, triage, parsedTriage.report).ledger;
		const original = nextCoverageAssignment(ledger, config);
		if (original === undefined) throw new Error("missing original assignment");
		const originalReport = parseCoverageReport(
			`<COVERAGE>{"assignmentId":"${original.id}","documents":[{"ref":"/A","decision":"reviewed","reason":"Original vollstaendig gelesen"}]}</COVERAGE>`,
			original,
			config.markers,
		);
		if (originalReport === undefined)
			throw new Error("missing original report");

		const rejected = applyCoverageReport(
			ledger,
			original,
			originalReport.report,
		);
		expect(rejected.rejectedRefs).toEqual(["/A"]);
		expect(isCoverageTerminal(rejected.ledger)).toBe(false);

		const first = coverageEvidenceFromToolResult(
			new Set(["/A"]),
			JSON.stringify({ reference: "/A", offset: 0, max_chars: 6 }),
			{
				content: [
					{
						type: "text",
						text: JSON.stringify({
							reference: "/A",
							content: "abcdef",
							totalChars: 10,
							modified: "2026-08-21T10:00:00.000Z",
						}),
					},
				],
			},
		);
		const second = coverageEvidenceFromToolResult(
			new Set(["/A"]),
			JSON.stringify({ reference: "/A", offset: 5, max_chars: 6 }),
			{
				reference: "/A",
				content: "fghij",
				totalChars: 10,
				modified: "2026-08-21T10:00:00.000Z",
			},
		);
		if (first === undefined || second === undefined) {
			throw new Error("missing tool evidence");
		}
		ledger = mergeCoverageEvidence(ledger, [first, second]);
		const searchRequirements = {
			minDistinctQueries: 2,
			requireHydeVariants: true,
			requireGroupedResults: true,
		};
		const missingSearches = applyCoverageReport(
			ledger,
			original,
			originalReport.report,
			[],
			searchRequirements,
		);
		expect(missingSearches.rejectedSearchRefs).toEqual(["/A"]);
		expect(isCoverageTerminal(missingSearches.ledger)).toBe(false);

		const accepted = applyCoverageReport(
			ledger,
			original,
			originalReport.report,
			[
				{
					query: "Aktenzeichen und exaktes Datum",
					hybrid: true,
					hyde: false,
					groupByDocument: true,
					resultRefs: ["/A"],
				},
				{
					query: "juristischer Fristbeginn und Zugang",
					hybrid: true,
					hyde: true,
					groupByDocument: true,
					resultRefs: ["/A"],
				},
			],
			searchRequirements,
		);
		expect(accepted.rejectedRefs).toEqual([]);
		expect(accepted.rejectedSearchRefs).toEqual([]);
		expect(accepted.ledger.documents[0]?.searches).toHaveLength(2);
		expect(isCoverageTerminal(accepted.ledger)).toBe(true);
	});

	test("parses MCP root-array text parts for document evidence", () => {
		const evidence = coverageEvidenceFromToolResult(
			new Set(["/A"]),
			JSON.stringify({ reference: "/A", offset: 0, max_chars: 6 }),
			[
				{
					type: "text",
					text: JSON.stringify({
						reference: "/A",
						content: "abcdef",
						totalChars: 6,
						modified: "2026-08-21T10:00:00.000Z",
					}),
				},
			],
		);

		expect(evidence).toMatchObject({
			ref: "/A",
			totalChars: 6,
		});
	});

	test("rejects get_document evidence without a document version", () => {
		const evidence = coverageEvidenceFromToolResult(
			new Set(["/A"]),
			JSON.stringify({ reference: "/A", offset: 0 }),
			{ reference: "/A", content: "abcdef", totalChars: 6 },
		);
		expect(evidence).toBeUndefined();
	});

	test("invalidates old windows when the document snapshot changes", () => {
		let ledger = seed();
		ledger = mergeCoverageEvidence(ledger, [
			{
				ref: "/A",
				totalChars: 10,
				modified: "v1",
				windows: [{ offset: 0, end: 10 }],
			},
			{
				ref: "/A",
				totalChars: 12,
				modified: "v2",
				windows: [{ offset: 6, end: 12 }],
			},
			{
				ref: "/A",
				totalChars: 10,
				modified: "v1",
				windows: [{ offset: 0, end: 10 }],
			},
		]);
		const document = ledger.documents.find((entry) => entry.ref === "/A");
		expect(document?.windows).toEqual([{ offset: 6, end: 12 }]);
		expect(document?.totalChars).toBe(12);
	});

	test("reopens one completed discovery round from structured global critique", () => {
		const discoveryConfig = {
			...config,
			searchDiscovery: {
				rounds: 1,
				maxAttemptsPerRound: 2,
				maxHitsPerPass: 2,
			},
		} as const;
		const priorSearches = [
			{
				query: "Aktenzeichen und Datum",
				hybrid: true as const,
				hyde: false,
				groupByDocument: true,
				resultRefs: ["/A"],
			},
		];
		const settled = {
			...seed(),
			discoveryRounds: discoveryConfig.searchDiscovery.rounds,
			discoverySearches: priorSearches,
			documents: seed().documents.map((document) => ({
				...document,
				status: "excluded" as const,
				reason: "triage",
			})),
		};
		expect(isCoverageTerminal(settled, discoveryConfig)).toBe(true);
		const reopened = reopenCoverageFromCritique(
			settled,
			"1. GLOBAL DISCOVERY: neue komplementaere Query-Evidenz erforderlich.",
		);
		expect(reopened.discoveryReopened).toBe(true);
		expect(reopened.ledger.discoveryRounds).toBe(0);
		expect(reopened.ledger.discoverySearches).toEqual(priorSearches);
		expect(nextCoverageAssignment(reopened.ledger, discoveryConfig)?.mode).toBe(
			"discovery",
		);
	});

	test("reopens only refs explicitly named by verifier critique", () => {
		const ledger = seed();
		ledger.documents = ledger.documents.map((document) => ({
			...document,
			status: "excluded" as const,
			reason: "initial",
		}));
		const reopened = reopenCoverageFromCritique(
			ledger,
			"1. /A erneut im Original pruefen",
		);
		expect(reopened.reopenedRefs).toEqual(["/A"]);
		expect(
			reopened.ledger.documents.map((document) => document.status),
		).toEqual(["open", "excluded"]);
	});
});
