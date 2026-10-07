// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** Storage-agnostic retention controls for public deployments. */
export interface ErasureSubject { tenantId?: string; userId?: string; }
export interface RetentionTarget { name: string; purgeOlderThan?: (cutoffIso: string) => Promise<number>; eraseSubject?: (subject: ErasureSubject) => Promise<number>; }
export interface RetentionTargetDescription { name: string; agePurge: boolean; subjectErase: boolean; maxAgeDays: number | null; }
export interface RetentionSweepResult { target: string; maxAgeDays: number | null; purged: number; skipped: boolean; error?: string; }
export interface RetentionForgetResult { target: string; erased: number; error?: string; }
export interface RetentionServiceOptions { maxAgeDaysByTarget?: Record<string, number>; defaultMaxAgeDays?: number; }
export interface RetentionLogger { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void; }
export interface RetentionDependencies { logger?: RetentionLogger; clock?: () => number; }

export function isValidSubject(subject: ErasureSubject): boolean {
  return [subject.tenantId, subject.userId].some((value) => typeof value === "string" && value.trim().length > 0);
}

export class RetentionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly targets: RetentionTarget[],
    private readonly options: RetentionServiceOptions = {},
    private readonly deps: RetentionDependencies = {},
  ) {}
  private maxAgeDays(target: RetentionTarget): number | undefined {
    return (
      this.options.maxAgeDaysByTarget?.[target.name] ??
      this.options.defaultMaxAgeDays
    );
  }
  get hasActiveWindows(): boolean {
    return this.targets.some(
      (target) =>
        target.purgeOlderThan !== undefined &&
        this.maxAgeDays(target) !== undefined,
    );
  }
  describeTargets(): RetentionTargetDescription[] {
    return this.targets.map((target) => ({
      name: target.name,
      agePurge: target.purgeOlderThan !== undefined,
      subjectErase: target.eraseSubject !== undefined,
      maxAgeDays: this.maxAgeDays(target) ?? null,
    }));
  }
  async sweep(): Promise<RetentionSweepResult[]> {
    const now = (this.deps.clock ?? Date.now)();
    return Promise.all(
      this.targets
        .filter((target) => target.purgeOlderThan !== undefined)
        .map(async (target) => {
          const maxAgeDays = this.maxAgeDays(target);
          if (maxAgeDays === undefined)
            return {
              target: target.name,
              maxAgeDays: null,
              purged: 0,
              skipped: true,
            };
          try {
            const purged = await target.purgeOlderThan!(
              new Date(now - maxAgeDays * 86_400_000).toISOString(),
            );
            return { target: target.name, maxAgeDays, purged, skipped: false };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.deps.logger?.warn("Retention target sweep failed", {
              target: target.name,
              error: message,
            });
            return {
              target: target.name,
              maxAgeDays,
              purged: 0,
              skipped: false,
              error: message,
            };
          }
        }),
    );
  }
  async forget(
    subject: ErasureSubject,
    onlyTargets?: readonly string[],
  ): Promise<RetentionForgetResult[]> {
    if (!isValidSubject(subject))
      throw new Error(
        "Retention erasure requires a non-empty tenantId or userId",
      );
    const only = onlyTargets === undefined ? undefined : new Set(onlyTargets);
    return Promise.all(
      this.targets
        .filter(
          (target) =>
            target.eraseSubject !== undefined &&
            (only === undefined || only.has(target.name)),
        )
        .map(async (target) => {
          try {
            return {
              target: target.name,
              erased: await target.eraseSubject!(subject),
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.deps.logger?.warn("Retention target erasure failed", {
              target: target.name,
              error: message,
            });
            return { target: target.name, erased: 0, error: message };
          }
        }),
    );
  }
  start(intervalMs: number): boolean {
    if (!this.hasActiveWindows) return false;
    if (this.timer !== undefined) return true;
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref?.();
    return true;
  }
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
