# Retrieval evaluation — ablation-hyde

Generated: 2026-10-07T04:12:59.294Z

Fixture `1.2.0` — 4 documents, 120 questions (mode: live, endpoint: v1, collection: `golden`).

## Retrieval metrics

| Metric | @5 | @10 |
| --- | --- | --- |
| Page Recall | 91.7% | 100.0% |
| Figure Recall | 100.0% | 100.0% |
| MRR | 0.8989 | 0.8989 |
| nDCG | 0.6446 | 0.6736 |
| Figure-Hit-Rate | 100.0% | 100.0% |

## Latency

| Metric | Value |
| --- | --- |
| p50 | 37.1 ms |
| p95 | 66.2 ms |
| samples | 120 |

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

