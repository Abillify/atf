// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Release preflight: run the CI gates locally before pushing a release branch.
 *
 * Local gates and CI diverge in three known ways, and each one has produced a
 * red CI run on `main` before: the local Bun can differ from the version
 * pinned in `packageManager` (budgets and bundles are measured with the pinned
 * one), `supply-chain:check` is only meaningful inside a linux/amd64
 * container, and the secret scan in CI covers the commits since the last tag.
 * This script runs the same gates in order, stops at the first failure with
 * exit 1, and prints a summary table of every step at the end.
 *
 * Usage:
 *   bun run scripts/release-preflight.ts [--skip <name>]... [--container] [--workdir <path>]
 *
 *   --skip <name>    omit a step (repeatable; the step name is the script
 *                    name, e.g. --skip knip --skip gitleaks)
 *   --container      also run the supply-chain inventory check in a
 *                    linux/amd64 Docker container (needs Docker and cargo
 *                    access; slow)
 *   --workdir <path> container copy target (default ${TMPDIR}/atf-preflight-<pid>)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** A preflight step: a name for `--skip` and the command to run. */
export interface Step {
	name: string;
	cmd: string[];
	/**
	 * Run through the pinned Bun via `npx` when the local Bun differs from
	 * the pin, so the measurement matches CI.
	 */
	pinnedBun?: boolean;
}

// keep in sync with DEVELOPMENT.md "CI gates"
//
// `supply-chain:check` and the gitleaks line of that list are deliberately
// absent: this script runs them as dedicated steps (the secret scan scoped to
// the commits since the last tag, the inventory check only in a container).
const CI_GATES: Step[] = [
	{ name: "verify:public", cmd: ["bun", "run", "verify:public"] },
	{ name: "verify:spdx", cmd: ["bun", "run", "verify:spdx"] },
	{ name: "verify:version", cmd: ["bun", "run", "verify:version"] },
	{ name: "config-reference:check", cmd: ["bun", "run", "config-reference:check"] },
	{ name: "flow-reference:check", cmd: ["bun", "run", "flow-reference:check"] },
	{ name: "route-reference:check", cmd: ["bun", "run", "route-reference:check"] },
	{ name: "openapi:check", cmd: ["bun", "run", "openapi:check"] },
	{ name: "check:links", cmd: ["bun", "run", "check:links"] },
	{ name: "check:workspace-counts", cmd: ["bun", "run", "check:workspace-counts"] },
	{ name: "check:raw-fetch", cmd: ["bun", "run", "check:raw-fetch"] },
	{ name: "check:flow-versions", cmd: ["bun", "run", "check:flow-versions"] },
	{ name: "coverage:security", cmd: ["bun", "run", "coverage:security"] },
	{ name: "knip", cmd: ["bun", "run", "knip"] },
	{ name: "lint:baseline", cmd: ["bun", "run", "lint:baseline"] },
	{ name: "typecheck", cmd: ["bun", "run", "typecheck"] },
	{ name: "test", cmd: ["bun", "run", "test"] },
	{ name: "test:contracts", cmd: ["bun", "run", "test:contracts"] },
	{ name: "build", cmd: ["bun", "run", "build"] },
	{ name: "check:budgets:ci", cmd: ["bun", "run", "check:budgets:ci"], pinnedBun: true },
];

export interface PreflightOptions {
	skip: Set<string>;
	container: boolean;
	workdir: string | undefined;
}

/** Parse the CLI arguments. Throws on an unknown flag or a missing value. */
export function parseArgs(argv: string[]): PreflightOptions {
	const skip = new Set<string>();
	let container = false;
	let workdir: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--container") {
			container = true;
		} else if (arg === "--skip") {
			const name = argv[++i];
			if (name === undefined || name.startsWith("--")) {
				throw new Error("--skip requires a step name");
			}
			skip.add(name);
		} else if (arg === "--workdir") {
			const path = argv[++i];
			if (path === undefined || path.startsWith("--")) {
				throw new Error("--workdir requires a path");
			}
			workdir = path;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { skip, container, workdir };
}

