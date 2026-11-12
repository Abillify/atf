<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Published measurements

Every number in this document comes from a raw report file that is committed
next to it, under `benchmarks/`. Nothing here is estimated, extrapolated, or
carried over from a run whose artefact is missing. Where a measurement does not
exist, the row says so instead of showing a number.

If you are looking for a headline quality figure to compare against another
product: this document deliberately does not provide one. Section
"Limits" explains why the honest answer is narrower than the question.

## How to read this document

Each results table states, in its heading or lead-in, four things: the script
that produced the numbers, the dataset it ran against, the commit the code came
from, and the directory holding the raw output. A number that cannot name all
four is not in a table here.

Two kinds of run appear:

| Kind | What it is | Where the raw file comes from |
| --- | --- | --- |
| CI run | The `Retrieval eval (real models)` job in `.github/workflows/ci.yml`, on a GitHub `ubuntu-latest` runner with real embedding and rerank models | Downloaded from the workflow run's `eval-reports-<sha>` artefact and committed unchanged |
| Local run | A harness invocation on this machine, without any model endpoint | Written by the harness (`--out`), or its stdout redirected to a file where the harness has no file output. Copied in unchanged |

The difference matters: the CI runs measure retrieval against real model
vectors, the local runs measure only the scorers themselves.

## Provenance of the raw files

