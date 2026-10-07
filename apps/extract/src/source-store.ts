// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * source-store.ts
 *
 * The durable, content-addressed store for source documents (design §9a.1,
 * requirement 4.13).
 *
 * A finished upload — whether it streamed in as resumable chunks or was pulled
 * from a `source_url` — is committed here under a path derived from its
 * whole-file sha256. Two properties fall out of that and are the whole point:
 *
 *   - **Idempotent storage.** Identical bytes always land on the same path, so a
 *     retried or duplicated upload dedupes for free and `put` is a no-op when the
 *     content is already present. A job can be created for a source that some
 *     earlier job already stored without copying it twice.
 *   - **Deterministic re-rendering.** The one durable copy is the source of
 *     truth every later stage renders from on demand (`POST /v2/render`, zoom,
 *     tiles). Nothing derived is stored eagerly; it is all reproducible from
 *     here, which is what lets a 10 000-page job keep its footprint flat.
 *
 * The commit is atomic: the caller streams into a scratch file (in a *different*
 * directory, so a partial write never appears at a content-addressed path),
 * verifies the sha256 there, and only then does an `rename` into the store. A
 * rename within a filesystem is atomic, so a crash mid-commit leaves either the
 * old state or the new one, never a truncated source at a valid-looking path.
 *
 * The layout shards by the first two hex characters of the digest
 * (`ab/abcdef…`), because a flat directory of hundreds of thousands of entries
 * is slow to list and hostile to some filesystems.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A lowercase 64-character hex sha256. */
export type Sha256Hex = string;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface StoredSource {
  /** The whole-file sha256 the source is addressed by. */
  sha256: Sha256Hex;
  /** Absolute path to the durable file inside the store. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** True when the bytes were already present, so nothing was written. */
  deduped: boolean;
}

/**
 * The content-addressed source store.
 *
 * An interface rather than a bare class so a later object-store backing (S3,
 * MinIO) can be dropped in without touching the upload handler, mirroring how
 * `AssetStore` (task 1.11) is shaped.
 */
export interface SourceStore {
  /** True when a source with this digest is already stored. */
  has(sha256: Sha256Hex): Promise<boolean>;
  /** Resolve the absolute path a stored source lives at, or null when absent. */
  locate(sha256: Sha256Hex): Promise<string | null>;
  /**
   * Commit a scratch file that has already been fully written and whose digest
   * the caller computed while writing it. The file is verified and moved into
   * the store; on a digest mismatch it is thrown away and an error is raised so
   * a corrupted upload can never be committed. The scratch file is consumed
   * (moved or removed) either way.
   */
  commitFile(scratchPath: string, expected: Sha256Hex): Promise<StoredSource>;
  /**
   * Stream arbitrary bytes into the store, hashing as they are written. Used by
   * the `source_url` pull, which does not have a pre-hashed scratch file. When
   * `expected` is given a mismatch is rejected; otherwise the computed digest is
   * trusted as the address.
   */
  putStream(
    source: Readable,
    options?: { expected?: Sha256Hex; maxBytes?: number },
  ): Promise<StoredSource>;
  /**
   * Remove a stored source (DSAR erasure, requirement 2.7). Returns true when
   * a file was deleted, false when nothing was stored under the digest. The
   * caller is responsible for only calling this once no job row references
   * the digest any more — the store itself is content-addressed and has no
   * idea of ownership.
   */
  remove?(sha256: Sha256Hex): Promise<boolean>;
}

/** Absolute path a digest maps to inside `root`, sharded by its first byte. */
function pathForDigest(root: string, sha256: Sha256Hex): string {
	return join(root, sha256.slice(0, 2), sha256);
}

/** Reject anything that is not a canonical lowercase hex sha256. */
export function assertSha256Hex(value: string): Sha256Hex {
	const lower = value.trim().toLowerCase();
  if (!SHA256_HEX.test(lower)) {
    throw new Error(`Not a sha256 hex digest: "${value}"`);
  }
  return lower;
}

