// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * figure-kinds.ts
 *
 * The figure-kind vocabulary a caller may filter on. The stored `figure_kind`
 * is one of the contract's kinds (`bpmn`, `flowchart`, `ui_mask`,
 * `technical_drawing`, `chart`, `table_image`, `photo`, `diagram`, `other`).
 * Callers — models above all — also say what a figure *is* in the words of the
 * transcription formats (`process`, `fields`, `drawing`, `data`) or in plain
 * German. An unknown word used to match nothing, and a model then concluded the
 * document had no such figures. So a filter value resolves to the set of stored
 * kinds it names, and a value that names none is rejected with the vocabulary.
 */

import { figureKindSchema } from "@atf/extract-contract";

/** The stored figure kinds. */
export const FIGURE_KINDS: readonly string[] = figureKindSchema.options;

/** Aliases → the stored kinds they cover. */
const ALIASES: Record<string, readonly string[]> = {
  process: ["bpmn", "flowchart"],
  prozess: ["bpmn", "flowchart"],
  workflow: ["bpmn", "flowchart"],
  ablauf: ["bpmn", "flowchart"],
  flow: ["flowchart"],
  fields: ["ui_mask"],
  mask: ["ui_mask"],
  maske: ["ui_mask"],
  screen: ["ui_mask"],
  screenshot: ["ui_mask"],
  ui: ["ui_mask"],
  drawing: ["technical_drawing"],
  zeichnung: ["technical_drawing"],
  plan: ["technical_drawing"],
  data: ["chart"],
  diagramm: ["chart", "diagram"],
  table: ["table_image"],
  tabelle: ["table_image"],
  foto: ["photo"],
  image: ["photo"],
};

/** Every value a filter accepts: the stored kinds plus the aliases. */
export const FIGURE_KIND_FILTER_VALUES: readonly string[] = [
  ...FIGURE_KINDS,
  ...Object.keys(ALIASES),
];

/**
 * The stored kinds a filter value names, or null when it names none. Matching
 * ignores case, surrounding space and `-`/space vs `_`.
 */
export function resolveFigureKinds(value: string): string[] | null {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "") return null;
  if (FIGURE_KINDS.includes(key)) return [key];
  const alias = ALIASES[key];
  return alias ? [...alias] : null;
}

/** The error text for a value that names no figure kind. */
export function unknownFigureKindMessage(value: string): string {
  return (
    `Unknown figure kind "${value}". Use one of: ${FIGURE_KINDS.join(", ")} ` +
    `(aliases: ${Object.keys(ALIASES).join(", ")}).`
  );
}
