// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 12: Vollständigkeit des Listings
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.6, 6.8**
 *
 * Für generierte Bäume (lokal, inkl. Symlinks und verschachtelter
 * Verzeichnisse) bzw. generierte Objekt-/Datei-/Eintrag-Mengen mit
 * beliebiger Seitengröße (S3, Drive, Dropbox über die Fakes) liefert der
 * Adapter genau die regulären Dateien/Objekte — jede genau einmal.
 * Symlinks (6.2) und Ordner-Marker erscheinen nicht; die `quellId` ist der
 * relative POSIX-Pfad (lokal), der S3-Key bzw. die Provider-ID
 * (Drive/Dropbox). Pagination (beliebige Seitengröße 1–3) ändert die
 * Ergebnismenge nicht.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectListing,
  createDropboxSource,
  createGdriveSource,
  createLocalSource,
  createS3Source,
  MemoryCredentialStore,
} from "../../src/index.js";
import { FakeDropbox } from "../fakes/fake-dropbox.js";
import { FakeGdrive } from "../fakes/fake-gdrive.js";
import { FakeS3 } from "../fakes/fake-s3.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const noSignal = new AbortController().signal;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "outpost-listing-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Relative POSIX-Pfade mit eindeutigen Segmenten erzeugen. */
const segmentArb = /^[a-z][a-z0-9]{0,5}(\.[a-z]{1,3})?$/;
const relPathArb = fc
  .array(fc.stringMatching(segmentArb), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));

/**
 * Mengen eindeutiger Pfade, in denen kein Pfad ein anderes Pfadpräfix ist —
 * sonst kollidiert eine Datei mit einem Ordner (z. B. „u“ und „u/a“).
 */
const filePathSetArb = fc
  .uniqueArray(relPathArb, { minLength: 0, maxLength: 12 })
  .filter(
    (paths) =>
      paths.every(
        (a) => paths.every((b) => a === b || !b.startsWith(`${a}/`)),
      ),
  );

