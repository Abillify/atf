// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * revision-client.test.ts
 *
 * The v2 revision client (task 1.12): the HTTP binding the emitter uses to
 * stream to Search's revision API. These tests exercise the request framing and
 * the transient/permanent error classification the emitter relies on to decide
 * between a retry-and-reconcile pause and a job failure. `fetch` is stubbed, so
 * no server is involved.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { testLogger } from "./helpers.js";
import {
  createRevisionClient,
  RevisionPermanentError,
  RevisionTransientError,
} from "../src/revision-client.js";

const CONFIG = {
  url: "http://search.internal",
  token: "t0ken",
  collection: "documents",
  timeoutMs: 5000,
  caCertFile: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revision-client · request framing", () => {
  it("opens a revision with the idempotency key and collection", async () => {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(201, {
          revisionId: "rev-1",
          reference: "doc/a.pdf",
          status: "staging",
          visibility: "progressive",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createRevisionClient(CONFIG, testLogger);

    const revision = await client.createRevision({
      reference: "doc/a.pdf",
      idempotencyKey: "job-123",
      visibility: "progressive",
    });

    expect(revision.revisionId).toBe("rev-1");
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string | URL, RequestInit];
    expect(String(url)).toContain("/v2/documents/doc%2Fa.pdf/revisions");
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("job-123");
    expect(headers.authorization).toBe("Bearer t0ken");
    expect(headers["x-visibility"]).toBe("progressive");
  });

  it("sends the source claim and the document ACL on revision create", async () => {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(201, {
          revisionId: "rev-2",
          reference: "doc/a.pdf",
          status: "staging",
          visibility: "on_commit",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createRevisionClient(CONFIG, testLogger);
    await client.createRevision({
      reference: "doc/a.pdf",
      idempotencyKey: "job-9",
      sourceId: "job-9",
      acl: { allowedUsers: ["anna", "jürgen"], allowedGroups: ["team"] },
    });
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-source-id"]).toBe("job-9");
    // Non-ASCII ids travel base64-encoded, as Search's readHeader expects.
    expect(headers["x-allowed-users"]).toBe(`base64:${Buffer.from("anna,jürgen").toString("base64")}`);
    expect(headers["x-allowed-groups"]).toBe("team");
  });

  it("PUTs a batch with the Content-Digest header at its seq", async () => {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(200, { seq: 3, digest: "sha-256=:abc:", status: "received", noop: false }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createRevisionClient(CONFIG, testLogger);

    const ack = await client.putBatch({
      reference: "doc/a.pdf",
      revisionId: "rev-1",
      seq: 3,
      body: new TextEncoder().encode('{"type":"page"}\n'),
      contentDigest: "sha-256=:abc:",
    });

    expect(ack.seq).toBe(3);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string | URL, RequestInit];
    expect(String(url)).toContain("/revisions/rev-1/batches/3");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-digest"]).toBe("sha-256=:abc:");
  });

  it("PUTs an asset with figure identity + placement headers", async () => {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 201 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createRevisionClient(CONFIG, testLogger);

    await client.putAsset({
      asset: {
        assetId: "a".repeat(64),
        buffer: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        checksum: "b".repeat(64),
        kind: "figure",
        localId: "p368-f1",
        page: 368,
        bbox: [0.1, 0.2, 0.3, 0.4],
      },
      reference: "doc/a.pdf",
      revisionId: "rev-1",
    });

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["x-asset-kind"]).toBe("figure");
    // Search indexes figure_id / page / bbox from these — expected_figure_id
    // and region zooms depend on them being present.
    expect(headers["x-figure-id"]).toBe("p368-f1");
    expect(headers["x-page"]).toBe("368");
    expect(headers["x-bbox"]).toBe("0.1,0.2,0.3,0.4");
  });

  it("omits the placement headers when an asset carries no metadata", async () => {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 201 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createRevisionClient(CONFIG, testLogger);

    await client.putAsset({
      asset: {
        assetId: "c".repeat(64),
        buffer: new Uint8Array([9]),
        mimeType: "image/png",
        checksum: "d".repeat(64),
        kind: "page",
      },
      reference: "doc/a.pdf",
      revisionId: "rev-1",
    });

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["x-figure-id"]).toBeUndefined();
    expect(headers["x-page"]).toBeUndefined();
    expect(headers["x-bbox"]).toBeUndefined();
  });
});

describe("revision-client · error classification", () => {
  it("treats a 5xx as transient (retryable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream down", { status: 503 })));
    const client = createRevisionClient(CONFIG, testLogger);
    await expect(
      client.putBatch({
        reference: "r",
        revisionId: "rev",
        seq: 0,
        body: new Uint8Array([1]),
        contentDigest: "d",
      }),
    ).rejects.toBeInstanceOf(RevisionTransientError);
  });

  it("treats a network throw as transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const client = createRevisionClient(CONFIG, testLogger);
    await expect(client.getState({ reference: "r", revisionId: "rev" })).rejects.toBeInstanceOf(
      RevisionTransientError,
    );
  });

  it("treats a 400 as permanent (not retryable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "bad batch", code: "INVALID_RECORD" })),
    );
    const client = createRevisionClient(CONFIG, testLogger);
    await expect(
      client.putBatch({
        reference: "r",
        revisionId: "rev",
        seq: 0,
        body: new Uint8Array([1]),
        contentDigest: "d",
      }),
    ).rejects.toBeInstanceOf(RevisionPermanentError);
  });

  it("surfaces a 409 commit as an uncommitted result carrying the missing ranges", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, {
          reference: "r",
          revisionId: "rev",
          committed: false,
          missingRanges: [{ from: 5, to: 6 }],
        }),
      ),
    );
    const client = createRevisionClient(CONFIG, testLogger);
    const result = await client.commit({ reference: "r", revisionId: "rev" });
    expect(result.committed).toBe(false);
    expect(result.missingRanges).toEqual([{ from: 5, to: 6 }]);
  });

  it("returns false from headAsset on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const client = createRevisionClient(CONFIG, testLogger);
    const exists = await client.headAsset({ assetId: "a1", reference: "r", revisionId: "rev" });
    expect(exists).toBe(false);
  });
});
