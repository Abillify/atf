// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * upload-spill.test.ts
 *
 * Disk spooling of uploads above the memory threshold.
 *
 * A document that waits in the conversion queue holds its bytes for the whole
 * wait, so an all-heap parser turns a full queue of large uploads into an
 * out-of-memory event with a 202 already sent. Above
 * `UPLOAD_MEMORY_THRESHOLD_BYTES` the upload is therefore spooled to a scratch
 * file under `TEMP_DIR/uploads`; these tests pin the three properties that
 * make that safe:
 *
 *   - the scratch file exists exactly while the request owns it (visible from
 *     inside the extractor, gone once the handler is done — success or not);
 *   - the bytes the extractor sees are byte-identical to what was uploaded;
 *   - the raw-body path and small uploads never touch the scratch directory.
 *
 * The startup sweep — the backstop for a process that died mid-request — is
 * covered separately at the bottom.
 */

import { once } from "node:events";
import { readdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import { sweepUploadScratch } from "../src/upload.js";
import { loadTestConfig, stubExtractor, stubVisionClient, testLogger } from "./helpers.js";

const PDF_HEAD = "%PDF-1.7\n";

/** Well above the 1 KiB threshold every test here configures. */
const LARGE = Buffer.concat([Buffer.from(PDF_HEAD), Buffer.alloc(200_000, 0x41)]);
const SMALL = Buffer.from(`${PDF_HEAD}small document\n`);

let tempRoot: string;

function scratchRoot(): string {
  return join(tempRoot, "uploads");
}

/** Scratch files currently on disk; empty when the directory was never made. */
async function scratchFiles(): Promise<string[]> {
  try {
    return await readdir(scratchRoot());
  } catch {
    return [];
  }
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "atf-spill-"));
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

/** Mount the real app with a tiny threshold, on one stable loopback URL. */
async function app(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
): Promise<string> {
  const config = loadTestConfig({
    TEMP_DIR: tempRoot,
    UPLOAD_MEMORY_THRESHOLD_BYTES: "1024",
    ...configOverrides,
  });
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: async () => ({ available: true, version: "stub" }),
    ...overrides,
  });
  cleanups.push(created.cleanup);
  const server = created.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

/** A loopback HTTP server that records callback bodies. */
async function startCallbackReceiver(): Promise<{
  url: string;
  received: string[];
  close: () => Promise<void>;
}> {
  const received: string[] = [];
  const server = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf-8"));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("POST /v1/convert with disk spooling (requirement 5.9)", () => {
  it("keeps a small multipart upload entirely in memory", async () => {
    const seen: Uint8Array[] = [];
    const response = await request(
      await app(
        {},
        { extractor: stubExtractor({ onExtract: (input) => seen.push(input.buffer) }) },
      ),
    )
      .post("/v1/convert")
      .attach("document", SMALL, { filename: "klein.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(200);
    expect(Buffer.from(seen[0] ?? new Uint8Array())).toEqual(SMALL);
    // The common case must not pay for the filesystem at all.
    expect(await scratchFiles()).toEqual([]);
  });

  it("spools a large multipart upload and removes the scratch file afterwards", async () => {
    const seen: Uint8Array[] = [];
    // Captured from inside the extractor: the file must exist while the
    // request owns it. The snapshot is taken synchronously, because an async
    // readdir can be scheduled after the handler's finally has already removed
    // the scratch file (observed under parallel load).
    let scratchDuring: string[] | undefined;
    const response = await request(
      await app(
        {},
        {
          extractor: stubExtractor({
            onExtract: (input) => {
              seen.push(input.buffer);
              try {
                scratchDuring = readdirSync(scratchRoot());
              } catch {
                scratchDuring = [];
              }
            },
          }),
        },
      ),
    )
      .post("/v1/convert")
      .attach("document", LARGE, { filename: "gross.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(200);
    expect(scratchDuring).toHaveLength(1);
    // The extractor must see the uploaded bytes, not a truncated spool.
    expect(Buffer.from(seen[0] ?? new Uint8Array())).toEqual(LARGE);
    expect(await scratchFiles()).toEqual([]);
  });

  it("removes the scratch file when the extractor fails", async () => {
    const response = await request(
      await app(
        {},
        { extractor: stubExtractor({ error: new Error("converter exploded") }) },
      ),
    )
      .post("/v1/convert")
      .attach("document", LARGE, { filename: "gross.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(500);
    expect(await scratchFiles()).toEqual([]);
  });

  it("removes the scratch file after the detached asynchronous delivery", async () => {
    const receiver = await startCallbackReceiver();
    cleanups.push(() => receiver.close());

    const response = await request(
      await app({ CALLBACK_ALLOWED_HOSTS: "127.0.0.1" }),
    )
      .post("/v1/convert")
      .set("X-Callback-URL", `${receiver.url}/done`)
      .attach("document", LARGE, { filename: "gross.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(202);
    // The response is gone at this point; the detached block owns the file.
    await vi.waitFor(async () => {
      expect(receiver.received.length).toBeGreaterThan(0);
      expect(await scratchFiles()).toEqual([]);
    });
  });

  it("never touches the scratch directory for a raw-body upload", async () => {
    // express.raw has no storage seam; the raw path stays in memory and must
    // not leave anything behind either.
    const response = await request(await app())
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .send(LARGE);

    expect(response.status).toBe(200);
    expect(await scratchFiles()).toEqual([]);
  });
});

describe("sweepUploadScratch", () => {
  it("removes files a crashed previous process left behind", async () => {
    await mkdir(scratchRoot(), { recursive: true });
    await writeFile(join(scratchRoot(), "upload-stale-1"), "leftover");
    await writeFile(join(scratchRoot(), "upload-stale-2"), "leftover");

    await sweepUploadScratch(tempRoot, testLogger);

    expect(await scratchFiles()).toEqual([]);
  });

  it("is a no-op when no spool has ever happened", async () => {
    await expect(sweepUploadScratch(tempRoot, testLogger)).resolves.toBeUndefined();
  });
});
