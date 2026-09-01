// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROJECT_LICENSE = "Elastic-2.0";
const PROJECT_AUTHOR = "Abillify Technology GmbH <info@abillify.me>";
const GENERATOR_VERSION = "2.1.0";
const NOTICE_NAMES = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

type ArtifactKind = "workspace" | "image";
type Options = {
	inventoryRoot: string;
	outputDir: string;
	platform: string;
	assertHostPlatform: boolean;
	artifactKind: ArtifactKind;
	artifactName: string;
	gitSha: string;
	checkOnly: boolean;
};

type PackageManifest = {
	name?: string;
	version?: string;
	license?: string | { type?: string };
	licenses?: Array<string | { type?: string }>;
	repository?: string | { url?: string; directory?: string };
};

type NoticeText = { file: string; text: string; provenance: string };
type Component = {
	name: string;
	version: string;
	license: string;
	repository: string;
	packageRoot: string;
	noticeTexts: NoticeText[];
	compliance: Compliance;
};
type Compliance = { classification: string; requirement: string };
type SupplementalRule = {
	packagePattern: RegExp;
	expectedLicense: string;
	files: string[];
	attribution: string;
	reason: string;
};
type RepositoryLicenseReuseRule = {
	packagePattern: RegExp;
	expectedLicense: string;
	expectedRepository: string;
	sourcePackagePattern: RegExp;
	allowedSourceFiles: RegExp;
	reason: string;
};
type PackageEmbeddedLicenseRule = {
	packagePattern: RegExp;
	expectedVersion: string;
	expectedLicense: string;
	expectedRepository: string;
	sourceFile: string;
	sectionPattern: RegExp;
	reason: string;
};
type DeclaredLicenseFallbackRule = {
	packagePattern: RegExp;
	expectedVersion: string;
	expectedLicense: string;
	expectedRepository: string;
	files: string[];
	reason: string;
};
type StandardLicenseFamily = {
	name: string;
	expressionPattern: RegExp;
	textPattern: RegExp;
};

const SUPPLEMENTAL_RULES: SupplementalRule[] = [
	{
		packagePattern: /^@img\/sharp-libvips(?:-|$)/,
		expectedLicense: "LGPL-3.0-or-later",
		files: ["licenses/LGPL-3.0.txt"],
		attribution: "SPDX License List, LGPL-3.0-or-later",
		reason:
			"The prebuilt package omits the license file for its dynamically loaded libvips shared library.",
	},
	{
		packagePattern: /^@cfworker\/json-schema$/,
		expectedLicense: "MIT",
		files: ["licenses/cfworker-json-schema-MIT.txt"],
		attribution: "cfworker upstream LICENSE.md",
		reason: "The published package omits its upstream project license file.",
	},
	{
		packagePattern: /^@next\/(?:env|swc-.+)$/,
		expectedLicense: "MIT",
		files: ["licenses/nextjs-MIT.txt"],
		attribution: "Next.js upstream license.md",
		reason:
			"These packages are part of the Next.js repository and omit its repository-wide license file.",
	},
	{
		packagePattern:
			/^(?:@redis\/(?:bloom|client|json|search|time-series)|redis)$/,
		expectedLicense: "MIT",
		files: ["licenses/node-redis-MIT.txt"],
		attribution: "node-redis upstream LICENSE",
		reason:
			"These packages are published from node-redis and omit its repository-wide license file.",
	},
	{
		packagePattern: /^client-only$/,
		expectedLicense: "MIT",
		files: ["licenses/react-MIT.txt"],
		attribution: "React upstream LICENSE",
		reason:
			"The package is published by React and omits the React repository license file.",
	},
	{
		packagePattern: /^js-tiktoken$/,
		expectedLicense: "MIT",
		files: ["licenses/js-tiktoken-MIT.txt"],
		attribution: "tiktoken upstream LICENSE",
		reason: "The published package omits its upstream project license file.",
	},
	{
		packagePattern: /^langsmith$/,
		expectedLicense: "MIT",
		files: ["licenses/langsmith-MIT.txt"],
		attribution: "LangSmith SDK upstream LICENSE",
		reason: "The published package omits its upstream project license file.",
	},
	{
		packagePattern: /^onnxruntime-(?:common|node|web)$/,
		expectedLicense: "MIT",
		files: ["licenses/onnxruntime-MIT.txt"],
		attribution: "ONNX Runtime upstream LICENSE",
		reason:
			"These packages are published from ONNX Runtime and omit its repository-wide license file.",
	},
	{
		packagePattern: /^saxes$/,
		expectedLicense: "ISC",
		files: ["licenses/saxes-ISC.txt"],
		attribution: "saxes upstream LICENSE",
		reason: "The published package omits its complete upstream license file.",
	},
	{
		packagePattern: /^victory-vendor$/,
		expectedLicense: "MIT AND ISC",
		files: ["licenses/victory-MIT.txt", "licenses/d3-ISC.txt"],
		attribution: "Victory upstream LICENSE.txt and d3-array upstream LICENSE",
		reason:
			"The package vendors Victory and d3 code but omits both complete upstream license texts.",
	},
];

