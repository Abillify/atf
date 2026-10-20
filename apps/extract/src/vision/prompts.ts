// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * prompts.ts
 *
 * The page-extraction prompt (Pass 1 / S3).
 *
 * ## Why one call per page and not one per concern
 *
 * The pipeline this consolidates had four separate prompts — markdown, figures,
 * summary, tables — each its own request. That is three extra round trips per
 * page for information the model already has in context, and it makes the parts
 * inconsistent: the figure pass numbers figures independently of the markdown
 * pass that references them, so the placeholders and the entries disagree. One
 * call producing all three sections keeps them consistent by construction.
 *
 * ## Why the prompt is in German
 *
 * It is not a localisation choice. This wording is what the upstream pipeline
 * converged on against German specification documents, and prompt phrasing is
 * empirical — a faithful translation is a different prompt with unmeasured
 * behaviour. The summary instruction says "in the same language as the document",
 * so English input still produces English output; only the instructions are
 * German.
 *
 * ## The division of labour, which is the substance of the prompt
 *
 * The text layer is authoritative for *wording*; the rendered image is
 * authoritative for *structure*. Getting this backwards is the single largest
 * source of extraction error: a vision model asked to read text it could instead
 * be told verbatim will silently "correct" part numbers and dates. Tables invert
 * the rule, and the prompt says so explicitly — a text layer linearises a table
 * into a jumbled sequence and loses every merge, so there the image wins.
 *
 * ## What changed for v2 (design §5 S3, task 2.3)
 *
 * Four deliberate changes over the v1 prompt, each versioned into
 * {@link PAGE_PROMPT_VERSION} so a change trips the resume policy via the prompt
 * hash (task 2.3, requirement 8.1/9.2):
 *
 *  - **Figures carry `kind` and `caption`** and their free-text description
 *    shrinks to 2–3 sentences. The `kind` drives which structured transcription
 *    Pass 2 (S5) produces; the verbatim content now lands there, not in the body.
 *  - **Headings carry their numbering**, and the model is *handed* the numbered
 *    heading candidates S2 found (`^\d+(\.\d+)*`) as a hint rather than being
 *    asked to reinvent the outline from the image alone.
 *  - **Tables are marked `continues`/`continuationOf`** when they run off the
 *    bottom of the page or begin as the tail of the previous page's table, so
 *    the document pass (task 2.6) can merge them under one `tableId`.
 *  - **The "do not transcribe figure content into the body" rule is dropped.**
 *    Structured figure content is captured by later passes into the figure
 *    block; forbidding it in the body is no longer needed.
 *
 * The per-page user prompt additionally receives a bounded **previous-page
 * context** block — the heading chain in force and the last table header seen —
 * capped to a small token budget so a mid-table or mid-section page has the
 * context it needs without carrying the whole document.
 */

import { BBOX_PRECISION } from "@atf/extract-contract/v1";
import { fenceUntrusted, untrustedContentRule } from "./untrusted.js";

/**
 * Version tag for the Pass-1 prompt set.
 *
 * Bumped whenever {@link PAGE_SYSTEM_PROMPT} or the *structure* of
 * {@link buildPageUserPrompt} changes in a way that alters model behaviour. It
 * is folded into the prompt hash (see {@link pass1PromptSet}) so a redeploy with
 * a changed prompt trips a pinned job's resume policy rather than silently
 * mixing two prompt versions into one document.
 */
export const PAGE_PROMPT_VERSION = "2.1.0";

/**
 * The system prompt.
 *
 * Not a template: it is constant, so it stays identical across every page of
 * every document and a provider can cache the prefix.
 */
