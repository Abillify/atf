// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Generates `docs/CONFIGURATION.md` from the configuration sources themselves.
 *
 *   bun run config-reference          # write the document
 *   bun run config-reference:check    # fail if it is out of date
 *
 * A hand-maintained configuration reference drifts immediately: Runtime alone declares
 * hundreds of variables. Deriving the document from the schemas means a new variable shows up
 * in the docs as soon as it exists, and CI fails when someone forgets to regenerate.
 *
 * Sources:
 *   - Runtime: the Zod `EnvSchema` object in `apps/runtime/src/config/schema.ts`.
 *   - Search:  the `Config` interface in `apps/search/src/config.ts`, whose members carry
 *              trailing `// VAR_NAME (default: …)` comments.
 *   - Gate:    `process.env` / `Bun.env` reads in `apps/gate/src`, because Gate takes its
 *              substantive configuration from YAML rather than the environment.
 *   - Control: `process.env` reads in `apps/control/src` plus the deployment-only variables
 *              consumed by Next.js.
 *
 * The parsers are deliberately shallow. They read names, defaults, enums, and optionality —
 * facts that are stable in the source text — and do not attempt to model Zod semantics. When a
 * parser cannot classify an entry it says so in the output rather than guessing.
 *
 * Coverage audit
 * --------------
 * A structured source alone is not enough: Runtime's `EnvSchema` and Search's `Config` are
 * each the *primary* contract, but neither service reads its environment exclusively through
 * one. Subsystems that accept an injectable `env` record for testability — the agent
 * transaction fabric, the Rocket.Chat connect flow — read names that no schema declares, so a
 * generator that trusted the schema alone silently under-reported.
 *
 * Every service is therefore also scanned for raw environment reads, and anything found that
 * the primary parser did not produce is emitted with an explicit "not validated at startup"
 * marker rather than dropped. `NON_CONFIG_NAMES` carries the few names that are genuinely not
 * operator configuration. The effect is that adding an out-of-schema read cannot quietly leave
 * the reference incomplete — it shows up in the document, and `--check` fails in CI until it
 * is regenerated.
 */
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = process.cwd();
const outputPath = resolve(root, "docs/CONFIGURATION.md");
const checkOnly = process.argv.includes("--check");

interface Variable {
	name: string;
	type: string;
	required: boolean;
	default?: string;
	allowed?: string[];
	description?: string;
	/**
	 * True when the variable is read directly rather than through the service's
	 * primary configuration contract, so it is not covered by the startup
	 * validation pass. Rendered as a warning in the Notes column.
	 */
	unvalidated?: boolean;
}

/**
 * Environment names that are read by application code but are not deployment
 * configuration, so they do not belong in an operator-facing reference.
 */
const NON_CONFIG_NAMES = new Set([
	// Set by the runtime itself, not by an operator.
	"BUN_WORKER",
	"NODE_ENV",
	// Test and CI gates. Present in source only to skip suites.
	"CI",
	"RUN_MODEL_INTEGRATION",
]);

interface Section {
	service: string;
	source: string;
	intro: string;
	variables: Variable[];
}

// ---------------------------------------------------------------------------
// Runtime: Zod EnvSchema
// ---------------------------------------------------------------------------

/** Extracts the body of the `z.object({ … })` passed to `EnvSchema`. */
function envSchemaBody(source: string): string {
	const start = source.indexOf("export const EnvSchema");
	if (start === -1) {
		throw new Error(
			"EnvSchema not found in apps/runtime/src/config/schema.ts. The parser in scripts/generate-config-reference.ts needs updating.",
		);
	}
	const open = source.indexOf("z.object({", start);
	if (open === -1)
		throw new Error("EnvSchema is no longer a z.object literal.");

	let depth = 0;
	let index = open + "z.object(".length;
	const bodyStart = index + 1;
	for (; index < source.length; index++) {
		const char = source[index];
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return source.slice(bodyStart, index);
		}
	}
	throw new Error("Unbalanced braces while reading EnvSchema.");
}

