// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unknown node `config` key detection (`src/graph/flow-config-keys.ts`)
 *
 * The node type catalog ({@link nodeTypeDoc}, {@link COMMON_CONFIG_FIELDS})
 * lists every top-level `config` key a node handler reads. A key outside that
 * set is a typo or a leftover: the engine keeps it and ignores it, so it
 * silently does nothing. This module reports such keys — with a "did you mean"
 * suggestion — for `cli.ts validate`, `POST /flows/validate` and the loader.
 *
 * Keys starting with {@link ANNOTATION_KEY_PREFIX} are reserved for author
 * annotations and never reported. Types that are not in the catalog (custom
 * plugins) are skipped entirely.
 */

import {
  COMMON_CONFIG_FIELDS,
  nodeTypeDoc,
} from "./node-type-catalog.js";

export interface UnknownConfigKey {
  nodeIndex: number;
  nodeId: string;
  nodeType: string;
  key: string;
  /** Closest known key (Levenshtein distance ≤ 2), when there is one. */
  suggestion?: string;
}

/** Keys an author may add for annotations; never reported. */
export const ANNOTATION_KEY_PREFIX = "x-";

/** Known top-level config keys of `type`, or undefined when the type is not in the catalog (then nothing is reported). */
export function knownConfigKeys(
  type: string,
): ReadonlySet<string> | undefined {
  const doc = nodeTypeDoc(type);
  if (!doc) return undefined;
  return new Set<string>([
    ...COMMON_CONFIG_FIELDS.map((f) => f.key),
    ...doc.config.map((f) => f.key),
  ]);
}

/** Iterative Levenshtein distance, O(n·m). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/** Closest known key within distance 2; smallest distance, alphabetically first on ties. */
function suggestKey(
  key: string,
  known: ReadonlySet<string>,
): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const candidate of [...known].sort()) {
    const dist = levenshtein(key, candidate);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Reports every top-level `config` key a node type does not read. Nodes whose
 * `config` is not a plain object are skipped (the schema validator reports
 * those). Deterministically sorted by `nodeIndex`, then `key`.
 */
export function findUnknownConfigKeys(
  nodes: ReadonlyArray<{ id: string; type: string; config?: unknown }>,
): UnknownConfigKey[] {
  const out: UnknownConfigKey[] = [];
  nodes.forEach((node, nodeIndex) => {
    const config = node.config;
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      return;
    }
    const known = knownConfigKeys(node.type);
    if (known === undefined) return; // unknown node type: nothing to report
    for (const key of Object.keys(config as Record<string, unknown>)) {
      if (known.has(key) || key.startsWith(ANNOTATION_KEY_PREFIX)) continue;
      const suggestion = suggestKey(key, known);
      out.push({
        nodeIndex,
        nodeId: node.id,
        nodeType: node.type,
        key,
        ...(suggestion !== undefined ? { suggestion } : {}),
      });
    }
  });
  out.sort((a, b) =>
    a.nodeIndex !== b.nodeIndex
      ? a.nodeIndex - b.nodeIndex
      : a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0,
  );
  return out;
}

/** Human-readable warning text for one finding. */
export function formatUnknownConfigKey(u: UnknownConfigKey): string {
  const base = `Unknown config key "${u.key}" for node type "${u.nodeType}" — the runtime ignores it.`;
  return u.suggestion ? `${base} Did you mean "${u.suggestion}"?` : base;
}