describe("Property 12: lokales Listing (createLocalSource)", () => {
  it("liefert genau die regulären Dateien, keine Symlinks, quellId = relativer POSIX-Pfad", async () => {
    await fc.assert(
      fc.asyncProperty(filePathSetArb, async (relPaths) => {
          const dir = await mkdtemp(path.join(tmpDir, "local-"));
          try {
            const expected = new Set<string>();
            for (const rel of relPaths) {
              const full = path.join(dir, ...rel.split("/"));
              await mkdir(path.dirname(full), { recursive: true });
              await writeFile(full, enc(`body:${rel}`));
              expected.add(rel);
            }
            // Symlinks (auf Datei und ins Leere) dürfen nicht erscheinen (6.2).
            const [firstPath] = relPaths;
            if (firstPath !== undefined) {
              await symlink(path.join(dir, ...firstPath.split("/")), path.join(dir, "link-a.txt"));
            }
            await symlink(path.join(dir, "fehlt"), path.join(dir, "link-broken"));

            const result = await collectListing(createLocalSource({ root: dir }), noSignal);
            expect(result.kind).toBe("complete");
            if (result.kind !== "complete") return;
            const ids = result.items.map((i) => i.quellId);
            expect(new Set(ids)).toEqual(expected);
            expect(ids.length).toBe(new Set(ids).size);
            for (const item of result.items) {
              expect(item.quellId).not.toContain("\\");
              // Marker: `${mtimeMs}:${size}` — mtimeMs kann Nachkomma-Stellen
              // haben (APFS); das Date entsteht daraus durch Rundung.
              const [ms, size] = item.marker.split(":");
              expect(size).toBe(String(item.size));
              expect(Math.round(Number(ms))).toBe(item.modified.getTime());
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 12: S3-Listing (FakeS3, beliebige Seitengröße)", () => {
  it("liefert genau die Objekte einmal; Ordner-Marker fehlen; quellId = Key", async () => {
    await fc.assert(
      fc.asyncProperty(
        filePathSetArb,
        fc.integer({ min: 1, max: 3 }),
        async (keys, pageSize) => {
          const s3 = new FakeS3({ bucket: "b", pageSize });
          const expected = new Set<string>();
          for (const key of keys) {
            s3.addObject(key, enc(`body:${key}`));
            expected.add(key);
            // Ordner-Marker zum Key: darf nicht im Listing erscheinen.
            s3.addObject(`${key}/`, new Uint8Array());
          }
          const store = new MemoryCredentialStore();
          await store.set("source:s3x:s3-access-key", "AKIA");
          await store.set("source:s3x:s3-secret-key", "secret");
          const adapter = createS3Source(
            { id: "s3x", bucket: "b", credentials: "store" },
            { fetchImpl: s3.fetchImpl, store, env: {} },
          );
          const result = await collectListing(adapter, noSignal);
          expect(result.kind).toBe("complete");
          if (result.kind !== "complete") return;
          const ids = result.items.map((i) => i.quellId);
          expect(new Set(ids)).toEqual(expected);
          expect(ids.length).toBe(new Set(ids).size);
          for (const item of result.items) {
            expect(item.quellId).not.toMatch(/\/$/);
            expect(item.marker).not.toBe("");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 12: GDrive-Listing (FakeGdrive, beliebige Seitengröße)", () => {
  it("liefert genau die Nicht-Ordner-Dateien einmal; quellId = Provider-ID", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{6,12}$/), { minLength: 0, maxLength: 10 }),
        fc.integer({ min: 1, max: 3 }),
        async (names, pageSize) => {
          const gdrive = new FakeGdrive({ pageSize });
          gdrive.addFile({
            id: "root",
            name: "Root",
            parentId: null,
            mimeType: "application/vnd.google-apps.folder",
          });
          const expected = new Set<string>();
          let i = 0;
          for (const name of names) {
            const id = `f${i}`;
            i += 1;
            gdrive.addFile({
              id,
              name,
              parentId: "root",
              mimeType: "text/plain",
              body: enc(`body:${name}`),
              md5Checksum: `md5-${id}`,
            });
            expected.add(id);
          }
          // Unterordner mit Datei — Ordner selbst darf nicht erscheinen.
          gdrive.addFile({
            id: "sub",
            name: "Unterordner",
            parentId: "root",
            mimeType: "application/vnd.google-apps.folder",
          });
          gdrive.addFile({
            id: "subf",
            name: "in-sub.txt",
            parentId: "sub",
            mimeType: "text/plain",
            revisionId: "r1",
          });
          expected.add("subf");

          const adapter = createGdriveSource(
            { id: "g", folderId: "root", exportFormat: "pdf" },
            {
              fetchImpl: gdrive.fetchImpl,
              credential: { kind: "refresh-token", token: "rt" },
              clientId: "cid",
            },
          );
          const result = await collectListing(adapter, noSignal);
          expect(result.kind).toBe("complete");
          if (result.kind !== "complete") return;
          const ids = result.items.map((item) => item.quellId);
          expect(new Set(ids)).toEqual(expected);
          expect(ids.length).toBe(new Set(ids).size);
          expect(ids).not.toContain("sub");
          expect(ids).not.toContain("root");
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 12: Dropbox-Listing (FakeDropbox, beliebige Seitengröße)", () => {
  it("liefert genau die file-Einträge einmal; Ordner fehlen; quellId = Provider-ID", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{2,8}\.txt$/), {
          minLength: 0,
          maxLength: 10,
        }),
        fc.integer({ min: 1, max: 3 }),
        async (names, pageSize) => {
          const dropbox = new FakeDropbox({ pageSize });
          const expected = new Set<string>();
          let i = 0;
          for (const name of names) {
            const id = `idb:${i}:${name}`;
            i += 1;
            dropbox.addEntry({
              id,
              name,
              pathDisplay: `/${name}`,
              type: "file",
              body: enc(`body:${name}`),
              contentHash: `hash-${i}`,
            });
            expected.add(id);
          }
          // Ordner-Eintrag: darf nicht erscheinen.
          dropbox.addEntry({
            id: "folderid",
            name: "Unterordner",
            pathDisplay: "/Unterordner",
            type: "folder",
          });

          const adapter = createDropboxSource(
            { id: "d", path: "" },
            {
              fetchImpl: dropbox.fetchImpl,
              credential: { kind: "refresh-token", token: "rt" },
              clientId: "cid",
            },
          );
          const result = await collectListing(adapter, noSignal);
          expect(result.kind).toBe("complete");
          if (result.kind !== "complete") return;
          const ids = result.items.map((item) => item.quellId);
          expect(new Set(ids)).toEqual(expected);
          expect(ids.length).toBe(new Set(ids).size);
          expect(ids).not.toContain("folderid");
        },
      ),
      { numRuns: 100 },
    );
  });
});
