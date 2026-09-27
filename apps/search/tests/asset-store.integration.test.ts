// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the v2 AssetStore against a REAL PostgreSQL instance
 * (task 1.11). These verify the SQL-level semantics unit tests cannot:
 *   - PUT stores a full + derived variants bound to a revision, idempotent on
 *     the checksum (same bytes → no-op, different bytes → rewrite) (Req 5.8);
 *   - HEAD reports variant existence (Req 5.8);
 *   - GET returns the requested variant, thumb/preview generated via sharp;
 *   - a GET without the revision document's row ACL is denied (Req 14.5);
 *   - the filesystem backend round-trips the bytes (Req 14.2);
 *   - a legacy figure asset (NULL revision) still resolves for a permitted read;
 *   - PUT validates the bound revision (exists in tenant + collection, same
 *     document, not aborted) and never re-binds an asset to another revision;
 *   - v2 unit rows (no `chunk`, pointer-resolved revision) grant the read.
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites);
 * when set and unreachable, the suite fails rather than silently passing.
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import sharp from "sharp";
import { accessScopeFromPrincipal } from "../src/access-scope.js";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { createAssetStore, encodePathSegment, type AssetStore } from "../src/asset-store.js";
import { createRevisionStore, type RevisionStore } from "../src/revision-store.js";
import { collectionTableName } from "../src/collection-ddl.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = "asset-integration-test";
const logger = pino({ level: "silent" });

const serviceScope = accessScopeFromPrincipal({ source: "service", tenantId: TENANT });
const userScope = (userId: string, userGroups: string[] = []) =>
  accessScopeFromPrincipal({ userId, userGroups, tenantId: TENANT, source: "asserted" });

function vec(axis: number): number[] {
  const v = new Array<number>(VECTOR_SIZE).fill(0.01);
  v[axis % VECTOR_SIZE] = 1;
  return v;
}

async function makePng(width = 1200, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
}

