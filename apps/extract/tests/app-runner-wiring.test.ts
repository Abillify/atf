// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * app-runner-wiring.test.ts
 *
 * `createApp` wires the v2 job runner with the deterministic S2 page analyzer
 * (design §5 S2, requirement 7.1) and the shared metrics registry
 * (requirement 18.1). Before this, `createPageAnalyzer` was only ever called
 * from tests, so production pages got no heading hints, no fast path, no
 * region text and no furniture.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import { createJobRunner, type JobRunnerDeps } from "../src/jobs/job-runner.js";
import { HttpMetrics } from "../src/http-metrics.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { createFakeJobStore } from "./job-store-fake.js";
import { loadTestConfig, stubExtractor, stubVisionClient, testLogger } from "./helpers.js";

let storeDir: string;
let tmpUploadDir: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "atf-wiring-store-"));
  tmpUploadDir = await mkdtemp(join(tmpdir(), "atf-wiring-tmp-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await rm(storeDir, { recursive: true, force: true });
  await rm(tmpUploadDir, { recursive: true, force: true });
});

describe("createApp · job runner wiring", () => {
  it("builds the runner with the S2 analyzer (shared, memoised capability probe) and HttpMetrics", async () => {
    const captured: JobRunnerDeps[] = [];
    const probe = vi.fn(async () => ({ supported: false, version: "0.26", reason: "too old" }));
    const metrics = new HttpMetrics();
    const created = createApp(loadTestConfig({ SOURCE_STORE_DIR: storeDir, UPLOAD_TMP_DIR: tmpUploadDir }), {
      logger: testLogger,
      vision: stubVisionClient(),
      extractor: stubExtractor(),
      probeBinary: async () => ({ available: true, version: "stub" }),
      store: createFakeJobStore(),
      sourceStore: createFilesystemSourceStore(storeDir),
      metrics,
      bboxLayoutProbe: probe,
      createJobRunner: (deps) => {
        captured.push(deps);
        return createJobRunner(deps);
      },
    });
    cleanups.push(created.cleanup);

    expect(created.worker).not.toBeNull();
    expect(captured).toHaveLength(1);
    const deps = captured[0];
    if (deps === undefined) throw new Error("runner not built");

    // The analyzer is wired …
    expect(deps.analyzer).toBeTruthy();
    // … and the shared metrics registry is passed straight through (its
    // recordStage feeds the per-stage series).
    expect(deps.metrics).toBe(metrics);

    // The analyzer degrades cleanly when poppler lacks -bbox-layout, and the
    // capability is probed once per process, not once per job/page.
    const first = deps.analyzer?.forSource({ pdfPath: "/tmp/does-not-matter.pdf", home: tmpUploadDir });
    const second = deps.analyzer?.forSource({ pdfPath: "/tmp/other.pdf", home: tmpUploadDir });
    const a = await first?.analyze(1);
    const b = await second?.analyze(2);
    expect(a?.blocks).toEqual([]);
    expect(b?.words).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect((await first?.capability())?.supported).toBe(false);
  });
});
