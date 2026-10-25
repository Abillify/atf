// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * source-url.test.ts
 *
 * Unit tests for the SSRF controls of the `source_url` pull
 * and the Postgres upload-offset committer:
 *
 *   - address classification (private, loopback, link-local, ULA, CGNAT,
 *     metadata, unspecified, IPv4-mapped/embedded IPv6);
 *   - DNS resolution refuses a host when ANY answer is forbidden;
 *   - the connection is pinned to the validated address via the `lookup`
 *     hook, so a host name that does not even resolve still reaches the pinned
 *     address (no second DNS query that could be rebound);
 *   - the committer locks the row and advances with a conditional update.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  isForbiddenAddress,
  pinnedLookup,
  pinnedRequest,
  resolvePinnedAddress,
  resolveSourceUrl,
} from "../src/handlers/source-url.js";
import {
  createPgUploadOffsetCommitter,
  KeyedMutex,
} from "../src/handlers/upload-session-lock.js";
import { advanceUploadOffsetInTx, type ExtractStore } from "../src/persistence/index.js";

const config = { allowedHosts: [], maxBytes: 1024, timeoutMs: 1000 };

describe("isForbiddenAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "127.8.9.10",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.1.2.3",
    "::ffff:169.254.169.254",
    "[::ffff:192.168.1.1]",
    "64:ff9b::a00:1",
    "2002:0a00:0001::1",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "2002:0808:0808::1",
  ])("allows public %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });
});

describe("resolveSourceUrl / resolvePinnedAddress", () => {
  it("refuses literal forbidden IPs without any DNS query", async () => {
    for (const raw of ["http://127.0.0.1/", "http://[::1]/", "http://[::ffff:10.0.0.1]/"]) {
      expect(() => resolveSourceUrl(raw, config)).toThrow(/private, loopback or reserved/);
    }
  });

  it("applies the allowlist in addition to the address checks", () => {
    expect(() =>
      resolveSourceUrl("https://evil.example.net/x", { ...config, allowedHosts: ["storage.example.com"] }),
    ).toThrow(/SOURCE_URL_ALLOWED_HOSTS/);
  });

  it("returns the first address when every answer is public", async () => {
    const pinned = await resolvePinnedAddress(new URL("https://storage.example.com/x"), async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(pinned).toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });

  it("refuses the host when any answer is forbidden", async () => {
    await expect(
      resolvePinnedAddress(new URL("https://storage.example.com/x"), async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "fd12::1", family: 6 },
      ]),
    ).rejects.toThrow(/resolves to a private/);
  });

  it("maps a resolution failure or an empty answer to SOURCE_FETCH_FAILED", async () => {
    await expect(
      resolvePinnedAddress(new URL("https://nx.example.com/x"), async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FETCH_FAILED" });
    await expect(
      resolvePinnedAddress(new URL("https://nx.example.com/x"), async () => []),
    ).rejects.toMatchObject({ code: "SOURCE_FETCH_FAILED" });
  });

  it("does not consult the resolver for an IP-literal host", async () => {
    let called = false;
    const pinned = await resolvePinnedAddress(new URL("http://93.184.216.34/x"), async () => {
      called = true;
      return [];
    });
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
    expect(called).toBe(false);
  });
});

describe("pinned connection", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("the lookup hook answers with the pinned address in both callback forms", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    const single: unknown[] = [];
    lookup("x.example.com", {}, (...args: unknown[]) => single.push(...args));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all: unknown[] = [];
    lookup("x.example.com", { all: true }, (...args: unknown[]) => all.push(...args));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  it("connects to the pinned address, never re-resolving the host name", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-length", "2");
      res.end(req.headers.host?.startsWith("pinned.invalid") ? "ok" : "no");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    // `.invalid` never resolves (RFC 6761); reaching the server proves the
    // socket used the pinned address and the Host header kept the name.
    const response = await pinnedRequest(
      new URL(`http://pinned.invalid:${port}/doc`),
      { address: "127.0.0.1", family: 4 },
      { headers: {}, signal: new AbortController().signal },
    );
    expect(response.status).toBe(200);
    expect(response.header("content-length")).toBe("2");
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("ok");
  });
});

