// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isLocked, parseLockedPackages } from "./bun-lock-identities.ts";

const PROJECT_LICENSE = "Elastic-2.0";
const PROJECT_AUTHOR = "Abillify Technology GmbH <info@abillify.me>";
const GENERATOR_VERSION = "3.1.0";
const APACHE_2_0_SHA256 =
	"283ea6cc2997a1a70da0049e09adf9317bb60ca1b51279b65196b83a69e1996b";
// "unlicense" is the canonical public-domain dedication file name used by
// crates such as byteorder; it is a license text like any LICENSE variant.
const NOTICE_NAMES = /^(?:licen[cs]e|copying|notice|unlicense)(?:[._-].*)?$/i;
const CARGO_MANIFEST = "apps/outpost-desktop/src-tauri/Cargo.toml";
const CARGO_LOCKFILE = "apps/outpost-desktop/src-tauri/Cargo.lock";

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
	includeCargo: boolean;
};

type PackageManifest = {
	name?: string;
	version?: string;
	license?: string | { type?: string };
	licenses?: Array<string | { type?: string }>;
	repository?: string | { url?: string; directory?: string };
};

type Ecosystem = "npm" | "cargo";
type NoticeText = { file: string; text: string; provenance: string };
type Component = {
	name: string;
	version: string;
	license: string;
	repository: string;
	packageRoot: string;
	noticeTexts: NoticeText[];
	compliance: Compliance;
	ecosystem: Ecosystem;
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
type ExpressionLicenseSupplementRule = {
	packagePattern: RegExp;
	expectedVersion: string;
	expectedLicense: string;
	expectedRepository: string;
	files: string[];
	attribution: string;
	reason: string;
};
type StandardLicenseFamily = {
	id: string;
	textPattern: RegExp;
};
type LicenseExpression =
	| { type: "id"; id: string }
	| { type: "and" | "or"; left: LicenseExpression; right: LicenseExpression };

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
		packagePattern: /^@nodable\/entities$/,
		expectedLicense: "MIT",
		files: ["licenses/nodable-entities-MIT.txt"],
		attribution: "nodable/val-parsers upstream LICENSE",
		reason:
			"The published package is built from the nodable/val-parsers repository and omits its repository-wide license file.",
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
		packagePattern: /^@esbuild\/[a-z0-9-]+$/,
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/evanw/esbuild",
		sourcePackagePattern: /^esbuild$/,
		allowedSourceFiles: /^LICENSE\.md$/i,
		reason:
			"esbuild platform binaries are published from the esbuild repository and use its repository-root MIT license.",
	},
	{
		packagePattern: /^@rollup\/rollup-[a-z0-9-]+$/,
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/rollup/rollup",
		sourcePackagePattern: /^rollup$/,
		allowedSourceFiles: /^LICENSE\.md$/i,
		reason:
			"Rollup native bindings are published from the rollup repository and use its repository-root MIT license.",
	},
	{
		packagePattern: /^@tauri-apps\/cli-[a-z0-9-]+$/,
		expectedLicense: "Apache-2.0 OR MIT",
		expectedRepository: "https://github.com/tauri-apps/tauri",
		sourcePackagePattern: /^@tauri-apps\/cli$/,
		allowedSourceFiles: /^LICENSE[_-](?:MIT|APACHE-2\.0)$/i,
		reason:
			"Tauri CLI platform binaries use the dual-license files of the Tauri repository (named LICENSE_MIT / LICENSE_APACHE-2.0 up to 2.8, LICENSE-MIT / LICENSE-APACHE-2.0 from 2.12).",
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
		packagePattern: /^@napi-rs\/lzma-linux-x64-gnu$/,
		expectedVersion: "1.5.1",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/brooooooklyn/lzma",
		files: ["licenses/declared-MIT-no-upstream-copyright.txt"],
		reason:
			"The exact package manifest declares MIT, but the published 1.5.1 tarball ships only package.json, README.md and the native binary, and the upstream Brooooooklyn/lzma tree at tag v1.5.1 has no license file or copyright notice; the package is a Linux x64 glibc optional dependency of rollup.",
	},
	{
		packagePattern: /^bun-types$/,
		expectedVersion: "1.4.0",
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
	{
		packagePattern:
			/^@oxc-parser\/binding-(?:darwin-arm64|linux-x64-gnu|linux-x64-musl)$/,
		expectedVersion: "0.155.0",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/oxc-project/oxc",
		files: ["licenses/declared-MIT-no-upstream-copyright.txt"],
		reason:
			"Optional native dependency of knip: the exact package manifest declares MIT, but the published binary tarball ships only package.json and the native .node binary, and the upstream oxc tree keeps its license text at the repository root rather than in the platform binary package.",
	},
	{
		packagePattern:
			/^@oxc-resolver\/binding-(?:darwin-arm64|linux-x64-gnu|linux-x64-musl)$/,
		expectedVersion: "11.24.2",
		expectedLicense: "MIT",
		expectedRepository: "https://github.com/oxc-project/oxc-resolver",
		files: ["licenses/declared-MIT-no-upstream-copyright.txt"],
		reason:
			"Optional native dependency of knip: the exact package manifest declares MIT, but the published binary tarball ships only package.json, a stub README and the native .node binary, and the upstream oxc-resolver tree keeps its license text at the repository root rather than in the platform binary package.",
	},
];

