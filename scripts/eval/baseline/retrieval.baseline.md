# Retrieval evaluation — baseline

Generated: 2026-09-27T06:17:39.939Z

Fixture `1.1.0` — 4 documents, 120 questions (mode: offline, collection: `golden`).

> **Pending baseline.** No search hits were observed, so every metric is 0. Regenerate against a live Search instance that has the golden documents indexed (see `scripts/eval/README.md`) to record the real Ist-Stand.

## Retrieval metrics

| Metric | @5 | @10 |
| --- | --- | --- |
| Page Recall | 0.0% | 0.0% |
| Figure Recall | 0.0% | 0.0% |
| MRR | 0.0000 | 0.0000 |
| Figure-Hit-Rate | 0.0% | 0.0% |

## Extraction-quality metrics

> **Pending extraction metrics.** No produced extraction output was supplied (`--extractions`), so table-cell accuracy, label-coverage and BPMN node/edge recall are 0. These require a live Extract run over the golden documents; feed the captured output back offline to score them (see `scripts/eval/README.md`).

| Metric | Value | Detail |
| --- | --- | --- |
| Table-cell accuracy | 0.0% | 0/112 cells, 22 tables |
| Label-coverage | 0.0% | 0/84 labels, 28 figures |
| BPMN node recall | 0.0% | 0/80 nodes, 20 diagrams |
| BPMN edge recall | 0.0% | 0/60 edges, 20 diagrams |

## Coverage

| Category | Count |
| --- | --- |
| questions (bpmn) | 30 |
| questions (docx) | 40 |
| questions (plan) | 20 |
| questions (ui_mask) | 30 |
| page questions | 120 |
| figure questions | 78 |
| table-cell questions | 22 |
| table annotations | 22 |
| label annotations | 28 |
| BPMN annotations | 20 |

