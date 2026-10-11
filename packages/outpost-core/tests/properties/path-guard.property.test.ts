// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 14: path confinement
 *
 * **Validates: Requirements 15.5**
 *
 * `guardPath(root, candidate)` accepts exactly when the candidate resolved
 * via `realpath` lies inside the root directory resolved via
 * `realpath`. Tested are `..` segments, absolute
 * paths, mixed separators, Unicode names and symlinks that lead out of the
 * root. `joinWithinRoot` rejects empty, absolute or
 * NUL-containing segments and accepts exactly when the resolved
 * path stays syntactically inside the root.
 */

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardPath, isInsideRoot, joinWithinRoot } from "../../src/index.js";

let tmpDir: string;
let root: string;
let outside: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "outpost-guard-"));
  root = path.join(tmpDir, "root");
  outside = path.join(tmpDir, "outside");
  await mkdir(path.join(root, "docs", "tief"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "a");
  await writeFile(path.join(root, "docs", "b.txt"), "b");
  await writeFile(path.join(root, "docs", "tief", "c-ü.txt"), "c");
  await writeFile(path.join(outside, "secret.txt"), "secret");
  // Symlink inside the root that points outside.
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
  // Symlink to a directory outside the root.
  await symlink(outside, path.join(root, "link-dir"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Independent reference: realpath + path.relative. */
async function referenceInside(candidate: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    const realCandidate = await realpath(candidate);
    const rel = path.relative(realRoot, realCandidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

// Candidates: valid relative paths, with .. detours, escapes, absolute,
// symlinks, mixed separators and Unicode.
const RELATIVE_OK = ["a.txt", "docs/b.txt", "docs/tief/c-ü.txt", "docs", "docs/./b.txt"];
const RELATIVE_VIA_DOTDOT = [
  "docs/../a.txt",
  "docs/tief/../b.txt",
  "docs/tief/../../docs/b.txt",
  "a.txt/../a.txt",
];
const ESCAPES = [
  "../outside/secret.txt",
  "docs/../../outside/secret.txt",
  "../root/a.txt",
  "link-out.txt",
  "link-dir/secret.txt",
  "docs/../link-dir/x.txt",
];

describe("Property 14: path confinement (guardPath)", () => {
  it("accepts exactly when the really resolved path lies inside", async () => {
    const candidates = [
      ...RELATIVE_OK.map((r) => path.join(root, r)),
      ...RELATIVE_VIA_DOTDOT.map((r) => path.join(root, r)),
      ...ESCAPES.map((r) => path.join(root, r)),
      path.join(outside, "secret.txt"),
      outside,
      root,
      path.join(root, "nicht-vorhanden.txt"),
      path.join(root, "docs", "nicht-vorhanden", "x.txt"),
    ];
    for (const candidate of candidates) {
      const result = await guardPath(root, candidate);
      expect(result.ok).toBe(await referenceInside(candidate));
    }
  });

  it("mixed separators: backslash segments do not exist and are rejected", async () => {
    // On POSIX "docs\b.txt" is a single file name, not nested.
    const result = await guardPath(root, path.join(root, "docs\\b.txt"));
    expect(result.ok).toBe(false);
  });

  it("Unicode names inside the root are accepted", async () => {
    const result = await guardPath(root, path.join(root, "docs", "tief", "c-ü.txt"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe(
        await realpath(path.join(root, "docs", "tief", "c-ü.txt")),
      );
    }
  });

  it("symlinks pointing outside are rejected (realpath, not lexical)", async () => {
    const viaFile = await guardPath(root, path.join(root, "link-out.txt"));
    expect(viaFile.ok).toBe(false);
    const viaDir = await guardPath(root, path.join(root, "link-dir", "secret.txt"));
    expect(viaDir.ok).toBe(false);
  });
});

describe("Property 14: joinWithinRoot (rein syntaktisch)", () => {
  it("rejects empty, absolute and NUL segments as well as escapes", () => {
    const bad: string[][] = [
      [""],
      ["/etc/passwd"],
      ["a", "/etc"],
      ["a\0b"],
      [".."],
      ["..", "outside", "secret.txt"],
      ["docs", "..", "..", "outside"],
    ];
    for (const segments of bad) {
      expect(joinWithinRoot(root, ...segments).ok).toBe(false);
    }
  });

  it("accepts exactly when path.resolve stays inside", () => {
    const good: string[][] = [
      ["a.txt"],
      ["docs", "b.txt"],
      ["docs", "tief", "c-ü.txt"],
      ["docs", "..", "b.txt"],
    ];
    for (const segments of good) {
      const result = joinWithinRoot(root, ...segments);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.realPath).toBe(path.resolve(root, ...segments));
      }
    }
  });

  it("isInsideRoot is consistent with path.relative", () => {
    const cases: [string, string, boolean][] = [
      ["/root", "/root/a/b", true],
      ["/root", "/root", true],
      ["/root", "/other", false],
      ["/root", "/root/../other", false],
      ["/root/", "/root/a", true],
    ];
    for (const [r, c, expected] of cases) {
      expect(isInsideRoot(r, c)).toBe(expected);
    }
  });
});
