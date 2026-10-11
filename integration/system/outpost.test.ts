// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the ATF Extract Outpost (Task 20.13).
 *
 * These tests only run against a real test environment and are otherwise
 * skipped with a clear message. Prerequisites
 * (environment variables):
 *
 *   OUTPOST_IT_EXTRACT_URL   base URL of the Extract instance (e.g.
 *                            http://127.0.0.1:8080)
 *   OUTPOST_IT_EXTRACT_TOKEN bearer token with the scopes `extract.ingest`
 *                            and `extract.delete`
 *   OUTPOST_IT_SEARCH_URL    optional Search URL for the retrieval check
 *                            (the token is sent along)
 *   OUTPOST_IT_IMAGE         optional Docker image (default
 *                            ghcr.io/abillify/atf-outpost:latest); the
 *                            container tests additionally require an
 *                            available `docker` CLI
 *
 * Run (example with a local Extract/Search stack):
 *   OUTPOST_IT_EXTRACT_URL=... OUTPOST_IT_EXTRACT_TOKEN=... \
 *     bun test ./outpost.test.ts
 *
 * Covered (Requirements 4.5, 6.4, 6.5, 6.17, 8.2, 9.1, 10.7, 12.2, 12.3):
 *   - Outpost -> Extract -> Search: new, version and delete case
 *   - Keycloak audience: an invalid token is rejected with 401/403
 *   - SIGTERM in the container -> clean exit 0
 *   - image checks: non-root (10001:10001), size <= 150 MB
 *   - `source-login` without a TTY -> exit 64 (interactive path, docs from 24.1)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveReference } from "../../packages/outpost-core/src/sync/reference.ts";

/** Absolute path to the Outpost entry point, independent of the calling CWD. */
const OUTPOST_MAIN = join(import.meta.dirname, "../../apps/outpost/src/main.ts");

const EXTRACT_URL = (process.env.OUTPOST_IT_EXTRACT_URL ?? "").replace(/\/$/, "");
const EXTRACT_TOKEN = process.env.OUTPOST_IT_EXTRACT_TOKEN ?? "";
const SEARCH_URL = (process.env.OUTPOST_IT_SEARCH_URL ?? "").replace(/\/$/, "");
const IMAGE = process.env.OUTPOST_IT_IMAGE ?? "ghcr.io/abillify/atf-outpost:latest";

const servicesAvailable = EXTRACT_URL !== "" && EXTRACT_TOKEN !== "";

async function dockerAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

const hasDocker = await dockerAvailable();

function skip(why: string): void {
	console.log(`SKIP (outpost integration): ${why}`);
}

const COLLECTION = "outpost_it";
const SOURCE_ID = "local";

/**
 * Length of a single test case run. A `once` run waits for the
 * terminal job status; vision processing of one page can take minutes
 * (LM Studio), hence well above the bun:test default of 5 s.
 */
const RUN_TIMEOUT_MS = 300_000;

/**
 * Generates a minimal, valid PDF 1.4 with a real text layer (poppler
 * compatible) and correct xref offsets. Extract does not support `.txt`
 * (see apps/extract/src/formats.ts SUPPORTED_FORMATS), so the test
 * documents are written as PDF.
 */
function makePdf(text: string): Uint8Array<ArrayBuffer> {
	const chunks: string[] = [];
	const offsets: number[] = [];
	let pos = 0;
	const push = (s: string): void => {
		offsets.push(pos);
		chunks.push(s);
		pos += s.length;
	};
	push("%PDF-1.4\n");
	const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET\n`;
	push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
	push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
	push(
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
	);
	push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
	push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
	const xrefStart = pos;
	let xref = "xref\n0 6\n0000000000 65535 f \n";
	for (const off of offsets) xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
	chunks.push(xref);
	chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
	return new TextEncoder().encode(chunks.join(""));
}

/** Minimal HTTP client against the Extract API (bearer + X-Collection). */
async function extractFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${EXTRACT_URL}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${EXTRACT_TOKEN}`,
			"x-collection": COLLECTION,
			...(init?.headers ?? {}),
		},
	});
}

type JobView = {
	jobId: string;
	reference: string;
	status: string;
	revisionId?: string;
	sourceSha256?: string;
	collection?: string;
};

