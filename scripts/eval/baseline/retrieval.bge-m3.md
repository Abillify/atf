<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Retrieval evaluation: bge-m3, Fixture 1.3.0 (nicht gemessen)

Status: **nicht gemessen**. Dieser Platzhalter ersetzt keine Messung. Die
Stack-Konfiguration `compose.eval.yaml` nutzt `BAAI/bge-m3` (1024 Dimensionen),
die Messung erfordert den Docker-Compose-Stack und wurde lokal nicht ausgeführt.

| Konfiguration | Fixture | page@5 | page@10 | MRR@10 | nDCG@10 | Abstention (Precision/Recall) | False-Answer-Rate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bge-m3, v1 hybrid, golden-set v1 | 1.3.0 | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen |
| bge-m3, v1 hybrid, de-morphology v1 | 1.1.0 | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen | nicht gemessen |

Die Werte unter `retrieval.baseline.*` und `retrieval.ablation-*.*` stammen von
Fixture 1.2.0 und `BAAI/bge-small-en-v1.5` (384 Dimensionen, englisch). Sie sind
mit diesem Modell gemessen und nicht auf bge-m3 übertragbar. Die Abstention-
Metriken existieren erst ab Fixture 1.3.0; für den Stand 1.2.0 gibt es keine.

Messung ausführen:

```bash
docker compose -f scripts/eval/compose.eval.yaml up --build -d --wait
bun run scripts/eval/golden-set/build-corpus.ts
bun run scripts/eval/ingest-corpus.ts --collection golden --base-url http://127.0.0.1:3012
bun run scripts/eval/retrieval.ts --collection golden --base-url http://127.0.0.1:3012 \
  --label bge-m3 --out reports/retrieval --abstain-min-score <Gate je Modus festlegen>
```
