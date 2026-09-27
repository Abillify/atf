// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * corpus-migrate.ts — the corpus re-ingest / migration driver (task 5.6,
 * requirements 17.3, 17.4).
 *
 * A repeatable operator CLI that re-ingests an existing corpus into the v2
 * pipeline, one document at a time, in **`version` mode** (so the running
 * system keeps serving the old revision until the new one is fully committed —
 * Search does the atomic `is_latest` switch on commit), ordered by usage
 * (most-used first, Req 17.3), and proving asset-id stability (Req 17.4). All
 * the arithmetic — manifest parsing, usage ordering, the asset-id-stability
 * check, the plan and summary formatting — lives in the PURE, unit-tested core
 * `../src/jobs/corpus-migration.ts`. This file adds only the side effects:
 * reading the manifest, uploading source bytes, POSTing `/v1/ingest` with the
 * version-mode header, polling `/v2/jobs/{id}`, and writing the report.
 *
 * Why `version` mode
 * ------------------
 * The ingest route accepts `X-Version-Mode: replace | version` (see
 * `src/handlers/ingest.ts`). `version` opens a NEW revision and Search performs
 * the atomic `is_latest` switch on commit, so a live corpus keeps answering
 * from the old revision throughout the re-extraction — that is the whole point
 * of migrating in `version` mode rather than `replace`.
 *
 * Why asset ids stay stable
 * --------------------------
 * Asset ids are `sha256(NFC(reference) + "\n" + NFC(localId))` — derived from
 * the reference and a local id, never from the image bytes (see
 * `@atf/extract-contract` `buildAssetId`). So re-extracting an existing corpus
 * produces byte-identical asset ids for the same reference + local id, and
 * previously uploaded crops stay valid. The tool proves this by recomputing the
 * ids from each manifest entry's reference + local ids and comparing them
 * against the pre-migration ids the manifest carries (`assets[].priorAssetId`).
 * A changed id is a real regression and is called out in the report.
 *
 * NO FABRICATED RESULTS. With `--dry-run`/`--plan` (or with no `--base-url`,
 * which forces plan mode) the tool prints ONLY the usage-ordered plan and the
 * expected asset ids computed purely from the manifest — proving the stability
 * math — WITHOUT contacting a server, and exits 0. It never invents a migration
 * outcome.
 *
 * Manifest
 * --------
 * A JSON array, a `{ "documents": [...] }` wrapper, or NDJSON (one JSON object
 * per line). Each entry:
 *
 *   {
 *     "reference": "specs/wms.pdf",        // required, the Search row key
 *     "sourceSha256": "<64 hex>",          // an already-stored source, OR
 *     "path": "/corpus/wms.pdf",           // a file to upload first
 *     "mimeType": "application/pdf",       // optional hint
 *     "collection": "documents",           // optional; else --collection
 *     "hitCount": 128,                     // usage signal (Req 17.3)
 *     "usage": 128,                        //   (alt) or
 *     "lastAccessed": "2026-02-01T…Z",     //   (alt) recency
 *     "assets": [                          // pre-migration ids (Req 17.4 proof)
 *       { "kind": "figure", "id": "p12-f3", "priorAssetId": "<64 hex>" },
 *       { "kind": "page",   "id": "37",     "priorAssetId": "<64 hex>" }
 *     ]
 *   }
 *
 * Usage
 * -----
 *   # Print the usage-ordered plan + expected asset ids (no server contacted):
 *   bun run scripts/corpus-migrate.ts --manifest corpus.json --plan
 *
 *   # Migrate for real, most-used first, in version mode:
 *   bun run scripts/corpus-migrate.ts \
 *     --manifest corpus.json \
 *     --base-url http://127.0.0.1:3004 \
 *     --token <bearer> \
 *     [--collection documents] \
 *     [--out reports/corpus-migration.json]
 *
 * Exit code 0 on success (including plan mode); non-zero on argument errors or
 * when any document failed to migrate (so a CI run notices).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  buildMigrationPlan,
  checkAssetIdStability,
  formatPlan,
  formatSummary,
  type ManifestEntry,
  type MigrationOutcome,
  parseManifest,
  summarizeRun,
} from "../src/jobs/corpus-migration.js";