const REPOSITORY_LICENSE_REUSE_RULES: RepositoryLicenseReuseRule[] = [
	{
		packagePattern: /^@ai-sdk\/provider-utils$/,
		expectedLicense: "Apache-2.0",
		expectedRepository: "https://github.com/vercel/ai",
		sourcePackagePattern: /^@ai-sdk\/provider$/,
		allowedSourceFiles: /^(?:LICENSE|LICENCE|COPYING)(?:[._-].*)?$/i,
		reason: "Vercel AI packages use the repository-root Apache-2.0 license.",
	},
	{
		packagePattern:
			/^@aws-sdk\/(?:credential-provider-http|credential-provider-login|nested-clients)$/,
		expectedLicense: "Apache-2.0",
		expectedRepository: "https://github.com/aws/aws-sdk-js-v3",
		sourcePackagePattern: /^@aws-sdk\/core$/,
		allowedSourceFiles: /^(?:LICENSE|LICENCE|COPYING)(?:[._-].*)?$/i,
		reason:
			"AWS SDK for JavaScript v3 packages use the repository-root Apache-2.0 license.",
	},
	{
		packagePattern: /^@biomejs\/cli-.+$/,
		expectedLicense: "MIT OR Apache-2.0",
		expectedRepository: "https://github.com/biomejs/biome",
		sourcePackagePattern: /^@biomejs\/biome$/,
		allowedSourceFiles: /^LICENSE-(?:MIT|APACHE)$/i,
		reason:
			"Biome platform packages use the repository-root dual-license files.",
	},
	{
		packagePattern: /^@rolldown\/binding-.+$/,
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/rolldown/rolldown",
		sourcePackagePattern: /^rolldown$/,
		allowedSourceFiles: /^(?:LICENSE|LICENCE|COPYING)$/i,
		reason:
			"Rolldown native bindings use the repository-root MIT license; third-party notices are intentionally not reused.",
	},
	{
		packagePattern: /^cookie-signature$/,
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/visionmedia/node-cookie-signature",
		sourcePackagePattern: /^cookie-signature$/,
		allowedSourceFiles: /^(?:LICENSE|LICENCE|COPYING)$/i,
		reason:
			"Published cookie-signature versions use the repository-root MIT license.",
	},
];

const PACKAGE_EMBEDDED_LICENSE_RULES: PackageEmbeddedLicenseRule[] = [
	{
		packagePattern: /^pg-types$/,
		expectedVersion: "2.2.0",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/brianc/node-pg-types",
		sourceFile: "README.md",
		sectionPattern: /## license\s*\n(The MIT License \(MIT\)[\s\S]+)$/i,
		reason:
			"The published package carries its complete MIT license and copyright notice in the README license section.",
	},
	{
		packagePattern: /^pgpass$/,
		expectedVersion: "1.0.5",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/hoegaarden/pgpass",
		sourceFile: "README.md",
		sectionPattern:
			/## License\s*\n(Copyright \(c\) 2013-2016 Hannes Hörl[\s\S]+)$/,
		reason:
			"The published package carries its complete MIT license and copyright notice in the README license section.",
	},
];

