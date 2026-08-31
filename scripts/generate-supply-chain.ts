// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const bunStore = join(root, "node_modules", ".bun");
const noticesPath = join(root, "THIRD_PARTY_NOTICES.md");
const sbomPath = join(root, "sbom.cdx.json");
const checkOnly = process.argv.includes("--check");

/** SPDX identifier ATF itself is released under. */
const PROJECT_LICENSE = "Elastic-2.0";
const PROJECT_NAME = "aiperator-trust-fabric";
const PROJECT_VERSION = "0.1.0";
const PROJECT_AUTHOR = "Abillify Technology GmbH <info@abillify.me>";

/**
 * License policy.
 *
 * `denied` licenses fail the run. Strong copyleft would reach into deployments that embed
 * ATF, and the source-available competitor licenses (SSPL, BUSL, and similar) impose terms
 * ATF cannot pass on under Elastic-2.0. Inventorying such a dependency without failing would
 * let it enter a release unnoticed, which is the failure mode this gate exists to prevent.
 *
 * `weakCopyleft` licenses are allowed but must ship their notice text, so a missing notice is
 * also a failure. Everything else is treated as permissive.
 */
const DENIED_LICENSE_PATTERNS: RegExp[] = [
	// `\b` before GPL keeps this from matching LGPL, where L and G are both word
	// characters. Long-form GNU names are matched separately, deliberately without
	// "Lesser" so that spelled-out LGPL falls through to the weak-copyleft rules.
	/\bA?GPL-[0-9]/i,
	/\bGNU (?:Affero )?General Public/i,
	/\bSSPL\b/i,
	/Server Side Public License/i,
	/\bBUSL\b/i,
	/Business Source License/i,
	/\bCC-BY-NC/i,
	/\bCPAL-/i,
	/\bOSL-/i,
	/\bEUPL-/i,
	/\bWTFPL\b/i,
	/\bJSON\b.*license/i,
];

/** Weak copyleft: permitted, but the notice text is mandatory. */
const WEAK_COPYLEFT_PATTERNS: RegExp[] = [
	/\bLGPL-[0-9]/i,
	/\bMPL-[0-9]/i,
	/\bCDDL-/i,
	/\bEPL-[0-9]/i,
];

/**
 * Dependencies allowed to trip a policy rule, with the reason.
 *
 * LGPL applies to `libvips`, which sharp loads as a separate native library rather than
 * linking statically into ATF code. The obligation is to ship the license text and permit
 * relinking, both of which hold for a dynamically loaded prebuilt binary. The upstream
 * packages omit the notice file, so ATF carries it in `licenses/` instead.
 */
const POLICY_EXCEPTIONS = new Map<string, string>([
	[
		"@img/sharp-libvips",
		"LGPL-3.0-or-later applies to the dynamically loaded libvips binary, not to ATF code. Notice text is vendored in licenses/LGPL-3.0.txt.",
	],
]);

/** Notice texts ATF supplies for packages that ship none. Keyed by package-name prefix. */
const SUPPLEMENTAL_NOTICES = new Map<string, string>([
	["@img/sharp-libvips", "licenses/LGPL-3.0.txt"],
]);

function matchesAny(value: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(value));
}

function exceptionFor(name: string): string | undefined {
	for (const [prefix, reason] of POLICY_EXCEPTIONS) {
		if (name === prefix || name.startsWith(`${prefix}-`)) return reason;
	}
	return undefined;
}

function supplementalNoticeFor(name: string): string | undefined {
	for (const [prefix, path] of SUPPLEMENTAL_NOTICES) {
		if (name === prefix || name.startsWith(`${prefix}-`)) return path;
	}
	return undefined;
}

type PackageManifest = {
	name?: string;
	version?: string;
	license?: string | { type?: string };
	licenses?: Array<string | { type?: string }>;
	private?: boolean;
};

type Component = {
	name: string;
	version: string;
	license: string;
	packageRoot: string;
	noticeTexts: Array<{ file: string; text: string }>;
};

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