describeIfPg("asset store · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  let store: AssetStore;
  let revisions: RevisionStore;
  // Real revisions the assets bind to (PUT validates the binding).
  let revAbc = "";
  let revPriv = "";
  let revFs = "";
  const collection = `astest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  // A document readable by everyone (no row ACL) and one private to alice.
  const publicRef = `${collection}/public-doc`;
  const privateRef = `${collection}/alice-doc`;

  beforeAll(async () => {
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    expect((await pg.ensureCollection(collection, VECTOR_SIZE)).ok).toBe(true);
    // A public document (no allowed users/groups → anyone in tenant may read).
    expect(
      (
        await pg.upsert(
          {
            reference: publicRef,
            vector: vec(0),
            content: "public document",
            tenantId: TENANT,
            metadata: {},
            chunk: { chunk_index: 0, chunk_total: 1, chunk_size: 1000, parent_ref: publicRef },
          },
          collection,
        )
      ).ok,
    ).toBe(true);
    // A document private to alice.
    expect(
      (
        await pg.upsert(
          {
            reference: privateRef,
            vector: vec(1),
            content: "alice only",
            tenantId: TENANT,
            metadata: {},
            allowedUsers: ["alice"],
            chunk: { chunk_index: 0, chunk_total: 1, chunk_size: 1000, parent_ref: privateRef },
          },
          collection,
        )
      ).ok,
    ).toBe(true);

    pool = new Pool({ connectionString: CONNECTION });
    store = createAssetStore(pool, { backend: "postgres" });
    await store.ensureSchema();
    revisions = createRevisionStore(pool);
    revAbc = await newRevision(publicRef);
    revPriv = await newRevision(privateRef);
    revFs = await newRevision(publicRef);
  }, 90_000);

  async function newRevision(reference: string): Promise<string> {
    const created = await revisions.createRevision({ tenantId: TENANT, collection, reference, ttlMs: 600_000 });
    if (!created.ok) throw new Error(`revision create failed: ${created.error.code}`);
    return created.result.revision.revisionId;
  }

  afterAll(async () => {
    try {
      await pool?.query(`DELETE FROM vs_assets WHERE tenant_id = $1`, [TENANT]);
      await pool?.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT]);
      await pool?.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]);
    } catch {
      /* best-effort */
    }
    try {
      await pg?.dropCollection?.(collection);
    } catch {
      /* best-effort */
    }
    await pool?.end();
    await pg?.close();
  });

  it("PUT stores full + derived variants, idempotent on the checksum", async () => {
    const png = await makePng();
    const put = await store.put(
      {
        tenantId: TENANT,
        collection,
        assetId: "fig-1",
        kind: "figure",
        documentReference: publicRef,
        revisionId: revAbc,
        figureId: "p1-f1",
        page: 1,
        bbox: [0.1, 0.1, 0.5, 0.5],
        mimeType: "image/png",
        data: png,
      },
      serviceScope,
    );
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(put.result.created).toBe(true);
    expect(put.result.variants.sort()).toEqual(["preview", "thumb"]);

    // Same bytes → idempotent no-op, no regeneration.
    const again = await store.put(
      {
        tenantId: TENANT,
        collection,
        assetId: "fig-1",
        kind: "figure",
        documentReference: publicRef,
        revisionId: revAbc,
        figureId: "p1-f1",
        page: 1,
        bbox: [0.1, 0.1, 0.5, 0.5],
        mimeType: "image/png",
        data: png,
      },
      serviceScope,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.result.created).toBe(false);
    expect(again.result.variants).toEqual([]);
    expect(again.result.checksum).toBe(put.result.checksum);

    // Different bytes → rewrite (created=false because the row already existed).
    const bigger = await makePng(1600, 900);
    const changed = await store.put(
      {
        tenantId: TENANT,
        collection,
        assetId: "fig-1",
        kind: "figure",
        documentReference: publicRef,
        revisionId: revAbc,
        figureId: "p1-f1",
        page: 1,
        bbox: null,
        mimeType: "image/png",
        data: bigger,
      },
      serviceScope,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.result.checksum).not.toBe(put.result.checksum);
  });

  it("HEAD reports variant existence", async () => {
    const head = await store.head({ tenantId: TENANT, collection }, "fig-1", "full", serviceScope);
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.result.exists).toBe(true);
    expect(head.result.mimeType).toBe("image/png");

    const missing = await store.head({ tenantId: TENANT, collection }, "nope", "full", serviceScope);
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.result.exists).toBe(false);
  });

  it("GET returns the requested variant with sharp-generated thumb/preview", async () => {
    for (const variant of ["full", "thumb", "preview"] as const) {
      const got = await store.get({ tenantId: TENANT, collection }, "fig-1", variant, serviceScope);
      expect(got.ok).toBe(true);
      if (!got.ok || !got.result) throw new Error(`missing ${variant}`);
      expect(got.result.variant).toBe(variant);
      const meta = await sharp(got.result.data).metadata();
      const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (variant === "thumb") expect(longEdge).toBeLessThanOrEqual(512);
      if (variant === "preview") expect(longEdge).toBeLessThanOrEqual(1568);
    }
  });

  it("denies a GET without the revision document's row ACL (Req 14.5)", async () => {
    // Bind an asset to the alice-private document.
    const put = await store.put(
      {
        tenantId: TENANT,
        collection,
        assetId: "fig-private",
        kind: "figure",
        documentReference: privateRef,
        revisionId: revPriv,
        figureId: "p1-f9",
        page: 1,
        bbox: null,
        mimeType: "image/png",
        data: await makePng(600, 400),
      },
      serviceScope,
    );
    expect(put.ok).toBe(true);

    // alice may read it; bob may not (returned as a null → 404 at the handler).
    const asAlice = await store.get({ tenantId: TENANT, collection }, "fig-private", "full", userScope("alice"));
    expect(asAlice.ok).toBe(true);
    if (asAlice.ok) expect(asAlice.result).not.toBeNull();

    const asBob = await store.get({ tenantId: TENANT, collection }, "fig-private", "full", userScope("bob"));
    expect(asBob.ok).toBe(true);
    if (asBob.ok) expect(asBob.result).toBeNull();
  });

  it("resolves a legacy figure asset with a NULL revision for a permitted reader", async () => {
    const put = await store.put(
      {
        tenantId: TENANT,
        collection,
        assetId: "legacy-fig",
        kind: "figure",
        documentReference: publicRef,
        revisionId: null, // legacy / unbound
        figureId: "p1-legacy",
        page: null,
        bbox: null,
        mimeType: "image/png",
        data: await makePng(500, 500),
      },
      serviceScope,
    );
    expect(put.ok).toBe(true);
    const got = await store.get({ tenantId: TENANT, collection }, "legacy-fig", "full", userScope("carol"));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.result).not.toBeNull();
  });

  it("round-trips bytes through the filesystem backend (Req 14.2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atf-assets-"));
    try {
      const fsStore = createAssetStore(pool, { backend: "filesystem", dir });
      const png = await makePng(800, 600);
      const put = await fsStore.put(
        {
          tenantId: TENANT,
          collection,
          assetId: "fs-fig",
          kind: "figure",
          documentReference: publicRef,
          revisionId: revFs,
          figureId: "p1-fs",
          page: 1,
          bbox: null,
          mimeType: "image/png",
          data: png,
        },
        serviceScope,
      );
      expect(put.ok).toBe(true);
      const got = await fsStore.get({ tenantId: TENANT, collection }, "fs-fig", "full", serviceScope);
      expect(got.ok).toBe(true);
      if (!got.ok || !got.result) throw new Error("filesystem asset not found");
      // The bytes came back off the volume, byte-for-byte.
      expect(Buffer.compare(got.result.data, png)).toBe(0);

      const head = await fsStore.head({ tenantId: TENANT, collection }, "fs-fig", "thumb", serviceScope);
      expect(head.ok).toBe(true);
      if (head.ok) expect(head.result.exists).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("PUT rejects an unknown, foreign-document or aborted revision", async () => {
    const png = await makePng(300, 200);
    const base = {
      tenantId: TENANT,
      collection,
      kind: "figure" as const,
      documentReference: publicRef,
      figureId: null,
      page: 1,
      bbox: null,
      mimeType: "image/png",
      data: png,
    };
    const unknown = await store.put({ ...base, assetId: "rev-check-1", revisionId: "no-such-revision" }, serviceScope);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.status).toBe(404);

    // A revision of ANOTHER document cannot adopt this document's asset.
    const foreign = await store.put({ ...base, assetId: "rev-check-2", revisionId: revPriv }, serviceScope);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("REVISION_DOCUMENT_MISMATCH");

    // A revision in another collection (same tenant) is not found.
    const otherCollection = await store.put(
      { ...base, collection: `${collection}_other`, assetId: "rev-check-3", revisionId: revAbc },
      serviceScope,
    );
    expect(otherCollection.ok).toBe(false);
    if (!otherCollection.ok) expect(otherCollection.error.status).toBe(404);

    const doomed = await newRevision(publicRef);
    expect((await revisions.abortRevision({ tenantId: TENANT, collection }, doomed)).ok).toBe(true);
    const aborted = await store.put({ ...base, assetId: "rev-check-4", revisionId: doomed }, serviceScope);
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.error.status).toBeGreaterThanOrEqual(404);
  });

  it("never re-binds an asset to another revision, and rejects a foreign document", async () => {
    const png = await makePng(320, 240);
    const input = {
      tenantId: TENANT,
      collection,
      assetId: "rebind-fig",
      kind: "figure" as const,
      documentReference: publicRef,
      figureId: "p2-f1",
      page: 2,
      bbox: null,
      mimeType: "image/png",
      data: png,
    };
    expect((await store.put({ ...input, revisionId: revAbc }, serviceScope)).ok).toBe(true);
    // A later revision of the same document re-uploads (even new bytes): the
    // binding stays with the live first revision.
    const second = await newRevision(publicRef);
    const again = await store.put({ ...input, revisionId: second, data: await makePng(330, 240) }, serviceScope);
    expect(again.ok).toBe(true);
    const bound = await pool.query<{ revision_id: string | null }>(
      `SELECT DISTINCT revision_id FROM vs_assets WHERE tenant_id = $1 AND collection = $2 AND asset_id = $3`,
      [TENANT, collection, "rebind-fig"],
    );
    expect(bound.rows.map((r) => r.revision_id)).toEqual([revAbc]);
    // Aborting the second revision does not take the shared asset with it.
    const abortedSecond = await revisions.abortRevision({ tenantId: TENANT, collection }, second);
    if (!abortedSecond.ok) throw new Error(`abort failed: ${JSON.stringify(abortedSecond.error)}`);
    const head = await store.head({ tenantId: TENANT, collection }, "rebind-fig", "full", serviceScope);
    expect(head.ok && head.result.exists).toBe(true);

    // The same asset id under a different document is refused.
    const hijack = await store.put(
      { ...input, documentReference: privateRef, revisionId: revPriv },
      serviceScope,
    );
    expect(hijack.ok).toBe(false);
    if (!hijack.ok) expect(hijack.error.code).toBe("ASSET_DOCUMENT_CONFLICT");
  });

  it("v2 unit rows grant the read via the document's current revision (Req 14.5)", async () => {
    const table = collectionTableName(collection);
    const v2Ref = `${collection}/v2-doc`;
    const v2Rev = await newRevision(v2Ref);
    // A v2 unit row (no `chunk`) of v2Rev, restricted to alice, still hidden
    // from search because the pointer does not name v2Rev yet.
    await pool.query(
      `INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, revision_id,
          unit_id, unit_type, document_id, page_start, page_end, allowed_users)
       VALUES ($1, $2, $3, TRUE, 'v2 unit', $4::vector, $5, $6, 'chunk', $3, 1, 1, ARRAY['alice'])`,
      [TENANT, `${v2Ref}#unit:u1`, v2Ref, JSON.stringify(vec(2)), v2Rev, `unit-${v2Rev}-1`],
    );
    const put = await store.put(
      {
        tenantId: TENANT,
        collection,
        assetId: "v2-fig",
        kind: "figure",
        documentReference: v2Ref,
        revisionId: v2Rev,
        figureId: "p1-f1",
        page: 1,
        bbox: null,
        mimeType: "image/png",
        data: await makePng(400, 300),
      },
      serviceScope,
    );
    expect(put.ok).toBe(true);
    const read = async (user: string) => {
      const got = await store.get({ tenantId: TENANT, collection }, "v2-fig", "full", userScope(user));
      expect(got.ok).toBe(true);
      return got.ok ? got.result : null;
    };
    // No pointer yet → the revision is not visible → fail closed, even for alice.
    expect(await read("alice")).toBeNull();
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id)
       VALUES ($1, $2, $3, $4)`,
      [TENANT, collection, v2Ref, v2Rev],
    );
    expect(await read("alice")).not.toBeNull();
    expect(await read("bob")).toBeNull();
    // Pointer moves to another revision without rows → fail closed again.
    await pool.query(
      `UPDATE vs_document_revisions SET current_revision_id = 'other'
        WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
      [TENANT, collection, v2Ref],
    );
    expect(await read("alice")).toBeNull();
  });

  it("filesystem path segments are collision-free and traversal-safe", () => {
    expect(encodePathSegment("a/b")).not.toBe(encodePathSegment("a_b"));
    expect(encodePathSegment("../x")).toMatch(/^[0-9a-f]+$/);
    const long = "t".repeat(500);
    expect(encodePathSegment(long)).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(encodePathSegment(long)).not.toBe(encodePathSegment(`${long}x`));
  });
});
