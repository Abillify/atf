// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared arbitraries for the sync planner / reducer / delete-planner /
 * header property tests (tasks 16.5–16.9).
 */

import fc from "fast-check";
import type { ItemState, SourceState } from "../../src/index.js";
import type { SourceItem } from "../../src/sources/types.js";
import type { OutpostConfig, SourceConfig } from "../../src/config/schema.js";
import { collectionArb, sourceIdArb } from "./config-arb.js";

/** quellIds: relative POSIX-Pfade, S3-Keys, Drive-/Dropbox-IDs — generisch. */
export const quellIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9 ._\-\u00e4\u00f6\u00fc\u00df]{0,30}(\/[a-zA-Z0-9 ._\-\u00e4\u00f6\u00fc\u00df]{1,20}){0,3}$/);

/** Namen mit Unicode inkl. Umlauten, Kommata und Leerzeichen. */
export const itemNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim() !== "");

export const itemArb: fc.Arbitrary<SourceItem> = fc.record({
  quellId: quellIdArb,
  name: itemNameArb,
  size: fc.nat({ max: 200_000_000 }),
  // fc.date kann ein Invalid Date erzeugen — daher Zeitstempel als integer.
  modified: fc
    .integer({ min: 946_684_800_000, max: 2_051_222_400_000 })
    .map((ms) => new Date(Math.floor(ms / 1000) * 1000)),
  marker: fc.string({ minLength: 1, maxLength: 40 }),
  link: fc.option(fc.webUrl(), { nil: undefined }),
  mimeType: fc.option(fc.constantFrom("application/pdf", "text/plain", "image/png"), {
    nil: undefined,
  }),
});

/** Tags/ACL-Werte ohne Komma — Extrakt nutzt `readListHeader` (Komma = Trenner). */
const listValueArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9 .\-\u00e4\u00f6\u00fc\u00df]{1,20}$/)
  .filter((s) => s.trim() !== "");

export const tagsArb: fc.Arbitrary<string[]> = fc.array(listValueArb, { maxLength: 4 });

export const metadataArb: fc.Arbitrary<Record<string, string>> = fc
  .dictionary(
    fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
    fc.string({ minLength: 0, maxLength: 30 }),
    { maxKeys: 4 },
  );

export const sourceConfigArb: fc.Arbitrary<SourceConfig> = fc
  .record({
    type: fc.constantFrom("local" as const, "s3" as const, "gdrive" as const, "dropbox" as const),
    id: sourceIdArb,
    collection: fc.option(collectionArb, { nil: undefined }),
    tags: fc.option(tagsArb, { nil: undefined }),
    metadata: fc.option(metadataArb, { nil: undefined }),
    allowedUsers: fc.option(fc.array(listValueArb, { maxLength: 3 }), { nil: undefined }),
    allowedGroups: fc.option(fc.array(listValueArb, { maxLength: 3 }), { nil: undefined }),
  })
  .chain((common) => {
    const rest =
      common.type === "local"
        ? { path: "/srv/data", watch: false }
        : common.type === "s3"
          ? { bucket: "bucket", credentials: "store" as const }
          : common.type === "gdrive"
            ? { folderId: "folder-1", exportFormat: "pdf" as const, auth: "oauth" as const }
            : { path: "/dropbox" };
    return fc.constant({ ...common, ...rest } as SourceConfig);
  });

export const outpostConfigArb: fc.Arbitrary<OutpostConfig> = fc
  .record({
    extractUrl: fc.constant("https://extract.example.com"),
    collection: collectionArb,
  })
  .map((c) => ({
    extractUrl: c.extractUrl,
    allowInsecureLocalhost: false,
    syncIntervalSec: 900,
    mirrorDelete: true,
    deleteThresholdPercent: 50,
    resumableThresholdBytes: 33_554_432,
    maxConcurrentUploads: 4,
    health: { bind: "127.0.0.1", port: 8787 },
    cloudOAuth: {},
    sources: [],
    collection: c.collection,
  }));

export const sha256Arb: fc.Arbitrary<string> = fc.stringMatching(/^[0-9a-f]{64}$/);

export const itemStateArb: fc.Arbitrary<ItemState> = fc.oneof(
  fc.record({
    reference: fc.stringMatching(/^outpost:[A-Za-z0-9._-]{1,10}:[A-Za-z0-9_-]{32}$/),
    marker: fc.string({ minLength: 1, maxLength: 40 }),
    sha256: sha256Arb,
    size: fc.nat({ max: 200_000_000 }),
    status: fc.constant("synced" as const),
    syncedAt: fc.constant("2025-01-01T00:00:00.000Z"),
  }),
  fc.record({
    reference: fc.stringMatching(/^outpost:[A-Za-z0-9._-]{1,10}:[A-Za-z0-9_-]{32}$/),
    marker: fc.string({ minLength: 1, maxLength: 40 }),
    sha256: fc.option(sha256Arb, { nil: undefined }),
    size: fc.nat({ max: 200_000_000 }),
    status: fc.constantFrom("failed" as const, "pending-job" as const, "deleted-in-source" as const),
  }),
);

/** SourceState mit 0–10 Items; quellIds und References konsistent. */
export const sourceStateArb: fc.Arbitrary<SourceState> = fc
  .uniqueArray(quellIdArb, { maxLength: 10 })
  .chain((quellIds) =>
    fc
      .array(itemStateArb, { minLength: quellIds.length, maxLength: quellIds.length })
      .map((items) => {
        const map: Record<string, ItemState> = {};
        quellIds.forEach((quellId, i) => {
          const item = items[i] as ItemState;
          map[quellId] = { ...item, reference: `outpost:s1:${(i).toString(16).padStart(32, "0")}` };
        });
        return { version: 1 as const, sourceId: "s1", collection: "col", items: map };
      }),
  );