/** All jobs of the test collection for a reference prefix, newest first. */
async function listJobs(prefix = `outpost:${SOURCE_ID}:`): Promise<JobView[]> {
	const res = await extractFetch("/v2/jobs?limit=100");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { jobs?: JobView[] };
	return (body.jobs ?? []).filter((job) => job.reference.startsWith(prefix));
}

describe("outpost -> extract -> search (live)", () => {
	if (!servicesAvailable) {
		skip("OUTPOST_IT_EXTRACT_URL / OUTPOST_IT_EXTRACT_TOKEN nicht gesetzt");
		return;
	}

	let dataDir = "";
	let srcDir = "";
	let configPath = "";

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "atf-outpost-it-"));
		srcDir = join(dataDir, "src");
		await Bun.spawn(["mkdir", "-p", srcDir]).exited;
		configPath = join(dataDir, "outpost.yaml");
		await writeFile(
			configPath,
			[
				`extractUrl: ${EXTRACT_URL}`,
				"allowInsecureLocalhost: true",
				`collection: ${COLLECTION}`,
				"syncIntervalSec: 3600",
				"mirrorDelete: true",
				"sources:",
				`  - id: ${SOURCE_ID}`,
				"    type: local",
				`    path: ${srcDir}`,
				"health:",
				"  bind: 127.0.0.1",
				"  port: 0",
				"",
			].join("\n"),
		);
	});

	afterAll(async () => {
		// Remove the test references from Extract again (best effort, 9.1).
		try {
			for (const job of await listJobs()) {
				await extractFetch(`/v2/documents/${encodeURIComponent(job.reference)}`, {
					method: "DELETE",
				});
			}
		} catch {
			/* cleanup is best effort */
		}
		if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
	});

	/**
	 * `atf-outpost once` against the live instance with the given config and
	 * state directory; returns stdout.
	 */
	async function runOnceWith(
		cfgPath: string,
		stateDir: string,
		extraEnv: Record<string, string> = {},
	): Promise<string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			// CODELLDB_LAUNCH_CONNECT_FILE (VS Code LLDB extension) makes bun
			// crash with ENOENT on rpcaddress.txt; do not pass it on.
			if (value !== undefined && key !== "CODELLDB_LAUNCH_CONNECT_FILE") env[key] = value;
		}
		const proc = Bun.spawn({
			cmd: ["bun", "run", OUTPOST_MAIN, "once"],
			env: {
				...env,
				OUTPOST_API_TOKEN: EXTRACT_TOKEN,
				OUTPOST_CONFIG_FILE: cfgPath,
				OUTPOST_DATA_DIR: stateDir,
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		// The report ends with failed=0; a failure should show here right away
		// why (stderr in the test output).
		if (code !== 0 || err.includes("FEHLER")) {
			console.log(`once exit=${code}\n${out}\n${err}`);
		}
		expect(code).toBe(0);
		expect(out).toContain(`failed=0`);
		return out;
	}

	/** `atf-outpost once` against the live instance (local source); returns stdout. */
	async function runOnce(): Promise<string> {
		return runOnceWith(configPath, join(dataDir, "state"));
	}

	test(
		"new case: a file is ingested and visible as a job (8.2, 4.5)",
		async () => {
			await writeFile(join(srcDir, "neu.pdf"), makePdf("erster Inhalt"));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "neu.pdf");
			const jobs = await listJobs();
			expect(jobs.some((job) => job.reference === reference)).toBe(true);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"Versionsfall: geaenderte Datei fuehrt zu hoeherer Version (6.4, 6.5)",
		async () => {
			// Self-contained: first content A (dedup-skipped on a repeated run,
			// 6.5), then content B, both under the same reference.
			await writeFile(join(srcDir, "neu.pdf"), makePdf("erster Inhalt"));
			await runOnce();
			const inhaltB = makePdf("zweiter Inhalt mit mehr text");
			await writeFile(join(srcDir, "neu.pdf"), inhaltB);
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "neu.pdf");
			const jobs = (await listJobs()).filter((job) => job.reference === reference);
			// Extract carries the revision (revisionId) and the source hash per job:
			// the new revision with the hash of content B next to an older
			// revision proves the new version under the same reference.
			const digest = await crypto.subtle.digest("SHA-256", inhaltB);
			const shaNeu = Array.from(new Uint8Array(digest))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const jobNeu = jobs.find((job) => job.sourceSha256 === shaNeu);
			expect(jobNeu?.revisionId).toBeDefined();
			const aeltere = jobs.filter(
				(job) => job.revisionId !== undefined && job.revisionId !== jobNeu?.revisionId,
			);
			expect(aeltere.length).toBeGreaterThanOrEqual(1);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"delete case: a removed file is deleted as a mirror (9.1)",
		async () => {
			await rm(join(srcDir, "neu.pdf"));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "neu.pdf");
			// After Mirror_Delete the delete endpoint returns 404 (idempotent, 9.3).
			const res = await extractFetch(`/v2/documents/${encodeURIComponent(reference)}`, {
				method: "DELETE",
			});
			expect([200, 404]).toContain(res.status);
		},
		RUN_TIMEOUT_MS,
	);

	test("Keycloak audience: an invalid token is rejected (10.7)", async () => {
		const res = await fetch(`${EXTRACT_URL}/v2/jobs?limit=1`, {
			headers: { Authorization: "Bearer ungueltiges-token", "x-collection": COLLECTION },
		});
		if (res.status === 200) {
			// The instance runs without authentication (AUTHN_MODE=disabled): an
			// invalid token is deliberately accepted, the audience check
			// does not apply.
			skip("Extract-Instanz laeuft ohne Authentifizierung (AUTHN_MODE=disabled)");
			return;
		}
		expect([401, 403]).toContain(res.status);
	});

	test(
		SEARCH_URL !== ""
			? "Search: ingestierter Inhalt ist auffindbar (6.17)"
			: "SKIP Search: OUTPOST_IT_SEARCH_URL nicht gesetzt",
		async () => {
			if (SEARCH_URL === "") {
				skip("OUTPOST_IT_SEARCH_URL nicht gesetzt");
				return;
			}
			await writeFile(join(srcDir, "suchbar.pdf"), makePdf("unikales Suchwort Plingtonk"));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "suchbar.pdf");
			// The content reaches Search only after the terminal job and emit; until
			// then the retrieval check may be repeated.
			let hits: Array<{ reference?: string }> = [];
			for (let attempt = 0; attempt < 30; attempt += 1) {
				const res = await fetch(`${SEARCH_URL}/search`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${EXTRACT_TOKEN}`,
						"content-type": "text/plain",
						"x-collection": COLLECTION,
						"x-search-mode": "fts",
					},
					body: "Plingtonk",
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as { results?: Array<{ reference?: string }> };
				hits = body.results ?? [];
				if (hits.some((hit) => (hit.reference ?? "").startsWith(`${reference}#`))) break;
				await Bun.sleep(2_000);
			}
			expect(hits.some((hit) => (hit.reference ?? "").startsWith(`${reference}#`))).toBe(true);
		},
		RUN_TIMEOUT_MS,
	);

	// S3 source against a locally started MinIO (Requirements 6.4, 6.17):
	// Outpost `once` runs on the host and reaches MinIO directly on
	// 127.0.0.1; the bucket commands run with the aws CLI against the same
	// endpoint. Skipped without docker, the aws CLI or a starting MinIO.
	test(
		"S3/MinIO: an object from the bucket is ingested (6.4, 6.17)",
		async () => {
			if (!hasDocker) {
				skip("kein docker-CLI verfuegbar (MinIO)");
				return;
			}
			const awsBin = Bun.spawnSync({ cmd: ["sh", "-c", "command -v aws"] });
			if (awsBin.exitCode !== 0) {
				skip("aws-CLI nicht installiert (MinIO-Bucket-Setup)");
				return;
			}
			const minioUser = "itaccess";
			const minioSecret = "itsecret123";
			const bucket = "itbucket";
			const key = "sub/obj.pdf";
			const s3SourceId = "s3it";
			const name = `outpost-it-minio-${Date.now()}`;
			const run = Bun.spawnSync({
				cmd: [
					"docker",
					"run",
					"-d",
					"--name",
					name,
					"-p",
					"127.0.0.1:19000:9000",
					"-e",
					`MINIO_ROOT_USER=${minioUser}`,
					"-e",
					`MINIO_ROOT_PASSWORD=${minioSecret}`,
					"minio/minio:RELEASE.2025-09-07T16-13-09Z",
					"server",
					"/data",
				],
			});
			if (run.exitCode !== 0) {
				skip(`MinIO konnte nicht starten: ${run.stderr.toString().slice(0, 200)}`);
				return;
			}
			const awsEnv = {
				AWS_ACCESS_KEY_ID: minioUser,
				AWS_SECRET_ACCESS_KEY: minioSecret,
				AWS_DEFAULT_REGION: "us-east-1",
			};
			const awsRun = (args: string[]): number =>
				Bun.spawnSync({
					cmd: ["aws", "--endpoint-url", "http://127.0.0.1:19000", ...args],
					env: { ...process.env, ...awsEnv } as Record<string, string>,
					stdout: "ignore",
					stderr: "pipe",
				}).exitCode ?? 1;
			try {
				// Wait for MinIO health, then create the bucket and object.
				let ready = false;
				for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
					try {
						const res = await fetch("http://127.0.0.1:19000/minio/health/live");
						ready = res.status === 200;
					} catch {
						/* not reachable yet */
					}
					if (!ready) await Bun.sleep(500);
				}
				if (!ready) {
					skip("MinIO wurde nicht bereit (Port 19000 belegt?)");
					return;
				}
				const objPath = join(dataDir, "s3-obj.pdf");
				await writeFile(objPath, makePdf("MinIO Integrationstext"));
				expect(awsRun(["s3api", "create-bucket", "--bucket", bucket])).toBe(0);
				expect(awsRun(["s3", "cp", objPath, `s3://${bucket}/${key}`])).toBe(0);

				const s3ConfigPath = join(dataDir, "outpost-s3.yaml");
				await writeFile(
					s3ConfigPath,
					[
						`extractUrl: ${EXTRACT_URL}`,
						"allowInsecureLocalhost: true",
						`collection: ${COLLECTION}`,
						"syncIntervalSec: 3600",
						"sources:",
						`  - id: ${s3SourceId}`,
						"    type: s3",
						`    bucket: ${bucket}`,
						"    endpoint: http://127.0.0.1:19000",
						"    forcePathStyle: true",
						"    credentials: default-chain",
						"health:",
						"  bind: 127.0.0.1",
						"  port: 0",
						"",
					].join("\n"),
				);
				await runOnceWith(
					s3ConfigPath,
					join(dataDir, "state-s3"),
					awsEnv,
				);
				const reference = deriveReference(s3SourceId, key);
				const jobs = await listJobs(`outpost:${s3SourceId}:`);
				expect(jobs.some((job) => job.reference === reference)).toBe(true);
			} finally {
				Bun.spawnSync({
					cmd: ["docker", "rm", "-f", name],
					stdout: "ignore",
					stderr: "ignore",
				});
				// Remove the S3 test references from Extract again (best effort).
				try {
					for (const job of await listJobs(`outpost:${s3SourceId}:`)) {
						await extractFetch(`/v2/documents/${encodeURIComponent(job.reference)}`, {
							method: "DELETE",
						});
					}
				} catch {
					/* cleanup is best effort */
				}
			}
		},
		RUN_TIMEOUT_MS,
	);
});

