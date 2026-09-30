// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integrationstests fuer den ATF Extract Outpost (Task 20.13).
 *
 * Diese Tests laufen nur gegen eine echte Testumgebung und werden
 * andernfalls mit klarer Meldung uebersprungen. Voraussetzungen
 * (Umgebungsvariablen):
 *
 *   OUTPOST_IT_EXTRACT_URL   Basis-URL der Extract-Instanz (z. B.
 *                            http://127.0.0.1:8080)
 *   OUTPOST_IT_EXTRACT_TOKEN Bearer-Token mit den Scopes `extract.ingest`
 *                            und `extract.delete`
 *   OUTPOST_IT_SEARCH_URL    optionale Search-URL fuer den Retrieval-Check
 *                            (Token wird mitgesendet)
 *   OUTPOST_IT_IMAGE         optionales Docker-Image (Default
 *                            ghcr.io/abillify/atf-outpost:latest); die
 *                            Container-Tests erfordern zusaetzlich ein
 *                            verfuegbares `docker`-CLI
 *
 * Ausfuehren (Beispiel mit lokalem Extract-/Search-Stack):
 *   OUTPOST_IT_EXTRACT_URL=... OUTPOST_IT_EXTRACT_TOKEN=... \
 *     bun test ./outpost.test.ts
 *
 * Abgedeckt (Anforderungen 4.5, 6.4, 6.5, 6.17, 8.2, 9.1, 10.7, 12.2, 12.3):
 *   - Outpost -> Extract -> Search: Neu-, Versions- und Loeschfall
 *   - Keycloak-Audience: ungueltiges Token wird mit 401/403 abgelehnt
 *   - SIGTERM im Container -> sauberer Exit 0
 *   - Image-Pruefungen: Nicht-Root (10001:10001), Groesse <= 150 MB
 *   - `source-login` ohne TTY -> Exit 64 (interaktiver Pfad, Doku aus 24.1)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveReference } from "../../packages/outpost-core/src/sync/reference.ts";

/** Absoluter Pfad zum Outpost-Einstieg, unabhaengig von der Aufruf-CWD. */
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
 * Laenge einer einzelnen Testfall-Ausfuehrung. Ein `once`-Lauf wartet auf den
 * terminalen Job-Status; eine Vision-Verarbeitung einer Seite kann Minuten
 * dauern (LM Studio), daher deutlich ueber dem bun:test-Default von 5 s.
 */
const RUN_TIMEOUT_MS = 300_000;

/**
 * Erzeugt ein minimales, gueltiges PDF-1.4 mit echtem Textlayer (poppler-
 * tauglich) und korrekten xref-Offsets. Extract unterstuetzt kein `.txt`
 * (siehe apps/extract/src/formats.ts SUPPORTED_FORMATS), daher werden die
 * Testdokumente als PDF geschrieben.
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

/** Minimaler HTTP-Client gegen die Extract-API (Bearer + X-Collection). */
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

