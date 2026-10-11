// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/budget.ts
 *
 * The concrete token-budget ledger backed by a job's `token_budget` /
 * `tokens_used` / `tokens_reserved` counters (design §9b.2, requirement 4.9).
 *
 * The stage runner reserves a stage's estimate BEFORE the model call and
 * settles it after. The reservation is one SQL statement (`tokens_reserved +
 * est WHERE budget − used − reserved >= est`), so concurrent page stages of the
 * same job can never together pass a check the budget only covers once — the
 * old read-then-call-then-consume sequence let a window of parallel pages
 * overdraw the budget. The settlement (release the reservation, book the actual
 * spend) runs in the same transaction as the stage's checkpoint write
 * ({@link BudgetLedger.settleInCheckpoint}), so result and cost are recorded
 * together or not at all. A crashed worker's reservations are dropped by the
 * next claim, which owns no calls in flight.
 *
 * A job with no cap uses `unlimitedBudget` from the stage runner instead — this
 * ledger is only constructed when `token_budget IS NOT NULL`.
 */

import type { ExtractStore } from "../persistence/index.js";
import type { Fence, JobRow } from "../persistence/types.js";
import type { BudgetLedger } from "./stage-runner.js";

/**
 * The fraction of a job's token budget at which a single early-warning is
 * recorded (design §9, requirement 6.6: "warning at 80 %"). The hard cap at
 * 100 % is the stage runner's budget guard, which parks the job in
 * `paused(reason=budget)` (requirement 4.9); this warning is the heads-up
 * before that, so an operator can raise the budget before the job stalls.
 */
export const BUDGET_WARN_FRACTION = 0.8;

/**
 * The config-marker key that records the 80 % warning has already fired. It
 * lives on the job's `config` JSON (merged, not overwritten) so the warning is
 * emitted EXACTLY ONCE across every stage and every resume, rather than once
 * per stage — the ledger's settlement runs after every model call.
 */
export const BUDGET_WARN_MARKER = "budgetWarned80";

/** The human-facing warning line recorded on the job when it crosses 80 %. */
export function budgetWarningLine(used: number, budget: number): string {
  const pct = Math.round((used / budget) * 100);
  return `Token-Budget zu ${pct}% ausgeschöpft (${used}/${budget}); bei 100% wird der Job pausiert (paused(reason=budget)).`;
}

/**
 * A ledger over one job's token counters. `fence` is the worker's lease token;
 * every write of the ledger is fenced with it (omitted only by tests that
 * drive the ledger without a lease).
 *
 * On the settlement that first carries cumulative `tokens_used` across
 * {@link BUDGET_WARN_FRACTION} of `token_budget`, it records a one-time warning
 * on the job (requirement 6.6). The fire-once guarantee is a marker merged into
 * the job's `config`: the append and the marker are only written when the
 * marker was absent AND this increment is the one that crossed the threshold,
 * so concurrent page stages and later resumes never re-emit it.
 */
export function createDbBudgetLedger(store: ExtractStore, jobId: string, fence?: Fence): BudgetLedger {
  async function warnIfCrossed(updated: JobRow | null, tokens: number): Promise<void> {
    if (updated === null || updated.token_budget === null || tokens <= 0) return;
    const budget = Number(updated.token_budget);
    if (budget <= 0) return;
    const usedAfter = Number(updated.tokens_used);
    const usedBefore = usedAfter - tokens;
    const threshold = budget * BUDGET_WARN_FRACTION;

    // Only the increment that actually crosses the 80 % line records the
    // warning; a spend wholly below or wholly above it does nothing here (the
    // 100 % hard cap is the stage runner's guard, not this ledger).
    const crossed = usedBefore < threshold && usedAfter >= threshold;
    if (!crossed) return;

    // Fire-once: skip when the marker is already set (a concurrent stage that
    // also straddled the line, or a resume).
    if (updated.config?.[BUDGET_WARN_MARKER] === true) return;
    await store.patchJobConfig(jobId, { [BUDGET_WARN_MARKER]: true }, fence);
    await store.appendJobWarning(jobId, budgetWarningLine(usedAfter, budget), fence);
  }

  return {
    async remaining() {
      const job = await store.getJob(jobId);
      if (job === null || job.token_budget === null) return null;
      return Math.max(
        0,
        Number(job.token_budget) - Number(job.tokens_used) - Number(job.tokens_reserved ?? 0),
      );
    },
    async consume(tokens) {
      if (tokens <= 0) return;
      // The atomic increment returns the updated row, so we learn the new total
      // and the budget without a second read racing another stage's spend.
      const updated = await store.consumeJobTokens(jobId, tokens, fence);
      await warnIfCrossed(updated, tokens);
    },
    async reserve(tokens) {
      if (tokens <= 0) return true;
      return (await store.reserveJobTokens(jobId, tokens, fence)) !== null;
    },
    async release(tokens) {
      if (tokens <= 0) return;
      await store.settleJobTokens(jobId, { reserved: tokens, used: 0 }, fence);
    },
    settleInCheckpoint: {
      onSettled: (job, used) => warnIfCrossed(job, used),
    },
  };
}