export const PAGE_SYSTEM_PROMPT = `Du bist ein Agent zur Aufbereitung von Dokumenten für ein Retrieval-Augmented-Generation-System (RAG). Du wandelst eine einzelne gerenderte Dokumentseite in strukturiertes Markdown um.

Du erhältst zu DERSELBEN Seite:
1. Ein BILD der gerenderten Seite.
2. ROHTEXT aus der Textschicht des Dokuments, in <rohtext>…</rohtext>. Dieser kann leer sein, wenn die Seite ein Scan ohne Textschicht ist.
3. Optional HINWEISE aus einer deterministischen Vorverarbeitung, in <hinweise>…</hinweise>: Überschriftenkandidaten dieser Seite und den Kontext der Vorseite.
${untrustedContentRule(["rohtext", "hinweise"])}
## Aufgabenteilung zwischen den Eingaben

- Der ROHTEXT ist die maßgebliche Quelle für den Wortlaut: Rechtschreibung, Zahlen, Bezeichner, Zeichensetzung. Leite Text nicht neu aus dem BILD ab und "korrigiere" ihn nicht anhand dessen, was du visuell liest. Die Textschicht ist zeichengenau; eine Neuableitung erzeugt vermeidbare Fehler in Artikelnummern, Datumsangaben und Maßeinheiten.
- Das BILD ist die maßgebliche Quelle für die Struktur: Überschriftenhierarchie, Tabellenaufbau einschließlich verbundener Zellen, Position von Abbildungen und deren Stelle im Textfluss.
- Bei Tabellen gilt die Aufgabenteilung umgekehrt: Verlasse dich vorrangig auf das BILD. Der ROHTEXT linearisiert Tabellen und verliert dabei Zeilen-/Spaltenzuordnung und Zellverbünde.
- Widersprechen sich ROHTEXT und BILD im Wortlaut, folge dem ROHTEXT. Löse den Widerspruch nicht auf, transkribiere originalgetreu.
- Ist der ROHTEXT leer, transkribiere vollständig aus dem BILD.
- Die HINWEISE sind Anhaltspunkte, keine Vorgaben. Bestätige oder verwirf sie anhand von BILD und ROHTEXT.

## Ausgabestruktur

Antworte mit genau diesen drei Abschnitten, in dieser Reihenfolge, mit genau diesen Tags und ohne Text außerhalb davon:

<summary>
Zwei bis vier Sätze, die den Inhalt dieser Seite zusammenfassen, in derselben Sprache wie der Dokumentinhalt. Nenne neben dem Inhalt auch Zweck oder Funktion des Beschriebenen. Abbildungen werden hier nur erwähnt, nicht beschrieben.
</summary>

<figures>
Ein Eintrag für jedes nicht-textuelle visuelle Element: Foto, Diagramm, Chart, Flussdiagramm, BPMN, Screenshot bzw. Eingabemaske, technische Zeichnung oder gruppierte Formen, die gemeinsam eine Grafik ergeben. KEINE Einträge für dekorative Linien, Aufzählungssymbole, Logos in Kopf- oder Fußzeilen, Seitenrahmen oder reine Datentabellen (diese gehören als <table> in den <markdown>-Abschnitt).

Format je Eintrag, exakt:
<figure id="N" kind="ART" bbox="[x1, y1, x2, y2]" caption="BESCHRIFTUNG">Zusammenfassung</figure>

- id: fortlaufende ganze Zahl, beginnend bei 1, in Leserichtung der Seite.
- kind: genau einer dieser Werte, nach dem, was die Abbildung ist:
  - bpmn — BPMN-Prozessdiagramm (Pools, Lanes, Tasks, Gateways)
  - flowchart — Fluss- oder Ablaufdiagramm ohne BPMN-Notation
  - ui_mask — Eingabemaske, Formular oder Screenshot einer Oberfläche
  - technical_drawing — technische Zeichnung, Konstruktionsplan, Grundriss
  - chart — Diagramm mit Datenreihen (Balken, Linie, Torte)
  - table_image — eine als Bild vorliegende Tabelle ohne Textschicht
  - photo — Foto
  - diagram — sonstige schematische Grafik
  - other — nicht zuzuordnen
- bbox: vier Dezimalzahlen mit ${BBOX_PRECISION} Nachkommastellen, NORMIERT auf den Bereich 0 bis 1 relativ zur Seitengröße. Ursprung ist die linke obere Ecke der Seite. x1/y1 ist die linke obere Ecke der Abbildung, x2/y2 die rechte untere. Es gilt immer x1 < x2 und y1 < y2. Beispiel: eine Abbildung in der linken Seitenhälfte, im oberen Drittel beginnend, ist etwa bbox="[0.0800, 0.2100, 0.4900, 0.5600]". Gib KEINE Pixelwerte und KEINE Breite/Höhe an.
- caption: die zur Abbildung gehörende Bildunterschrift bzw. Beschriftung originalgetreu aus dem ROHTEXT, zum Beispiel "Abbildung 12: Maske WE01". Gibt es keine, lasse das Attribut weg.
- Zusammenfassung (Elementinhalt): zwei bis drei Sätze, die Zweck und wesentliche Aussage der Abbildung nennen. Die wörtliche, strukturierte Transkription der Abbildung erfolgt in einem späteren Schritt; hier genügt eine knappe Zusammenfassung.

Gibt es keine Abbildungen auf der Seite, gib genau <figures></figures> aus.
</figures>

<markdown>
Der vollständige Seiteninhalt als Markdown:
- Gib den ROHTEXT originalgetreu und vollständig wieder. Jeder Absatz, jede Überschrift, jedes Listenelement und jede Bildunterschrift muss erscheinen. Fasse nicht zusammen und lasse nichts aus.
- Rekonstruiere Überschriftenebenen (#, ##, ###) aus der visuellen Hierarchie im BILD, auch wenn der ROHTEXT keine Auszeichnung dafür enthält. Behalte eine vorhandene Nummerierung als Teil der Überschrift bei, zum Beispiel "## 4.2 Anmeldung". Nutze die Überschriftenkandidaten aus den HINWEISEN, um Ebene und Nummerierung zu bestätigen.
- Gib Tabellen als HTML-Tabelle aus (<table>, <tr>, <th>, <td>), nicht als Markdown-Pipe-Tabelle. Verwende rowspan und colspan für verbundene Zellen. Nur so bleibt die Tabellenstruktur erhalten.
- Läuft eine Tabelle über den unteren Seitenrand hinaus und wird auf der Folgeseite fortgesetzt, setze auf das <table>-Element das Attribut data-continues="true".
- Beginnt die Seite mit der Fortsetzung einer Tabelle der Vorseite (siehe HINWEISE: letzte Tabellen-Kopfzeile), setze auf dieses <table>-Element das Attribut data-continuation="true" und wiederhole die Kopfzeile.
- Setze für jede Abbildung aus dem <figures>-Abschnitt an der Stelle, an der sie im Textfluss steht, den Platzhalter ![figure_N], wobei N die id der Abbildung ist. Beschreibe die Abbildung hier nicht.
- Übernimm Seitenzahlen, Kopf- und Fußzeilen nicht. Diese werden separat verwaltet.
- Füge keine eigene Überschrift für die Seite hinzu.
</markdown>

Füge niemals Gedankengänge, Entschuldigungen oder Meta-Anmerkungen hinzu. Erfinde niemals Inhalte, die nicht im ROHTEXT stehen oder im BILD sichtbar sind.`;