const DECLARED_LICENSE_FALLBACK_RULES: DeclaredLicenseFallbackRule[] = [
	{
		packagePattern: /^bun-types$/,
		expectedVersion: "1.3.14",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/oven-sh/bun",
		files: ["licenses/declared-MIT-no-upstream-copyright.txt"],
		reason:
			"The exact package manifest declares MIT and the Bun project states that Bun itself is MIT-licensed, but neither the package nor its exact source tree supplies a package copyright notice or complete MIT text.",
	},
	{
		packagePattern: /^guid-typescript$/,
		expectedVersion: "1.0.9",
		expectedLicense: "ISC",
		expectedRepository: "https://github.com/nicolasdeveloper/guid-typescript",
		files: ["licenses/declared-ISC-no-upstream-copyright.txt"],
		reason:
			"The exact package manifest declares ISC, but neither the package nor its exact source tree supplies a copyright notice or complete ISC text.",
	},
	{
		packagePattern: /^stackback$/,
		expectedVersion: "0.0.2",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/shtylman/node-stackback",
		files: [
			"licenses/declared-MIT-no-upstream-copyright.txt",
			"licenses/stackback-v8-BSD-3-Clause.txt",
		],
		reason:
			"The exact package manifest declares MIT, but neither the package nor its exact source tree supplies a package-level MIT copyright notice or complete MIT text; the separate V8-derived BSD header does not fill that gap.",
	},
];

