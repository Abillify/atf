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
 *   - Outpost: the `ENV_MAP` of `packages/outpost-core/src/config/merge.ts` (each entry
 *              overrides one key of `outpost.yaml`) plus raw environment reads in
 *              `apps/outpost/src` and `packages/outpost-core/src`.
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
import { buildGateConfigReference } from "./generate-gate-config-reference.ts";

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
	// Placeholder in docs/UI strings such as `{{env.NAME}}`.
	"NAME",
]);

/**
 * `FLOW_PUBLIC_*` is an open prefix read by flows, not a fixed set of settings;
 * it has its own section below. Names with it in the source are examples.
 */
const NON_CONFIG_PREFIXES = ["FLOW_PUBLIC_"];

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
 * The leading sentence of a cleaned doc block, for fallback descriptions taken
 * from a neighbouring declaration where the full block would swamp the table.
 */
function leadSentence(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const match = /^(.{20,}?[.!?])(?:\s|$)/.exec(text);
	const sentence = (match?.[1] ?? text).trim();
	return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence;
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

/**
 * Runtime fallback: many `EnvSchema` keys carry no JSDoc, while the `AppConfig`
 * member they are loaded into does. `load.ts` maps each variable onto its member
 * (`member: env.NAME`); for every undocumented variable the member's JSDoc
 * supplies the description.
 */
function withAppConfigDocs(
	variables: Variable[],
	schemaSource: string,
	loadSource: string,
): Variable[] {
	const memberOf = new Map<string, string>();
	for (const [, member, name] of loadSource.matchAll(
		/\b(\w+):\s*env\.([A-Z][A-Z0-9_]*)\b/g,
	)) {
		if (!memberOf.has(name)) memberOf.set(name, member);
	}
	const start = schemaSource.indexOf("export interface AppConfig");
	if (start === -1) return variables;
	const open = schemaSource.indexOf("{", start);
	let depth = 0;
	let end = open;
	for (let index = open; index < schemaSource.length; index++) {
		if (schemaSource[index] === "{") depth++;
		else if (schemaSource[index] === "}" && --depth === 0) {
			end = index;
			break;
		}
	}
	const body = schemaSource.slice(open, end);
	const docOf = new Map<string, string>();
	for (const match of body.matchAll(/^[\t ]{2}(\w+)\??:/gm)) {
		const doc = leadSentence(
			cleanDoc(lastAdjacentDocBlock(body.slice(0, match.index ?? 0))),
		);
		if (doc !== undefined && !docOf.has(match[1])) docOf.set(match[1], doc);
	}
	return variables.map((variable) => {
		if (variable.description) return variable;
		const member = memberOf.get(variable.name);
		const doc = member === undefined ? undefined : docOf.get(member);
		return doc === undefined
			? variable
			: { ...variable, description: `${doc} (\`${member}\`)` };
	});
}

// ---------------------------------------------------------------------------
// Search and Extract: a `Config` interface with trailing comments
//
// Both services follow the same convention — one flat `Config` interface whose
// members carry `// ENV_NAME (default: …)` trailing comments — so one parser
// serves both. `sourcePath` only improves the error message when the convention
// is broken.
// ---------------------------------------------------------------------------

function parseConfigInterface(source: string, sourcePath: string): Variable[] {
  const start = source.indexOf("export interface Config");
  if (start === -1) {
    throw new Error(`Config interface not found in ${sourcePath}.`);
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

  // e.g. `embedUrl: string; // EMBED_URL (required)`. A slash-separated list
  // (`// ATF_PROFILE / NODE_ENV (default: …)`) documents a member that reads
  // several variables in priority order; every name gets its own row.
  // Keep every whitespace matcher line-local: `\s` would cross into the
  // following JSDoc and previously misparsed the final `T` in `NODE_ENV` as an
  // environment variable.
  const pattern =
    /^[\t ]*(\w+)\??[\t ]*:[\t ]*([^;\n]+);[\t ]*\/\/[\t ]*([A-Z][A-Z0-9_]*(?:[\t ]*\/[\t ]*[A-Z][A-Z0-9_]*)*)[\t ]*(?:\(([^)\n]*)\))?/gm;
  const seen = new Set<string>();
  const variables: Variable[] = [];

  for (const match of body.matchAll(pattern)) {
    const [, member, tsType, nameList, annotation] = match;
    const names = nameList.split("/").map((entry) => entry.trim());
    // `// OIDC_* (…)` marks a member that groups a whole block of variables
    // (each listed on its own); it is not a variable itself.
    if (names[0].endsWith("_")) continue;

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

    // The member's own JSDoc, when it has one, says what the variable does;
    // the member name alone does not.
    const doc = leadSentence(
      cleanDoc(lastAdjacentDocBlock(body.slice(0, match.index ?? 0))),
    );
    const extra = note && !defaultMatch && !required ? ` — ${note}` : "";
    names.forEach((name, index) => {
      if (seen.has(name)) return;
      seen.add(name);
      variables.push({
        name,
        type,
        required,
        default: defaultMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
        allowed,
        description:
          index === 0
            ? doc !== undefined
              ? `${doc}${extra} (\`${member}\`)`
              : `Config member \`${member}\`${extra}`
            : `Read only when ${names
                .slice(0, index)
                .map((earlier) => `\`${earlier}\``)
                .join(
                  " and ",
                )} ${index === 1 ? "is" : "are"} unset. (\`${member}\`)`,
      });
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
      // Extract's string accessors are not named after the environment, so the
      // `…Env(` pattern above misses them — and it missed 25 of them silently,
      // which is the failure mode this whole script exists to prevent. They are
      // listed by name rather than matched generically because a generic
      // "identifier called with a SCREAMING_SNAKE literal" pattern also picks up
      // things like push("SOME_CODE") and would fill the reference with noise.
      for (const match of text.matchAll(
        /\b(?:optionalString|requireString|requiredString)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
      )) {
        names.add(match[1]);
      }
      // The shared operational-profile resolver receives the service's own
      // environment variables as a string-literal array
      // (resolveOperationalProfile(env, ["MCPGATE_ENV", "NODE_ENV"])), which none
      // of the patterns above see — without this, Gate's MCPGATE_ENV row would
      // silently vanish from the reference.
      for (const match of text.matchAll(
        /\bresolveOperationalProfile\([\s\S]{0,120}?\[([^\]]*)\]/g,
      )) {
        for (const name of match[1].matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) {
          names.add(name[1]);
        }
      }
    }
	}
	for (const name of NON_CONFIG_NAMES) names.delete(name);
	for (const name of [...names]) {
		if (NON_CONFIG_PREFIXES.some((p) => name.startsWith(p))) names.delete(name);
	}
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
 * Names read through a startup-validating accessor (`parseIntEnv("JOB_CONCURRENCY", …)`,
 * `parseEnumEnv("TRANSACTION_ENFORCEMENT", …)`, …) under `directories`.
 *
 * Such reads belong to the startup validation pass even when no `Config`
 * interface member documents them — the accessor parses and range-checks the
 * value at boot. They therefore must not carry the "read directly — not
 * validated at startup" label.
 */
async function collectValidatedNames(directories: string[]): Promise<Set<string>> {
	const names = new Set<string>();
	for (const directory of directories) {
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		for await (const entry of glob.scan({ cwd: resolve(root, directory) })) {
			if (/__tests__|\.test\.|\.spec\./.test(entry)) continue;
			const text = await readFile(resolve(root, directory, entry), "utf8");
			for (const match of text.matchAll(
				/\bparse[A-Za-z]*Env\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
			)) {
				names.add(match[1]);
			}
		}
	}
	for (const name of NON_CONFIG_NAMES) names.delete(name);
	for (const name of [...names]) {
		if (NON_CONFIG_PREFIXES.some((p) => name.startsWith(p))) names.delete(name);
	}
	return names;
}

/**
 * Returns the variables read under `directories` that the service's primary
 * parser did not produce, marked as unvalidated.
 *
 * These are real operator-facing settings — they are simply not part of the
 * startup validation pass, which is a fact an operator needs, not one to hide.
 *
 * `validated` names the variables that a startup-validating accessor reads
 * (see `collectValidatedNames`); they are listed without the warning because
 * the accessor does check them at boot.
 */
async function unvalidatedExtras(
	directories: string[],
	parsed: Variable[],
	validated?: Set<string>,
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
			unvalidated: validated?.has(name) ? false : true,
		}));
}

