<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Phase 2 Abschlussbericht (T2.10)

Phase 2 ("Extraktionsqualität") ist implementiert. Dieser Bericht fasst die
gelieferten Änderungen zusammen, dokumentiert die in dieser Umgebung
durchgeführte Verifikation, stellt die vom Eval-Harness berechneten
Extraktionsmetriken vor und hält den Vorher/Nachher-Vergleich gegen die Baseline
fest. Wie schon in Phase 0 und 1 sind die Schritte, die eine **Live-Umgebung**
brauchen (reale Golden-Auswertung, Deployment), als Runbook vorbereitet und nicht
fingiert.

_Requirements: 18.3, 18.4_

## 1. In Phase 2 gelieferte Änderungen

| Task | Bereich | Änderung |
| --- | --- | --- |
| 2.1 | Extract | Poppler-Textgeometrie (`-bbox-layout`), XHTML-Parser (Blöcke, Zeilen, Wörter mit normierter BBox); Stufe `analyzed`. |
| 2.2 | Extract | Seitenklassifikation `text \| scan \| drawing \| mixed`, Kopf-/Fußzeilenerkennung über rollierendes Fenster (`docpass_state`, `furniture`), Seiten-Deduplizierung per Render-Hash. |
| 2.3 | Extract | Prompt v2 für Pass 1: Abbildungen mit `kind`/`caption` und Kurzsummary, Überschriften mit Nummerierung, Tabellen-`continues`/`continuationOf`; Parser auf Blöcke v2; Prompt-Hash im Snapshot. |
| 2.4 | Extract | BBox-Snapping (3 % Erweiterung, Tinten-Trim, Ausrichtung an Textblöcken), `regionText` und `labels` aus den Wörtern innerhalb der BBox. |
| 2.5 | Extract | Pass 2 je Abbildungstyp (`process`, `fields`, `drawing`, `data`, `table_image`), Eingabe Ausschnitt + `regionText`, Label-Coverage-Prüfung mit einmaliger Wiederholung, Steuerung über `FIGURE_PASS2_KINDS`. |
| 2.6 | Extract | Streaming-Dokument-Pass: Gliederungsstapel, `sectionPath` je Block, Tabellen-Zusammenführung, Bildunterschriften/Querverweise, Bezeichner-Extraktion; Zustand je Seite in `docpass_state`, strikt in Seitenreihenfolge. |
| 2.7 | Extract | Summary-Hierarchie (Abschnitts-, Kapitel-, Dokument-Summary) je als Stufe mit Checkpoint. |
| 2.8 | Extract | Native Parser: DOCX-Überschriftenebenen, XLSX (exceljs), BPMN (Pools/Lanes/Tasks/Gateways/Flows → `process`, Asset `native:`), PPTX über LibreOffice. |
| 2.9 | Extract | Text-Fast-Path: deterministische Blockbildung aus der Geometrie für `text`-Seiten ohne Kandidaten, Summaries gebündelt; Fidelity-Gate mit Rückfall auf Vision, Anteil als Metrik. |
| 2.10 | Eval/Docs | Dieser Bericht; Extraktionsmetriken im Harness (Tabellenzellen, Label-Coverage, BPMN-Knoten-/Kanten-Recall); Golden-Set um Ground-Truth-Annotationen erweitert; Baseline erweitert; Deployment-Runbook. |

Phase 2 hat **keine Flows geändert.** Die Flow-Versionierungsregel
(`aiperator/flows/*`) ist hier daher nicht einschlägig; es wurde keine
`metadata.version` berührt.

## 2. Extraktionsmetriken (T2.10, Requirement 18.3)

Der Eval-Harness (`scripts/eval/`) berechnete bislang reine Retrieval-Metriken
(Recall@5/10 Seite und Abbildung, MRR, Figure-Hit-Rate — Task 0.1). Phase 2
ergänzt drei **Extraktionsqualitäts**-Metriken. Sie sind — wie die
Retrieval-Metriken — reine, deterministische Funktionen und laufen ohne Server,
Modell oder DB im Unit-Test.

