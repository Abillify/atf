// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Path containment guard.
 *
 * Every path that leaves the source root must resolve — via `realpath` — to
 * a location inside `realpath(root)`. This defeats `..` segments, absolute
 * paths, mixed separators, and symlinks pointing outside the tree. The check
 * happens again at `open` time (TOCTOU is reduced, not eliminated; the
 * source mount is read-only in Docker, 12.4).
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

export type GuardResult = { ok: true; realPath: string } | { ok: false; reason: string };

/** Pure containment test on already-resolved paths. */
export function isInsideRoot(realRoot: string, candidate: string): boolean {
  const relative = path.relative(realRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolve `root` and `candidate` and accept the candidate only when its real
 * path lies inside the real root. A candidate that does not exist (or whose
 * symlink target does not exist) is rejected.
 */
export async function guardPath(root: string, candidate: string): Promise<GuardResult> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "source root not resolvable" };
  }
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    return { ok: false, reason: "candidate path not resolvable" };
  }
  if (!isInsideRoot(realRoot, realCandidate)) {
    return { ok: false, reason: "path escapes the source root" };
  }
  return { ok: true, realPath: realCandidate };
}

/**
 * Build a candidate path from root + relative segments WITHOUT trusting the
 * segments: any absolute segment or `..` that escapes is rejected before any
 * filesystem call.
 */
export function joinWithinRoot(root: string, ...segments: readonly string[]): GuardResult {
  let current = root;
  for (const segment of segments) {
    if (segment === "" || path.isAbsolute(segment) || segment.includes("\0")) {
      return { ok: false, reason: "unsafe path segment" };
    }
    const next = path.resolve(current, segment);
    if (!isInsideRoot(path.resolve(root), next)) {
      return { ok: false, reason: "path escapes the source root" };
    }
    current = next;
  }
  return { ok: true, realPath: current };
}