/**
 * Outpost: every `OUTPOST_*` entry of the core's `ENV_MAP` (name → config key and
 * value kind), then the names the runtime and the core read directly.
 */
async function parseOutpost(): Promise<Variable[]> {
	const mergeSource = await readFile(
		resolve(root, "packages/outpost-core/src/config/merge.ts"),
		"utf8",
	);
	const kindType: Record<string, string> = {
		string: "string",
		url: "string",
		collection: "string",
		bool: "boolean",
		int: "number",
		number: "number",
		list: "list",
		json: "json",
	};
	const mapped: Variable[] = [];
	for (const entry of mergeSource.matchAll(
		/name:\s*"(OUTPOST_[A-Z0-9_]+)",\s*path:\s*\[([^\]]*)\],\s*kind:\s*"(\w+)"/g,
	)) {
		const key = entry[2]
			.split(",")
			.map((part) => part.trim().replace(/^"|"$/g, ""))
			.filter((part) => part !== "")
			.join(".");
		mapped.push({
			name: entry[1],
			type: kindType[entry[3]] ?? "string",
			required: false,
			description:
				CURATED_DESCRIPTIONS[`Outpost:${entry[1]}`] !== undefined
					? `${CURATED_DESCRIPTIONS[`Outpost:${entry[1]}`]}. Overrides \`${key}\` of \`outpost.yaml\``
					: `Overrides \`${key}\` of \`outpost.yaml\``,
		});
	}
	const extras = await unvalidatedExtras(
		["apps/outpost/src", "packages/outpost-core/src"],
		mapped,
	);
	return [...mapped, ...extras];
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
    "Optional provider fields: `url`, `apiKey`, `region`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `resourceName`, `apiVersion`, `local`, `keepAlive`. Supported `protocol` values are `openai`, `google`, `anthropic`, `azure`, `bedrock`, and `ollama`.",
    "",
    "`local: true` is an explicit operator assertion that the endpoint is trusted and on-premises. It is never inferred from the URL, because a private-looking hostname is not evidence of a private network.",
    "",
    "`LLM_HTTP_KEEP_ALIVE` defaults to `true` (socket reuse, as before); the table shows no default because the value is derived by a transform. `keepAlive: false` (or globally `LLM_HTTP_KEEP_ALIVE=false`) turns off socket reuse for this provider's requests, so every request opens a fresh connection. It applies to the `openai` and `ollama` protocols, which run through the runtime egress guard; other egress traffic (MCP, OIDC, reranker) keeps keep-alive.",
    "",
    "Runtime walks the whole parsed environment for `{ provider, model }` shapes and validates every reference at startup, so a typo in any model setting fails the boot rather than the first request that happens to use it.",
    "",
    "Per-protocol variables such as `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`, `AZURE_*`, `BEDROCK_*`, and `ANTHROPIC_API_KEY` are **not** Runtime configuration. They remain in use only by the standalone smoke scripts under `apps/runtime/scripts/` and by model integration tests, which talk to providers directly and bypass the provider registry on purpose.",
    "",
    "## Flow-readable environment values",
    "",
    "Flow variables can read environment values as `{{env.FLOW_PUBLIC_<NAME>}}`, but **only** variables whose name starts with `FLOW_PUBLIC_`; every other variable stays invisible to flows. The values end up in prompts, tool arguments, and traces, so they reach model providers, operators, and logs. Never give a secret this prefix. Runtime reads them when a flow's variables are evaluated, so they are not validated at startup. See `apps/runtime/src/graph/flow-parser/flow-constants.ts`.",
    "",
    "```bash",
    "FLOW_PUBLIC_ENVIRONMENT=staging",
    "FLOW_PUBLIC_ORGANIZATION=Example Ltd",
    "```",
    "",
    "Values shared by all flows that are not deployment-specific belong in `FLOWS_DIR/constants.yaml` (`{{const.<name>}}`) instead, where they are versioned with the flows.",
    "",
    "## Profiles",
    "",
    "`ATF_PRESET` applies a curated bundle of defaults before validation. Explicit variables always win over a preset. Available presets: `dev`, `secure`, `regulated`, `regulated-multitenant`, `performance`. See `apps/runtime/src/config/profiles.ts`. `PROFILE` is a deprecated alias of `ATF_PRESET` (same values); setting both to different values stops startup.",
    "",
    "A profile is a starting point, not a compliance statement. `regulated` sets stricter defaults; it does not make a deployment compliant on its own.",
    "",
    "## Production gate",
    "",
    "With the operational profile set to `production`, a service refuses to start under unsafe settings — open CORS, unverified JWTs, an unauthenticated monitoring or metrics endpoint, and similar. See `apps/runtime/src/config/prod-gate.ts` and [DEPLOYMENT.md](../DEPLOYMENT.md).",
    "",
    "Every service (Runtime, Gate, Search, Extract) resolves its profile the same way through `@atf/security-kit` (`packages/security-kit/src/prod-gate/profile.ts`): the platform-wide `ATF_PROFILE` wins over the service variable (`APP_ENV`, `MCPGATE_ENV`, `NODE_ENV`); unset means `development`. The value set is closed (`development`, `staging`, `production`, `test`) and an unknown value aborts startup — a typo like `prod` can no longer silently disable the gates. `staging` runs the checks in warn mode: findings are reported, startup continues. `ATF_PROFILE` is unrelated to Runtime's `ATF_PRESET` preset variable above.",
    "",
  );
	return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Main

