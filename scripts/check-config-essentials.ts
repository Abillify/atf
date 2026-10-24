// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Drift check for docs/CONFIGURATION-ESSENTIALS.md: every environment variable
 * named in the first column of a table must exist as a row in the generated
 * docs/CONFIGURATION.md. The essentials page is hand-written, so a renamed or
 * removed variable would otherwise silently keep pointing at nothing.
 *
 * Usage: bun run scripts/check-config-essentials.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Extract the backticked names from the first column of Markdown table rows.
 * Only rows whose first cell is a single backticked token count, so prose and
 * example cells never contribute.
 */
export function extractFirstColumnNames(markdown: string): string[] {
	const names: string[] = [];
	for (const line of markdown.split("\n")) {
		const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
		if (match?.[1] !== undefined) names.push(match[1]);
	}
	return names;
}

/**
 * The set of variables that have a table row in the generated configuration
 * reference (`| \`NAME\` | ...`).
 */
export function referenceVariables(markdown: string): Set<string> {
	const found = new Set<string>();
	for (const line of markdown.split("\n")) {
		const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
		if (match?.[1] !== undefined) found.add(match[1]);
	}
	return found;
}

/** Names listed in essentials but absent from the reference, in document order. */
export function findMissing(names: string[], reference: Set<string>): string[] {
	return names.filter((name) => !reference.has(name));
}

function main(): number {
	const essentials = readFileSync(join(ROOT, "docs/CONFIGURATION-ESSENTIALS.md"), "utf8");
	const reference = readFileSync(join(ROOT, "docs/CONFIGURATION.md"), "utf8");
	const names = extractFirstColumnNames(essentials);
	const missing = findMissing(names, referenceVariables(reference));
	if (missing.length > 0) {
		console.error(
			`check:config-essentials failed — ${missing.length} variable(s) listed in ` +
				`docs/CONFIGURATION-ESSENTIALS.md have no row in docs/CONFIGURATION.md:`,
		);
		for (const name of missing) console.error(`  ${name}`);
		return 1;
	}
	console.log(`check:config-essentials passed: ${names.length} listed variables all exist.`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
