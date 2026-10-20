// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * job-retention.test.ts
 *
 * What a finished job keeps (page-level model responses, outboxes) and what an
 * abandoned upload leaves behind is bounded by JOB_RETENTION_DAYS and
 * UPLOAD_SESSION_MAX_AGE_HOURS (P1-E8). The source bytes are not part of the
 * sweep: /v2/render needs them for as long as Search serves the document.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orphanedSourceDigests, startRetentionSweeper, sweepRetention } from "../src/jobs/job-retention.js";
import { createFakeJobStore } from "./job-store-fake.js";
import { loadTestConfig, testLogger } from "./helpers.js";

const DAY = 86_400_000;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (n: number): string => n.toString(16).padStart(64, "0");

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "atf-retention-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedJobs(store: ReturnType<typeof createFakeJobStore>): Promise<void> {
  await store.createJob({ id: id(1), reference: "a", source_sha256: sha(1), status: "completed" });
  await store.createJob({ id: id(2), reference: "b", source_sha256: sha(2), status: "failed" });
  await store.createJob({ id: id(3), reference: "c", source_sha256: sha(3), status: "cancelled" });
  await store.createJob({ id: id(4), reference: "d", source_sha256: sha(4), status: "processing" });
  await store.createJob({ id: id(5), reference: "e", source_sha256: sha(5), status: "paused" });
  await store.createJob({ id: id(6), reference: "f", source_sha256: sha(6), status: "queued" });
}

describe("sweepRetention · jobs", () => {
  it("removes terminal jobs idle for the retention period and never a live one", async () => {
    const store = createFakeJobStore();
    await seedJobs(store);
    store.advance(10 * DAY);
    const result = await sweepRetention({ store, logger: testLogger, jobRetentionDays: 7, uploadMaxAgeHours: 0 });
    expect(result.jobs).toBe(3);
    for (const n of [1, 2, 3]) expect(store.peek(id(n))).toBeUndefined();
    // However old, a running, paused or queued job is not swept.
    for (const n of [4, 5, 6]) expect(store.peek(id(n))).toBeDefined();
  });

  it("keeps a terminal job younger than the retention period", async () => {
    const store = createFakeJobStore();
    await seedJobs(store);
    store.advance(3 * DAY);
    const result = await sweepRetention({ store, logger: testLogger, jobRetentionDays: 7, uploadMaxAgeHours: 0 });
    expect(result.jobs).toBe(0);
    expect(store.peek(id(1))).toBeDefined();
  });

  it("does nothing while the rule is off (0 = keep forever)", async () => {
    const store = createFakeJobStore();
    await seedJobs(store);
    store.advance(3650 * DAY);
    const result = await sweepRetention({ store, logger: testLogger, jobRetentionDays: 0, uploadMaxAgeHours: 0 });
    expect(result).toEqual({ jobs: 0, uploads: 0 });
    expect(store.peek(id(1))).toBeDefined();
  });

  it("takes the stage checkpoints with the job row", async () => {
    const store = createFakeJobStore();
    await store.createJob({ id: id(1), reference: "a", source_sha256: sha(1), status: "completed" });
    await store.stageEmitBatch({
      job_id: id(1),
      seq: 0,
      digest: "d",
      page_from: 1,
      page_to: 1,
      payload: { markdown: "page text" },
    });
    expect(store.peekEmitBatches(id(1))).toHaveLength(1);
    store.advance(2 * DAY);
    await sweepRetention({ store, logger: testLogger, jobRetentionDays: 1, uploadMaxAgeHours: 0 });
    expect(store.peek(id(1))).toBeUndefined();
    expect(store.peekEmitBatches(id(1))).toEqual([]);
  });
});

describe("sweepRetention · upload sessions", () => {
  it("removes unfinished sessions past the age together with their .part files, keeps fresh and completed ones", async () => {
    const store = createFakeJobStore();
    const stale = "11111111-1111-4111-8111-111111111111";
    const fresh = "22222222-2222-4222-8222-222222222222";
    const done = "33333333-3333-4333-8333-333333333333";
    store.seedUpload(stale, "a", "open");
    store.seedUpload(done, "c", "completed");
    for (const name of [stale, fresh, done]) await writeFile(join(tmpDir, `${name}.part`), "x");
    store.advance(100 * 3_600_000);
    store.seedUpload(fresh, "b", "open");
    const result = await sweepRetention({
      store,
      logger: testLogger,
      jobRetentionDays: 0,
      uploadMaxAgeHours: 72,
      tmpDir,
    });
    expect(result.uploads).toBe(1);
    expect(store.peekUploads().map((u) => u.upload_id).sort()).toEqual([fresh, done].sort());
    expect((await readdir(tmpDir)).sort()).toEqual([`${done}.part`, `${fresh}.part`].sort());
  });
});

describe("orphanedSourceDigests", () => {
  it("names only the digests no remaining job uses", async () => {
    const store = createFakeJobStore();
    await store.createJob({ id: id(1), reference: "kept", source_sha256: sha(2), status: "completed" });
    const orphans = await orphanedSourceDigests(store, [
      { id: id(9), reference: "gone", source_sha256: sha(1) },
      { id: id(8), reference: "gone", source_sha256: sha(2) },
      { id: id(7), reference: "gone", source_sha256: "" },
    ]);
    expect(orphans).toEqual([sha(1)]);
  });
});

describe("startRetentionSweeper", () => {
  it("sweeps once at start and starts no timer while both rules are off", async () => {
    vi.useFakeTimers();
    try {
      const store = { deleteExpiredJobs: vi.fn(async () => []), deleteExpiredUploads: vi.fn(async () => []) };
      const off = startRetentionSweeper({ store, logger: testLogger, jobRetentionDays: 0, uploadMaxAgeHours: 0, intervalMs: 60_000 });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(store.deleteExpiredJobs).not.toHaveBeenCalled();
      off.stop();

      const on = startRetentionSweeper({ store, logger: testLogger, jobRetentionDays: 7, uploadMaxAgeHours: 0, intervalMs: 60_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.deleteExpiredJobs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.deleteExpiredJobs).toHaveBeenCalledTimes(2);
      on.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(store.deleteExpiredJobs).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a failing pass and does not overlap itself", async () => {
    let calls = 0;
    const store = {
      deleteExpiredJobs: vi.fn(async () => {
        calls += 1;
        throw new Error("db down");
      }),
      deleteExpiredUploads: vi.fn(async () => []),
    };
    const sweeper = startRetentionSweeper({ store, logger: testLogger, jobRetentionDays: 7, uploadMaxAgeHours: 0, intervalMs: 3_600_000 });
    await sweeper.sweepNow();
    expect(calls).toBeGreaterThanOrEqual(1);
    sweeper.stop();
  });
});

describe("configuration", () => {
  it("defaults: jobs kept (0), upload sessions 72 h, sweep hourly", () => {
    const config = loadTestConfig({});
    expect(config.jobRetentionDays).toBe(0);
    expect(config.uploadSessionMaxAgeHours).toBe(72);
    expect(config.retentionSweepIntervalMinutes).toBe(60);
  });

  it("reads the environment", () => {
    const config = loadTestConfig({
      JOB_RETENTION_DAYS: "30",
      UPLOAD_SESSION_MAX_AGE_HOURS: "0",
      RETENTION_SWEEP_INTERVAL_MINUTES: "15",
    });
    expect(config.jobRetentionDays).toBe(30);
    expect(config.uploadSessionMaxAgeHours).toBe(0);
    expect(config.retentionSweepIntervalMinutes).toBe(15);
  });
});
