// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure release-gate logic for `atf flows release` (T-352, E6) plus the
 * signed release receipt (T-353, E6 step 6).
 *
 * Everything here is side-effect free: SemVer comparison, percentile
 * statistics, threshold evaluation, baseline comparison and receipt
 * building/signing over bytes. The CLI in `scripts/cli.ts` supplies I/O
 * (flow files, git, HTTP executor, key files) and turns the structured
 * outcome into exit codes and output.
 */

import { type KeyObject, createHash } from "node:crypto";
import { z } from "zod";
import type { BenchFile, BenchThresholds } from "./bench-contract.js";
import {
  type EvalCase,
  type EvalReport,
  type FlowExecutor,
  runEval,
} from "./eval-runner.js";
import { canonicalizeForBundleHash } from "../observability/evidence-bundle.js";
import {
  type Ed25519EvidenceKey,
  signEvidenceBytes,
  verifyEvidenceBytes,
} from "../observability/evidence-key.js";

/** SemVer shape accepted by the release gate (same as the CLI's SEMVER_RE). */
export const RELEASE_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Compares two SemVer versions. Returns a negative number when `a < b`,
 * `0` when equal and a positive number when `a > b`.
 *
 * The numeric `major.minor.patch` core decides first. A release without a
 * prerelease tag is greater than one with a prerelease tag (per SemVer);
 * two prerelease tags compare dot-separated, numeric identifiers below
 * alphanumeric ones.
 *
 * Throws on inputs that do not match {@link RELEASE_SEMVER_RE}.
 */
export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i] - pb.core[i];
    if (d !== 0) return Math.sign(d);
  }
  if (pa.prerelease === undefined && pb.prerelease === undefined) return 0;
  if (pa.prerelease === undefined) return 1;
  if (pb.prerelease === undefined) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function parseSemVer(raw: string): {
  core: [number, number, number];
  prerelease: string[] | undefined;
} {
  if (!RELEASE_SEMVER_RE.test(raw)) {
    throw new Error(`invalid SemVer version: "${raw}"`);
  }
  const dash = raw.indexOf("-");
  const coreRaw = dash === -1 ? raw : raw.slice(0, dash);
  const preRaw = dash === -1 ? undefined : raw.slice(dash + 1);
  const parts = coreRaw.split(".").map((n) => Number.parseInt(n, 10));
  const core: [number, number, number] = [parts[0], parts[1], parts[2]];
  const prerelease =
    preRaw === undefined || preRaw === "" ? undefined : preRaw.split(".");
  return { core, prerelease };
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number.parseInt(ai, 10) - Number.parseInt(bi, 10);
      if (d !== 0) return Math.sign(d);
    } else if (an) {
      return -1;
    } else if (bn) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Median (50th percentile) of the given values. For an even count the
 * convention is the average of the two middle values. Throws on an empty
 * input — a release run always produces at least one case.
 */
export function percentile50(values: number[]): number {
  if (values.length === 0) {
    throw new Error("percentile50 requires at least one value");
  }
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor((sorted.length - 1) / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid] + sorted[mid + 1]) / 2;
}

/** Aggregated bench statistics a release decision is made from. */
export interface ReleaseStats {
  cases: number;
  passed: number;
  passRate: number;
  latencyMsP50: number;
  tokensP50: number;
}

/**
 * Checks the aggregated statistics against the bench thresholds. Returns a
 * human-readable failure per violated threshold (empty list = gate passed).
 */
export function evaluateThresholds(
  stats: ReleaseStats,
  thresholds: BenchThresholds,
): string[] {
  const failures: string[] = [];
  if (stats.passRate < thresholds.passRate) {
    failures.push(
      `passRate ${formatRate(stats.passRate)} below required ${formatRate(thresholds.passRate)}`,
    );
  }
  if (
    thresholds.maxLatencyMsP50 !== undefined &&
    stats.latencyMsP50 > thresholds.maxLatencyMsP50
  ) {
    failures.push(
      `p50 latency ${Math.round(stats.latencyMsP50)}ms above max ${thresholds.maxLatencyMsP50}ms`,
    );
  }
  if (
    thresholds.maxTokensP50 !== undefined &&
    stats.tokensP50 > thresholds.maxTokensP50
  ) {
    failures.push(
      `p50 tokens ${Math.round(stats.tokensP50)} above max ${thresholds.maxTokensP50}`,
    );
  }
  return failures;
}

