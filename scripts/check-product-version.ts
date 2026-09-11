// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Product-version guard.
 *
 * The product version is declared in the root `package.json` and then repeated
 * in places that cannot import it: badge URLs, prose, a Zod default, and two MCP
 * client identities. Nothing kept those in step, so releases 0.1.2 and 0.1.3
 * shipped with Search's OpenAPI document and Gate's server identity still
 * announcing 0.1.1 — CI was green because no check compared them.
 *
 * This is that check. Run without arguments to rewrite every occurrence to the
 * root version, or with `--check` to fail instead of writing (what CI does).
 *
 * Deliberately a string sweep rather than a refactor to import the version:
 * a Zod schema default and a badge URL cannot read `package.json` at the point
 * they are written, and making the runtime identities depend on a JSON import
 * would change what the bundlers have to inline. Keeping the duplication and
 * verifying it is the smaller mechanism.
 *
 * Adding a new occurrence? Put it in OCCURRENCES. A `pattern` must capture the
 * version in group 1 so the rewrite can target it precisely.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");

interface Occurrence {
	/** Repository-relative path. */
	file: string;
	/** Must capture exactly the version string in group 1. Global. */
	pattern: RegExp;
	/** What this occurrence is for, used in failure output. */
	label: string;
	/** Expected number of matches; a drift here means the file was restructured. */
	expected: number;
}

/** Every workspace whose package version tracks the product version. */
const WORKSPACE_MANIFESTS = [
	"package.json",
	"apps/control/package.json",
	"apps/extract/package.json",
	"apps/gate/package.json",
	"apps/runtime/package.json",
	"apps/search/package.json",
	"integration/system/package.json",
];

const OCCURRENCES: Occurrence[] = [
	...WORKSPACE_MANIFESTS.map((file) => ({
		file,
		// Every manifest here contains exactly one `"version"` key — its own.
		// Dependency versions are keyed by package name, so they cannot match.
		// The expected-count assertion below fails loudly if that ever changes.
		// No line anchor: several of these manifests are written on one line.
		pattern: /"version"\s*:\s*"(\d+\.\d+\.\d+)"/g,
		label: "package version",
		expected: 1,
	})),
	{
		file: "README.md",
		pattern: /img\.shields\.io\/badge\/release-(\d+\.\d+\.\d+)-orange/g,
		label: "README release badge",
		expected: 1,
	},
	{
		file: "README.md",
		pattern: /alt="Release: (\d+\.\d+\.\d+)"/g,
		label: "README release badge alt text",
		expected: 1,
	},
	{
		file: "README.md",
		pattern: /ATF is at `(\d+\.\d+\.\d+)`/g,
		label: "README project-status line",
		expected: 1,
	},
	{
		file: "SECURITY.md",
		pattern: /Tagged releases, including `v(\d+\.\d+\.\d+)`/g,
		label: "SECURITY.md supported-versions table",
		expected: 1,
	},
	{
		file: "apps/search/src/openapi.ts",
		pattern: /title: "Aiperator Trust Fabric Search",\n\t{0,6} *version: "(\d+\.\d+\.\d+)"/g,
		label: "Search OpenAPI document version",
		expected: 1,
	},
	{
		file: "apps/gate/src/config/schema.ts",
		pattern: /version: z\.string\(\)\.default\("(\d+\.\d+\.\d+)"\)/g,
		label: "Gate MCP server identity default",
		expected: 1,
	},
	{
		file: "apps/gate/src/tools/mcp-proxy-tool.ts",
		pattern: /name: "mcpgate-proxy", version: "(\d+\.\d+\.\d+)"/g,
		label: "Gate MCP proxy client identity",
		expected: 1,
	},
	{
		file: "apps/gate/src/config/mcp-import.ts",
		pattern: /name: "mcpgate-import", version: "(\d+\.\d+\.\d+)"/g,
		label: "Gate MCP import client identity",
		expected: 1,
	},
	{
		file: "apps/gate/test/integration/mcp.test.ts",
		// `serverInfo` on the discovery result and again under `_meta`.
		pattern: /name: "mcpgate", version: "(\d+\.\d+\.\d+)"/g,
		label: "Gate MCP serverInfo expectation",
		expected: 2,
	},
	{
		file: "apps/gate/test/integration/mcp.test.ts",
		// The `service` block, which spreads the same identity over two lines.
		pattern: /name: "mcpgate",\n\s+version: "(\d+\.\d+\.\d+)",\n\s+endpoint:/g,
		label: "Gate MCP service-block expectation",
		expected: 1,
	},
];

const manifest = JSON.parse(
	await readFile(resolve(root, "package.json"), "utf8"),
) as { version?: string };
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("Root package.json has no usable semantic version");
	process.exit(1);
}

const problems: string[] = [];
const rewritten: string[] = [];

// Files are grouped so several occurrences in one file produce one write.
const byFile = new Map<string, Occurrence[]>();
for (const occurrence of OCCURRENCES) {
	const list = byFile.get(occurrence.file) ?? [];
	list.push(occurrence);
	byFile.set(occurrence.file, list);
}

for (const [file, occurrences] of byFile) {
	const path = resolve(root, file);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		problems.push(`${file}: cannot read (occurrence list is stale)`);
		continue;
	}
	let updated = text;
	for (const occurrence of occurrences) {
		const pattern = new RegExp(
			occurrence.pattern.source,
			occurrence.pattern.flags.includes("g")
				? occurrence.pattern.flags
				: `${occurrence.pattern.flags}g`,
		);
		const matches = [...updated.matchAll(pattern)];
		if (occurrence.expected > 0 && matches.length !== occurrence.expected) {
			problems.push(
				`${file}: expected ${occurrence.expected} occurrence(s) of ${occurrence.label}, found ${matches.length} — the file changed shape, update scripts/check-product-version.ts`,
			);
			continue;
		}
		for (const match of matches) {
			const found = match[1];
			if (found === version) continue;
			if (checkOnly) {
				problems.push(
					`${file}: ${occurrence.label} declares ${found}, root package.json declares ${version}`,
				);
			} else {
				// Replace only the captured span, so surrounding text is untouched.
				const start = match.index + match[0].indexOf(found);
				updated = `${updated.slice(0, start)}${version}${updated.slice(start + found.length)}`;
				rewritten.push(`${file}: ${occurrence.label} ${found} → ${version}`);
			}
		}
	}
	if (!checkOnly && updated !== text) await writeFile(path, updated, "utf8");
}

if (problems.length > 0) {
	console.error(
		`Product version is ${version}; ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
	);
	if (checkOnly) console.error("\nRun `bun run version:sync` to fix.");
	process.exit(1);
}

console.log(
	checkOnly
		? `Product version ${version} verified across ${OCCURRENCES.length} declared occurrences.`
		: rewritten.length === 0
			? `Product version ${version} already consistent across ${OCCURRENCES.length} declared occurrences.`
			: `Synchronised to ${version}:\n${rewritten.map((r) => `  - ${r}`).join("\n")}`,
);