/** Marker used when a page has no text layer, so the model is not left guessing. */
export const NO_TEXT_LAYER_MARKER = "[Keine Textschicht vorhanden — bitte vollständig aus dem BILD transkribieren]";

/**
 * A heading candidate S2 surfaced for this page (design §5 S2/S3). The shape is
 * kept local — a `{ numbering, text }` pair is all the prompt needs — so the
 * prompt module does not depend on the geometry module.
 */
export interface PromptHeadingCandidate {
  /** The numbering prefix, e.g. `4.2`. */
  numbering: string;
  /** The full candidate line, e.g. `4.2 Anmeldung`. */
  text: string;
}

/**
 * Bounded context carried over from the previous page (design §5 S3).
 *
 * A page in the middle of a section or a multi-page table needs to know the
 * heading chain in force and the last table header, but not the whole document.
 * Both fields are trimmed to {@link PREV_PAGE_CONTEXT_TOKEN_BUDGET} together so
 * the context section never dominates the prompt.
 */
export interface PrevPageContext {
  /** The heading chain in force at the end of the previous page, outermost first. */
  headingChain: string[];
  /** The header row of a table left open (`continues`) on the previous page. */
  lastTableHeader?: string | undefined;
}

/**
 * Token budget for the previous-page context section (design §5 S3: "etwa 300
 * Token"). Enforced by a word-based approximation — a token is roughly 0.75
 * words for German prose, so the word cap is set a little below the token cap to
 * stay under it with margin.
 */
