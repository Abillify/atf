<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Retrieval eval harness (Document Intelligence v2, T0.1)

A golden set plus an eval harness that measures Search retrieval quality on the
page and figure level. It produces the machine-comparable baseline that every
later phase of the Document Intelligence v2 plan diffs against
(`_Requirements: 18.3, 18.4_`).

## What it measures

For a set of questions with known answers, the harness runs each question
against `POST /search`, derives references from every hit, and computes:

| Metric | Definition |
| --- | --- |
| **Page Recall@k** | fraction of expected pages retrieved within the top _k_, averaged over page questions |
| **Figure Recall@k** | same, over expected figures (a hit is a figure when its evidence is an image with a `figure_id`) |
| **MRR** | reciprocal rank of the first correct hit at any granularity, averaged over questions |
| **Figure-Hit-Rate@k** | fraction of figure questions with at least one expected figure in the top _k_ |
| **Abstention precision / recall** | over the unanswerable questions (`abstain: true`): precision = share of abstentions that were on an unanswerable question, recall = share of unanswerable questions left unanswered |
| **False-answer rate** | share of unanswerable questions that still got an answer (1 − abstention recall) |
| **False-abstention rate** | share of answerable questions that got no answer (over-abstention) |

A question counts as *answered* when a top-_k_ hit exists. A ranked retriever
almost always returns something, so abstention only becomes informative with a
score gate: `--abstain-min-score <n>` counts a question as answered only when a
top-_k_ hit has a score of at least _n_. Scores are not comparable across search
modes or rerankers, so set the gate per configuration. Offline runs without
captured scores (older `--capture` files) cannot pass a gate. Abstention is
reported as „nicht gemessen" for a run without any hit.

References are derived from the Search result contract:

- document → `base_ref`
- page → `base_ref#page=<n>` for every page in `evidence.page_start..page_end`
- figure → `base_ref#figure=<figure_id>` when `evidence.modality === "image"`

The golden set annotates each question with expected pages / figures / cells, so
scoring is a plain set-membership test.

### Extraction-quality metrics (task T2.10)

Beyond retrieval, the harness also scores how faithfully the pipeline reproduces
document *content*. These are pure functions in `extraction-metrics.ts`, scored
against the golden set's ground-truth `extraction` annotations:

| Metric | Definition |
| --- | --- |
| **Table-cell accuracy** | position-aware, whitespace-/case-normalised fraction of expected cells matched at the same (row, col); a missing produced cell is a miss |
| **Label-coverage** | fraction of a figure's expected labels present (as normalised substrings) in the produced transcription — the eval flavour of the runtime `labelCoverage`, measured against ground truth |
| **BPMN node recall** | fraction of expected nodes recovered, matched by id **or** label |
| **BPMN edge recall** | fraction of expected directed edges (`from→to`) recovered |

Aggregation is **micro** (pool the counts, then divide). These metrics need the
pipeline's produced output, which does not come from `POST /search` — it comes
from Extract's emitted units. Supply it offline with `--extractions <path>`, a
JSON map of question id → `{ table?, text?, process? }`. Without it the metrics
report as pending (0, with the expected-item counts still shown), the same way
the retrieval baseline ships as a pending skeleton.

## Extraction quality: CER, Heading-F1, TEDS (`extract-quality.ts`)

The retrieval metrics above tell you whether the right page comes back. This
harness scores the extraction itself, with the measures the document-parsing
literature uses, so a change of vision model, render DPI or prompt (the largest
cost and quality levers, see `docs/OPERATIONS-TCO.md`) can be judged by a number:

| Metric | Definition |
| --- | --- |
| **CER** | character error rate of the running text: Levenshtein distance over Unicode code points (NFC, whitespace collapsed) divided by the reference length. Pooled over all pages (total edits / total characters). Lower is better; it can exceed 100 % |
| **Heading-F1** | precision, recall and F1 of the headings, matched as a multiset on the normalised text; the *with level* variant also needs the level to agree |
| **TEDS** | tree-edit-distance similarity of a table (Zhong et al., ECCV 2020): `1 - TED / max(nodes)` on the tree table → row → cell. A cell carries its `colspan`/`rowspan` and text; a text mismatch costs the normalised edit distance, a span mismatch 1. **TEDS (structure)** ignores the cell text |

```bash
# The shipped synthetic set against its sample output (a self-check of the scorer):
bun run eval:extract-quality

# Your own set against what Extract produced for it, gating a model or prompt change:
bun run eval:extract-quality -- --set internal/quality-set --produced reports/produced \
  --out reports/extract-quality --label vlm-b --max-cer 0.03 --min-heading-f1 0.9 --min-teds 0.85
```

