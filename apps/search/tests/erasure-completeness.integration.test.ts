// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 3 — Erasure-Vollständigkeit Search (task 4.3, Requirements 2.3/2.4):
 *
 *   Für beliebige ingestierte Dokumentmengen und Löschreferenzen liefert nach
 *   Delete KEINE Tabelle des Search-Schemas eine Zeile mit gelöschter
 *   Reference oder deren Unit-IDs.
 *
 * fast-check generates random document sets — multiple revisions per document
 * (committed / staging / aborted), units across those revisions, legacy units
 * without a revision_id, child units linked through `chunk->>'parent_ref'`,
 * staged batches, segments, revision-bound and document-bound assets, legacy
 * vs_document_assets rows, sources, group rows, mail messages, and revision
 * pointers — deletes a random subset (half the runs through
 * `deleteDocumentCascade`, half through the public `PostgresClient.delete`,
 * accented documents deleted with their NFD spelling), and asserts that EVERY
 * table of the search schema is empty for the deleted references, their
 * revisions, and their unit ids — while the documents that were NOT deleted
 * survive untouched and a repeated delete is a no-op.
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 */

import * as fc from "fast-check";
import { Pool } from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import {
	createPostgresClient,
	type PostgresClient,
} from "../src/postgres-client.js";
import { deleteDocumentCascade } from "../src/revision-store.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const VECTOR_LITERAL = `[${Array<number>(VECTOR_SIZE).fill(0.1).join(",")}]`;
const TENANT = `erasuretest-${Date.now()}`;
const logger = pino({ level: "silent" });

const scope: AccessScope = {
	principal: {
		userId: undefined,
		userGroups: [],
		scopes: [],
		source: "asserted",
	},
	userId: undefined,
	userGroups: [],
	tenantId: TENANT,
	scopes: [],
	service: true,
};

/** A unit of the collection table, relative to its document stem. */
interface GenUnit {
	/** Suffix appended to the document stem to form the unit reference. */
	refSuffix: string;
	/** true → the unit's base_ref is its own reference (child/attachment). */
	ownBase: boolean;
	revisionIndex: number | null;
	/** true → chunk->>'parent_ref' points at the document reference. */
	childOfDoc: boolean;
}

/** One generated document, relative to its stem (materialised per run). */
interface GenDoc {
	stem: string;
	accented: boolean;
	deleted: boolean;
	revisions: string[];
	units: GenUnit[];
	batchesPerRev: number;
	segmentsPerRev: number;
	assetsPerRev: number;
	docAssets: number;
	legacyAssets: number;
	sources: number;
	group: boolean;
	messages: number;
}

/** A materialised unit row, ready to INSERT. */
interface UnitRow {
	unitId: string;
	reference: string;
	baseRef: string;
	revisionId: string | null;
	parentRef: string | null;
}

/** A materialised document with concrete NFC references. */
interface DocRow {
	/** NFC spelling every row is inserted under. */
	ref: string;
	/** The spelling the delete is issued with (may be the NFD form). */
	deleteRef: string;
	deleted: boolean;
	revisions: string[];
	units: UnitRow[];
	batchesPerRev: number;
	segmentsPerRev: number;
	assetsPerRev: number;
	docAssets: number;
	legacyAssets: number;
	sources: number;
	group: boolean;
	messages: number;
}

interface GenModel {
	docs: GenDoc[];
	/** Use the raw cascade; otherwise the public delete() per reference. */
	useCascade: boolean;
}

interface ModelRow {
	docs: DocRow[];
	useCascade: boolean;
}