function normalizeNoticeText(text: string): string {
	return text
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function licenseValue(manifest: PackageManifest): string {
	if (typeof manifest.license === "string") return manifest.license.trim();
	if (manifest.license && typeof manifest.license.type === "string") {
		return manifest.license.type.trim();
	}
	if (Array.isArray(manifest.licenses)) {
		return manifest.licenses
			.map((entry) => (typeof entry === "string" ? entry : (entry.type ?? "")))
			.filter(Boolean)
			.join(" OR ");
	}
	return "NOASSERTION";
}

async function packageRoots(): Promise<string[]> {
	const roots: string[] = [];
	for (const storeEntry of await readdir(bunStore, { withFileTypes: true })) {
		if (!storeEntry.isDirectory()) continue;
		const modules = join(bunStore, storeEntry.name, "node_modules");
		let entries: Dirent[];
		try {
			entries = await readdir(modules, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (entry.name.startsWith("@")) {
				const scope = join(modules, entry.name);
				for (const scoped of await readdir(scope, { withFileTypes: true })) {
					if (scoped.isDirectory() || scoped.isSymbolicLink())
						roots.push(join(scope, scoped.name));
				}
			} else {
				roots.push(join(modules, entry.name));
			}
		}
	}
	return roots;
}

async function loadComponents(): Promise<Component[]> {
	const byIdentity = new Map<string, Component>();
	for (const packageRoot of await packageRoots()) {
		const manifestPath = join(packageRoot, "package.json");
		if (!(await exists(manifestPath))) continue;
		let manifest: PackageManifest;
		try {
			manifest = JSON.parse(
				await readFile(manifestPath, "utf8"),
			) as PackageManifest;
		} catch {
			continue;
		}
		if (!manifest.name || !manifest.version) continue;
		const identity = `${manifest.name}@${manifest.version}`;
		if (byIdentity.has(identity)) continue;

		const noticeTexts: Component["noticeTexts"] = [];
		for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
			if (
				!entry.isFile() ||
				!/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)
			)
				continue;
			const text = normalizeNoticeText(
				await readFile(join(packageRoot, entry.name), "utf8"),
			);
			if (text) noticeTexts.push({ file: entry.name, text });
		}
		// Some upstream packages ship no license file even though their license requires the
		// text to accompany distribution. Substitute the copy ATF vendors in licenses/.
		if (noticeTexts.length === 0) {
			const supplemental = supplementalNoticeFor(manifest.name);
			if (supplemental) {
				try {
					noticeTexts.push({
						file: `${supplemental} (supplied by ATF)`,
						text: normalizeNoticeText(
							await readFile(join(root, supplemental), "utf8"),
						),
					});
				} catch {
					// Reported by the policy check below, which has the package context.
				}
			}
		}

		noticeTexts.sort((a, b) => a.file.localeCompare(b.file));
		byIdentity.set(identity, {
			name: manifest.name,
			version: manifest.version,
			license: licenseValue(manifest),
			packageRoot,
			noticeTexts,
		});
	}
	return [...byIdentity.values()].sort(
		(a, b) =>
			a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
	);
}

function markdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * Platform label recorded in the notices and SBOM.
 *
 * Optional dependencies such as native prebuilds resolve per platform, so an inventory is
 * only complete for the platform it was generated on. Recording that explicitly prevents a
 * macOS-generated SBOM from being mistaken for a description of a Linux release image.
 */
function platformLabel(): string {
	return `${process.platform}-${process.arch}`;
}

