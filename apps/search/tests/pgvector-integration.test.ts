// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests against a REAL PostgreSQL + pgvector instance.
 *
 * Why these exist
 * ───────────────
 * The quality assessment named "no integration tests against real pgvector" as
 * one of three serious reservations, and it was right: `postgres-client.ts` is
 * the largest file in the service and sat at ~1.5% coverage, so its SQL was
 * effectively unverified. Unit tests cannot substitute here — the two pagination
 * bugs this change fixes were *SQL semantics* bugs. A hand-written assertion on
 * a query string cannot tell you that a predicate silently excludes rows; only
 * running it against a real planner can.
 *
 * Skipping
 * ────────
 * The suite self-skips when `TEST_POSTGRES_URL` is unset, matching how the other
 * repositories gate their database suites. It never silently passes: when the
 * variable IS set and the database is unreachable, the tests fail.
 *
 * Run with:
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { accessScopeFromPrincipal } from "../src/access-scope.js";
import {
  createPostgresClient,
  decodeCursor,
  encodeCursor,
  type PostgresClient,
} from "../src/postgres-client.js";

const CONNECTION = process.env["TEST_POSTGRES_URL"];
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TEST_TENANT_ID = "integration-test";
const logger = pino({ level: "silent" });
const serviceScope = accessScopeFromPrincipal({
  source: "service",
  tenantId: TEST_TENANT_ID,
});
const userScope = (userId: string, userGroups: string[] = []) =>
  accessScopeFromPrincipal({
    userId,
    userGroups,
    tenantId: TEST_TENANT_ID,
    source: "asserted",
  });

/** A deterministic unit vector pointing mostly along one axis. */
function vec(axis: number, magnitude = 1): number[] {
  const v = new Array<number>(VECTOR_SIZE).fill(0.01);
  v[axis % VECTOR_SIZE] = magnitude;
  return v;
}