| Metrik | Definition | Modul |
| --- | --- | --- |
| **Tabellenzellen-Genauigkeit** | Positionsbezogener Anteil der erwarteten Zellen, deren Wert (whitespace-normalisiert, case-insensitiv) mit der produzierten Zelle an derselben (Zeile, Spalte) übereinstimmt. Fehlende produzierte Zellen zählen als falsch. Rückgabe: Genauigkeit plus Zähler. | `tableCellAccuracy` |
| **Label-Coverage** (Eval-Variante) | Anteil der erwarteten Labels einer Abbildung, die im produzierten Transkript/Labeltext als whitespace-normalisierter, case-insensitiver Teilstring vorkommen. Spiegelt die Laufzeit-`labelCoverage` aus `apps/extract/src/vision/response.ts`, misst aber gegen die Golden-Ground-Truth statt gegen die eigene Ausgabe der Pipeline. | `labelCoverage` |
| **BPMN-Knoten- und Kanten-Recall** | Anteil der erwarteten Knoten (per id ODER Label) und der erwarteten Kanten (from→to, richtungssensitiv), die eine produzierte `process`-Transkription wiederfindet. Rückgabe: Knoten-Recall + Kanten-Recall plus Zähler. | `bpmnRecall` |

`aggregateExtractionMetrics` fasst diese über alle annotierten Fälle zusammen.
Die Mittelung ist **mikro** (Zähler poolen, dann teilen), sodass eine große
Tabelle proportional stärker in die Zellengenauigkeit eingeht als eine
Zwei-Zellen-Tabelle — die richtige Vorgabe für eine im Kern pro-Zelle definierte
Genauigkeit.

### Ground-Truth im Golden Set

Damit diese Metriken etwas zu messen haben, trägt jede betroffene Frage im
Golden Set jetzt eine optionale `extraction`-Annotation (Fixture-Version
`1.1.0`, rückwärtskompatibel zu `1.0.0` — das Feld ist optional):

- **Tabellen** (`expectedTable`): erwarteter Zelleninhalt als Zeilen-/Spaltengitter
  (WMS-Anforderungstabellen, Schriftfelder der Planblätter) — 22 Fragen, 112 Zellen.
- **Labels** (`expectedLabels`): erwartete Feld-/Maskenbeschriftungen
  (WMS-Feldlisten, UI-Masken) — 28 Fragen, 84 Labels.
- **BPMN** (`expectedNodes`/`expectedEdges`): erwartete Knoten und gerichtete
  Kanten der Teildiagramme — 20 Fragen, 80 Knoten, 60 Kanten.

Das Fixture bleibt **synthetisch** (kein vertraulicher Inhalt) und übersteht
`bun run verify:public`. Für reale Korpora wird ein eigenes annotiertes Fixture
außerhalb des öffentlichen Trees gehalten und via `--fixture` übergeben.

## 3. Vorher/Nachher gegen die Baseline (Requirement 18.4)

Was **offline** (in dieser Umgebung, ohne Live-Cluster) messbar ist:

- **Harness-Korrektheit.** Gegen einen synthetischen „perfekten" Mitschnitt der
  produzierten Extraktion (jede Zelle/jedes Label/jeder Knoten/jede Kante wie in
  der Ground-Truth) liefert der Harness deterministisch
  Tabellenzellen-Genauigkeit 100 %, Label-Coverage 100 %, BPMN-Knoten- und
  -Kanten-Recall je 100 % (112/112 Zellen, 84/84 Labels, 80/80 Knoten,
  60/60 Kanten). Metriken, Ground-Truth-Ableitung und Reportgenerierung arbeiten
  korrekt.