const docArb: fc.Arbitrary<GenDoc> = fc
	.record({
		numRevisions: fc.integer({ min: 0, max: 3 }),
		unitsPerRev: fc.integer({ min: 0, max: 2 }),
		legacyUnits: fc.integer({ min: 0, max: 2 }),
		childUnits: fc.integer({ min: 0, max: 2 }),
		batchesPerRev: fc.integer({ min: 0, max: 2 }),
		segmentsPerRev: fc.integer({ min: 0, max: 2 }),
		assetsPerRev: fc.integer({ min: 0, max: 2 }),
		docAssets: fc.integer({ min: 0, max: 2 }),
		legacyAssets: fc.integer({ min: 0, max: 2 }),
		sources: fc.integer({ min: 0, max: 2 }),
		group: fc.boolean(),
		messages: fc.integer({ min: 0, max: 2 }),
		accented: fc.boolean(),
	})
	.chain((g) =>
		fc.nat({ max: 3 }).map((deletedRoll): GenDoc => {
			const units: GenUnit[] = [];
			for (let r = 0; r < g.numRevisions; r++) {
				for (let u = 0; u < g.unitsPerRev; u++) {
					units.push({
						refSuffix: `#r${r}u${u}`,
						ownBase: false,
						revisionIndex: r,
						childOfDoc: false,
					});
				}
			}
			for (let u = 0; u < g.legacyUnits; u++) {
				// v1 rows: no revision_id, matched only through base_ref.
				units.push({
					refSuffix: `#legacy${u}`,
					ownBase: false,
					revisionIndex: null,
					childOfDoc: false,
				});
			}
			for (let c = 0; c < g.childUnits; c++) {
				// Child units (attachments): their own reference, linked to the
				// parent document only through chunk->>'parent_ref'.
				units.push({
					refSuffix: `#child${c}`,
					ownBase: true,
					revisionIndex: g.numRevisions > 0 ? 0 : null,
					childOfDoc: true,
				});
			}
			return {
				stem: "", // filled in by the model arb (needs the array index)
				accented: g.accented,
				deleted: deletedRoll > 0,
				revisions: Array.from(
					{ length: g.numRevisions },
					(_, r) => `rev-r${r}`,
				),
				units,
				batchesPerRev: g.batchesPerRev,
				segmentsPerRev: g.segmentsPerRev,
				assetsPerRev: g.assetsPerRev,
				docAssets: g.docAssets,
				legacyAssets: g.legacyAssets,
				sources: g.sources,
				group: g.group,
				messages: g.messages,
			};
		}),
	);

const modelArb: fc.Arbitrary<GenModel> = fc
	.record({
		docs: fc.array(docArb, { minLength: 2, maxLength: 4 }),
		useCascade: fc.boolean(),
	})
	.map(
		(m): GenModel => ({
			...m,
			docs: m.docs.map((d, idx) => ({
				...d,
				stem: d.accented ? `doekumentee${idx}` : `dokument${idx}`,
				// Deterministic coverage: the first document is always deleted, the
				// last always survives — the middle ones follow the generated roll.
				deleted:
					idx === 0 ? true : idx === m.docs.length - 1 ? false : d.deleted,
			})),
		}),
	);

/** Turn the relative model into concrete rows unique for this iteration. */
function materialize(model: GenModel, iteration: number): ModelRow {
	return {
		useCascade: model.useCascade,
		docs: model.docs.map((d) => {
			const stem = `${d.stem}-${iteration}`;
			const ref = `${stem}.pdf`.normalize("NFC");
			const revisions = d.revisions.map((r) => `${stem}-${r}`);
			const units: UnitRow[] = d.units.map((u, ui) => {
				const reference = `${stem}${u.refSuffix}`;
				return {
					unitId: `${stem}-u${ui}`,
					reference,
					baseRef: u.ownBase ? reference : ref,
					revisionId:
						u.revisionIndex !== null
							? (revisions[u.revisionIndex] ?? null)
							: null,
					parentRef: u.childOfDoc ? ref : null,
				};
			});
			return {
				ref,
				deleteRef: d.accented ? ref.normalize("NFD") : ref,
				deleted: d.deleted,
				revisions,
				units,
				batchesPerRev: d.batchesPerRev,
				segmentsPerRev: d.segmentsPerRev,
				assetsPerRev: d.assetsPerRev,
				docAssets: d.docAssets,
				legacyAssets: d.legacyAssets,
				sources: d.sources,
				group: d.group,
				messages: d.messages,
			};
		}),
	};
}

