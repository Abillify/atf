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
 * The four documents mirror the representative set from the design: a
 * requirements specification (DOCX), a process document with BPMN diagrams, a
 * screen/mask document with UI screenshots, and a technical plan set.
 */

import { resolve } from "node:path";
import { parseGoldenSet } from "../golden-set.ts";

// 1.1.0: added ground-truth extraction annotations (expected table content,
// figure labels, BPMN nodes/edges) for the Phase-2 extraction-quality metrics
// (task T2.10). Backward-compatible with 1.0.0 readers — the
// `extraction` field is optional.
// 1.2.0: figure ids now use the extract-contract v1 shape `p<page>-f<n>`.
// The contract parser (packages/extract-contract/src/v1/parse.ts) rewrites
// every other id to a synthetic `p<page>-f<ordinal>`, so ids like `fig-spec-1`
// could never match the figure ids Search stores — figure recall was always
// zero. Annotating with the contract shape keeps golden and indexed ids
// aligned.
// 1.3.0: added 24 unanswerable questions (`abstain: true`, 6 per document) whose
// subject appears nowhere in the corpus. The expected outcome is "no hit"; they
// feed the abstention metrics and are skipped by the recall/MRR metrics and by
// the corpus builder. Backward-compatible: `abstain` is optional.
// 1.4.0: new document ids, references and titles (`requirements-spec`) and
// reworded questions. Pages, figures, cells and the
// question count are unchanged, but retrieval metrics are not comparable with
// 1.3.0: re-ingest a live golden corpus and record a new baseline.
const VERSION = "1.4.0";

interface DocSpec {
	id: string;
	reference: string;
	kind: "docx" | "bpmn" | "ui_mask" | "plan";
	title: string;
	pages: number;
	note: string;
}

const SPEC: DocSpec = {
	id: "requirements-spec",
	reference: "/golden/anforderungsspezifikation.docx",
	kind: "docx",
	title: "Anforderungsspezifikation (synthetisch)",
	pages: 42,
	note: "Synthetic requirements spec: numbered sections, requirement tables, field lists.",
};
const BPMN: DocSpec = {
	id: "process-bpmn",
	reference: "/golden/antragseingang-prozesse.pdf",
	kind: "bpmn",
	title: "Prozessdokumentation mit BPMN (synthetisch)",
	pages: 18,
	note: "Synthetic process manual embedding BPMN diagrams for application intake and objections.",
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
	reference: "/golden/plansatz-gebaeude.pdf",
	kind: "plan",
	title: "Plansatz Gebäude (synthetisch)",
	pages: 12,
	note: "Synthetic plan set: large-format technical drawings with title blocks and legends.",
};

const documents: DocSpec[] = [SPEC, BPMN, MASKS, PLAN];

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
	/** Unanswerable question: expected outcome is "no hit". */
	abstain?: boolean;
}

// Deterministic page picker so questions spread across a document. Always
// returns a page in 1..total (total is a positive integer for every document).
function pickPage(seed: number, total: number): number {
	const x = ((seed * 2654435761) % total) + seed * 37;
	return (((x % total) + total) % total) + 1;
}

// Contract-compliant figure id: `p<page>-f<n>` with a per-document, per-page
// ordinal (the only shape extract-contract v1 preserves verbatim). Each
// question gets its own figure, so the id embeds the page the figure markup
// is emitted on and the ordinal disambiguates figures sharing a page.
const figureOrdinals = new Map<string, number>();
function figureId(docId: string, page: number): string {
	const key = `${docId}:${page}`;
	const ordinal = (figureOrdinals.get(key) ?? 0) + 1;
	figureOrdinals.set(key, ordinal);
	return `p${page}-f${ordinal}`;
}

const questions: QSpec[] = [];

