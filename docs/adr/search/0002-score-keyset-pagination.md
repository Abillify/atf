# ADR-0002: Score-keyset pagination, and refusing a cursor where ranking is pool-relative

- **Status:** Accepted
- **Date:** 2026-08-02
- **Context repo:** vectorsearch

## Context

Search results are paginated two ways: an opaque keyset `cursor` (preferred) and
`limit`/`offset` (legacy). Three defects made both silently lossy. All three
produced *plausible* result sets — full-looking pages, no errors — which is why
they survived.

**Defect 1 — the cursor keyed on the wrong column.**
The cursor carried `(created, id)` and the predicate was:

```sql
created > $c OR (created = $c AND id::text > $i)
```

But every ranked query ordered by relevance first:

```sql
ORDER BY vector_similarity DESC, created ASC, id ASC   -- created is SECONDARY
```

Filtering on `created` against a relevance-ordered set excludes every document
older than the last row of the previous page — **including highly relevant ones**.
Paging a ranked search dropped top hits. The doc comment claimed the filter used
"the same order used in the final ORDER BY", which was not true.

The FTS query (`ORDER BY text_score DESC`) and the hybrid query
(`ORDER BY r.rrf_score DESC`) had **no deterministic tie-break at all**, so their
row order was not even stable between identical calls.

**Defect 2 — the candidate pool ignored `offset`.**
Two-stage modes size a first-stage pool: `min(limit * max(4, multiplier), cap)`.
With `limit=10, multiplier=4` that is 40 candidates, so `offset=50` fell entirely
outside the pool and returned an **empty page** — a silent, premature end of
results.

**Defect 3 — `created` cannot round-trip through this cursor.**
Found by the new pgvector integration suite, not by reasoning. PostgreSQL stores
`timestamptz` at microsecond precision; the value reaches the client as a
JavaScript `Date` (milliseconds) and returns as an ISO string. The boundary row
therefore satisfies `created > cursor.created` — it is genuinely later than its
own truncated timestamp — and is returned **again** on the next page. Observed
directly: every page repeated its last row. This affected the original cursor too.

## Decision

**1. The sort key is `(score DESC, id ASC)` for every ranked mode**, and the
cursor encodes exactly that key.

`id` is `BIGSERIAL`: unique, immutable and exact across the wire. It needs no
companion key, so the precision ambiguity disappears rather than being narrowed.
`created` is no longer part of the comparison. The comparison is numeric
(`id > $n::bigint`), matching `ORDER BY … id ASC` — a text comparison would order
10 before 9.

The predicate repeats the *same* score expression the `ORDER BY` uses, because a
SELECT alias is not visible in `WHERE`.

**2. Cursor format v2, with v1 still decodable.**
`v2|<score>|<created>|<id>`, base64url. A v1 cursor (`<created>|<id>`) still
decodes so pagination in flight survives a deploy; lacking a score, it falls back
to the time-only predicate and is only sound for non-ranked ordering.

**3. Refuse a cursor for hybrid (RRF) search.**
RRF scores are **pool-relative**: a document's `rrf_score` depends on which other
documents are in the candidate set, so filtering the pool by a cursor changes the
ranking of everything left in it. No tie-break fixes that. `CursorNotSupportedError`
is raised and the HTTP layer returns `400` with the reason; the MCP tool returns
an `isError` result. Offset pagination over a pool sized for `limit + offset` is
correct here and is what the builder now does.

The same refusal applies to the `base_ref` (whole-document) branch, which orders
by chunk index and has no score to page by.

**4. Size the candidate pool from `limit + offset`** (`candidatePoolSize`), with
the existing hard caps retained so a pathological offset cannot become an
unbounded scan.

**5. Verify against real pgvector.** `tests/pgvector-integration.test.ts` builds a
collection where relevance and insertion order are deliberately *anti-correlated*
— the most relevant document is the oldest — then walks every page and asserts
each document appears exactly once. Defect 3 was found by this test on its first
run.

## Consequences

**Good**

- Paging a ranked search returns each document exactly once. Verified, not argued.
- FTS and hybrid results have a stable order at all.
- A deep offset returns the next hits instead of an empty page.
- The one case that genuinely cannot be keyset-paginated says so, with an
  actionable message, instead of returning a subtly wrong page.

**Costs and limits, stated plainly**

- **`X-Cursor` + hybrid search is now a `400`.** It previously "worked" and lost
  results. Callers must use `X-Offset`, or switch to `dense`/`fts`. This is a
  breaking API change and the error text says what to do.
- **A v1 cursor is only correct for non-ranked ordering.** It is accepted for
  continuity across a deploy, not because it is sound. Clients should re-issue the
  search to obtain a v2 cursor.
- **Deep offsets cost more.** Sizing the pool from `limit + offset` means a large
  offset scans more candidates — bounded by the hard cap, but not free. Keyset
  pagination remains the recommended path for the modes that support it.
- **Reranking still disables the cursor.** Reranking reorders results after the
  SQL layer, so the emitted score is no longer the sort key. `next_cursor` is
  omitted when reranking is active — pre-existing behaviour, retained.
- **`postgres-client.ts` remains a very large file** (~3.4k lines). This change
  did not decompose it; that stays an open maintainability item.

## Alternatives considered

- **Keep `(created, id)` and truncate `created` in SQL** (`date_trunc`) so both
  sides agree. Rejected: it puts a function on a filtered column and still leaves
  two keys where one exact key suffices.
- **Carry `created` as exact microsecond text in the cursor.** Rejected: it
  requires plumbing a second representation of a value the API already exposes as
  a `Date`, to solve a problem `id` does not have.
- **Make the hybrid cursor "best effort".** Rejected — that is precisely the
  behaviour being removed. A pagination API that quietly loses results is worse
  than one that refuses.