/**
 * Extract the pinned Bun version from a `packageManager` field
 * (`bun@1.4.0`, optionally with a `v` prefix or a `+hash` suffix).
 * Returns `undefined` for anything that is not a Bun pin.
 */
export function parsePinnedBun(packageManager: string): string | undefined {
	const match = /^bun@v?(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(packageManager.trim());
	return match?.[1];
}

/** Normalise a version for comparison: strip a leading `v`. */
function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

/** Whether two version strings denote the same release. */
export function versionsMatch(local: string, pinned: string): boolean {
	return normalizeVersion(local) === normalizeVersion(pinned);
}

type Status = "passed" | "warned" | "failed" | "skipped" | "not run";

interface Result {
	name: string;
	status: Status;
	note?: string;
}

function run(cmd: string[]): number {
	const res = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: "inherit" });
	if (res.error) {
		console.error(`${cmd[0]}: ${res.error.message}`);
		return 1;
	}
	return res.status ?? 1;
}

function git(args: string[]): string | undefined {
	const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	if (res.status !== 0) return undefined;
	return res.stdout.trim();
}

/** The most recent tag, or `undefined` when the history has none. */
function lastTag(): string | undefined {
	return git(["describe", "--tags", "--abbrev=0"]);
}

/**
 * Copy only the tracked (and non-ignored untracked) files into `target`, so
 * the container never sees build outputs or the working tree's data
 * directories.
 */
function copyTrackedFiles(target: string): boolean {
	const listing = spawnSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: ROOT, encoding: "buffer" },
	);
	if (listing.status !== 0) {
		console.error("git ls-files failed; cannot build the container copy");
		return false;
	}
	const res = spawnSync("rsync", ["-a", "--from0", "--files-from=-", "./", target], {
		cwd: ROOT,
		input: listing.stdout,
		stdio: ["pipe", "inherit", "inherit"],
	});
	return (res.status ?? 1) === 0;
}

/**
 * The container script from DEVELOPMENT.md's supply-chain recipe: install the
 * pinned Bun and git, fetch the Rust dependency archives, then generate and
 * verify the linux-x64 workspace inventory.
 */
export function containerScript(pinnedBun: string): string {
	return [
		"apt-get update -qq && apt-get install -y -qq unzip git >/dev/null",
		`curl -fsSL https://bun.sh/install | bash -s "bun-v${pinnedBun}" >/dev/null`,
		'export PATH="$HOME/.bun/bin:$PATH"',
		"bun install --frozen-lockfile >/dev/null",
		"cargo fetch --locked --manifest-path apps/outpost-desktop/src-tauri/Cargo.toml >/dev/null",
		'FLAGS="--inventory-root /w --output-dir /w --platform linux-x64 --assert-host-platform ' +
			'--artifact-kind workspace --artifact-name workspace-linux-x64 --git-sha unknown --include-cargo"',
		"bun run supply-chain $FLAGS",
		"bun run supply-chain:check $FLAGS",
	].join("\n");
}

function printSummary(results: Result[]): void {
	const width = Math.max(...results.map((r) => r.name.length));
	console.log("\nRelease preflight summary");
	for (const r of results) {
		const note = r.note ? `  (${r.note})` : "";
		console.log(`  ${r.name.padEnd(width)}  ${r.status}${note}`);
	}
}

