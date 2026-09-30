// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 14: Pfad-Eingrenzung
 *
 * **Validates: Requirements 15.5**
 *
 * `guardPath(root, candidate)` akzeptiert genau dann, wenn der per
 * `realpath` aufgelöste Kandidat innerhalb des per `realpath` aufgelösten
 * Wurzelverzeichnisses liegt. Getestet werden `..`-Segmente, absolute
 * Pfade, gemischte Separatoren, Unicode-Namen und Symlinks, die aus der
 * Wurzel herausführen. `joinWithinRoot` lehnt leere, absolute oder
 * NUL-haltige Segmente ab und akzeptiert genau dann, wenn der aufgelöste
 * Pfad syntaktisch innerhalb der Wurzel bleibt.
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
  // Symlink innerhalb der Wurzel, der nach außerhalb zeigt.
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
  // Symlink auf ein Verzeichnis außerhalb der Wurzel.
  await symlink(outside, path.join(root, "link-dir"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Unabhängige Referenz: realpath + path.relative. */
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

// Kandidaten: gültige relative Pfade, mit ..-Umwegen, Escapes, absolut,
// Symlinks, gemischte Separatoren und Unicode.
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

describe("Property 14: Pfad-Eingrenzung (guardPath)", () => {
  it("akzeptiert genau dann, wenn der real aufgelöste Pfad innerhalb liegt", async () => {
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

  it("gemischte Separatoren: Backslash-Segmente existieren nicht und werden abgelehnt", async () => {
    // Auf POSIX ist "docs\b.txt" ein einzelner Dateiname, nicht verschachtelt.
    const result = await guardPath(root, path.join(root, "docs\\b.txt"));
    expect(result.ok).toBe(false);
  });

  it("Unicode-Namen innerhalb der Wurzel werden akzeptiert", async () => {
    const result = await guardPath(root, path.join(root, "docs", "tief", "c-ü.txt"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe(
        await realpath(path.join(root, "docs", "tief", "c-ü.txt")),
      );
    }
  });

  it("Symlinks nach außerhalb werden abgelehnt (realpath, nicht lexikalisch)", async () => {
    const viaFile = await guardPath(root, path.join(root, "link-out.txt"));
    expect(viaFile.ok).toBe(false);
    const viaDir = await guardPath(root, path.join(root, "link-dir", "secret.txt"));
    expect(viaDir.ok).toBe(false);
  });
});

describe("Property 14: joinWithinRoot (rein syntaktisch)", () => {
  it("lehnt leere, absolute und NUL-Segmente sowie Escapes ab", () => {
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

  it("akzeptiert genau dann, wenn path.resolve innerhalb bleibt", () => {
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

  it("isInsideRoot ist konsistent mit path.relative", () => {
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
