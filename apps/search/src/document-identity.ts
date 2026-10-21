// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * document-identity.ts
 *
 * Which document a new ingest belongs to, whether it is already indexed, and
 * which group (e-mail thread) it joins. Backs three features:
 *
 *   1. Version chains. A document is identified by its reference without file
 *      extension (`documentKeyOf`), so `handbuch.docx` becomes a new revision of
 *      an indexed `handbuch.pdf`. {@link identifySource} resolves the
 *      *canonical* reference: the reference the key was first indexed under.
 *
 *   2. Duplicates. Every ingest registers a source row (its claim) before any
 *      expensive work. {@link identifySource} compares it against the live
 *      sources of the collection:
 *        - the same file bytes (sha256) anywhere in the collection,
 *        - the same normalised text (whitespace, hyphenation, page numbers and
 *          Unicode forms folded away by Extract) anywhere in the collection,
 *        - the same Message-ID (an e-mail exported twice),
 *        - a near-identical text (MinHash) of the same document key whose
 *          version is the same, or unknown and the texts nearly identical.
 *      A duplicate is recorded as an additional source of the document it
 *      duplicates instead of being indexed again.
 *
 *   3. E-mail threads. {@link registerDocumentGroup} runs inside the final
 *      revision switch and threads an e-mail by its Message-ID, In-Reply-To,
 *      References and Outlook Thread-Index — with a subject fallback — into
 *      `vs_mail_messages`, merging threads when a message links two of them.
 *      Search groups documents by {@link resolveDocumentGroups}.
 *
 * All writes for one (tenant, collection) are serialised by a transaction-level
 * advisory lock, so two concurrent ingests of the same file cannot both be
 * "new" and two halves of a thread cannot both mint a thread id.
 */

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  compareDocumentVersions,
  documentKeyOf,
  isStrongVersionSource,
  type DocumentSource,
  type DocumentVersion,
  type DuplicateOf,
  type EmailHeaders,
  type IdentifyResponse,
  type SourceStatus,
} from "@atf/extract-contract";
import { rowAclAllows, type AccessScope, type RowAcl } from "./access-scope.js";
import {
  VS_DOCUMENT_GROUPS_TABLE,
  VS_DOCUMENT_REVISIONS_TABLE,
  VS_DOCUMENT_SOURCES_TABLE,
  VS_MAIL_MESSAGES_TABLE,
} from "./revision-schema.js";

const SOURCES = VS_DOCUMENT_SOURCES_TABLE;
const MESSAGES = VS_MAIL_MESSAGES_TABLE;
const GROUPS = VS_DOCUMENT_GROUPS_TABLE;
const POINTER = VS_DOCUMENT_REVISIONS_TABLE;

// ─── Tunables ─────────────────────────────────────────────────────────────

export interface IdentityOptions {
  /** How long a pending claim blocks a duplicate of it. Default 24 h. */
  claimTtlMs: number;
  /** MinHash similarity from which two texts of one document are "the same text". */
  nearDuplicateThreshold: number;
  /**
   * Similarity from which a near-duplicate with unknown (or only file-time)
   * versions is a duplicate rather than a new version.
   */
  duplicateSimilarity: number;
}

export const DEFAULT_IDENTITY_OPTIONS: IdentityOptions = {
  claimTtlMs: 24 * 60 * 60 * 1000,
  nearDuplicateThreshold: 0.9,
  duplicateSimilarity: 0.97,
};

// ─── Identify ─────────────────────────────────────────────────────────────

export interface IdentifyInput {
  tenantId: string;
  collection: string;
  sourceId: string;
  phase: "source" | "content";
  reference: string;
  documentKey: string;
  filename?: string | undefined;
  mimeType?: string | undefined;
  sourceSha256: string;
  textHash?: string | undefined;
  minhash?: number[] | undefined;
  /** Message-ID when the source is an e-mail. */
  messageId?: string | undefined;
  version?: DocumentVersion | undefined;
  dedup: "auto" | "exact" | "off";
  /**
   * The row ACL the document will be indexed under (`rowAclForRevision`). A
   * source only matches sources of the same ACL: a file another audience
   * already indexed is not a duplicate for this one, and a document of another
   * audience is never replaced by it.
   */
  acl: RowAcl;
}

interface SourceRowRaw {
  tenant_id: string;
  collection: string;
  source_id: string;
  reference: string;
  requested_reference: string;
  document_key: string;
  filename: string | null;
  mime_type: string | null;
  source_sha256: string;
  text_hash: string | null;
  minhash: number[] | null;
  message_id: string | null;
  allowed_users: string[];
  allowed_groups: string[];
  version: unknown;
  status: SourceStatus;
  revision_id: string | null;
  duplicate_of: unknown;
  claim_expires_at: Date | null;
  created: Date;
}

/**
 * A source counts while its document exists: an indexed source whose reference
 * still has a revision pointer, or a claim that has not expired. A deleted
 * document or an abandoned ingest must not make a re-ingest a "duplicate".
 */
