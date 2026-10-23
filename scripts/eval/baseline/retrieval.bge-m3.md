<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Retrieval evaluation: bge-m3, Fixture 1.3.0

Status: **gemessen** für das Golden Set, in der CI auf dem Commit `f5c2384`
(Job `Retrieval eval (real models)`, 2026-10-23; GitHub-Runner `ubuntu-latest`,
TEI `cpu-1.9`, `BAAI/bge-m3`, 1024 Dimensionen). Gemessen über den
v1-Endpunkt, Hybrid-Suche, 144 Fragen (davon 24 Abstention-Fragen, die in
Page/Figure-Recall nicht mitzählen). Das de-morphology-Set ist noch nicht
gemessen.

| Konfiguration | Fixture | page@5 | page@10 | MRR@10 | nDCG@10 | Abstention (Precision/Recall) | False-Answer-Rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bge-m3, v1 hybrid, golden-set v1 | 1.3.0 | 71.7 % | 82.5 % | 0.8957 | 0.5554 | 0 % / 0 % (ohne Score-Gate) | 100 % |
| bge-m3, v1 hybrid, de-morphology v1 | 1.1.0 | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen |

Weitere Werte des Laufs: Figure Recall@10 97.4 %, Figure-Hit-Rate@10 97.4 %,
Latenz p50 84.8 ms / p95 157.9 ms. Ohne `--abstain-min-score` liefert jede
Frage einen Treffer, daher die 0 %/100 % in den Abstention-Spalten.

`thresholds.json` ist auf diesen Lauf kalibriert: `page_recall` 0.80 und
`ndcg` 0.53 liegen knapp unter der Messung; `figure_recall` (0.95), `mrr`
(0.85) und die Latenz-Grenzen sind unverändert.

Die Werte unter `retrieval.baseline.*` und `retrieval.ablation-*.*` stammen von
Fixture 1.2.0 und `BAAI/bge-small-en-v1.5` (384 Dimensionen, englisch). Sie sind
mit diesem Modell gemessen und nicht auf bge-m3 übertragbar; gegenüber diesem
Stand (page@10 100 %, nDCG@10 0.6602) liegt bge-m3 auf Fixture 1.3.0 niedriger.
Ob das am Modell oder an den zusätzlichen Fragen von Fixture 1.3.0 liegt, ist
nicht untersucht: dafür müssten beide Modelle auf derselben Fixture laufen.
Die Abstention-Metriken existieren erst ab Fixture 1.3.0; für den Stand 1.2.0
gibt es keine.

Messung ausführen:

```bash
docker compose -f scripts/eval/compose.eval.yaml up --build -d --wait
bun run scripts/eval/golden-set/build-corpus.ts
bun run scripts/eval/ingest-corpus.ts --collection golden --base-url http://127.0.0.1:3012
bun run scripts/eval/retrieval.ts --collection golden --base-url http://127.0.0.1:3012 \
  --label bge-m3 --out reports/retrieval --abstain-min-score <Gate je Modus festlegen>
```