- **Baseline erweitert.** `scripts/eval/baseline/retrieval.baseline.{json,md}`
  enthält jetzt zusätzlich zum Retrieval-Block einen `extraction`-Block. Er ist —
  wie schon der Retrieval-Teil — ein **PENDING-Skelett**: die Zähler der
  erwarteten Elemente (112 Zellen / 84 Labels / 80 Knoten / 60 Kanten) stehen
  fest, die produzierten Werte sind 0, bis ein Live-Extract-Lauf über die
  Golden-Dokumente vorliegt.

Der eigentliche **Vorher/Nachher-Vergleich mit echten Zahlen** hängt an einem
Live-Lauf (§5): „vorher" ist die eingefrorene Baseline vor den Phase-2-Fixes,
„nachher" der Lauf gegen den Stand mit den Phase-2-Fixes. Es werden **keine**
Live-Cluster-Metriken fingiert.

| Metrik | Vorher (Baseline) | Nachher | Quelle |
| --- | --- | --- | --- |
| Tabellenzellen-Genauigkeit | _pending_ (0/112) | _Live-Lauf_ | `--extractions`-Mitschnitt |
| Label-Coverage | _pending_ (0/84) | _Live-Lauf_ | `--extractions`-Mitschnitt |
| BPMN-Knoten-Recall | _pending_ (0/80) | _Live-Lauf_ | `--extractions`-Mitschnitt |
| BPMN-Kanten-Recall | _pending_ (0/60) | _Live-Lauf_ | `--extractions`-Mitschnitt |

### Offline vs. Live — was misst was

- **Offline (hier verifiziert):** die Reinheit und Korrektheit der drei Metriken,
  die Ground-Truth-Annotationen im Fixture, die deterministische
  Report-/Baseline-Generierung. Der Harness selbst ist vollständig geprüft.
- **Live (Nutzer-Follow-up):** die tatsächlichen produzierten Werte. Sie
  entstehen erst, wenn Extract die Golden-Dokumente durch die Phase-2-Pipeline
  (native Parser, Pass 2 je Abbildungstyp, Streaming-Dokument-Pass) verarbeitet
  und die produzierten Tabellen/Labels/`process`-Transkriptionen je Frage-ID als
  `--extractions`-Mitschnitt vorliegen.

## 4. In dieser Umgebung verifiziert (offline)

- `bun run eval:test` — 46 Tests grün (Retrieval-Metriken, Extraktionsmetriken,
  Fixture-Loader inkl. Annotationen); zuvor 21.
- `bun run eval:typecheck` — `tsc --noEmit` fehlerfrei.
- `bun run eval:fixture` — regeneriert `golden-set.v1.json` deterministisch
  (Version `1.1.0`, 4 Dokumente, 120 Fragen, Annotationen validiert).
- **Harness end-to-end im Offline-Modus:** „perfekter" Mitschnitt → alle vier
  Extraktionsmetriken 100 %; leerer Mitschnitt → `pending`, alle 0 mit korrekten
  Erwartungszählern.
- `bun run lint:baseline` — „At baseline" (202 Fehler, 659 Warnungen unverändert).

## 5. Runbook — was noch in einer Live-Umgebung zu tun ist

Voraussetzungen: laufende Extract- und Search-Dienste, Modell-Endpunkte,
Cluster-Zugriff und die Golden-Dokumente (bzw. das reale annotierte Fixture).

### (a) Golden-Dokumente durch die Phase-2-Pipeline verarbeiten

Die vier Golden-Dokumente über Extract in eine dedizierte Collection ingestieren,
sodass die Phase-2-Stufen (native Parser, Pass 2 je Abbildungstyp,
Streaming-Dokument-Pass, Text-Fast-Path) laufen und Einheiten emittieren.

### (b) Produzierte Extraktion je Frage mitschneiden

Aus den emittierten Einheiten je Golden-Frage die produzierte Extraktion
zusammenstellen (Tabelle aus `table`/`data`-Block, Labeltext aus der
Figure-Transkription, `process`-Knoten/-Kanten) und als JSON
`Frage-ID → { table?, text?, process? }` ablegen.

### (c) Offline scoren und diffen