const LIVE_SOURCE_SQL = `(
  (s.status = 'indexed' AND EXISTS (
     SELECT 1 FROM ${POINTER} dr
      WHERE dr.tenant_id = s.tenant_id AND dr.collection = s.collection
        AND dr.reference = s.reference))
  OR (s.status = 'pending' AND s.claim_expires_at > NOW())
)`;

/** Sources match only under the same row ACL ($5 users, $6 groups — both sorted). */
const SAME_ACL_SQL = `s.allowed_users = $5::text[] AND s.allowed_groups = $6::text[]`;

/** The ACL as the two sorted, de-duplicated array parameters SAME_ACL_SQL compares. */
function aclParams(acl: RowAcl): [string[], string[]] {
  const norm = (v: readonly string[]) => [...new Set(v)].sort();
  return [norm(acl.allowedUsers), norm(acl.allowedGroups)];
}

/** The share of equal MinHash slots: an estimate of the Jaccard similarity. */
export function minhashSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let equal = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) equal++;
  return equal / n;
}

/**
 * Decide whether a near-identical text of the same document is a duplicate or
 * a new version. Only versions read from the content or given by the caller
 * count: two exports of one document carry different file times, so a
 * `source_modified` version must not turn a duplicate into a "new version".
 */
export function nearDuplicateDecision(
  similarity: number,
  incoming: DocumentVersion | undefined,
  existing: DocumentVersion | undefined,
  options: Pick<IdentityOptions, "duplicateSimilarity">,
): "duplicate" | "new_version" {
  if (isStrongVersionSource(incoming?.source) && isStrongVersionSource(existing?.source)) {
    const order = compareDocumentVersions(incoming, existing);
    if (order !== null) return order === 0 ? "duplicate" : "new_version";
  }
  return similarity >= options.duplicateSimilarity ? "duplicate" : "new_version";
}

function asVersion(value: unknown): DocumentVersion | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === "string" && raw.label !== "" ? raw.label : undefined;
  const date = typeof raw.date === "string" && raw.date !== "" ? raw.date : undefined;
  const source = typeof raw.source === "string" ? raw.source : undefined;
  if ((label === undefined && date === undefined) || source === undefined) return undefined;
  return {
    ...(label !== undefined ? { label } : {}),
    ...(date !== undefined ? { date } : {}),
    source: source as DocumentVersion["source"],
  };
}

function asDuplicateOf(value: unknown): DuplicateOf | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.reference !== "string" || typeof raw.sourceId !== "string") return undefined;
  const match = raw.match === "sha256" || raw.match === "text" || raw.match === "similar" ? raw.match : "sha256";
  return {
    reference: raw.reference,
    sourceId: raw.sourceId,
    match,
    ...(typeof raw.filename === "string" ? { filename: raw.filename } : {}),
    ...(typeof raw.revisionId === "string" ? { revisionId: raw.revisionId } : {}),
    ...(typeof raw.similarity === "number" ? { similarity: raw.similarity } : {}),
  };
}

function duplicateOfRow(
  row: SourceRowRaw,
  match: DuplicateOf["match"],
  similarity?: number,
): DuplicateOf {
  return {
    reference: row.reference,
    sourceId: row.source_id,
    match,
    ...(row.filename !== null ? { filename: row.filename } : {}),
    ...(row.revision_id !== null ? { revisionId: row.revision_id } : {}),
    ...(similarity !== undefined ? { similarity: Math.round(similarity * 1000) / 1000 } : {}),
  };
}

/** Take the per-(tenant, collection) identity lock for the current transaction. */
async function lockIdentity(client: PoolClient, tenantId: string, collection: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `atf-document-identity:${tenantId}/${collection}`,
  ]);
}

async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Resolve the canonical reference for a document key: the reference of the
 * earliest live source with that key, else an indexed v2 document (revision
 * pointer) whose reference has the same key — which covers documents indexed
 * before sources were registered — else null.
 */
