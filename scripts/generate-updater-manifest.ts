// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Erzeugt das Tauri-Updater-Manifest `latest.json` fuer den ATF Extract
 * Outpost (Task 23.4, Anforderungen 14.9/14.10).
 *
 * Laeuft im Job `publish` des Workflows `outpost-release.yml`. Erwartet im
 * Artefakt-Verzeichnis die von `tauri build --config
 * '{"bundle":{"createUpdaterArtifacts":true}}'` erzeugten Updater-Artefakte
 * (`*.nsis.zip`, `*.app.tar.gz`) mit zugehoeriger Minisign-Signatur (`.sig`).
 *
 * Verwendung:
 *   UPDATER_REPO=<owner>/<repo> RELEASE_TAG=outpost-v0.1.0 \
 *     bun run scripts/generate-updater-manifest.ts --dir artifacts --out latest.json
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

type PlatformEntry = { signature: string; url: string };
type Manifest = {
	version: string;
	notes: string;
	pub_date: string;
	platforms: Record<string, PlatformEntry>;
};

/** Tauri-Plattform-Schluessel aus dem Dateinamen des Updater-Artefakts. */
function platformKey(fileName: string): string | undefined {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".nsis.zip")) return "windows-x86_64";
	if (lower.endsWith(".app.tar.gz")) {
		if (
			lower.includes("aarch64") ||
			lower.includes("_aarch64") ||
			lower.includes("-arm64")
		) {
			return "darwin-aarch64";
		}
		if (
			lower.includes("x86_64") ||
			lower.includes("_x64") ||
			lower.includes("-x64")
		) {
			return "darwin-x86_64";
		}
	}
	return undefined;
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(path)));
		else out.push(path);
	}
	return out;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const readArg = (name: string): string => {
		const index = args.indexOf(`--${name}`);
		const value = index >= 0 ? args[index + 1] : undefined;
		if (value === undefined) throw new Error(`--${name} fehlt`);
		return value;
	};
	const dir = readArg("dir");
	const out = readArg("out");
	const repo = process.env.UPDATER_REPO;
	const tag = process.env.RELEASE_TAG;
	if (repo === undefined || repo === "" || tag === undefined || tag === "") {
		throw new Error("UPDATER_REPO und RELEASE_TAG muessen gesetzt sein");
	}
	// App-Version: Tag ohne Praefix "outpost-v" (vergleicht mit version in
	// tauri.conf.json).
	const version = tag.replace(/^outpost-v/, "");

	const files = await walk(dir);
	const platforms: Record<string, PlatformEntry> = {};
	for (const file of files) {
		const fileName = basename(file);
		const key = platformKey(fileName);
		if (key === undefined) continue;
		if (platforms[key] !== undefined) {
			throw new Error(`Mehrdeutiges Updater-Artefakt fuer ${key}: ${fileName}`);
		}
		const signature = (await readFile(`${file}.sig`, "utf8")).trim();
		if (signature === "") throw new Error(`Leere Signatur fuer ${fileName}`);
		platforms[key] = {
			signature,
			url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(fileName)}`,
		};
	}

	const missing = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"].filter(
		(key) => platforms[key] === undefined,
	);
	if (missing.length > 0) {
		throw new Error(
			`Folgende Updater-Plattformen fehlen (Artefakt + .sig): ${missing.join(", ")}`,
		);
	}

	const manifest: Manifest = {
		version,
		notes: `ATF Extract Outpost ${version}`,
		pub_date: new Date().toISOString(),
		platforms,
	};
	await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(
		`latest.json geschrieben: ${out} (${Object.keys(platforms).length} Plattformen)`,
	);
}

await main();
