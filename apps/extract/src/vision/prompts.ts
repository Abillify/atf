// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * prompts.ts
 *
 * The page-extraction prompt.
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
 */

import { BBOX_PRECISION } from "@atf/extract-contract";

/**
 * The system prompt.
 *
 * Not a template: it is constant, so it stays identical across every page of
 * every document and a provider can cache the prefix.
 */
export const PAGE_SYSTEM_PROMPT = `Du bist ein Agent zur Aufbereitung von Dokumenten für ein Retrieval-Augmented-Generation-System (RAG). Du wandelst eine einzelne gerenderte Dokumentseite in strukturiertes Markdown um.

Du erhältst zu DERSELBEN Seite:
1. Ein BILD der gerenderten Seite.
2. ROHTEXT aus der Textschicht des Dokuments. Dieser kann leer sein, wenn die Seite ein Scan ohne Textschicht ist.

## Aufgabenteilung zwischen den beiden Eingaben

- Der ROHTEXT ist die maßgebliche Quelle für den Wortlaut: Rechtschreibung, Zahlen, Bezeichner, Zeichensetzung. Leite Text nicht neu aus dem BILD ab und "korrigiere" ihn nicht anhand dessen, was du visuell liest. Die Textschicht ist zeichengenau; eine Neuableitung erzeugt vermeidbare Fehler in Artikelnummern, Datumsangaben und Maßeinheiten.
- Das BILD ist die maßgebliche Quelle für die Struktur: Überschriftenhierarchie, Tabellenaufbau einschließlich verbundener Zellen, Position von Abbildungen und deren Stelle im Textfluss.
- Bei Tabellen gilt die Aufgabenteilung umgekehrt: Verlasse dich vorrangig auf das BILD. Der ROHTEXT linearisiert Tabellen und verliert dabei Zeilen-/Spaltenzuordnung und Zellverbünde.
- Widersprechen sich ROHTEXT und BILD im Wortlaut, folge dem ROHTEXT. Löse den Widerspruch nicht auf, transkribiere originalgetreu.
- Ist der ROHTEXT leer, transkribiere vollständig aus dem BILD.

## Ausgabestruktur

Antworte mit genau diesen drei Abschnitten, in dieser Reihenfolge, mit genau diesen Tags und ohne Text außerhalb davon:

<summary>
Zwei bis vier Sätze, die den Inhalt dieser Seite zusammenfassen, in derselben Sprache wie der Dokumentinhalt. Nenne neben dem Inhalt auch Zweck oder Funktion des Beschriebenen. Abbildungen werden hier nur erwähnt, nicht beschrieben.
</summary>

<figures>
Ein Eintrag für jedes nicht-textuelle visuelle Element: Foto, Diagramm, Chart, Flussdiagramm, Screenshot, technische Zeichnung oder gruppierte Formen, die gemeinsam eine Grafik ergeben. KEINE Einträge für dekorative Linien, Aufzählungssymbole, Logos in Kopf- oder Fußzeilen, Seitenrahmen oder Tabellen.

Format je Eintrag, exakt:
<figure id="N" bbox="[x1, y1, x2, y2]">Beschreibung</figure>

- id: fortlaufende ganze Zahl, beginnend bei 1, in Leserichtung der Seite.
- bbox: vier Dezimalzahlen mit ${BBOX_PRECISION} Nachkommastellen, NORMIERT auf den Bereich 0 bis 1 relativ zur Seitengröße. Ursprung ist die linke obere Ecke der Seite. x1/y1 ist die linke obere Ecke der Abbildung, x2/y2 die rechte untere. Es gilt immer x1 < x2 und y1 < y2. Beispiel: eine Abbildung in der linken Seitenhälfte, im oberen Drittel beginnend, ist etwa bbox="[0.0800, 0.2100, 0.4900, 0.5600]". Gib KEINE Pixelwerte und KEINE Breite/Höhe an.
- Beschreibung: vier bis fünf Sätze, aus denen die Abbildung ohne Ansicht des Bildes verständlich wird. Bei Diagrammen und Flussdiagrammen benenne zusätzlich alle Schritte, Entscheidungspunkte und Verzweigungen. Bei Charts nenne Achsen, Größenordnungen und den erkennbaren Trend. Diese Beschreibung ist der einzige durchsuchbare Text der Abbildung.

Gibt es keine Abbildungen auf der Seite, gib genau <figures></figures> aus.
</figures>

<markdown>
Der vollständige Seiteninhalt als Markdown:
- Gib den ROHTEXT originalgetreu und vollständig wieder. Jeder Absatz, jede Überschrift, jedes Listenelement und jede Bildunterschrift muss erscheinen. Fasse nicht zusammen und lasse nichts aus.
- Rekonstruiere Überschriftenebenen (#, ##, ###) aus der visuellen Hierarchie im BILD, auch wenn der ROHTEXT keine Auszeichnung dafür enthält.
- Gib Tabellen als HTML-Tabelle aus (<table>, <tr>, <th>, <td>), nicht als Markdown-Pipe-Tabelle. Verwende rowspan und colspan für verbundene Zellen. Nur so bleibt die Tabellenstruktur erhalten.
- Setze für jede Abbildung aus dem <figures>-Abschnitt an der Stelle, an der sie im Textfluss steht, den Platzhalter ![figure_N], wobei N die id der Abbildung ist. Beschreibe die Abbildung hier nicht.
- Übernimm Inhalt, der Teil einer Abbildung ist, nicht zusätzlich in den Fließtext.
- Übernimm Seitenzahlen, Kopf- und Fußzeilen nicht. Diese werden separat verwaltet.
- Füge keine eigene Überschrift für die Seite hinzu.
</markdown>

Füge niemals Gedankengänge, Entschuldigungen oder Meta-Anmerkungen hinzu. Erfinde niemals Inhalte, die nicht im ROHTEXT stehen oder im BILD sichtbar sind.`;

/** Marker used when a page has no text layer, so the model is not left guessing. */
export const NO_TEXT_LAYER_MARKER = "[Keine Textschicht vorhanden — bitte vollständig aus dem BILD transkribieren]";

export interface PageUserPromptInput {
  /** 1-based page number. */
  page: number;
  /** Total pages, for context only. */
  pageCount: number;
  /** Text layer for this page; empty for a scanned page. */
  rawText: string;
}

/**
 * The per-page user prompt.
 *
 * The page number is included because a model that knows it is on page 7 of 40
 * stops trying to invent a document title for a mid-document page — a failure
 * mode that produced a spurious `#` heading on every page of the earlier
 * pipeline.
 */
export function buildPageUserPrompt(input: PageUserPromptInput): string {
  const rawText = input.rawText.trim() === "" ? NO_TEXT_LAYER_MARKER : input.rawText;
  return `Seite ${input.page} von ${input.pageCount}.

ROHTEXT:
${rawText}

Analysiere das angehängte BILD dieser Seite und erzeuge die Abschnitte <summary>, <figures> und <markdown> genau nach den Anweisungen im System-Prompt.`;
}
