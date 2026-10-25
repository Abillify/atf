// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-view.test.ts
 *
 * The JobRow → Job translation and its derived fields: per-stage progress and
 * the remaining-time estimate. The ETA is a
 * throughput-based `remaining × perUnit` estimate measured from the first stage
 * checkpoint, so a job that sat queued for a long time before processing does
 * not report an inflated remaining time.
 */

import { describe, expect, it } from "vitest";
import {
  computeProgress,
  estimateEtaSeconds,
  toJobView,
} from "../src/jobs/job-view.js";
import type { JobRow, PageStageRow } from "../src/persistence/types.js";

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  const now = new Date();
  return {
    id: "00000000-0000-0000-0000-000000000001",
    reference: "tests/handbuch.pdf",
    status: "processing",
    pause_reason: null,
    config: {},
    pipeline_hash: null,
    prompt_hash: null,
    resume_policy: "pin",
    visibility: "progressive",
    priority: 0,
    token_budget: null,
    tokens_used: 0,
    tokens_reserved: 0,
    emit_generation: 0,
    auto_resume: false,
    cost_usd: 0,
    page_count: 10,
    source_sha256: "a".repeat(64),
    collection: null,
    revision_id: null,
    callback_url: null,
    warnings: [],
    lease_holder: null,
    lease_epoch: 0,
    lease_expires_at: null,
    heartbeat_at: null,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function stage(page: number, stageName: string, status: PageStageRow["status"], at: Date): PageStageRow {
  return {
    job_id: "00000000-0000-0000-0000-000000000001",
    page,
    stage: stageName,
    input_hash: "h",
    status,
    output: null,
    attempts: 0,
    next_attempt_at: null,
    error: null,
    created_at: at,
    updated_at: at,
  };
}

describe("computeProgress", () => {
  it("reads done/total per stage against the page count", () => {
    const rows = [
      stage(1, "vision1", "done", new Date()),
      stage(2, "vision1", "done", new Date()),
      stage(3, "vision1", "failed", new Date()),
    ];
    const progress = computeProgress(rows, 10);
    expect(progress.vision1).toEqual({ done: 2, total: 10, failed: 1 });
  });
});

describe("estimateEtaSeconds (requirement 4.11)", () => {
  it("estimates remaining from measured throughput, not queue-wait", () => {
    // 10-page job; 5 of one stage done. Processing began 50s ago (not the 1h the
    // job sat queued). perUnit = 50s/5 = 10s; 5 remaining → 50s.
    const created = new Date(Date.now() - 60 * 60 * 1000); // queued an hour ago
    const processingStart = Date.now() - 50_000; // processing began 50s ago
    const row = jobRow({ created_at: created, page_count: 10 });
    const progress = computeProgress(
      [
        stage(1, "vision1", "done", new Date()),
        stage(2, "vision1", "done", new Date()),
        stage(3, "vision1", "done", new Date()),
        stage(4, "vision1", "done", new Date()),
        stage(5, "vision1", "done", new Date()),
      ],
      10,
    );
    const eta = estimateEtaSeconds(row, progress, Date.now(), processingStart);
    // ~50s, tolerant of a few ms of test overhead.
    expect(eta).not.toBeNull();
    expect(eta).toBeGreaterThanOrEqual(45);
    expect(eta).toBeLessThanOrEqual(55);
  });

  it("returns null when no work has finished yet (no throughput to measure)", () => {
    const row = jobRow({ page_count: 10 });
    const progress = computeProgress([stage(1, "vision1", "pending", new Date())], 10);
    expect(estimateEtaSeconds(row, progress, Date.now(), Date.now() - 10_000)).toBeNull();
  });

  it("returns 0 when everything is done", () => {
    const row = jobRow({ page_count: 2 });
    const progress = computeProgress(
      [stage(1, "emitted", "done", new Date()), stage(2, "emitted", "done", new Date())],
      2,
    );
    expect(estimateEtaSeconds(row, progress, Date.now(), Date.now() - 10_000)).toBe(0);
  });

  it("returns null for a terminal or non-running job", () => {
    const row = jobRow({ status: "completed", page_count: 10 });
    const progress = computeProgress([stage(1, "vision1", "done", new Date())], 10);
    expect(estimateEtaSeconds(row, progress)).toBeNull();
  });
});

describe("toJobView", () => {
  it("surfaces etaSeconds on the detail view when stage rows are supplied", () => {
    const start = new Date(Date.now() - 20_000);
    const row = jobRow({ page_count: 4, created_at: new Date(Date.now() - 30_000) });
    const stages = [
      stage(1, "vision1", "done", start),
      stage(2, "vision1", "done", start),
    ];
    const view = toJobView(row, stages);
    expect(view.progress?.vision1?.done).toBe(2);
    // ETA is populated (a number, since throughput is measurable).
    expect(typeof view.etaSeconds).toBe("number");
  });

  it("omits progress/eta on the cheap list view (no stage rows)", () => {
    const view = toJobView(jobRow());
    expect(view.progress).toBeUndefined();
    expect(view.etaSeconds).toBeUndefined();
  });
});
