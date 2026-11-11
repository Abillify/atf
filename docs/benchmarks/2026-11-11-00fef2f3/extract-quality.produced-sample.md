# Extraction quality — session-scoring

Set: synthetic v1.1.0 — Invented German requirements, interface and operations text; no real documents. Sample output carries deliberate defects to exercise the scorer.
Produced output: produced-sample

| Metric | Value | Definition |
| --- | ---: | --- |
| CER | 7.2 % | edit distance of the running text / reference characters (lower is better) |
| Heading-F1 | 87.5 % | headings matched on their text |
| Heading-F1 (with level) | 75.0 % | headings matched on text and level |
| TEDS | 39.0 % | tree-edit-distance similarity of 2 annotated table(s) |
| TEDS (structure) | 39.5 % | the same ignoring cell text |

3 case(s), 5 annotated page(s), 1 without a produced page, 0 produced table(s) matched to no annotation.

| Case | Pages | CER | Heading-F1 | TEDS | Missing pages |
| --- | ---: | ---: | ---: | ---: | --- |
| anforderungen | 2 | 0.2 % | 88.9 % | n/a | — |
| schnittstellen | 1 | 0.0 % | 100.0 % | 78.1 % | — |
| betriebshandbuch | 2 | 27.2 % | 80.0 % | 0.0 % | 2 |