async function canonicalReferenceFor(
  client: PoolClient,
  input: Pick<IdentifyInput, "tenantId" | "collection" | "documentKey" | "sourceId" | "acl">,
): Promise<string | null> {
  const fromSources = await client.query<{ reference: string }>(
    `SELECT s.reference FROM ${SOURCES} s
      WHERE s.tenant_id = $1 AND s.collection = $2 AND s.document_key = $3
        AND s.source_id <> $4 AND s.status IN ('indexed', 'pending')
        AND ${SAME_ACL_SQL} AND ${LIVE_SOURCE_SQL}
      ORDER BY s.created ASC
      LIMIT 1`,
    [input.tenantId, input.collection, input.documentKey, input.sourceId, ...aclParams(input.acl)],
  );
  if (fromSources.rows[0]) return fromSources.rows[0].reference;

  // Legacy documents: a pointer whose reference starts with the key and strips
  // to it. The LIKE prefix narrows the scan; documentKeyOf decides.
  const escaped = input.documentKey.replace(/[\\%_]/g, (c) => `\\${c}`);
  // Only a document of the same audience (its current revision's row ACL).
  const pointers = await client.query<{ reference: string }>(
    `SELECT dr.reference FROM ${POINTER} dr
       JOIN vs_revisions r
         ON r.tenant_id = dr.tenant_id AND r.collection = dr.collection
        AND r.revision_id = dr.current_revision_id
      WHERE dr.tenant_id = $1 AND dr.collection = $2 AND dr.reference LIKE $3 ESCAPE '\\'
        AND COALESCE(r.allowed_users, '{}') = $4::text[]
        AND COALESCE(r.allowed_groups, '{}') = $5::text[]
      ORDER BY dr.modified ASC
      LIMIT 50`,
    [input.tenantId, input.collection, `${escaped}%`, ...aclParams(input.acl)],
  );
  const match = pointers.rows.find((r) => documentKeyOf(r.reference) === input.documentKey);
  return match?.reference ?? null;
}

/**
 * Register (or update) an ingest's source claim and decide whether it is new,
 * a new version of an indexed document, or a duplicate. Idempotent per
 * `sourceId`: a replay returns the same canonical reference, and a source
 * already recorded as a duplicate stays one.
 */
export async function identifySource(
  pool: Pool,
  input: IdentifyInput,
  options: IdentityOptions = DEFAULT_IDENTITY_OPTIONS,
): Promise<IdentifyResponse> {
  const client = await pool.connect();
  try {
    return await inTransaction(client, async () => {
      await lockIdentity(client, input.tenantId, input.collection);
      const { tenantId, collection, sourceId } = input;

      const ownRes = await client.query<SourceRowRaw>(
        `SELECT * FROM ${SOURCES} WHERE tenant_id = $1 AND collection = $2 AND source_id = $3`,
        [tenantId, collection, sourceId],
      );
      const own = ownRes.rows[0];
      if (own?.status === "duplicate") {
        const duplicateOf = asDuplicateOf(own.duplicate_of);
        return {
          decision: "duplicate",
          canonicalReference: own.reference,
          ...(duplicateOf ? { duplicateOf } : {}),
        };
      }

      // The canonical reference is fixed by the first identify of a source, so
      // both phases (and every resume) ingest under the same reference.
      const existing = await canonicalReferenceFor(client, input);
      const canonicalReference = own?.reference ?? existing ?? input.reference;
      const knownDocument = existing !== null;

      let duplicate: DuplicateOf | undefined;
      if (input.dedup !== "off") {
        duplicate = await findDuplicate(client, input, options);
      }

      const decision: IdentifyResponse["decision"] = duplicate
        ? "duplicate"
        : knownDocument
          ? "new_version"
          : "new";

      await client.query(
        `INSERT INTO ${SOURCES}
           (tenant_id, collection, source_id, reference, requested_reference, document_key,
            filename, mime_type, source_sha256, text_hash, minhash, message_id, version,
            status, duplicate_of, claim_expires_at, allowed_users, allowed_groups)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb,
                 NOW() + ($16::bigint * INTERVAL '1 millisecond'), $17::text[], $18::text[])
         ON CONFLICT (tenant_id, collection, source_id) DO UPDATE SET
           filename         = COALESCE(EXCLUDED.filename, ${SOURCES}.filename),
           mime_type        = COALESCE(EXCLUDED.mime_type, ${SOURCES}.mime_type),
           source_sha256    = EXCLUDED.source_sha256,
           text_hash        = COALESCE(EXCLUDED.text_hash, ${SOURCES}.text_hash),
           minhash          = COALESCE(EXCLUDED.minhash, ${SOURCES}.minhash),
           message_id       = COALESCE(EXCLUDED.message_id, ${SOURCES}.message_id),
           version          = COALESCE(EXCLUDED.version, ${SOURCES}.version),
           status           = CASE WHEN ${SOURCES}.status = 'indexed' THEN 'indexed' ELSE EXCLUDED.status END,
           duplicate_of     = EXCLUDED.duplicate_of,
           claim_expires_at = EXCLUDED.claim_expires_at,
           allowed_users    = EXCLUDED.allowed_users,
           allowed_groups   = EXCLUDED.allowed_groups,
           modified         = NOW()`,
        [
          tenantId,
          collection,
          sourceId,
          canonicalReference,
          own?.requested_reference ?? input.reference,
          input.documentKey,
          input.filename ?? null,
          input.mimeType ?? null,
          input.sourceSha256,
          input.textHash ?? null,
          input.minhash && input.minhash.length > 0 ? input.minhash : null,
          input.messageId ?? null,
          input.version ? JSON.stringify(input.version) : null,
          duplicate ? "duplicate" : "pending",
          duplicate ? JSON.stringify(duplicate) : null,
          options.claimTtlMs,
          ...aclParams(input.acl),
        ],
      );

      return {
        decision,
        canonicalReference,
        ...(duplicate ? { duplicateOf: duplicate } : {}),
      };
    });
  } finally {
    client.release();
  }
}

