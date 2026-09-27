<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Phase 0 Abschlussbericht (T0.9)

Phase 0 ("Baseline und Sofortkorrekturen") ist implementiert. Dieser Bericht
fasst die gelieferten Änderungen zusammen, hält den Stand der Retrieval-Baseline
fest und enthält den vollständigen Runbook für die zwei Schritte, die zwingend
eine **Live-Umgebung** brauchen: die reale Golden-Set-Auswertung (vorher/nachher)
und die Deployment-Verifikation von `flow_version` im Debug-Trace.

_Requirements: 18.4, 16.6_

## 1. In Phase 0 gelieferte Änderungen

| Task | Bereich | Änderung |
| --- | --- | --- |
| 0.1 | Eval | Golden Set (`scripts/eval/golden-set/golden-set.v1.json`, 4 Dokumenttypen, 120 Fragen) und Harness `scripts/eval/retrieval.ts` (Recall@5/10 Seite+Abbildung, MRR, Figure-Hit-Rate; JSON- und Markdown-Bericht). Baseline-Skelett committed. |
| 0.2 | Search | Embedding-Kontext seitenbezogen statt Summary-Kette; `buildEmbedInput` deckelt pro Chunk auf die überdeckten Seiten-Summaries. |
| 0.3 | Search | Seitenmarker (`## Seite N`) und Trenner (`---`) aus Embedding- und Volltext entfernt, Offset-Mapping konsistent gehalten. |
| 0.4 | Search | Text↔Abbildung-Verknüpfung: Platzhalter aufgelöst, `figure_refs` in `ChunkInfo`/`evidence`/Antwort, angereicherter Embedding-Input für Abbildungs-Chunks. |
| 0.5 | Search | FTS-Sprache pro Collection (`fts_language`, Default `FTS_LANGUAGE`); Migration für `ts_search`. |
| 0.6 | Extract | Robuste Seitenverarbeitung: adaptive DPI/`MAX_PIXELS`, Fehlerpfad pro Seite, `SUBPROCESS_TIMEOUT_MS`. |
| 0.7 | Runtime | RAG-Knoten reicht `filter`, `filter_v2`, `path_prefix`, `hyde` durch; `ragProfiles`-Schema erweitert. |
| 0.8 | Flows | `vectorsearch/get_document_asset` (Collection-Pin) in den bereichsspezifischen und Assistant-Recherche-Flows; Entry-Flow-Versionen erhöht. |
| 0.9 | Eval/Docs | Dieser Abschlussbericht; Harness offline verifiziert; Runbook für Live-Baseline und Trace-Check. |

### Versionsstand der betroffenen Entry-Flows (aus 0.8)

Verifiziert im privaten Deployment-Repository unter
`aiperator/flows/flows/*.yaml` (`metadata.version`). Die konkreten
Flownamen der einzelnen Recherche-Bereiche (`<tenant-a>-*`, `<tenant-b>-*`) leben nur dort; hier
generisch gehalten:

| Flow | Version |
| --- | --- |
| `<tenant-a>-recherche` | 1.4.0 |
| `<tenant-a>-recherche-loop` | 2.3.0 |
| `<tenant-b>-recherche` | 1.21.0 |
| `<tenant-b>-recherche-loop` | 2.4.0 |
| `assistant` | 1.3.0 |

Diese Werte sind die Soll-Werte, die nach dem Deployment im Trace-Feld
`flow_version` erscheinen müssen (siehe §4).

## 2. Verifiziert in dieser Umgebung (offline)

- `bun run eval:test` — 21 Tests grün (Metriken + Fixture-Loader).
- `bun run eval:typecheck` — `tsc --noEmit` fehlerfrei.
- **Harness end-to-end im Offline-Modus:** gegen eine synthetische
  Captured-Responses-Datei mit Treffern für jede erwartete Seite/Abbildung
  liefert der Harness deterministisch Page/Figure Recall = 100 %, MRR = 1.0000,
  Figure-Hit-Rate = 100 % — Metriken, Referenzableitung und Reportgenerierung
  arbeiten korrekt.
- **Deterministische Baseline-Regenerierung:** aus leeren Responses regeneriert
  der Harness ein Skelett, das bis auf `generated_at`/`path` byte-identisch zum
  committeten `scripts/eval/baseline/retrieval.baseline.json` ist
  (`pending: true`, alle Metriken 0, Coverage: 120 Seiten-, 78 Abbildungs-,
  22 Tabellenzellen-Fragen).
- Flow-Versionen der fünf Entry-Flows stimmen mit den in 0.8 gesetzten Werten
  überein.
- `flow_version` im Debug-Trace wird direkt aus `metadata.version` des Entry-Flows
  gelesen (`apps/runtime/src/graph/graph-engine/handler-factories.ts`, Zuweisung
  `flowVersion = resolvedFlow.metadata?.version`), also genau das Feld, das 0.8
  erhöht hat.

## 3. Stand der Baseline

Die committete Baseline `scripts/eval/baseline/retrieval.baseline.{json,md}`
ist weiterhin ein **PENDING-Skelett** (`"pending": true`, alle Metriken 0). Sie
kann nicht in dieser Umgebung befüllt werden, weil dafür eine laufende
Search-Instanz mit den indexierten Golden-Dokumenten nötig ist. Ein echter
Vorher/Nachher-Vergleich ist erst nach einem Live-Lauf möglich; Metriken werden
**nicht** fingiert.

