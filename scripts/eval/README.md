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

## The golden set

`golden-set/golden-set.v1.json` is the **versioned** fixture: four representative
document types (WMS requirements DOCX, a BPMN process document, a UI-mask manual,
a technical plan set) and 120 questions carrying expected page, figure and
table-cell answers, plus ground-truth `extraction` annotations (expected table
content, figure labels, BPMN nodes/edges) for the extraction-quality metrics.
The `extraction` field is optional and was added in fixture `1.1.0` (T2.10);
`1.0.0` readers ignore it.

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

## The committed baseline

`baseline/retrieval.baseline.{json,md}` is the Ist-Stand reference. It currently
ships as a **pending skeleton** (`"pending": true`, all metrics 0, and an
`extraction` block whose expected-item counts are fixed but produced values are
0) because it must be recorded against a live Search/Extract instance that has
the golden documents indexed.
Regenerate it once the golden documents are ingested:

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
bun run eval:test          # unit tests for metrics + fixture loader
bun run eval:typecheck     # tsc --noEmit for the harness
```