```bash
# Extraktionsmetriken gegen die Ground-Truth des Fixtures scoren:
bun run eval:retrieval -- --collection golden \
  --responses reports/retrieval.phase-2-after.responses.json \
  --extractions reports/extractions.phase-2-after.json \
  --out reports/retrieval --label phase-2-after
```

Ergebnis: der `extraction`-Block im Report trägt reale Werte (`pending: false`).
Der Vorher/Nachher-Vergleich difft `scripts/eval/baseline/retrieval.baseline.json`
(vorher) gegen `reports/retrieval.phase-2-after.json` (nachher).

### (d) Live-Baseline einfrieren (optional)

Sobald ein Live-Extract-Stand als „vorher" dienen soll, den Mitschnitt in
`scripts/eval/baseline/` einfrieren (analog zum Retrieval-Baseline-Verfahren in
`scripts/eval/README.md`).

## 6. Deployment-Runbook (Phase 2)

Phase 2 änderte die **Extraktionspipeline** (Prompts, Parser, Stufen), aber
**keine Flows** und keine öffentlichen Verträge. Das Deployment ist damit ein
reiner Extract-Rollout; es braucht einen Live-Cluster und ist ein
**Nutzer-Follow-up**. Es wird hier kein Deployment ausgeführt und es werden keine
Deployment-Metriken erfunden.

### Was auszurollen ist

- Der Extract-Dienst mit dem Phase-2-Stand (native Parser, Pass 2 je
  Abbildungstyp, Streaming-Dokument-Pass, Text-Fast-Path, Prompt v2).
- Ggf. das Base-Image, falls Poppler `-bbox-layout` nicht enthält (Task 2.1).

### Wie zu verifizieren ist (nach dem Rollout)

- **Pipeline-Version / Prompt-Hash auf den Einheiten.** Jede emittierte Einheit
  trägt `extract_pipeline_version`, `contract` und den Prompt-Hash in den
  Metadaten (Requirement 18.2). Nach dem Rollout an einem frisch verarbeiteten
  Dokument prüfen, dass der Prompt-Hash dem Phase-2-Stand entspricht — so ist
  belegt, dass Prompt v2 (2.3) und nicht der alte Prompt ausgerollt ist.
- **Metriken auf `/metrics`.** Die Stufen-Metriken (Requirement 18.1) auf dem
  Extract-`/metrics`-Endpunkt prüfen: insbesondere den **Fast-Path-Anteil** (2.9)
  und die **Label-Coverage** (2.5) — beide sollten für die verarbeiteten
  Dokumente plausible Werte zeigen (Fast-Path > 0 für textreiche Dokumente,
  Label-Coverage nahe dem in der Prüfung mit Wiederholung erzwungenen Niveau).
- **`flow_version` im Trace — nicht einschlägig.** Phase 2 änderte keine Flows;
  es gibt daher kein neues `flow_version` zu prüfen. Der Wert bleibt auf dem in
  Phase 0 (0.8) gesetzten Stand. Sollte ein späterer Task Flows ändern, greift die
  Flow-Versionierungsregel wieder.

## 7. Blockiert auf eine Live-Umgebung

- **Reale Extraktionsmetriken (vorher/nachher mit echten Zahlen)** — kein
  laufender Extract-Backend, keine verarbeiteten Golden-Dokumente, keine
  Modell-Endpunkte. Der `extraction`-Block der Baseline bleibt bis dahin ein
  PENDING-Skelett (§3).
- **Deployment und Post-Rollout-Verifikation (Prompt-Hash, `/metrics`)** — kein
  Cluster/Deploy-Ziel verfügbar; über das Runbook (§6) vom Betreiber abzuschließen.

Alles, was ohne Live-Umgebung prüfbar ist (Metrik-Korrektheit, Ground-Truth im
Fixture, deterministische Report-/Baseline-Generierung, Lint- und Typ-Stand), ist
in §4 verifiziert. Es wird kein Deployment und werden keine Metriken fingiert.