const EXPRESSION_LICENSE_SUPPLEMENT_RULES: ExpressionLicenseSupplementRule[] = [
	{
		packagePattern: /^type-fest$/,
		expectedVersion: "0.20.2",
		expectedLicense: "(MIT OR CC0-1.0)",
		expectedRepository: "sindresorhus/type-fest",
		files: ["licenses/CC0-1.0.txt"],
		attribution: "Creative Commons CC0 1.0 Universal legal code",
		reason:
			"The published package supplies the MIT branch but omits the CC0-1.0 branch of its declared expression.",
	},
];

const STANDARD_LICENSE_FAMILIES: StandardLicenseFamily[] = [
	{
		id: "Apache-2.0",
		textPattern:
			/Apache License[\s\S]*Version 2\.0[\s\S]*TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION[\s\S]*END OF TERMS AND CONDITIONS/i,
	},
	{
		id: "MIT",
		// The optional "(including the next paragraph)" clause is the modern
		// canonical MIT wording used by many crates (e.g. bytemuck).
		textPattern:
			/^(?=[\s\S]*Permission is hereby granted, free of charge,)(?=[\s\S]*The above copyright notice and this permission notice(?: \(including the next paragraph\))?\s+shall be[\s\S]*included)(?=[\s\S]*THE SOFTWARE IS PROVIDED [“"']AS IS[”"'])[\s\S]*$/i,
	},
	{
		id: "MIT-0",
		textPattern:
			/MIT No Attribution \(MIT-0\)[\s\S]*Permission is hereby granted, free of charge,[\s\S]*THE SOFTWARE IS PROVIDED [“"']AS IS[”"']/i,
	},
	{
		id: "0BSD",
		textPattern:
			/Permission to use, copy, modify, and\/or distribute this software for any[\s\S]*purpose with or without fee is hereby granted\.[\s\S]*THE SOFTWARE IS PROVIDED [“"']AS IS[”"']/i,
	},
	{
		id: "ISC",
		textPattern:
			/^(?=[\s\S]*Permission to use, copy, modify, and\/or distribute this software[\s\S]*with or without fee is hereby granted, provided that)(?=[\s\S]*copyright notice[\s\S]*and this permission notice appear in all copies)(?=[\s\S]*THE SOFTWARE IS PROVIDED [“"']AS IS[”"'])[\s\S]*$/i,
	},
	{
		id: "BSD-2-Clause",
		textPattern:
			/^(?![\s\S]*(?:Neither[\s\S]*may\s+be\s+used\s+to|may\s+not\s+be\s+used\s+to)[\s\S]*endorse or promote)(?=[\s\S]*Redistribution and use in source and binary forms)(?=[\s\S]*Redistributions? of source code)(?=[\s\S]*Redistributions? in binary form)(?=[\s\S]*THIS (?:SOFTWARE )?IS PROVIDED)[\s\S]*$/i,
	},
	{
		id: "BSD-3-Clause",
		textPattern:
			/^(?=[\s\S]*Redistribution and use in source and binary forms)(?=[\s\S]*Redistributions? of source code)(?=[\s\S]*Redistributions? in binary form)(?=[\s\S]*(?:Neither[\s\S]*may\s+be\s+used\s+to|may\s+not\s+be\s+used\s+to)[\s\S]*endorse or promote)(?=[\s\S]*THIS (?:SOFTWARE )?IS PROVIDED)[\s\S]*$/i,
	},
	{
		id: "MPL-2.0",
		textPattern: /Mozilla Public License,? version 2\.0[\s\S]*1\. Definitions/i,
	},
	{
		id: "LGPL-3.0-or-later",
		textPattern:
			/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]*Version 3[\s\S]*GNU GENERAL PUBLIC LICENSE/i,
	},
	{
		id: "CC-BY-4.0",
		textPattern:
			/Creative Commons Attribution 4\.0 International Public License/i,
	},
	{
		id: "AFL-2.1",
		textPattern:
			/The Academic Free License, v\. 2\.1:[\s\S]*Grant of Copyright License[\s\S]*This license is Copyright \(C\) 2003-2004 Lawrence E\. Rosen/i,
	},
	{
		id: "CC0-1.0",
		textPattern:
			/CC0 1\.0 Universal[\s\S]*Statement of Purpose[\s\S]*1\. Copyright and Related Rights[\s\S]*2\. Waiver[\s\S]*3\. Public License Fallback[\s\S]*4\. Limitations and Disclaimers/i,
	},
	{
		// Permissive with an express patent grant; the only duty is passing on
		// the license text or its link, which the notices do (lru-cache 11 via jsdom).
		id: "BlueOak-1.0.0",
		textPattern:
			/Blue Oak Model License[\s\S]*Version 1\.0\.0[\s\S]*## Purpose[\s\S]*## Copyright[\s\S]*## Notices[\s\S]*## Patent[\s\S]*## No Liability/i,
	},
	// Families below occur in the Rust (crates.io) dependency graph of
	// Outpost Desktop (Requirement 10.7, Task 14.4).
	{
		id: "Zlib",
		textPattern:
			/^(?=[\s\S]*This software is provided 'as-is')(?=[\s\S]*The origin of this software must not be misrepresented)(?=[\s\S]*[Aa]ltered [Ss]ource versions must be plainly marked)(?=[\s\S]*[Tt]his notice may not be removed or altered)[\s\S]*$/i,
	},
	{
		id: "Unicode-3.0",
		textPattern:
			/UNICODE LICENSE V3[\s\S]*COPYRIGHT AND PERMISSION NOTICE[\s\S]*Permission is hereby granted, free of charge[\s\S]*THE DATA FILES AND SOFTWARE ARE PROVIDED ["']AS IS["']/i,
	},
	{
		id: "Unlicense",
		textPattern:
			/This is free and unencumbered software released into the public domain\.[\s\S]*Anyone is free to copy, modify, publish[\s\S]*dedicate any and all copyright interest[\s\S]*THE SOFTWARE IS PROVIDED ["']AS IS["']/i,
	},
	{
		id: "CDLA-Permissive-2.0",
		textPattern:
			/Community Data License Agreement - Permissive - Version 2\.0[\s\S]*1\. Provision of the Data[\s\S]*2\. Conditions for Sharing Data[\s\S]*3\. No Restrictions on Results/i,
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

const ALLOWED_LICENSE_IDS = new Set(
	STANDARD_LICENSE_FAMILIES.map((family) => family.id),
);
const ALLOWED_LICENSE_EXPRESSIONS = new Map<string, string>([
	["id:Apache-2.0", "Apache-2.0"],
	["id:MIT", "MIT"],
	["id:MIT-0", "MIT-0"],
	["id:0BSD", "0BSD"],
	["id:ISC", "ISC"],
	["id:BSD-2-Clause", "BSD-2-Clause"],
	["id:BSD-3-Clause", "BSD-3-Clause"],
	["id:MPL-2.0", "MPL-2.0"],
	["id:LGPL-3.0-or-later", "LGPL-3.0-or-later"],
	["id:CC-BY-4.0", "CC-BY-4.0"],
	// Dev-only dependencies of jsdom 30 (Control tests): lru-cache 11 and mdn-data.
	["id:BlueOak-1.0.0", "BlueOak-1.0.0"],
	["id:CC0-1.0", "CC0-1.0"],
	["and(id:MIT,id:ISC)", "MIT AND ISC"],
	["or(id:MIT,id:Apache-2.0)", "MIT OR Apache-2.0"],
	// Same dual license, operand order as declared by the Tauri packages.
	["or(id:Apache-2.0,id:MIT)", "Apache-2.0 OR MIT"],
	["or(id:AFL-2.1,id:BSD-3-Clause)", "(AFL-2.1 OR BSD-3-Clause)"],
	["or(id:MIT,id:CC0-1.0)", "(MIT OR CC0-1.0)"],
	// Expressions from the Rust dependency graph of Outpost Desktop
	// (crates.io manifests, normalized; Requirement 10.7, Task 14.4).
	// The operand order follows the declared manifest strings.
	["id:Zlib", "Zlib"],
	["id:Unicode-3.0", "Unicode-3.0"],
	["id:Unlicense", "Unlicense"],
	["id:CDLA-Permissive-2.0", "CDLA-Permissive-2.0"],
	[
		"and(or(id:MIT,id:Apache-2.0),id:Unicode-3.0)",
		"(MIT OR Apache-2.0) AND Unicode-3.0",
	],
	["or(or(id:0BSD,id:MIT),id:Apache-2.0)", "0BSD OR MIT OR Apache-2.0"],
	["and(id:Apache-2.0,id:ISC)", "Apache-2.0 AND ISC"],
	["and(id:Apache-2.0,id:MIT)", "Apache-2.0 AND MIT"],
	["or(or(id:Apache-2.0,id:ISC),id:MIT)", "Apache-2.0 OR ISC OR MIT"],
	[
		"or(or(id:BSD-2-Clause,id:Apache-2.0),id:MIT)",
		"BSD-2-Clause OR Apache-2.0 OR MIT",
	],
	["and(id:BSD-3-Clause,id:MIT)", "BSD-3-Clause AND MIT"],
	[
		"or(or(id:BSD-3-Clause,id:MIT),id:Apache-2.0)",
		"BSD-3-Clause OR MIT OR Apache-2.0",
	],
	["or(id:BSD-3-Clause,id:MIT)", "BSD-3-Clause OR MIT"],
	[
		"or(or(id:CC0-1.0,id:MIT-0),id:Apache-2.0)",
		"CC0-1.0 OR MIT-0 OR Apache-2.0",
	],
	["or(or(id:MIT,id:Apache-2.0),id:Zlib)", "MIT OR Apache-2.0 OR Zlib"],
	["or(or(id:MIT,id:Zlib),id:Apache-2.0)", "MIT OR Zlib OR Apache-2.0"],
	["or(id:Unlicense,id:MIT)", "Unlicense OR MIT"],
	["or(or(id:Zlib,id:Apache-2.0),id:MIT)", "Zlib OR Apache-2.0 OR MIT"],
]);

type LicenseToken =
	| { type: "id"; value: string; offset: number }
	| { type: "and" | "or" | "left" | "right"; offset: number };

function tokenizeLicenseExpression(value: string): LicenseToken[] {
	const tokens: LicenseToken[] = [];
	let offset = 0;
	while (offset < value.length) {
		if (/\s/.test(value[offset])) {
			offset++;
			continue;
		}
		if (value[offset] === "(" || value[offset] === ")") {
			tokens.push({
				type: value[offset] === "(" ? "left" : "right",
				offset,
			});
			offset++;
			continue;
		}
		const match = value.slice(offset).match(/^[A-Za-z0-9][A-Za-z0-9.-]*/);
		if (!match)
			throw new Error(
				`invalid SPDX syntax at offset ${offset}: ${JSON.stringify(value[offset])}`,
			);
		const tokenValue = match[0];
		if (tokenValue === "AND" || tokenValue === "OR") {
			tokens.push({
				type: tokenValue === "AND" ? "and" : "or",
				offset,
			});
		} else {
			if (tokenValue === "WITH" || tokenValue.startsWith("LicenseRef-"))
				throw new Error(`${tokenValue} is not permitted`);
			if (!ALLOWED_LICENSE_IDS.has(tokenValue)) {
				const diagnostic = matches(tokenValue, DENIED_LICENSE_PATTERNS)
					? "denied"
					: "unknown or unsupported";
				throw new Error(`${diagnostic} SPDX license identifier ${tokenValue}`);
			}
			tokens.push({ type: "id", value: tokenValue, offset });
		}
		offset += tokenValue.length;
	}
	if (tokens.length === 0) throw new Error("empty SPDX license expression");
	return tokens;
}

function licenseExpressionKey(expression: LicenseExpression): string {
	if (expression.type === "id") return `id:${expression.id}`;
	return `${expression.type}(${licenseExpressionKey(expression.left)},${licenseExpressionKey(expression.right)})`;
}

function parseLicenseExpression(value: string): LicenseExpression {
	const tokens = tokenizeLicenseExpression(value);
	let index = 0;
	const parsePrimary = (): LicenseExpression => {
		const token = tokens[index];
		if (!token) throw new Error("incomplete SPDX license expression");
		if (token.type === "id") {
			index++;
			return { type: "id", id: token.value };
		}
		if (token.type !== "left")
			throw new Error(
				`expected a license identifier at offset ${token.offset}`,
			);
		index++;
		const expression = parseOr();
		const closing = tokens[index];
		if (closing?.type !== "right")
			throw new Error(`unclosed parenthesis at offset ${token.offset}`);
		index++;
		return expression;
	};
	const parseAnd = (): LicenseExpression => {
		let expression = parsePrimary();
		while (tokens[index]?.type === "and") {
			index++;
			expression = {
				type: "and",
				left: expression,
				right: parsePrimary(),
			};
		}
		return expression;
	};
	const parseOr = (): LicenseExpression => {
		let expression = parseAnd();
		while (tokens[index]?.type === "or") {
			index++;
			expression = {
				type: "or",
				left: expression,
				right: parseAnd(),
			};
		}
		return expression;
	};
	const expression = parseOr();
	const trailing = tokens[index];
	if (trailing)
		throw new Error(`unexpected token at offset ${trailing.offset}`);
	return expression;
}

function canonicalLicenseExpression(value: string): string {
	const expression = parseLicenseExpression(value);
	const canonical = ALLOWED_LICENSE_EXPRESSIONS.get(
		licenseExpressionKey(expression),
	);
	if (!canonical)
		throw new Error(
			`SPDX expression is not allowlisted: ${JSON.stringify(value.trim())}`,
		);
	return canonical;
}

function licenseIds(value: string): Set<string> {
	const ids = new Set<string>();
	const visit = (expression: LicenseExpression): void => {
		if (expression.type === "id") {
			ids.add(expression.id);
			return;
		}
		visit(expression.left);
		visit(expression.right);
	};
	visit(parseLicenseExpression(value));
	return ids;
}

// crates.io manifests sometimes declare licenses in conventions that are not
// valid SPDX expressions (Task 14.4, Requirement 10.7):
// - "A/B": "/" means OR (crates.io convention, e.g. "MIT/Apache-2.0").
// - "Apache-2.0 WITH LLVM-exception": the exception only adds extra
//   permissions; the crate archives ship the plain Apache-2.0 text,
//   which is fully covered by the SPDX family Apache-2.0.
// - "LGPL-2.1-or-later" as a third branch next to MIT/Apache-2.0 (r-efi):
//   a license choice of the licensee; ATF uses the MIT/Apache branch, so
//   the LGPL branch is dropped here (it would otherwise be blocked by policy).
// Empty segments after removing operands are consolidated;
// parenthesized expressions such as "(MIT OR Apache-2.0) AND Unicode-3.0" stay
// unchanged.
function normalizeRustLicenseExpression(value: string): string {
	const withoutExceptions = value.replace(/\bWITH\b\s+\S+/gi, " ");
	const withOr = withoutExceptions.replaceAll("/", " OR ");
	const withoutLgplElection = withOr.replace(/\bLGPL-2\.1-or-later\b/gi, " ");
	const collapsed = withoutLgplElection
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\s+(?:AND|OR)\s+(?=(?:AND|OR)\b)/gi, " ")
		.replace(/^(?:AND|OR)\s+/i, "")
		.replace(/\s+(?:AND|OR)$/i, "")
		.trim();
	return dedupeTopLevelOrOperands(collapsed);
}

// After removing a WITH exception an operand can appear twice
// (e.g. "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT"). Deduplicates
// only operands at parenthesis depth 0; parenthesized subexpressions stay intact.
function dedupeTopLevelOrOperands(value: string): string {
	const segments: string[][] = [];
	let current: string[] = [];
	let depth = 0;
	for (const token of value.split(" ")) {
		if (token === "(") depth++;
		if (token === ")") depth--;
		if (token === "OR" && depth === 0) {
			segments.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	segments.push(current);
	if (segments.length < 2) return value;
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const segment of segments) {
		const key = segment.join(" ");
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(key);
	}
	return kept.join(" OR ");
}

// Crate license texts are often wrapped differently from the canonical
// SPDX wording (e.g. adler2 0BSD, libloading ISC). For Cargo
// components the family pattern is additionally checked against a
// whitespace-normalized copy; the inventory text stays unchanged.
function noticeMatchesFamily(
	component: Component,
	family: StandardLicenseFamily,
	notice: NoticeText,
): boolean {
	if (family.textPattern.test(notice.text)) return true;
	if (component.ecosystem !== "cargo") return false;
	return family.textPattern.test(notice.text.replace(/\s+/g, " "));
}

const MPL_SOURCE_BY_VERSION = new Map([
	[
		"1.30.2",
		"https://github.com/parcel-bundler/lightningcss/archive/400f705e63e139c326f480aed11e1416f5a3a61f.tar.gz",
	],
	[
		"1.32.0",
		"https://github.com/parcel-bundler/lightningcss/archive/7f8a861bdee476fe90c89a8badeb3fd33a99c51a.tar.gz",
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
		if (
			arg === "--check" ||
			arg === "--assert-host-platform" ||
			arg === "--include-cargo"
		) {
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
		includeCargo: flags.has("--include-cargo"),
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
	ecosystem: Ecosystem,
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
		if (ecosystem === "cargo") {
			return {
				classification: "MPL file-level source",
				requirement: `The unmodified crates.io archive of ${name}@${version}, pinned by the Cargo.lock checksum recorded in this inventory, is the corresponding source under MPL-2.0. Retain the MPL-2.0 text and the pinned archive; publish covered-file modifications if that status changes.`,
			};
		}
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
	// bun.lock decides what the product ships: an installed package it does not
	// lock (a removed dependency whose store directory survived) is not part of
	// the inventory.
	const locked = parseLockedPackages(
		await readFile(join(repoRoot, "bun.lock"), "utf8"),
	);
	// Fail closed: a lockfile format the parser does not understand would
	// otherwise drop every npm component and ship an empty inventory.
	if (locked.identities.size === 0 && locked.nonRegistryNames.size === 0) {
		throw new Error(
			"bun.lock: no locked packages found; refusing to generate an inventory without npm components",
		);
	}
	const notLocked = new Set<string>();
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
		if (!isLocked(locked, manifest.name, manifest.version)) {
			notLocked.add(identity);
			continue;
		}
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
		const declaredLicense = licenseValue(manifest);
		let license: string;
		try {
			license = canonicalLicenseExpression(declaredLicense);
		} catch (error) {
			discoveryErrors.push(
				`${identity}: invalid or disallowed license ${JSON.stringify(declaredLicense)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
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
				"npm",
			),
			ecosystem: "npm",
		});
	}
	if (notLocked.size > 0) {
		console.warn(
			`ignored ${notLocked.size} installed packages not in bun.lock`,
		);
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
	for (const component of components) {
		const rule = EXPRESSION_LICENSE_SUPPLEMENT_RULES.find((candidate) =>
			candidate.packagePattern.test(component.name),
		);
		if (!rule) continue;
		if (component.version !== rule.expectedVersion) {
			throw new Error(
				`${component.name}@${component.version}: expression supplement expects version ${rule.expectedVersion}`,
			);
		}
		if (component.license !== rule.expectedLicense) {
			throw new Error(
				`${component.name}@${component.version}: expression supplement expects ${rule.expectedLicense}, package declares ${component.license}`,
			);
		}
		if (component.repository !== rule.expectedRepository) {
			throw new Error(
				`${component.name}@${component.version}: expression supplement expects ${rule.expectedRepository}, package declares ${component.repository || "no repository"}`,
			);
		}
		for (const file of rule.files) {
			const text = normalizeText(await readFile(join(repoRoot, file), "utf8"));
			if (!text)
				throw new Error(
					`${component.name}@${component.version}: expression supplement file is empty: ${file}`,
				);
			component.noticeTexts.push({
				file: `${file} (expression supplement)`,
				text,
				provenance: `${rule.attribution}; ${rule.reason}`,
			});
		}
	}
	return components;
}

// Fallback files for license branches a crate manifest declares but whose
// crates.io archive ships no matching text.
// Apache-2.0 is deliberately missing here: the canonical text is injected
// centrally for all ecosystems.
const RUST_DECLARED_FALLBACK_FILES = new Map<string, string>([
	["MIT", "licenses/declared-MIT-no-upstream-copyright.txt"],
	["MIT-0", "licenses/rust-declared-MIT-0-no-upstream-copyright.txt"],
	["Zlib", "licenses/rust-declared-Zlib-no-upstream-copyright.txt"],
	[
		"BSD-3-Clause",
		"licenses/rust-declared-BSD-3-Clause-no-upstream-copyright.txt",
	],
	["MPL-2.0", "licenses/rust-declared-MPL-2.0-no-upstream-copyright.txt"],
]);

type CargoMetadataPackage = {
	name: string;
	version: string;
	license?: string | null;
	repository?: string | null;
	source?: string | null;
	manifest_path?: string;
};

// Loads the Rust dependencies from Cargo.lock/Cargo.toml of Outpost Desktop
// (Requirement 10.7, Task 14.4). Requires `cargo fetch --locked` so the
// license texts of the crate archives are in the local registry cache.
async function loadCargoComponents(
	repoRoot: string,
	options: Options,
): Promise<Component[]> {
	let metadata: { packages?: CargoMetadataPackage[] };
	try {
		const proc = Bun.spawn(
			[
				"cargo",
				"metadata",
				"--manifest-path",
				CARGO_MANIFEST,
				"--locked",
				"--format-version",
				"1",
			],
			{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		if (proc.exitCode !== 0)
			throw new Error(`exit code ${proc.exitCode}: ${stderr.trim()}`);
		metadata = JSON.parse(stdout) as { packages?: CargoMetadataPackage[] };
	} catch (error) {
		throw new Error(
			`cargo metadata failed for ${CARGO_MANIFEST}: ${error instanceof Error ? error.message : String(error)}. Install cargo and run \`cargo fetch --locked --manifest-path ${CARGO_MANIFEST}\` before --include-cargo.`,
		);
	}
	const discoveryErrors: string[] = [];
	const components: Component[] = [];
	const seen = new Set<string>();
	const registryPackages = (metadata.packages ?? [])
		.filter((pkg) => (pkg.source ?? "").startsWith("registry+"))
		.sort((a, b) =>
			stableCompare(`${a.name}@${a.version}`, `${b.name}@${b.version}`),
		);
	if (registryPackages.length === 0)
		throw new Error(
			`cargo metadata returned no registry packages for ${CARGO_MANIFEST}`,
		);
	for (const pkg of registryPackages) {
		const identity = `${pkg.name}@${pkg.version}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		const declaredLicense = (pkg.license ?? "").trim();
		if (!declaredLicense) {
			discoveryErrors.push(`${identity}: crate manifest declares no license`);
			continue;
		}
		let license: string;
		try {
			license = canonicalLicenseExpression(
				normalizeRustLicenseExpression(declaredLicense),
			);
		} catch (error) {
			discoveryErrors.push(
				`${identity}: invalid or disallowed license ${JSON.stringify(declaredLicense)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		const packageRoot = (pkg.manifest_path ?? "").replace(
			/[\\/]Cargo\.toml$/,
			"",
		);
		const noticeTexts: NoticeText[] = [];
		if (!packageRoot) {
			discoveryErrors.push(`${identity}: cargo metadata has no manifest path`);
			continue;
		}
		let packageEntries: Dirent[];
		try {
			packageEntries = await readdir(packageRoot, { withFileTypes: true });
		} catch (error) {
			discoveryErrors.push(
				`${packageRoot}: cannot read crate directory (run cargo fetch --locked): ${error instanceof Error ? error.message : String(error)}`,
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
		components.push({
			name: pkg.name,
			version: pkg.version,
			license,
			repository: (pkg.repository ?? "").toLowerCase(),
			packageRoot,
			noticeTexts,
			compliance: complianceFor(
				pkg.name,
				pkg.version,
				license,
				options.artifactKind,
				"cargo",
			),
			ecosystem: "cargo",
		});
	}
	// For every declared license branch without a matching text in the crate archive
	// the reviewed fallback text is added without an invented copyright holder.
	for (const component of components) {
		const identity = `${component.name}@${component.version}`;
		const declaredIds = licenseIds(component.license);
		for (const family of STANDARD_LICENSE_FAMILIES) {
			if (!declaredIds.has(family.id) || family.id === "Apache-2.0") continue;
			if (
				component.noticeTexts.some((notice) =>
					noticeMatchesFamily(component, family, notice),
				)
			)
				continue;
			const file = RUST_DECLARED_FALLBACK_FILES.get(family.id);
			if (!file) {
				discoveryErrors.push(
					`${identity}: declared ${family.id} branch has no crate text and no reviewed Rust fallback file`,
				);
				continue;
			}
			const text = normalizeText(await readFile(join(repoRoot, file), "utf8"));
			if (!text)
				throw new Error(
					`${identity}: Rust declared-license fallback file is empty: ${file}`,
				);
			component.noticeTexts.push({
				file: `${file} (declared-license fallback)`,
				text,
				provenance: `${identity} crate manifest pinned by Cargo.lock declares ${family.id}; the published crates.io archive omits that license branch. No copyright holder or year was inferred.`,
			});
		}
	}
	if (discoveryErrors.length > 0) {
		throw new Error(
			`Crate discovery failed (${discoveryErrors.length}):\n${discoveryErrors.map((error) => `  - ${error}`).join("\n")}`,
		);
	}
	return components;
}

function generateNotices(
	components: Component[],
	options: Options,
	project: PackageManifest,
	lockSha: string,
	cargoLockSha: string,
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
		`Git commit: \`${options.gitSha}\`; \`bun.lock\` SHA-256: \`${lockSha}\`.${cargoLockSha ? ` \`Cargo.lock\` SHA-256: \`${cargoLockSha}\`.` : ""}`,
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
function licenseEntry(value: string): { expression: string } {
	return { expression: value };
}
function purl(ecosystem: Ecosystem, name: string, version: string): string {
	const type = ecosystem === "cargo" ? "cargo" : "npm";
	return `pkg:${type}/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}
function generateSbom(
	components: Component[],
	options: Options,
	project: PackageManifest,
	lockSha: string,
	cargoLockSha: string,
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
				...(cargoLockSha
					? [{ name: "atf:cargo-lock:sha256", value: cargoLockSha }]
					: []),
			],
		},
		components: components.map((component) => {
			const packageUrl = purl(
				component.ecosystem,
				component.name,
				component.version,
			);
			const slash =
				component.ecosystem === "npm" && component.name.startsWith("@")
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
	let cargoLockSha = "";
	if (options.includeCargo) {
		cargoLockSha = digest(await readFile(join(repoRoot, CARGO_LOCKFILE)));
		const cargoComponents = await loadCargoComponents(repoRoot, options);
		components.push(...cargoComponents);
		components.sort(
			(a, b) =>
				stableCompare(a.name, b.name) ||
				stableCompare(a.version, b.version) ||
				stableCompare(a.ecosystem, b.ecosystem),
		);
	}
	const apacheSource = await readFile(
		join(repoRoot, "licenses/Apache-2.0.txt"),
	);
	const apacheDigest = digest(apacheSource);
	if (apacheDigest !== APACHE_2_0_SHA256)
		throw new Error(
			`Canonical Apache-2.0 text SHA-256 mismatch: expected ${APACHE_2_0_SHA256}, received ${apacheDigest}`,
		);
	const apacheText = normalizeText(apacheSource.toString("utf8"));
	if (!apacheText)
		throw new Error("Apache-2.0 family text is empty: licenses/Apache-2.0.txt");
	for (const component of components) {
		if (!licenseIds(component.license).has("Apache-2.0")) continue;
		component.noticeTexts.push({
			file: "licenses/Apache-2.0.txt (standard license family)",
			text: apacheText,
			provenance:
				"Canonical Apache License 2.0 standard text; package-specific NOTICE files remain separate",
		});
	}
	const failures: string[] = [];
	for (const component of components) {
		const identity = `${component.ecosystem}:${component.name}@${component.version}`;
		if (component.noticeTexts.length === 0)
			failures.push(
				`${identity}: no complete license/notice text; add a reviewed repository reuse rule or authoritative package/project-family supplemental rule`,
			);
		const declaredIds = licenseIds(component.license);
		for (const family of STANDARD_LICENSE_FAMILIES) {
			if (!declaredIds.has(family.id)) continue;
			if (
				!component.noticeTexts.some((notice) =>
					noticeMatchesFamily(component, family, notice),
				)
			) {
				failures.push(
					`${identity}: declared ${family.id} family is missing a plausibly complete matching license text`,
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
			generateNotices(components, options, project, lockSha, cargoLockSha),
			options,
		),
		verifyOrWrite(
			sbomPath,
			generateSbom(components, options, project, lockSha, cargoLockSha),
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