// ---------------------------------------------------------------------------
// Curated descriptions
//
// Variables read directly from the environment (Gate, Control, the
// out-of-schema reads) and `Config` members without JSDoc have no description
// in their source. These entries fill the gap, security-relevant ones first.
// A key `Service:NAME` wins over a plain `NAME`, which covers the access-control
// block Search and Extract deliberately share. Prefer a JSDoc at the source
// where a structured contract exists; this table is for the rest.
// ---------------------------------------------------------------------------

const CURATED_DESCRIPTIONS: Record<string, string> = {
  // Shared access control (Search, Extract)
  AUTHN_MODE:
    "API authentication: `disabled`, `token` (API_TOKEN), `oidc` (API_OIDC_ISSUERS) or `token_or_oidc`. Inferred from what is configured when unset; a mode without its credentials fails startup",
  AUTHZ_ENABLED:
    "Enforce scope-based authorization on the API (canonical switch; replaces AUTHZ_ENFORCEMENT). Default `false`",
  AUTHZ_ENFORCEMENT:
    "Legacy form of AUTHZ_ENABLED (`off`/`required`); `optional` is refused unless AUTHZ_ENABLED is set explicitly",
  TENANT_ISOLATION_ENABLED:
    "Scope every request to the caller's tenant (from the token) instead of the single default tenant. Default `false`",
  DEFAULT_TENANT_ID:
    "Tenant used for callers whose credential carries none (service token, single-tenant deployments). Default `default`",
  API_SERVICE_TENANT_ID:
    "Legacy alias of DEFAULT_TENANT_ID for service-token callers; must match it when both are set",
  API_OIDC_DEFAULT_TENANT_ID:
    "Legacy alias of DEFAULT_TENANT_ID for OIDC callers; must match API_SERVICE_TENANT_ID when both are set",
  API_SERVICE_SCOPES:
    "Scopes granted to the static API_TOKEN caller (comma- or space-separated) when AUTHZ_ENABLED is on",
  API_OIDC_ISSUERS:
    'JSON array of trusted API token issuers, `[{"issuer": "https://…", "audience": "optional"}]`; tokens are verified against each issuer\'s JWKS',
  ACL_REQUIRE_IDENTITY:
    "SECURITY: refuse searches that carry no user identity instead of applying no row-level ACL filter. Default `false`",
  ACL_REQUIRE_IDENTITY_WAIVER:
    "Documented reason for running with ACL_REQUIRE_IDENTITY=false; the production check asks for it",
  DOCUMENT_ACL_DEFAULT:
    "Visibility of a document without ACL entries: `allow` (default, visible to everyone in the tenant) or `deny` (visible to nobody)",
  OIDC_ISSUER:
    "OIDC issuer URL for the built-in web UI login (authorization-code flow); enables the OIDC block below",
  OIDC_CLIENT_ID: "OIDC client id of the web UI login",
  OIDC_CLIENT_SECRET: "SECRET. OIDC client secret of the web UI login",
  OIDC_REDIRECT_URI: "Callback URL registered at the IdP for the web UI login",
  OIDC_SCOPES:
    "Scopes requested by the web UI login. Default `openid profile email`",
  OIDC_SESSION_SECRET:
    "SECRET (≥ 16 characters). HMAC key of the web UI session cookie; rotating it ends all sessions",
  OIDC_SESSION_TTL:
    "Web UI session lifetime in seconds (≥ 60). Default 28800 (8 h)",
  OIDC_ALLOWED_EMAILS:
    "Comma-separated e-mail addresses allowed to log in to the web UI; empty allows any authenticated user unless a domain or group list applies",
  OIDC_ALLOWED_EMAIL_DOMAINS:
    "Comma-separated e-mail domains allowed to log in to the web UI",
  OIDC_GROUPS_CLAIM:
    "ID-token claim holding the user's groups (for UI_ALLOWED_GROUPS). Default `groups`",
  UI_ALLOWED_GROUPS:
    "Groups allowed to use the web UI; empty allows any user that passed the e-mail checks",
  UI_SCOPES: "Scopes granted to web UI sessions",
  UI_TENANT_ID: "Tenant of web UI sessions. Default DEFAULT_TENANT_ID",
  TLS_KEY_FILE:
    "SECRET. Private key (PEM) of the HTTPS listener; with TLS_CERT_FILE switches the server to TLS",
  TLS_CLIENT_CA_FILE:
    "CA bundle (PEM) for verifying client certificates (mTLS) on the HTTPS listener",
  TRUST_PROXY:
    "Trust `X-Forwarded-*` from a reverse proxy (client IP for rate limits, HTTPS detection for Secure cookies). Default `false`; enable only behind a proxy that sets them",
  RATE_LIMIT: "Requests per minute per client IP; `0` disables. Default 120",
  "Search:TRANSACTION_HS256_SECRET":
    "SECRET. HS256 key for verifying agent transaction tokens (TRANSACTION_ENFORCEMENT). A shared secret: every holder can also mint tokens, so prefer TRANSACTION_JWKS_URI",
  "Search:TRANSACTION_JWKS_URI":
    "The issuer's public keys (the Runtime serves `/.well-known/atf-transaction-jwks.json`) for ES256/EdDSA transaction tokens; no shared secret needed (ADR-0035)",
  "Search:TRANSACTION_ALGORITHMS":
    "Accepted transaction-token algorithms, any of `HS256`, `ES256`, `EdDSA`. Default: `HS256` when the secret is set, plus `ES256` and `EdDSA` when the JWKS URI is set, so a migration accepts both until HS256 is dropped",
  "Search:TRANSACTION_ISSUER":
    "Expected issuer of agent transaction tokens. Default `vectorsearch-client`",
  "Search:TRANSACTION_AUDIENCE":
    "Expected audience of agent transaction tokens. Default `vectorsearch`",
  "Search:CONVERTER_TOKEN":
    "SECRET. Bearer token Search sends to the document converter (Extract) on `/ingest-file`",
  "Search:CONVERTER_CA_CERT_FILE":
    "CA bundle (PEM) for verifying the converter's TLS certificate",
  // Extract
  "Extract:API_TOKEN":
    "SECRET. Static bearer token for the Extract API (AUTHN_MODE=token)",
  "Extract:MONITOR_TOKEN":
    "SECRET. Token for the Extract monitoring UI login; without it (and without OIDC) the UI is not protected by a login",
  "Extract:SEARCH_TOKEN":
    "SECRET. Bearer token Extract sends to Search when it forwards results to `/v1/ingest`",
  "Extract:SEARCH_CA_CERT_FILE":
    "CA bundle (PEM) for verifying Search's TLS certificate",
  "Extract:SUMMARY_API_KEY": "SECRET. API key of the summary LLM endpoint",
  // Gate (process-level environment; substantive config is YAML)
  "Gate:AUTHN_MODE":
    "Overrides `auth.mode` from YAML: `disabled`, `token` (static tokens), `oidc` or `token_or_oidc`",
  "Gate:AUTHZ_ENABLED":
    "Overrides `authorization.enabled` (scope checks on tools). Canonical name; conflicts with AUTHORIZATION_ENABLED fail startup",
  "Gate:AUTHORIZATION_ENABLED": "Legacy alias of AUTHZ_ENABLED",
  "Gate:DEFAULT_TENANT_ID":
    "Overrides `tenantIsolation.defaultTenantId`: tenant for callers whose token carries none",
  "Gate:TENANT_ISOLATION_DEFAULT_TENANT_ID":
    "Legacy alias of DEFAULT_TENANT_ID; must match it when both are set",
  "Gate:TENANT_ISOLATION_ENABLED":
    "Overrides `tenantIsolation.enabled`: scope database tools to the caller's tenant",
  "Gate:TENANT_ISOLATION_CLAIM_NAMES":
    "Comma-separated token claims read for the caller's tenant (first present wins)",
  "Gate:TENANT_ISOLATION_ISOLATED_DATABASES":
    "Comma-separated database names whose tools are tenant-isolated",
  "Gate:TENANT_ISOLATION_SQL_VALIDATION_MODE":
    "`report` logs SQL that may escape the tenant filter, `strict` refuses it",
  "Gate:MCP_SCHEMA_COMPATIBILITY_MODE":
    "`report` logs incompatible tool schema changes, `strict` refuses them",
  "Gate:MCPGATE_APPROVAL_SECRET":
    "SECRET. HMAC key for approval tokens when `approval.secret` is not set in YAML; without either, no approval token validates",
  "Gate:MCPGATE_AUTH_ADDITIONAL_OIDC_ISSUER":
    "Additional trusted OIDC issuer; set together with …_JWKS_URI and …_AUDIENCE",
  "Gate:MCPGATE_AUTH_ADDITIONAL_OIDC_JWKS_URI":
    "JWKS of the additional OIDC issuer",
  "Gate:MCPGATE_AUTH_ADDITIONAL_OIDC_AUDIENCE":
    "Required audience for tokens of the additional OIDC issuer",
  "Gate:MCPGATE_CONFIG_DIR":
    "Directory with the YAML configuration. Default `./config`",
  "Gate:MCPGATE_DEBUG_HEARTBEAT":
    "`0` disables the 2-second debug heartbeat log line (memory/uptime)",
  "Gate:MCPGATE_ENV":
    "Environment name for the production check. The platform-wide `ATF_PROFILE` wins over it; falls back to NODE_ENV, then `development`. Unknown values abort startup",
  "Gate:MCPGATE_LOG_JSON": "`1` writes JSON log lines",
  "Gate:MCPGATE_LOG_LEVEL": "`debug` additionally logs database tool SQL",
  "Gate:MCPGATE_LOG_REDACT":
    "SECURITY: `0` turns off redaction of sensitive fields in log context — local debugging only",
  "Gate:MCPGATE_REPLICAS":
    "Replica count, for the production check that redeemed approval tokens are shared (Redis) when more than one replica runs. Default 1",
  "Gate:MCPGATE_TRANSACTION_ENFORCEMENT":
    "Agent transaction tokens on tool calls: `off` (default), `optional` (verified when present) or `required`",
  "Gate:MCPGATE_TRANSACTION_HS256_SECRET":
    "SECRET. HS256 key for verifying agent transaction tokens",
  "Gate:MCPGATE_TRANSACTION_JWKS_URI":
    "JWKS for verifying asymmetrically signed agent transaction tokens",
  "Gate:MCPGATE_TRANSACTION_ALGORITHMS":
    "Accepted transaction token algorithms (HS256, RS256, ES256, EdDSA). Default: HS256 when the secret is set, plus RS256/ES256/EdDSA when the JWKS URI is set, so a migration accepts both",
  "Gate:MCPGATE_TRANSACTION_ISSUER":
    "Expected issuer of agent transaction tokens",
  "Gate:MCPGATE_TRANSACTION_AUDIENCE":
    "Expected audience of agent transaction tokens. Give each Gate its own and map it on the Runtime with AGENT_TRANSACTION_AUDIENCES (ADR-0035)",
  "Gate:MCPGATE_TRANSACTION_USER_CLAIMS":
    "Claims read for the user of a transaction. Default `sub`",
  "Gate:MCPGATE_TRANSACTION_TENANT_CLAIMS":
    "Claims read for the tenant of a transaction. Default `tenant,tid,client_id`",
  "Gate:MCPGATE_TRANSACTION_GROUP_CLAIMS":
    "Claims read for the groups of a transaction. Default `groups`",
  "Gate:MCPGATE_TRANSACTION_SESSION_CLAIMS":
    "Claims read for the session of a transaction. Default `sid,session_id`",
  "Gate:MCPGATE_TRANSACTION_REDIS_URL":
    "Redis for transaction replay protection across replicas; in-memory per replica without it",
  "Gate:MCPGATE_TRANSACTION_REDIS_PREFIX":
    "Key prefix in that Redis. Default `mcpgate:transaction:`",
  "Gate:PUBLIC_URL": "Public base URL announced in the OpenAPI document",
  // Outpost (Docker runtime and desktop sidecar)
  "Outpost:OUTPOST_ALLOW_INSECURE_LOCALHOST":
    "Allows plaintext `http://` for an Extract URL on `localhost` or `127.0.0.1`. For local development only: the token and the documents cross that connection unencrypted. Every other `http://` URL stays refused",
  "Outpost:OUTPOST_CA_CERT_PATH":
    "PEM file with an additional certificate authority for the TLS connections (private CA); `rejectUnauthorized` is never turned off",
  "Outpost:OUTPOST_API_TOKEN":
    "SECRET. Static bearer token for Extract. Wins over the client-credentials flow and the interactive device login. Supplied through the environment or the secrets file",
  "Outpost:OUTPOST_CLIENT_SECRET":
    "SECRET. OIDC client secret for the client-credentials flow (`OUTPOST_OIDC_*`); not written to disk when it comes from the environment. Supplied through the environment or the secrets file",
  "Outpost:OUTPOST_GDRIVE_CLIENT_SECRET":
    "SECRET. OAuth client secret of the Google Drive source login (pairs with `OUTPOST_GDRIVE_CLIENT_ID`)",
  "Outpost:OUTPOST_CONFIG_FILE":
    "Path of the configuration file; default `/config/outpost.yaml` (optional: without a file the environment alone configures the Outpost)",
  "Outpost:OUTPOST_DATA_DIR":
    "State and credential directory (sync state, tokens); default `/data`. Must be persistent and private to the Outpost",
  "Outpost:OUTPOST_CREDENTIAL_DIRS":
    "Comma-separated extra directories searched for credential files (service-account keys, secrets files)",
  "Outpost:OUTPOST_CONFIRM_DELETES":
    "`<sourceId>:<hash>[,…]`. Confirms one specific over-threshold delete set (see `OUTPOST_DELETE_THRESHOLD_PERCENT`): the hash names the set that was reported, so a different set is not deleted by an old confirmation",
  "Outpost:OUTPOST_LOG_LEVEL": "Log level; default `info`",
  "Outpost:OUTPOST_DROPBOX_APP_KEY": "Dropbox app key of the source login",
  "Outpost:OUTPOST_GDRIVE_CLIENT_ID": "Google OAuth client id of the source login",
  "Gate:TRUST_PROXY":
    "Overrides `server.trustProxy`: `true`, `false` or a trusted proxy hop count",
  // Runtime: read directly by subsystems with an injectable environment
  "Runtime:AGENT_TRANSACTION_SECRET":
    "SECRET. HS256 key the Runtime signs agent transaction tokens with (alternatively TRANSACTION_SIGNING_ALG/TRANSACTION_SIGNING_KEY)",
  "Runtime:AGENT_TRANSACTION_ISSUER":
    "Issuer of the agent transaction tokens the Runtime mints. Default `aiperator`",
  "Runtime:AGENT_TRANSACTION_AUDIENCE":
    "Default audience of minted agent transaction tokens",
  "Runtime:AGENT_TRANSACTION_AUDIENCES":
    "JSON object mapping MCP server names to the audience their transaction tokens carry",
  "Runtime:AGENT_TRANSACTION_SCOPE_CLAIMS":
    "Claims copied into transaction tokens as scopes",
  "Runtime:AGENT_TRANSACTION_ENFORCEMENT":
    "Agent transaction protocol per MCP call: `off`, `optional` or `required` (a server that does not advertise it fails the call)",
  "Runtime:ROCKETCHAT_CONNECT_OIDC_ISSUER":
    "Issuer of the Rocket.Chat end-user connect-link login; must equal the assistants' delegation issuer, or the connect flow stays off",
  "Runtime:ROCKETCHAT_CONNECT_OIDC_CLIENT_ID":
    "Client id of the Rocket.Chat connect-link login; must equal the delegation client id",
  "Runtime:ROCKETCHAT_CONNECT_OIDC_CLIENT_SECRET":
    "SECRET. Client secret of the Rocket.Chat connect-link login; must equal ASSISTANT_DELEGATION_CLIENT_SECRET",
  "Runtime:ROCKETCHAT_CONNECT_SESSION_SECRET":
    "SECRET. Signs the Rocket.Chat connect-link state; separate from the operator OIDC session",
  "Runtime:ROCKETCHAT_CONNECT_PUBLIC_URL":
    "Public Runtime URL the Rocket.Chat connect links point to",
  "Runtime:ATF_RUNTIME_TOKEN":
    "SECRET. Bearer token the eval CLI (`scripts/eval`) uses against the Runtime API",
};

