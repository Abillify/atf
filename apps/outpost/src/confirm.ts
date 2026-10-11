// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Resolution of the user confirmation for suspended deletions (requirements
 * 9.5, 9.11).
 *
 * A confirmation comes from exactly two sources:
 * - the confirm file `<stateDir>/<sourceId>.confirm` (written by
 *   `atf-outpost confirm-deletes <sourceId>`),
 * - the environment variable `OUTPOST_CONFIRM_DELETES=<sourceId>:<hash>` (comma
 *   for several sources).
 *
 * The value is the hash of the candidate set the user has seen. The run only
 * deletes when it exactly matches the current candidate hash (the check
 * happens in `run.ts`). A stored hash from an earlier run never confirms on
 * its own.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "@atf/outpost-core";

/** Path of a source's confirm file. */
export const confirmFilePath = (stateDir: string, sourceId: string): string =>
  join(stateDir, `${sourceId}.confirm`);

/**
 * Parse `OUTPOST_CONFIRM_DELETES=<id>:<hash>[,<id>:<hash>...]`. An entry
 * without a colon or with an empty hash is ignored (fault tolerant; the
 * variable is a convenience path, not a security anchor).
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
 * The candidate set confirmed by the user for a source: the file wins over
 * the env variable (the file is the operator's explicit action).
 * Returns `undefined` when nothing is confirmed. Errors reading the file
 * count as "not confirmed", never as a failure of the run.
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
    // no confirm file: the normal case
  }
  return parseConfirmEnv(env.OUTPOST_CONFIRM_DELETES).get(sourceId);
}
