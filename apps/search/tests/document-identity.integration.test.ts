// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for document identity against a REAL PostgreSQL + pgvector:
 *
 *   - source identification: exact (sha256 / text / Message-ID) duplicates
 *     collection-wide, near-duplicates of the same document key decided by
 *     version, the canonical reference of a document key, expiring claims, and
 *     a deleted document no longer counting;
 *   - version order in the final switch: an older version arriving late is
 *     indexed but does not become the latest;
 *   - e-mail threading across independent ingests (reply before parent, thread
 *     merge, subject fallback), attachment groups, and `expand=document`
 *     reading the whole thread chronologically.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */

import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import type { DocumentVersion, EmailHeaders } from "@atf/extract-contract";
import type {
  EmbeddingBatchResponse,
  EmbeddingClient,
  EmbeddingResponse,
} from "../src/embedding-client.js";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { createRevisionStore, type RevisionStore } from "../src/revision-store.js";
import { createBatchWorker } from "../src/batch-worker.js";
import {
  DEFAULT_IDENTITY_OPTIONS,
  identifySource,
  listDocumentSources,
  resolveDocumentGroups,
  type IdentifyInput,
} from "../src/document-identity.js";
import type { AccessScope } from "../src/access-scope.js";
import { createDocumentSourceHandlers } from "../src/handlers/document-sources.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `idtest-${Date.now()}`;
const logger = pino({ level: "silent" });

const scope: AccessScope = {
  principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
  userId: undefined,
  userGroups: [],
  tenantId: TENANT,
  scopes: [],
  service: true,
};

function fakeEmbeddingClient(): EmbeddingClient {
  const vector = (): number[] =>
    new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01));
  return {
    async embed(): Promise<EmbeddingResponse> {
      return { ok: true, result: { vector: vector() } };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
      return { ok: true, result: { vectors: texts.map(() => vector()) } };
    },
  };
}

