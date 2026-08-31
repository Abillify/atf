// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * DLP effectiveness harness CLI (`src/eval/pii-recall-run.ts`)
 *
 * Runs the PII detector recall/precision harness over a labeled dataset and
 * prints a report. Exits non-zero when overall recall is below `--min-recall`,
 * so CI can gate on DLP effectiveness (a regression that starts leaking a PII
 * type fails the build).
 *
 *   bun run pii:recall -- --dataset eval/pii-recall.example.json [--min-recall 0.9] [--json]
 *
 * Uses the deterministic regex detector by default (fully offline). No `any`.
 */

import { readFileSync } from "node:fs";
import {
  evaluatePiiRecall,
  formatPiiRecallReport,
  parsePiiRecallDataset,
} from "./pii-recall.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const datasetPath = arg("dataset");
  if (datasetPath === undefined) {
    process.stderr.write(
      "Usage: bun run pii:recall -- --dataset <file.json> [--min-recall 0.9] [--json]\n",
    );
    process.exit(2);
  }
  const minRecall = Number(arg("min-recall") ?? "0");
  const asJson = process.argv.includes("--json");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(datasetPath, "utf-8"));
  } catch (err) {
    process.stderr.write(
      `Failed to read dataset ${datasetPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  const dataset = parsePiiRecallDataset(raw);
  if (dataset === undefined || dataset.cases.length === 0) {
    process.stderr.write("Dataset is empty or malformed.\n");
    process.exit(2);
  }

  const report = evaluatePiiRecall(dataset);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPiiRecallReport(report)}\n`);
  }

  if (Number.isFinite(minRecall) && minRecall > 0 && report.overall.recall < minRecall) {
    process.stderr.write(
      `\n✗ DLP recall ${(report.overall.recall * 100).toFixed(1)}% is below the ` +
        `--min-recall gate of ${(minRecall * 100).toFixed(1)}%.\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
