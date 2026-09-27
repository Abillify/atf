// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Deterministic builder for the shipped, synthetic golden-set fixture.
 *
 * Run with `bun run scripts/eval/golden-set/build-fixture.ts` to regenerate
 * `golden-set.v1.json`. The content is entirely synthetic (no confidential
 * material) so the fixture may live in the public tree. When the fixture
 * changes, bump `VERSION` and regenerate.
 *
 * The four documents mirror the representative set from the design: a WMS
 * requirements specification (DOCX), a process document with BPMN diagrams, a
 * screen/mask document with UI screenshots, and a technical plan set.
 */

import { resolve } from "node:path";
import { parseGoldenSet } from "../golden-set.ts";

// 1.1.0: added ground-truth extraction annotations (expected table content,
// figure labels, BPMN nodes/edges) for the Phase-2 extraction-quality metrics
// (task T2.10, requirement 18.3). Backward-compatible with 1.0.0 readers — the
// `extraction` field is optional.
const VERSION = "1.1.0";

interface DocSpec {
	id: string;
	reference: string;
	kind: "docx" | "bpmn" | "ui_mask" | "plan";
	title: string;
	pages: number;
	note: string;
}

const WMS: DocSpec = {
	id: "wms-spec",
	reference: "/golden/wms-pflichtenheft.docx",
	kind: "docx",
	title: "WMS-Pflichtenheft (synthetisch)",
	pages: 42,
	note: "Synthetic warehouse-management requirements spec: numbered sections, requirement tables, field lists.",
};
const BPMN: DocSpec = {
	id: "process-bpmn",
	reference: "/golden/wareneingang-prozesse.pdf",
	kind: "bpmn",
	title: "Prozessdokumentation mit BPMN (synthetisch)",
	pages: 18,
	note: "Synthetic process manual embedding BPMN diagrams for goods receipt and returns.",
};
const MASKS: DocSpec = {
	id: "ui-masks",
	reference: "/golden/masken-handbuch.pdf",
	kind: "ui_mask",
	title: "Maskenhandbuch (synthetisch)",
	pages: 24,
	note: "Synthetic screen manual with UI-mask screenshots and labelled fields.",
};
const PLAN: DocSpec = {
	id: "plan-set",
	reference: "/golden/plansatz-halle.pdf",
	kind: "plan",
	title: "Plansatz Halle (synthetisch)",
	pages: 12,
	note: "Synthetic plan set: large-format technical drawings with title blocks and legends.",
};

const documents: DocSpec[] = [WMS, BPMN, MASKS, PLAN];

interface ExtractionSpec {
	expectedTable?: string[][];
	expectedLabels?: string[];
	expectedNodes?: { id?: string; label?: string }[];
	expectedEdges?: { from: string; to: string }[];
}

interface QSpec {
	document: string;
	question: string;
	pages?: number[];
	figures?: string[];
	cells?: { page: number; row: number; col: number }[];
	extraction?: ExtractionSpec;
}

// Deterministic page picker so questions spread across a document. Always
// returns a page in 1..total (total is a positive integer for every document).
function pickPage(seed: number, total: number): number {
	const x = ((seed * 2654435761) % total) + seed * 37;
	return (((x % total) + total) % total) + 1;
}

const questions: QSpec[] = [];