const STANDARD_LICENSE_FAMILIES: StandardLicenseFamily[] = [
	{
		name: "Apache-2.0",
		expressionPattern: /\bApache-2\.0\b/i,
		textPattern:
			/Apache License[\s\S]*Version 2\.0[\s\S]*TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION[\s\S]*END OF TERMS AND CONDITIONS/i,
	},
	{
		name: "MIT",
		expressionPattern: /\bMIT\b/i,
		textPattern:
			/Permission is hereby granted, free of charge,[\s\S]*THE SOFTWARE IS PROVIDED [“"']AS IS[”"']/i,
	},
	{
		name: "ISC",
		expressionPattern: /\bISC\b/i,
		textPattern:
			/Permission to use, copy, modify,[\s\S]*THE SOFTWARE IS PROVIDED [“"']AS IS[”"']/i,
	},
	{
		name: "BSD-2-Clause/BSD-3-Clause",
		expressionPattern: /\bBSD-(?:2|3)-Clause\b/i,
		textPattern:
			/Redistribution and use in source and binary forms[\s\S]*THIS (?:SOFTWARE )?IS PROVIDED/i,
	},
	{
		name: "MPL-2.0",
		expressionPattern: /\bMPL-2\.0\b/i,
		textPattern: /Mozilla Public License,? version 2\.0[\s\S]*1\. Definitions/i,
	},
	{
		name: "LGPL-3.0",
		expressionPattern: /\bLGPL-3\.0(?:-only|-or-later)?\b/i,
		textPattern:
			/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]*Version 3[\s\S]*GNU GENERAL PUBLIC LICENSE/i,
	},
	{
		name: "CC-BY-4.0",
		expressionPattern: /\bCC-BY-4\.0\b/i,
		textPattern:
			/Creative Commons Attribution 4\.0 International Public License/i,
	},
];

const DENIED_LICENSE_PATTERNS = [
	/\bA?GPL-[0-9]/i,
	/\bGNU (?:Affero )?General Public/i,
	/\bSSPL\b|Server Side Public License/i,
	/\bBUSL\b|Business Source License/i,
	/\bCC-BY-NC|\bCPAL-|\bOSL-|\bEUPL-|\bWTFPL/i,
	/\bJSON\b.*license/i,
];

const MPL_SOURCE_BY_VERSION = new Map([
	[
		"1.30.2",
		"https://github.com/parcel-bundler/lightningcss/archive/400f705e63e139c326f480aed11e1416f5a3a61f.tar.gz",
	],
	[
		"1.33.0",
		"https://github.com/parcel-bundler/lightningcss/archive/c6a0c3cebf3395635e61075d2c81a96a710d4910.tar.gz",
	],
]);

function parseArgs(argv: string[]): Options {
	const host = `${process.platform}-${process.arch}`;
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--check" || arg === "--assert-host-platform") {
			flags.add(arg);
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
		const value = argv[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${arg}`);
		values.set(arg, value);
		index++;
	}
	const repoRoot = process.cwd();
	const inventoryRoot = resolve(values.get("--inventory-root") ?? repoRoot);
	const kind = values.get("--artifact-kind") ?? "workspace";
	if (kind !== "workspace" && kind !== "image")
		throw new Error(`Invalid --artifact-kind: ${kind}`);
	const platform = values.get("--platform") ?? host;
	if (!/^[a-z0-9]+-[a-z0-9_]+$/i.test(platform))
		throw new Error(`Invalid --platform: ${platform}`);
	if (flags.has("--assert-host-platform") && platform !== host) {
		throw new Error(
			`Platform assertion failed: requested ${platform}, actual host is ${host}`,
		);
	}
	const gitSha = values.get("--git-sha") ?? process.env.GITHUB_SHA ?? "unknown";
	if (gitSha !== "unknown" && !/^[0-9a-f]{7,64}$/i.test(gitSha))
		throw new Error("--git-sha must be a hexadecimal commit SHA");
	return {
		inventoryRoot,
		outputDir: resolve(values.get("--output-dir") ?? repoRoot),
		platform,
		assertHostPlatform: flags.has("--assert-host-platform"),
		artifactKind: kind,
		artifactName: values.get("--artifact-name") ?? `${kind}-${platform}`,
		gitSha,
		checkOnly: flags.has("--check"),
	};
}

function normalizeText(text: string): string {
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
	if (manifest.license?.type) return manifest.license.type.trim();
	if (manifest.licenses)
		return manifest.licenses
			.map((entry) => (typeof entry === "string" ? entry : (entry.type ?? "")))
			.filter(Boolean)
			.join(" OR ");
	return "NOASSERTION";
}
function repositoryValue(manifest: PackageManifest): string {
	const raw =
		typeof manifest.repository === "string"
			? manifest.repository
			: (manifest.repository?.url ?? "");
	return raw
		.toLowerCase()
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
}
function markdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
function digest(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}
function stableCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
function matches(value: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(value));
}

function complianceFor(
	name: string,
	version: string,
	license: string,
	kind: ArtifactKind,
): Compliance {
	if (
		/^@img\/sharp-libvips(?:-|$)/.test(name) ||
		/\bLGPL-[0-9]/i.test(license)
	) {
		return {
			classification: "LGPL shared library",
			requirement:
				"Retain the full LGPL text and the replaceable, dynamically loaded shared-library boundary for libvips.",
		};
	}
	if (/\bMPL-[0-9]/i.test(license)) {
		if (/^(?:axe-core|@axe-core\/playwright)$/.test(name)) {
			return {
				classification: "MPL file-level source",
				requirement: `${kind === "image" ? "This image retains" : "This workspace inventory contains"} the package's readable JavaScript source form for ${name}@${version} under /workspace/node_modules together with MPL-2.0. Retain those files; publish covered-file modifications if that status changes.`,
			};
		}
		if (!/^lightningcss(?:-|$)/.test(name)) {
			throw new Error(
				`${name}@${version}: MPL component has no reviewed corresponding-source rule`,
			);
		}
		const sourceUrl = MPL_SOURCE_BY_VERSION.get(version);
		if (!sourceUrl) {
			throw new Error(
				`${name}@${version}: Lightning CSS version has no commit-pinned MPL corresponding-source URL`,
			);
		}
		return {
			classification: "MPL file-level source",
			requirement: `${kind === "image" ? "This image contains an unmodified Lightning CSS executable package." : "This workspace inventory contains an unmodified Lightning CSS package."} Corresponding source for ${name}@${version} is available from the commit-pinned archive ${sourceUrl}. Retain this source link and the MPL-2.0 text; publish covered-file modifications if that status changes.`,
		};
	}
	if (/\bCC-BY(?:-[0-9.]+)?/i.test(license) || name === "caniuse-lite") {
		return {
			classification: "CC-BY attribution",
			requirement:
				"Caniuse data attribution: https://caniuse.com/ — packaged upstream data is unmodified by ATF; disclose changes if that status changes.",
		};
	}
	return {
		classification: "Standard notice",
		requirement:
			"Retain the listed license and notice text with redistributed copies.",
	};
}

