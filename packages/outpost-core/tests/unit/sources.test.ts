// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the source adapters.
 *
 * Covered: GDrive export mapping (6.7), S3 endpoint override and
 * addressing (6.5), SigV4 signature, credential resolution (6.4),
 * errors → listing incomplete (6.12), refresh-token rotation (6.17) and
 * Dropbox markers (6.8).
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectListing,
  createDropboxSource,
  createGdriveSource,
  createLocalSource,
  createS3Source,
  exportMimeType,
  MemoryCredentialStore,
  resolveS3Credentials,
  resolveS3Target,
  SourceRejectedError,
  type GdriveSource,
} from "../../src/index.js";
import { FakeDropbox } from "../fakes/fake-dropbox.js";
import { FakeGdrive } from "../fakes/fake-gdrive.js";
import { FakeS3 } from "../fakes/fake-s3.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const noSignal = new AbortController().signal

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "outpost-sources-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GDrive Export-Mapping (6.7)", () => {
  it("exportMimeType maps the configured formats, default pdf", () => {
    expect(exportMimeType("pdf")).toBe("application/pdf");
    expect(exportMimeType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(exportMimeType("xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(exportMimeType("pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(exportMimeType("unknown")).toBe("application/pdf");
  });

  it("workspace files get exportAs; open hits /export with mimeType", async () => {
    const gdrive = new FakeGdrive();
    gdrive.addFile({ id: "root", name: "R", parentId: null, mimeType: "application/vnd.google-apps.folder" });
    gdrive.addFile({
      id: "doc1",
      name: "Bericht",
      parentId: "root",
      mimeType: "application/vnd.google-apps.document",
      revisionId: "rev-7",
    });
    gdrive.addFile({
      id: "bin1",
      name: "bild.png",
      parentId: "root",
      mimeType: "image/png",
      body: enc("png-bytes"),
      md5Checksum: "md5-1",
    });
    const adapter = createGdriveSource(
      { id: "g", folderId: "root", exportFormat: "docx" },
      {
        fetchImpl: gdrive.fetchImpl,
        credential: { kind: "refresh-token", token: "rt" },
        clientId: "cid",
      },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const doc = result.items.find((i) => i.quellId === "doc1");
    const bin = result.items.find((i) => i.quellId === "bin1");
    expect(doc?.exportAs).toBe("docx");
    // Workspace: md5Checksum missing → revisionId is the marker (6.6).
    expect(doc?.marker).toBe("rev-7");
    expect(bin?.exportAs).toBeUndefined();
    expect(bin?.marker).toBe("md5-1");

    if (doc !== undefined) {
      const content = await readAll(await adapter.open(doc, noSignal));
      expect(dec(content)).toContain("exported:Bericht:");
      expect(gdrive.exportCalls).toBe(1);
      expect(gdrive.lastExportMimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }
    if (bin !== undefined) {
      const content = await readAll(await adapter.open(bin, noSignal));
      expect(dec(content)).toBe("png-bytes");
      expect(gdrive.downloadCalls).toBe(1);
    }
  });

  it("refresh-token rotation becomes visible via rotatedRefreshToken() (6.17)", async () => {
    const gdrive = new FakeGdrive({ rotateOnRefresh: "rt-rotated" });
    gdrive.addFile({ id: "root", name: "R", parentId: null, mimeType: "application/vnd.google-apps.folder" });
    const adapter: GdriveSource = createGdriveSource(
      { id: "g", folderId: "root", exportFormat: "pdf" },
      {
        fetchImpl: gdrive.fetchImpl,
        credential: { kind: "refresh-token", token: "rt-alt" },
        clientId: "cid",
      },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    expect(adapter.rotatedRefreshToken()).toBe("rt-rotated");
    expect(gdrive.tokenCalls).toBe(1);
  });

  it("abgelehntes Refresh-Token → SourceRejectedError, Listing incomplete (6.12, 6.18)", async () => {
    const gdrive = new FakeGdrive({ rejectRefresh: true });
    const adapter = createGdriveSource(
      { id: "g", folderId: "root", exportFormat: "pdf" },
      {
        fetchImpl: gdrive.fetchImpl,
        credential: { kind: "refresh-token", token: "rt" },
        clientId: "cid",
      },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");
    expect(result.kind === "incomplete" && result.error).toBeInstanceOf(SourceRejectedError);
    // The listing never reaches the API (6.18).
    expect(gdrive.listCalls).toBe(0);
  });

  it("invalid service-account key → SourceRejectedError", async () => {
    const gdrive = new FakeGdrive();
    const adapter = createGdriveSource(
      { id: "g", folderId: "root", exportFormat: "pdf" },
      {
        fetchImpl: gdrive.fetchImpl,
        credential: { kind: "service-account", keyJson: "{kein json}" },
      },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");
    expect(result.kind === "incomplete" && result.error).toBeInstanceOf(SourceRejectedError);
    expect(gdrive.listCalls).toBe(0);
  });

  it("listing errors (500 / network) → incomplete (6.12)", async () => {
    const gdrive = new FakeGdrive();
    gdrive.addFile({ id: "root", name: "R", parentId: null, mimeType: "application/vnd.google-apps.folder" });
    gdrive.injectListFailure(500);
    const adapter = createGdriveSource(
      { id: "g", folderId: "root", exportFormat: "pdf" },
      {
        fetchImpl: gdrive.fetchImpl,
        credential: { kind: "refresh-token", token: "rt" },
        clientId: "cid",
      },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");

    const gdrive2 = new FakeGdrive();
    gdrive2.addFile({ id: "root", name: "R", parentId: null, mimeType: "application/vnd.google-apps.folder" });
    gdrive2.injectListNetworkFailure();
    const adapter2 = createGdriveSource(
      { id: "g", folderId: "root", exportFormat: "pdf" },
      {
        fetchImpl: gdrive2.fetchImpl,
        credential: { kind: "refresh-token", token: "rt" },
        clientId: "cid",
      },
    );
    const result2 = await collectListing(adapter2, noSignal);
    expect(result2.kind).toBe("incomplete");
  });
});

describe("S3 addressing and SigV4 (6.3, 6.4, 6.5)", () => {
  it("resolveS3Target: virtual-hosted Default, Endpoint-Override, path-style, localhost", () => {
    expect(resolveS3Target("b", "eu-central-1")).toEqual({
      host: "b.s3.eu-central-1.amazonaws.com",
      pathPrefix: "",
      scheme: "https",
    });
    // 6.5: a custom endpoint replaces the AWS default.
    expect(resolveS3Target("b", "us-east-1", "https://s3.mine.example")).toEqual({
      host: "b.s3.mine.example",
      pathPrefix: "",
      scheme: "https",
    });
    expect(
      resolveS3Target("b", "us-east-1", "https://s3.mine.example", true),
    ).toEqual({ host: "s3.mine.example", pathPrefix: "/b", scheme: "https" });
    // localhost (MinIO) erzwingt path-style.
    expect(resolveS3Target("b", "us-east-1", "http://localhost:9000")).toEqual({
      host: "localhost:9000",
      pathPrefix: "/b",
      scheme: "http",
    });
  });

  it("credentials from the store; SigV4 Authorization header set", async () => {
    const s3 = new FakeS3({ bucket: "b", pageSize: 2 });
    s3.addObject("docs/a.txt", enc("a"));
    s3.addObject("docs/b.txt", enc("b"));
    s3.addObject("docs/c.txt", enc("c"));
    const store = new MemoryCredentialStore();
    await store.set("source:s3a:s3-access-key", "AKIATEST");
    await store.set("source:s3a:s3-secret-key", "secret");
    const options = { id: "s3a", bucket: "b", region: "eu-central-1", credentials: "store" } as const;
    const creds = await resolveS3Credentials(options, {
      fetchImpl: s3.fetchImpl,
      store,
      env: {},
    });
    expect(creds).toEqual({ accessKeyId: "AKIATEST", secretAccessKey: "secret" });

    const adapter = createS3Source(options, { fetchImpl: s3.fetchImpl, store, env: {} });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.items.map((i) => i.quellId)).toEqual([
        "docs/a.txt",
        "docs/b.txt",
        "docs/c.txt",
      ]);
      expect(result.items[0]?.link).toBe("s3://b/docs/a.txt");
    }
    // Pagination mit pageSize 2 → mindestens 2 List-Aufrufe.
    expect(s3.listCalls).toBeGreaterThanOrEqual(2);
    expect(s3.lastAuthHeader).toBeDefined();
    expect(s3.lastAuthHeader).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-central-1\/s3\/aws4_request/);
  });

  it("default chain via environment variables (6.4)", async () => {
    const store = new MemoryCredentialStore();
    const creds = await resolveS3Credentials(
      { id: "s3b", bucket: "b", credentials: "default-chain" },
      {
        fetchImpl: new FakeS3({ bucket: "b" }).fetchImpl,
        store,
        env: {
          AWS_ACCESS_KEY_ID: "ENVID",
          AWS_SECRET_ACCESS_KEY: "ENVSECRET",
          AWS_SESSION_TOKEN: "ENVTOKEN",
        },
      },
    );
    expect(creds).toEqual({
      accessKeyId: "ENVID",
      secretAccessKey: "ENVSECRET",
      sessionToken: "ENVTOKEN",
    });
  });

  it("profile resolution from ~/.aws/credentials (6.4)", async () => {
    const store = new MemoryCredentialStore();
    const ini = ["[default]", "aws_access_key_id = PROFID", "aws_secret_access_key = PROFSECRET"].join("\n");
    const creds = await resolveS3Credentials(
      { id: "s3c", bucket: "b", credentials: { profile: "default" } },
      {
        fetchImpl: new FakeS3({ bucket: "b" }).fetchImpl,
        store,
        env: {},
        homeDir: "/home/test",
        readFile: async (p) => {
          expect(p).toBe("/home/test/.aws/credentials");
          return ini;
        },
      },
    );
    expect(creds).toEqual({ accessKeyId: "PROFID", secretAccessKey: "PROFSECRET" });
  });

  it("fehlende Credentials → Listing incomplete (6.12)", async () => {
    const s3 = new FakeS3({ bucket: "b" });
    const adapter = createS3Source(
      { id: "s3d", bucket: "b", credentials: "store" },
      { fetchImpl: s3.fetchImpl, store: new MemoryCredentialStore(), env: {} },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");
    expect(s3.listCalls).toBe(0);
  });

  it("S3-Fehlerinjektion → incomplete (6.12)", async () => {
    const s3 = new FakeS3({ bucket: "b", failListStatus: 500 });
    s3.addObject("a.txt", enc("a"));
    const store = new MemoryCredentialStore();
    await store.set("source:s3e:s3-access-key", "AKIA");
    await store.set("source:s3e:s3-secret-key", "s");
    const adapter = createS3Source(
      { id: "s3e", bucket: "b", credentials: "store" },
      { fetchImpl: s3.fetchImpl, store, env: {} },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");
  });

  it("open loads the object content signed", async () => {
    const s3 = new FakeS3({ bucket: "b" });
    s3.addObject("x/y.bin", enc("inhalt"));
    const store = new MemoryCredentialStore();
    await store.set("source:s3f:s3-access-key", "AKIA");
    await store.set("source:s3f:s3-secret-key", "s");
    const adapter = createS3Source(
      { id: "s3f", bucket: "b", credentials: "store" },
      { fetchImpl: s3.fetchImpl, store, env: {} },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const [first] = result.items;
    if (first === undefined) throw new Error("listing is empty");
    const content = await readAll(await adapter.open(first, noSignal));
    expect(dec(content)).toBe("inhalt");
    expect(s3.getCalls).toBe(1);
  });
});

describe("Dropbox (6.8)", () => {
  it("marker = content_hash, otherwise rev; only .tag=file appears", async () => {
    const dropbox = new FakeDropbox();
    dropbox.addEntry({
      id: "id1",
      name: "a.txt",
      pathDisplay: "/a.txt",
      type: "file",
      body: enc("A"),
      contentHash: "chash1",
      rev: "r1",
    });
    dropbox.addEntry({
      id: "id2",
      name: "b.txt",
      pathDisplay: "/b.txt",
      type: "file",
      body: enc("B"),
      rev: "r2",
    });
    dropbox.addEntry({ id: "fid", name: "ordner", pathDisplay: "/ordner", type: "folder" });
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
    const byId = new Map(result.items.map((i) => [i.quellId, i]));
    expect(byId.get("id1")?.marker).toBe("chash1");
    expect(byId.get("id2")?.marker).toBe("r2");
    expect(byId.has("fid")).toBe(false);

    const item = byId.get("id1");
    if (item !== undefined) {
      const content = await readAll(await adapter.open(item, noSignal));
      expect(dec(content)).toBe("A");
      expect(dropbox.lastDownloadPath).toBe("/a.txt");
    }
  });

  it("rejected refresh token → SourceRejectedError, no listing (6.18)", async () => {
    const dropbox = new FakeDropbox({ rejectRefresh: true });
    const adapter = createDropboxSource(
      { id: "d", path: "" },
      {
        fetchImpl: dropbox.fetchImpl,
        credential: { kind: "refresh-token", token: "rt" },
        clientId: "cid",
      },
    );
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("incomplete");
    expect(result.kind === "incomplete" && result.error).toBeInstanceOf(SourceRejectedError);
    expect(dropbox.listCalls).toBe(0);
  });
});

describe("local source: open with the path guard (15.5)", () => {
  it("reads files; symlinks pointing outside are rejected on open", async () => {
    const dir = path.join(tmpDir, "src");
    const outside = path.join(tmpDir, "out");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.txt"), enc("inhalt-a"));
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), enc("geheim"));
    await symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));

    const adapter = createLocalSource({ root: dir });
    const result = await collectListing(adapter, noSignal);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    // The symlink does not appear in the listing (6.2), only a.txt.
    expect(result.items.map((i) => i.quellId)).toEqual(["a.txt"]);

    const [first] = result.items;
    if (first === undefined) throw new Error("listing is empty");
    const content = await readAll(await adapter.open(first, noSignal));
    expect(dec(content)).toBe("inhalt-a");

    // A forced escape path is rejected on open.
    await expect(
      adapter.open(
        { quellId: "link.txt", name: "link.txt", size: 6, modified: new Date(), marker: "m" },
        noSignal,
      ),
    ).rejects.toThrow(/path guard rejected/);
  });
});