function isUndescribed(variable: Variable): boolean {
	return (
		variable.description === undefined ||
		variable.description === "" ||
		/^Config member `\w+`$/.test(variable.description)
	);
}

function withCuratedDescriptions(service: string, variables: Variable[]): Variable[] {
	return variables.map((variable) => {
		if (!isUndescribed(variable)) return variable;
		const curated =
			CURATED_DESCRIPTIONS[`${service}:${variable.name}`] ??
			CURATED_DESCRIPTIONS[variable.name];
		if (curated === undefined) return variable;
		const member = /^Config member (`\w+`)$/.exec(variable.description ?? "")?.[1];
		return {
			...variable,
			description: member === undefined ? curated : `${curated} (${member})`,
		};
	});
}

/**
 * Names whose meaning an operator must not have to guess: credentials, trust
 * anchors, authentication and isolation switches, and the debug toggles that
 * weaken them. Every one needs a description; `--check` and the writer fail
 * otherwise, so a new security variable cannot ship undocumented.
 */
const SECURITY_RELEVANT =
	/SECRET|PASSWORD|ENCRYPTION|(^|_)API_KEY$|(^|_)TOKEN$|^JWT_|JWKS|^OIDC_|^API_OIDC|AUTHN|AUTHZ|(^|_)AUTH$|^TLS_|CA_CERT|CA_FILE|CORS|ALLOW_UNVERIFIED|TRUST_PROXY|_RLS_|TENANT_ISOLATION|^ACL_|FAIL_CLOSED|CAPTURE_REQUEST_TOKENS|LOG_REDACT|SANDBOX|ALLOWLIST/;