// Requirements spec: 40 questions — mix of page lookups, requirement tables (cells),
// and a few field-list figures.
const wmsTopics = [
	"Welche Anforderung beschreibt die Teilfreigabe im Antragseingang?",
	"Wo ist die Rolle des Teamleiters definiert?",
	"Welche Pflichtfelder hat die Antragseingangsmaske?",
	"Wie wird die Vorgangsverwaltung gefordert?",
	"Welche Anforderung regelt die Rückverfolgbarkeit?",
	"Wo steht die Definition des Begriffs Anmeldung?",
	"Welche Schnittstelle zum ERP wird verlangt?",
	"Welche Anforderung betrifft die Revision?",
	"Wo werden die Berechtigungen beschrieben?",
	"Welche Anforderung nennt die Prüfung der Mengen?",
	"Wie wird die Sperrvermerklogik gefordert?",
	"Welche Anforderung beschreibt die Umverteilung?",
	"Wo ist der Freigabeprozess dokumentiert?",
	"Welche Felder hat die Freigabemaske?",
	"Welche Anforderung regelt die Kennzeichnung?",
	"Wo steht die Fehlerbehandlung bei Buchungen?",
	"Welche Anforderung betrifft die Zusammenstellung?",
	"Wie wird die Vertretungssteuerung beschrieben?",
	"Welche Anforderung nennt die Aktenführung?",
	"Wo ist die Definition der Teilmenge?",
];
wmsTopics.forEach((question, index) => {
	const page = pickPage(index + 1, SPEC.pages);
	questions.push({ document: "requirements-spec", question, pages: [page] });
});
// Requirement-table cell questions for the requirements spec. Each carries the
// ground-truth requirement table so table-cell accuracy can be scored: a small
// header + one requirement row per question (task T2.10).
for (let i = 0; i < 12; i++) {
	const page = pickPage(100 + i, SPEC.pages);
	const code = `A-${(i + 1).toString().padStart(3, "0")}`;
	questions.push({
		document: "requirements-spec",
		question: `Welchen Wert hat Anforderung ${code} in der Anforderungstabelle?`,
		pages: [page],
		cells: [{ page, row: (i % 6) + 2, col: (i % 3) + 2 }],
		extraction: {
			expectedTable: [
				["ID", "Anforderung", "Priorität"],
				[
					code,
					`Anforderung ${code} des Antragseingangs`,
					i % 2 === 0 ? "MUSS" : "SOLL",
				],
			],
		},
	});
}
// Field-list figures in the requirements spec. Each figure is annotated with the field
// labels a correct transcription must surface (label-coverage).
for (let i = 0; i < 8; i++) {
	const page = pickPage(200 + i, SPEC.pages);
	questions.push({
    document: "requirements-spec",
    question: `Welche Feldliste zeigt die Abbildung der Maske M-${i + 1}?`,
    pages: [page],
    figures: [figureId(SPEC.id, page)],
    extraction: {
      expectedLabels: [`Feld ${i + 1}a`, `Feld ${i + 1}b`, "Speichern"],
    },
  });
}

// BPMN document: 30 questions — process/figure heavy.
const bpmnTopics = [
	"Welche Aufgabe folgt auf die Antragseingangsprüfung im Prozess?",
	"Welches Gateway entscheidet über die Teilfreigabe?",
	"Welche Lane bearbeitet die Rücksendung?",
	"Wo beginnt der Antragseingangsprozess?",
	"Welche Aufgabe schließt den Reklamationsprozess ab?",
	"Welche Pools zeigt das BPMN-Diagramm des Antragseingangs?",
	"Welcher Sequenzfluss verbindet Prüfung und Buchung?",
	"Welche Entscheidung trifft der Teamleiter im Prozess?",
	"Welche Aufgabe erzeugt das Antragseingangsprotokoll?",
	"Welches Ereignis startet die Reklamation?",
];
bpmnTopics.forEach((question, index) => {
	const page = pickPage(300 + index, BPMN.pages);
	questions.push({
    document: "process-bpmn",
    question,
    pages: [page],
    figures: [figureId(BPMN.id, page)],
  });
});
for (let i = 0; i < 20; i++) {
	const page = pickPage(400 + i, BPMN.pages);
	// A small synthetic process per sub-diagram: start → task → gateway → end,
	// annotated as ground truth for BPMN node/edge recall (task T2.10).
	const nodes = [
		{ id: `n${i}-start`, label: "Start" },
		{ id: `n${i}-pruefung`, label: "Antragseingangsprüfung" },
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
    figures: [figureId(BPMN.id, page)],
    extraction: { expectedNodes: nodes, expectedEdges: edges },
  });
}

