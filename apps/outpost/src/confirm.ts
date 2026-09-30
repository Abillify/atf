// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Aufloesung der Nutzerbestätigung fuer ausgesetzte Loeschungen (requirements
 * 9.5, 9.11).
 *
 * Eine Bestätigung kommt aus genau zwei Quellen:
 * - der Confirm-Datei `<stateDir>/<sourceId>.confirm` (geschrieben von
 *   `atf-outpost confirm-deletes <sourceId>`),
 * - der Umgebungsvariable `OUTPOST_CONFIRM_DELETES=<sourceId>:<hash>` (Komma
 *   fuer mehrere Quellen).
 *
 * Der Wert ist der Hash der Kandidatenmenge, die der Benutzer gesehen hat.
 * Nur wenn er exakt dem aktuellen Kandidaten-Hash entspricht, loescht der
 * Lauf (die Pruefung passiert in `run.ts`). Ein gespeicherter Hash aus einem
 * frueheren Lauf bestaetigt niemals selbst.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "@atf/outpost-core";

/** Pfad der Confirm-Datei einer Quelle. */
export const confirmFilePath = (stateDir: string, sourceId: string): string =>
  join(stateDir, `${sourceId}.confirm`);

/**
 * Parse `OUTPOST_CONFIRM_DELETES=<id>:<hash>[,<id>:<hash>...]`. Ein Eintrag
 * ohne Doppelpunkt oder mit leerem Hash wird ignoriert (fehlertolerant — die
 * Variable ist ein Convenience-Pfad, kein Sicherheitsanker).
 */
export function parseConfirmEnv(
  value: string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (value === undefined || value === "") return map;
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0 || sep === trimmed.length - 1) continue;
    const id = trimmed.slice(0, sep).trim();
    const hash = trimmed.slice(sep + 1).trim();
    if (id !== "" && hash !== "") map.set(id, hash);
  }
  return map;
}

/**
 * Die vom Benutzer bestaetigte Kandidatenmenge fuer eine Quelle: Datei gewinnt
 * vor der Env-Variable (die Datei ist die explizite Aktion des Operators).
 * Liefert `undefined`, wenn nichts bestaetigt ist. Fehler beim Lesen der
 * Datei zaehlen als "nicht bestaetigt" — nie als Fehler des Laufs.
 */
export async function confirmForSource(
  env: Env,
  stateDir: string,
  sourceId: string,
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<string | undefined> {
  try {
    const raw = await readFileImpl(confirmFilePath(stateDir, sourceId));
    const hash = raw.trim();
    if (hash !== "") return hash;
  } catch {
    // keine Confirm-Datei — normaler Fall
  }
  return parseConfirmEnv(env.OUTPOST_CONFIRM_DELETES).get(sourceId);
}
