// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 12: completeness of the listing
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.6, 6.8**
 *
 * For generated trees (local, including symlinks and nested directories) or
 * generated object/file/entry sets with arbitrary page sizes (S3, Drive,
 * Dropbox through the fakes), the adapter returns exactly the regular
 * files/objects, each exactly once.
 * Symlinks (6.2) and folder markers do not appear; the `quellId` is the
 * relative POSIX path (local), the S3 key or the provider ID
 * (Drive/Dropbox). Pagination (arbitrary page size 1–3) does not change the
 * result set.
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
 * Sets of unique paths in which no path is a prefix of another path;
 * otherwise a file collides with a folder (e.g. "u" and "u/a").
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
  it("returns exactly the regular files, no symlinks, quellId = relative POSIX path", async () => {
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
            // Symlinks (to a file and dangling) must not appear (6.2).
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
              // Marker: `${mtimeMs}:${size}`; mtimeMs can have fractional
              // digits (APFS); the Date is derived from it by rounding.
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

describe("Property 12: S3 listing (FakeS3, arbitrary page size)", () => {
  it("returns exactly the objects once; folder markers missing; quellId = key", async () => {
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
            // Folder marker for the key: must not appear in the listing.
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

describe("Property 12: GDrive listing (FakeGdrive, arbitrary page size)", () => {
  it("returns exactly the non-folder files once; quellId = provider ID", async () => {
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
          // Subfolder with a file; the folder itself must not appear.
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

describe("Property 12: Dropbox listing (FakeDropbox, arbitrary page size)", () => {
  it("returns exactly the file entries once; folders missing; quellId = provider ID", async () => {
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
          // Folder entry: must not appear.
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
