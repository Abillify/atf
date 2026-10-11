// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 38: logout ends all runs without deletions
 *
 * **Validates: Requirements 3.5, 3.8, 9.4**
 *
 * After `stopAll("logout")` (via {@link performLogout}): no active run,
 * no pending, no new runs until the next login; aborted runs end
 * `incomplete`; no DELETE requests go to Extract (9.4); the
 * Sync_State is flushed BEFORE the Extract tokens are deleted (3.5).
 * No fake timers are used; the run really blocks in `open` until the
 * abort arrives.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { SourceAdapter, SourceItem } from "../../src/sources/types.js";
import { Scheduler, performLogout } from "../../src/schedule/scheduler.js";
import type { TokenProvider } from "../../src/auth/manager.js";
import { NeedsAuthTracker, runSourceOnce, type RunReport } from "../../src/sync/run.js";
import { SyncStateStore } from "../../src/state/store.js";
import { ExtractHttpClient } from "../../src/http/client.js";
import { MemoryCredentialStore } from "../../src/credentials/memory-store.js";
import { outpostConfigSchema, type OutpostConfig, type SourceConfig } from "../../src/config/schema.js";
import { contentMarker, type HarnessItem } from "../fakes/fake-adapter.js";
import { FakeExtract } from "../fakes/fake-extract.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";
import { testLogger } from "../fakes/test-logger.js";

/** Adapter whose `open` blocks until the abort; the run stays active. */
function blockingAdapter(items: readonly HarnessItem[]): SourceAdapter & {
  readonly openCalls: string[];
} {
  const openCalls: string[] = [];
  return {
    openCalls,
    async *list(signal: AbortSignal): AsyncIterable<SourceItem> {
      for (const item of items) {
        if (Boolean(signal.aborted)) throw new Error("listing aborted");
        yield {
          quellId: item.quellId,
          name: item.quellId,
          size: item.content.byteLength,
          modified: new Date("2026-01-01T00:00:00Z"),
          marker: contentMarker(item.content),
        };
      }
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      openCalls.push(item.quellId);
      await new Promise<void>((resolve) => {
        if (Boolean(signal.aborted)) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (Boolean(signal.aborted)) throw new Error("open aborted");
      const source = items.find((i) => i.quellId === item.quellId);
      if (source === undefined) throw new Error(`unknown ${item.quellId}`);
      return Readable.from(Buffer.from(source.content));
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("Property 38: logout ends all runs without deletions", () => {
  it("stopAll: incomplete, no DELETEs, flush before token deletion, no follow-up runs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}\.txt$/), {
          minLength: 1,
          maxLength: 6,
          selector: (s) => s,
        }),
        async (quellIds) => {
          const specs = quellIds.map((quellId) => ({
            quellId,
            size: 8,
          }));
          const items: HarnessItem[] = specs.map((s) => ({
            quellId: s.quellId,
            content: new Uint8Array(s.size).fill(97),
          }));
          const dir = await mkdtemp(path.join(tmpdir(), "atf-logout-"));
          const cfg: OutpostConfig = outpostConfigSchema.parse({
            extractUrl: "https://extract.example.com",
            collection: "main",
            syncIntervalSec: 900,
          });
          const src = {
            type: "local",
            path: "/src",
            id: "logout-src",
            watch: false,
          } as unknown as SourceConfig;
          const cfgWith = { ...cfg, sources: [src] };

          const fake = new FakeExtract();
          const store = await SyncStateStore.open({
            dir,
            sourceId: src.id,
            collection: cfg.collection,
          });
          const client = new ExtractHttpClient({
            extractUrl: "https://extract.example.com",
            tokenProvider: new FakeTokenProvider(),
            version: "0.0.0-test",
            runtime: "docker",
            fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
          });
          const needsAuth = new NeedsAuthTracker();
          const adapter = blockingAdapter(items);
          const reports: RunReport[] = [];
          let runCount = 0;
          const order: string[] = [];

          const scheduler = new Scheduler({
            cfg: cfgWith,
            logger: testLogger(),
            flushSource: async () => {
              order.push("flush");
              await store.flush();
            },
            runSource: async (_s, signal) => {
              runCount += 1;
              const report = await runSourceOnce({
                src,
                cfg: cfgWith,
                store,
                client,
                credentialStore: new MemoryCredentialStore(),
                env: {},
                rejectedIds: new Set<string>(),
                makeAdapter: () => adapter,
                resolveCredential: async () => ({ kind: "static" }),
                limits: {
                  resumableThresholdBytes: cfg.resumableThresholdBytes,
                  maxUploadBytes: 52_428_800,
                },
                logger: testLogger(),
                needsAuth,
                signal,
                sleep: async () => undefined,
                rand: () => 0.5,
                now: () => "2026-01-01T00:00:00.000Z",
                nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
              });
              reports.push(report);
              return report;
            },
          });

          const tokenProvider: TokenProvider = {
            getAccessToken: async () => "tok",
            forceRefresh: async () => "tok",
            logout: async () => {
              order.push("logout");
            },
          };

          // Start a run, trigger during the run → pending (gets discarded).
          scheduler.trigger(src.id);
          await vi_waitUntil(() => adapter.openCalls.length >= 1);
          scheduler.trigger(src.id);

          await performLogout(scheduler, tokenProvider);

          // 1. The aborted run ended incomplete, without a delete phase.
          expect(reports).toHaveLength(1);
          expect(reports[0]?.outcome).toBe("incomplete");
          expect(reports[0]?.deletePhase).toBe("skipped-incomplete");

          // 2. No DELETE request to Extract (9.4).
          expect(fake.requests.filter((r) => r.method === "DELETE")).toEqual([]);

          // 3. The flush happened BEFORE token deletion (3.5), exactly once per source.
          expect(order).toEqual(["flush", "logout"]);

          // 4. No active run, no pending, status stopped.
          const view = scheduler.status();
          expect(view).toHaveLength(1);
          expect(view[0]?.status).toBe("stopped");
          expect(view[0]?.pending).toBe(false);

          // 5. No new runs until the next login (3.8).
          scheduler.trigger(src.id);
          scheduler.credentialChanged(src.id);
          await sleep(20);
          expect(runCount).toBe(1);

          await store.close();
        },
      ),
      { numRuns: 20 },
    );
  });
});

/** Waits until `pred()` is true (real timers, polling). */
async function vi_waitUntil(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timeout");
    await sleep(5);
  }
}
