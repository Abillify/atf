// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 35: isolation of unauthorized sources
 *
 * Every source without a valid credential ends with `needs-authorization`,
 * calls no provider endpoint, produces no uploads and no deletions, its
 * Sync_State stays unchanged, and the log contains the hint
 * `atf-outpost source-login <sourceId>`. A GDrive source with
 * `auth: service-account` and an existing key is never affected. For all
 * other sources, calls to the fake Extract, counters and Sync_State are
 * identical to a run in which the affected sources are not configured.
 * Health/status report exactly the affected sources as
 * `needs-authorization` via the NeedsAuthTracker.
 *
 * **Validates: Requirements 6.10, 6.12, 6.18**
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ExtractHttpClient } from "../../src/http/client.js";
import { MemoryCredentialStore } from "../../src/credentials/memory-store.js";
import { sourceGdriveSaKey, sourceOauthRefreshKey } from "../../src/credentials/keys.js";
import { outpostConfigSchema, type OutpostConfig, type SourceConfig } from "../../src/config/schema.js";
import { SyncStateStore } from "../../src/state/store.js";
import { newCounters } from "../../src/sync/counters.js";
import {
  NeedsAuthTracker,
  runSourceOnce,
  type RunReport,
  type SourceCredentialUnion,
} from "../../src/sync/run.js";
import type { UploadLimits } from "../../src/sync/planner.js";
import type { SourceAdapter } from "../../src/sources/types.js";
import { createGdriveSource } from "../../src/sources/gdrive.js";
import { createDropboxSource } from "../../src/sources/dropbox.js";
import { fakeAdapter } from "../fakes/fake-adapter.js";
import { FakeExtract } from "../fakes/fake-extract.js";
import { FakeGdrive } from "../fakes/fake-gdrive.js";
import { FakeDropbox } from "../fakes/fake-dropbox.js";
import { FakeTokenProvider } from "../fakes/fake-token-provider.js";
import { parseLines, recordingLogger } from "../fakes/test-logger.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const CFG: OutpostConfig = outpostConfigSchema.parse({
  extractUrl: "https://extract.example.com",
  collection: "main",
});
const LIMITS: UploadLimits = {
  resumableThresholdBytes: 32 * 1024 * 1024,
  maxUploadBytes: 52_428_800,
};

/** Real RSA key so the service-account assertion can be signed. */
const SA_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const SA_KEY_JSON = JSON.stringify({
  type: "service_account",
  client_email: "outpost@example.iam.gserviceaccount.com",
  private_key: SA_PEM,
  // Deliberately wrong: the fixed endpoint must be used regardless (15.1).
  token_uri: "https://evil.example.com/token",
});

type Kind = "local" | "gdrive" | "gdrive-sa" | "dropbox";
const ALL_SOURCES: Readonly<Record<string, Kind>> = {
  "local-a": "local",
  "gd-oauth": "gdrive",
  "gd-sa": "gdrive-sa",
  "db-x": "dropbox",
};
const ALL_IDS = Object.keys(ALL_SOURCES);
const GHOST = "ghost-item";

const makeSourceConfig = (id: string, kind: Kind): SourceConfig => {
  switch (kind) {
    case "local":
      return { type: "local", path: "/src", watch: false, id };
    case "gdrive":
      return { type: "gdrive", folderId: "FOLDER", exportFormat: "pdf", auth: "oauth", id };
    case "gdrive-sa":
      return {
        type: "gdrive",
        folderId: "FOLDER",
        exportFormat: "pdf",
        auth: "service-account",
        id,
      };
    case "dropbox":
      return { type: "dropbox", path: "/sync", id };
  }
};

interface SourceRunResult {
  report: RunReport;
  requests: string[];
  stateJson: string;
  gdrive: FakeGdrive | undefined;
  dropbox: FakeDropbox | undefined;
  events: Array<Record<string, unknown>>;
}