/** Hash a file already on disk, streaming so it never sits in memory whole. */
export async function hashFile(
  path: string,
): Promise<{ sha256: Sha256Hex; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest("hex"), size };
}

/**
 * Create a filesystem-backed source store rooted at `dir`.
 *
 * The scratch directory the upload handler streams into is a separate concern
 * (`UPLOAD_TMP_DIR`), passed to `commitFile` as an already-written path — the
 * store only owns the durable half.
 */
export function createFilesystemSourceStore(dir: string): SourceStore {
	async function ensureParent(target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
  }

	async function fileSize(path: string): Promise<number | null> {
    try {
      const info = await stat(path);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

	const store: SourceStore = {
    async has(sha256) {
      return (
        (await fileSize(pathForDigest(dir, assertSha256Hex(sha256)))) !== null
      );
    },

    async locate(sha256) {
      const target = pathForDigest(dir, assertSha256Hex(sha256));
      return (await fileSize(target)) !== null ? target : null;
    },

    async commitFile(scratchPath, expected) {
      const digest = assertSha256Hex(expected);
      const actual = await hashFile(scratchPath);
      if (actual.sha256 !== digest) {
        // Never leave a file whose name claims a digest its bytes do not have.
        await rm(scratchPath, { force: true });
        throw new SourceChecksumError(digest, actual.sha256);
      }

      const target = pathForDigest(dir, digest);
      const existing = await fileSize(target);
      if (existing !== null) {
        // Already stored — the scratch copy is redundant.
        await rm(scratchPath, { force: true });
        return { sha256: digest, path: target, size: existing, deduped: true };
      }

      await ensureParent(target);
      try {
        await rename(scratchPath, target);
      } catch (err) {
        // A cross-device rename (scratch and store on different mounts) fails
        // with EXDEV; fall back to a streamed copy, then drop the scratch file.
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          await pipeline(
            createReadStream(scratchPath),
            createWriteStream(target),
          );
          await rm(scratchPath, { force: true });
        } else {
          throw err;
        }
      }
      return {
        sha256: digest,
        path: target,
        size: actual.size,
        deduped: false,
      };
    },

    async putStream(source, options = {}) {
      await mkdir(dir, { recursive: true });
      const scratch = join(
        dir,
        `.incoming-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const hash = createHash("sha256");
      let size = 0;
      const max = options.maxBytes;

      const out = createWriteStream(scratch);
      try {
        for await (const chunk of source) {
          const buf = chunk as Buffer;
          size += buf.length;
          if (max !== undefined && size > max) {
            throw new SourceTooLargeError(max);
          }
          hash.update(buf);
          if (!out.write(buf)) {
            await new Promise<void>((resolve, reject) => {
              out.once("drain", resolve);
              out.once("error", reject);
            });
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        out.destroy();
        await rm(scratch, { force: true });
        throw err;
      }

      const digest = hash.digest("hex");
      if (
        options.expected !== undefined &&
        assertSha256Hex(options.expected) !== digest
      ) {
        await rm(scratch, { force: true });
        throw new SourceChecksumError(
          assertSha256Hex(options.expected),
          digest,
        );
      }

      return store.commitFile(scratch, digest);
    },

    async remove(sha256) {
      const target = await store.locate(sha256);
      if (target === null) return false;
      await rm(target, { force: true });
      return true;
    },
  };

	return store;
}

/** Raised when computed bytes do not match the declared sha256. */
export class SourceChecksumError extends Error {
  readonly expected: Sha256Hex;
  readonly actual: Sha256Hex;
  constructor(expected: Sha256Hex, actual: Sha256Hex) {
    super(`Checksum mismatch: expected ${expected}, got ${actual}`);
    this.name = "SourceChecksumError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Raised when a stream exceeds the byte ceiling before it finishes. */
export class SourceTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Source exceeds the ${maxBytes} byte limit`);
    this.name = "SourceTooLargeError";
    this.maxBytes = maxBytes;
  }
}