A **quality set** is a directory with a `manifest.json` (`version`, `kind`
`synthetic` | `public` | `customer`, `cases[]`) and one `<id>.expected.json` per
case: `pages[]`, each with the running `text` (headings, paragraphs, list items,
no table cells), the `headings` (`level`, `text`) and the `tables`
(`headerRows`, `rows`; a cell is a string or the contract's
`{ text, colspan, rowspan, header }`). Every part is optional; a case scores what
it annotates. The format is validated with messages that name the file and field.

What Extract produced is a v2 record stream per case, `<produced>/<id>.ndjson`
(only the `page` records are read). Capture it from a finished job's outbox:

```sh
psql "$EXTRACT_DATABASE_URL" -At -c \
  "SELECT payload->'record' FROM extract.emit_outbox WHERE job_id = '<job>' ORDER BY page_from" \
  > reports/produced/<id>.ndjson
```

The outbox holds the enriched page records until the retention sweeper removes
the finished job (`JOB_RETENTION_DAYS`), so capture before that. A case with no
`.ndjson` counts every annotated page as missing; without `--produced` and
without a `producedDir` in the manifest the report reads *pending* instead of
printing numbers that would look like a measurement.

**Customer sets stay out of the repository.** The only set that ships is
`quality-set/synthetic` (invented German requirements, interface and operations
text; its `produced-sample/` carries deliberate defects: a wrong heading level,
a merged heading, an OCR slip, a split header cell, a missing page). It exists to
pin the scorer, not to say anything about the pipeline's quality. Keep real
documents, annotations and outputs under `internal/` or outside the tree;
`bun run verify:public` guards the public tree. The report states the set's
`kind`, so a customer report is never mistaken for the shipped one.

The metrics are pure functions in `extract-quality-metrics.ts`
(`extract-quality.test.ts`); the figure labels, BPMN graph and table-cell
accuracy of `extraction-metrics.ts` remain the measures for figures and
diagrams.

## German morphology set

`golden-set/de-morphology.v1.json` re-asks 36 answerable golden-set questions (plus the abstain variants below) with other
German word forms and keeps their expected answers:

| Phenomenon | Example (base → variant) |
| --- | --- |
| inflection | „Wo werden die Berechtigungen beschrieben?" → „Wo wird die Berechtigung beschrieben?" |
| compound | „Welche Pflichtfelder hat die Wareneingangsmaske?" → „Welches Pflichtfeld hat die Maske für den Wareneingang?" |
| derivation | „Wie wird die Chargenverwaltung gefordert?" → „Wie werden Chargen verwaltet?" |

Since fixture 1.1.0 the set also holds 7 variants of unanswerable questions
(16 % of 43), so the abstention metrics cover German word forms too.

The v1 questions appear verbatim in the corpus, so they score well even without
stemming; the variants only score well when the full-text configuration
handles German morphology. Run the same corpus under `FTS_LANGUAGE=simple`,
`german` and a compound-splitting configuration (`FTS_EXTRA_LANGUAGES`, see
docs/operations-and-retrieval.md) and compare:

```sh
bun run eval:retrieval:de -- --search-mode fts --collection golden
```

`de-morphology.test.ts` guards the set: every variant must drop at least one
content word of its base and must not occur verbatim in the corpus.

## The golden set

`golden-set/golden-set.v1.json` is the **versioned** fixture: four representative
document types (WMS requirements DOCX, a BPMN process document, a UI-mask manual,
a technical plan set) and 144 questions: 120 answerable ones carrying expected
page, figure and table-cell answers and 24 unanswerable ones (`abstain: true`,
16.7 %, subject absent from the corpus, expected outcome „no hit"), plus ground-truth `extraction` annotations (expected table
content, figure labels, BPMN nodes/edges) for the extraction-quality metrics.
The `extraction` field is optional and was added in fixture `1.1.0` (T2.10);
`1.0.0` readers ignore it. The optional `abstain` flag was added in fixture
`1.3.0`; abstain questions carry no expected page, figure or cell, are skipped by
the recall/MRR metrics and are left out of the generated corpus.

The shipped fixture is **synthetic** — it contains no confidential material and
therefore passes `bun run verify:public`. Regenerate it with:

```bash
bun run eval:fixture       # writes golden-set/golden-set.v1.json
```