function ndjson(record: unknown): { body: Buffer; digest: string } {
  const body = Buffer.from(`${JSON.stringify(record)}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describeIfPg("document identity · real postgres", () => {
  let pool: Pool;
  let store: RevisionStore;
  let pg: PostgresClient;
  const collection = `idtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    store = createRevisionStore(pool);
    await store.ensureSchema();
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);
    // The legacy asset table (global migration v4) that delete-by-reference
    // cleans up; a bare test database has not run the migrations.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vs_document_assets (
        tenant_id TEXT NOT NULL, collection TEXT NOT NULL, asset_id TEXT NOT NULL,
        document_reference TEXT NOT NULL, figure_id TEXT NOT NULL, mime_type TEXT NOT NULL,
        data BYTEA NOT NULL, checksum TEXT,
        created TIMESTAMPTZ NOT NULL DEFAULT NOW(), modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, collection, asset_id)
      )`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    try {
      await pg?.deleteCollection(collection);
    } catch {
      /* ignore */
    }
    for (const table of [
      "vs_ingest_batches",
      "vs_segments",
      "vs_document_revisions",
      "vs_revisions",
      "vs_document_sources",
      "vs_mail_messages",
      "vs_document_groups",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    }
    await pg?.close();
    await pool.end();
  });

  function identify(input: Partial<IdentifyInput> & Pick<IdentifyInput, "sourceId" | "reference">) {
    const reference = input.reference;
    return identifySource(pool, {
      tenantId: TENANT,
      collection,
      phase: "source",
      documentKey: reference.replace(/\.[a-z]+$/, ""),
      sourceSha256: sha(input.sourceId),
      dedup: "auto",
      acl: { allowedUsers: [], allowedGroups: [] },
      ...input,
    });
  }

  async function drain(): Promise<void> {
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    const outcomes = await worker.drain();
    worker.stop();
    expect(outcomes.filter((o) => o.kind === "error" || o.kind === "deferred")).toEqual([]);
  }

  /** Stage and commit a one-page revision; returns the commit result. */
  async function ingest(args: {
    reference: string;
    text: string;
    sourceId?: string;
    version?: DocumentVersion;
    email?: EmailHeaders;
    parentReference?: string;
    acl?: { allowedUsers: string[]; allowedGroups: string[] };
  }) {
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference: args.reference,
      ttlMs: 60_000,
      ...(args.sourceId ? { sourceId: args.sourceId } : {}),
      ...(args.acl ? { acl: args.acl } : {}),
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const revisionId = created.result.revision.revisionId;
    const begin = {
      type: "document.begin",
      contract: "atf-extract/2.1.0",
      reference: args.reference,
      source: { filename: args.reference, mimeType: "application/pdf", bytes: 1, sha256: "a".repeat(64) },
      pipeline: { extractor: "test" },
      pageCount: 1,
      ...(args.version ? { version: args.version } : {}),
      ...(args.email ? { email: args.email } : {}),
      ...(args.parentReference ? { parentReference: args.parentReference } : {}),
    };
    const page = {
      type: "page",
      page: 1,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [{ type: "paragraph", id: "p1-b1", page: 1, text: args.text }],
      assets: [],
      warnings: [],
    };
    const end = { type: "document.end", reference: args.reference, pageCount: 1 };
    for (const [seq, record] of [[0, begin], [1, page], [2, end]] as const) {
      const batch = ndjson(record);
      const staged = await store.stageBatch({
        tenantId: TENANT,
        collection,
        revisionId,
        seq,
        body: batch.body,
        contentDigest: batch.digest,
        ttlMs: 60_000,
      });
      if (!staged.ok) throw new Error(`stage failed: ${staged.error.code} ${JSON.stringify(staged.error.issues)}`);
    }
    await drain();
    const committed = await store.finalCommit({ tenantId: TENANT, collection, revisionId });
    if (!committed.ok) throw new Error(`commit failed: ${committed.error.code}`);
    return { revisionId, ...committed.result };
  }

  async function searchTerm(term: string, as: AccessScope = scope) {
    const res = await pg.search(
      term,
      new Array<number>(VECTOR_SIZE).fill(0),
      50,
      collection,
      as,
      undefined,
      false,
      false,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    if (!res.ok) throw new Error(`search failed: ${res.error.code}`);
    return res.result;
  }

  describe("identify", () => {
    it("a concurrent ingest of the same file is a duplicate of the pending claim", async () => {
      const first = await identify({ sourceId: "job-a1", reference: "dup/a.pdf", sourceSha256: sha("bytes-a") });
      expect(first).toEqual({ decision: "new", canonicalReference: "dup/a.pdf" });
      const second = await identify({ sourceId: "job-a2", reference: "other/a-copy.pdf", sourceSha256: sha("bytes-a") });
      expect(second.decision).toBe("duplicate");
      expect(second.duplicateOf).toMatchObject({ reference: "dup/a.pdf", sourceId: "job-a1", match: "sha256" });
      // Replays keep the decision.
      const replay = await identify({ sourceId: "job-a2", reference: "other/a-copy.pdf", phase: "content", sourceSha256: sha("bytes-a") });
      expect(replay.decision).toBe("duplicate");
    });

    it("the same normalised text is a duplicate anywhere in the collection", async () => {
      await identify({ sourceId: "job-t1", reference: "t/one.pdf", phase: "content", textHash: sha("text-t") });
      const other = await identify({ sourceId: "job-t2", reference: "t/two.docx", phase: "content", textHash: sha("text-t") });
      expect(other.decision).toBe("duplicate");
      expect(other.duplicateOf?.match).toBe("text");
    });

    it("dedup=off registers without skipping", async () => {
      await identify({ sourceId: "job-o1", reference: "o/x.pdf", sourceSha256: sha("bytes-o") });
      const off = await identify({ sourceId: "job-o2", reference: "o/y.pdf", sourceSha256: sha("bytes-o"), dedup: "off" });
      expect(off.decision).toBe("new");
    });

    it("an expired claim no longer counts", async () => {
      await identifySource(
        pool,
        {
          tenantId: TENANT,
          collection,
          sourceId: "job-e1",
          phase: "source",
          reference: "e/x.pdf",
          documentKey: "e/x",
          sourceSha256: sha("bytes-e"),
          dedup: "auto",
          acl: { allowedUsers: [], allowedGroups: [] },
        },
        { ...DEFAULT_IDENTITY_OPTIONS, claimTtlMs: 1 },
      );
      await new Promise((r) => setTimeout(r, 20));
      const again = await identify({ sourceId: "job-e2", reference: "e/y.pdf", sourceSha256: sha("bytes-e") });
      expect(again.decision).toBe("new");
    });

    it("another format of an indexed document resolves to its reference; same version is a near-duplicate, a new version is not", async () => {
      const signature = Array.from({ length: 64 }, (_, i) => i);
      const nearly = signature.map((v, i) => (i < 2 ? v + 1000 : v)); // 62/64 ≈ 0.97
      const v1 = { label: "1.0", source: "page_label" as const };
      await identify({
        sourceId: "job-h1", reference: "hb/handbuch.pdf", phase: "content",
        minhash: signature, version: v1, textHash: sha("hb-pdf"),
      });
      const committed = await ingest({ reference: "hb/handbuch.pdf", text: "Handbuch Version eins", sourceId: "job-h1", version: v1 });
      expect(committed.isLatest).toBe(true);

      const sameVersion = await identify({
        sourceId: "job-h2", reference: "hb/handbuch.docx", phase: "content",
        minhash: nearly, version: v1, textHash: sha("hb-docx"),
      });
      expect(sameVersion.decision).toBe("duplicate");
      expect(sameVersion.canonicalReference).toBe("hb/handbuch.pdf");
      expect(sameVersion.duplicateOf).toMatchObject({ reference: "hb/handbuch.pdf", match: "similar" });

      const newer = await identify({
        sourceId: "job-h3", reference: "hb/handbuch.docx", phase: "content",
        minhash: nearly, version: { label: "1.1", source: "page_label" }, textHash: sha("hb-docx-11"),
      });
      expect(newer).toEqual({ decision: "new_version", canonicalReference: "hb/handbuch.pdf" });

      const sources = await listDocumentSources(pool, {
        tenantId: TENANT,
        collection,
        reference: "hb/handbuch.pdf",
        scope,
      });
      expect(sources.map((s) => [s.sourceId, s.status])).toEqual([
        ["job-h1", "indexed"],
        ["job-h2", "duplicate"],
        ["job-h3", "pending"],
      ]);
    });

    it("a deleted document is not a duplicate target any more", async () => {
      await identify({ sourceId: "job-d1", reference: "del/x.pdf", sourceSha256: sha("bytes-d") });
      await ingest({ reference: "del/x.pdf", text: "Loeschkandidat", sourceId: "job-d1" });
      const dup = await identify({ sourceId: "job-d2", reference: "del/x.pdf", sourceSha256: sha("bytes-d") });
      expect(dup.decision).toBe("duplicate");
      const deleted = await pg.delete({}, collection, scope, "del/x.pdf");
      expect(deleted).toMatchObject({ ok: true });
      const again = await identify({ sourceId: "job-d3", reference: "del/x.pdf", sourceSha256: sha("bytes-d") });
      expect(again).toEqual({ decision: "new", canonicalReference: "del/x.pdf" });
    });
  });

  describe("version order", () => {
    it("an older version committed later is indexed but not latest; a newer one switches", async () => {
      const v2 = await ingest({ reference: "ver/doc.pdf", text: "zweitausgabe inhalt", version: { label: "2.0", source: "page_label" } });
      expect(v2.isLatest).toBe(true);
      const v1 = await ingest({ reference: "ver/doc.pdf", text: "erstausgabe inhalt", version: { label: "1.0", source: "page_label" } });
      expect(v1.committed).toBe(true);
      expect(v1.isLatest).toBe(false);
      expect(await searchTerm("zweitausgabe")).toHaveLength(1);
      expect(await searchTerm("erstausgabe")).toHaveLength(0);

      // A replayed commit of the older revision is still a success.
      const replay = await store.finalCommit({ tenantId: TENANT, collection, revisionId: v1.revisionId });
      expect(replay.ok && replay.result.isLatest).toBe(false);

      const v3 = await ingest({ reference: "ver/doc.pdf", text: "drittausgabe inhalt", version: { label: "3.0", source: "page_label" } });
      expect(v3.isLatest).toBe(true);
      expect(await searchTerm("zweitausgabe")).toHaveLength(0);
      expect(await searchTerm("drittausgabe")).toHaveLength(1);
    });

    it("without comparable versions the last commit wins", async () => {
      await ingest({ reference: "ver/free.pdf", text: "freiversion alpha", version: { label: "2.0", source: "page_label" } });
      const later = await ingest({ reference: "ver/free.pdf", text: "freiversion beta", version: { date: "2020-01-01", source: "page_date" } });
      expect(later.isLatest).toBe(true);
    });
  });

  describe("e-mail threads", () => {
    const mail = (messageId: string, extra: Partial<EmailHeaders> = {}): EmailHeaders => ({
      messageId,
      inReplyTo: [],
      references: [],
      to: [{ address: "team@example.com" }],
      cc: [],
      attachments: [],
      from: { address: "anna@example.com" },
      ...extra,
    });

    it("threads independently ingested messages, in any order, and merges threads", async () => {
      // The reply arrives before its parent.
      await ingest({
        reference: "mail/b.eml", text: "Antwort bravo",
        email: mail("b@x", { inReplyTo: ["a@x"], references: ["a@x"], subject: "AW: Angebot", date: "2025-01-02T10:00:00Z" }),
      });
      await ingest({
        reference: "mail/a.eml", text: "Frage alpha",
        email: mail("a@x", { subject: "Angebot", date: "2025-01-01T10:00:00Z" }),
      });
      // An unrelated message starts its own thread …
      await ingest({
        reference: "mail/d.eml", text: "Separat delta",
        email: mail("d@x", { subject: "Lieferung", date: "2025-01-03T10:00:00Z" }),
      });
      let groups = await resolveDocumentGroups(pool, {
        tenantId: TENANT, collection, references: ["mail/a.eml", "mail/b.eml", "mail/d.eml"],
      });
      expect(groups.get("mail/a.eml")?.id).toBe(groups.get("mail/b.eml")?.id);
      expect(groups.get("mail/d.eml")?.id).not.toBe(groups.get("mail/a.eml")?.id);

      // … until a message references both: the threads merge.
      await ingest({
        reference: "mail/e.eml", text: "Zusammen echo",
        email: mail("e@x", { references: ["a@x", "d@x"], subject: "AW: Angebot", date: "2025-01-04T10:00:00Z" }),
      });
      groups = await resolveDocumentGroups(pool, {
        tenantId: TENANT, collection, references: ["mail/a.eml", "mail/b.eml", "mail/d.eml", "mail/e.eml"],
      });
      const ids = new Set([...groups.values()].map((g) => g.id));
      expect(ids.size).toBe(1);
      expect(groups.get("mail/a.eml")?.kind).toBe("email_thread");
    });

    it("joins a reply without threading headers by subject and participant", async () => {
      await ingest({
        reference: "mail/f.eml", text: "Nachtrag foxtrot",
        email: mail("f@x", { subject: "Re: Angebot", date: "2025-01-05T10:00:00Z" }),
      });
      const groups = await resolveDocumentGroups(pool, {
        tenantId: TENANT, collection, references: ["mail/a.eml", "mail/f.eml"],
      });
      expect(groups.get("mail/f.eml")?.id).toBe(groups.get("mail/a.eml")?.id);
    });

    it("an attachment inherits its e-mail's thread", async () => {
      await ingest({ reference: "mail/a.eml/preisliste.pdf", text: "Preisliste golf", parentReference: "mail/a.eml" });
      const groups = await resolveDocumentGroups(pool, {
        tenantId: TENANT, collection, references: ["mail/a.eml", "mail/a.eml/preisliste.pdf"],
      });
      expect(groups.get("mail/a.eml/preisliste.pdf")).toMatchObject({
        id: groups.get("mail/a.eml")?.id,
        kind: "email_thread",
      });
    });

    it("expand=document returns the whole thread chronologically", async () => {
      const res = await pg.expandUnit(collection, scope, "document", { baseRef: "mail/b.eml" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const text = res.result.map((u) => u.content).join(" | ");
      expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("bravo"));
      expect(text.indexOf("bravo")).toBeLessThan(text.indexOf("delta"));
      expect(text.indexOf("delta")).toBeLessThan(text.indexOf("echo"));
      expect(text).toContain("foxtrot");
      // Attachments are not part of the conversation text.
      expect(text).not.toContain("golf");
    });

    it("expand=document of a plain document is the document", async () => {
      const res = await pg.expandUnit(collection, scope, "document", { baseRef: "ver/doc.pdf" });
      expect(res.ok && res.result.map((u) => u.content).join(" ")).toContain("drittausgabe");
    });
  });

  describe("HTTP routes", () => {
    function app(withTenant = true) {
      const handlers = createDocumentSourceHandlers(pool, { identity: DEFAULT_IDENTITY_OPTIONS, logger });
      const a = express();
      a.use(express.json());
      a.use((_req, res, next) => {
        if (withTenant) res.locals.accessScope = scope;
        res.locals.resolvedCollection = collection;
        next();
      });
      a.post("/v2/sources/identify", handlers.identify);
      a.get("/v2/documents/:ref/sources", handlers.list);
      return a;
    }

    it("identifies over HTTP and validates the body", async () => {
      const ok = await request(app())
        .post("/v2/sources/identify")
        .send({
          sourceId: "http-1",
          phase: "source",
          reference: "http/a.pdf",
          documentKey: "http/a",
          sourceSha256: sha("http-bytes"),
        });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ decision: "new", canonicalReference: "http/a.pdf" });

      const bad = await request(app()).post("/v2/sources/identify").send({ sourceId: "x", phase: "later" });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("INVALID_IDENTIFY_REQUEST");

      const noTenant = await request(app(false)).post("/v2/sources/identify").send({});
      expect(noTenant.status).toBe(403);
    });

    it("lists a document's sources, duplicates included", async () => {
      const res = await request(app()).get(`/v2/documents/${encodeURIComponent("hb/handbuch.pdf")}/sources`);
      expect(res.status).toBe(200);
      expect(res.body.sources.map((s: { sourceId: string }) => s.sourceId)).toEqual(["job-h1", "job-h2", "job-h3"]);
      expect(res.body.sources[1]).toMatchObject({
        status: "duplicate",
        requestedReference: "hb/handbuch.docx",
        duplicateOf: { reference: "hb/handbuch.pdf", match: "similar" },
      });
    });
  });

  describe("access control", () => {
    const userScope = (userId: string, groups: string[] = []): AccessScope => ({
      principal: { userId, userGroups: groups, scopes: [], source: "asserted" },
      userId,
      userGroups: groups,
      tenantId: TENANT,
      scopes: [],
      service: false,
    });
    const anna = { allowedUsers: ["anna"], allowedGroups: [] };
    const bob = { allowedUsers: ["bob"], allowedGroups: [] };

    it("units of a revision carry its row ACL", async () => {
      await ingest({ reference: "acl/privat.pdf", text: "geheimwort kilo", acl: anna });
      expect(await searchTerm("geheimwort", userScope("anna"))).toHaveLength(1);
      expect(await searchTerm("geheimwort", userScope("bob"))).toHaveLength(0);
      expect(await searchTerm("geheimwort", userScope("carl", ["team"]))).toHaveLength(0);
      const expanded = await pg.expandUnit(collection, userScope("bob"), "document", { baseRef: "acl/privat.pdf" });
      expect(expanded.ok && expanded.result).toEqual([]);
    });

    it("a document ingested for the group finance is visible to its members only", async () => {
      // The list Outpost sets from a source ACL and Extract passes on unchanged.
      await ingest({
        reference: "acl/finanzen.pdf",
        text: "quartalszahl november",
        acl: { allowedUsers: [], allowedGroups: ["finance"] },
      });
      expect(await searchTerm("quartalszahl", userScope("carl", ["finance"]))).toHaveLength(1);
      expect(await searchTerm("quartalszahl", userScope("carl", ["team"]))).toHaveLength(0);
      expect(await searchTerm("quartalszahl", userScope("dora"))).toHaveLength(0);
    });

    it("the same file under another ACL is neither a duplicate nor a version of it", async () => {
      await identify({ sourceId: "acl-a1", reference: "acl/bericht.pdf", sourceSha256: sha("acl-bytes"), acl: anna });
      await ingest({ reference: "acl/bericht.pdf", text: "bericht lima", sourceId: "acl-a1", acl: anna });

      const other = await identify({
        sourceId: "acl-b1", reference: "acl/bericht.docx", sourceSha256: sha("acl-bytes"), acl: bob,
      });
      expect(other).toEqual({ decision: "new", canonicalReference: "acl/bericht.docx" });

      const same = await identify({
        sourceId: "acl-a2", reference: "acl/bericht.docx", sourceSha256: sha("acl-bytes"), acl: anna,
      });
      expect(same.decision).toBe("duplicate");
      expect(same.canonicalReference).toBe("acl/bericht.pdf");
    });

    it("a legacy document of another audience is not taken as the canonical reference", async () => {
      await ingest({ reference: "acl/alt.pdf", text: "altbestand mike", acl: anna });
      const res = await identify({ sourceId: "acl-b2", reference: "acl/alt.docx", acl: bob });
      expect(res.canonicalReference).toBe("acl/alt.docx");
      const own = await identify({ sourceId: "acl-a3", reference: "acl/alt.docx", acl: anna });
      expect(own.canonicalReference).toBe("acl/alt.pdf");
    });

    it("lists a document's sources only to readers of the document", async () => {
      const forAnna = await listDocumentSources(pool, {
        tenantId: TENANT, collection, reference: "acl/bericht.pdf", scope: userScope("anna"),
      });
      expect(forAnna.map((s) => s.sourceId)).toEqual(["acl-a1", "acl-a2"]);
      const forBob = await listDocumentSources(pool, {
        tenantId: TENANT, collection, reference: "acl/bericht.pdf", scope: userScope("bob"),
      });
      expect(forBob).toEqual([]);
    });
  });
});
