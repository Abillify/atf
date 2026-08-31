// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the RetentionService orchestrator (pure, fake targets).
 */

import { describe, it, expect } from "bun:test";
import {
  RetentionService,
  isValidSubject,
  type RetentionTarget,
  type ErasureSubject,
} from "../retention.js";

/** A fake target recording the cutoffs/subjects it was asked to purge/erase. */
class FakeTarget implements RetentionTarget {
  cutoffs: string[] = [];
  subjects: ErasureSubject[] = [];
  constructor(
    public readonly name: string,
    private readonly opts: {
      ageReturn?: number;
      eraseReturn?: number;
      ageThrows?: boolean;
      eraseThrows?: boolean;
      supportsAge?: boolean;
      supportsErase?: boolean;
    } = {},
  ) {
    if (opts.supportsAge === false)
      delete (this as Partial<RetentionTarget>).purgeOlderThan;
    if (opts.supportsErase === false)
      delete (this as Partial<RetentionTarget>).eraseSubject;
  }
  purgeOlderThan? = async (cutoffIso: string): Promise<number> => {
    if (this.opts.ageThrows) throw new Error("age boom");
    this.cutoffs.push(cutoffIso);
    return this.opts.ageReturn ?? 0;
  };
  eraseSubject? = async (subject: ErasureSubject): Promise<number> => {
    if (this.opts.eraseThrows) throw new Error("erase boom");
    this.subjects.push(subject);
    return this.opts.eraseReturn ?? 0;
  };
}

const at = (iso: string) => new Date(iso).getTime();

describe("isValidSubject", () => {
  it("requires at least one non-empty field", () => {
    expect(isValidSubject({})).toBe(false);
    expect(isValidSubject({ tenantId: "  " })).toBe(false);
    expect(isValidSubject({ tenantId: "acme" })).toBe(true);
    expect(isValidSubject({ userId: "u@x.de" })).toBe(true);
  });
});

describe("RetentionService.sweep", () => {
  it("purges age-capable targets using their configured window", async () => {
    const snapshots = new FakeTarget("snapshots", { ageReturn: 3 });
    const history = new FakeTarget("history", { ageReturn: 7 });
    const svc = new RetentionService(
      [snapshots, history],
      { maxAgeDaysByTarget: { snapshots: 30, history: 90 } },
      { clock: () => at("2026-01-31T00:00:00.000Z") },
    );

    const report = await svc.sweep();

    expect(report).toEqual([
      { target: "snapshots", maxAgeDays: 30, purged: 3, skipped: false },
      { target: "history", maxAgeDays: 90, purged: 7, skipped: false },
    ]);
    // 30 days before 2026-01-31 → 2026-01-01
    expect(snapshots.cutoffs[0]).toBe("2026-01-01T00:00:00.000Z");
    // 90 days before 2026-01-31 → 2025-11-02
    expect(history.cutoffs[0]).toBe("2025-11-02T00:00:00.000Z");
  });

  it("skips targets with no configured window", async () => {
    const t = new FakeTarget("snapshots", { ageReturn: 5 });
    const svc = new RetentionService(
      [t],
      {},
      { clock: () => at("2026-01-31T00:00:00.000Z") },
    );
    const report = await svc.sweep();
    expect(report).toEqual([
      { target: "snapshots", maxAgeDays: null, purged: 0, skipped: true },
    ]);
    expect(t.cutoffs).toHaveLength(0);
  });

  it("applies defaultMaxAgeDays to age-capable targets without an explicit window", async () => {
    const t = new FakeTarget("memory", { ageReturn: 2 });
    const svc = new RetentionService(
      [t],
      { defaultMaxAgeDays: 10 },
      { clock: () => at("2026-01-31T00:00:00.000Z") },
    );
    const report = await svc.sweep();
    expect(report[0]).toMatchObject({
      target: "memory",
      maxAgeDays: 10,
      purged: 2,
    });
  });

  it("isolates a failing target without aborting the rest", async () => {
    const bad = new FakeTarget("snapshots", { ageThrows: true });
    const good = new FakeTarget("history", { ageReturn: 4 });
    const svc = new RetentionService(
      [bad, good],
      { defaultMaxAgeDays: 30 },
      { clock: () => at("2026-01-31T00:00:00.000Z") },
    );
    const report = await svc.sweep();
    expect(report[0]).toMatchObject({
      target: "snapshots",
      error: "age boom",
      purged: 0,
    });
    expect(report[1]).toMatchObject({ target: "history", purged: 4 });
  });

  it("ignores targets that do not support age purge", async () => {
    const eraseOnly = new FakeTarget("memory", { supportsAge: false });
    const svc = new RetentionService([eraseOnly], { defaultMaxAgeDays: 30 });
    const report = await svc.sweep();
    expect(report).toHaveLength(0);
  });
});