describe("KeyedMutex", () => {
  it("is a non-blocking per-key try-lock with idempotent release", () => {
    const mutex = new KeyedMutex();
    const release = mutex.tryAcquire("a");
    expect(release).not.toBeNull();
    expect(mutex.tryAcquire("a")).toBeNull();
    expect(mutex.tryAcquire("b")).not.toBeNull();
    release?.();
    release?.();
    expect(mutex.isHeld("a")).toBe(false);
    expect(mutex.tryAcquire("a")).not.toBeNull();
  });
});

describe("createPgUploadOffsetCommitter", () => {
  function fakeStore(row: Record<string, unknown> | null, updateMatches = true) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      async query(text: string, values: unknown[]) {
        queries.push({ text, values });
        if (/FOR UPDATE/.test(text)) return { rows: row === null ? [] : [row] };
        if (/^\s*UPDATE/.test(text)) {
          return { rows: updateMatches ? [{ ...row, received_offset: values[2] }] : [] };
        }
        throw new Error(`unexpected query ${text}`);
      },
    } as unknown as PoolClient;
    // The real store runs advanceUploadOffsetInTx inside its own transaction;
    // here the fake client stands in for that transaction.
    const store = {
      advanceUploadOffset: (commit) => advanceUploadOffsetInTx(client, commit),
    } satisfies Pick<ExtractStore, "advanceUploadOffset">;
    return { store, queries };
  }

  it("locks the row, appends, then advances with a conditional update", async () => {
    const { store, queries } = fakeStore({ upload_id: "u", status: "open", received_offset: "8" });
    let appended = 0;
    const result = await createPgUploadOffsetCommitter(store).commitChunk({
      uploadId: "u",
      expectedOffset: 8,
      newOffset: 20,
      append: async () => {
        appended++;
      },
    });
    expect(result.status).toBe("committed");
    expect(appended).toBe(1);
    expect(queries[0]?.text).toMatch(/SELECT \* FROM extract\.uploads WHERE upload_id = \$1 FOR UPDATE/);
    expect(queries[1]?.text).toMatch(/WHERE upload_id = \$1\s+AND received_offset = \$2\s+AND status = 'open'/);
    expect(queries[1]?.values).toEqual(["u", 8, 20]);
  });

  it("reports a conflict without appending when the offset moved", async () => {
    const { store, queries } = fakeStore({ upload_id: "u", status: "open", received_offset: 12 });
    let appended = 0;
    const result = await createPgUploadOffsetCommitter(store).commitChunk({
      uploadId: "u",
      expectedOffset: 8,
      newOffset: 20,
      append: async () => {
        appended++;
      },
    });
    expect(result).toMatchObject({ status: "conflict", current: { received_offset: 12 } });
    expect(appended).toBe(0);
    expect(queries).toHaveLength(1);
  });

  it("reports a conflict for a closed or vanished session", async () => {
    for (const row of [{ upload_id: "u", status: "completed", received_offset: 8 }, null]) {
      const { store } = fakeStore(row);
      const result = await createPgUploadOffsetCommitter(store).commitChunk({
        uploadId: "u",
        expectedOffset: 8,
        newOffset: 9,
        append: async () => {},
      });
      expect(result.status).toBe("conflict");
    }
  });

  it("fails (rolling back) when the conditional update matches nothing", async () => {
    const { store } = fakeStore({ upload_id: "u", status: "open", received_offset: 8 }, false);
    await expect(
      createPgUploadOffsetCommitter(store).commitChunk({
        uploadId: "u",
        expectedOffset: 8,
        newOffset: 9,
        append: async () => {},
      }),
    ).rejects.toThrow(/matched no row/);
  });
});