Bump `VERSION` in `golden-set/build-fixture.ts` on every change to the fixture.

To evaluate against real corpora, keep your annotated fixture **out of the public
tree** (e.g. under `internal/`) and pass it with `--fixture`.

## Running the harness

```bash
# Against a live Search instance with the golden documents indexed:
bun run eval:retrieval -- \
  --collection <name> \
  --base-url http://127.0.0.1:3002 \
  --token <bearer-if-AUTHN_MODE-enabled> \
  --k 5,10 \
  --out reports/retrieval --label baseline \
  --capture reports/retrieval.baseline.responses.json \
  --extractions reports/extractions.baseline.json   # optional: score extraction metrics
```

All flags of `retrieval.ts`:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--collection <name>` | `documents` | Search collection to query |
| `--fixture <path>` | `scripts/eval/golden-set/golden-set.v1.json` | golden-set fixture (e.g. an internal, annotated one) |
| `--base-url <url>` | `$SEARCH_BASE_URL`, else `http://127.0.0.1:3002` | Search base URL (trailing `/` is stripped) |
| `--token <bearer>` | `$SEARCH_TOKEN`, else none | bearer token, needed when Search runs with `AUTHN_MODE` enabled |
| `--k <list>` | `5,10` | comma-separated positive integer cutoffs for the @k metrics |
| `--out <prefix>` | `reports/retrieval` | report path prefix (`<out>.<label>.{json,md}`) |
| `--label <name>` | `run` | run label used in the report file names |
| `--v2` | off | target `POST /v2/search` instead of v1 `POST /search` |
| `--responses <path>` | — | replay captured responses offline instead of calling Search |
| `--capture <path>` | — | write the raw per-question results of a live run |
| `--extractions <path>` | — | produced extraction output for the extraction-quality metrics |
| `--min-page-recall <0–1>` | — | release gate: exit non-zero when Page Recall at the largest `--k` is below the floor |
| `--min-figure-recall <0–1>` | — | release gate: exit non-zero when Figure Recall at the largest `--k` is below the floor |
| `--search-mode dense\|hybrid\|fts` | server default | retrieval-mode ablation: `X-Search-Mode` on v1, mapped to the `hybrid` body flag on v2 |
| `--rerank` | off | cross-encoder reranking (`X-Rerank: true` / v2 body `rerank`) |
| `--hyde` | off | HyDE query expansion (`X-Hyde: true`, v1 endpoint only) |
| `--thresholds <path>` | — | regression gate: JSON file of floors, exit non-zero when any is missed (see below) |
| `--abstain-min-score <n>` | — | abstention score gate: answered only when a top-_k_ hit scores at least _n_ (unset: any hit counts) |

`SEARCH_BASE_URL` and `SEARCH_TOKEN` are environment fallbacks: an explicit
`--base-url` / `--token` always wins. Prefer the environment variable for the
token so it does not end up in shell history.

### Targeting the v2 pipeline (`--v2`, task 3.7 / 3.10)

By default the harness runs each question against v1 `POST /search`. Add `--v2`
to run the same golden questions against `POST /v2/search` instead, which
exercises the full Phase-3 retrieval pipeline (identifier RRF, rerank-with-context,
diversification, small-to-big expansion):

```bash
bun run eval:retrieval -- \
  --collection <name> --base-url http://127.0.0.1:3002 --v2 \
  --k 5,10 --out reports/retrieval --label phase-3-after \
  --capture reports/retrieval.phase-3-after.responses.json
```

