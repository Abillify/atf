// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Every image target in `deploy/examples/Dockerfile` that produces an inventory
 * under `/usr/share/doc/atf`. Keep in sync with that file: a target missing here
 * ships without an inventory in the release bundle.
 */
const TARGETS = ["runtime", "control", "search", "gate", "extract"] as const;

type Options = { outputDir: string; gitSha: string; platform: string };
type CommandResult = { stdout: string; stderr: string; exitCode: number };

function parseArgs(argv: string[]): Options {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || !value) throw new Error(`Expected --key value, received: ${key ?? "<empty>"}`);
		values.set(key, value);
	}
	const gitSha = values.get("--git-sha");
	if (!gitSha || !/^[0-9a-f]{7,64}$/i.test(gitSha)) throw new Error("--git-sha is required and must be a hexadecimal commit SHA");
	const platform = values.get("--platform") ?? "linux-x64";
	if (platform !== "linux-x64" && platform !== "linux-arm64") throw new Error("Quickstart image inventory supports linux-x64 or linux-arm64");
	return { outputDir: resolve(values.get("--output-dir") ?? "artifacts/images"), gitSha, platform };
}

function run(command: string[], options: { quiet?: boolean } = {}): CommandResult {
	const result = Bun.spawnSync(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	if (!options.quiet && stdout) console.log(stdout);
	if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${result.exitCode})${stderr ? `:\n${stderr}` : ""}`);
	return { stdout, stderr, exitCode: result.exitCode };
}
function sha256(text: string | Uint8Array): string { return createHash("sha256").update(text).digest("hex"); }

const options = parseArgs(process.argv.slice(2));
const head = run(["git", "rev-parse", "HEAD"], { quiet: true }).stdout;
if (head !== options.gitSha) throw new Error(`Checkout mismatch: HEAD is ${head}, requested ${options.gitSha}`);

await mkdir(options.outputDir, { recursive: true });
const contextDir = join(options.outputDir, ".exact-checkout");
const archivePath = join(options.outputDir, ".exact-checkout.tar");
await rm(contextDir, { recursive: true, force: true });
await rm(archivePath, { force: true });
await mkdir(contextDir, { recursive: true });
run(["git", "archive", "--format=tar", `--output=${archivePath}`, options.gitSha], { quiet: true });
run(["tar", "-xf", archivePath, "-C", contextDir], { quiet: true });

const dockerPlatform = options.platform === "linux-x64" ? "linux/amd64" : "linux/arm64";
const records: Array<Record<string, string>> = [];

try {
	for (const target of TARGETS) {
		const tag = `atf-quickstart-${target}:${options.gitSha.slice(0, 12)}-${options.platform}`;
		run([
			"docker", "build", "--platform", dockerPlatform, "--file", join(contextDir, "deploy/examples/Dockerfile"), "--target", target,
			"--build-arg", `GIT_SHA=${options.gitSha}`, "--build-arg", `INVENTORY_PLATFORM=${options.platform}`, "--tag", tag, contextDir,
		]);
		const inspection = run(["docker", "image", "inspect", "--format", "{{.Id}}|{{json .RepoDigests}}|{{.Os}}-{{.Architecture}}", tag], { quiet: true }).stdout;
		const [imageId, repoDigests, actualPlatformRaw] = inspection.split("|");
		const actualPlatform = actualPlatformRaw === "linux-amd64" ? "linux-x64" : actualPlatformRaw;
		if (actualPlatform !== options.platform) throw new Error(`${target}: built image platform ${actualPlatform}, expected ${options.platform}`);
		const container = run(["docker", "create", tag], { quiet: true }).stdout;
		const targetDir = join(options.outputDir, target);
		await mkdir(targetDir, { recursive: true });
		try {
			run(["docker", "cp", `${container}:/usr/share/doc/atf/.`, targetDir]);
		} finally {
			run(["docker", "rm", container], { quiet: true });
		}
		const noticeSha = sha256(await readFile(join(targetDir, "THIRD_PARTY_NOTICES.md")));
		const sbomSha = sha256(await readFile(join(targetDir, "sbom.cdx.json")));
		const digest = JSON.parse(repoDigests || "[]")[0] ?? imageId;
		const record = { target, artifactName: `quickstart-${target}`, commit: options.gitSha, platform: options.platform, imageId, imageDigest: digest, noticesSha256: noticeSha, sbomSha256: sbomSha };
		await Bun.write(join(targetDir, "image.json"), `${JSON.stringify(record, null, 2)}\n`);
		records.push(record);
	}

	const index = { schemaVersion: 1, kind: "atf-quickstart-image-inventory", commit: options.gitSha, platform: options.platform, images: records };
	await Bun.write(join(options.outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
	console.log(`Generated Quickstart image inventories for ${TARGETS.join(", ")} at ${options.outputDir}`);
} finally {
	await rm(contextDir, { recursive: true, force: true });
	await rm(archivePath, { force: true });
}