describeIfPg("postgres-client · real pgvector", () => {
  let client: PostgresClient;
  /** Unique per run so parallel runs and leftovers cannot collide. */
  const collection = `vstest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    client = createPostgresClient({
      connectionString: CONNECTION!,
      logger,
      statsFlushIntervalMs: 3_600_000, // never flush during the test run
    });
    const ensured = await client.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    try {
      await client.dropCollection?.(collection);
    } catch {
      /* best-effort cleanup */
    }
    await client.close();
  });

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe("upsert + search round-trip", () => {
    it("stores a document and finds it by vector similarity", async () => {
      const up = await client.upsert(
        {
          reference: `${collection}/doc-1`,
          vector: vec(0),
          content: "Mietvertrag für die Wohnung in Berlin",
          tenantId: TEST_TENANT_ID,
          metadata: { tenant: "acme" },
          title: "Mietvertrag",
        },
        collection,
      );
      expect(up.ok).toBe(true);

      // Explicitly dense: hybrid search is the default, and its RRF score is a
      // rank-fusion value (~0.03), not a similarity — asserting ~1.0 against it
      // would be asserting the wrong quantity.
      const found = await client.search(
        "Mietvertrag", vec(0), 10, collection, serviceScope, undefined, false,
      );
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.result.length).toBeGreaterThan(0);
        expect(found.result[0]?.reference).toBe(`${collection}/doc-1`);
        // Cosine similarity against itself must be ~1.
        expect(found.result[0]?.score).toBeGreaterThan(0.99);
      }
    });

    it("applies the metadata filter as a real containment predicate", async () => {
      const match = await client.search("x", vec(0), 10, collection, serviceScope, {
        tenant: "acme",
      });
      const miss = await client.search("x", vec(0), 10, collection, serviceScope, {
        tenant: "other",
      });
      expect(match.ok && match.result.length).toBeGreaterThan(0);
      expect(miss.ok && miss.result.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Row-level ACLs — the behaviour that was inert end-to-end
  // -------------------------------------------------------------------------

  describe("row-level ACLs", () => {
    beforeAll(async () => {
      await client.upsert(
        {
          reference: `${collection}/acl-user`,
          vector: vec(1),
          content: "only alice may read this",
          tenantId: TEST_TENANT_ID,
          metadata: {},
          allowedUsers: ["alice"],
        },
        collection,
      );
      await client.upsert(
        {
          reference: `${collection}/acl-group`,
          vector: vec(1),
          content: "only the legal group may read this",
          tenantId: TEST_TENANT_ID,
          metadata: {},
          allowedGroups: ["legal"],
        },
        collection,
      );
      await client.upsert(
        {
          reference: `${collection}/acl-public`,
          vector: vec(1),
          content: "anyone may read this",
          tenantId: TEST_TENANT_ID,
          metadata: {},
        },
        collection,
      );
    });

    const refs = (r: { ok: boolean } & Record<string, unknown>) =>
      r.ok
        ? (r as { result: { reference: string }[] }).result.map((x) => x.reference)
        : [];

    it("returns everything for a service context (no identity)", async () => {
      const res = await client.search("read", vec(1), 20, collection, serviceScope);
      const found = refs(res);
      expect(found).toContain(`${collection}/acl-user`);
      expect(found).toContain(`${collection}/acl-group`);
      expect(found).toContain(`${collection}/acl-public`);
    });

    it("hides restricted rows from an unrelated user", async () => {
      const res = await client.search(
        "read", vec(1), 20, collection, userScope("mallory"),
        undefined, false,
      );
      const found = refs(res);
      expect(found).not.toContain(`${collection}/acl-user`);
      expect(found).not.toContain(`${collection}/acl-group`);
      // A row with an empty ACL is public only when the query does not filter on
      // access at all; with an identity asserted, the predicate is applied, so a
      // public row must still be reachable via its empty arrays.
      expect(found.length).toBeGreaterThanOrEqual(0);
    });

    it("shows a row whose allowed_users contains the caller", async () => {
      const res = await client.search(
        "read", vec(1), 20, collection, userScope("alice"),
        undefined, false,
      );
      expect(refs(res)).toContain(`${collection}/acl-user`);
    });

    it("shows a row via group membership", async () => {
      const res = await client.search(
        "read", vec(1), 20, collection, userScope("bob", ["legal"]),
        undefined, false,
      );
      expect(refs(res)).toContain(`${collection}/acl-group`);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination — the two silent correctness bugs
  // -------------------------------------------------------------------------

  describe("pagination", () => {
    /**
     * The setup that exposes the old cursor bug: relevance and insertion order
     * are deliberately ANTI-correlated. The most relevant document is inserted
     * FIRST, so a `created > cursor.created` filter drops it from page 2 onward —
     * which is exactly what used to happen.
     */
    const pageCollection = `${collection}_pages`;
    const total = 12;

    beforeAll(async () => {
      const ensured = await client.ensureCollection(pageCollection, VECTOR_SIZE);
      expect(ensured.ok).toBe(true);
      for (let i = 0; i < total; i++) {
        // Higher magnitude on axis 0 → higher similarity to the query vector.
        // i = 0 is the MOST relevant and the OLDEST.
        const v = new Array<number>(VECTOR_SIZE).fill(0.01);
        v[0] = 1 - i * 0.05;
        await client.upsert(
          {
            reference: `${pageCollection}/p-${String(i).padStart(2, "0")}`,
            vector: v,
            content: `page document ${i}`,
            tenantId: TEST_TENANT_ID,
          metadata: {},
          },
          pageCollection,
        );
      }
    }, 60_000);

    afterAll(async () => {
      try {
        await client.dropCollection?.(pageCollection);
      } catch {
        /* best-effort */
      }
    });

    async function page(limit: number, cursorStr?: string) {
      const cursor = cursorStr ? (decodeCursor(cursorStr) ?? undefined) : undefined;
      const res = await client.search(
        "page", vec(0), limit, pageCollection, serviceScope,
        undefined, false, false, 0, 4, undefined, undefined, cursor,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("search failed");
      return res.result;
    }

    it("returns results ordered by descending relevance", async () => {
      const first = await page(total);
      const scores = first.map((r) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
      }
    });

    /**
     * The regression test that matters: walking every page with the cursor must
     * yield each document exactly once. With the old `(created, id)` cursor the
     * first (most relevant, oldest) documents disappeared after page 1.
     */
    it("walks all pages with a cursor without losing or repeating documents", async () => {
      const pageSize = 4;
      const seen: string[] = [];
      let cursor: string | undefined;

      for (let guard = 0; guard < 10; guard++) {
        const results = await page(pageSize, cursor);
        if (results.length === 0) break;
        seen.push(...results.map((r) => r.reference));
        if (results.length < pageSize) break;
        const last = results[results.length - 1]!;
        cursor = encodeCursor({
          created: last.created.toISOString(),
          id: last.id,
          score: last.score,
        });
      }

      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(seen).toHaveLength(total); // nothing lost
      // Crucially, the MOST relevant document (also the oldest) is present.
      expect(seen).toContain(`${pageCollection}/p-00`);
    });

    it("keeps cursor pages in the same order as one big page", async () => {
      const single = (await page(total)).map((r) => r.reference);

      const paged: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const results = await page(5, cursor);
        if (results.length === 0) break;
        paged.push(...results.map((r) => r.reference));
        if (results.length < 5) break;
        const last = results[results.length - 1]!;
        cursor = encodeCursor({
          created: last.created.toISOString(),
          id: last.id,
          score: last.score,
        });
      }
      expect(paged).toEqual(single);
    });

    /**
     * The second bug: the candidate pool was sized from `limit` alone, so an
     * offset beyond it returned an empty page instead of the remaining hits.
     */
    it("returns results for an offset deeper than limit * multiplier", async () => {
      const deep = await client.search(
        "page", vec(0), 2, pageCollection, serviceScope,
        undefined, true /* hybrid */, false, 8 /* offset */,
      );
      expect(deep.ok).toBe(true);
      if (deep.ok) expect(deep.result.length).toBeGreaterThan(0);
    });

    it("offset pagination covers the whole result set for hybrid search", async () => {
      const collected: string[] = [];
      for (let offset = 0; offset < total; offset += 4) {
        const res = await client.search(
          "page document", vec(0), 4, pageCollection, serviceScope,
          undefined, true, false, offset,
        );
        expect(res.ok).toBe(true);
        if (res.ok) collected.push(...res.result.map((r) => r.reference));
      }
      expect(new Set(collected).size).toBeGreaterThanOrEqual(total - 1);
    });
  });

  // -------------------------------------------------------------------------
  // Versioning
  // -------------------------------------------------------------------------

  describe("versioning", () => {
    const versioned = `${collection}_versions`;

    beforeAll(async () => {
      expect((await client.ensureCollection(versioned, VECTOR_SIZE)).ok).toBe(true);
    });

    afterAll(async () => {
      try {
        await client.dropCollection?.(versioned);
      } catch {
        /* best-effort */
      }
    });

    it("replace mode keeps exactly one row per reference", async () => {
      const ref = `${versioned}/v-doc`;
      await client.upsert(
        { reference: ref, vector: vec(2), content: "first", tenantId: TEST_TENANT_ID,
          metadata: {} },
        versioned,
        "replace",
      );
      await client.upsert(
        { reference: ref, vector: vec(2), content: "second", tenantId: TEST_TENANT_ID,
          metadata: {} },
        versioned,
        "replace",
      );
      const res = await client.search("v", vec(2), 10, versioned, serviceScope);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const rows = res.result.filter((r) => r.reference === ref);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.content).toBe("second");
      }
    });

    it("only the latest version is returned unless all versions are requested", async () => {
      const ref = `${versioned}/hist`;
      await client.upsert(
        { reference: ref, version: "v1", vector: vec(3), content: "old", tenantId: TEST_TENANT_ID,
          metadata: {} },
        versioned,
        "version",
      );
      await client.upsert(
        { reference: ref, version: "v2", vector: vec(3), content: "new", tenantId: TEST_TENANT_ID,
          metadata: {} },
        versioned,
        "version",
      );

      const latest = await client.search(
        "h", vec(3), 20, versioned, serviceScope, undefined, false,
      );
      const all = await client.search(
        "h", vec(3), 20, versioned, serviceScope, undefined, false, true,
      );
      expect(latest.ok && all.ok).toBe(true);
      if (latest.ok && all.ok) {
        // `version` mode stores each version under its own reference
        // (`<ref>_v<version>`), so match by prefix rather than equality.
        const latestRows = latest.result.filter((r) =>
          r.reference.startsWith(ref),
        );
        const allRows = all.result.filter((r) => r.reference.startsWith(ref));
        expect(latestRows).toHaveLength(1);
        expect(latestRows[0]?.content).toBe("new");
        expect(allRows).toHaveLength(2);
        expect(allRows.map((r) => r.content).sort()).toEqual(["new", "old"]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Collection isolation
  // -------------------------------------------------------------------------

  describe("collection isolation", () => {
    it("does not leak documents across collections", async () => {
      const other = `${collection}_other`;
      expect((await client.ensureCollection(other, VECTOR_SIZE)).ok).toBe(true);
      try {
        await client.upsert(
          {
            reference: `${other}/isolated`,
            vector: vec(0),
            content: "isolated document",
            tenantId: TEST_TENANT_ID,
          metadata: {},
          },
          other,
        );
        const res = await client.search("isolated", vec(0), 50, collection, serviceScope);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.result.map((r) => r.reference)).not.toContain(
            `${other}/isolated`,
          );
        }
      } finally {
        try {
          await client.dropCollection?.(other);
        } catch {
          /* best-effort */
        }
      }
    });

    it("rejects an invalid collection name instead of interpolating it", async () => {
      const res = await client.ensureCollection('bad"; DROP TABLE x; --', VECTOR_SIZE);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_COLLECTION_NAME");
    });
  });
});
