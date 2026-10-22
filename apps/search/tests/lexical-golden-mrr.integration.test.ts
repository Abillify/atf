// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Integration test pinning lexical MRR@10 on the SYNTHETIC golden set against
 * a REAL PostgreSQL instance (release gate for the all-terms-first ranking).
 *
 * The defect it pins: a plain OR lexical list recovers recall but lets a chunk
 * that matches a single common term outrank the page that answers the
 * question, which dragged lexical MRR@10 down to 0.70 on this corpus. The
 * ranking (buildLexicalAndTsQuery) puts chunks containing EVERY query term first; this test
 * measures both rankings on the same data and requires:
 *   - all-terms-first MRR@10 >= 0.9;
 *   - all-terms-first never below the plain-OR baseline;
 *   - for the German morphology variants, all-terms-first within 0.01 of the
 *     plain-OR baseline (de-morphology must not regress).
 *
 * Corpus: scripts/eval/golden-set/corpus/*.md (pages split on `## Seite N`),
 * questions: golden-set.v1.json, variants: de-morphology.v1.json.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { ensureRevisionTables } from "../src/revision-schema.js";
import {
  buildLexicalAndTsQuery,
  buildLexicalOrTsQuery,
} from "../src/query-builder.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;
const VECTOR_SIZE = 8;
const TENANT = `lexgold-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

const GOLDEN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/eval/golden-set",
);

interface CorpusManifestDoc {
  id: string;
  file: string;
}

interface GoldenQuestionLike {
  id: string;
  document: string;
  question: string;
  expectedPages: number[];
}

interface MorphologyVariantLike {
  id: string;
  base: string;
  question: string;
}

function serviceScope(tenantId = TENANT): AccessScope {
  return {
    principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
    userId: undefined,
    userGroups: [],
    tenantId,
    scopes: [],
    service: true,
  };
}

/** Orthogonal to the query: dense ranks these last (irrelevant for ftsOnly). */
function farVector(i: number): number[] {
  const v = new Array<number>(VECTOR_SIZE).fill(0);
  v[VECTOR_SIZE - 1] = 1;
  v[VECTOR_SIZE - 2] = 0.05 * (i + 1);
  return v;
}

const QUERY_VECTOR = (() => {
  const v = new Array<number>(VECTOR_SIZE).fill(0);
  v[0] = 1;
  return v;
})();

