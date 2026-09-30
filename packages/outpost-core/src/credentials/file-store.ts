// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * File-backed {@link CredentialStore} for the Docker runtime
 * (requirements 6.16, 12.5, 12.6, 15.4).
 *
 * Layout: `<dataDir>/credentials/<sha256(key)>` with mode `0600`; the file
 * name is a hash so the directory listing reveals nothing about which
 * credentials exist. Writes go through a temporary file in the same
 * directory, are `fsync`-ed, then `rename`-d, so a crash never leaves a
 * truncated credential behind.
 *
 * Additional read-only directories (Docker secret mounts) may be configured;
 * they are consulted after the data directory and their trailing newline is
 * stripped, matching the `_FILE` convention.
 *
 * A change listener (basis for the scheduler's `credential-changed` trigger,
 * 6.17) reports the *hash* of a changed file; consumers hash the key they
 * care about and compare. If `fs.watch` is unavailable the failure is logged
 * and the store keeps working without notifications.
 */

import { createHash, randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { CredentialStoreError, type CredentialStore } from "./store.js";
import type { SecretRedactor } from "../log/redact.js";

export interface FileCredentialStoreOptions {
  /** Data directory; credentials live under `<dataDir>/credentials`. */
  dataDir: string;
  /** Read-only extra directories, e.g. Docker secret mounts. */
  extraReadDirs?: readonly string[];
  /** Secrets loaded through this store get registered here (4.6). */
  redactor?: SecretRedactor;
  /** Logger used for non-fatal problems such as a missing `fs.watch`. */
  logger?: Logger;
}

/** Hash a credential key into its file name. */
export const credentialFileHash = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

export class FileCredentialStore implements CredentialStore {
  private readonly dir: string;
  private readonly extraDirs: readonly string[];
  private readonly redactor?: SecretRedactor;
  private readonly logger?: Logger;
  private watcher: FSWatcher | null = null;

  constructor(options: FileCredentialStoreOptions) {
    this.dir = join(options.dataDir, "credentials");
    this.extraDirs = options.extraReadDirs ?? [];
    this.redactor = options.redactor;
    this.logger = options.logger;
  }

  /** Absolute path of the data-directory file for `key`. */
  credentialPath(key: string): string {
    return join(this.dir, credentialFileHash(key));
  }

  async get(key: string): Promise<string | null> {
    const hash = credentialFileHash(key);
    try {
      const value = await readFile(join(this.dir, hash), "utf8");
      this.redactor?.register(value);
      return value;
    } catch (error) {
      if (!isNotFound(error)) {
        throw new CredentialStoreError(
          `credential store: read failed for key (code ${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
          { cause: error },
        );
      }
    }
    // Docker secret mounts: same file name, trailing newline stripped.
    for (const extra of this.extraDirs) {
      try {
        const raw = await readFile(join(extra, hash), "utf8");
        const value = raw.replace(/\r?\n$/, "");
        this.redactor?.register(value);
        return value;
      } catch (error) {
        if (!isNotFound(error)) {
          throw new CredentialStoreError(
            `credential store: read failed in secret mount (code ${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
            { cause: error },
          );
        }
      }
    }
    return null;
  }

  async set(key: string, value: string): Promise<void> {
    const target = this.credentialPath(key);
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      // Unique temporary name in the same directory so rename stays atomic.
      const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
    } catch (error) {
      throw new CredentialStoreError(
        `credential store: write failed (code ${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
        { cause: error },
      );
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.credentialPath(key), { force: true });
    } catch (error) {
      throw new CredentialStoreError(
        `credential store: delete failed (code ${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
        { cause: error },
      );
    }
  }

  /**
   * Start watching the credentials directory. The callback receives the
   * file-name hash of the changed entry; hash the key you care about and
   * compare. A failing `fs.watch` is logged and non-fatal.
   */
  watchChanges(onChange: (keyHash: string) => void): void {
    if (this.watcher !== null) return;
    try {
      this.watcher = watch(this.dir, { persistent: false }, (_event, filename) => {
        if (typeof filename !== "string" || filename.length === 0) return;
        // Ignore temporary files from in-flight atomic writes.
        if (filename.endsWith(".tmp")) return;
        onChange(filename);
      });
      this.watcher.on("error", (error: unknown) => {
        this.logger?.warn(
          { err: error },
          "credential store: fs.watch failed, change notifications disabled",
        );
        this.watcher = null;
      });
    } catch (error) {
      this.logger?.warn(
        { err: error },
        "credential store: fs.watch unavailable, change notifications disabled",
      );
      this.watcher = null;
    }
  }

  /** Stop watching (safe to call when no watcher is active). */
  unwatchChanges(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Existence check used by tests and the status endpoint. */
  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.credentialPath(key));
      return true;
    } catch {
      return false;
    }
  }
}

const isNotFound = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";