## 4. Runbook — was noch in einer Live-Umgebung zu tun ist

Voraussetzungen: laufende Search-, Extract- und Runtime-Dienste, Modell-Endpunkte,
Cluster-Zugriff sowie die Golden-Dokumente (bzw. das reale annotierte Fixture).

### (a) Golden-Dokumente indexieren

Die vier Golden-Dokumente (WMS-Pflichtenheft DOCX, BPMN-Prozessdokument,
Masken-Handbuch, Plansatz) über Extract in eine dedizierte Collection ingestieren.
Für reale Korpora das annotierte Fixture außerhalb des öffentlichen Trees halten
und via `--fixture <pfad>` übergeben.

```bash
# Collectionname z. B. "golden"; Dokumente über den regulären Ingest-Pfad einlesen.
```

### (b) Live-Baseline aufnehmen (Ist-Stand VOR den Phase-0-Fixes)

Am sinnvollsten auf einem Stand **vor** den Search-Änderungen 0.2–0.5 (bzw. auf
einer Vergleichs-Collection), damit "vorher" den unkorrigierten Zustand abbildet.

```bash
# 1) Live-Lauf aufnehmen und Rohantworten mitschneiden
bun run eval:retrieval -- \
  --collection golden --base-url http://127.0.0.1:3002 \
  --token <bearer-falls-AUTHN_MODE> --k 5,10 \
  --out reports/retrieval --label baseline \
  --capture scripts/eval/baseline/retrieval.baseline.responses.json

# 2) committete Baseline aus dem Mitschnitt einfrieren (deterministisch, offline)
bun run eval:retrieval -- --collection golden \
  --responses scripts/eval/baseline/retrieval.baseline.responses.json \
  --out scripts/eval/baseline/retrieval --label baseline
```

Ergebnis: `scripts/eval/baseline/retrieval.baseline.{json,md}` mit realen
Metriken (`pending` wird `false`).

### (c) Nach Phase 0 neu auswerten und diffen

Golden-Set gegen die Collection mit den Phase-0-Fixes erneut laufen lassen und
gegen die eingefrorene Baseline vergleichen:

```bash
bun run eval:retrieval -- \
  --collection golden --base-url http://127.0.0.1:3002 \
  --token <bearer> --k 5,10 \
  --out reports/retrieval --label phase-0-after \
  --capture reports/retrieval.phase-0-after.responses.json

# Vorher/Nachher-Diff (Page-/Figure-Recall, MRR, Figure-Hit-Rate) aus beiden JSONs:
#   scripts/eval/baseline/retrieval.baseline.json   (vorher)
#   reports/retrieval.phase-0-after.json            (nachher)
```

Optionale Release-Gates: `--min-page-recall 0.7 --min-figure-recall 0.5`
lassen den Prozess mit Exit-Code ≠ 0 abbrechen, wenn ein Floor nicht erreicht ist.
Der erwartete Effekt der Phase-0-Fixes ist ein Anstieg von Page- und
Figure-Recall sowie MRR gegenüber der Baseline.

### (d) Gebumpte Flows deployen

Die fünf Entry-Flows (§1) plus eingebundene Subflows/Prompts validieren und
ausrollen:

```bash
cli validate           # Flows validieren (aus 0.8)
# anschließend Deployment über den üblichen Flow-Deploy-Pfad des privaten
# Deployment-Repositories (aiperator/flows + deploy/)
```

### (e) `flow_version` im Debug-Trace verifizieren

Nach dem Deployment je einen Turn über jeden Entry-Flow ausführen und im
Execution-Debug-Trace das Feld `flow_version` prüfen. Es MUSS exakt der in 0.8
gesetzten `metadata.version` entsprechen:

| Flow | erwartetes `flow_version` |
| --- | --- |
| `<tenant-a>-recherche` | 1.4.0 |
| `<tenant-a>-recherche-loop` | 2.3.0 |
| `<tenant-b>-recherche` | 1.21.0 |
| `<tenant-b>-recherche-loop` | 2.4.0 |
| `assistant` | 1.3.0 |

Weicht ein Wert ab, ist der alte Flow-Stand ausgerollt — Deployment wiederholen.

## 5. Blockiert auf eine Live-Umgebung

Die folgenden Teilschritte von T0.9 **können in dieser Umgebung nicht** ausgeführt
werden und sind über den Runbook (§4) vom Nutzer abzuschließen:

- **Reale Golden-Set-Auswertung und Baseline** — kein laufender Search-Backend,
  keine indexierten Golden-Dokumente, keine Modell-Endpunkte. Die committete
  Baseline bleibt bis dahin ein PENDING-Skelett (§3).
- **Vorher/Nachher-Vergleichsbericht mit echten Zahlen** — hängt an der
  Live-Baseline.
- **Deployment und `flow_version`-Trace-Check** — kein Cluster/Deploy-Ziel und
  keine laufende Runtime verfügbar.

Alles, was ohne Live-Umgebung prüfbar ist (Harness-Korrektheit, deterministische
Reportgenerierung, Flow-Versionsstand, Herkunft von `flow_version`), ist in §2
verifiziert.
