// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Test harness around {@link runSourceOnce}: wires a {@link FakeExtract} as
 * `ExtractHttpClient.fetchImpl`, a {@link fakeAdapter} as the source, a
 * `MemoryCredentialStore`, a temp-dir {@link SyncStateStore}, and instant
 * sleep/rand/clock. Tests control the credential through
 * {@link HarnessOptions.credential} and can abort the run from item hooks.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { ExtractHttpClient } from "../../src/http/client.js";
import { MemoryCredentialStore } from "../../src/credentials/memory-store.js";
import type { CredentialStore } from "../../src/credentials/store.js";
import type { Env } from "../../src/config/secrets-file.js";
import { outpostConfigSchema, type OutpostConfig, type SourceConfig } from "../../src/config/schema.js";
import { SyncStateStore } from "../../src/state/store.js";
import { NeedsAuthTracker, runSourceOnce, type RunReport, type SourceCredentialUnion } from "../../src/sync/run.js";
import type { UploadLimits } from "../../src/sync/planner.js";
import type { SourceAdapter } from "../../src/sources/types.js";
import { fakeAdapter, type FakeAdapter, type HarnessItem } from "./fake-adapter.js";
import { FakeExtract } from "./fake-extract.js";
import { FakeTokenProvider } from "./fake-token-provider.js";
import { testLogger } from "./test-logger.js";

export interface HarnessOptions {
  items: readonly HarnessItem[];
  /** Reuse an existing state dir (follow-up runs); created when omitted. */
  dir?: string;
  /** Config overrides merged over the defaults. */
  config?: Partial<OutpostConfig>;
  limits?: Partial<UploadLimits>;
  /** Credential the (injected) resolver returns. Default: static. */
  credential?: SourceCredentialUnion;
  /** Custom adapter factory (default: fakeAdapter over `items`). */
  makeAdapter?: (
    src: SourceConfig,
    credential: SourceCredentialUnion,
  ) => SourceAdapter | Promise<SourceAdapter>;
  credentialStore?: CredentialStore;
  env?: Env;
  rejectedIds?: ReadonlySet<string>;
  fake?: FakeExtract;
  logger?: Logger;
  needsAuth?: NeedsAuthTracker;
  signal?: AbortSignal;
  /** Source overrides (id, type, collection…). */
  source?: Partial<SourceConfig> & { id?: string; type?: SourceConfig["type"] };
  /** Use the REAL resolveSourceCredential instead of the injected one. */
  realResolve?: boolean;
  /**
   * Simulate an explicit user confirmation (confirm-file / env, 9.5/9.11):
   * the hash the user confirmed for the current candidate set.
   */
  deleteConfirmation?: string;
  /** Mutate the opened store (e.g. crash after n journal writes). */
  storeTweak?: (store: SyncStateStore, controller: AbortController) => void;
}

export interface Harness {
  dir: string;
  cfg: OutpostConfig;
  src: SourceConfig;
  store: SyncStateStore;
  fake: FakeExtract;
  adapter: FakeAdapter;
  credentialStore: CredentialStore;
  needsAuth: NeedsAuthTracker;
  controller: AbortController;
  run: () => Promise<RunReport>;
  close: () => Promise<void>;
}

export const STATIC_CREDENTIAL: SourceCredentialUnion = { kind: "static" };

export async function makeHarness(options: HarnessOptions): Promise<Harness> {
  const dir = options.dir ?? (await mkdtemp(path.join(tmpdir(), "atf-outpost-test-")));
  const fake = options.fake ?? new FakeExtract();
  const cfg: OutpostConfig = {
    ...outpostConfigSchema.parse({
      extractUrl: "https://extract.example.com",
      collection: "main",
    }),
    ...options.config,
  };
  const src = {
    type: options.source?.type ?? "local",
    path: "/src",
    id: options.source?.id ?? "s1",
    ...options.source,
  } as SourceConfig;
  const controller = new AbortController();
  const store = await SyncStateStore.open({
    dir,
    sourceId: src.id,
    collection: cfg.collection,
  });
  options.storeTweak?.(store, controller);
  const client = new ExtractHttpClient({
    extractUrl: "https://extract.example.com",
    tokenProvider: new FakeTokenProvider(),
    version: "0.0.0-test",
    runtime: "docker",
    fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
  });
  const credentialStore = options.credentialStore ?? new MemoryCredentialStore();
  const needsAuth = options.needsAuth ?? new NeedsAuthTracker();
  const credential: SourceCredentialUnion = options.credential ?? STATIC_CREDENTIAL;
  const adapter = fakeAdapter(options.items);
  const makeAdapter =
    options.makeAdapter ??
    ((): SourceAdapter => adapter);
  const limits: UploadLimits = {
    resumableThresholdBytes: cfg.resumableThresholdBytes,
    maxUploadBytes: 52_428_800,
    ...options.limits,
  };

  return {
    dir,
    cfg,
    src,
    store,
    fake,
    adapter,
    credentialStore,
    needsAuth,
    controller,
    run: () =>
      runSourceOnce({
        src,
        cfg,
        store,
        client,
        credentialStore,
        env: options.env ?? {},
        rejectedIds: options.rejectedIds ?? new Set<string>(),
        makeAdapter: (s, cred) => makeAdapter(s, cred),
        ...(options.realResolve === true
          ? {}
          : { resolveCredential: async () => credential }),
        limits,
        logger: options.logger ?? testLogger(),
        needsAuth,
        ...(options.deleteConfirmation !== undefined
          ? { deleteConfirmation: options.deleteConfirmation }
          : {}),
        signal: options.signal ?? controller.signal,
        sleep: async () => undefined,
        rand: () => 0.5,
        now: () => "2026-01-01T00:00:00.000Z",
        nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    close: async () => {
      await store.close();
    },
  };
}