// WMS spec: 40 questions — mix of page lookups, requirement tables (cells),
// and a few field-list figures.
const wmsTopics = [
	"Welche Anforderung beschreibt die Teilfreigabe im Wareneingang?",
	"Wo ist die Rolle des Lagerleiters definiert?",
	"Welche Pflichtfelder hat die Wareneingangsmaske?",
	"Wie wird die Chargenverwaltung gefordert?",
	"Welche Anforderung regelt die Rückverfolgbarkeit?",
	"Wo steht die Definition des Begriffs Anmeldung?",
	"Welche Schnittstelle zum ERP wird verlangt?",
	"Welche Anforderung betrifft die Inventur?",
	"Wo werden die Berechtigungen beschrieben?",
	"Welche Anforderung nennt die Prüfung der Mengen?",
	"Wie wird die Sperrlagerlogik gefordert?",
	"Welche Anforderung beschreibt die Umlagerung?",
	"Wo ist der Freigabeprozess dokumentiert?",
	"Welche Felder hat die Freigabemaske?",
	"Welche Anforderung regelt die Etikettierung?",
	"Wo steht die Fehlerbehandlung bei Buchungen?",
	"Welche Anforderung betrifft die Kommissionierung?",
	"Wie wird die Nachschubsteuerung beschrieben?",
	"Welche Anforderung nennt die Bestandsführung?",
	"Wo ist die Definition der Teilmenge?",
];
wmsTopics.forEach((question, index) => {
	const page = pickPage(index + 1, WMS.pages);
	questions.push({ document: "wms-spec", question, pages: [page] });
});
// Requirement-table cell questions for the WMS spec. Each carries the
// ground-truth requirement table so table-cell accuracy can be scored: a small
// header + one requirement row per question (task T2.10, requirement 18.3).
for (let i = 0; i < 12; i++) {
	const page = pickPage(100 + i, WMS.pages);
	const code = `A-${(i + 1).toString().padStart(3, "0")}`;
	questions.push({
		document: "wms-spec",
		question: `Welchen Wert hat Anforderung ${code} in der Anforderungstabelle?`,
		pages: [page],
		cells: [{ page, row: (i % 6) + 2, col: (i % 3) + 2 }],
		extraction: {
			expectedTable: [
				["ID", "Anforderung", "Priorität"],
				[
					code,
					`Anforderung ${code} des Wareneingangs`,
					i % 2 === 0 ? "MUSS" : "SOLL",
				],
			],
		},
	});
}
// Field-list figures in the WMS spec. Each figure is annotated with the field
// labels a correct transcription must surface (label-coverage).
for (let i = 0; i < 8; i++) {
	const page = pickPage(200 + i, WMS.pages);
	questions.push({
		document: "wms-spec",
		question: `Welche Feldliste zeigt die Abbildung der Maske M-${i + 1}?`,
		pages: [page],
		figures: [`fig-wms-${i + 1}`],
		extraction: {
			expectedLabels: [`Feld ${i + 1}a`, `Feld ${i + 1}b`, "Speichern"],
		},
	});
}

// BPMN document: 30 questions — process/figure heavy.
const bpmnTopics = [
	"Welche Aufgabe folgt auf die Wareneingangsprüfung im Prozess?",
	"Welches Gateway entscheidet über die Teilfreigabe?",
	"Welche Lane bearbeitet die Rücksendung?",
	"Wo beginnt der Wareneingangsprozess?",
	"Welche Aufgabe schließt den Retourenprozess ab?",
	"Welche Pools zeigt das BPMN-Diagramm des Wareneingangs?",
	"Welcher Sequenzfluss verbindet Prüfung und Buchung?",
	"Welche Entscheidung trifft der Lagerleiter im Prozess?",
	"Welche Aufgabe erzeugt das Wareneingangsetikett?",
	"Welches Ereignis startet die Reklamation?",
];
bpmnTopics.forEach((question, index) => {
	const page = pickPage(300 + index, BPMN.pages);
	questions.push({
		document: "process-bpmn",
		question,
		pages: [page],
		figures: [`fig-bpmn-${(index % 6) + 1}`],
	});
});
for (let i = 0; i < 20; i++) {
	const page = pickPage(400 + i, BPMN.pages);
	// A small synthetic process per sub-diagram: start → task → gateway → end,
	// annotated as ground truth for BPMN node/edge recall (task T2.10).
	const nodes = [
		{ id: `n${i}-start`, label: "Start" },
		{ id: `n${i}-pruefung`, label: "Wareneingangsprüfung" },
		{ id: `n${i}-gw`, label: "Teilfreigabe?" },
		{ id: `n${i}-end`, label: "Ende" },
	];
	const edges = [
		{ from: `n${i}-start`, to: `n${i}-pruefung` },
		{ from: `n${i}-pruefung`, to: `n${i}-gw` },
		{ from: `n${i}-gw`, to: `n${i}-end` },
	];
	questions.push({
		document: "process-bpmn",
		question: `Welche Knoten und Kanten enthält das Teildiagramm ${i + 1} des Prozesses?`,
		pages: [page],
		figures: [`fig-bpmn-${(i % 6) + 1}`],
		extraction: { expectedNodes: nodes, expectedEdges: edges },
	});
}