/** Collapses a JSDoc block into a single sentence-ish line. */
function cleanDoc(block: string | undefined): string | undefined {
	if (!block) return undefined;
	const text = block
		.replace(/^\s*\/\*\*/, "")
		.replace(/\*\/\s*$/, "")
		.split("\n")
		.map((line) => line.replace(/^\s*\*ID?\s?/, "").replace(/^\s*\*\s?/, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.replace(/`/g, "`")
		.trim();
	return text === "" ? undefined : text;
}

/**
 * Returns the JSDoc block that ends immediately before the end of `text`, or undefined when
 * the text does not end with one. "Immediately" allows only whitespace in between, so a
 * comment that documents an earlier entry is not attributed to this one.
 */
function lastAdjacentDocBlock(text: string): string | undefined {
	const trimmed = text.replace(/\s+$/, "");
	if (!trimmed.endsWith("*/")) return undefined;
	const open = trimmed.lastIndexOf("/**");
	if (open === -1) return undefined;
	// Reject a block that already closed earlier: the last `*/` must be the block's own.
	const candidate = trimmed.slice(open);
	if (candidate.indexOf("*/") !== candidate.length - 2) return undefined;
	return candidate;
}

/** Numeric literals may use `_` separators; string defaults must not be altered. */
function normalizeDefault(raw: string): string {
	const value = raw.replace(/\s+/g, " ").trim();
	const unquoted = value.replace(/^["'`]|["'`]$/g, "");
	if (/^-?[\d_]+(\.[\d_]+)?$/.test(unquoted))
		return unquoted.replaceAll("_", "");
	return unquoted;
}

function parseRuntime(source: string): Variable[] {
	const body = envSchemaBody(source);
	// Top-level keys are indented by exactly one tab or two spaces in this file; match a
	// SCREAMING_SNAKE key followed by a colon at low indentation.
	const keyPattern = /^[\t ]{1,2}([A-Z][A-Z0-9_]*):/gm;
	const matches = [...body.matchAll(keyPattern)];
	const variables: Variable[] = [];

	for (const [index, match] of matches.entries()) {
		const name = match[1];
		const start = match.index ?? 0;
		const end = matches[index + 1]?.index ?? body.length;
		const entry = body.slice(start, end);

		// JSDoc immediately preceding this key, if any. Anchoring a lazy `[\s\S]*?` at the end
		// of the preceding text would still start at the first `/**` in the file and swallow
		// everything up to here, so locate the last block explicitly.
		const preceding = body.slice(0, start);
		const description = cleanDoc(lastAdjacentDocBlock(preceding));

		const defaultMatch = /\.default\(\s*([\s\S]*?)\s*\)/.exec(entry);
		const enumMatch = /z\s*\.\s*enum\(\s*\[([\s\S]*?)\]/.exec(entry);
		const optional = /\.optional\(\)/.test(entry);

		let type = "string";
		if (/z\s*\.\s*coerce\s*\.\s*number|z\s*\.\s*number/.test(entry))
			type = "number";
		else if (/z\s*\.\s*coerce\s*\.\s*boolean|z\s*\.\s*boolean/.test(entry))
			type = "boolean";
		else if (enumMatch) type = "enum";
		else if (/z\s*\.\s*array/.test(entry)) type = "list";
		if (/JSON\.parse/.test(entry)) type = "JSON";
		if (/\.transform\([\s\S]*?boolean/.test(entry)) type = "boolean";
		if (/\.transform\([\s\S]*?string\[\]/.test(entry)) type = "list";

		const allowed = enumMatch
			? enumMatch[1]
					.split(",")
					.map((value) => value.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean)
			: undefined;

		let defaultValue =
			defaultMatch === null ? undefined : normalizeDefault(defaultMatch[1]);
		if (defaultValue !== undefined && defaultValue.length > 60) {
			defaultValue = `${defaultValue.slice(0, 57)}…`;
		}
		// A multi-line arrow or object default is not useful in a table cell.
		if (defaultValue !== undefined && /=>|\{|\[/.test(defaultValue)) {
			defaultValue = "(computed)";
		}

		variables.push({
			name,
			type,
			required: defaultValue === undefined && !optional,
			default: defaultValue,
			allowed,
			description,
		});
	}

	if (variables.length === 0) {
		throw new Error(
			"Parsed zero Runtime variables; the EnvSchema parser is broken.",
		);
	}
	return variables;
}

// ---------------------------------------------------------------------------
// Search: Config interface with trailing comments
// ---------------------------------------------------------------------------

function parseSearch(source: string): Variable[] {
	const start = source.indexOf("export interface Config");
	if (start === -1) {
		throw new Error("Config interface not found in apps/search/src/config.ts.");
	}
	const open = source.indexOf("{", start);
	let depth = 0;
	let end = open;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}") {
			depth--;
			if (depth === 0) {
				end = index;
				break;
			}
		}
	}
	const body = source.slice(open, end);

	// e.g. `embedUrl: string; // EMBED_URL (required)`. Keep every whitespace
	// matcher line-local: `\s` would cross into the following JSDoc and previously
	// misparsed the final `T` in `NODE_ENV` as an environment variable.
	const pattern =
		/^[\t ]*(\w+)\??[\t ]*:[\t ]*([^;\n]+);[\t ]*\/\/[\t ]*([A-Z][A-Z0-9_]*)[\t ]*(?:\(([^)\n]*)\))?/gm;
	const seen = new Set<string>();
	const variables: Variable[] = [];

	for (const match of body.matchAll(pattern)) {
		const [, member, tsType, name, annotation] = match;
		if (seen.has(name)) continue;
		seen.add(name);

		const note = annotation?.trim();
		const defaultMatch = note ? /default:\s*(.+)$/i.exec(note) : null;
		const required = note ? /^required/i.test(note) : false;

		let type = "string";
		if (/number/.test(tsType)) type = "number";
		else if (/boolean/.test(tsType)) type = "boolean";
		else if (/\[\]/.test(tsType)) type = "list";
		else if (/\|/.test(tsType) && /"/.test(tsType)) type = "enum";

		const allowed =
			/\|/.test(tsType) && tsType.includes('"')
				? [...tsType.matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
				: undefined;

		variables.push({
			name,
			type,
			required,
			default: defaultMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
			allowed,
			description: `Config member \`${member}\`${note && !defaultMatch && !required ? ` — ${note}` : ""}`,
		});
	}

	// A small number of members document their environment contract in the
	// adjacent JSDoc instead of a trailing comment (notably NODE_ENV).
	const docPattern =
		/\/\*\*([\s\S]*?)\*\/[\t \r\n]+(\w+)\??[\t ]*:[\t ]*([^;\n]+);/g;
	for (const match of body.matchAll(docPattern)) {
		const [, doc, member, tsType] = match;
		const annotations = [
			...doc.matchAll(
				/\b([A-Z][A-Z0-9_]{2,})[\t ]*\((required|default:[^)]*)\)/g,
			),
		];
		const annotation = annotations.at(-1);
		if (!annotation) continue;
		const [, name, note] = annotation;
		if (seen.has(name)) continue;
		seen.add(name);

		const defaultMatch = /default:\s*(.+)$/i.exec(note);
		let type = "string";
		if (/number/.test(tsType)) type = "number";
		else if (/boolean/.test(tsType)) type = "boolean";
		else if (/\[\]/.test(tsType)) type = "list";

		variables.push({
			name,
			type,
			required: /^required$/i.test(note.trim()),
			default: defaultMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
			description: `Config member \`${member}\``,
		});
	}

	if (variables.length === 0) {
		throw new Error(
			"Parsed zero Search variables; the Config parser is broken.",
		);
	}
	return variables;
}

// ---------------------------------------------------------------------------
// Gate and Control: environment reads
// ---------------------------------------------------------------------------

/** Collects every environment variable name read anywhere under `directories`. */
async function collectEnvNames(directories: string[]): Promise<Set<string>> {
	const names = new Set<string>();
	for (const directory of directories) {
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		for await (const entry of glob.scan({ cwd: resolve(root, directory) })) {
			if (/__tests__|\.test\.|\.spec\./.test(entry)) continue;
			const text = await readFile(resolve(root, directory, entry), "utf8");
			for (const match of text.matchAll(
				/(?:process|Bun)\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g,
			)) {
				names.add(match[1] ?? match[2]);
			}
			// Gate destructures the environment into a local `env` object and reads
			// `env.MCPGATE_…` from there, so matching only `process.env.X` would miss the
			// transaction-enforcement variables. Runtime's transaction subsystem does the
			// same with an injectable `env` record. Requiring a SCREAMING_SNAKE name keeps
			// this from picking up ordinary property access.
			for (const match of text.matchAll(
				/\benv(?:ironment)?\.([A-Z][A-Z0-9_]{2,})\b/g,
			)) {
				names.add(match[1]);
			}
			// Search reads most of its environment through local helpers that take the
			// variable name as a string literal: parseIntEnv("HNSW_M", 16),
			// parseBoolEnv("HYBRID_SEARCH", true), parseCsvEnv("UI_SCOPES"), and so on.
			for (const match of text.matchAll(
				/\b[a-z][A-Za-z]*Env\w*\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
			)) {
				names.add(match[1]);
			}
		}
	}
	for (const name of NON_CONFIG_NAMES) names.delete(name);
	return names;
}

async function parseEnvReads(directories: string[]): Promise<Variable[]> {
	return [...(await collectEnvNames(directories))].sort().map((name) => ({
		name,
		type: "string",
		required: false,
	}));
}

/**
 * Returns the variables read under `directories` that the service's primary
 * parser did not produce, marked as unvalidated.
 *
 * These are real operator-facing settings — they are simply not part of the
 * startup validation pass, which is a fact an operator needs, not one to hide.
 */
async function unvalidatedExtras(
	directories: string[],
	parsed: Variable[],
): Promise<Variable[]> {
	const known = new Set(parsed.map((variable) => variable.name));
	const read = await collectEnvNames(directories);
	return [...read]
		.filter((name) => !known.has(name))
		.sort()
		.map((name) => ({
			name,
			type: "string",
			required: false,
			unvalidated: true,
		}));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTable(variables: Variable[]): string[] {
	const lines = [
		"| Variable | Type | Required | Default | Notes |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const variable of [...variables].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const notes: string[] = [];
		if (variable.allowed?.length) {
			notes.push(
				`one of ${variable.allowed.map((v) => `\`${v}\``).join(", ")}`,
			);
		}
		if (variable.unvalidated) {
			notes.push("**read directly — not validated at startup**");
		}
		if (variable.description) notes.push(variable.description);
		lines.push(
			[
				`\`${variable.name}\``,
				variable.type,
				variable.required ? "**yes**" : "no",
				variable.default === undefined ? "—" : `\`${variable.default}\``,
				notes.join("; ").replaceAll("|", "\\|") || "—",
			]
				.map((cell) => cell.replaceAll("\n", " "))
				.join(" | ")
				.replace(/^/, "| ")
				.concat(" |"),
		);
	}
	return lines;
}

function render(sections: Section[]): string {
	const total = sections.reduce(
		(sum, section) => sum + section.variables.length,
		0,
	);
	const lines = [
		"# Configuration reference",
		"",
		"Generated by `bun run config-reference` from the configuration sources themselves. Do not edit manually.",
		"",
		`Documented variables: **${total}**.`,
		"",
		"Every ATF application is configured entirely through environment variables, except Gate, which reads its tool and policy definitions from YAML in `MCPGATE_CONFIG_DIR`. Runtime validates its `EnvSchema` environment at startup and exits with the complete list of problems rather than failing at first use.",
		"",
		"This table is generated from two passes: the service's primary configuration contract, and a scan of the source for raw environment reads. A variable marked **read directly — not validated at startup** is real configuration that bypasses the startup validation pass, so a malformed value surfaces when the feature first runs instead of at boot. Treat those with extra care in production.",
		"",
		"`Required: yes` means the application will not start without the variable **when the feature that uses it is enabled**. Most features are off by default, so the practical minimum for a local run is much smaller than this table — see `.env.example` files and `deploy/examples/`.",
		"",
		"> Secrets belong in a secret manager, never in a committed file or a ConfigMap. Variables whose names end in `_SECRET`, `_KEY`, `_TOKEN`, or `_PASSWORD` must be treated as such.",
		"",
		"## Contents",
		"",
	];
	for (const section of sections) {
		lines.push(
			`- [${section.service}](#${section.service.toLowerCase().replace(/[^a-z0-9]+/g, "-")}) — ${section.variables.length} variables`,
		);
	}
	for (const section of sections) {
		lines.push(
			"",
			`## ${section.service}`,
			"",
			section.intro,
			"",
			`Source of truth: \`${section.source}\`.`,
			"",
			...renderTable(section.variables),
		);
	}
	lines.push(
		"",
		"## Provider configuration",
		"",
		"Runtime resolves models through **named provider instances**, never through a protocol name. Declare them once in `PROVIDERS`, then reference the instance `name` from every model setting:",
		"",
		"```bash",
		'PROVIDERS=\'[{"name":"eu-openai","protocol":"openai","url":"https://…/v1","apiKey":"…"},',
		'            {"name":"local","protocol":"openai","url":"http://127.0.0.1:1234/v1","local":true}]\'',
		'DEFAULT_LLM=\'{"provider":"eu-openai","model":"a-chat-model"}\'',
		'FALLBACK_LLM=\'{"provider":"local","model":"a-local-model"}\'',
		"```",
		"",
		"Optional provider fields: `url`, `apiKey`, `region`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `resourceName`, `apiVersion`, `local`. Supported `protocol` values are `openai`, `google`, `anthropic`, `azure`, `bedrock`, and `ollama`.",
		"",
		"`local: true` is an explicit operator assertion that the endpoint is trusted and on-premises. It is never inferred from the URL, because a private-looking hostname is not evidence of a private network.",
		"",
		"Runtime walks the whole parsed environment for `{ provider, model }` shapes and validates every reference at startup, so a typo in any model setting fails the boot rather than the first request that happens to use it.",
		"",
		"Per-protocol variables such as `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`, `AZURE_*`, `BEDROCK_*`, and `ANTHROPIC_API_KEY` are **not** Runtime configuration. They remain in use only by the standalone smoke scripts under `apps/runtime/scripts/` and by model integration tests, which talk to providers directly and bypass the provider registry on purpose.",
		"",
		"## Profiles",
		"",
		"`PROFILE` applies a curated bundle of defaults before validation. Explicit variables always win over a profile. Available profiles: `dev`, `secure`, `regulated`, `regulated-multitenant`, `performance`. See `apps/runtime/src/config/profiles.ts`.",
		"",
		"A profile is a starting point, not a compliance statement. `regulated` sets stricter defaults; it does not make a deployment compliant on its own.",
		"",
		"## Production gate",
		"",
		"With `APP_ENV=production`, Runtime refuses to start under unsafe settings — open CORS, unverified JWTs, an unauthenticated monitoring or metrics endpoint, and similar. See `apps/runtime/src/config/prod-gate.ts` and [DEPLOYMENT.md](../DEPLOYMENT.md).",
		"",
	);
	return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runtimeSource = await readFile(
	resolve(root, "apps/runtime/src/config/schema.ts"),
	"utf8",
);
const searchSource = await readFile(
	resolve(root, "apps/search/src/config.ts"),
	"utf8",
);

const runtimeParsed = parseRuntime(runtimeSource);
const searchParsed = parseSearch(searchSource);

const sections: Section[] = [
	{
		service: "Runtime",
		source: "apps/runtime/src/config/schema.ts",
		intro:
			"Orchestration, guardrails, policy, approvals, cost control, and the operator API. Everything declared in `EnvSchema` is parsed and validated as a whole at startup. A small number of variables listed below are read directly by subsystems that accept an injectable environment record; those are flagged in the Notes column and are validated where they are used rather than at boot.",
		variables: [
			...runtimeParsed,
			...(await unvalidatedExtras(["apps/runtime/src"], runtimeParsed)),
		],
	},
	{
		service: "Search",
		source: "apps/search/src/config.ts",
		intro:
			"Retrieval, ingestion, chunking, embedding, and reranking. Search has its own environment contract and does not share Runtime's variables even where names coincide. Entries flagged in the Notes column are read by `loadConfig` without a corresponding `Config` member, so they do not appear in the typed configuration object.",
		variables: [
			...searchParsed,
			...(await unvalidatedExtras(["apps/search/src"], searchParsed)),
		],
	},
	{
		service: "Gate",
		source: "apps/gate/src (environment reads)",
		intro:
			"Gate's substantive configuration — tools, backends, scopes, policies — lives in YAML under `MCPGATE_CONFIG_DIR`. The environment covers only process-level concerns, so this table is short by design. See `deploy/examples/gate/config.yaml` for the YAML shape.",
		variables: await parseEnvReads(["apps/gate/src"]),
	},
	{
		service: "Control",
		source:
			"apps/control/src (environment reads) and apps/control/next.config.ts",
		intro:
			"Control uses Runtime's HTTP API and SSE stream. Relative same-origin Runtime URLs are the production default; the deployment must provide the reverse-proxy routing because Control has no internal API rewrite. `NEXT_PUBLIC_BACKEND_URL` is an explicit development or cross-origin override frozen into the browser bundle at build time.",
		variables: [
			...(await parseEnvReads(["apps/control/src"])),
			{
				name: "CONTROL_CSP_MODE",
				type: "enum",
				required: false,
				default: "legacy",
				allowed: ["legacy", "report-only"],
				description:
					"Read by `next.config.ts`. `legacy` emits no CSP header; `report-only` emits only `Content-Security-Policy-Report-Only`. Control never emits an enforcement CSP header",
			},
		],
	},
];

const expected = render(sections);

if (checkOnly) {
	let actual = "";
	try {
		actual = await readFile(outputPath, "utf8");
	} catch {
		console.error(`Missing generated artifact: ${relative(root, outputPath)}`);
		process.exit(1);
	}
	if (actual !== expected) {
		console.error(
			`Stale generated artifact: ${relative(root, outputPath)} (run bun run config-reference)`,
		);
		process.exit(1);
	}
	console.log(
		`Verified ${relative(root, outputPath)} for ${sections.reduce((sum, s) => sum + s.variables.length, 0)} variables.`,
	);
} else {
	await Bun.write(outputPath, expected);
	console.log(
		`Generated ${relative(root, outputPath)} for ${sections.reduce((sum, s) => sum + s.variables.length, 0)} variables across ${sections.length} services.`,
	);
}