function generateNotices(components: Component[]): string {
	const textGroups = new Map<
		string,
		{ text: string; files: Set<string>; packages: Set<string> }
	>();
	for (const component of components) {
		for (const notice of component.noticeTexts) {
			const digest = createHash("sha256").update(notice.text).digest("hex");
			const group = textGroups.get(digest) ?? {
				text: notice.text,
				files: new Set<string>(),
				packages: new Set<string>(),
			};
			group.files.add(notice.file);
			group.packages.add(`${component.name}@${component.version}`);
			textGroups.set(digest, group);
		}
	}

	const lines = [
		"# Third-Party Notices",
		"",
		"This file is generated by `bun run supply-chain`. Do not edit it manually.",
		"",
		`ATF itself is licensed under ${PROJECT_LICENSE}; see LICENSE.md. The third-party components listed below remain subject to their own licenses. Inclusion here does not change their terms, and it does not imply that ATF is licensed under those terms or that those components are licensed under ${PROJECT_LICENSE}.`,
		"",
		`Installed third-party package versions: **${components.length}**.`,
		"",
		`Platforms covered by this inventory: **${platformLabel()}**. Optional platform-specific packages that are not installed on the generating host are absent; regenerate on each target platform to obtain a complete picture, or consult a release SBOM produced in CI.`,
		"",
		"## Package inventory",
		"",
		"| Package | Version | Declared license | License/notice text found |",
		"| --- | --- | --- | --- |",
	];
	for (const component of components) {
		lines.push(
			`| ${markdownCell(component.name)} | ${markdownCell(component.version)} | ${markdownCell(component.license)} | ${component.noticeTexts.length > 0 ? "yes" : "no"} |`,
		);
	}
	lines.push("", "## License and notice texts", "");
	for (const [digest, group] of [...textGroups.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		lines.push(
			`### ${[...group.packages].sort().join(", ")}`,
			"",
			`Source files: ${[...group.files].sort().join(", ")}; SHA-256: \`${digest}\``,
			"",
			"```text",
			group.text.replaceAll("```", "` ` `"),
			"```",
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function licenseEntry(
	value: string,
): { expression: string } | { license: { name: string } } {
	return value === "NOASSERTION"
		? { license: { name: value } }
		: { expression: value };
}

function purl(name: string, version: string): string {
	return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function generateSbom(components: Component[]): string {
	const componentEntries = components.map((component) => {
		const packageUrl = purl(component.name, component.version);
		const slash = component.name.startsWith("@")
			? component.name.indexOf("/")
			: -1;
		return {
			type: "library",
			"bom-ref": packageUrl,
			...(slash > 0 ? { group: component.name.slice(0, slash) } : {}),
			name: slash > 0 ? component.name.slice(slash + 1) : component.name,
			version: component.version,
			licenses: [licenseEntry(component.license)],
			purl: packageUrl,
		};
	});
	const bom = {
		$schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
		bomFormat: "CycloneDX",
		specVersion: "1.6",
		version: 1,
		metadata: {
			tools: {
				components: [
					{
						type: "application",
						author: PROJECT_AUTHOR,
						name: "ATF supply-chain generator",
						version: "1.1.0",
					},
				],
			},
			component: {
				type: "application",
				"bom-ref": `pkg:npm/${PROJECT_NAME}@${PROJECT_VERSION}`,
				group: "Abillify Technology GmbH",
				name: PROJECT_NAME,
				version: PROJECT_VERSION,
				licenses: [{ expression: PROJECT_LICENSE }],
				purl: `pkg:npm/${PROJECT_NAME}@${PROJECT_VERSION}`,
			},
			properties: [
				{ name: "atf:inventory:platform", value: platformLabel() },
			],
		},
		components: componentEntries,
	};
	return `${JSON.stringify(bom, null, 2)}\n`;
}

async function verifyOrWrite(path: string, expected: string): Promise<boolean> {
	if (!checkOnly) {
		await Bun.write(path, expected);
		return true;
	}
	let actual = "";
	try {
		actual = await readFile(path, "utf8");
	} catch {
		console.error(`Missing generated artifact: ${relative(root, path)}`);
		return false;
	}
	if (actual !== expected) {
		console.error(
			`Stale generated artifact: ${relative(root, path)} (run bun run supply-chain)`,
		);
		return false;
	}
	return true;
}

const components = await loadComponents();
if (components.length === 0) {
	console.error(
		"No installed third-party packages found. Run bun install first.",
	);
	process.exit(1);
}
// ---------------------------------------------------------------------------
// License policy
// ---------------------------------------------------------------------------

const policyFailures: string[] = [];

for (const component of components) {
	const identity = `${component.name}@${component.version}`;
	const exception = exceptionFor(component.name);

	if (component.license === "NOASSERTION") {
		policyFailures.push(
			`${identity}: no license metadata. Determine the license and either record it upstream or add an explicit exception.`,
		);
		continue;
	}

	// Weak copyleft is checked first: "GNU Lesser General Public License" also contains
	// "General Public", so evaluating the denial rules first would reject a permitted license.
	if (matchesAny(component.license, WEAK_COPYLEFT_PATTERNS)) {
		if (component.noticeTexts.length === 0) {
			policyFailures.push(
				`${identity}: weak-copyleft license "${component.license}" requires its license text to be distributed, but none was found. Vendor the text in licenses/ and register it in SUPPLEMENTAL_NOTICES.`,
			);
		}
		continue;
	}

	if (matchesAny(component.license, DENIED_LICENSE_PATTERNS)) {
		if (exception === undefined) {
			policyFailures.push(
				`${identity}: license "${component.license}" is not permitted alongside ${PROJECT_LICENSE}. Replace the dependency or record an exception with a documented rationale.`,
			);
			continue;
		}
		if (component.noticeTexts.length === 0) {
			policyFailures.push(
				`${identity}: license "${component.license}" is allowed by exception but ships no license or notice text, which the license requires.`,
			);
		}
	}
}

if (policyFailures.length > 0) {
	console.error(
		`License policy violations (${policyFailures.length}):\n${policyFailures
			.map((failure) => `  - ${failure}`)
			.join("\n")}`,
	);
	process.exit(1);
}
const results = await Promise.all([
	verifyOrWrite(noticesPath, generateNotices(components)),
	verifyOrWrite(sbomPath, generateSbom(components)),
]);
if (results.some((result) => !result)) process.exit(1);
console.log(
	`${checkOnly ? "Verified" : "Generated"} THIRD_PARTY_NOTICES.md and sbom.cdx.json for ${components.length} package versions.`,
);