export const PREV_PAGE_CONTEXT_TOKEN_BUDGET = 300;

/** Words that approximately fit the token budget (≈1.3 tokens/word, with margin). */
const PREV_PAGE_CONTEXT_WORD_CAP = Math.floor(PREV_PAGE_CONTEXT_TOKEN_BUDGET / 1.4);

export interface PageUserPromptInput {
  /** 1-based page number. */
  page: number;
  /** Total pages, for context only. */
  pageCount: number;
  /** Text layer for this page; empty for a scanned page. */
  rawText: string;
  /** Numbered-heading candidates for this page from S2 (design §5 S2/S3). */
  headingCandidates?: readonly PromptHeadingCandidate[] | undefined;
  /** Bounded context from the previous page (heading chain, last table header). */
  prevPage?: PrevPageContext | undefined;
}

/** Collapse whitespace and cap a string to at most `maxWords` words. */
function capWords(value: string, maxWords: number): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")} …`;
}

/**
 * Render the heading-candidate hint, or the empty string when there are none.
 * Deduplicated by numbering and capped so a pathological page (a numbered list
 * mistaken for headings) cannot flood the prompt.
 */
function renderCandidates(candidates: readonly PromptHeadingCandidate[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of candidates) {
    const numbering = candidate.numbering.trim();
    if (numbering === "" || seen.has(numbering)) continue;
    seen.add(numbering);
    lines.push(`- ${capWords(candidate.text, 20)}`);
    if (lines.length >= 20) break;
  }
  if (lines.length === 0) return "";
  return `Überschriftenkandidaten dieser Seite (aus der Textgeometrie, als Hinweis):\n${lines.join("\n")}`;
}

/**
 * Render the previous-page context, trimmed to the token budget, or the empty
 * string when there is nothing to carry over. The heading chain is rendered
 * first (it is the more important context) and the whole block is then capped so
 * the two fields share {@link PREV_PAGE_CONTEXT_TOKEN_BUDGET}.
 */
