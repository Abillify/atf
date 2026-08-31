// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auto-eval dataset generator CLI (`src/eval/generate-dataset.ts`)
 *
 * Mines production execution snapshots (captured by the time-travel replay
 * store) into a regression {@link EvalDataset} and writes it to disk. Feed the
 * result back into the eval harness (`bun run eval`) to gate prompt/model/flow
 * changes against real usage.
 *
 * Requires `DATABASE_URL` so snapshots are read from the durable
 * `execution_snapshots` table (the in-memory store does not survive across
 * processes). `REPLAY_ENABLED=true` must have been set while traffic ran so the
 * snapshots exist.
 *
 * Usage:
 *   bun run src/eval/generate-dataset.ts --out eval/regression.json \
 *     [--limit 500] [--max-cases 100] [--key-phrases 3] [--flow my-flow] \
 *     [--judge-criteria "Answer is correct and grounded."] [--no-dedupe]
 *
 * No `any` at module boundaries.
 */

import * as fs from "node:fs";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../observability/logger.js";
import { createDatabase } from "../db/database.js";
import { PostgresReplayStore, type ReplayStore } from "../graph/replay.js";
import { buildAutoEvalDataset, type BuildDatasetOptions } from "./auto-eval.js";

interface CliArgs {
  out: string;
  limit: number;
  maxCases?: number;
  keyPhrases: number;
  flows: string[];
  judgeCriteria?: string;
  dedupe: boolean;
  name?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: "eval/regression.json",
    limit: 500,
    keyPhrases: 3,
    flows: [],
    dedupe: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--limit")
      args.limit = Number.parseInt(argv[++i] ?? "500", 10) || 500;
    else if (a === "--max-cases")
      args.maxCases = Number.parseInt(argv[++i] ?? "0", 10) || undefined;
    else if (a === "--key-phrases")
      args.keyPhrases = Number.parseInt(argv[++i] ?? "3", 10);
    else if (a === "--flow") args.flows.push(argv[++i] ?? "");
    else if (a === "--judge-criteria") args.judgeCriteria = argv[++i];
    else if (a === "--no-dedupe") args.dedupe = false;
    else if (a === "--name") args.name = argv[++i];
  }
  args.flows = args.flows.filter((f) => f.length > 0);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.databaseUrl === undefined) {
    process.stderr.write(
      "DATABASE_URL is required: auto-eval reads durable snapshots from the " +
        "execution_snapshots table. Run the backend with REPLAY_ENABLED=true and " +
        "DATABASE_URL set so snapshots are captured.\n",
    );
    process.exit(2);
    return;
  }

  const database = await createDatabase(config.databaseUrl, logger, {
    poolMax: config.databasePoolMax,
  });
  if (database === undefined) {
    process.stderr.write("Failed to connect to the database.\n");
    process.exit(2);
    return;
  }

  const store: ReplayStore = new PostgresReplayStore(database, logger);
  const snapshots = await store.list(args.limit);

  const options: BuildDatasetOptions = {
    keyPhrases: args.keyPhrases,
    dedupe: args.dedupe,
    ...(args.maxCases !== undefined ? { maxCases: args.maxCases } : {}),
    ...(args.flows.length > 0 ? { flows: args.flows } : {}),
    ...(args.judgeCriteria !== undefined
      ? { judgeCriteria: args.judgeCriteria }
      : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
  };
  const dataset = buildAutoEvalDataset(snapshots, options);

  fs.writeFileSync(args.out, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");
  process.stdout.write(
    `Wrote ${dataset.cases.length} regression case(s) from ${snapshots.length} ` +
      `snapshot(s) to ${args.out}\n`,
  );
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
