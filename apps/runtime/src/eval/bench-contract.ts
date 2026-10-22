// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Contract for versioned bench files: `<FLOWS_DIR>/bench/<flowId>.bench.yaml`.
 *
 * A bench file pins a flow to a set of recorded conversations plus the
 * thresholds a release must meet. It is the input of `atf flows release`
 * (T-352) and is deliberately strict: a bench file that silently does nothing
 * is worse than none, so `loadBenchFile` throws on anything malformed.
 *
 * Assertions reuse {@link AssertionSchema} from `assertion-schema.ts` verbatim
 * — which means `llmJudge` is rejected there by design, matching the rule that
 * a bench gate must be deterministic.
 */
import { z } from "zod";
import { parseFlowFile } from "../util/parse-flow-file.js";
import { AssertionSchema } from "./assertion-schema.js";
import type { Assertion } from "./eval-runner.js";

/** Current bench file format version. Bumped only on breaking changes. */
export const BENCH_FILE_VERSION = 1;

/** Directory below `FLOWS_DIR` holding bench files. Not a flow directory. */
export const BENCH_DIR_NAME = "bench";

/** Suffix (before the extension) of a bench file: `<flowId>.bench.yaml`. */
export const BENCH_FILE_SUFFIX = ".bench";

/** Same cap as matrix tasks; a bench run executes every case against a live server. */
export const MAX_ASSERTIONS_PER_BENCH_CASE = 20;

/** Messages of one bench case: a recorded conversation replayed verbatim. */
const BenchMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().min(1).max(50_000),
  })
  .strict();

const BenchCaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    messages: z.array(BenchMessageSchema).min(1).max(50),
    /** Extra keys merged into the chat request (user, metadata, ...). */
    metadata: z.record(z.string(), z.unknown()).optional(),
    assert: z.array(AssertionSchema).max(MAX_ASSERTIONS_PER_BENCH_CASE).optional(),
  })
  .strict();

const BenchThresholdsSchema = z
  .object({
    /** Share of cases that must pass, 0–1. Required: a gate without one is meaningless. */
    passRate: z.number().min(0).max(1),
    /** Median latency (ms) of the run must stay at or below this. */
    maxLatencyMsP50: z.number().int().positive().finite().optional(),
    /** Median total tokens (prompt + completion) must stay at or below this. */
    maxTokensP50: z.number().int().positive().finite().optional(),
  })
  .strict();

export const BenchFileSchema = z
  .object({
    version: z.literal(BENCH_FILE_VERSION),
    flow: z.string().min(1).max(200),
    cases: z.array(BenchCaseSchema).min(1).max(200),
    thresholds: BenchThresholdsSchema,
  })
  .strict()
  .refine(
    (file) => new Set(file.cases.map((c) => c.id)).size === file.cases.length,
    { message: "case ids must be unique", path: ["cases"] },
  );

export type BenchMessage = z.infer<typeof BenchMessageSchema>;
export type BenchCase = z.infer<typeof BenchCaseSchema> & { assert?: Assertion[] };
export type BenchThresholds = z.infer<typeof BenchThresholdsSchema>;
export type BenchFile = Omit<z.infer<typeof BenchFileSchema>, "cases"> & {
  cases: BenchCase[];
};

/** Formats zod issues as `cases[0].id: <message>` lines joined by `; `. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((part) =>
        typeof part === "number"
          ? `[${part}]`
          : typeof part === "string" && part !== ""
            ? `.${part}`
            : "",
      ).join("");
      const location = path.startsWith("[") ? path.slice(1) : path.replace(/^\./, "");
      return `${location || "$"}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Reads and validates a bench file. Throws with the file name and the exact
 * issues on read, parse or schema failures — the release gate must not
 * continue on a half-valid bench definition.
 *
 * A file named `<name>.bench.<ext>` must declare `flow: <name>`; other file
 * names are accepted as-is (useful for tests and ad-hoc runs).
 */
export function loadBenchFile(filePath: string): BenchFile {
  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    throw new Error(
      `${filePath}: failed to read/parse bench file — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = BenchFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${filePath}: invalid bench file — ${formatIssues(result.error)}`);
  }
  const file = result.data as BenchFile;

  const base = filePath.replace(/\.(ya?ml|json)$/i, "");
  const suffixIndex = base.lastIndexOf(BENCH_FILE_SUFFIX);
  if (suffixIndex !== -1 && base.slice(suffixIndex) === BENCH_FILE_SUFFIX) {
    const expected = base.slice(0, suffixIndex).split(/[\\/]/).pop() ?? base;
    if (expected !== file.flow) {
      throw new Error(
        `${filePath}: bench file name says flow ${JSON.stringify(expected)} but \`flow\` is ${JSON.stringify(file.flow)}`,
      );
    }
  }
  return file;
}