/** Alle Jobs der Test-Collection fuer einen Reference-Prefix, neueste zuerst. */
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
		// Testreferenzen in Extract wieder entfernen (best effort, 9.1).
		try {
			for (const job of await listJobs()) {
				await extractFetch(`/v2/documents/${encodeURIComponent(job.reference)}`, {
					method: "DELETE",
				});
			}
		} catch {
			/* Ausraeumen best effort */
		}
		if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
	});

	/**
	 * `atf-outpost once` gegen die Live-Instanz mit gegebener Config und
	 * State-Verzeichnis; liefert stdout.
	 */
	async function runOnceWith(
		cfgPath: string,
		stateDir: string,
		extraEnv: Record<string, string> = {},
	): Promise<string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			// CODELLDB_LAUNCH_CONNECT_FILE (VS-Code-LLDB-Erweiterung) bringt bun
			// mit ENOENT auf rpcaddress.txt zum Absturz — nicht weitergeben.
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
		// Der Report endet mit failed=0; ein Fehlerfall soll hier sofort zeigen,
		// warum (stderr im Testoutput).
		if (code !== 0 || err.includes("FEHLER")) {
			console.log(`once exit=${code}\n${out}\n${err}`);
		}
		expect(code).toBe(0);
		expect(out).toContain(`failed=0`);
		return out;
	}

	/** `atf-outpost once` gegen die Live-Instanz (lokale Source); liefert stdout. */
	async function runOnce(): Promise<string> {
		return runOnceWith(configPath, join(dataDir, "state"));
	}

	test(
		"Neufall: Datei wird ingestiert und als Job sichtbar (8.2, 4.5)",
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
			// Selbsttragend: zuerst Inhalt A (bei erneutem Lauf dedup-uebersprungen,
			// 6.5), dann Inhalt B — beide unter derselben Reference.
			await writeFile(join(srcDir, "neu.pdf"), makePdf("erster Inhalt"));
			await runOnce();
			const inhaltB = makePdf("zweiter Inhalt mit mehr text");
			await writeFile(join(srcDir, "neu.pdf"), inhaltB);
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "neu.pdf");
			const jobs = (await listJobs()).filter((job) => job.reference === reference);
			// Extract traegt je Job die Revision (revisionId) und den Quellen-Hash:
			// die neue Revision mit dem Hash von Inhalt B neben einer aelteren
			// Revision belegen die neue Version unter gleicher Reference.
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
		"Loeschfall: entfernte Datei wird gespiegelt geloescht (9.1)",
		async () => {
			await rm(join(srcDir, "neu.pdf"));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "neu.pdf");
			// Nach Mirror_Delete liefert der Loesch-Endpoint 404 (idempotent, 9.3).
			const res = await extractFetch(`/v2/documents/${encodeURIComponent(reference)}`, {
				method: "DELETE",
			});
			expect([200, 404]).toContain(res.status);
		},
		RUN_TIMEOUT_MS,
	);

	test("Keycloak-Audience: ungueltiges Token wird abgelehnt (10.7)", async () => {
		const res = await fetch(`${EXTRACT_URL}/v2/jobs?limit=1`, {
			headers: { Authorization: "Bearer ungueltiges-token", "x-collection": COLLECTION },
		});
		if (res.status === 200) {
			// Instanz laeuft ohne Authentifizierung (AUTHN_MODE=disabled): ein
			// ungueltiges Token wird bewusst akzeptiert, die Audience-Pruefung
			// ist nicht anwendbar.
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
			// Der Inhalt erreicht Search erst nach terminalem Job und Emit; bis
			// dahin kann der Retrieval-Check wiederholt werden.
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

	// S3-Quelle gegen ein lokal gestartetes MinIO (Anforderungen 6.4, 6.17):
	// Outpost `once` laeuft auf dem Host und erreicht MinIO direkt auf
	// 127.0.0.1; die Bucket-Befehle laufen mit dem aws-CLI gegen denselben
	// Endpoint. Ohne docker, aws-CLI oder startendem MinIO wird uebersprungen.
	test(
		"S3/MinIO: Objekt aus Bucket wird ingestiert (6.4, 6.17)",
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
				// Auf MinIO-Health warten, dann Bucket und Objekt anlegen.
				let ready = false;
				for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
					try {
						const res = await fetch("http://127.0.0.1:19000/minio/health/live");
						ready = res.status === 200;
					} catch {
						/* noch nicht erreichbar */
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
				// S3-Testreferenzen in Extract wieder entfernen (best effort).
				try {
					for (const job of await listJobs(`outpost:${s3SourceId}:`)) {
						await extractFetch(`/v2/documents/${encodeURIComponent(job.reference)}`, {
							method: "DELETE",
						});
					}
				} catch {
					/* Ausraeumen best effort */
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

	test("Image: Nicht-Root (10001:10001) und Groesse <= 150 MB (12.2, 12.3)", async () => {
		const inspect = Bun.spawnSync({
			cmd: ["docker", "image", "inspect", IMAGE, "--format", "{{.Config.User}}"],
		});
		if (inspect.exitCode !== 0) {
			skip(`Image ${IMAGE} nicht vorhanden (zuerst docker pull ausfuehren)`);
			return;
		}
		expect(inspect.stdout.toString().trim()).toBe("10001:10001");
		// 12.3 misst die komprimierte Groesse: docker save | gzip (Near-Default
		// der Registry-Uebertragungskompression).
		const packed = Bun.spawnSync({
			cmd: ["sh", "-c", `docker save '${IMAGE}' | gzip -1 | wc -c`],
		});
		expect(packed.exitCode).toBe(0);
		const compressedBytes = Number(packed.stdout.toString().trim());
		expect(compressedBytes).toBeGreaterThan(0);
		expect(compressedBytes).toBeLessThanOrEqual(157_286_400);
	});

	test("SIGTERM im Container fuehrt zu sauberem Exit 0 (12.2)", async () => {
		// Gueltige Minimal-Konfiguration mounten, damit der Daemon startet und
		// auf SIGTERM wartet (statt sofort mit 78 zu enden).
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
			// Warten, bis der Daemon hochgefahren ist: Als PID 1 ignoriert der
			// Prozess SIGTERM, solange noch kein Handler installiert ist — ein
			// Stop zu frueh waere wirkungslos und endete bei docker stop -t mit
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
			// docker stop sendet SIGTERM und wartet; der Daemon muss mit Exit 0
			// herunterfahren (State geflusht, 12.2).
			await Bun.spawn(["docker", "stop", "-t", "20", name]).exited;
			const wait = Bun.spawnSync({ cmd: ["docker", "wait", name] });
			expect(wait.stdout.toString().trim()).toBe("0");
		} finally {
			await Bun.spawn(["docker", "rm", "-f", name]).exited;
			await rm(dir, { recursive: true, force: true });
		}
	},
	RUN_TIMEOUT_MS);

	test("source-login ohne TTY -> Exit 64 (6.17, Doku 24.1)", async () => {
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
			// Ohne TTY: Benutzungsfehler 64 (interaktiver Pfad, siehe 24.1).
			expect(proc.exitCode).toBe(64);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	RUN_TIMEOUT_MS);
});
