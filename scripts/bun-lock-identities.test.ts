// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterToLocked, isLocked, parseLockedPackages } from "./bun-lock-identities.ts";

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "left-pad": "1.3.0" } },
  },
  "packages": {
    "@atf/security-kit": ["@atf/security-kit@workspace:packages/security-kit"],

    "@scope/pkg": ["@scope/pkg@2.4.1", "", { "dependencies": { "left-pad": "1.3.0" } }, "sha512-aaa"],

    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-bbb"],

    "left-pad/nested": ["left-pad@1.1.0", "", {}, "sha512-ccc"],

    "string-width-cjs": ["string-width@4.2.3", "", {}, "sha512-ddd"],

    "from-git": ["from-git@github:someone/from-git#abc123", {}, "someone-from-git-abc123"],
  }
}
`;

describe("parseLockedPackages", () => {
	const locked = parseLockedPackages(LOCK);

	test("collects registry identities, including scoped, nested and aliased entries", () => {
		expect([...locked.identities].sort()).toEqual([
			"@scope/pkg@2.4.1",
			"left-pad@1.1.0",
			"left-pad@1.3.0",
			"string-width@4.2.3",
		]);
	});

	test("workspace packages are first-party and not listed", () => {
		expect([...locked.identities].some((id) => id.startsWith("@atf/"))).toBe(false);
	});

	test("a git or tarball spec locks the name, not a version", () => {
		expect([...locked.nonRegistryNames]).toEqual(["from-git"]);
		expect(isLocked(locked, "from-git", "0.0.1-whatever")).toBe(true);
	});

	test("ignores entries outside the packages section (workspace dependency ranges)", () => {
		expect(locked.identities.has("left-pad@1.3.0")).toBe(true);
		expect(parseLockedPackages('{ "workspaces": { "": { "x": ["y@1.0.0"] } } }').identities.size).toBe(0);
	});
});

describe("filterToLocked", () => {
	const locked = parseLockedPackages(LOCK);
	const installed = [
		{ name: "left-pad", version: "1.3.0" },
		{ name: "left-pad", version: "9.9.9" }, // orphan: removed from the lock
		{ name: "@scope/pkg", version: "2.4.1" },
		{ name: "orphaned-dep", version: "1.0.0" },
		{ name: "from-git", version: "3.0.0" },
	];

	test("keeps locked packages and counts the orphans", () => {
		const { kept, ignored } = filterToLocked(installed, locked);
		expect(kept.map((p) => `${p.name}@${p.version}`)).toEqual([
			"left-pad@1.3.0",
			"@scope/pkg@2.4.1",
			"from-git@3.0.0",
		]);
		expect(ignored).toBe(2);
	});

	test("nothing is dropped when everything is locked", () => {
		expect(filterToLocked([{ name: "left-pad", version: "1.1.0" }], locked)).toEqual({
			kept: [{ name: "left-pad", version: "1.1.0" }],
			ignored: 0,
		});
	});
});

describe("the repository lockfile", () => {
	test("parses to a plausible set of locked packages", () => {
		const text = readFileSync(join(import.meta.dir, "..", "bun.lock"), "utf8");
		const locked = parseLockedPackages(text);
		expect(locked.identities.size).toBeGreaterThan(500);
		expect([...locked.identities].some((id) => id.startsWith("jose@"))).toBe(true);
	});
});