function undocumentedSecurityVariables(sections: Section[]): string[] {
	return sections.flatMap((section) =>
		section.variables
			.filter((v) => SECURITY_RELEVANT.test(v.name) && isUndescribed(v))
			.map((v) => `${section.service}: ${v.name}`),
	);
}

// ---------------------------------------------------------------------------

const runtimeSource = await readFile(
	resolve(root, "apps/runtime/src/config/schema.ts"),
	"utf8",
);
const searchSource = await readFile(
	resolve(root, "apps/search/src/config.ts"),
	"utf8",
);
const extractSource = await readFile(
	resolve(root, "apps/extract/src/config.ts"),
	"utf8",
);

const runtimeParsed = withAppConfigDocs(
	parseRuntime(runtimeSource),
	runtimeSource,
	await readFile(resolve(root, "apps/runtime/src/config/load.ts"), "utf8"),
);
const searchParsed = parseConfigInterface(
	searchSource,
	"apps/search/src/config.ts",
);
const extractParsed = parseConfigInterface(
	extractSource,
	"apps/extract/src/config.ts",
);

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
      ...(await unvalidatedExtras(
        ["apps/search/src"],
        searchParsed,
        await collectValidatedNames(["apps/search/src"]),
      )),
    ],
  },
  {
    service: "Extract",
    source: "apps/extract/src/config.ts",
    intro:
      "Document-to-Markdown extraction against the `atf-extract` contract. Extract has its own environment contract; only the access-control block (`AUTHN_MODE`, `OIDC_*`, `UI_*`, …) is deliberately identical to Search's so SSO is configured once. `VISION_URL` and `VISION_MODEL` are the only required variables. `SEARCH_URL` and `CONVERTER_URL` are the two halves of the optional Search integration: without `SEARCH_URL` the `/v1/ingest` route is not mounted here, and without `CONVERTER_URL` the `/ingest-file` route is not mounted in Search. Entries flagged in the Notes column are read by `loadConfig` without a corresponding `Config` member.",
    variables: [
      ...extractParsed,
      ...(await unvalidatedExtras(
        ["apps/extract/src"],
        extractParsed,
        await collectValidatedNames(["apps/extract/src"]),
      )),
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
    service: "Outpost",
    source:
      "packages/outpost-core/src/config/merge.ts (ENV_MAP) and the environment reads of apps/outpost/src and packages/outpost-core/src",
    intro:
      "The Outpost (Docker runtime and the desktop sidecar) is configured by an optional `outpost.yaml` (`OUTPOST_CONFIG_FILE`, default `/config/outpost.yaml`) and by these variables, which win per key over the file. Per-source credentials are read from `OUTPOST_SOURCE_<ID>_*` variables (`<ID>` is the upper-cased source id), never from the file; secrets may also come from a secrets file. Rows marked **read directly** are secrets and runtime paths that are not part of the file schema.",
    variables: await parseOutpost(),
  },
  {
    service: "Control",
    source:
      "apps/control/src (environment reads) and apps/control/next.config.ts",
    intro:
      "Control uses Runtime's HTTP API and SSE stream. Relative same-origin Runtime URLs are the production default; the deployment must provide the reverse-proxy routing because Control has no internal API rewrite. `NEXT_PUBLIC_BACKEND_URL` is an explicit development or cross-origin override frozen into the browser bundle at build time.",
    variables: [
      // CONTROL_CSP_MODE is read by src/proxy.ts (inside the scanned
      // tree); the enriched manual entry below replaces the scan result.
      // The BFF variables (Req 8.7) are read by src/lib/session-mode.ts,
      // src/lib/session-crypto.ts and src/lib/bff-session.ts.
      ...(await parseEnvReads(["apps/control/src"])).filter(
        (v) =>
          v.name !== "CONTROL_CSP_MODE" &&
          v.name !== "CONTROL_SESSION_MODE" &&
          v.name !== "CONTROL_SESSION_SECRET" &&
          v.name !== "CONTROL_BACKEND_URL" &&
          v.name !== "CONTROL_TELEMETRY_URL",
      ),
      {
        name: "CONTROL_CSP_MODE",
        type: "enum",
        required: false,
        default: "enforce",
        allowed: ["legacy", "report-only", "enforce"],
        description:
          "Read by `src/proxy.ts` per request. `enforce` (default since 0.15) emits `Content-Security-Policy` with a per-request script nonce; `report-only` emits `Content-Security-Policy-Report-Only`; `legacy` emits no CSP header. An invalid value fails every request",
      },
      {
        name: "CONTROL_SESSION_MODE",
        type: "enum",
        required: false,
        default: "token",
        allowed: ["token", "bff"],
        description:
          "`token` (default): the browser holds the Access-Token (sessionStorage). `bff`: the Next.js server holds the token server-side only and the browser receives an encrypted `HttpOnly` `SameSite=Strict` session cookie; API calls are routed through the same-origin BFF proxy `app/api/backend/[...path]`. An invalid value fails every request (fail closed)",
      },
      {
        name: "CONTROL_SESSION_SECRET",
        type: "string",
        required: false,
        description:
          "Master secret (≥ 32 characters) for the AES-256-GCM sealed session cookie in `bff` mode (SHA-256-derived key). Required when `CONTROL_SESSION_MODE=bff`: without a valid secret the session endpoints return 503 and no cookie is ever issued. Rotating the secret invalidates all sessions",
      },
      {
        name: "CONTROL_BACKEND_URL",
        type: "string",
        required: false,
        default: "http://127.0.0.1:3000",
        description:
          "Server-side Runtime origin the BFF proxy forwards to in `bff` mode (falls back to `NEXT_PUBLIC_BACKEND_URL`). Never exposed to the browser; only an `http`/`https` origin is accepted",
      },
      {
        name: "CONTROL_TELEMETRY_URL",
        type: "string",
        required: false,
        description:
          "Optional external error-telemetry endpoint (Req 9.6). The browser always POSTs client errors to the same-origin route `app/api/telemetry`; when this variable is set, the route forwards each event as JSON to the configured URL with a 5-second timeout. Without it, events are only written to the server log (`console.error`). The route is unauthenticated and therefore only accepts same-origin `application/json` posts (cross-site `Sec-Fetch-Site`/`Origin` → 403, other content types → 415) and strips control characters before logging or forwarding. Never exposed to the browser",
      },
    ],
  },
];

for (const section of sections) {
	section.variables = withCuratedDescriptions(section.service, section.variables);
}
const undocumented = undocumentedSecurityVariables(sections);
if (undocumented.length > 0) {
	console.error(
		`Security-relevant configuration without a description (add a JSDoc at the source or a CURATED_DESCRIPTIONS entry):\n  ${undocumented.join("\n  ")}`,
	);
	process.exit(1);
}

const gateSchemaSource = await readFile(
	resolve(root, "apps/gate/src/config/schema.ts"),
	"utf8",
);
const expected = `${render(sections)}\n${buildGateConfigReference(gateSchemaSource)}\n`;

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