/** Split a corpus markdown file into pages on the `## Seite N` markers. */
function splitPages(markdown: string): Map<number, string> {
  const pages = new Map<number, string>();
  const marker = /^## Seite (\d+)\s*$/gm;
  const hits = [...markdown.matchAll(marker)];
  for (let i = 0; i < hits.length; i++) {
    const page = Number(hits[i][1]);
    const start = (hits[i].index ?? 0) + hits[i][0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index ?? markdown.length : markdown.length;
    pages.set(page, markdown.slice(start, end).trim());
  }
  return pages;
}

/** Reciprocal rank of the first hit whose reference answers the question. */
function reciprocalRank(
  references: string[],
  document: string,
  expectedPages: number[],
): number {
  const wanted = new Set(expectedPages.map((page) => `${document}::p${page}`));
  for (let i = 0; i < references.length; i++) {
    if (wanted.has(references[i])) return 1 / (i + 1);
  }
  return 0;
}

describeIfPg("lexical MRR@10 on the synthetic golden set · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `lexgold_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  const hybrid = (query: string) =>
    pg.search(
      query,
      QUERY_VECTOR,
      10,
      collection,
      serviceScope(),
      undefined,
      true, // hybrid
      false,
      0,
      4,
      undefined,
      undefined,
      undefined,
      true, // ftsOnly — the lexical ranking alone is under test
    );

  /** Plain-OR baseline (no all-terms-first), straight SQL against the table. */
  async function orBaselineReferences(query: string): Promise<string[]> {
    const res = await pool.query<{ reference: string }>(
      `SELECT reference FROM "${table}"
        WHERE tenant_id = $1
          AND ts_search @@ to_tsquery('simple', $2)
        ORDER BY ts_rank_cd(ts_search, to_tsquery('simple', $2), 32) DESC, id ASC
        LIMIT 10`,
      [TENANT, buildLexicalOrTsQuery(query)],
    );
    return res.rows.map((r) => r.reference);
  }

  /**
   * The production ranking shape (all-terms-first) with an explicit
   * `ts_rank_cd` normalisation flag, so flags 32 and 33 can be measured on the
   * same data (see the normalisation comparison below).
   */
  async function andFirstReferencesWithFlag(
    query: string,
    flag: number,
  ): Promise<string[]> {
    const res = await pool.query<{ reference: string }>(
      `SELECT reference FROM "${table}"
        WHERE tenant_id = $1
          AND ts_search @@ to_tsquery('simple', $2)
        ORDER BY (ts_search @@ to_tsquery('simple', $3)) DESC,
                 ts_rank_cd(ts_search, to_tsquery('simple', $2), $4) DESC,
                 id ASC
        LIMIT 10`,
      [TENANT, buildLexicalOrTsQuery(query), buildLexicalAndTsQuery(query), flag],
    );
    return res.rows.map((r) => r.reference);
  }

  async function andFirstReferences(query: string): Promise<string[]> {
    const res = await hybrid(query);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    return res.ok ? res.result.map((r) => r.reference) : [];
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);

    const manifest = JSON.parse(
      readFileSync(resolve(GOLDEN_DIR, "corpus/manifest.json"), "utf8"),
    ) as { documents: CorpusManifestDoc[] };
    for (const doc of manifest.documents) {
      const markdown = readFileSync(resolve(GOLDEN_DIR, "corpus", doc.file), "utf8");
      for (const [page, text] of splitPages(markdown)) {
        await pool.query(
          `INSERT INTO "${table}"
             (tenant_id, reference, base_ref, is_latest, content, vector, ts_search, metadata, unit_id, unit_type)
           VALUES ($1, $2, $3, TRUE, $4, $5::vector, to_tsvector('simple', $4), $6::jsonb, $7, 'chunk')`,
          [
            TENANT,
            `${doc.id}::p${page}`,
            doc.id,
            text,
            JSON.stringify(farVector(page)),
            JSON.stringify({ unit_id: `${doc.id}-p${page}`, unit_type: "chunk" }),
            `${doc.id}-p${page}`,
          ],
        );
      }
    }

    for (let attempt = 1; ; attempt++) {
      const client = await pool.connect();
      try {
        await ensureRevisionTables(client);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt >= 5 || (code !== "40P01" && code !== "23505")) throw err;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      } finally {
        client.release();
      }
    }
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
    await pool?.query(`DELETE FROM vs_ingest_batches WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pool?.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  it(
    "all-terms-first ranking reaches MRR@10 >= 0.9 and never trails the plain OR list",
    async () => {
      const golden = JSON.parse(
        readFileSync(resolve(GOLDEN_DIR, "golden-set.v1.json"), "utf8"),
      ) as { questions: GoldenQuestionLike[] };
      const variantSet = JSON.parse(
        readFileSync(resolve(GOLDEN_DIR, "de-morphology.v1.json"), "utf8"),
      ) as { variants: MorphologyVariantLike[] };
      const questionById = new Map(golden.questions.map((q) => [q.id, q]));
      const questions = golden.questions.filter((q) => q.expectedPages.length > 0);
      expect(questions.length).toBeGreaterThan(0);

      let sumAndFirst = 0;
      let sumOr = 0;
      for (const q of questions) {
        sumAndFirst += reciprocalRank(await andFirstReferences(q.question), q.document, q.expectedPages);
        sumOr += reciprocalRank(await orBaselineReferences(q.question), q.document, q.expectedPages);
      }
      const mrrAndFirst = sumAndFirst / questions.length;
      const mrrOrBaseline = sumOr / questions.length;

      let sumAndFirstDe = 0;
      let sumOrDe = 0;
      let deCount = 0;
      for (const variant of variantSet.variants) {
        const base = questionById.get(variant.base);
        if (!base || base.expectedPages.length === 0) continue;
        deCount++;
        sumAndFirstDe += reciprocalRank(await andFirstReferences(variant.question), base.document, base.expectedPages);
        sumOrDe += reciprocalRank(await orBaselineReferences(variant.question), base.document, base.expectedPages);
      }
      const mrrAndFirstDe = deCount > 0 ? sumAndFirstDe / deCount : 0;
      const mrrOrBaselineDe = deCount > 0 ? sumOrDe / deCount : 0;

      console.info("lexical MRR@10", {
        questions: questions.length,
        mrrAndFirst,
        mrrOrBaseline,
        deVariants: deCount,
        mrrAndFirstDe,
        mrrOrBaselineDe,
      });

      expect(mrrAndFirst).toBeGreaterThanOrEqual(0.9);
      expect(mrrAndFirst).toBeGreaterThanOrEqual(mrrOrBaseline);
      expect(mrrAndFirstDe).toBeGreaterThanOrEqual(mrrOrBaselineDe - 0.01);
    },
    120_000,
  );

  it(
    "compares ts_rank_cd normalisation 32 vs 33",
    async () => {
      const golden = JSON.parse(
        readFileSync(resolve(GOLDEN_DIR, "golden-set.v1.json"), "utf8"),
      ) as { questions: GoldenQuestionLike[] };
      const variantSet = JSON.parse(
        readFileSync(resolve(GOLDEN_DIR, "de-morphology.v1.json"), "utf8"),
      ) as { variants: MorphologyVariantLike[] };
      const questionById = new Map(golden.questions.map((q) => [q.id, q]));
      const questions = golden.questions.filter((q) => q.expectedPages.length > 0);
      expect(questions.length).toBeGreaterThan(0);

      const mrr = async (
        items: { question: string; document: string; expectedPages: number[] }[],
        flag: number,
      ): Promise<number> => {
        let sum = 0;
        for (const item of items) {
          sum += reciprocalRank(
            await andFirstReferencesWithFlag(item.question, flag),
            item.document,
            item.expectedPages,
          );
        }
        return items.length > 0 ? sum / items.length : 0;
      };

      const deItems = variantSet.variants
        .map((variant) => {
          const base = questionById.get(variant.base);
          if (!base || base.expectedPages.length === 0) return null;
          return {
            question: variant.question,
            document: base.document,
            expectedPages: base.expectedPages,
          };
        })
        .filter((item): item is { question: string; document: string; expectedPages: number[] } => item !== null);

      const golden32 = await mrr(questions, 32);
      const golden33 = await mrr(questions, 33);
      const de32 = await mrr(deItems, 32);
      const de33 = await mrr(deItems, 33);

      console.info("normalisation compare", { golden32, golden33, de32, de33 });

      for (const value of [golden32, golden33, de32, de33]) {
        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    },
    120_000,
  );
});