describe("RetentionService.forget", () => {
  it("erases the subject across all subject-capable targets", async () => {
    const memory = new FakeTarget("memory", { eraseReturn: 11 });
    const snapshots = new FakeTarget("snapshots", { eraseReturn: 2 });
    const svc = new RetentionService([memory, snapshots], {});
    const subject = { tenantId: "acme", userId: "u@x.de" };

    const report = await svc.forget(subject);

    expect(report).toEqual([
      { target: "memory", erased: 11 },
      { target: "snapshots", erased: 2 },
    ]);
    expect(memory.subjects[0]).toEqual(subject);
  });

  it("rejects an empty subject (never erases everything)", async () => {
    const svc = new RetentionService([new FakeTarget("memory")], {});
    await expect(svc.forget({})).rejects.toThrow(/tenantId or userId/);
  });

  it("isolates a failing target during erasure", async () => {
    const bad = new FakeTarget("memory", { eraseThrows: true });
    const good = new FakeTarget("history", { eraseReturn: 9 });
    const svc = new RetentionService([bad, good], {});
    const report = await svc.forget({ tenantId: "acme" });
    expect(report[0]).toMatchObject({
      target: "memory",
      erased: 0,
      error: "erase boom",
    });
    expect(report[1]).toMatchObject({ target: "history", erased: 9 });
  });

  it("skips targets that do not support subject erasure", async () => {
    const ageOnly = new FakeTarget("history", { supportsErase: false });
    const svc = new RetentionService([ageOnly], {});
    const report = await svc.forget({ tenantId: "acme" });
    expect(report).toHaveLength(0);
  });
});

describe("RetentionService capabilities & scheduling", () => {
  it("describes target capabilities and windows", () => {
    const both = new FakeTarget("snapshots");
    const eraseOnly = new FakeTarget("memory", { supportsAge: false });
    const svc = new RetentionService([both, eraseOnly], {
      maxAgeDaysByTarget: { snapshots: 30 },
    });
    expect(svc.describeTargets()).toEqual([
      { name: "snapshots", agePurge: true, subjectErase: true, maxAgeDays: 30 },
      { name: "memory", agePurge: false, subjectErase: true, maxAgeDays: null },
    ]);
  });

  it("reports active windows correctly", () => {
    const t = new FakeTarget("snapshots");
    expect(new RetentionService([t], {}).hasActiveWindows).toBe(false);
    expect(
      new RetentionService([t], { maxAgeDaysByTarget: { snapshots: 1 } })
        .hasActiveWindows,
    ).toBe(true);
  });

  it("does not start a timer when there are no active windows", () => {
    const t = new FakeTarget("memory", { supportsAge: false });
    const svc = new RetentionService([t], {});
    expect(svc.start(1000)).toBe(false);
    svc.stop();
  });

  it("starts and stops a sweep timer when windows are active", () => {
    const t = new FakeTarget("snapshots");
    const svc = new RetentionService([t], {
      maxAgeDaysByTarget: { snapshots: 1 },
    });
    expect(svc.start(60_000)).toBe(true);
    expect(svc.start(60_000)).toBe(true); // idempotent
    svc.stop();
  });
});