/**
 * The strongest duplicate match for the input among the collection's live
 * sources, or undefined. Exact matches (file, text, Message-ID) are checked
 * collection-wide; the near-duplicate check only compares sources of the same
 * document key, and only under `dedup=auto`.
 */
async function findDuplicate(
  client: PoolClient,
  input: IdentifyInput,
  options: IdentityOptions,
): Promise<DuplicateOf | undefined> {
  const { tenantId, collection, sourceId } = input;
  // An indexed source beats a pending claim as the one to point at.
  const order = `ORDER BY (s.status = 'indexed') DESC, s.created ASC LIMIT 1`;

  const bySha = await client.query<SourceRowRaw>(
    `SELECT s.* FROM ${SOURCES} s
      WHERE s.tenant_id = $1 AND s.collection = $2 AND s.source_sha256 = $3
        AND s.source_id <> $4 AND ${SAME_ACL_SQL} AND ${LIVE_SOURCE_SQL}
      ${order}`,
    [tenantId, collection, input.sourceSha256, sourceId, ...aclParams(input.acl)],
  );
  if (bySha.rows[0]) return duplicateOfRow(bySha.rows[0], "sha256");

  if (input.phase !== "content") return undefined;

  if (input.messageId) {
    const byMessage = await client.query<SourceRowRaw>(
      `SELECT s.* FROM ${SOURCES} s
        WHERE s.tenant_id = $1 AND s.collection = $2 AND s.message_id = $3
          AND s.source_id <> $4 AND ${SAME_ACL_SQL} AND ${LIVE_SOURCE_SQL}
        ${order}`,
      [tenantId, collection, input.messageId, sourceId, ...aclParams(input.acl)],
    );
    if (byMessage.rows[0]) return duplicateOfRow(byMessage.rows[0], "text");
  }

  if (input.textHash) {
    const byText = await client.query<SourceRowRaw>(
      `SELECT s.* FROM ${SOURCES} s
        WHERE s.tenant_id = $1 AND s.collection = $2 AND s.text_hash = $3
          AND s.source_id <> $4 AND ${SAME_ACL_SQL} AND ${LIVE_SOURCE_SQL}
        ${order}`,
      [tenantId, collection, input.textHash, sourceId, ...aclParams(input.acl)],
    );
    const row = byText.rows[0];
    // The same text under different explicit/detected versions is still a
    // different version (a re-issued document with only the version changed
    // keeps its text hash only if the version string was not in the text).
    if (row) {
      const rowVersion = asVersion(row.version);
      const versionOrder = compareDocumentVersions(input.version, rowVersion);
      const differs =
        isStrongVersionSource(input.version?.source) &&
        isStrongVersionSource(rowVersion?.source) &&
        versionOrder !== null &&
        versionOrder !== 0 &&
        row.document_key === input.documentKey;
      if (!differs) return duplicateOfRow(row, "text");
    }
  }

  if (input.dedup !== "auto" || !input.minhash || input.minhash.length === 0) return undefined;

  const candidates = await client.query<SourceRowRaw>(
    `SELECT s.* FROM ${SOURCES} s
      WHERE s.tenant_id = $1 AND s.collection = $2 AND s.document_key = $3
        AND s.source_id <> $4 AND s.minhash IS NOT NULL AND ${SAME_ACL_SQL} AND ${LIVE_SOURCE_SQL}
      ORDER BY s.created DESC
      LIMIT 200`,
    [tenantId, collection, input.documentKey, sourceId, ...aclParams(input.acl)],
  );
  let best: { row: SourceRowRaw; similarity: number } | undefined;
  for (const row of candidates.rows) {
    const similarity = minhashSimilarity(input.minhash, row.minhash ?? []);
    if (similarity < options.nearDuplicateThreshold) continue;
    const decision = nearDuplicateDecision(similarity, input.version, asVersion(row.version), options);
    if (decision !== "duplicate") continue;
    if (!best || similarity > best.similarity) best = { row, similarity };
  }
  return best ? duplicateOfRow(best.row, "similar", best.similarity) : undefined;
}

/**
 * Mark a source indexed by a committed revision (called inside the final
 * switch). The source's reference is set to the revision's, which it already is
 * unless the claim predates a canonical-reference change.
 */
export async function markSourceIndexed(
  client: PoolClient,
  args: { tenantId: string; collection: string; sourceId: string; reference: string; revisionId: string },
): Promise<void> {
  await client.query(
    `UPDATE ${SOURCES}
        SET status = 'indexed', revision_id = $4, reference = $5,
            claim_expires_at = NULL, modified = NOW()
      WHERE tenant_id = $1 AND collection = $2 AND source_id = $3 AND status <> 'duplicate'`,
    [args.tenantId, args.collection, args.sourceId, args.revisionId, args.reference],
  );
}

