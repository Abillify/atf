// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 36: credential pickup without a restart
 *
 * Over a sequence of runs with store changes in between (set token,
 * delete token, provider rotation) every run uses exactly the refresh-token
 * value that was in the CredentialStore at its start, or ends with
 * `needs-authorization` when there was none. After the first write of a
 * valid token, the next run synchronizes at the latest, without a process
 * restart; rotated tokens are picked up.
 *
 * **Validates: Requirements 6.16, 6.17**
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ExtractHttpClient } from "../../src/http/client.js";
import { MemoryCredentialStore } from "../../src/credentials/memory-store.js";
import { sourceOauthRefreshKey } from "../../src/credentials/keys.js";
import { outpostConfigSchema, type SourceConfig } from "../../src/config/schema.js";
import { SyncStateStore } from "../../src/state/store.js";
import { NeedsAuthTracker, runSourceOnce } from "../../src/sync/run.js";
import type { UploadLimits } from "../../src/sync/planner.js";
import { createGdriveSource } from "../../src/sources/gdrive.js";
import type { SourceFetch } from "../../src/sources/types.js";
import { FakeExtract } from "../fakes/fake-extract.js";
import { FakeGdrive } from "../fakes/fake-gdrive.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";
import { testLogger } from "../fakes/test-logger.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SOURCE_ID = "gd-pickup";

const SRC: SourceConfig = {
  type: "gdrive",
  folderId: "FOLDER",
  exportFormat: "pdf",
  auth: "oauth",
  id: SOURCE_ID,
};

const CFG = outpostConfigSchema.parse({
  extractUrl: "https://extract.example.com",
  collection: "main",
});
const LIMITS: UploadLimits = {
  resumableThresholdBytes: 32 * 1024 * 1024,
  maxUploadBytes: 52_428_800,
};

/** Store operation between two runs. */
type Op =
  | { t: "set"; value: string }
  | { t: "delete" }
  | { t: "rotate"; value: string };

const opsArb: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    fc.integer({ min: 1, max: 9 }).map((n) => ({ t: "set" as const, value: `tok-${n}` })),
    fc.constant({ t: "delete" as const }),
    fc.integer({ min: 1, max: 9 }).map((n) => ({ t: "rotate" as const, value: `rot-${n}` })),
  ),
  { minLength: 1, maxLength: 10 },
);

describe("Property 36: credential pickup without a restart", () => {
  it("every run reads the store fresh; a token appears in the next run at the latest", async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const dir = await mkdtemp(path.join(tmpdir(), "atf-prop36-"));
        try {
          const gdrive = new FakeGdrive({
            files: [
              {
                id: "f1",
                name: "f1.txt",
                parentId: "FOLDER",
                mimeType: "text/plain",
                body: new TextEncoder().encode("inhalt"),
              },
            ],
          });
          // Record every refresh token presented at the token endpoint so the
          // test can prove WHICH stored value the run actually used.
          const presented: string[] = [];
          const fetchImpl: SourceFetch = async (url, init) => {
            if (url === TOKEN_URL && typeof init?.body === "string") {
              const params = new URLSearchParams(init.body);
              if (params.get("grant_type") === "refresh_token") {
                presented.push(params.get("refresh_token") ?? "");
              }
            }
            return gdrive.fetchImpl(url, init);
          };

          const credentialStore = new MemoryCredentialStore();
          const tracker = new NeedsAuthTracker();
          const store = await SyncStateStore.open({
            dir,
            sourceId: SOURCE_ID,
            collection: "main",
          });
          const fake = new FakeExtract();
          const client = new ExtractHttpClient({
            extractUrl: "https://extract.example.com",
            tokenProvider: new FakeTokenProvider(),
            version: "0.0.0-test",
            runtime: "docker",
            fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
          });
          try {
            // Model: the token value expected to be in the store at run start,
            // plus a rotation the provider will hand out on the next refresh.
            let expected: string | undefined;
            let pendingRotate: string | undefined;
            let syncedOnce = false;
            for (const op of ops) {
              if (op.t === "set") {
                await credentialStore.set(sourceOauthRefreshKey(SOURCE_ID), op.value);
                expected = op.value;
              } else if (op.t === "delete") {
                await credentialStore.delete(sourceOauthRefreshKey(SOURCE_ID));
                expected = undefined;
              } else {
                // Provider rotates on the next successful refresh (6.17).
                pendingRotate = op.value;
                gdrive.rotateOnRefresh = op.value;
              }

              const before = presented.length;
              const report = await runSourceOnce({
                src: SRC,
                cfg: CFG,
                store,
                client,
                credentialStore,
                env: {},
                makeAdapter: (_s, credential) => {
                  if (credential.kind !== "refresh-token") {
                    throw new Error(`unexpected credential ${credential.kind}`);
                  }
                  return createGdriveSource(
                    { id: SOURCE_ID, folderId: "FOLDER", exportFormat: "pdf" },
                    { fetchImpl, credential, clientId: "client-id" },
                  );
                },
                limits: LIMITS,
                logger: testLogger(),
                needsAuth: tracker,
                signal: new AbortController().signal,
                sleep: async () => undefined,
                rand: () => 0.5,
                now: () => "2026-01-01T00:00:00.000Z",
                nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
              });

              if (expected === undefined) {
                // No token at run start: needs-authorization, provider untouched.
                expect(report.outcome).toBe("needs-authorization");
                expect(report.reason).toBe("missing");
                expect(presented.length).toBe(before);
                expect(tracker.isAnnounced(SOURCE_ID)).toBe(true);
              } else {
                // The run used EXACTLY the value stored at its start (6.17).
                expect(report.outcome).toBe("ok");
                expect(presented.length).toBe(before + 1);
                expect(presented[before]).toBe(expected);
                expect(tracker.isAnnounced(SOURCE_ID)).toBe(false);
                if (pendingRotate !== undefined) {
                  // The provider rotated: the new value is written back (6.17).
                  expected = pendingRotate;
                  pendingRotate = undefined;
                }
                syncedOnce = true;
              }
              // The store reflects what the next run must read.
              expect(await credentialStore.get(sourceOauthRefreshKey(SOURCE_ID))).toBe(
                expected ?? null,
              );
            }
            // After the first valid token, some run synced — same process.
            if (expected !== undefined || ops.some((o) => o.t === "set")) {
              expect(syncedOnce).toBe(true);
            }
          } finally {
            await store.close();
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