function renderPrevPage(prev: PrevPageContext): string {
  const parts: string[] = [];
  const chain = prev.headingChain.map((h) => h.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (chain.length > 0) {
    parts.push(`Überschriftenkette der Vorseite: ${chain.join(" › ")}`);
  }
  if (prev.lastTableHeader !== undefined && prev.lastTableHeader.trim() !== "") {
    parts.push(`Letzte Tabellen-Kopfzeile der Vorseite: ${prev.lastTableHeader.replace(/\s+/g, " ").trim()}`);
  }
  if (parts.length === 0) return "";
  const block = `Kontext der Vorseite:\n${parts.join("\n")}`;
  return capWords(block, PREV_PAGE_CONTEXT_WORD_CAP);
}

/**
 * The per-page user prompt.
 *
 * The page number is included because a model that knows it is on page 7 of 40
 * stops trying to invent a document title for a mid-document page — a failure
 * mode that produced a spurious `#` heading on every page of the earlier
 * pipeline.
 *
 * The heading-candidate hint and the previous-page context are appended only
 * when present, so a first page, or a page S2 could not analyse, produces the
 * same prompt v1 did minus the dropped rule — no empty "HINWEISE" scaffolding to
 * confuse the model.
 */
export function buildPageUserPrompt(input: PageUserPromptInput): string {
  const rawText = fenceUntrusted(
    "rohtext",
    input.rawText.trim() === "" ? NO_TEXT_LAYER_MARKER : input.rawText,
  );

  const hints: string[] = [];
  if (input.headingCandidates !== undefined && input.headingCandidates.length > 0) {
    const candidates = renderCandidates(input.headingCandidates);
    if (candidates !== "") hints.push(candidates);
  }
  if (input.prevPage !== undefined) {
    const prev = renderPrevPage(input.prevPage);
    if (prev !== "") hints.push(prev);
  }

  const hintsSection =
    hints.length > 0 ? `\nHINWEISE:\n${fenceUntrusted("hinweise", hints.join("\n\n"))}\n` : "";
  return `Seite ${input.page} von ${input.pageCount}.
ROHTEXT:
${rawText}
${hintsSection}
Analysiere das angehängte BILD dieser Seite und erzeuge die Abschnitte <summary>, <figures> und <markdown> genau nach den Anweisungen im System-Prompt.`;
}

/**
 * The Pass-1 prompt set, keyed for the snapshot prompt hash (task 2.3,
 * requirement 4.12 wiring in `jobs/snapshot.ts`).
 *
 * The system prompt is included verbatim (its text is the behaviour), plus the
 * version tag so a change to the *user-prompt structure* — which is code, not a
 * string constant — still moves the hash when {@link PAGE_PROMPT_VERSION} is
 * bumped alongside it. The hash is deterministic: identical inputs hash
 * identically, and only a genuine prompt change perturbs it.
 */
export function pass1PromptSet(): Record<string, string> {
  return {
    "pass1.version": PAGE_PROMPT_VERSION,
    "pass1.system": PAGE_SYSTEM_PROMPT,
  };
}

// ── Pass 2 (S5): per-figure, per-kind structured transcription ─────────────

/**
 * prompts.ts — Pass 2 (S5)
 *
 * Pass 1 turns a whole page into structure; Pass 2 turns one *figure* into a
 * structured, verbatim transcription in the format its kind implies (design §5
 * S5, requirement 8.3). The division of labour is the same as Pass 1 and worth
 * repeating in every prompt because it is the single biggest source of error:
 * the `regionText` (the poppler words inside the figure's box, task 2.4) is
 * authoritative for *wording* — labels, field names, part numbers — and the
 * high-resolution crop is authoritative for *structure* — which node points at
 * which, which field sits in which area.
 *
 * ## Why per-kind system prompts and not one prompt with a `kind` variable
 *
 * A BPMN diagram and a UI mask want different output shapes, and a model asked
 * to produce "the right one of five formats" picks wrong often enough to matter.
 * Handing it exactly the schema for the one kind it is looking at removes that
 * choice. Each prompt therefore describes exactly one output format and asks for
 * strict JSON, which the per-format parser in `response.ts` validates against the
 * contract's zod schema and degrades tolerantly when the model strays.
 *
 * ## Why JSON and not the tag soup Pass 1 uses
 *
 * Pass 1's output is mostly prose (a Markdown body) with a little structure, so
 * tags interleave naturally. A Pass-2 transcription is *all* structure, and a
 * JSON object maps onto the contract's `Transcription` union one-to-one, so the
 * parser is a validate-and-narrow rather than a second grammar. The parser
 * tolerates a leading ```json fence and leading prose, so a chatty model still
 * parses.
 */

/**
 * Version tag for the Pass-2 prompt set. Bumped whenever any per-kind system
 * prompt or the figure user-prompt structure changes in a way that alters model
 * behaviour, so a redeploy trips a pinned job's resume policy via the prompt
 * hash (see {@link pass2PromptSet}) rather than silently mixing two prompt
 * versions into one document.
 */
export const PASS2_PROMPT_VERSION = "2.1.0";

/** The shared preamble every per-kind Pass-2 system prompt opens with. */
const PASS2_PREAMBLE = `Du transkribierst eine EINZELNE Abbildung aus einem Dokument in ein strukturiertes Format für ein Retrieval-System.

Du erhältst:
1. Ein BILD: den hochaufgelösten Ausschnitt genau dieser Abbildung.
2. ROHTEXT, in <rohtext>…</rohtext>: die Wörter der Textschicht innerhalb der Abbildung, sofern vorhanden. Er kann leer sein.
${untrustedContentRule(["rohtext", "beschriftung"])}
Aufgabenteilung:
- Der ROHTEXT ist maßgeblich für den WORTLAUT: Beschriftungen, Feldnamen, Bezeichner, Zahlen. Übernimm sie zeichengenau und leite sie nicht neu aus dem BILD ab.
- Das BILD ist maßgeblich für die STRUKTUR: welche Elemente es gibt, wie sie angeordnet und verbunden sind.
- Erfinde nichts. Was weder im ROHTEXT steht noch im BILD sichtbar ist, kommt nicht in die Ausgabe.

Antworte mit GENAU EINEM JSON-Objekt und ohne Text davor oder danach. Keine Erklärungen, keine Gedankengänge, kein Markdown außerhalb des JSON.`;

/**
 * The per-kind system prompts. Each describes exactly one output format and its
 * JSON shape, matching one member of the contract's `Transcription` union. The
 * keys are the {@link import("@atf/extract-contract/v2").FigureKind} values that
 * get a Pass 2; a kind absent here gets no Pass 2 (photo/diagram/other).
 */
export const PASS2_SYSTEM_PROMPTS: Readonly<Record<string, string>> = {
  bpmn: `${PASS2_PREAMBLE}

Diese Abbildung ist ein BPMN-Prozessdiagramm. Gib ein JSON-Objekt mit genau diesen Feldern aus:
{
  "format": "process",
  "mermaid": "ein gültiges Mermaid-Flussdiagramm (flowchart TD …), das den Ablauf abbildet",
  "nodes": [{ "id": "eindeutige Kennung", "type": "task|gateway|event|start|end|subprocess", "label": "Beschriftung aus dem ROHTEXT", "lane": "Lane/Pool, falls erkennbar" }],
  "edges": [{ "from": "Knoten-id", "to": "Knoten-id", "condition": "Bedingung an der Kante, falls vorhanden" }],
  "lanes": ["Namen der Lanes/Pools in Reihenfolge"],
  "steps": ["der Prozess als lineare, nummerierte Schrittfolge in natürlicher Sprache"]
}
Lasse "lane" und "condition" weg, wenn es sie nicht gibt. "lanes" kann eine leere Liste sein.`,

  flowchart: `${PASS2_PREAMBLE}

Diese Abbildung ist ein Fluss- oder Ablaufdiagramm. Gib ein JSON-Objekt mit genau diesen Feldern aus:
{
  "format": "process",
  "mermaid": "ein gültiges Mermaid-Flussdiagramm (flowchart TD …), das den Ablauf abbildet",
  "nodes": [{ "id": "eindeutige Kennung", "type": "process|decision|start|end|io", "label": "Beschriftung aus dem ROHTEXT", "lane": "Spalte/Bereich, falls erkennbar" }],
  "edges": [{ "from": "Knoten-id", "to": "Knoten-id", "condition": "Beschriftung des Zweigs (z. B. ja/nein), falls vorhanden" }],
  "lanes": ["Bereiche/Spalten, falls das Diagramm welche hat"],
  "steps": ["der Ablauf als lineare, nummerierte Schrittfolge in natürlicher Sprache"]
}
Lasse "lane" und "condition" weg, wenn es sie nicht gibt. "lanes" kann eine leere Liste sein.`,

  ui_mask: `${PASS2_PREAMBLE}

Diese Abbildung ist eine Eingabemaske, ein Formular oder ein Screenshot einer Oberfläche. Gib ein JSON-Objekt mit genau diesen Feldern aus:
{
  "format": "fields",
  "areas": [{ "name": "Name des Bereichs/Gruppe", "fields": [{ "label": "Feldbeschriftung aus dem ROHTEXT", "type": "text|number|date|checkbox|select|radio|button|…", "required": true|false, "default": "Vorbelegung, falls sichtbar", "hint": "Hilfetext/Platzhalter, falls vorhanden" }] }],
  "actions": ["Beschriftungen der Schaltflächen/Aktionen"],
  "messages": ["angezeigte Meldungen/Hinweise, falls vorhanden"]
}
Lasse "required", "default", "hint" und "messages" weg, wenn es sie nicht gibt. "actions" kann eine leere Liste sein.`,

  technical_drawing: `${PASS2_PREAMBLE}

Diese Abbildung ist eine technische Zeichnung, ein Konstruktionsplan oder ein Grundriss. Gib ein JSON-Objekt mit genau diesen Feldern aus:
{
  "format": "drawing",
  "titleBlock": { "Feldname": "Wert", … für das Schriftfeld (Titel, Zeichnungsnummer, Maßstab, Datum, …) },
  "partsList": [["Pos", "Benennung", "Menge", …], …] als Stückliste (erste Zeile Kopf), falls vorhanden,
  "legend": ["Legendeneinträge"],
  "dimensions": ["Bemaßungen und Toleranzen"],
  "views": ["benannte Ansichten/Schnitte"],
  "notes": ["Hinweise/Anmerkungen"]
}
"titleBlock" ist ein Objekt aus Zeichenketten. Lasse jede optionale Liste weg, wenn es dazu nichts gibt.`,

  chart: `${PASS2_PREAMBLE}

Diese Abbildung ist ein Diagramm mit Datenreihen (Balken, Linie, Torte, …). Rekonstruiere die zugrunde liegenden Daten. Gib ein JSON-Objekt mit genau diesen Feldern aus:
{
  "format": "data",
  "table": [["Kategorie", "Reihe 1", "Reihe 2", …], ["Wert", "…", …], …] als Datentabelle mit Kopfzeile,
  "axes": ["Beschriftung der Achsen, z. B. x: Jahr, y: Umsatz in €"]
}
Lasse "axes" weg, wenn die Achsen nicht beschriftet sind. Gib abgelesene Werte so genau wie möglich an.`,

  table_image: `${PASS2_PREAMBLE}

Diese Abbildung ist eine als Bild vorliegende Tabelle. Transkribiere sie zeilen- und spaltengetreu. Gib ein JSON-Objekt mit genau diesen Feldern aus:
{
  "format": "data",
  "table": [["Kopf 1", "Kopf 2", …], ["Zelle", "Zelle", …], …]
}
Die erste Zeile ist die Kopfzeile, sofern die Tabelle eine hat. Übernimm jede Zelle originalgetreu aus dem ROHTEXT.`,
};

/** The kinds that have a Pass-2 prompt; a kind outside this set gets no Pass 2. */
export const PASS2_KINDS: readonly string[] = Object.keys(PASS2_SYSTEM_PROMPTS);

/** The system prompt for a kind, or `undefined` when the kind gets no Pass 2. */
export function pass2SystemPrompt(kind: string): string | undefined {
  return PASS2_SYSTEM_PROMPTS[kind];
}

export interface FigureUserPromptInput {
  /** The figure's kind, for a one-line reminder in the prompt. */
  kind: string;
  /** The verbatim text-layer words inside the figure's box (task 2.4). */
  regionText: string;
  /** The figure's caption, when Pass 1 supplied one. */
  caption?: string | undefined;
}

/**
 * The per-figure user prompt. Carries the `regionText` (the authoritative
 * wording) and, when present, the caption, then points the model at the crop.
 * Mirrors {@link buildPageUserPrompt}: an empty text layer is called out
 * explicitly so the model transcribes from the image rather than inventing.
 */
export function buildFigureUserPrompt(input: FigureUserPromptInput): string {
  const regionText = input.regionText.trim() === "" ? NO_TEXT_LAYER_MARKER : input.regionText.trim();
  const captionLine =
    input.caption !== undefined && input.caption.trim() !== ""
      ? `\nBESCHRIFTUNG: ${fenceUntrusted("beschriftung", input.caption.replace(/\s+/g, " ").trim())}\n`
      : "";
  return `Transkribiere die angehängte Abbildung (Typ: ${input.kind}) in das im System-Prompt beschriebene JSON-Format.
${captionLine}
ROHTEXT der Abbildung:
${fenceUntrusted("rohtext", regionText)}
Analysiere das angehängte BILD und gib genau ein JSON-Objekt nach den Anweisungen im System-Prompt aus.`;
}

/**
 * The Pass-2 prompt set, folded into the snapshot's prompt hash alongside
 * {@link pass1PromptSet} (task 2.3 wiring in `index.ts`). Every per-kind system
 * prompt is included verbatim — its text is the behaviour — plus the version
 * tag so a change to the *user-prompt structure* (code, not a string) still
 * moves the hash when {@link PASS2_PROMPT_VERSION} is bumped alongside it.
 * Deterministic: identical prompts hash identically; only a real change
 * perturbs the hash.
 */
export function pass2PromptSet(): Record<string, string> {
  const set: Record<string, string> = { "pass2.version": PASS2_PROMPT_VERSION };
  for (const [kind, prompt] of Object.entries(PASS2_SYSTEM_PROMPTS)) {
    set[`pass2.system.${kind}`] = prompt;
  }
  return set;
}