function main(): number {
	let options: PreflightOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		return 1;
	}

	const results: Result[] = [];
	const record = (name: string, status: Status, note?: string): void => {
		results.push({ name, status, note });
	};

	// 1. Bun version: warn on deviation, never fail — CI measures with the pin.
	const packageManager = String(
		(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).packageManager ?? ""),
	);
	const pinned = parsePinnedBun(packageManager);
	const local = Bun.version;
	let bunDiffers = false;
	if (pinned === undefined) {
		record("bun-version", "warned", "packageManager is not a Bun pin");
	} else if (!versionsMatch(local, pinned)) {
		bunDiffers = true;
		console.warn(
			`local Bun ${local} differs from the pinned ${pinned}; budgets and bundles ` +
				`are measured with ${pinned} in CI`,
		);
		record("bun-version", "warned", `local ${local}, pinned ${pinned}`);
	} else {
		record("bun-version", "passed", local);
	}

	const tag = lastTag();

	// 2. The CI gate list, in order.
	for (const step of CI_GATES) {
		if (options.skip.has(step.name)) {
			record(step.name, "skipped");
			continue;
		}
		const cmd = [...step.cmd];
		if (step.name === "check:flow-versions" && tag !== undefined) {
			cmd.push("--", "--base", tag);
		}
		if (step.pinnedBun && bunDiffers && pinned !== undefined) {
			// measure with the pinned Bun, as CI does: npx -y bun@<pinned> run …
			cmd.splice(0, cmd.length, "npx", "-y", `bun@${pinned}`, ...step.cmd.slice(1));
		}
		console.log(`\n$ ${cmd.join(" ")}`);
		const code = run(cmd);
		if (code !== 0) {
			record(step.name, "failed");
			for (const rest of CI_GATES) {
				if (!results.some((r) => r.name === rest.name)) record(rest.name, "not run");
			}
			record("gitleaks", "not run");
			record("supply-chain", "not run");
			printSummary(results);
			return 1;
		}
		record(step.name, "passed");
	}

	// 3. Secret scan over the commits since the last tag, as CI scopes it.
	if (options.skip.has("gitleaks")) {
		record("gitleaks", "skipped");
	} else if (Bun.which("gitleaks") === null) {
		console.log("gitleaks not installed — CI will scan the full history");
		record("gitleaks", "skipped", "not installed");
	} else {
		const cmd = ["gitleaks", "git", ".", "--config", ".gitleaks.toml", "--redact", "--no-banner"];
		if (tag !== undefined) cmd.push("--log-opts", `${tag}..HEAD`);
		console.log(`\n$ ${cmd.join(" ")}`);
		const code = run(cmd);
		if (code !== 0) {
			record("gitleaks", "failed");
			record("supply-chain", "not run");
			printSummary(results);
			return 1;
		}
		record("gitleaks", "passed", tag === undefined ? "full history" : `${tag}..HEAD`);
	}

	// 4. Supply-chain inventory, linux/amd64 container only.
	if (options.skip.has("supply-chain")) {
		record("supply-chain", "skipped");
	} else if (!options.container) {
		console.log("supply-chain check skipped — pass --container to run it in linux/amd64");
		record("supply-chain", "skipped", "--container not given");
	} else if (Bun.which("docker") === null) {
		console.error("docker not installed — the supply-chain check needs a linux/amd64 container");
		record("supply-chain", "failed", "docker not installed");
		printSummary(results);
		return 1;
	} else {
		const workdir = options.workdir ?? join(process.env.TMPDIR || tmpdir(), `atf-preflight-${process.pid}`);
		rmSync(workdir, { recursive: true, force: true });
		mkdirSync(workdir, { recursive: true });
		try {
			if (!copyTrackedFiles(workdir)) {
				record("supply-chain", "failed", "copy failed");
				printSummary(results);
				return 1;
			}
			const cmd = [
				"docker",
				"run",
				"--rm",
				"--platform",
				"linux/amd64",
				"-v",
				`${workdir}:/w`,
				"-w",
				"/w",
				"rust:1-bookworm",
				"bash",
				"-euo",
				"pipefail",
				"-c",
				containerScript(pinned ?? local),
			];
			console.log(`\n$ ${cmd.slice(0, 12).join(" ")} bash -c '<supply-chain recipe>'`);
			const code = run(cmd);
			if (code !== 0) {
				record("supply-chain", "failed");
				printSummary(results);
				return 1;
			}
			record("supply-chain", "passed");
		} finally {
			rmSync(workdir, { recursive: true, force: true });
		}
	}

	printSummary(results);
	const warned = results.filter((r) => r.status === "warned").length;
	console.log(
		`\nAll steps passed${warned > 0 ? ` (${warned} warning${warned > 1 ? "s" : ""})` : ""}.`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
