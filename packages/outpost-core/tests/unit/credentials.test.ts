// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit cases for the Credential_Store (task 8.5): file mode `0600`
 * (requirements 6.16, 12.6), atomic writes, error reporting without a
 * plaintext fallback (15.4), Docker secret mounts, and the `fs.watch`
 * change callback (6.17).
 */

import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialStoreError,
  credentialFileHash,
  EXTRACT_AUTH_KEYS,
  FileCredentialStore,
  isExtractAuthKey,
  MemoryCredentialStore,
  sourceGdriveSaKey,
  sourceOauthRefreshKey,
  sourceS3AccessKeyKey,
  sourceS3SecretKeyKey,
} from "../../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "outpost-creds-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("FileCredentialStore", () => {
  it("stores a credential with mode 0600 under the hashed file name", async () => {
    const data = await tempDir();
    const store = new FileCredentialStore({ dataDir: data });
    await store.set("auth:extract:refresh-token", "tok-123");

    const path = store.credentialPath("auth:extract:refresh-token");
    expect(path).toContain(credentialFileHash("auth:extract:refresh-token"));
    // The file name must not reveal the key.
    expect(path).not.toContain("refresh");

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("tok-123");
    expect(await store.get("auth:extract:refresh-token")).toBe("tok-123");
  });

  it("leaves no temporary files behind after a write", async () => {
    const data = await tempDir();
    const store = new FileCredentialStore({ dataDir: data });
    await store.set("k", "v");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(data, "credentials"));
    expect(entries).toEqual([credentialFileHash("k")]);
  });

  it("delete is idempotent and get returns null for unknown keys", async () => {
    const data = await tempDir();
    const store = new FileCredentialStore({ dataDir: data });
    expect(await store.get("missing")).toBeNull();
    await store.delete("missing");
    await store.set("k", "v");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });

  it("reports a failing write as CredentialStoreError without fallback", async () => {
    const data = await tempDir();
    // Make the credentials path a regular file so mkdir fails.
    await writeFile(join(data, "credentials"), "not a directory");
    const store = new FileCredentialStore({ dataDir: data });
    await expect(store.set("k", "v")).rejects.toBeInstanceOf(CredentialStoreError);
    // Nothing was written anywhere else (no plaintext fallback, 15.4).
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(data);
    expect(entries).toEqual(["credentials"]);
  });

  it("reads Docker secret mounts and strips a trailing newline", async () => {
    const data = await tempDir();
    const mount = await tempDir();
    const hash = credentialFileHash("OUTPOST_MOUNTED");
    await writeFile(join(mount, hash), "mounted-secret\n");
    const store = new FileCredentialStore({ dataDir: data, extraReadDirs: [mount] });
    expect(await store.get("OUTPOST_MOUNTED")).toBe("mounted-secret");
  });

  it("prefers the data directory over a secret mount", async () => {
    const data = await tempDir();
    const mount = await tempDir();
    const hash = credentialFileHash("k");
    await writeFile(join(mount, hash), "from-mount\n");
    const store = new FileCredentialStore({ dataDir: data, extraReadDirs: [mount] });
    await store.set("k", "from-store");
    expect(await store.get("k")).toBe("from-store");
  });

  it("notifies the watcher about changed keys by hash", async () => {
    const data = await tempDir();
    await mkdir(join(data, "credentials"), { recursive: true });
    const store = new FileCredentialStore({ dataDir: data });
    const seen: string[] = [];
    store.watchChanges((keyHash) => seen.push(keyHash));
    try {
      await store.set("watched-key", "value");
      // fs.watch delivery is asynchronous — poll briefly.
      const target = credentialFileHash("watched-key");
      for (let i = 0; i < 50 && !seen.includes(target); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen).toContain(target);
    } finally {
      store.unwatchChanges();
    }
  });

  it("a failing fs.watch is logged and not fatal", async () => {
    const data = await tempDir();
    // No credentials directory exists yet; watch() fails with ENOENT.
    const warn = vi.fn();
    const store = new FileCredentialStore({
      dataDir: data,
      logger: { warn } as never,
    });
    store.watchChanges(() => {});
    expect(warn).toHaveBeenCalled();
    // The store still works.
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
  });
});

describe("MemoryCredentialStore", () => {
  it("get/set/delete round trip", async () => {
    const store = new MemoryCredentialStore();
    expect(await store.get("a")).toBeNull();
    await store.set("a", "1");
    expect(await store.get("a")).toBe("1");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });
});

describe("credential keys", () => {
  it("constructs the documented namespaces", () => {
    expect(sourceOauthRefreshKey("team-a")).toBe("source:team-a:oauth-refresh");
    expect(sourceGdriveSaKey("g1")).toBe("source:g1:gdrive-sa");
    expect(sourceS3AccessKeyKey("s3")).toBe("source:s3:s3-access-key");
    expect(sourceS3SecretKeyKey("s3")).toBe("source:s3:s3-secret-key");
  });

  it("EXTRACT_AUTH_KEYS is exactly the three auth:extract keys", () => {
    expect(EXTRACT_AUTH_KEYS).toEqual([
      "auth:extract:refresh-token",
      "auth:extract:api-token",
      "auth:extract:client-secret",
    ]);
    for (const key of EXTRACT_AUTH_KEYS) expect(isExtractAuthKey(key)).toBe(true);
    expect(isExtractAuthKey(sourceOauthRefreshKey("x"))).toBe(false);
  });
});