// ─── CLI parsing ────────────────────────────────────────────────────────────────

interface Args {
  manifest?: string;
  plan: boolean;
  baseUrl?: string;
  token?: string;
  collection?: string;
  versionMode: "version" | "replace";
  out?: string;
  pollMs: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const int = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };

  const baseUrl = get("--base-url");
  // No server means we cannot migrate — force plan mode so the tool is always
  // safe to run offline and never pretends to have migrated anything.
  const plan = has("--plan") || has("--dry-run") || baseUrl === undefined;
  const versionModeRaw = get("--version-mode") ?? "version";
  if (versionModeRaw !== "version" && versionModeRaw !== "replace") {
    throw new Error('--version-mode must be "version" or "replace"');
  }

  return {
    manifest: get("--manifest"),
    plan,
    baseUrl,
    token: get("--token"),
    collection: get("--collection"),
    versionMode: versionModeRaw,
    out: get("--out"),
    pollMs: int("--poll-ms", 2000),
    timeoutMs: int("--timeout-ms", 24 * 60 * 60 * 1000),
  };
}

// ─── Ingest I/O (the only side effects) ──────────────────────────────────────────

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** The subset of the `/v1/ingest` responses this driver reads. */
interface IngestResponse {
  status?: string;
  job_id?: string;
  page_count?: number;
  contract?: string;
  poll?: string;
  warnings?: string[];
}