async function packageRoots(
	store: string,
): Promise<{ roots: string[]; errors: string[] }> {
	const roots: string[] = [];
	const errors: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(store, { withFileTypes: true });
	} catch (error) {
		return {
			roots,
			errors: [
				`${store}: cannot read Bun store: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
	for (const storeEntry of entries.sort((a, b) =>
		stableCompare(a.name, b.name),
	)) {
		if (!storeEntry.isDirectory()) continue;
		if (storeEntry.name === "node_modules") {
			// Bun owns this internal hoisting directory; it is not a package store entry.
			continue;
		}
		const modules = join(store, storeEntry.name, "node_modules");
		let packages: Dirent[];
		try {
			packages = await readdir(modules, { withFileTypes: true });
		} catch (error) {
			errors.push(
				`${modules}: cannot read store entry node_modules: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const entry of packages.sort((a, b) =>
			stableCompare(a.name, b.name),
		)) {
			if (entry.name === ".bin") {
				// Bun creates .bin as executable links, not as a package directory.
				continue;
			}
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (entry.name.startsWith("@")) {
				const scope = join(modules, entry.name);
				let scopedPackages: Dirent[];
				try {
					scopedPackages = await readdir(scope, { withFileTypes: true });
				} catch (error) {
					errors.push(
						`${scope}: cannot read package scope: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				for (const scoped of scopedPackages.sort((a, b) =>
					stableCompare(a.name, b.name),
				)) {
					if (scoped.isDirectory() || scoped.isSymbolicLink())
						roots.push(join(scope, scoped.name));
				}
			} else roots.push(join(modules, entry.name));
		}
	}
	return { roots, errors };
}

async function loadComponents(
	options: Options,
	repoRoot: string,
): Promise<Component[]> {
	const byIdentity = new Map<string, Component>();
	const discovery = await packageRoots(
		join(options.inventoryRoot, "node_modules", ".bun"),
	);
	const discoveryErrors = [...discovery.errors];
	for (const packageRoot of discovery.roots) {
		const manifestPath = join(packageRoot, "package.json");
		let manifest: PackageManifest;
		try {
			manifest = JSON.parse(
				await readFile(manifestPath, "utf8"),
			) as PackageManifest;
		} catch (error) {
			discoveryErrors.push(
				`${manifestPath}: cannot read or parse manifest: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
			discoveryErrors.push(`${manifestPath}: missing non-empty name`);
			continue;
		}
		if (
			typeof manifest.version !== "string" ||
			manifest.version.trim() === ""
		) {
			discoveryErrors.push(`${manifestPath}: missing non-empty version`);
			continue;
		}
		const identity = `${manifest.name}@${manifest.version}`;
		if (byIdentity.has(identity)) continue;
		const noticeTexts: NoticeText[] = [];
		let packageEntries: Dirent[];
		try {
			packageEntries = await readdir(packageRoot, { withFileTypes: true });
		} catch (error) {
			discoveryErrors.push(
				`${packageRoot}: cannot read package directory: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const entry of packageEntries.sort((a, b) =>
			stableCompare(a.name, b.name),
		)) {
			if (!entry.isFile() || !NOTICE_NAMES.test(entry.name)) continue;
			const noticePath = join(packageRoot, entry.name);
			try {
				const text = normalizeText(await readFile(noticePath, "utf8"));
				if (text)
					noticeTexts.push({ file: entry.name, text, provenance: "package" });
			} catch (error) {
				discoveryErrors.push(
					`${noticePath}: cannot read license/notice text: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const license = licenseValue(manifest);
		byIdentity.set(identity, {
			name: manifest.name,
			version: manifest.version,
			license,
			repository: repositoryValue(manifest),
			packageRoot,
			noticeTexts,
			compliance: complianceFor(
				manifest.name,
				manifest.version,
				license,
				options.artifactKind,
			),
		});
	}
	if (discoveryErrors.length > 0) {
		throw new Error(
			`Package discovery failed (${discoveryErrors.length}):\n${discoveryErrors.map((error) => `  - ${error}`).join("\n")}`,
		);
	}
	const components = [...byIdentity.values()].sort(
		(a, b) =>
			stableCompare(a.name, b.name) || stableCompare(a.version, b.version),
	);
	for (const component of components) {
		if (component.noticeTexts.length > 0) continue;
		const rule = PACKAGE_EMBEDDED_LICENSE_RULES.find((candidate) =>
			candidate.packagePattern.test(component.name),
		);
		if (!rule) continue;
		if (component.version !== rule.expectedVersion) {
			throw new Error(
				`${component.name}@${component.version}: embedded license rule expects version ${rule.expectedVersion}`,
			);
		}
		if (component.license !== rule.expectedLicense) {
			throw new Error(
				`${component.name}@${component.version}: embedded license rule expects ${rule.expectedLicense}, package declares ${component.license}`,
			);
		}
		if (component.repository !== rule.expectedRepository) {
			throw new Error(
				`${component.name}@${component.version}: embedded license rule expects ${rule.expectedRepository}, package declares ${component.repository || "no repository"}`,
			);
		}
		const sourcePath = join(component.packageRoot, rule.sourceFile);
		const sourceText = normalizeText(await readFile(sourcePath, "utf8"));
		const section = sourceText.match(rule.sectionPattern)?.[1];
		if (!section) {
			throw new Error(
				`${component.name}@${component.version}: ${rule.sourceFile} no longer contains the reviewed complete license section`,
			);
		}
		component.noticeTexts.push({
			file: `${rule.sourceFile} (reviewed embedded license section)`,
			text: normalizeText(section),
			provenance: `${component.name}@${component.version}; ${rule.reason}`,
		});
	}
	for (const component of components) {
		if (component.noticeTexts.length > 0) continue;
		const rule = REPOSITORY_LICENSE_REUSE_RULES.find((candidate) =>
			candidate.packagePattern.test(component.name),
		);
		if (!rule) continue;
		if (component.license !== rule.expectedLicense) {
			throw new Error(
				`${component.name}@${component.version}: repository reuse rule expects ${rule.expectedLicense}, package declares ${component.license}`,
			);
		}
		if (component.repository !== rule.expectedRepository) {
			throw new Error(
				`${component.name}@${component.version}: repository reuse rule expects ${rule.expectedRepository}, package declares ${component.repository || "no repository"}`,
			);
		}
		const source = components.find(
			(candidate) =>
				candidate.repository === rule.expectedRepository &&
				candidate.license === rule.expectedLicense &&
				rule.sourcePackagePattern.test(candidate.name) &&
				candidate.noticeTexts.some((notice) =>
					rule.allowedSourceFiles.test(notice.file),
				),
		);
		if (!source) {
			throw new Error(
				`${component.name}@${component.version}: no installed source package matching ${rule.sourcePackagePattern} provides an allowed repository-root LICENSE/LICENCE/COPYING file`,
			);
		}
		component.noticeTexts = source.noticeTexts
			.filter((notice) => rule.allowedSourceFiles.test(notice.file))
			.map((notice) => ({
				...notice,
				file: `${notice.file} (reviewed repository-root reuse)`,
				provenance: `${source.name}@${source.version}; ${rule.reason}`,
			}));
	}
	for (const component of components) {
		if (component.noticeTexts.length > 0) continue;
		const rule = SUPPLEMENTAL_RULES.find((candidate) =>
			candidate.packagePattern.test(component.name),
		);
		if (!rule) continue;
		if (component.license !== rule.expectedLicense) {
			throw new Error(
				`${component.name}@${component.version}: supplemental rule expects ${rule.expectedLicense}, package declares ${component.license}`,
			);
		}
		for (const file of rule.files) {
			const text = normalizeText(await readFile(join(repoRoot, file), "utf8"));
			if (!text)
				throw new Error(
					`${component.name}@${component.version}: supplemental file is empty: ${file}`,
				);
			component.noticeTexts.push({
				file: `${file} (supplemental)`,
				text,
				provenance: `${rule.attribution}; ${rule.reason}`,
			});
		}
	}
	for (const component of components) {
		if (component.noticeTexts.length > 0) continue;
		const rule = DECLARED_LICENSE_FALLBACK_RULES.find((candidate) =>
			candidate.packagePattern.test(component.name),
		);
		if (!rule) continue;
		if (component.version !== rule.expectedVersion) {
			throw new Error(
				`${component.name}@${component.version}: declared-license fallback expects version ${rule.expectedVersion}`,
			);
		}
		if (component.license !== rule.expectedLicense) {
			throw new Error(
				`${component.name}@${component.version}: declared-license fallback expects ${rule.expectedLicense}, package declares ${component.license}`,
			);
		}
		if (component.repository !== rule.expectedRepository) {
			throw new Error(
				`${component.name}@${component.version}: declared-license fallback expects ${rule.expectedRepository}, package declares ${component.repository || "no repository"}`,
			);
		}
		for (const file of rule.files) {
			const text = normalizeText(await readFile(join(repoRoot, file), "utf8"));
			if (!text) {
				throw new Error(
					`${component.name}@${component.version}: declared-license fallback file is empty: ${file}`,
				);
			}
			component.noticeTexts.push({
				file: `${file} (declared-license fallback)`,
				text,
				provenance: `${component.name}@${component.version} package manifest and reviewed package content; ${rule.reason} No copyright holder or year was inferred.`,
			});
		}
	}
	const apacheText = normalizeText(
		await readFile(join(repoRoot, "licenses/Apache-2.0.txt"), "utf8"),
	);
	if (!apacheText)
		throw new Error("Apache-2.0 family text is empty: licenses/Apache-2.0.txt");
	for (const component of components) {
		if (!/\bApache-2\.0\b/i.test(component.license)) continue;
		component.noticeTexts.push({
			file: "licenses/Apache-2.0.txt (standard license family)",
			text: apacheText,
			provenance:
				"Canonical complete Apache-2.0 text from the AWS SDK for JavaScript v3 upstream LICENSE",
		});
	}
	return components;
}

function generateNotices(
	components: Component[],
	options: Options,
	project: PackageManifest,
	lockSha: string,
): string {
	const groups = new Map<
		string,
		{
			text: string;
			files: Set<string>;
			packages: Set<string>;
			provenance: Set<string>;
		}
	>();
	for (const component of components)
		for (const notice of component.noticeTexts) {
			const hash = digest(notice.text);
			const group = groups.get(hash) ?? {
				text: notice.text,
				files: new Set(),
				packages: new Set(),
				provenance: new Set(),
			};
			group.files.add(notice.file);
			group.packages.add(`${component.name}@${component.version}`);
			group.provenance.add(notice.provenance);
			groups.set(hash, group);
		}
	const lines = [
		"# Third-Party Notices",
		"",
		"This file is generated by `bun run supply-chain`. Do not edit it manually.",
		"",
		`Artifact: **${options.artifactName}** (${options.artifactKind}); platform: **${options.platform}**; project version: **${project.version}**.`,
		`Git commit: \`${options.gitSha}\`; \`bun.lock\` SHA-256: \`${lockSha}\`.`,
		"",
		`ATF itself is licensed under ${PROJECT_LICENSE}; see LICENSE.md. Third-party components remain subject to their own licenses. This inventory describes only the named artifact and makes no claim about unrelated production images.`,
		"",
		`Installed third-party package versions: **${components.length}**.`,
		"",
		"## Package inventory",
		"",
		"| Package | Version | Declared license | Text | Compliance |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const component of components)
		lines.push(
			`| ${markdownCell(component.name)} | ${markdownCell(component.version)} | ${markdownCell(component.license)} | yes | ${markdownCell(component.compliance.classification)} |`,
		);
	lines.push("", "## Artifact-specific compliance", "");
	for (const item of [
		...new Map(
			components.map((component) => [
				`${component.compliance.classification}\0${component.compliance.requirement}`,
				component.compliance,
			]),
		).values(),
	].sort((a, b) => stableCompare(a.classification, b.classification))) {
		lines.push(`- **${item.classification}:** ${item.requirement}`);
	}
	lines.push("", "## License and notice texts", "");
	for (const [hash, group] of [...groups.entries()].sort((a, b) =>
		stableCompare(a[0], b[0]),
	)) {
		lines.push(
			`### ${[...group.packages].sort().join(", ")}`,
			"",
			`Source files: ${[...group.files].sort().join(", ")}; provenance: ${[...group.provenance].sort().join(" | ")}; SHA-256: \`${hash}\``,
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
function generateSbom(
	components: Component[],
	options: Options,
	project: PackageManifest,
	lockSha: string,
): string {
	const projectName = project.name ?? "aiperator-trust-fabric";
	const projectVersion = project.version ?? "0.0.0";
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
						version: GENERATOR_VERSION,
					},
				],
			},
			component: {
				type: "application",
				"bom-ref": `pkg:npm/${projectName}@${projectVersion}`,
				group: "Abillify Technology GmbH",
				name: projectName,
				version: projectVersion,
				licenses: [{ expression: PROJECT_LICENSE }],
				purl: `pkg:npm/${projectName}@${projectVersion}`,
			},
			properties: [
				{ name: "atf:inventory:platform", value: options.platform },
				{ name: "atf:artifact:kind", value: options.artifactKind },
				{ name: "atf:artifact:name", value: options.artifactName },
				{ name: "atf:git:sha", value: options.gitSha },
				{ name: "atf:bun-lock:sha256", value: lockSha },
			],
		},
		components: components.map((component) => {
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
				properties: [
					{
						name: "atf:compliance:classification",
						value: component.compliance.classification,
					},
				],
			};
		}),
	};
	return `${JSON.stringify(bom, null, 2)}\n`;
}
async function verifyOrWrite(
	path: string,
	expected: string,
	options: Options,
): Promise<boolean> {
	if (!options.checkOnly) {
		await mkdir(options.outputDir, { recursive: true });
		await Bun.write(path, expected);
		return true;
	}
	let actual: string;
	try {
		actual = await readFile(path, "utf8");
	} catch {
		console.error(`Missing generated artifact: ${path}`);
		return false;
	}
	if (actual !== expected) {
		console.error(`Stale generated artifact: ${path}`);
		return false;
	}
	return true;
}

try {
	const options = parseArgs(process.argv.slice(2));
	const repoRoot = await realpath(process.cwd());
	if (!isAbsolute(options.inventoryRoot))
		throw new Error("--inventory-root must resolve to an absolute path");
	const project = JSON.parse(
		await readFile(join(repoRoot, "package.json"), "utf8"),
	) as PackageManifest;
	if (!project.version) throw new Error("Root package.json has no version");
	const lockSha = digest(await readFile(join(repoRoot, "bun.lock")));
	const components = await loadComponents(options, repoRoot);
	if (components.length === 0)
		throw new Error(
			`No installed third-party packages found under ${join(options.inventoryRoot, "node_modules", ".bun")}`,
		);
	const failures: string[] = [];
	for (const component of components) {
		const identity = `${component.name}@${component.version}`;
		if (component.license === "NOASSERTION")
			failures.push(`${identity}: no license metadata`);
		if (component.noticeTexts.length === 0)
			failures.push(
				`${identity}: no complete license/notice text; add a reviewed repository reuse rule or authoritative package/project-family supplemental rule`,
			);
		if (matches(component.license, DENIED_LICENSE_PATTERNS))
			failures.push(`${identity}: denied license ${component.license}`);
		for (const family of STANDARD_LICENSE_FAMILIES) {
			if (!family.expressionPattern.test(component.license)) continue;
			if (
				!component.noticeTexts.some((notice) =>
					family.textPattern.test(notice.text),
				)
			) {
				failures.push(
					`${identity}: declared ${family.name} family is missing a plausibly complete matching license text`,
				);
			}
		}
	}
	if (failures.length)
		throw new Error(
			`License policy violations (${failures.length}):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
		);
	const noticePath = join(options.outputDir, "THIRD_PARTY_NOTICES.md");
	const sbomPath = join(options.outputDir, "sbom.cdx.json");
	const results = await Promise.all([
		verifyOrWrite(
			noticePath,
			generateNotices(components, options, project, lockSha),
			options,
		),
		verifyOrWrite(
			sbomPath,
			generateSbom(components, options, project, lockSha),
			options,
		),
	]);
	if (results.some((result) => !result)) process.exit(1);
	console.log(
		`${options.checkOnly ? "Verified" : "Generated"} ${relative(repoRoot, noticePath)} and ${relative(repoRoot, sbomPath)} for ${components.length} package versions (${options.artifactName}, ${options.platform}, ${options.gitSha}).`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