/** Every source of a document (indexed ones and skipped duplicates), oldest first. */
export async function listDocumentSources(
  pool: Pool,
  args: { tenantId: string; collection: string; reference: string; scope: AccessScope },
): Promise<DocumentSource[]> {
  const res = await pool.query<SourceRowRaw>(
    `SELECT s.* FROM ${SOURCES} s
      WHERE s.tenant_id = $1 AND s.collection = $2
        AND (s.reference = $3 OR s.duplicate_of->>'reference' = $3)
        AND s.status IN ('indexed', 'duplicate', 'pending')
      ORDER BY s.created ASC`,
    [args.tenantId, args.collection, args.reference],
  );
  // A source is listed only to whom its document is readable.
  const readable = res.rows.filter((row) =>
    rowAclAllows(args.scope, { allowedUsers: row.allowed_users, allowedGroups: row.allowed_groups }),
  );
  return readable.map((row) => {
    const version = asVersion(row.version);
    const duplicateOf = asDuplicateOf(row.duplicate_of);
    return {
      sourceId: row.source_id,
      reference: row.reference,
      requestedReference: row.requested_reference,
      ...(row.filename !== null ? { filename: row.filename } : {}),
      ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}),
      sourceSha256: row.source_sha256,
      status: row.status,
      ...(row.revision_id !== null ? { revisionId: row.revision_id } : {}),
      ...(version ? { version } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
      createdAt: row.created.toISOString(),
    };
  });
}

/**
 * Remove a deleted document's identity rows: its sources (so a re-ingest is not
 * a "duplicate" of something that no longer exists), its group membership and
 * its thread messages' reference (the Message-IDs stay as thread placeholders,
 * so the rest of the thread keeps its shape), and its revision pointer.
 */
export async function forgetDocument(
  client: PoolClient,
  args: { tenantId: string; collection: string; reference: string },
): Promise<void> {
  const params = [args.tenantId, args.collection, args.reference];
  await client.query(
    `DELETE FROM ${SOURCES} WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
    params,
  );
  await client.query(
    `DELETE FROM ${GROUPS} WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
    params,
  );
  await client.query(
    `UPDATE ${MESSAGES} SET reference = NULL
      WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
    params,
  );
  await client.query(
    `DELETE FROM ${POINTER} WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
    params,
  );
}

// ─── Document info (document.begin → vs_revisions.document_info) ─────────────

/** What the final switch needs from `document.begin`. */
export interface DocumentInfo {
  title?: string;
  version?: DocumentVersion;
  email?: EmailHeaders;
  parentReference?: string;
  /** The caller's document attributes (contract 2.2), stored on every unit. */
  tags?: string[];
  metadata?: Record<string, unknown>;
  link?: string;
  sourceLabel?: string;
  /**
   * First page of the stream when the job processed a `pages` window (contract
   * 2.4); absent = 1. The final commit checks completeness over
   * `[firstPage, pageCount]`.
   */
  firstPage?: number;
}