// UI masks: 30 questions — figure and field heavy.
const maskTopics = [
	"Welche Felder hat die Anmeldemaske?",
	"Wo ist die Maske für die Teilfreigabe abgebildet?",
	"Welche Schaltflächen zeigt die Antragseingangsmaske?",
	"Welche Pflichtfelder markiert die Freigabemaske?",
	"Welche Maske zeigt die Vorgangsauswahl?",
	"Wo ist die Suchmaske für Artikel abgebildet?",
	"Welche Felder hat die Revisionsmaske?",
	"Welche Maske zeigt die Umverteilung?",
	"Welche Eingabefelder hat die Reklamationsmaske?",
	"Wo ist die Übersichtsmaske dargestellt?",
];
maskTopics.forEach((question, index) => {
	const page = pickPage(500 + index, MASKS.pages);
	questions.push({
    document: "ui-masks",
    question,
    pages: [page],
    figures: [figureId(MASKS.id, page)],
  });
});
for (let i = 0; i < 20; i++) {
	const page = pickPage(600 + i, MASKS.pages);
	questions.push({
    document: "ui-masks",
    question: `Welches Feldlabel trägt das Eingabefeld ${i + 1} auf dem Screenshot?`,
    pages: [page],
    figures: [figureId(MASKS.id, page)],
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
    figures: [figureId(PLAN.id, page)],
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

// Unanswerable questions (15–20 % of the set): each asks about a subject the
// synthetic corpus never mentions, so the correct system behaviour is to find
// nothing relevant. They stay in the base fixture so the German morphology set
// can re-ask them with other word forms.
const abstainTopics: Record<string, string[]> = {
	"requirements-spec": [
		"Welche Anforderung regelt die Fristenüberwachung für Eilverfahren?",
		"Wo ist die Aufbewahrung von Verschlusssachen der Stufe 3 beschrieben?",
		"Welche Schnittstelle zum Meldesystem der Aufsichtsbehörde wird verlangt?",
		"Wie wird die Geräteverleihung an Subunternehmer abgerechnet?",
		"Welche Anforderung nennt die Sprachsteuerung per Headset?",
		"Wo steht die Regelung zur Drohnenrevision im Archivkeller?",
	],
	"process-bpmn": [
		"Welcher Prozess beschreibt die Entsorgung von Altbatterien?",
		"Wo ist das Verfahren zur Quarantäne bei Schädlingsbefall dokumentiert?",
		"Welche Prozessschritte hat die Reklamation durch Endkunden?",
		"Wie läuft der Nachtschichtwechsel der Pförtner ab?",
		"Welches Diagramm zeigt die Zertifizierung nach Lebensmittelrecht?",
		"Wo ist der Ablauf der Gebäudeevakuierung bei Hochwasser abgebildet?",
	],
	"ui-masks": [
		"Welche Felder hat die Maske zur Besucherregistrierung?",
		"Wo ist der Dialog für die Reifendruckprüfung abgebildet?",
		"Welche Schaltfläche startet den Barcode-Druck auf Aktendeckeln?",
		"Wie sieht die Maske für den Dienstausweis-Antrag aus?",
		"Welche Pflichtfelder hat die Kantinenbestellung?",
		"Wo wird die Dunkelmodus-Einstellung des Handhelds beschrieben?",
	],
	"plan-set": [
		"Welches Planblatt zeigt die Photovoltaikanlage auf dem Dach?",
		"Wo ist die Sprinklerzentrale im Plan eingezeichnet?",
		"Welche Bemaßung hat die Ladestation für Elektrofahrzeuge?",
		"Welcher Plan zeigt die Regenwasserzisterne?",
		"Wo ist der Kranbahnträger im Schnitt dargestellt?",
		"Welche Legende erklärt die Lärmschutzwand am Grundstück?",
	],
};
for (const [document, texts] of Object.entries(abstainTopics)) {
	for (const question of texts) {
		questions.push({ document, question, abstain: true });
	}
}

const set = {
	version: VERSION,
	description:
		"Synthetic golden set for Document Intelligence v2 evaluation (tasks T0.1, T2.10). " +
		"Four representative document types with 120 answerable questions annotated with expected page, " +
		"figure and table-cell answers, 24 unanswerable (abstain) questions, plus ground-truth extraction content (table cells, " +
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
		...(q.abstain ? { abstain: true } : {}),
	})),
};

// Validate before writing so a broken generator fails loudly.
parseGoldenSet(set);

const outPath = resolve(import.meta.dir, "golden-set.v1.json");
await Bun.write(outPath, `${JSON.stringify(set, null, "\t")}\n`);
console.log(
	`Wrote ${outPath}: ${set.documents.length} documents, ${set.questions.length} questions.`,
);