| Directory | Commit | Date (UTC) | Contents |
| --- | --- | --- | --- |
| [`benchmarks/2026-11-10-810a20b8/`](benchmarks/2026-11-10-810a20b8/) | `810a20b8` = `v0.25.6` | 2026-11-10 | Eight retrieval reports (JSON) from CI run [42777628333](https://github.com/Abillify/atf/actions/runs/42777628333), job `Retrieval eval (real models)` |
| [`benchmarks/2026-11-11-00fef2f3/`](benchmarks/2026-11-11-00fef2f3/) | `00fef2f3` | 2026-11-11 | Groundedness scorer calibration (text) and extraction-quality scorer self-check (JSON + MD), local machine, no model |

`810a20b824e60ccde82e278a4a69e5473f1ba609` (shortened to `810a20b8` throughout)
is the `v0.25.6` release commit and the base of the branch this document was
written on, so the retrieval numbers describe the code that shipped as 0.25.6.
The commit is named directly because `v0.25.6` is an annotated tag and
`git rev-parse v0.25.6` resolves to the tag object (`19e06c3d…`), not to a
commit; `git rev-list -n1 v0.25.6` is the command that returns `810a20b8`.

Each CI report carries provenance inside the JSON: `generated_at`, `label`,
`fixture.version` and a `parameters` block with `collection`, `base_url`,
`cutoffs`, `mode` and `endpoint`. Where an ablation was a request flag, it is
recorded too — `search_mode`, `rerank: true` or `hyde: true` — so five of the
eight rows identify themselves from their own file.

Two rows do not, and the gap is worth stating rather than papering over:

- the contextual-header row records only `endpoint: "v2"` and
  `collection: "golden_ctx"`; the ingest path that produces the effect is not a
  field in the report
- the compound row is identical to the German fts row except for
  `base_url: http://127.0.0.1:3013`, the compound-splitting twin of the Search
  service

For both, the only record of what made them different is the step in
`.github/workflows/ci.yml` that ran them. A report alone cannot prove which
server setting was active — a real gap in the harness's provenance, and the
reason these two rows cite the workflow file alongside the JSON.

Committing these files is deliberately a snapshot, not a change to the eval
gate. `ci.yml` writes reports into artefacts and keeps the tree clean so that
`scripts/eval/baseline/` stays a stable reference; that job is untouched. What
lives here instead is a dated copy, so a published number keeps its raw source
after the artefact's retention runs out.

## Method

The retrieval harness and its options are documented in
[`../scripts/eval/README.md`](../scripts/eval/README.md); this section only
summarises what a reader needs to judge the numbers.

**Retrieval** ([`scripts/eval/retrieval.ts`](../scripts/eval/retrieval.ts),
`bun run eval:retrieval`). A versioned golden set of questions with known
answers is run against a live Search instance. Each hit is turned into page and
figure references, and scoring is a set-membership test against the annotated
expected answers. Metrics, exactly as the harness names them:

| Metric | Definition |
| --- | --- |
| Page Recall@k | share of expected pages found within the top _k_, averaged over page questions |
| Figure Recall@k | the same over expected figures |
| MRR@k | reciprocal rank of the first correct hit at any granularity |
| nDCG@k | normalised discounted cumulative gain of the ranking |
| Figure-Hit-Rate@k | share of figure questions with at least one expected figure in the top _k_ |
| Abstention precision / recall | over the unanswerable questions only, needs a score gate to be meaningful |
| False-answer / false-abstention rate | answered-unanswerable and unanswered-answerable shares |

Datasets: `golden-set.v1.json` fixture 1.4.0 — 4 synthetic documents, 144
questions (120 answerable, 24 unanswerable) — and
`de-morphology.v1.json` fixture 1.2.0, 43 German word-form variants of
golden-set questions, reported as `1.4.0+de-morphology.1.2.0` by the harness.
Both are generated, contain no real documents, and are re-creatable with
`bun run eval:fixture`.

**Extraction quality**
([`scripts/eval/extract-quality.ts`](../scripts/eval/extract-quality.ts),
`bun run eval:extract-quality`). CER, Heading-F1 (with and without level) and
TEDS over a *quality set* plus the produced page records. The only quality set
that ships is `quality-set/synthetic` (kind `synthetic`) with a
`produced-sample/` that carries deliberate defects; it exists to pin the
scorer, not to describe pipeline quality.

**Answer-level groundedness**
([`scripts/eval/groundedness.ts`](../scripts/eval/groundedness.ts),
`bun run eval:groundedness`). 12 items, two curated candidate answers each, one
grounded and one with unsupported claims, scored by the runtime's lexical
groundedness checker. Reference mode calibrates the checker; scoring real model
answers needs `--answers <file>` produced by a live model.

## Environment

**The retrieval runs.** Executed by GitHub Actions, not on this machine:

| Item | Value |
| --- | --- |
| Runner | GitHub Actions `ubuntu-latest` (shared CPU, amd64) |
| ATF version | 0.25.6, commit `810a20b8` |
| Bun | 1.4.4 (`packageManager` pin, installed by `setup-bun`) |
| Stack | [`scripts/eval/compose.eval.yaml`](../scripts/eval/compose.eval.yaml) at that commit |
| Embedding | `BAAI/bge-m3`, 1024 dimensions, TEI `cpu-1.9`, CPU-only |
| Reranker | `BAAI/bge-reranker-base`, TEI `cpu-1.9`, native `/rerank` |
| HyDE generator | `echo-hyde` — a deterministic mock, not a real chat model |
| Store | `pgvector/pgvector:0.8.1-pg18` |
| Full-text language | `FTS_LANGUAGE=german` |
| Rate limiting | disabled (`RATE_LIMIT=0`) so back-to-back queries are not throttled |

The HyDE generator is a mock by design. `scripts/eval/echo-mock.py` turns a query
into a fixed pseudo-document sentence, so the HyDE row measures the *shape* of
HyDE — an expanded query is embedded and searched, and that costs a round trip —
without measuring any real model's expansion quality. A real generator would
change the HyDE numbers; the row is not a HyDE capability figure.

**The local runs.** One Apple M4 Pro machine, macOS 26.6.2, arm64, 12 cores,
64 GB, Docker 29.9.2, Bun 1.4.2 locally against the 1.4.4 pin (the harness has
no runtime-sensitive code paths, but the difference is recorded). No model
endpoint was configured for them, which is why they are scorer checks and not
measurements of the product.

## Results: retrieval

All rows come from
[`benchmarks/2026-11-10-810a20b8/`](benchmarks/2026-11-10-810a20b8/), commit
`810a20b8` (v0.25.6), 2026-11-10, bge-m3 on CPU. Metrics at k=10 unless
noted. `page@5`/`page@10` are Page Recall, `nDCG` is the page-group value.

| Configuration | Raw file | page@5 | page@10 | MRR@10 | nDCG@10 | fig@10 | p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline, v1 hybrid | `retrieval.baseline.json` | 69.2 % | 80.0 % | 0.8642 | 53.7 % | 97.4 % | 87.5 / 198.6 |
| dense only (`--search-mode dense`) | `retrieval.ablation-dense.json` | 57.5 % | 66.7 % | 0.7007 | 42.4 % | 92.3 % | 4.2 / 15.7 |
| + rerank (`--rerank`) | `retrieval.ablation-rerank.json` | 100.0 % | 100.0 % | 0.9903 | 84.8 % | 100.0 % | 15333.1 / 16825.7 |
| + HyDE (`--hyde`) | `retrieval.ablation-hyde.json` | 68.3 % | 80.0 % | 0.8540 | 53.1 % | 97.4 % | 109.1 / 236.2 |
| contextual-header variant, v2 (`--v2`, `golden_ctx`) | `retrieval.ablation-ctx-header.json` | 99.2 % | 100.0 % | 0.9117 | 93.4 % | 100.0 % | 7.2 / 12.5 |
| answer-ready (`--retrieve`, `POST /v2/retrieve`) | `retrieval.ablation-retrieve.json` | 100.0 % | 100.0 % | 0.7944 | 84.8 % | n/a | 7730.1 / 8740.9 |
| German variants, fts (de-morphology) | `retrieval.de-baseline.json` | 58.3 % | 75.0 % | 0.5751 | 47.3 % | 78.9 % | 5.3 / 8.2 |
| German variants, fts + compound splitting | `retrieval.ablation-compound.json` | 58.3 % | 77.8 % | 0.5797 | 48.3 % | 78.9 % | 4.0 / 7.3 |

Every file is in
[`benchmarks/2026-11-10-810a20b8/`](benchmarks/2026-11-10-810a20b8/), named by
the `--label` the CI step passed.

What these numbers support, and what they do not:

- **Dense-only collapses, hybrid recovers it.** 66.7 % against 80.0 % page
  recall. The synthetic corpus is deliberately lexical-heavy, so this measures
  the corpus as much as the retriever.
- **The contextual-header variant is the quality winner** and also the cheapest
  per query of the strong configurations: 100.0 % page recall at k=10, 93.4 %
  nDCG, 7.2 ms p50. The comparison is not flag-vs-no-flag: this row ingests the
  same corpus through the v2 revision API, which is the only path that runs the
  batch worker, and only the batch worker applies the contextual embedding
  header (`scripts/eval/compose.eval.yaml`, header comment). So it measures the
  v2 ingest shape against the v1 ingest shape, endpoint and all. The name is
  also narrower than it sounds: `compose.eval.yaml` never sets
  `FTS_CONTEXTUAL_HEADER`, which defaults to `off` (`apps/search/README.md`), so
  what this row exercises is the contextual header on the **embedding** side
  only, not a full-text variant of it.
- **Rerank buys quality at a latency that is not usable on CPU.** Page recall
  80.0 % → 100.0 % and nDCG 53.7 % → 84.8 % for p50 87.5 ms → 15 333 ms, a
  175× increase inside the same run on the same corpus. See the next section —
  the number is real, and it is not a regression to tune away.
- **Compound splitting on the query side gains 2.8 percentage points** of page
  recall (75.0 % → 77.8 %) on the German variants and costs nothing measurable.
  Both numbers come from one small set of 43 questions, so treat the direction
  as the finding and the size as unknown.
- **`--retrieve` returns no figure evidence**, so Figure Recall is `n/a` there —
  not zero. The raw JSON carries `figure: null`; the `figure_hit_rate` block in
  the same file reports 0 % because it counts hits without figure references.
  Use the `n/a`, not the 0 %.

**Abstention is unmeasured in every row.** All eight runs ran with
`abstention_min_score: null` — no score gate — so "answered" means "any hit in
the top _k_", and a ranked retriever always returns something. Every row
therefore reports `abstentionPrecision: 0`, `abstentionRecall: 0` and
`falseAnswerRate: 1`, which describe the missing gate rather than the
retriever. The de-morphology rows additionally report
`falseAbstentionRate: 0.0278`: one of its 7 unanswerable questions got no hit at
all, so it was treated as abstained — a further sign that "answered" is not a
meaningful category here. `../scripts/eval/README.md` states why the gate has to
be set per configuration: scores are not comparable across search modes or
rerankers. Choosing a gate is a decision, not a measurement: `TODO(human)` —
someone has to define when a search result is too weak to build an answer on.

## Results: the rerank latency, in detail

The rerank row is the one a reader will doubt, so it gets its own section.

The raw file records 144 latency samples, one per question, in a sequential loop
with no warm-up request. What rules out cold-start amortisation is the shape of
the distribution: p50 15 333 ms and p95 16 826 ms differ by only 1.5 s across
144 samples. A model load that the later queries amortise would make p50 far
below p95; instead every query costs roughly the same. **The reading is that
each reranked query takes about 15 s on a shared CPU runner**, not that one slow
request skews the median.

The same job on three different commits, all with fixture 1.4.0, measured:

| CI run | Commit | Date | rerank p50 / p95 ms |
| --- | --- | --- | --- |
| 42257759757 | `56b6fb8e` | 2026-11-06 | 14293.9 / 15665.8 |
| 42768965133 | `94aace78` | 2026-11-10 | 13136.5 / 14157.2 |
| 42777628333 | `810a20b8` | 2026-11-10 | 15333.1 / 16825.7 |

All three CI reports are from the same stack and the same ablation; only the
`810a20b8` file is committed under `benchmarks/`, and it is the one the table
above quotes. The other two are cited from CI artefacts that expire, which is
stated here so the claim can be re-checked while they last.

Stable across commits and dates, so this is the cost of the configuration and
not a one-off. The claim this supports is narrow and specific: **rerank with
`BAAI/bge-reranker-base` on a GitHub Actions CPU runner costs around 15 s per
query for a 4-document corpus at this k, and the quality gain in the table above
comes at that price.** Whether a GPU runner, a smaller cross-encoder, batching,
or a limit on how many candidates get reranked changes the picture is
unmeasured — the harness exposes no such knob (`../scripts/eval/README.md` lists
every flag), so the eval always exercises whatever default the Search service
applies.

For comparison, the committed older ablation
(`scripts/eval/baseline/retrieval.ablation-rerank.*`, measured 2026-10-07 with
`bge-small-en-v1.5` on fixture 1.2.0) reports rerank p50/p95 of 8.3 / 16.1 ms
with page@10 100 % and nDCG 65.7 %. Same flag, three orders of magnitude apart.

That delta cannot be attributed to any single change from the data available:
model, embedding dimension and fixture version all differ between the two runs,
and no run exists with both models on the same fixture. What the pair does
establish is that 15 s is not inherent to cross-encoder reranking, so the
question "what makes it slow here" is open and worth answering before rerank is
recommended anywhere: `TODO(human)`.

## Results: gate margins

`thresholds*.json` under [`../scripts/eval/baseline/`](../scripts/eval/baseline/)
are floors the CI job enforces. Three of them are registered in
`.github/workflows/ci.yml`; the remaining keys of `thresholds.json` are loaded
by the baseline step alongside them.

| Floor file | Registered in CI for |
| --- | --- |
| `thresholds.json` | the `baseline` run |
| `thresholds.ctx-header.json` | the contextual-header run |
| `thresholds.retrieve.json` | the answer-ready run |
| — | dense, rerank and HyDE (`Ablations (dense, rerank, hyde)`) and the German compound runs pass no `--thresholds` at all: they are diagnostic, and a floor on them would only record which configuration loses |

The floors are quoted as they stand in the tree; the measured column is the
2026-11-10 run on fixture 1.4.0. The two sides are deliberately shown together
even though they are **not the same dataset version** — every one of these files
was calibrated on an earlier run, and reading a margin without that fact misreads
it. The calibration sources are below the table.

| Floor file | Key | Floor | Measured | Margin |
| --- | --- | --- | --- | --- |
| `thresholds.json` | page_recall | 0.80 | 0.8000 | 0.0000 |
| `thresholds.json` | figure_recall | 0.95 | 0.9744 | 0.0244 |
| `thresholds.json` | mrr | 0.85 | 0.8642 | 0.0142 |
| `thresholds.json` | ndcg | 0.53 | 0.5373 | 0.0073 |
| `thresholds.json` | p50_latency_ms | ≤ 150 | 87.5 | 62.5 |
| `thresholds.json` | p95_latency_ms | ≤ 500 | 198.6 | 301.4 |
| `thresholds.retrieve.json` | page_recall | 0.96 | 1.0000 | 0.0400 |
| `thresholds.retrieve.json` | ndcg | 0.81 | 0.8482 | 0.0382 |
| `thresholds.ctx-header.json` | page_recall | 0.97 | 1.0000 | 0.0300 |
| `thresholds.ctx-header.json` | figure_recall | 0.97 | 1.0000 | 0.0300 |
| `thresholds.ctx-header.json` | ndcg | 0.88 | 0.9339 | 0.0539 |

**Where each floor came from.** `thresholds.json` was recalibrated on the
bge-m3 run of 2026-10-23 (fixture **1.3.0**, commit `f5c2384`, page@10 82.5 %,
nDCG 0.5554, MRR@10 0.8957, figure@10 97.4 % — recorded in
`scripts/eval/baseline/retrieval.bge-m3.md`), with the floors set about 0.025
below that measurement. `thresholds.retrieve.json` and
`thresholds.ctx-header.json` were set 0.03 below the CI measurement of
2026-10-25, also on fixture **1.3.0** (`--retrieve` 0.992 / nDCG 0.847;
contextual header 1.000 / figure 1.000 / nDCG 0.918) —
`../scripts/eval/README.md`, section "Gates".

That is the real finding in this table. Fixture 1.4.0 reworded every question and
renamed the documents (`scripts/eval/golden-set/build-fixture.ts`, version
comment: "retrieval metrics are not comparable with 1.3.0"), page recall fell
from 82.5 % to 80.0 %, and the `page_recall` floor that was set 0.025 below the
measurement now sits exactly **on** it: margin 0.0000. The same happened to the
nDCG margin, 0.0254 → 0.0073, and to MRR, 0.0457 → 0.0142. The two newer files
were less affected — `--retrieve` gained (0.992 → 1.000) and the contextual
header's nDCG margin widened from 0.03 to 0.0539.

A floor with zero margin still fails on any real regression, which is arguably
what a floor is for. But it no longer says anything about headroom, and the next
question a reader will ask — "how much room is left" — has no answer in the data.
Whether to recalibrate `thresholds.json` on a fixture 1.4.0 run, or to accept
that page recall is pinned, is a decision, not a measurement: `TODO(human)`.
Recalibrating is cheap to ask for and not cheap to do honestly: it needs a new
CI measurement, and lowering a floor to match a measurement is how a gate stops
meaning anything.

Note that `scripts/eval/baseline/retrieval.baseline.md` in the tree describes a
*different* run (2026-10-07, `bge-small-en-v1.5`, fixture 1.2.0, page@10
100 %, nDCG 0.6602). It is not this document's source and must not be mixed
with the numbers above; `../scripts/eval/README.md` explains the model switch.

## Results: scorer checks, no model involved

These two ran locally at `00fef2f3` on 2026-11-11, with no model endpoint
configured. They say something about the measuring instruments and nothing about
ATF's quality. Raw files:
[`benchmarks/2026-11-11-00fef2f3/`](benchmarks/2026-11-11-00fef2f3/).

**Groundedness checker, reference mode** (`groundedness.reference-mode.txt`,
the redirected stdout of `bun run eval:groundedness`, which has no file output).
12 items from `groundedness/answer-set.v1.json` version 1.1.0, two curated
candidates each:

| Metric | Value |
| --- | --- |
| Candidates scored | 24 |
| Accuracy against the curated label | 1.000 |
| Mean score, grounded candidates | 1.000 |
| Mean score, unsupported candidates | 0.042 |
| Unsupported-detection rate | 1.000 |
| False-flag rate | 0.000 |

The checker separates the curated pairs on this set. That is a calibration of a
lexical overlap measure on 24 hand-written candidates — the harness itself
states it is not a measurement of any LLM. A paraphrase scores low, and a wrong
claim assembled from context words can pass.

**Extraction-quality scorer, self-check**
(`extract-quality.produced-sample.json`). Quality set `synthetic` v1.1.0, 3
cases, 5 annotated pages, scored against the shipped `produced-sample/`, which
contains deliberate defects (a wrong heading level, a merged heading, an OCR
slip, a split header cell, a missing page). The run was invoked with
`--label produced-sample`; the file's own `label` field reads `session-scoring`,
the default, so the committed file name and the label inside it name the same
run by different words — the JSON is authoritative for what was scored, the file
name for why it is here:

| Metric | Value |
| --- | --- |
| CER | 7.2 % (54 edits / 750 characters) |
| Heading-F1 | 87.5 % |
| Heading-F1 with level | 75.0 % |
| TEDS | 39.0 % (2 annotated tables) |
| TEDS ignoring cell text | 39.5 % |

Because the defects are known, these are expected values that pin the scorer.
**They are not extraction quality.** For that, a quality set of real documents
plus Extract's emitted page records is needed, and no such measurement exists
in this repository.

## Not measured

| What | Status | What it would take |
| --- | --- | --- |
| Extraction quality on real documents | TODO(human) | A quality set (kind `public` or `customer`, kept out of the public tree) plus `--produced` records captured from Extract's emit outbox before `JOB_RETENTION_DAYS` sweeps the job |
| Table-cell / label / BPMN metrics | TODO(human) | The same produced output, fed to `eval:retrieval -- --extractions <file>`. The six golden-set rows above report these as pending (0 of 112 cells, 0 of 84 labels, 0 of 80 nodes, 0 of 60 edges matched); the two de-morphology rows are not missing data but absent annotation — that set carries no table, label or BPMN expectations at all, so it reports the metrics as complete at zero |
| Groundedness of real model answers | TODO(human) | Answers per item id from a live model, scored with `--answers`; `../scripts/eval/baseline/groundedness.live.md` states the same |
| Abstention with a score gate | TODO(human) | A chosen `--abstain-min-score` per search mode, then a rerun |
| Throughput, load, soak, concurrency | not measured | No tooling exists; the retrieval latencies are single-client sequential timings over a 4-document corpus, not capacity figures |
| End-to-end flow latency, tokens per run | not measured | The runtime exposes the counters; no benchmark drives them |
| Conversion throughput per page (VLM) | not measured | Needs a vision model endpoint and a fixed document set |
| Cost per 1 000 pages | derived, not measured | `OPERATIONS-TCO.md` models this from prices and page counts; no invoice-verified figure is published |

## Reproducing a measurement

Retrieval, exactly as CI runs it. Use a linux/amd64 machine: the TEI images
`ghcr.io/huggingface/text-embeddings-inference:cpu-1.9` provide no arm64
manifest, and under amd64 emulation on Apple silicon the embedding container was
OOM-killed here during the local run of this task (exit 137).

```bash
docker compose -f scripts/eval/compose.eval.yaml up --build -d --wait --wait-timeout 600
bun run scripts/eval/golden-set/build-corpus.ts
bun run scripts/eval/ingest-corpus.ts --collection golden --base-url http://127.0.0.1:3012
bun run scripts/eval/retrieval.ts --collection golden \
  --base-url http://127.0.0.1:3012 --k 5,10 --label baseline \
  --out reports/eval/retrieval --thresholds scripts/eval/baseline/thresholds.json
docker compose -f scripts/eval/compose.eval.yaml down --volumes
```

The ablations differ from that command as follows, one step each in the workflow:

- dense / rerank / HyDE: add `--search-mode dense`, `--rerank` or `--hyde`.
  CI runs all three against `$base` with the labels `ablation-dense`,
  `ablation-rerank`, `ablation-hyde` and no `--thresholds`
- contextual header: a second ingest `ingest-corpus.ts --v2 --collection
  golden_ctx --base-url http://127.0.0.1:3012`, then `retrieval.ts --v2
  --collection golden_ctx` with `--thresholds
  scripts/eval/baseline/thresholds.ctx-header.json`. The collection name is the
  only trace of the variant in the report — see "Provenance of the raw files"
- answer-ready retrieval: `--retrieve --collection golden` with
  `--thresholds scripts/eval/baseline/thresholds.retrieve.json`
- German variants: `--fixture scripts/eval/golden-set/de-morphology.v1.json
  --search-mode fts --collection golden`, once against port 3012
  (`de-baseline`) and once against 3013, the compound-splitting instance
  (`ablation-compound`). Both share one database with the rows above

The flags in the `parameters` block of each committed JSON say which was used,
except for the two cases named above; a reproduction is checkable against the
file rather than against this prose. `reports/` is gitignored, so reproducing a
number never dirties the tree.

Scorer checks, no model needed:

```bash
bun run eval:groundedness          # reference mode, prints to stdout
bun run eval:extract-quality       # synthetic quality set against produced-sample
```

Add `--out <prefix> --label <name>` to `eval:extract-quality` to get the JSON
file the tables above were read from.

## Limits

Read these before quoting any number from this document.

- **The corpus is synthetic and small.** Four generated documents, 144
  questions, all German, all deterministic from `build-fixture.ts`. The
  questions in the golden set appear verbatim in the corpus, which inflates
  recall; the de-morphology set exists precisely because variants score
  differently. A page recall of 80 % here does not predict 80 % on a customer
  corpus.
- **Retrieval latency is not product latency.** The p50/p95 figures measure one
  client sending back-to-back queries to a Search instance with rate limiting
  disabled against 4 documents. They are comparable between configurations in
  the same run and nothing else.
- **`--retrieve` does more work per question.** It targets the answer-ready
  endpoint, which expands the question into up to `max_subqueries` sub-queries
  (4 by default) under a `budget_tokens` cap, and it cannot be combined with
  `--rerank`, `--hyde` or `--search-mode` because the pipeline has its own fixed
  configuration. The harness still measures wall-clock time for the same
  question, which is what `../scripts/eval/README.md` calls comparable across
  endpoints — but the 7.7 s there and the 15.3 s under rerank are different
  amounts of work, so reading them as "rerank is twice as fast" would be wrong.
- **The rerank row is CPU-only** with one specific cross-encoder on a shared
  runner. Section "Results: the rerank latency, in detail" is the full extent of
  what is known about it.
- **Quality sets with real documents do not ship.** `verify:public` guards the
  public tree, so the only extraction numbers available are scorer self-checks.
- **Fixture version changes are not isolated, and the harness says so.**
  `build-fixture.ts` states in its own version comment that 1.4.0 reworded the
  questions and renamed the documents, that pages/figures/cells/count are
  unchanged, and that "retrieval metrics are not comparable with 1.3.0". So the
  step from the 2026-10-07 run (fixture 1.2.0, `bge-small-en-v1.5`, page@10
  100 %) via 2026-10-23 (fixture 1.3.0, `bge-m3`, 82.5 %) to this one (1.4.0,
  80.0 %) contains at least two changed variables and no run exists with both
  models on one fixture. Any sentence attributing that delta to the model would
  be a guess — including the tempting one, that bge-m3 is worse than its smaller
  predecessor.
- **Judge-free by construction.** No metric here depends on an LLM judging
  output, which makes them reproducible and also blind to meaning: the
  groundedness checker is lexical overlap.
- **Artefacts expire where they are not committed.** Only the files under
  `benchmarks/` are permanent; the two extra rerank-latency CI reports cited
  above live in GitHub Actions storage with a 30-day retention.

## See also

- [`../scripts/eval/README.md`](../scripts/eval/README.md) — the harness in
  detail: every flag, the fixture format, the ablation design, and how the
  committed floors were calibrated
- [`OPERATIONS-TCO.md`](OPERATIONS-TCO.md) — cost and sizing model behind the
  reranker and VLM decisions
- [`operations-and-retrieval.md`](operations-and-retrieval.md) — full-text
  language and compound-splitting configuration
- [`METRICS-AND-RETENTION.md`](METRICS-AND-RETENTION.md) — the runtime metrics,
  which are a different thing from these offline measurements
- [`CAPABILITIES.md`](CAPABILITIES.md) — what the retrieval pipeline actually
  does, per setting
