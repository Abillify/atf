// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Public-tree release guard.
 *
 * Verifies that every file which would ship in a public release is free of
 * structurally forbidden paths and of sensitive literals.
 *
 * Two rule classes exist:
 *
 *   1. Structural rules (in this file). Generic and safe to publish: generated
 *      directories, non-example env files, production-suffixed files, and
 *      private-key blocks.
 *
 *   2. Redaction rules (external). Customer names, personal identifiers, and
 *      internal hostnames are themselves confidential, so they must never live
 *      in a published file. They are loaded from a redaction rule set that is
 *      excluded from the repository.
 *
 * Rule-set resolution order:
 *   - `--rules <path>` argument
 *   - `ATF_REDACTION_RULES` environment variable
 *   - `internal/redaction-rules.json` (the `internal/` prefix is gitignored)
 *
 * When no rule set is found the guard still applies its structural rules and
 * reports that literal redaction was skipped. Pass `--require-rules` (or set
 * `ATF_REDACTION_RULES_REQUIRED=1`) to make a missing rule set a failure; use
 * that mode on the machine that publishes a release.
 *
 * See `scripts/redaction-rules.example.json` for the file format.
 */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const argv = Bun.argv.slice(2);

function argValue(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

const requireRules =
	argv.includes("--require-rules") ||
	process.env.ATF_REDACTION_RULES_REQUIRED === "1";

const rulesPathCandidates = [
	argValue("--rules"),
	process.env.ATF_REDACTION_RULES,
	"internal/redaction-rules.json",
].filter((value): value is string => typeof value === "string" && value !== "");

const allowedEnvName = ".env.example";

const forbiddenGeneratedPath =
	/(^|\/)(?:node_modules|dist|dist-node|\.next|coverage|playwright-report|test-results)(?:\/|$)/i;
const forbiddenRootPath =
	/^(?:live|production|secrets|private|internal|analysis|reports?|semantic-review)(?:\/|$)/i;

interface ContentRule {
	label: string;
	pattern: RegExp;
}

/** Structural content rules. Safe to publish because they match no secret. */
const structuralContentRules: ContentRule[] = [
	{
		label: "private key",
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
	},
	{ label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
	{ label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
	/**
	 * Redaction damage, not a secret — but the most dangerous class of defect
	 * this guard can catch, because it is self-inverting: a placeholder glued
	 * into the middle of an ordinary word tells a reader exactly which literal
	 * was replaced, which is the one thing redaction must never reveal.
	 *
	 * Cause is always the same: a rule whose pattern was a bare literal rather
	 * than a `\b`-anchored one, applied as a substitution across the tree. See
	 * the "Writing patterns" note in `scripts/redaction-rules.example.json`.
	 *
	 * The token list is deliberately short. It covers the placeholders this
	 * project substitutes with, and nothing that reads as an ordinary English
	 * noun — `Placeholder` and `Customer` are excluded precisely because
	 * `resolveContextPlaceholders` and `getCustomer` are legitimate
	 * identifiers, and a guard that cries wolf gets switched off.
	 *
	 * The `[a-z]{3,}` prefix keeps short camelCase identifiers such as
	 * `isExampleFile` out; anything longer that still trips this is either real
	 * damage or an allowlist entry away from being declared intentional.
	 */
	{
		label: "redaction damage",
		pattern: /[a-z]{3,}(?:Example|Redacted|Acme)(?![a-z])/,
	},
];

/**
 * Files that intentionally contain synthetic credential shapes, with the
 * structural labels they are allowed to trip.
 *
 * This lives next to the structural rules rather than in the external rule set:
 * the information is not confidential, and a contributor running the guard
 * without a redaction rule set must not get a false positive.
 */
const structuralAllowlist = new Map<string, Set<string>>([
	[
		"apps/runtime/src/assistants/__tests__/proposal-scanner.test.ts",
		new Set(["private key", "AWS access key id", "GitHub token"]),
	],
]);

interface RedactionRuleSet {
	/** Literal patterns whose presence in a release file is a failure. */
	rules: ContentRule[];
	/** Base file names that must never ship, matched case-insensitively. */
	forbiddenFileNames: Set<string>;
	/** Per-path labels tolerated because the match is a synthetic fixture. */
	allowlist: Map<string, Set<string>>;
	/** Path the rule set was loaded from, or `null` when none was found. */
	source: string | null;
}

interface RedactionRuleFile {
	rules?: {
		label?: string;
		pattern?: string;
		flags?: string;
		testValue?: string;
	}[];
	forbiddenFileNames?: string[];
	allowlist?: Record<string, string[]>;
}

const emptyRuleSet: RedactionRuleSet = {
	rules: [],
	forbiddenFileNames: new Set(),
	allowlist: new Map(),
	source: null,
};

async function loadRedactionRules(): Promise<RedactionRuleSet> {
	for (const candidate of rulesPathCandidates) {
		const path = resolve(root, candidate);
		const file = Bun.file(path);
		if (!(await file.exists())) continue;

		let raw: unknown;
		try {
			raw = await file.json();
		} catch (error) {
			throw new Error(
				`Redaction rule set ${candidate} is not valid JSON: ${(error as Error).message}`,
			);
		}
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(
				`Redaction rule set ${candidate}: root must be a JSON object`,
			);
		}
		const parsed = raw as RedactionRuleFile;
		if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) {
			throw new Error(
				`Redaction rule set ${candidate}: "rules" must be an array`,
			);
		}
		if (
			parsed.forbiddenFileNames !== undefined &&
			(!Array.isArray(parsed.forbiddenFileNames) ||
				!parsed.forbiddenFileNames.every(
					(name) =>
						typeof name === "string" &&
						name.trim() === name &&
						name.length > 0 &&
						!name.includes("\0") &&
						basename(name) === name &&
						name !== "." &&
						name !== "..",
				))
		) {
			throw new Error(
				`Redaction rule set ${candidate}: "forbiddenFileNames" must contain non-empty base file names without surrounding whitespace or path components`,
			);
		}
		if (
			parsed.allowlist !== undefined &&
			(typeof parsed.allowlist !== "object" ||
				parsed.allowlist === null ||
				Array.isArray(parsed.allowlist))
		) {
			throw new Error(
				`Redaction rule set ${candidate}: "allowlist" must be an object`,
			);
		}

		const rules: ContentRule[] = [];
		for (const [index, entry] of (parsed.rules ?? []).entries()) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}] must be an object`,
				);
			}
			if (typeof entry.pattern !== "string" || entry.pattern === "") {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}] is missing a non-empty string "pattern"`,
				);
			}
			if (entry.label !== undefined && typeof entry.label !== "string") {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}].label must be a string`,
				);
			}
			if (entry.flags !== undefined && typeof entry.flags !== "string") {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}].flags must be a string`,
				);
			}
			if (
				entry.testValue !== undefined &&
				typeof entry.testValue !== "string"
			) {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}].testValue must be a string`,
				);
			}
			if (requireRules && entry.testValue === undefined) {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}] needs a "testValue" under --require-rules`,
				);
			}
			const label = entry.label ?? `redaction rule ${index}`;
			let pattern: RegExp;
			try {
				pattern = new RegExp(entry.pattern, entry.flags ?? "i");
			} catch (error) {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}] (${label}) has an invalid pattern: ${(error as Error).message}`,
				);
			}
			if (entry.testValue !== undefined && !pattern.test(entry.testValue)) {
				throw new Error(
					`Redaction rule set ${candidate}: rules[${index}] (${label}) does not match its "testValue"`,
				);
			}
			pattern.lastIndex = 0;
			rules.push({ label, pattern });
		}

		const allowlist = new Map<string, Set<string>>();
		for (const [path_, labels] of Object.entries(parsed.allowlist ?? {})) {
			if (
				!Array.isArray(labels) ||
				!labels.every((label) => typeof label === "string")
			) {
				throw new Error(
					`Redaction rule set ${candidate}: allowlist[${JSON.stringify(path_)}] must be an array of strings`,
				);
			}
			allowlist.set(path_, new Set(labels));
		}

		const forbiddenFileNames = new Set(
			(parsed.forbiddenFileNames ?? []).map((name) => name.toLowerCase()),
		);
		if (requireRules && rules.length === 0 && forbiddenFileNames.size === 0) {
			throw new Error(
				`Redaction rule set ${candidate}: --require-rules needs at least one content rule or forbidden file name`,
			);
		}

		return {
			rules,
			forbiddenFileNames,
			allowlist,
			source: candidate,
		};
	}
	return emptyRuleSet;
}

async function releaseFiles(): Promise<string[]> {
	const result = Bun.spawnSync(
		["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		const detail = result.stderr.toString().trim();
		throw new Error(
			`Unable to enumerate release files${detail ? `: ${detail}` : "."}`,
		);
	}
	const candidates = [
		...new Set(result.stdout.toString().split("\0").filter(Boolean)),
	].sort();
	const existing: string[] = [];
	for (const path of candidates) {
		if (await Bun.file(join(root, path)).exists()) existing.push(path);
	}
	return existing;
}

function checkPath(
	path: string,
	ruleSet: RedactionRuleSet,
	failures: string[],
): void {
	const name = basename(path);
	const lowerName = name.toLowerCase();
	if (forbiddenGeneratedPath.test(path) || forbiddenRootPath.test(path))
		failures.push(`Forbidden path: ${path}`);
	if (
		(name.startsWith(".env") && name !== allowedEnvName) ||
		/\.production\./i.test(name) ||
		ruleSet.forbiddenFileNames.has(lowerName)
	) {
		failures.push(`Forbidden file: ${path}`);
	}
}

async function checkContent(
	path: string,
	ruleSet: RedactionRuleSet,
	failures: string[],
): Promise<void> {
	let data: Buffer;
	try {
		data = await readFile(join(root, path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (data.includes(0)) return;
	const text = data.toString("utf8");
	const allowedLabels = new Set([
		...(structuralAllowlist.get(path) ?? []),
		...(ruleSet.allowlist.get(path) ?? []),
	]);
	for (const { label, pattern } of [
		...structuralContentRules,
		...ruleSet.rules,
	]) {
		if (!allowedLabels.has(label) && pattern.test(text))
			failures.push(`Sensitive content (${label}): ${path}`);
	}
}

const ruleSet = await loadRedactionRules();

if (ruleSet.source === null) {
	const detail = `Checked: ${rulesPathCandidates.join(", ")}`;
	if (requireRules) {
		console.error(
			`No redaction rule set found; literal redaction cannot be verified.\n${detail}`,
		);
		process.exit(1);
	}
	console.warn(
		`Warning: no redaction rule set found. Structural rules were applied; literal redaction was skipped.\n${detail}`,
	);
}

const failures: string[] = [];
const files = await releaseFiles();
for (const path of files) {
	checkPath(path, ruleSet, failures);
	await checkContent(path, ruleSet, failures);
}

if (failures.length > 0) {
	console.error([...new Set(failures)].sort().join("\n"));
	process.exit(1);
}

const scope =
	ruleSet.source === null
		? "structural rules only"
		: `${structuralContentRules.length + ruleSet.rules.length} content rules from ${ruleSet.source}`;
console.log(
	`Public-tree verification passed (${files.length} release files, ${scope}).`,
);