/** Shape of a previously stored release receipt used as a baseline. */
export interface ReleaseBaseline {
  flowId?: string;
  flowVersion?: string;
  results?: {
    cases?: number;
    passed?: number;
    passRate?: number;
    latencyMsP50?: number;
    tokensP50?: number;
  };
}

export interface BaselineComparison {
  ok: boolean;
  /** Human-readable per-metric deltas (baseline → current). */
  deltas: string[];
  failures: string[];
}

/**
 * Compares the current run against a baseline receipt. The pass rate must
 * not drop; latency and token medians are reported as deltas only (the
 * thresholds in the bench file govern them).
 */
export function compareBaseline(
  baseline: ReleaseBaseline,
  current: ReleaseStats,
): BaselineComparison {
  const deltas: string[] = [];
  const failures: string[] = [];
  const base = baseline.results ?? {};

  if (typeof base.passRate === "number") {
    deltas.push(
      `passRate ${formatRate(base.passRate)} → ${formatRate(current.passRate)}`,
    );
    if (current.passRate < base.passRate) {
      failures.push(
        `passRate regressed from baseline ${formatRate(base.passRate)} to ${formatRate(current.passRate)}`,
      );
    }
  }
  if (typeof base.latencyMsP50 === "number") {
    const d = current.latencyMsP50 - base.latencyMsP50;
    deltas.push(
      `p50 latency ${Math.round(base.latencyMsP50)}ms → ${Math.round(current.latencyMsP50)}ms (${d >= 0 ? "+" : ""}${Math.round(d)}ms)`,
    );
  }
  if (typeof base.tokensP50 === "number") {
    const d = current.tokensP50 - base.tokensP50;
    deltas.push(
      `p50 tokens ${Math.round(base.tokensP50)} → ${Math.round(current.tokensP50)} (${d >= 0 ? "+" : ""}${Math.round(d)})`,
    );
  }
  return { ok: failures.length === 0, deltas, failures };
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Version gate for a changed flow (E6 step 3). When the flow digest
 * changed between base and head, `metadata.version` must be a valid SemVer
 * strictly greater than the base version. Returns an error message on
 * violation, `undefined` when the gate passes.
 */
export function versionGateProblem(input: {
  digestChanged: boolean;
  baseVersion?: string;
  headVersion?: string;
}): string | undefined {
  if (!input.digestChanged) return undefined;
  const head = input.headVersion;
  const base = input.baseVersion;
  if (head === undefined || head === "") {
    return `flow changed but metadata.version was not raised (${base ?? "?"} → <missing>)`;
  }
  if (!RELEASE_SEMVER_RE.test(head)) {
    return `flow metadata.version "${head}" is not a valid SemVer version`;
  }
  if (base === undefined || base === "") return undefined;
  if (!RELEASE_SEMVER_RE.test(base)) {
    return `base flow metadata.version "${base}" is not a valid SemVer version`;
  }
  if (compareSemVer(head, base) <= 0) {
    return `flow changed but metadata.version was not raised (${base} → ${head})`;
  }
  return undefined;
}

/** Statistics captured per executed bench case (tokens are not on CaseResult). */
export interface ReleaseCaseStat {
  id: string;
  passed: boolean;
  latencyMs: number;
  tokens: number | undefined;
}

/** Shape of the token usage subset the release gate reads. */
export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Total tokens of a completion usage payload, mirroring the eval runner's
 * private helper: prefer `total_tokens`, else sum prompt+completion.
 */
export function totalTokensOf(usage: UsageLike | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const parts = [usage.prompt_tokens, usage.completion_tokens].filter(
    (n): n is number => typeof n === "number",
  );
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Runs every bench case through the executor (concurrency 2 by default,
 * per the E6 design) and collects per-case latency and token statistics.
 *
 * Token usage is captured by wrapping the executor: `CaseResult` carries
 * latency and cost but no token counts. `runEval` passes each case's
 * `messages` array by identity, so the wrapper can record usage keyed by
 * that reference — safe under concurrency.
 */
export async function runBenchCases(
  bench: BenchFile,
  executor: FlowExecutor,
  concurrency = 2,
): Promise<{ report: EvalReport; stats: ReleaseCaseStat[] }> {
  const evalCases: EvalCase[] = bench.cases.map((c) => ({
    id: c.id,
    flow: bench.flow,
    messages: c.messages,
    assert: c.assert,
    metadata: c.metadata,
  }));

  const tokensByMessages = new Map<unknown, number | undefined>();
  const wrapped: FlowExecutor = async (flowId, messages, metadata) => {
    const result = await executor(flowId, messages, metadata);
    tokensByMessages.set(messages, totalTokensOf(result.usage));
    return result;
  };

  const report = await runEval({ name: bench.flow, cases: evalCases }, wrapped, {
    concurrency,
  });

  const stats: ReleaseCaseStat[] = report.cases.map((caseResult) => {
    const evalCase = evalCases.find((c) => c.id === caseResult.id);
    return {
      id: caseResult.id,
      passed: caseResult.passed,
      latencyMs: caseResult.latencyMs,
      tokens: evalCase !== undefined ? tokensByMessages.get(evalCase.messages) : undefined,
    };
  });
  return { report, stats };
}

/**
 * Aggregates per-case observations into the release statistics. Cases
 * without token usage are excluded from the token median; if no case
 * reported usage the token median is 0.
 */
export function aggregateStats(
  report: EvalReport,
  caseStats: ReleaseCaseStat[],
): ReleaseStats {
  const tokens = caseStats
    .map((c) => c.tokens)
    .filter((t): t is number => typeof t === "number");
  return {
    cases: report.total,
    passed: report.passed,
    passRate: report.passRate,
    latencyMsP50: percentile50(caseStats.map((c) => c.latencyMs)),
    tokensP50: tokens.length > 0 ? percentile50(tokens) : 0,
  };
}

// ---------------------------------------------------------------------------
// Signed release receipt (T-353, E6 step 6)
// ---------------------------------------------------------------------------

/** Format discriminator of a flow release receipt. */
export const RELEASE_RECEIPT_TYPE = "atf.flow-release-receipt";

/** Current release receipt format version. Bump on breaking shape changes. */
export const RELEASE_RECEIPT_VERSION = 1 as const;

/** EdDSA (Ed25519) is the only signing algorithm for release receipts. */
export const RELEASE_RECEIPT_ALG = "EdDSA";

/**
 * A signed flow release receipt (E6 design): the outcome of a passing
 * release gate, bound to the flow digest and the bench file digest and
 * signed with an Ed25519 evidence key. Holders verify it offline with
 * `atf-verify --release-receipt` against the issuer's JWKS. There is
 * deliberately no transparency-log entry (Anhang B).
 */
export interface FlowReleaseReceipt {
  type: typeof RELEASE_RECEIPT_TYPE;
  version: typeof RELEASE_RECEIPT_VERSION;
  flowId: string;
  flowVersion: string;
  flowDigest: string;
  baseRef?: string;
  baseFlowVersion?: string;
  benchDigest: string;
  results: ReleaseStats;
  thresholds: BenchThresholds;
  createdAt: string;
  signature: {
    alg: typeof RELEASE_RECEIPT_ALG;
    kid: string;
    value: string;
  };
}

/**
 * Schema mirroring {@link FlowReleaseReceipt}. The thresholds sub-object is
 * spelled out here because `BenchThresholdsSchema` is not exported from
 * `bench-contract.ts`; the constraints are identical.
 */
export const FlowReleaseReceiptSchema = z
  .object({
    type: z.literal(RELEASE_RECEIPT_TYPE),
    version: z.literal(RELEASE_RECEIPT_VERSION),
    flowId: z.string().min(1).max(200),
    flowVersion: z.string().min(1),
    flowDigest: z.string().min(1),
    baseRef: z.string().min(1).optional(),
    baseFlowVersion: z.string().min(1).optional(),
    benchDigest: z.string().min(1),
    results: z
      .object({
        cases: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        passRate: z.number().min(0).max(1),
        latencyMsP50: z.number().finite().nonnegative(),
        tokensP50: z.number().finite().nonnegative(),
      })
      .strict(),
    thresholds: z
      .object({
        passRate: z.number().min(0).max(1),
        maxLatencyMsP50: z.number().int().positive().finite().optional(),
        maxTokensP50: z.number().int().positive().finite().optional(),
      })
      .strict(),
    createdAt: z.string().min(1),
    signature: z
      .object({
        alg: z.literal(RELEASE_RECEIPT_ALG),
        kid: z.string().min(1),
        value: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Digest of a bench file: `sha256:<hex>` over its canonical JSON, the same
 * format as {@link computeFlowDigest} for flows. Pinning the bench file in
 * the receipt makes the exact gate definition (cases + thresholds)
 * verifiable later, not just the numbers it produced.
 */
export function computeBenchDigest(bench: BenchFile): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeForBundleHash(bench))
    .digest("hex")}`;
}

/** Input for {@link buildReleaseReceipt}: everything except the signature. */
export interface ReleaseReceiptInput {
  flowId: string;
  flowVersion: string;
  flowDigest: string;
  baseRef?: string;
  baseFlowVersion?: string;
  benchDigest: string;
  results: ReleaseStats;
  thresholds: BenchThresholds;
  createdAt: string;
}

/**
 * Builds the unsigned receipt document (E6 shape). Optional fields absent
 * at build time are omitted entirely rather than set to `undefined`, so the
 * canonical signing bytes stay stable.
 */
export function buildReleaseReceipt(
  input: ReleaseReceiptInput,
): Omit<FlowReleaseReceipt, "signature"> {
  return {
    type: RELEASE_RECEIPT_TYPE,
    version: RELEASE_RECEIPT_VERSION,
    flowId: input.flowId,
    flowVersion: input.flowVersion,
    flowDigest: input.flowDigest,
    ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
    ...(input.baseFlowVersion !== undefined
      ? { baseFlowVersion: input.baseFlowVersion }
      : {}),
    benchDigest: input.benchDigest,
    results: input.results,
    thresholds: input.thresholds,
    createdAt: input.createdAt,
  };
}

/**
 * Canonical bytes covered by the signature: the receipt without its
 * `signature` field, canonicalized exactly like evidence bundles
 * (`canonicalJson`). Verifiers must reproduce these bytes identically.
 */
export function releaseReceiptSigningBytes(
  receipt: Omit<FlowReleaseReceipt, "signature"> | FlowReleaseReceipt,
): string {
  const { signature: _signature, ...unsigned } = receipt as FlowReleaseReceipt;
  return canonicalizeForBundleHash(unsigned);
}

/**
 * Signs a release receipt with an Ed25519 evidence key. The signature
 * covers the canonical bytes of the receipt without the `signature` field;
 * the result satisfies {@link FlowReleaseReceiptSchema}.
 */
export function signReleaseReceipt(
  unsigned: Omit<FlowReleaseReceipt, "signature">,
  key: Ed25519EvidenceKey,
): FlowReleaseReceipt {
  const value = signEvidenceBytes(key, releaseReceiptSigningBytes(unsigned));
  return {
    ...unsigned,
    signature: { alg: RELEASE_RECEIPT_ALG, kid: key.kid, value },
  };
}

/**
 * Verifies the Ed25519 signature of a release receipt against a public key
 * (raw 32 bytes or a KeyObject). Never throws; malformed signatures simply
 * verify as `false`.
 */
export function verifyReleaseReceiptSignature(
  receipt: FlowReleaseReceipt,
  publicKey: Uint8Array | KeyObject,
): boolean {
  return verifyEvidenceBytes(
    publicKey,
    releaseReceiptSigningBytes(receipt),
    receipt.signature.value,
  );
}