function makeAdapterFor(
  src: SourceConfig,
  credential: Exclude<SourceCredentialUnion, { kind: "needs-authorization" }>,
  gdrive: FakeGdrive | undefined,
  dropbox: FakeDropbox | undefined,
): SourceAdapter {
  if (src.type === "gdrive" && gdrive !== undefined) {
    if (credential.kind === "refresh-token" || credential.kind === "service-account") {
      return createGdriveSource(
        { id: src.id, folderId: "FOLDER", exportFormat: "pdf" },
        { fetchImpl: gdrive.fetchImpl, credential, clientId: "client-id" },
      );
    }
  }
  if (src.type === "dropbox" && dropbox !== undefined && credential.kind === "refresh-token") {
    return createDropboxSource(
      { id: src.id, path: "/sync" },
      { fetchImpl: dropbox.fetchImpl, credential, clientId: "app-key" },
    );
  }
  if (src.type === "local") {
    return fakeAdapter([
      { quellId: "a.txt", content: enc(`${src.id}-a`) },
      { quellId: "b.txt", content: enc(`${src.id}-b`) },
    ]);
  }
  throw new Error(`no adapter for ${src.type}/${credential.kind}`);
}

/** Run every listed source once against fresh fakes and a fresh state dir. */
async function runScenario(
  ids: readonly string[],
  credentialStore: MemoryCredentialStore,
  tracker: NeedsAuthTracker,
): Promise<Map<string, SourceRunResult>> {
  const out = new Map<string, SourceRunResult>();
  for (const id of ids) {
    const kind = ALL_SOURCES[id];
    if (kind === undefined) throw new Error(`unknown source ${id}`);
    const dir = await mkdtemp(path.join(tmpdir(), "atf-prop35-"));
    try {
      const gdrive =
        kind === "gdrive" || kind === "gdrive-sa"
          ? new FakeGdrive({
              files: [
                {
                  id: `${id}-g1`,
                  name: "g1.txt",
                  parentId: "FOLDER",
                  mimeType: "text/plain",
                  body: enc(`${id}-g1`),
                },
              ],
            })
          : undefined;
      const dropbox =
        kind === "dropbox"
          ? new FakeDropbox({
              entries: [
                {
                  id: `${id}-d1`,
                  name: "d1.txt",
                  pathDisplay: "/sync/d1.txt",
                  type: "file",
                  body: enc(`${id}-d1`),
                },
              ],
            })
          : undefined;
      const store = await SyncStateStore.open({ dir, sourceId: id, collection: "main" });
      // Pre-existing state entry: a needs-authorization run must not touch it.
      await store.upsert(GHOST, {
        reference: `outpost:${id}:ghost`,
        marker: "ghost-marker",
        size: 5,
        status: "synced",
      });
      const fake = new FakeExtract();
      const client = new ExtractHttpClient({
        extractUrl: "https://extract.example.com",
        tokenProvider: new FakeTokenProvider(),
        version: "0.0.0-test",
        runtime: "docker",
        fetchImpl: fake.fetchImpl as unknown as typeof globalThis.fetch,
      });
      const rec = recordingLogger();
      const src = makeSourceConfig(id, kind);
      const report = await runSourceOnce({
        src,
        cfg: CFG,
        store,
        client,
        credentialStore,
        env: {},
        makeAdapter: (s, credential) => makeAdapterFor(s, credential, gdrive, dropbox),
        limits: LIMITS,
        logger: rec.logger,
        needsAuth: tracker,
        signal: new AbortController().signal,
        sleep: async () => undefined,
        rand: () => 0.5,
        now: () => "2026-01-01T00:00:00.000Z",
        nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
      });
      const stateJson = JSON.stringify(store.state);
      await store.close();
      out.set(id, {
        report,
        requests: fake.requests.map((r) => `${r.method} ${r.url}`),
        stateJson,
        gdrive,
        dropbox,
        events: parseLines(rec.lines),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return out;
}

function seedCredentials(
  store: MemoryCredentialStore,
  flags: { gdrive: boolean; dropbox: boolean },
): void {
  if (flags.gdrive) void store.set(sourceOauthRefreshKey("gd-oauth"), "refresh-gd");
  if (flags.dropbox) void store.set(sourceOauthRefreshKey("db-x"), "refresh-db");
  // The service-account key is always present (6.10: never needs authorization).
  void store.set(sourceGdriveSaKey("gd-sa"), SA_KEY_JSON);
}

const flagsArb = fc.record({ gdrive: fc.boolean(), dropbox: fc.boolean() });

describe("Property 35: isolation of unauthorized sources", () => {
  it("fehlende Credentials isolieren genau die betroffene Source", async () => {
    await fc.assert(
      fc.asyncProperty(flagsArb, async (flags) => {
        const missing: string[] = [];
        if (!flags.gdrive) missing.push("gd-oauth");
        if (!flags.dropbox) missing.push("db-x");

        // Scenario A: all four sources configured, shared tracker/store.
        const trackerA = new NeedsAuthTracker();
        const credA = new MemoryCredentialStore();
        seedCredentials(credA, flags);
        const resA = await runScenario(ALL_IDS, credA, trackerA);

        // Scenario B: the missing-credential sources are not configured at all.
        const nonMissing = ALL_IDS.filter((id) => !missing.includes(id));
        const trackerB = new NeedsAuthTracker();
        const credB = new MemoryCredentialStore();
        seedCredentials(credB, flags);
        const resB = await runScenario(nonMissing, credB, trackerB);

        // ── every source without a credential is fully isolated (6.18) ──────
        for (const id of missing) {
          const r = resA.get(id);
          if (r === undefined) throw new Error(`missing result for ${id}`);
          expect(r.report.outcome).toBe("needs-authorization");
          expect(r.report.reason).toBe("missing");
          expect(r.report.counters).toEqual(newCounters());
          expect(r.report.deletePhase).toBe("none");
          // No Extract traffic at all: no uploads, no deletions.
          expect(r.requests).toEqual([]);
          // The provider is never contacted — not even the token endpoint.
          expect(r.gdrive?.listCalls ?? 0).toBe(0);
          expect(r.gdrive?.tokenCalls ?? 0).toBe(0);
          expect(r.dropbox?.listCalls ?? 0).toBe(0);
          expect(r.dropbox?.tokenCalls ?? 0).toBe(0);
          // Sync_State unchanged: the ghost entry is intact, no delete marking.
          const state = JSON.parse(r.stateJson) as {
            items: Record<string, { marker?: string; status?: string }>;
            candidateSetHash?: string;
          };
          expect(Object.keys(state.items)).toEqual([GHOST]);
          expect(state.items[GHOST]?.marker).toBe("ghost-marker");
          expect(state.candidateSetHash).toBeUndefined();
          // Log hint exactly once (6.18).
          const hints = r.events.filter(
            (e) =>
              e["event"] === "source.needs_authorization" &&
              e["sourceId"] === id &&
              e["hint"] === `atf-outpost source-login ${id}`,
          );
          expect(hints).toHaveLength(1);
        }

        // ── service-account GDrive is never in the affected set (6.10) ──────
        expect(missing).not.toContain("gd-sa");
        expect(resA.get("gd-sa")?.report.outcome).toBe("ok");

        // ── health/status view: exactly the affected sources announced ──────
        for (const id of ALL_IDS) {
          expect(trackerA.isAnnounced(id)).toBe(missing.includes(id));
        }

        // ── unaffected sources behave exactly as without the others ─────────
        for (const id of nonMissing) {
          const a = resA.get(id);
          const b = resB.get(id);
          if (a === undefined || b === undefined) throw new Error(`missing result ${id}`);
          expect(a.report.outcome).toBe("ok");
          expect(a.requests).toEqual(b.requests);
          expect(a.report.counters).toEqual(b.report.counters);
          // Compare structurally: the item order in the state depends on the
          // (deliberately variable) concurrency, not the content.
          expect(JSON.parse(a.stateJson)).toEqual(JSON.parse(b.stateJson));
        }
      }),
      // Per evaluation 8 state stores with fsync (2 scenarios × 4 sources);
      // on slow volumes 100 runs do not fit the time budget.
      { numRuns: 25 },
    );
  });
});
