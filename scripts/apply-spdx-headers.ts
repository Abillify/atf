// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Applies and verifies SPDX headers on source files.
 *
 *   bun run spdx          # insert missing headers, correct outdated ones
 *   bun run verify:spdx   # fail if any tracked source file lacks a correct header
 *
 * Per-file headers matter for a source-available license: once a file is copied out of the
 * repository the root LICENSE.md no longer travels with it, and Elastic-2.0 requires that
 * licensing notices are not removed or obscured. A machine-readable header is also what
 * license scanners in downstream build pipelines look for.
 *
 * The header is inserted after a shebang and after a directive prologue such as
 * `"use client"`, because both must remain the first executable construct in the file.
 */
import { readFile, writeFile } from "node:fs/promises";

const LICENSE_ID = "Elastic-2.0";
const COPYRIGHT = "2026 Abillify Technology GmbH";

const HEADER_LINES = [
	`// SPDX-License-Identifier: ${LICENSE_ID}`,
	`// SPDX-FileCopyrightText: ${COPYRIGHT}`,
];
const HEADER = `${HEADER_LINES.join("\n")}\n`;

const IDENTIFIER_PATTERN = /^\/\/\s*SPDX-License-Identifier:\s*(.+?)\s*$/m;
const COPYRIGHT_PATTERN = /^\/\/\s*SPDX-FileCopyrightText:\s*(.+?)\s*$/gm;

function copyrightMatches(source: string): RegExpMatchArray[] {
	return [...source.matchAll(COPYRIGHT_PATTERN)];
}

const SOURCE_GLOBS = ["*.ts", "*.tsx"];
const EXCLUDED_PATH =
	/(^|\/)(?:node_modules|dist|dist-node|\.next|coverage|playwright-report|test-results)(?:\/|$)/;

const checkOnly = process.argv.includes("--check");

/** Files whose content is generated or whose header would break a consumer. */
const EXCLUDED_FILES = new Set(["next-env.d.ts"]);

function trackedSourceFiles(): string[] {
	const result = Bun.spawnSync(
		["git", "ls-files", "-z", "--", ...SOURCE_GLOBS],
		{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Unable to list tracked source files: ${result.stderr.toString().trim()}`,
		);
	}
	return result.stdout
		.toString()
		.split("\0")
		.filter(Boolean)
		.filter((path) => !EXCLUDED_PATH.test(path))
		.filter((path) => !EXCLUDED_FILES.has(path.split("/").at(-1) ?? ""))
		.sort();
}

/**
 * Byte offset at which the header may be inserted.
 *
 * Skips a shebang line and a leading directive prologue (`"use client"`,
 * `"use server"`, `"use strict"`), each of which must stay ahead of any other
 * construct in the file.
 */
function insertionOffset(source: string): number {
	let offset = 0;

	if (source.startsWith("#!")) {
		const lineEnd = source.indexOf("\n");
		if (lineEnd === -1) return source.length;
		offset = lineEnd + 1;
	}

	const directive = /^\s*(['"])use (?:client|server|strict)\1\s*;?[ \t]*\r?\n/;
	const match = directive.exec(source.slice(offset));
	if (match) offset += match[0].length;

	return offset;
}

type Outcome = "ok" | "inserted" | "corrected" | "missing" | "wrong";

async function applyHeader(path: string): Promise<Outcome> {
	const source = await readFile(path, "utf8");
	const identifier = IDENTIFIER_PATTERN.exec(source);
	const copyrights = copyrightMatches(source);
	const hasRequiredCopyright = copyrights.some(
		(match) => match[1] === COPYRIGHT,
	);

	if (identifier?.[1] === LICENSE_ID && hasRequiredCopyright) return "ok";

	// Correct only the project license identifier. Existing copyright holders are evidence of
	// file provenance and must never be replaced or removed; add Abillify alongside them.
	if (identifier || copyrights.length > 0) {
		if (checkOnly) return "wrong";
		let updated = source;
		if (identifier) {
			updated = updated.replace(IDENTIFIER_PATTERN, HEADER_LINES[0]);
		} else {
			const firstCopyright = copyrightMatches(updated)[0];
			const index = firstCopyright?.index;
			if (index === undefined) throw new Error(`Unable to locate copyright in ${path}`);
			updated = `${updated.slice(0, index)}${HEADER_LINES[0]}\n${updated.slice(index)}`;
		}

		if (!hasRequiredCopyright) {
			const updatedCopyrights = copyrightMatches(updated);
			const lastCopyright = updatedCopyrights.at(-1);
			const index = lastCopyright?.index;
			if (index === undefined) {
				updated = updated.replace(IDENTIFIER_PATTERN, HEADER_LINES.join("\n"));
			} else {
				const end = index + lastCopyright[0].length;
				updated = `${updated.slice(0, end)}\n${HEADER_LINES[1]}${updated.slice(end)}`;
			}
		}
		await writeFile(path, updated);
		return "corrected";
	}

	if (checkOnly) return "missing";

	const offset = insertionOffset(source);
	const head = source.slice(0, offset);
	const tail = source.slice(offset);
	// Keep exactly one blank line between the header and the following code, but do not add
	// one when the file continues immediately with a blank line of its own.
	const separator = tail.startsWith("\n") ? "" : "\n";
	await writeFile(path, `${head}${HEADER}${separator}${tail}`);
	return "inserted";
}

const files = trackedSourceFiles();
const counts: Record<Outcome, string[]> = {
	ok: [],
	inserted: [],
	corrected: [],
	missing: [],
	wrong: [],
};

for (const path of files) counts[await applyHeader(path)].push(path);

if (checkOnly) {
	const failures = [...counts.missing, ...counts.wrong];
	if (failures.length > 0) {
		console.error(
			`${failures.length} of ${files.length} source files lack a correct SPDX header (run bun run spdx):`,
		);
		for (const path of failures.slice(0, 40)) console.error(`  - ${path}`);
		if (failures.length > 40) {
			console.error(`  … and ${failures.length - 40} more`);
		}
		process.exit(1);
	}
	console.log(`SPDX headers verified on ${files.length} source files.`);
} else {
	console.log(
		`SPDX headers: ${counts.inserted.length} inserted, ${counts.corrected.length} corrected, ${counts.ok.length} already correct (${files.length} files).`,
	);
}