/** Project a `document.begin` record onto the persisted {@link DocumentInfo}. */
export function documentInfoOf(begin: {
  firstPage?: number | undefined;
  title?: string | undefined;
  version?: DocumentVersion | undefined;
  email?: EmailHeaders | undefined;
  parentReference?: string | undefined;
  tags?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  link?: string | undefined;
  sourceLabel?: string | undefined;
}): DocumentInfo | undefined {
  const info: DocumentInfo = {
    ...(begin.title ? { title: begin.title } : {}),
    ...(begin.version ? { version: begin.version } : {}),
    ...(begin.email ? { email: begin.email } : {}),
    ...(begin.parentReference ? { parentReference: begin.parentReference } : {}),
    ...(begin.tags && begin.tags.length > 0 ? { tags: begin.tags } : {}),
    ...(begin.metadata && Object.keys(begin.metadata).length > 0 ? { metadata: begin.metadata } : {}),
    ...(begin.link ? { link: begin.link } : {}),
    ...(begin.sourceLabel ? { sourceLabel: begin.sourceLabel } : {}),
    ...(begin.firstPage !== undefined && begin.firstPage > 1 ? { firstPage: begin.firstPage } : {}),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}

/** Parse the persisted `vs_revisions.document_info` defensively. */
export function parseDocumentInfo(value: unknown): DocumentInfo {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const version = asVersion(raw.version);
  const email = asEmail(raw.email);
  return {
    ...(typeof raw.title === "string" && raw.title !== "" ? { title: raw.title } : {}),
    ...(version ? { version } : {}),
    ...(email ? { email } : {}),
    ...(typeof raw.parentReference === "string" && raw.parentReference !== ""
      ? { parentReference: raw.parentReference }
      : {}),
    ...(stringArray(raw.tags).length > 0 ? { tags: stringArray(raw.tags) } : {}),
    ...(raw.metadata !== null && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
    ...(typeof raw.link === "string" && raw.link !== "" ? { link: raw.link } : {}),
    ...(typeof raw.sourceLabel === "string" && raw.sourceLabel !== "" ? { sourceLabel: raw.sourceLabel } : {}),
    ...(typeof raw.firstPage === "number" && Number.isInteger(raw.firstPage) && raw.firstPage > 1
      ? { firstPage: raw.firstPage }
      : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

function asEmail(value: unknown): EmailHeaders | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.messageId !== "string" || raw.messageId === "") return undefined;
  const mailbox = (v: unknown): { name?: string; address: string } | undefined => {
    if (v === null || typeof v !== "object") return undefined;
    const m = v as Record<string, unknown>;
    if (typeof m.address !== "string") return undefined;
    return { address: m.address, ...(typeof m.name === "string" ? { name: m.name } : {}) };
  };
  const mailboxes = (v: unknown) =>
    Array.isArray(v) ? v.map(mailbox).filter((m): m is { address: string; name?: string } => m !== undefined) : [];
  const from = mailbox(raw.from);
  return {
    messageId: raw.messageId,
    inReplyTo: stringArray(raw.inReplyTo),
    references: stringArray(raw.references),
    ...(typeof raw.threadIndexRoot === "string" ? { threadIndexRoot: raw.threadIndexRoot } : {}),
    ...(typeof raw.subject === "string" ? { subject: raw.subject } : {}),
    ...(from ? { from } : {}),
    to: mailboxes(raw.to),
    cc: mailboxes(raw.cc),
    ...(typeof raw.date === "string" ? { date: raw.date } : {}),
    attachments: stringArray(raw.attachments),
  };
}

/**
 * The version order the final switch applies: true when the incoming revision
 * is strictly OLDER than the current one, so it is indexed but must not become
 * the latest. Unknown order (no comparable version) keeps "last ingest wins".
 */
export function isOlderVersion(incoming: DocumentInfo, current: DocumentInfo): boolean {
  const order = compareDocumentVersions(incoming.version, current.version);
  return order !== null && order < 0;
}

// ─── E-mail threading ─────────────────────────────────────────────────────

/** Reply / forward prefixes in the languages a mailbox here plausibly holds. */
const SUBJECT_PREFIX = /^\s*(?:re|aw|wg|fw|fwd|sv|vs|antw|r|rif|tr|enc|res|odp|ynt|atb)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;

/** A mailing-list tag such as `[team]` in front of a subject. */
const LIST_TAG = /^\s*\[[^\]]{1,40}\]\s*/;

/** A subject without reply/forward prefixes and list tags, lower-cased. */
export function normalizeSubject(subject: string | undefined): { norm: string; isReply: boolean } {
  if (subject === undefined) return { norm: "", isReply: false };
  let s = subject.normalize("NFKC");
  let isReply = false;
  for (let i = 0; i < 10; i++) {
    const untagged = s.replace(LIST_TAG, "");
    const stripped = untagged.replace(SUBJECT_PREFIX, "");
    if (stripped !== untagged) isReply = true;
    if (stripped === s) break;
    s = stripped;
  }
  return { norm: s.replace(/\s+/g, " ").trim().toLowerCase(), isReply };
}

/** A Message-ID as stored: angle brackets and whitespace removed. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<+|>+$/g, "").trim();
}

/** The subject fallback only joins messages this close in time. */
const SUBJECT_WINDOW_DAYS = 180;

/**
 * Register a committed document's group membership. Runs inside the final
 * switch's transaction:
 *   - an e-mail is threaded (see the module header) and grouped by its thread;
 *   - an attachment (a document with a parent) records its parent and inherits
 *     the parent's group at read time, whichever of the two commits first;
 *   - a document the caller declared part of a split document (`metadata.split_of`,
 *     see {@link splitGroupId}) joins the group of the parts that share its folder
 *     and its `split_of`. The runtime never guesses this: without `split_of`
 *     there is no group.
 */
export async function registerDocumentGroup(
  client: PoolClient,
  args: { tenantId: string; collection: string; reference: string; info: DocumentInfo },
): Promise<void> {
  const { tenantId, collection, reference, info } = args;
  if (info.email) {
    await threadEmail(client, { tenantId, collection, reference, email: info.email, title: info.title });
    return;
  }
  if (info.parentReference) {
    await client.query(
      `INSERT INTO ${GROUPS} (tenant_id, collection, reference, group_id, parent_reference, kind, title)
       VALUES ($1, $2, $3, NULL, $4, 'attachment', $5)
       ON CONFLICT (tenant_id, collection, reference) DO UPDATE SET
         parent_reference = EXCLUDED.parent_reference, kind = 'attachment',
         title = EXCLUDED.title, modified = NOW()`,
      [tenantId, collection, reference, info.parentReference, info.title ?? null],
    );
    return;
  }
  const splitId = splitGroupId(reference, info.metadata);
  if (splitId !== undefined) {
    await client.query(
      `INSERT INTO ${GROUPS} (tenant_id, collection, reference, group_id, parent_reference, kind, title)
       VALUES ($1, $2, $3, $4, NULL, 'split', $5)
       ON CONFLICT (tenant_id, collection, reference) DO UPDATE SET
         group_id = EXCLUDED.group_id, parent_reference = NULL, kind = 'split',
         title = EXCLUDED.title, modified = NOW()`,
      [tenantId, collection, reference, splitId, info.title ?? null],
    );
  }
}

/** The part of a reference before its last `/` ("" for a reference without one). */
export function folderOf(reference: string): string {
  const slash = reference.lastIndexOf("/");
  return slash === -1 ? "" : reference.slice(0, slash);
}

/** The `split_of` value of a document's metadata: a non-blank string, else undefined. */
export function splitOfValue(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.split_of;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Group id of a split document's part: documents belong together when they
 * share the folder of their `base_ref` (everything before the last `/`) AND the
 * same `split_of` value. Returns undefined for a document that is not declared
 * as part of a split document — there is no automatic guessing.
 */
export function splitGroupId(
  reference: string,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const splitOf = splitOfValue(metadata);
  if (splitOf === undefined || !reference.includes("/")) return undefined;
  return `split:${createHash("sha256").update(`${folderOf(reference)}\n${splitOf}`).digest("hex").slice(0, 32)}`;
}

async function threadEmail(
  client: PoolClient,
  args: { tenantId: string; collection: string; reference: string; email: EmailHeaders; title?: string | undefined },
): Promise<void> {
  const { tenantId, collection, reference, email } = args;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `atf-mail-threads:${tenantId}/${collection}`,
  ]);

  const messageId = normalizeMessageId(email.messageId);
  const linked = new Set<string>();
  for (const id of [...email.inReplyTo, ...email.references]) {
    const norm = normalizeMessageId(id);
    if (norm !== "" && norm !== messageId) linked.add(norm);
  }
  // Outlook's conversation root: every message of one conversation shares it,
  // even when a client dropped the References chain.
  if (email.threadIndexRoot) linked.add(`thread-index:${email.threadIndexRoot}`);
  const ids = [messageId, ...linked];

  const { norm: subjectNorm, isReply } = normalizeSubject(email.subject);
  const participants = [
    email.from?.address,
    ...email.to.map((m) => m.address),
    ...email.cc.map((m) => m.address),
  ]
    .filter((a): a is string => typeof a === "string" && a !== "")
    .map((a) => a.toLowerCase());
  const sentAt = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date) : null;

  const known = await client.query<{ thread_id: string; first_seen: Date }>(
    `SELECT thread_id, MIN(created) AS first_seen FROM ${MESSAGES}
      WHERE tenant_id = $1 AND collection = $2 AND message_id = ANY($3::text[])
      GROUP BY thread_id
      ORDER BY first_seen ASC`,
    [tenantId, collection, ids],
  );
  let threads = known.rows.map((r) => r.thread_id);

  // Subject fallback: a reply without usable threading headers joins the most
  // recent thread with the same normalised subject that shares a participant.
  if (threads.length === 0 && isReply && subjectNorm !== "" && participants.length > 0) {
    const bySubject = await client.query<{ thread_id: string }>(
      `SELECT thread_id FROM ${MESSAGES}
        WHERE tenant_id = $1 AND collection = $2 AND subject_norm = $3
          AND reference IS NOT NULL AND participants && $4::text[]
          AND ($5::timestamptz IS NULL OR sent_at IS NULL
               OR sent_at BETWEEN $5::timestamptz - INTERVAL '${SUBJECT_WINDOW_DAYS} days'
                              AND $5::timestamptz + INTERVAL '${SUBJECT_WINDOW_DAYS} days')
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 1`,
      [tenantId, collection, subjectNorm, participants, sentAt],
    );
    if (bySubject.rows[0]) threads = [bySubject.rows[0].thread_id];
  }

  const threadId =
    threads[0] ?? `thread:${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;
  const merged = threads.slice(1);
  if (merged.length > 0) {
    // This message links threads that were separate so far: fold them into
    // the oldest one, messages and grouped documents alike.
    await client.query(
      `UPDATE ${MESSAGES} SET thread_id = $3
        WHERE tenant_id = $1 AND collection = $2 AND thread_id = ANY($4::text[])`,
      [tenantId, collection, threadId, merged],
    );
    await client.query(
      `UPDATE ${GROUPS} SET group_id = $3, modified = NOW()
        WHERE tenant_id = $1 AND collection = $2 AND group_id = ANY($4::text[])`,
      [tenantId, collection, threadId, merged],
    );
  }

  await client.query(
    `INSERT INTO ${MESSAGES}
       (tenant_id, collection, message_id, thread_id, reference, subject_norm, participants, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, collection, message_id) DO UPDATE SET
       thread_id = EXCLUDED.thread_id, reference = EXCLUDED.reference,
       subject_norm = EXCLUDED.subject_norm, participants = EXCLUDED.participants,
       sent_at = EXCLUDED.sent_at`,
    [tenantId, collection, messageId, threadId, reference, subjectNorm || null, participants, sentAt],
  );
  // Placeholders for the messages this one refers to: when one of them is
  // ingested later, it finds this thread by its own Message-ID.
  for (const id of linked) {
    await client.query(
      `INSERT INTO ${MESSAGES} (tenant_id, collection, message_id, thread_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, collection, message_id) DO NOTHING`,
      [tenantId, collection, id, threadId],
    );
  }

  await client.query(
    `INSERT INTO ${GROUPS} (tenant_id, collection, reference, group_id, parent_reference, kind, sort_at, title)
     VALUES ($1, $2, $3, $4, NULL, 'email', $5, $6)
     ON CONFLICT (tenant_id, collection, reference) DO UPDATE SET
       group_id = EXCLUDED.group_id, kind = 'email', sort_at = EXCLUDED.sort_at,
       title = EXCLUDED.title, modified = NOW()`,
    [tenantId, collection, reference, threadId, sentAt, email.subject ?? args.title ?? null],
  );
}

// ─── Read side ────────────────────────────────────────────────────────────

/** The group a document belongs to, as search results carry it. */
export interface DocumentGroup {
  /** Stable group id: the thread id, or the parent reference of an attachment. */
  id: string;
  kind: "email_thread" | "attachment" | "split_document";
  /** The thread subject (or the attachment's parent title). */
  title?: string;
  /** When the document was sent, for ordering a thread chronologically. */
  sort_at?: string;
}

/**
 * Resolve the groups of a set of document references (one query). References
 * without a group are absent from the map. An attachment takes its parent's
 * thread when the parent is a grouped e-mail, else it groups under the parent
 * reference.
 */
export async function resolveDocumentGroups(
  client: Pick<PoolClient, "query">,
  args: { tenantId: string; collection: string; references: string[] },
): Promise<Map<string, DocumentGroup>> {
  const out = new Map<string, DocumentGroup>();
  const refs = [...new Set(args.references.filter((r) => r !== ""))];
  if (refs.length === 0) return out;
  const res = await client.query<{
    reference: string;
    kind: string;
    group_id: string | null;
    parent_reference: string | null;
    parent_group_id: string | null;
    sort_at: Date | null;
    parent_sort_at: Date | null;
    title: string | null;
    parent_title: string | null;
  }>(
    `SELECT g.reference, g.kind, g.group_id, g.parent_reference,
            p.group_id AS parent_group_id, g.sort_at, p.sort_at AS parent_sort_at,
            g.title, p.title AS parent_title
       FROM ${GROUPS} g
       LEFT JOIN ${GROUPS} p
         ON p.tenant_id = g.tenant_id AND p.collection = g.collection
        AND p.reference = g.parent_reference
      WHERE g.tenant_id = $1 AND g.collection = $2 AND g.reference = ANY($3::text[])`,
    [args.tenantId, args.collection, refs],
  );
  for (const row of res.rows) {
    if (row.kind === "split") {
      if (!row.group_id) continue;
      out.set(row.reference, {
        id: row.group_id,
        kind: "split_document",
        ...(row.title ? { title: row.title } : {}),
      });
      continue;
    }
    const threadId = row.group_id ?? row.parent_group_id;
    const id = threadId ?? row.parent_reference;
    if (!id) continue;
    const sortAt = row.sort_at ?? row.parent_sort_at;
    const title = threadId !== null && row.kind === "attachment" ? row.parent_title : row.title ?? row.parent_title;
    out.set(row.reference, {
      id,
      kind: threadId !== null ? "email_thread" : "attachment",
      ...(title ? { title } : {}),
      ...(sortAt ? { sort_at: sortAt.toISOString() } : {}),
    });
  }
  return out;
}

/**
 * The document references of a group in reading order: the thread's e-mails
 * chronologically. Attachments are not expanded into a thread (a 300-page PDF
 * is not "the conversation"); the e-mail text lists them by name.
 */
export async function groupMemberReferences(
  client: Pick<PoolClient, "query">,
  args: { tenantId: string; collection: string; groupId: string },
): Promise<string[]> {
  const res = await client.query<{ reference: string }>(
    `SELECT reference FROM ${GROUPS}
      WHERE tenant_id = $1 AND collection = $2 AND group_id = $3 AND kind = 'email'
      ORDER BY sort_at ASC NULLS LAST, reference ASC`,
    [args.tenantId, args.collection, args.groupId],
  );
  return res.rows.map((r) => r.reference);
}
