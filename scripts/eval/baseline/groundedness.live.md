<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Answer-level groundedness: Live-Modell (nicht gemessen)

Status: **nicht gemessen** (requires live model). Das Mini-Set
`groundedness/answer-set.v1.json` enthält kuratierte Referenzantworten. Antworten
eines echten Modells liegen nicht vor, daher gibt es keine Zahlen.

| Konfiguration | Antworten bewertet | mittlerer Faithfulness-Score | Pass-Rate |
| --- | --- | --- | --- |
| Live-Modell, Prompt wie Runtime-RAG-Flow | nicht gemessen | nicht gemessen | nicht gemessen |

Ablauf: Antworten je Item-ID als JSON `{ "g-01": "…" }` mit einem Live-Modell
erzeugen und mit `bun run eval:groundedness -- --answers <datei>` bewerten.
Der Scorer ist die lexikalische Groundedness-Prüfung der Runtime (kein
Modellaufruf).