interface JobView {
  jobId: string;
  status: string;
  pageCount?: number;
  warnings?: string[];
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Re-ingest ONE document in `version` mode: POST the source bytes to
 * `/v1/ingest` with `X-Version-Mode: version` and `X-Reference`, then, if the
 * document was large enough to be answered async (202 + a job id), poll
 * `/v2/jobs/{id}` to a terminal state. Returns the completed page count. Throws
 * on any transport, validation or job failure — the caller records it as a
 * per-document failure and continues.
 */
async function migrateOne(args: Args, entry: ManifestEntry): Promise<{ pageCount: number; contract?: string }> {
  const body = await sourceBytes(entry);
  const collection = entry.collection ?? args.collection;
  const headers: Record<string, string> = {
    "content-type": entry.mimeType ?? "application/octet-stream",
    "x-reference": entry.reference,
    "x-version-mode": args.versionMode,
    "x-filename": basename(entry.path ?? entry.reference),
    ...authHeaders(args.token),
  };
  if (collection !== undefined) headers["x-collection"] = collection;

  const res = await fetch(`${args.baseUrl}/v1/ingest`, {
    method: "POST",
    headers,
    // A Blob is the portable BodyInit for raw bytes across the fetch typings.
    body: new Blob([body as BlobPart]),
  });
  if (!res.ok) {
    throw new Error(`POST /v1/ingest failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const ingest = (await res.json()) as IngestResponse;

  // Small document: answered synchronously with the completed result.
  if (res.status === 200 && ingest.status === "ok") {
    return { pageCount: ingest.page_count ?? 0, ...(ingest.contract !== undefined ? { contract: ingest.contract } : {}) };
  }

  // Large document: 202 + a job id to poll to a terminal state.
  const jobId = ingest.job_id;
  if (jobId === undefined) {
    throw new Error(`/v1/ingest gave neither a completed result nor a job id (status ${ingest.status ?? res.status})`);
  }
  const job = await pollJob(args, jobId);
  if (job.status !== "completed") {
    throw new Error(`job ${jobId} ended ${job.status}${job.warnings?.length ? `: ${job.warnings.join("; ")}` : ""}`);
  }
  return { pageCount: job.pageCount ?? 0 };
}

/** The bytes to ingest: a file read from `path`. */
async function sourceBytes(entry: ManifestEntry): Promise<Uint8Array> {
  if (entry.path !== undefined) return readFile(resolve(entry.path));
  // A manifest with only a stored sha cannot be re-uploaded through /v1/ingest
  // (that route takes the file body); such an entry is skipped upstream. This
  // guard keeps the type honest.
  throw new Error(`document "${entry.reference}" has no "path" to upload; a sha-only entry cannot be re-ingested here`);
}

async function pollJob(args: Args, jobId: string): Promise<JobView> {
  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    const res = await fetch(`${args.baseUrl}/v2/jobs/${jobId}`, { headers: authHeaders(args.token) });
    if (!res.ok) throw new Error(`GET /v2/jobs/${jobId} failed: ${res.status}`);
    const job = (await res.json()) as JobView;
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish within --timeout-ms; last status ${job.status}`);
    await sleep(args.pollMs);
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────────

async function writeReport(outPath: string, payload: unknown): Promise<void> {
  const abs = resolve(outPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${abs}`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.manifest === undefined) {
    console.error("--manifest <file> is required (a JSON array, { documents: [] }, or NDJSON).");
    return 2;
  }

  const text = await readFile(resolve(args.manifest), "utf8");
  const { entries, warnings } = parseManifest(text);
  for (const w of warnings) console.error(`manifest warning: ${w}`);
  if (entries.length === 0) {
    console.error("Manifest contained no valid documents.");
    return 2;
  }

  const plan = buildMigrationPlan(entries);

  // ── plan / dry-run: print the usage-ordered plan + expected asset ids ─────
  if (args.plan) {
    console.log("Corpus migration plan (version mode, most-used first — no server contacted):");
    console.log("");
    console.log(formatPlan(plan));
    console.log("");
    const missing = plan.filter((d) => d.sourceKind === "none").length;
    const shaOnly = plan.filter((d) => d.sourceKind === "sha256").length;
    if (missing > 0) console.log(`Note: ${missing} document(s) have no source (neither path nor sha) and cannot be migrated.`);
    if (shaOnly > 0) {
      console.log(
        `Note: ${shaOnly} document(s) carry only a sourceSha256; /v1/ingest re-ingests from an uploaded file, so add a "path" to migrate them.`,
      );
    }
    if (args.baseUrl === undefined && !process.argv.includes("--plan") && !process.argv.includes("--dry-run")) {
      console.log("");
      console.log("(No --base-url given, so plan mode was selected automatically.)");
    }
    return 0;
  }

  // ── migrate for real, most-used first, one at a time ──────────────────────
  console.log(`Migrating ${plan.length} document(s) in ${args.versionMode} mode against ${args.baseUrl}…`);
  const outcomes: MigrationOutcome[] = [];
  for (const doc of plan) {
    const entry = entries.find((e) => e.reference === doc.reference);
    const stability = checkAssetIdStability(doc.reference, entry?.assets ?? []);
    if (doc.sourceKind !== "upload") {
      const reason =
        doc.sourceKind === "none"
          ? "no source (path or sha) in the manifest"
          : "only a sourceSha256 was given; /v1/ingest needs an uploadable path";
      console.error(`  [skip] ${doc.reference}: ${reason}`);
      outcomes.push({ reference: doc.reference, status: "skipped", error: reason, stability });
      continue;
    }
    try {
      console.log(`  [${doc.order}/${plan.length}] ${doc.reference} …`);
      const result = await migrateOne(args, entry as ManifestEntry);
      outcomes.push({
        reference: doc.reference,
        status: "migrated",
        pageCount: result.pageCount,
        ...(result.contract !== undefined ? { contract: result.contract } : {}),
        stability,
      });
      const s = stability;
      console.log(
        `        migrated (${result.pageCount} pages); asset ids: ${s.stable} stable, ${s.changed} changed, ${s.unverified} unverified`,
      );
      if (!s.ok) console.error(`        ✗ asset-id regression on ${doc.reference} — a re-extraction changed an id`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`        failed: ${message}`);
      outcomes.push({ reference: doc.reference, status: "failed", error: message, stability });
    }
  }

  const summary = summarizeRun(outcomes);
  console.log("");
  console.log(formatSummary(summary));

  if (args.out !== undefined) {
    await writeReport(args.out, { generatedAt: new Date().toISOString(), versionMode: args.versionMode, summary, outcomes });
  }

  // A failed document, or an asset-id regression, is a non-zero exit so a
  // scripted migration notices.
  return summary.failed > 0 || summary.assetIdRegressions.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