The v2 hit shape (top-level `pages`, `assets`) is normalised back to the same
reference-bearing shape the v1 path uses, so **the metrics and the report layout
are identical and directly comparable** — only the endpoint and request body
differ. The report records which endpoint a run targeted under
`parameters.endpoint` (`"v1"` | `"v2"`). A figure hit is an asset with
`relation:"hit"` and a `figure_id` (the v2 equivalent of v1's image evidence);
referenced figures do not count as the hit's own figure, matching v1. A `--v2`
`--capture` stores the already-normalised hits, so replaying it offline with
`--responses` reproduces the run without normalisation ambiguity.

The `--extractions` file is a JSON map of question id → produced extraction,
assembled from Extract's emitted units for the golden documents:

```json
{
  "q-021": { "table": [["ID", "Anforderung", "Priorität"], ["A-001", "…", "MUSS"]] },
  "q-041": { "process": { "nodes": [{ "id": "n0-start", "label": "Start" }], "edges": [] } },
  "q-071": { "text": "Eingabefeld 1 Abbrechen Übernehmen" }
}
```

Two reports are written: `<out>.<label>.json` (comparable baseline) and
`<out>.<label>.md` (readable summary). `reports/` is gitignored, so live reports
never enter the public tree.

`--capture` records the raw `results` per question. Feed it back with
`--responses` to reproduce a run deterministically and offline (used in CI and to
regenerate the committed baseline skeleton without a backend):

```bash
bun run eval:retrieval -- --collection <name> \
  --responses reports/retrieval.baseline.responses.json \
  --out scripts/eval/baseline/retrieval --label baseline
```

Optional release gates fail the process when a floor is not met:
`--min-page-recall 0.7 --min-figure-recall 0.5`.

## The eval stack (task 6.11)

`compose.eval.yaml` is the eval-only stack: Search + Extract + a **real**
TEI-CPU embedding model (`BAAI/bge-m3`, multilingual, 1024 dims) + a **real**
TEI-CPU cross-encoder reranker (`BAAI/bge-reranker-base`) + a deterministic
HyDE chat mock (`echo-mock.py`) + Postgres/pgvector. Unlike the quickstart
stack (`deploy/examples/compose.yaml`), whose constant-vector mock can only
prove plumbing, the vectors here come from a real model, so Recall/MRR/nDCG
measure retrieval quality and a regression is a real regression.

The stack moved from `BAAI/bge-small-en-v1.5` (384 dims, English-only) to
`BAAI/bge-m3` because the golden set is German. Keep
`EMBED_EXPECTED_DIMENSION` (1024) in `compose.eval.yaml` in sync with the model:
Search rejects embeddings of another dimension when it is set. It is the only
dimension setting in the stack; no other 384 is hard-coded in `apps/search/src`
or the eval scripts (checked by search, not by a live run). TEI on CPU embeds bge-m3 noticeably slower than
the small model, so expect a longer ingest and larger latencies. **Every number
under `baseline/retrieval.baseline.*` and `baseline/retrieval.ablation-*` was
measured with bge-small-en-v1.5 on fixture 1.2.0.** The first bge-m3 run on
fixture 1.3.0 (CI, 2026-10-23) is recorded in `baseline/retrieval.bge-m3.md`
(page recall@10 82.5 %, nDCG@10 0.5554), and the floors in
`baseline/thresholds.json` are recalibrated on it.

```bash
# from the repository root
docker compose -f scripts/eval/compose.eval.yaml up --build -d --wait
bun run scripts/eval/golden-set/build-corpus.ts
bun run scripts/eval/ingest-corpus.ts --collection golden \
  --base-url http://127.0.0.1:3012
bun run scripts/eval/retrieval.ts --collection golden \
  --base-url http://127.0.0.1:3012 --label baseline \
  --out scripts/eval/baseline/retrieval \
  --thresholds scripts/eval/baseline/thresholds.json
docker compose -f scripts/eval/compose.eval.yaml down --volumes
```

`golden-set/build-corpus.ts` writes the **deterministic** Markdown corpus
(gitignored — always regenerate, never edit) that matches the fixture's page
and figure annotations; `ingest-corpus.ts` indexes it through v1 `POST /ingest`
(with chunking, so page/figure evidence is produced) or, with `--v2`, through
the v2 revision API — the only path that runs the batch worker, which is what
applies the contextual embedding header (task 3.3). Collection names may only
contain letters, digits and underscores (`golden_ctx`, not `golden-ctx`).

The CI job `eval` in `.github/workflows/ci.yml` runs exactly this stack, the
baseline plus the four ablations below, gates on `thresholds.json`, and uploads
the reports as artifacts (into `reports/`, never into the tree, so the
committed baseline stays stable).

## Thresholds (`baseline/thresholds.json`)

`--thresholds <path>` reads a JSON object of floors and exits non-zero when the
run misses any of them (checked at the largest `--k`):

| Key | Type | Compared against |
| --- | --- | --- |
| `page_recall` | 0–1 | Page Recall at the largest `--k` |
| `figure_recall` | 0–1 | Figure Recall at the largest `--k` |
| `mrr` | 0–1 | MRR at the largest `--k` |
| `ndcg` | 0–1 | nDCG at the largest `--k` |
| `p50_latency_ms` | ms | p50 query latency (must not exceed) |
| `p95_latency_ms` | ms | p95 query latency (must not exceed) |

The committed floors sit just below the measured bge-m3 run
(`page_recall` 0.80, `ndcg` 0.53; `figure_recall` 0.95 and `mrr` 0.85 still
hold with margin); the latency
floors are generous because CI runs on shared CPU (a cold Search under TEI
contention can show p50 in the tens of ms while warm it is ~5 ms).

## Ablations (requirements 4.9/4.10)

Each ablation isolates one pipeline stage against the same golden corpus:

```bash
base=http://127.0.0.1:3012
bun run scripts/eval/retrieval.ts --collection golden --base-url "$base" \
  --search-mode dense --label ablation-dense --out scripts/eval/baseline/retrieval
bun run scripts/eval/retrieval.ts --collection golden --base-url "$base" \
  --rerank --label ablation-rerank --out scripts/eval/baseline/retrieval
bun run scripts/eval/retrieval.ts --collection golden --base-url "$base" \
  --hyde --label ablation-hyde --out scripts/eval/baseline/retrieval
# contextual header: ingest via the v2 revision API (batch worker applies the
# header), then query the same collection through v2
bun run scripts/eval/ingest-corpus.ts --v2 --collection golden_ctx --base-url "$base"
bun run scripts/eval/retrieval.ts --v2 --collection golden_ctx --base-url "$base" \
  --label ablation-ctx-header --out scripts/eval/baseline/retrieval
```

Measured on the local stack (TEI-CPU, warm; `baseline/retrieval.ablation-*.md`):

| Konfiguration | page@5 | page@10 | MRR@10 | nDCG@10 | fig@5 | fig-MRR | p50/p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline (v1 hybrid) | 0.900 | 1.000 | 0.906 | 0.660 | 1.000 | 0.859 | 4.8 / 7.6 |
| dense only | – | 0.475 | 0.456 | – | 0.564 | – | 4.6 / 6.7 |
| + rerank | – | 1.000 | 0.906 | – | 1.000 | – | 8.3 / 16.1 |
| + HyDE | – | 1.000 | 0.899 | – | 1.000 | – | 37.1 / 66.2 |
| contextual header (v2) | 0.992 | 1.000 | 0.993 | 0.994 | 1.000 | 0.968 | 5.6 / 7.4 |

Reading: dense-only collapses (the synthetic corpus is deliberately lexical-heavy);
hybrid recovers it fully. Rerank and HyDE leave quality ~equal on this fixture
and cost latency (HyDE dominates: ~7× p50). The contextual-header variant is
the quality winner — nearly every expected page lands in the top 5 — which is
why it is the shape the v2 pipeline keeps.

## Answer-level groundedness (mini set)

Retrieval metrics do not show whether an answer stays within the retrieved
context. `groundedness/answer-set.v1.json` holds 12 German items; each has a
retrieval context and two curated candidate answers (one grounded, one with
unsupported claims). `bun run eval:groundedness` scores them with the runtime
Groundedness checker (`checkGroundedness`, lexical, no model call):

- **Reference mode** (default) checks that the checker separates the curated
  candidates. This calibrates the gate; it is not a measurement of any LLM.
- **Answers mode** (`--answers <file>`, JSON map of item id → answer) scores
  answers a live model produced. Producing them requires a live model; no such
  numbers are recorded (`baseline/groundedness.live.md`: „nicht gemessen").

The lexical checker measures word overlap, not meaning: paraphrases score lower
and a wrong claim made from context words can pass. Treat it as a floor, not as
a faithfulness judge.

## The committed baseline

`baseline/retrieval.baseline.{json,md}` is the Ist-Stand reference, recorded
against the compose.eval.yaml stack as it was then (real **bge-small-en-v1.5**
vectors, German FTS, fixture 1.2.0) with the golden corpus ingested. It predates
the abstention metrics and the bge-m3 switch. The extraction block still ships
pending (produced values 0, „nicht gemessen") until a live Extract run over the
golden documents feeds `--extractions`. Regenerate with:

```bash
# 1) capture a live run
bun run eval:retrieval -- --collection <name> --base-url <url> \
  --out reports/retrieval --label baseline \
  --capture scripts/eval/baseline/retrieval.baseline.responses.json
# 2) freeze the committed baseline from the capture
bun run eval:retrieval -- --collection <name> \
  --responses scripts/eval/baseline/retrieval.baseline.responses.json \
  --out scripts/eval/baseline/retrieval --label baseline
```

## Tests and types

```bash
bun run eval:test          # unit tests for metrics, fixture loader, groundedness set, extraction quality
bun run eval:typecheck     # tsc --noEmit for the harness
```
