// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-source / per-item access control lists (T-203).
 *
 * Covers: the effective ACL precedence (item > nested source `acl` > legacy
 * flat lists), the headers/job bodies Extract receives, the ACL digest in the
 * Sync_State, and the migration rule — a state without a stored digest means
 * "unknown" and never forces a re-upload by itself, while a changed digest on
 * an otherwise unchanged document does.
 */

import { describe, expect, it } from "vitest";
import {
  aclDigest,
  buildIngestHeaders,
  effectiveAcl,
  effectiveAclDigest,
  outpostConfigSchema,
  planAfterHash,
  planItem,
  reduce,
  toJobRequest,
  type ItemState,
  type OutpostConfig,
  type SourceConfig,
  type SourceItem,
} from "../../src/index.js";
import { makeHarness } from "../fakes/run-harness.js";

const cfg: OutpostConfig = outpostConfigSchema.parse({
  extractUrl: "https://extract.example.com",
  collection: "main",
});

function localSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { type: "local", path: "/src", id: "s1", ...overrides } as SourceConfig;
}

function item(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    quellId: "a.txt",
    name: "a.txt",
    size: 3,
    modified: new Date("2026-01-01T00:00:00Z"),
    marker: "3:deadbeef",
    ...overrides,
  };
}

const decoded = (headers: Record<string, string>, name: string): string[] => {
  let value = headers[name] ?? "";
  if (value.toLowerCase().startsWith("base64:")) {
    value = Buffer.from(value.slice("base64:".length), "base64").toString("utf-8");
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
};

describe("effective ACL precedence", () => {
  it("no ACL anywhere yields undefined", () => {
    expect(effectiveAcl(item(), localSource())).toBeUndefined();
    expect(effectiveAclDigest(item(), localSource())).toBeUndefined();
  });

  it("nested source acl is used when the item has none", () => {
    const src = localSource({
      acl: { users: [" u1 ", "u2"], groups: ["g1"] },
      allowedUsers: ["legacy"],
    });
    expect(effectiveAcl(item(), src)).toEqual({
      allowedUsers: ["u1", "u2"],
      allowedGroups: ["g1"],
    });
  });

  it("legacy flat lists apply when no nested acl is configured", () => {
    const src = localSource({ allowedUsers: ["u9"], allowedGroups: ["g9"] });
    expect(effectiveAcl(item(), src)).toEqual({
      allowedUsers: ["u9"],
      allowedGroups: ["g9"],
    });
  });

  it("item acl wins over both source forms", () => {
    const src = localSource({
      acl: { users: ["src-user"], groups: ["src-group"] },
      allowedUsers: ["legacy"],
      allowedGroups: ["legacy"],
    });
    const it = item({ acl: { allowedUsers: ["item-user"], allowedGroups: [] } });
    expect(effectiveAcl(it, src)).toEqual({
      allowedUsers: ["item-user"],
      allowedGroups: [],
    });
  });

  it("an explicitly empty item acl does not fall through to the source", () => {
    const src = localSource({ acl: { users: ["src-user"] } });
    const it = item({ acl: { allowedUsers: [], allowedGroups: [] } });
    expect(effectiveAcl(it, src)).toBeUndefined();
  });

  it("the digest is stable and order-sensitive", () => {
    const a = aclDigest({ allowedUsers: ["u1", "u2"], allowedGroups: ["g"] });
    expect(a).toBeDefined();
    expect(aclDigest({ allowedUsers: ["u1", "u2"], allowedGroups: ["g"] })).toBe(a);
    expect(aclDigest({ allowedUsers: ["u2", "u1"], allowedGroups: ["g"] })).not.toBe(a);
    expect(aclDigest({ allowedUsers: ["u1"], allowedGroups: ["g"] })).not.toBe(a);
    expect(aclDigest(undefined)).toBeUndefined();
  });
});

describe("headers and job bodies carry the effective ACL", () => {
  it("ingest headers use the nested source acl", () => {
    const src = localSource({ acl: { users: ["u1"], groups: ["g1", "g2"] } });
    const headers = buildIngestHeaders(item(), src, cfg);
    expect(decoded(headers, "x-allowed-users")).toEqual(["u1"]);
    expect(decoded(headers, "x-allowed-groups")).toEqual(["g1", "g2"]);
  });

  it("ingest headers prefer the item acl", () => {
    const src = localSource({ acl: { users: ["src-user"], groups: ["src-group"] } });
    const it = item({ acl: { allowedUsers: ["item-user"], allowedGroups: [] } });
    const headers = buildIngestHeaders(it, src, cfg);
    expect(decoded(headers, "x-allowed-users")).toEqual(["item-user"]);
    expect(headers["x-allowed-groups"]).toBeUndefined();
  });

  it("no headers without an ACL", () => {
    const headers = buildIngestHeaders(item(), localSource(), cfg);
    expect(headers["x-allowed-users"]).toBeUndefined();
    expect(headers["x-allowed-groups"]).toBeUndefined();
  });

  it("toJobRequest mirrors the effective ACL", () => {
    const src = localSource({ acl: { users: ["u1"], groups: ["g1"] } });
    const it = item({ acl: { allowedUsers: [], allowedGroups: ["item-group"] } });
    const request = toJobRequest(it, src, cfg, "0".repeat(64));
    expect(request.allowedUsers).toBeUndefined();
    expect(request.allowedGroups).toEqual(["item-group"]);
  });
});

describe("planner reacts to the ACL digest", () => {
  const synced = (overrides: Partial<ItemState> = {}): ItemState => ({
    reference: "outpost:s1:x",
    marker: "3:deadbeef",
    sha256: "a".repeat(64),
    size: 3,
    status: "synced",
    ...overrides,
  });
  const limits = { resumableThresholdBytes: 1000, maxUploadBytes: 5000 };

  it("marker match skips when digests agree or the state digest is unknown", () => {
    expect(planItem(item(), synced({ aclDigest: "d1" }), "d1").kind).toBe("skip");
    expect(planItem(item(), synced(), "d1").kind).toBe("skip");
    expect(planItem(item(), synced(), undefined).kind).toBe("skip");
  });

  it("a differing digest forces hashing", () => {
    expect(planItem(item(), synced({ aclDigest: "d1" }), "d2").kind).toBe("hash");
    // ACL removed entirely: stored digest vs. none is a change too.
    expect(planItem(item(), synced({ aclDigest: "d1" }), undefined).kind).toBe("hash");
  });

  it("identical content uploads only on a digest mismatch", () => {
    expect(planAfterHash(item(), synced({ aclDigest: "d1" }), "a".repeat(64), limits, "d1").kind).toBe(
      "update-marker",
    );
    expect(planAfterHash(item(), synced(), "a".repeat(64), limits, "d1").kind).toBe(
      "update-marker",
    );
    const plan = planAfterHash(item(), synced({ aclDigest: "d1" }), "a".repeat(64), limits, "d2");
    expect(plan.kind).toBe("upload");
  });
});

describe("reducer stores the digest on success", () => {
  const now = (): string => "2026-01-01T00:00:00.000Z";

  it("ingested writes the digest", () => {
    const next = reduce(undefined, "r", {
      kind: "ingested",
      status: "ok",
      sha256: "a".repeat(64),
      marker: "m",
      aclDigest: "d1",
    }, now);
    expect(next?.aclDigest).toBe("d1");
  });

  it("marker-only refreshes an unknown digest without a re-upload", () => {
    const prev: ItemState = { reference: "r", marker: "old", size: 1, status: "synced" };
    const next = reduce(prev, "r", { kind: "marker-only", marker: "m", aclDigest: "d1" }, now);
    expect(next?.aclDigest).toBe("d1");
  });

  it("failures keep the stored digest", () => {
    const prev: ItemState = {
      reference: "r",
      marker: "m",
      sha256: "a".repeat(64),
      aclDigest: "d1",
      size: 1,
      status: "synced",
    };
    const next = reduce(prev, "r", { kind: "client-error", status: 403, message: "no" }, now);
    expect(next?.aclDigest).toBe("d1");
    expect(next?.status).toBe("failed");
  });
});

describe("run integration: ACL headers and re-upload", () => {
  const content = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("sends the source ACL on ingest and records the digest", async () => {
    const harness = await makeHarness({
      items: [{ quellId: "docs/a.txt", content: content("eins") }],
      source: { acl: { users: ["u1"], groups: ["g1"] } },
    });
    try {
      await harness.run();
      expect(harness.fake.ingests).toHaveLength(1);
      expect(harness.fake.ingests[0]?.allowedUsers).toEqual(["u1"]);
      expect(harness.fake.ingests[0]?.allowedGroups).toEqual(["g1"]);
      const state = harness.store.state.items["docs/a.txt"];
      expect(state?.aclDigest).toBe(
        aclDigest({ allowedUsers: ["u1"], allowedGroups: ["g1"] }),
      );
    } finally {
      await harness.close();
    }
  });

  it("item ACL wins over the source ACL end-to-end", async () => {
    const harness = await makeHarness({
      items: [
        {
          quellId: "docs/a.txt",
          content: content("eins"),
          acl: { allowedUsers: ["item-user"], allowedGroups: [] },
        },
      ],
      source: { acl: { users: ["src-user"], groups: ["src-group"] } },
    });
    try {
      await harness.run();
      expect(harness.fake.ingests).toHaveLength(1);
      expect(harness.fake.ingests[0]?.allowedUsers).toEqual(["item-user"]);
      expect(harness.fake.ingests[0]?.allowedGroups).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("a changed source ACL re-uploads unchanged content", async () => {
    const items = [{ quellId: "docs/a.txt", content: content("eins") }];
    const first = await makeHarness({
      items,
      source: { acl: { users: ["u1"], groups: ["g1"] } },
    });
    try {
      await first.run();
      expect(first.fake.ingests).toHaveLength(1);
      const dir = first.dir;
      const second = await makeHarness({
        items,
        dir,
        source: { acl: { users: ["u2"], groups: ["g1"] } },
      });
      try {
        await second.run();
        expect(second.fake.ingests).toHaveLength(1);
        expect(second.fake.ingests[0]?.allowedUsers).toEqual(["u2"]);
        const state = second.store.state.items["docs/a.txt"];
        expect(state?.aclDigest).toBe(
          aclDigest({ allowedUsers: ["u2"], allowedGroups: ["g1"] }),
        );
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("an old state without a digest does not re-upload; the digest lands with the next change", async () => {
    const items = [{ quellId: "docs/a.txt", content: content("eins") }];
    const first = await makeHarness({ items });
    try {
      await first.run();
      expect(first.fake.ingests).toHaveLength(1);
      expect(first.store.state.items["docs/a.txt"]?.aclDigest).toBeUndefined();
      const dir = first.dir;

      // Same content, ACL added afterwards: unknown digest → no re-upload.
      const second = await makeHarness({ items, dir, source: { acl: { users: ["u1"] } } });
      try {
        await second.run();
        expect(second.fake.ingests).toHaveLength(0);
        expect(second.store.state.items["docs/a.txt"]?.aclDigest).toBeUndefined();
      } finally {
        await second.close();
      }

      // A real content change uploads — and now records the digest.
      const changed = [{ quellId: "docs/a.txt", content: content("zwei") }];
      const third = await makeHarness({ items: changed, dir, source: { acl: { users: ["u1"] } } });
      try {
        await third.run();
        expect(third.fake.ingests).toHaveLength(1);
        expect(third.fake.ingests[0]?.allowedUsers).toEqual(["u1"]);
        expect(third.store.state.items["docs/a.txt"]?.aclDigest).toBe(
          aclDigest({ allowedUsers: ["u1"], allowedGroups: [] }),
        );
      } finally {
        await third.close();
      }
    } finally {
      await first.close();
    }
  });
});
