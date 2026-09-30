// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Include/exclude filtering (requirements 1.9, 6.11).
 *
 * Semantics: a path is included when NO exclude pattern matches AND
 * (no include patterns are configured OR at least one include pattern
 * matches). Patterns are globs matched with picomatch; paths always use
 * `/` separators (cloud adapters pass the display path), and dot-files are
 * matchable so `*.txt` also covers `.notes.txt`-style names only when the
 * pattern says so — `dot: true` lets `*` cross leading dots, which matches
 * user expectations for folder filters.
 */

import picomatch from "picomatch";

/** Normalize a path for matching: backslashes become `/`, no leading `./`. */
export function normalizeMatchPath(path: string): string {
  let p = path.replaceAll("\\", "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** Compile a pattern list once; empty/undefined lists match nothing. */
function compile(patterns: readonly string[] | undefined): ((path: string) => boolean) | undefined {
  if (patterns === undefined || patterns.length === 0) return undefined;
  const match = picomatch(patterns as string[], { dot: true });
  return (path: string) => match(normalizeMatchPath(path));
}

/**
 * True when `quellPath` should be synced. Exclude wins over include.
 * Compiled lazily and cached per pattern list identity.
 */
const includeCache = new WeakMap<object, (path: string) => boolean>();
const excludeCache = new WeakMap<object, (path: string) => boolean>();

function matcherFor(
  cache: WeakMap<object, (path: string) => boolean>,
  patterns: readonly string[] | undefined,
): ((path: string) => boolean) | undefined {
  if (patterns === undefined || patterns.length === 0) return undefined;
  const key = patterns as unknown as object;
  let cached = cache.get(key);
  if (cached === undefined) {
    cached = compile(patterns) ?? (() => false);
    cache.set(key, cached);
  }
  return cached;
}

export function isIncluded(
  quellPath: string,
  include?: readonly string[],
  exclude?: readonly string[],
): boolean {
  const excludeMatch = matcherFor(excludeCache, exclude);
  if (excludeMatch?.(quellPath)) return false;
  const includeMatch = matcherFor(includeCache, include);
  if (includeMatch === undefined) return true;
  return includeMatch(quellPath);
}