describeIfPg("Erasure-Vollständigkeit · Property 3 (real postgres)", () => {
	let pool: Pool;
	let pg: PostgresClient;
	let table: string;
	const collection = `erasure_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

	beforeAll(async () => {
		pool = new Pool({ connectionString: CONNECTION });
		pg = createPostgresClient({
			connectionString: CONNECTION ?? "",
			logger,
			statsFlushIntervalMs: 3_600_000,
		});
		const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
		expect(ensured.ok).toBe(true);
		table = `vc_${collection}`;
		// The legacy asset table (global migration v4); a bare test DB has not run
		// the migrations.
		await pool
			.query(`
      CREATE TABLE IF NOT EXISTS vs_document_assets (
        tenant_id TEXT NOT NULL, collection TEXT NOT NULL, asset_id TEXT NOT NULL,
        document_reference TEXT NOT NULL, figure_id TEXT NOT NULL, mime_type TEXT NOT NULL,
        data BYTEA NOT NULL, checksum TEXT,
        created TIMESTAMPTZ NOT NULL DEFAULT NOW(), modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, collection, asset_id)
      )`)
			.catch(() => {});
	}, 60_000);

	afterAll(async () => {
		try {
			await pg?.deleteCollection(collection);
		} catch {
			/* ignore */
		}
		for (const t of [
			"vs_ingest_batches",
			"vs_segments",
			"vs_assets",
			"vs_document_assets",
			"vs_identifiers",
			"vs_document_revisions",
			"vs_revisions",
			"vs_document_sources",
			"vs_mail_messages",
			"vs_document_groups",
		]) {
			await pool
				.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT])
				.catch(() => {});
		}
		await pg?.close();
		await pool.end();
	});

	async function insertModel(model: ModelRow): Promise<void> {
		for (const doc of model.docs) {
			for (const [ri, revisionId] of doc.revisions.entries()) {
				await pool.query(
					`INSERT INTO vs_revisions (tenant_id, collection, revision_id, reference, status)
           VALUES ($1,$2,$3,$4,$5)`,
					[
						TENANT,
						collection,
						revisionId,
						doc.ref,
						["committed", "staging", "aborted"][ri % 3],
					],
				);
				for (let s = 0; s < doc.segmentsPerRev; s++) {
					await pool.query(
						`INSERT INTO vs_segments (tenant_id, collection, revision_id, seq, page_start, page_end)
             VALUES ($1,$2,$3,$4,1,3)`,
						[TENANT, collection, revisionId, s],
					);
				}
				for (let b = 0; b < doc.batchesPerRev; b++) {
					await pool.query(
						`INSERT INTO vs_ingest_batches (tenant_id, collection, revision_id, seq, digest)
             VALUES ($1,$2,$3,$4,$5)`,
						[TENANT, collection, revisionId, b, "0".repeat(64)],
					);
				}
				for (let a = 0; a < doc.assetsPerRev; a++) {
					await pool.query(
						`INSERT INTO vs_assets
               (tenant_id, collection, asset_id, kind, document_reference, revision_id, mime_type, data)
             VALUES ($1,$2,$3,'figure',$4,$5,'image/png',$6)`,
						[
							TENANT,
							collection,
							`a-${revisionId}-${a}`,
							doc.ref,
							revisionId,
							Buffer.from("png"),
						],
					);
				}
			}
			if (doc.revisions.length > 0) {
				await pool.query(
					`INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id)
           VALUES ($1,$2,$3,$4)`,
					[
						TENANT,
						collection,
						doc.ref,
						doc.revisions[doc.revisions.length - 1],
					],
				);
			}
			for (const unit of doc.units) {
				await pool.query(
					`INSERT INTO "${table}" (tenant_id, reference, base_ref, content, vector, revision_id, unit_id, chunk)
           VALUES ($1,$2,$3,'inhalt',$4::vector,$5,$6,$7::jsonb)`,
					[
						TENANT,
						unit.reference,
						unit.baseRef,
						VECTOR_LITERAL,
						unit.revisionId,
						unit.unitId,
						unit.parentRef !== null
							? JSON.stringify({ parent_ref: unit.parentRef })
							: null,
					],
				);
				await pool.query(
					`INSERT INTO vs_identifiers (tenant_id, collection, value_norm, unit_id, kind)
           VALUES ($1,$2,$3,$4,'akz')`,
					[TENANT, collection, `norm-${unit.unitId}`, unit.unitId],
				);
			}
			for (let a = 0; a < doc.docAssets; a++) {
				await pool.query(
					`INSERT INTO vs_assets
             (tenant_id, collection, asset_id, kind, document_reference, mime_type, data)
           VALUES ($1,$2,$3,'page_image',$4,'image/png',$5)`,
					[
						TENANT,
						collection,
						`da-${doc.ref}-${a}`,
						doc.ref,
						Buffer.from("img"),
					],
				);
			}
			for (let a = 0; a < doc.legacyAssets; a++) {
				await pool.query(
					`INSERT INTO vs_document_assets
             (tenant_id, collection, asset_id, document_reference, figure_id, mime_type, data)
           VALUES ($1,$2,$3,$4,$5,'image/png',$6)`,
					[
						TENANT,
						collection,
						`la-${doc.ref}-${a}`,
						doc.ref,
						`fig-${a}`,
						Buffer.from("img"),
					],
				);
			}
			for (let s = 0; s < doc.sources; s++) {
				await pool.query(
					`INSERT INTO vs_document_sources
             (tenant_id, collection, source_id, reference, requested_reference, document_key, source_sha256)
           VALUES ($1,$2,$3,$4,$4,$4,$5)`,
					[
						TENANT,
						collection,
						`src-${doc.ref}-${s}`,
						doc.ref,
						`${s}${"a".repeat(63)}`,
					],
				);
			}
			if (doc.group) {
				await pool.query(
					`INSERT INTO vs_document_groups (tenant_id, collection, reference, kind, group_id)
           VALUES ($1,$2,$3,'attachment',$4)`,
					[TENANT, collection, doc.ref, `grp-${doc.ref}`],
				);
			}
			for (let m = 0; m < doc.messages; m++) {
				await pool.query(
					`INSERT INTO vs_mail_messages (tenant_id, collection, message_id, thread_id, reference)
           VALUES ($1,$2,$3,$4,$5)`,
					[
						TENANT,
						collection,
						`msg-${doc.ref}-${m}`,
						`thr-${doc.ref}`,
						doc.ref,
					],
				);
			}
		}
	}

	async function deleteModel(model: ModelRow): Promise<void> {
		const deletedDocs = model.docs.filter((d) => d.deleted);
		if (deletedDocs.length === 0) return;
		if (model.useCascade) {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await deleteDocumentCascade(client, {
					tenantId: TENANT,
					collection,
					rootRefs: deletedDocs.map((d) => d.deleteRef),
				});
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		} else {
			for (const doc of deletedDocs) {
				const res = await pg.delete({}, collection, scope, doc.deleteRef);
				if (!res.ok)
					throw new Error(`delete failed: ${JSON.stringify(res.error)}`);
			}
		}
	}

	async function countWhere(sql: string, params: unknown[]): Promise<number> {
		const res = await pool.query<{ n: number }>(sql, params);
		return res.rows[0]?.n ?? 0;
	}

	it("after delete NO table of the search schema keeps a row of the deleted references, revisions, or unit ids", async () => {
		let iteration = 0;
		await fc.assert(
			fc.asyncProperty(modelArb, async (genModel) => {
				iteration++;
				const model = materialize(genModel, iteration);
				await insertModel(model);
				await deleteModel(model);

				const deletedDocs = model.docs.filter((d) => d.deleted);
				const keptDocs = model.docs.filter((d) => !d.deleted);
				// Both NFC and NFD spellings must be gone from every table.
				const deletedRefs = [
					...new Set(
						deletedDocs.flatMap((d) => [d.ref, d.ref.normalize("NFD")]),
					),
				];
				const deletedRevisions = deletedDocs.flatMap((d) => d.revisions);
				const deletedUnits = deletedDocs.flatMap((d) =>
					d.units.map((u) => u.unitId),
				);
				const keptRefs = [
					...new Set(keptDocs.flatMap((d) => [d.ref, d.ref.normalize("NFD")])),
				];

				// ── Nothing of the deleted documents remains anywhere ──────────────
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM "${table}"
              WHERE tenant_id = $1
                AND (reference = ANY($2::text[]) OR base_ref = ANY($2::text[])
                     OR chunk->>'parent_ref' = ANY($2::text[])
                     OR revision_id = ANY($3::text[]) OR unit_id = ANY($4::text[]))`,
						[TENANT, deletedRefs, deletedRevisions, deletedUnits],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_ingest_batches
              WHERE tenant_id = $1 AND revision_id = ANY($2::text[])`,
						[TENANT, deletedRevisions],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_segments
              WHERE tenant_id = $1 AND revision_id = ANY($2::text[])`,
						[TENANT, deletedRevisions],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_identifiers
              WHERE tenant_id = $1 AND unit_id = ANY($2::text[])`,
						[TENANT, deletedUnits],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_assets
              WHERE tenant_id = $1 AND (revision_id = ANY($2::text[]) OR document_reference = ANY($3::text[]))`,
						[TENANT, deletedRevisions, deletedRefs],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_document_assets
              WHERE tenant_id = $1 AND document_reference = ANY($2::text[])`,
						[TENANT, deletedRefs],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_document_revisions
              WHERE tenant_id = $1 AND reference = ANY($2::text[])`,
						[TENANT, deletedRefs],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_revisions
              WHERE tenant_id = $1 AND (reference = ANY($2::text[]) OR revision_id = ANY($3::text[]))`,
						[TENANT, deletedRefs, deletedRevisions],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_document_sources
              WHERE tenant_id = $1 AND reference = ANY($2::text[])`,
						[TENANT, deletedRefs],
					),
				).toBe(0);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_document_groups
              WHERE tenant_id = $1 AND reference = ANY($2::text[])`,
						[TENANT, deletedRefs],
					),
				).toBe(0);
				// Mail messages keep their Message-ID as a thread placeholder, but a
				// deleted document must not remain referenced by any of them.
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_mail_messages
              WHERE tenant_id = $1 AND reference = ANY($2::text[])`,
						[TENANT, deletedRefs],
					),
				).toBe(0);

				// ── Everything of the surviving documents is untouched ─────────────
				const expectedKeptUnits = keptDocs.reduce(
					(sum, d) => sum + d.units.length,
					0,
				);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM "${table}"
              WHERE tenant_id = $1
                AND (base_ref = ANY($2::text[]) OR chunk->>'parent_ref' = ANY($2::text[]))`,
						[TENANT, keptRefs],
					),
				).toBe(expectedKeptUnits);
				const expectedKeptAssets = keptDocs.reduce(
					(sum, d) => sum + d.docAssets + d.assetsPerRev * d.revisions.length,
					0,
				);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_assets
              WHERE tenant_id = $1 AND document_reference = ANY($2::text[])`,
						[TENANT, keptRefs],
					),
				).toBe(expectedKeptAssets);
				const expectedKeptRevisions = keptDocs.reduce(
					(sum, d) => sum + d.revisions.length,
					0,
				);
				expect(
					await countWhere(
						`SELECT COUNT(*)::int AS n FROM vs_revisions
              WHERE tenant_id = $1 AND reference = ANY($2::text[])`,
						[TENANT, keptRefs],
					),
				).toBe(expectedKeptRevisions);

				// ── Idempotency: deleting again is a no-op, not an error ───────────
				const [firstDeleted] = deletedDocs;
				if (firstDeleted) {
					const again = await pg.delete(
						{},
						collection,
						scope,
						firstDeleted.deleteRef,
					);
					expect(again.ok).toBe(true);
					if (again.ok) expect(again.result.deleted).toBe(0);
				}
			}),
			{ numRuns: 20 },
		);
	}, 300_000);
});