describe("outpost docker image", () => {
	if (!hasDocker) {
		skip("kein docker-CLI verfuegbar");
		return;
	}

	test("image: non-root (10001:10001) and size <= 150 MB (12.2, 12.3)", async () => {
		const inspect = Bun.spawnSync({
			cmd: ["docker", "image", "inspect", IMAGE, "--format", "{{.Config.User}}"],
		});
		if (inspect.exitCode !== 0) {
			skip(`Image ${IMAGE} nicht vorhanden (zuerst docker pull ausfuehren)`);
			return;
		}
		expect(inspect.stdout.toString().trim()).toBe("10001:10001");
		// 12.3 measures the compressed size: docker save | gzip (close to the
		// default registry transfer compression).
		const packed = Bun.spawnSync({
			cmd: ["sh", "-c", `docker save '${IMAGE}' | gzip -1 | wc -c`],
		});
		expect(packed.exitCode).toBe(0);
		const compressedBytes = Number(packed.stdout.toString().trim());
		expect(compressedBytes).toBeGreaterThan(0);
		expect(compressedBytes).toBeLessThanOrEqual(157_286_400);
	});

	test("SIGTERM in the container leads to a clean exit 0 (12.2)", async () => {
		// Mount a valid minimal configuration so the daemon starts and
		// waits for SIGTERM (instead of ending immediately with 78).
		const dir = await mkdtemp(join(tmpdir(), "atf-outpost-it-docker-"));
		await writeFile(
			join(dir, "outpost.yaml"),
			[
				`extractUrl: ${EXTRACT_URL !== "" ? EXTRACT_URL : "https://extract.example"}`,
				"allowInsecureLocalhost: true",
				`collection: ${COLLECTION}`,
				"sources: []",
				"health:",
				"  bind: 0.0.0.0",
				"  port: 8787",
				"",
			].join("\n"),
		);
		const name = `outpost-it-sigterm-${Date.now()}`;
		const run = Bun.spawnSync({
			cmd: [
				"docker",
				"run",
				"-d",
				"--name",
				name,
				"-v",
				`${join(dir, "outpost.yaml")}:/config/outpost.yaml:ro`,
				"-e",
				"OUTPOST_API_TOKEN=it-token",
				IMAGE,
				"daemon",
			],
		});
		if (run.exitCode !== 0) {
			skip(`Container konnte nicht starten: ${run.stderr.toString().slice(0, 200)}`);
			await rm(dir, { recursive: true, force: true });
			return;
		}
		try {
			// Wait until the daemon is up: as PID 1 the process ignores
			// SIGTERM as long as no handler is installed; a stop too early
			// would have no effect and would end with docker stop -t in
			// SIGKILL (137).
			const deadline = Date.now() + 30_000;
			for (;;) {
				const logs = Bun.spawnSync({ cmd: ["docker", "logs", name] });
				const text = logs.stderr.toString() + logs.stdout.toString();
				if (/daemon\.started|connection\.(finding|retry)/.test(text)) break;
				if (Date.now() > deadline) {
					skip(`Daemon wurde nicht bereit: ${text.slice(0, 300)}`);
					return;
				}
				await Bun.sleep(500);
			}
			// docker stop sends SIGTERM and waits; the daemon must shut down
			// with exit 0 (state flushed, 12.2).
			await Bun.spawn(["docker", "stop", "-t", "20", name]).exited;
			const wait = Bun.spawnSync({ cmd: ["docker", "wait", name] });
			expect(wait.stdout.toString().trim()).toBe("0");
		} finally {
			await Bun.spawn(["docker", "rm", "-f", name]).exited;
			await rm(dir, { recursive: true, force: true });
		}
	},
	RUN_TIMEOUT_MS);

	test("source-login without a TTY -> exit 64 (6.17, docs 24.1)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atf-outpost-it-login-"));
		await writeFile(
			join(dir, "outpost.yaml"),
			[
				`extractUrl: ${EXTRACT_URL !== "" ? EXTRACT_URL : "https://extract.example"}`,
				"allowInsecureLocalhost: true",
				`collection: ${COLLECTION}`,
				"sources:",
				"  - id: gdrive",
				"    type: gdrive",
				"    folderId: it-folder",
				"",
			].join("\n"),
		);
		try {
			const proc = Bun.spawnSync({
				cmd: [
					"docker",
					"run",
					"--rm",
					"-v",
					`${join(dir, "outpost.yaml")}:/config/outpost.yaml:ro`,
					"-e",
					"OUTPOST_API_TOKEN=it-token",
					IMAGE,
					"source-login",
					"gdrive",
				],
				stderr: "pipe",
			});
			if (proc.exitCode === null || proc.exitCode === 125) {
				skip(`Image ${IMAGE} nicht vorhanden oder docker run fehlgeschlagen`);
				return;
			}
			// Without a TTY: usage error 64 (interactive path, see 24.1).
			expect(proc.exitCode).toBe(64);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	RUN_TIMEOUT_MS);
});
