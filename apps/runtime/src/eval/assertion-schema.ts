// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Validation of structured eval assertions that arrive over HTTP (matrix
 * tasks). Bounded on purpose: the operator plane is trusted, but a pattern or a
 * path is still compiled and run against model output, so lengths and counts
 * are capped. `llmJudge` needs a judge model the matrix does not have and is
 * rejected here rather than failing every cell later.
 */
import { z } from "zod";
import { parseJsonPath, type Assertion } from "./eval-runner.js";

const text = z.string().min(1).max(2_000);
const flags = z.string().max(8).regex(/^[dgimsuy]*$/, "unsupported regex flags");
/**
 * A group that contains a quantifier and is itself quantified — `(a+)+`,
 * `(.*)*`, `(\\w+\\s*)+` — is the classic source of catastrophic backtracking.
 * A heuristic, not a proof: it refuses the common shapes, and the matched text
 * is capped separately ({@link EVAL_REGEX_MAX_INPUT_CHARS}).
 */
const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\))[+*{]/;

const pattern = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => {
      try {
        new RegExp(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid regular expression" },
  )
  .refine((value) => !NESTED_QUANTIFIER.test(value), {
    message: "pattern may backtrack catastrophically",
  });

/**
 * One structured assertion (no `llmJudge`, see the file header). Exported so
 * the bench contract ({@link ./bench-contract.js}) validates the very same
 * shapes instead of duplicating them.
 */
export const AssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contains"), value: text, caseSensitive: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("notContains"), value: text, caseSensitive: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("equals"), value: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal("regex"), pattern, flags: flags.optional() }).strict(),
  z.object({ type: z.literal("maxLatencyMs"), value: z.number().positive().finite() }).strict(),
  z.object({ type: z.literal("maxCost"), value: z.number().nonnegative().finite() }).strict(),
  z
    .object({
      type: z.literal("jsonPath"),
      path: z.string().min(1).max(500).refine((p) => parseJsonPath(p) !== undefined, {
        message: "unsupported JSON path (use $.a.b[0] or $[\"key\"])",
      }),
      equals: z.unknown().optional(),
      matches: pattern.optional(),
      flags: flags.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("toolCalled"),
      name: z.string().min(1).max(200),
      min: z.number().int().nonnegative().max(1000).optional(),
      max: z.number().int().nonnegative().max(1000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("maxTokens"), value: z.number().int().positive().finite() }).strict(),
  z
    .object({
      type: z.literal("finishReason"),
      equals: z.string().min(1).max(64).optional(),
      notEquals: z.string().min(1).max(64).optional(),
    })
    .strict()
    .refine((value) => (value.equals === undefined) !== (value.notEquals === undefined), {
      message: "exactly one of equals or notEquals is required",
    }),
  z.object({ type: z.literal("noDiagnostic"), code: z.string().min(1).max(100) }).strict(),
]);

export const MAX_ASSERTIONS_PER_TASK = 20;

export type AssertionParse =
  | { ok: true; assertions: Assertion[] }
  | { ok: false; message: string };

/** Parse the `assert` of one matrix task; `undefined` means the task has none. */
export function parseTaskAssertions(value: unknown): AssertionParse {
  if (value === undefined) return { ok: true, assertions: [] };
  if (!Array.isArray(value) || value.length > MAX_ASSERTIONS_PER_TASK) {
    return { ok: false, message: `assert must be an array of at most ${MAX_ASSERTIONS_PER_TASK} assertions` };
  }
  const assertions: Assertion[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = AssertionSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        message: `assert[${index}]: ${issue?.message ?? "invalid assertion"}`,
      };
    }
    assertions.push(parsed.data as Assertion);
  }
  return { ok: true, assertions };
}