// ─── Tenant daily vision-page budget (task 7.7, requirement 5.8) ─────────────

/**
 * The second, independent budget axis: while the ledger above caps ONE job's
 * token spend, this one caps how many VLM pages a TENANT may spend per UTC
 * day across all of its jobs (`VISION_BUDGET_PAGES_PER_DAY`). Neither
 * subsumes the other — a tenant running many small jobs exhausts neither
 * per-job cap while its daily cost grows without bound.
 *
 * Only pages that actually reach the model are counted: a fast-path page, a
 * render-hash dedup reuse, or a checkpoint replay on resume consumes no VLM
 * page and is charged nothing. The counter lives in
 * `extract.vision_daily_usage` and the increment is one atomic upsert, so
 * concurrent pages — across jobs and worker instances — can never together
 * cross the cap. A refusal marks the ledger exhausted locally — for that day
 * only, so a page arriving after midnight is judged against the new bucket —
 * and later pages of the same run stop calling the model at all.
 *
 * A job without a tenant (`created_by_tenant IS NULL`, e.g. created before
 * ownership tracking or by an unauthenticated local dev) is not capped —
 * there is no tenant to attribute the spend to.
 */
export interface TenantDailyPageBudget {
  /**
   * Book one VLM page for the tenant's current UTC day. Returns false when
   * the daily cap is reached — the counter is then unchanged and the ledger
   * is marked exhausted.
   */
  tryConsumePage(): Promise<boolean>;
  /**
   * True once a booking was refused for the current UTC day; later pages
   * skip the model entirely. A new UTC day clears the flag.
   */
  isExhausted(): boolean;
}

/**
 * The failure line recorded on a job whose tenant daily budget is exhausted
 * (design §Budget: the job goes `failed`, not `paused` — waiting inside the
 * same day changes nothing). Carries the error code so the job warning names
 * `BUDGET_EXCEEDED` verbatim.
 */
export function tenantDailyBudgetFailureMessage(limit: number): string {
  return (
    `BUDGET_EXCEEDED: Das Tagesbudget des Tenants ist erschöpft ` +
    `(VISION_BUDGET_PAGES_PER_DAY=${limit}); ab dem nächsten UTC-Tag kann erneut verarbeitet werden.`
  );
}

/** The UTC day key (`YYYY-MM-DD`) the counter rows are bucketed by. */
export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export function createTenantDailyPageBudget(
  store: ExtractStore,
  opts: {
    tenantId: string | null | undefined;
    limit: number;
    now?: () => Date;
  },
): TenantDailyPageBudget {
  const unlimited =
    opts.limit <= 0 ||
    opts.tenantId === null ||
    opts.tenantId === undefined ||
    opts.tenantId === "";
  // The day the last refusal belonged to. Day-scoped rather than a plain
  // boolean so a refusal at 23:59 does not also reject the first page after
  // midnight, which is a fresh bucket with a fresh allowance.
  let exhaustedDay: string | null = null;

  if (unlimited) {
    return {
      async tryConsumePage() {
        return true;
      },
      isExhausted: () => false,
    };
  }

  const now = opts.now ?? ((): Date => new Date());
  return {
    async tryConsumePage() {
      const day = utcDayKey(now());
      if (exhaustedDay === day) return false;
      const used = await store.consumeVisionDailyPages(
        opts.tenantId as string,
        day,
        1,
        opts.limit,
      );
      if (used === null) {
        exhaustedDay = day;
        return false;
      }
      return true;
    },
    isExhausted: () => exhaustedDay === utcDayKey(now()),
  };
}
