// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * An item with an access list is only kept when Extract reports it applied the
 * list as requested (`X-ACL-Applied: assigned`). Anything else would leave the
 * document visible tenant-wide, so the item fails and the document is removed.
 */

import { describe, expect, it } from "vitest";
import { FakeExtract } from "../fakes/fake-extract.js";
import { makeHarness } from "../fakes/run-harness.js";

const content = (text: string): Uint8Array => new TextEncoder().encode(text);
const items = [{ quellId: "docs/a.txt", content: content("eins") }];
const source = { acl: { users: [], groups: ["finance"] } };

function storedDocuments(fake: FakeExtract): number {
  let count = 0;
  for (const bucket of fake.documents.values()) count += bucket.size;
  return count;
}

describe("X-ACL-Applied enforcement", () => {
  it("keeps the item when Extract assigned the list", async () => {
    const harness = await makeHarness({ items, source });
    try {
      await harness.run();
      expect(storedDocuments(harness.fake)).toBe(1);
      expect(harness.store.state.items["docs/a.txt"]?.status).not.toBe("failed");
    } finally {
      await harness.close();
    }
  });

  it("fails the item and removes the document when Extract reports service-empty", async () => {
    const harness = await makeHarness({
      items,
      source,
      fake: new FakeExtract({ aclApplied: "service-empty" }),
    });
    try {
      await harness.run();
      const state = harness.store.state.items["docs/a.txt"];
      expect(state?.status).toBe("failed");
      expect(state?.lastError?.message).toContain("X-ACL-Applied: service-empty");
      expect(state?.lastError?.message).toContain("extract.acl.assign");
      expect(storedDocuments(harness.fake)).toBe(0);
      expect(harness.fake.requests.some((r) => r.method === "DELETE")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("fails the item when an older Extract sends no header", async () => {
    const harness = await makeHarness({
      items,
      source,
      fake: new FakeExtract({ aclApplied: null }),
    });
    try {
      await harness.run();
      const state = harness.store.state.items["docs/a.txt"];
      expect(state?.status).toBe("failed");
      expect(state?.lastError?.message).toContain("X-ACL-Applied: missing");
      expect(storedDocuments(harness.fake)).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("removes the document of an asynchronous job before failing the item", async () => {
    const harness = await makeHarness({
      items,
      source,
      fake: new FakeExtract({ ingestMode: "async", aclApplied: "intersected" }),
    });
    try {
      await harness.run();
      expect(harness.store.state.items["docs/a.txt"]?.status).toBe("failed");
      expect(storedDocuments(harness.fake)).toBe(0);
      // The job is stopped before the delete, not awaited to completion.
      expect(harness.fake.requests.some((r) => r.method === "POST" && /^\/v2\/jobs\/[^/]+\/cancel$/.test(new URL(r.url).pathname))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("retries a failed item on the next run", async () => {
    const first = await makeHarness({
      items,
      source,
      fake: new FakeExtract({ aclApplied: "service-empty" }),
    });
    try {
      await first.run();
      const second = await makeHarness({ items, source, dir: first.dir });
      try {
        await second.run();
        expect(second.fake.ingests).toHaveLength(1);
        expect(second.store.state.items["docs/a.txt"]?.status).not.toBe("failed");
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("ignores the header for an item without an access list", async () => {
    const harness = await makeHarness({
      items,
      fake: new FakeExtract({ aclApplied: "service-empty" }),
    });
    try {
      await harness.run();
      expect(storedDocuments(harness.fake)).toBe(1);
      expect(harness.store.state.items["docs/a.txt"]?.status).not.toBe("failed");
    } finally {
      await harness.close();
    }
  });
});