// UI masks: 30 questions — figure and field heavy.
const maskTopics = [
	"Welche Felder hat die Anmeldemaske?",
	"Wo ist die Maske für die Teilfreigabe abgebildet?",
	"Welche Schaltflächen zeigt die Wareneingangsmaske?",
	"Welche Pflichtfelder markiert die Freigabemaske?",
	"Welche Maske zeigt die Chargenauswahl?",
	"Wo ist die Suchmaske für Artikel abgebildet?",
	"Welche Felder hat die Inventurmaske?",
	"Welche Maske zeigt die Umlagerung?",
	"Welche Eingabefelder hat die Reklamationsmaske?",
	"Wo ist die Übersichtsmaske dargestellt?",
];
maskTopics.forEach((question, index) => {
	const page = pickPage(500 + index, MASKS.pages);
	questions.push({
		document: "ui-masks",
		question,
		pages: [page],
		figures: [`fig-mask-${(index % 10) + 1}`],
	});
});
for (let i = 0; i < 20; i++) {
	const page = pickPage(600 + i, MASKS.pages);
	questions.push({
		document: "ui-masks",
		question: `Welches Feldlabel trägt das Eingabefeld ${i + 1} auf dem Screenshot?`,
		pages: [page],
		figures: [`fig-mask-${(i % 10) + 1}`],
		extraction: {
			expectedLabels: [`Eingabefeld ${i + 1}`, "Abbrechen", "Übernehmen"],
		},
	});
}

// Plan set: 20 questions — drawing/figure heavy + title-block cells.
const planTopics = [
	"Welche Legende erklärt die Symbole im Hallenplan?",
	"Wo ist der Grundriss der Halle abgebildet?",
	"Welche Maße nennt der Schnitt A-A?",
	"Welches Planblatt zeigt die Regalzonen?",
	"Wo ist die Fluchtwegkennzeichnung dargestellt?",
	"Welche Bemaßung hat das Tor im Plan?",
	"Welches Blatt zeigt die Elektroinstallation?",
	"Wo ist der Detailausschnitt der Rampe?",
	"Welche Zeichnungsnummer trägt der Übersichtsplan?",
	"Welche Zonen zeigt der Nutzungsplan?",
];
planTopics.forEach((question, index) => {
	const page = pickPage(700 + index, PLAN.pages);
	questions.push({
		document: "plan-set",
		question,
		pages: [page],
		figures: [`fig-plan-${(index % 6) + 1}`],
	});
});
for (let i = 0; i < 10; i++) {
	const page = pickPage(800 + i, PLAN.pages);
	// The plan-sheet title block as a small key/value grid — ground truth for
	// table-cell accuracy on drawing title blocks (task T2.10).
	questions.push({
		document: "plan-set",
		question: `Welchen Wert trägt Feld ${i + 1} im Schriftfeld des Planblatts?`,
		pages: [page],
		cells: [{ page, row: (i % 4) + 1, col: (i % 2) + 1 }],
		extraction: {
			expectedTable: [
				["Feld", "Wert"],
				[`Feld ${i + 1}`, `Wert-${(i + 1).toString().padStart(2, "0")}`],
			],
		},
	});
}

const set = {
	version: VERSION,
	description:
		"Synthetic golden set for Document Intelligence v2 evaluation (tasks T0.1, T2.10). " +
		"Four representative document types with 120 questions annotated with expected page, " +
		"figure and table-cell answers, plus ground-truth extraction content (table cells, " +
		"figure labels, BPMN nodes/edges) for the extraction-quality metrics. Content is " +
		"synthetic and contains no confidential material.",
	documents: documents.map((d) => ({ ...d })),
	questions: questions.map((q, index) => ({
		id: `q-${(index + 1).toString().padStart(3, "0")}`,
		document: q.document,
		question: q.question,
		expectedPages: q.pages ?? [],
		expectedFigures: q.figures ?? [],
		expectedCells: q.cells ?? [],
		...(q.extraction ? { extraction: q.extraction } : {}),
	})),
};

// Validate before writing so a broken generator fails loudly.
parseGoldenSet(set);

const outPath = resolve(import.meta.dir, "golden-set.v1.json");
await Bun.write(outPath, `${JSON.stringify(set, null, "\t")}\n`);
console.log(
	`Wrote ${outPath}: ${set.documents.length} documents, ${set.questions.length} questions.`,
);
