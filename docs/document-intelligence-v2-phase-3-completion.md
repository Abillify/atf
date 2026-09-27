<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Phase 3 Abschlussbericht (T3.10)

Phase 3 ("Index und Retrieval") ist implementiert. Dieser Bericht fasst die
gelieferten Änderungen zusammen, dokumentiert die in dieser Umgebung
durchgeführte Verifikation, stellt die vom Eval-Harness berechneten
**Retrieval**-Metriken vor, inventarisiert die **Tuning-Stellschrauben**, die ein
Phase-3-Betreiber dreht, und hält den Vorher/Nachher-Vergleich gegen die Baseline
fest. Wie schon in Phase 0, 1 und 2 sind die Schritte, die eine **Live-Umgebung**
brauchen (reale Golden-Auswertung, Deployment), als Runbook vorbereitet und nicht
fingiert.

_Requirements: 18.3, 18.4_

## 1. In Phase 3 gelieferte Änderungen

| Task | Bereich | Änderung |
| --- | --- | --- |
| 3.1 | Search | Token-Budgetierung: Token-Zählung über TEI `/tokenize` (bge-m3) mit Cache, Heuristik als Fallback (`countBatch`). |
| 3.2 | Search | Vollständiger Unit-Builder aus Blöcken: `chunk` (350–500 Token, abschnittstreu), `table` (Zeilengruppen mit Kopf), `figure` (Caption/Summary/Transkription/Labels), `section`, `page`, `document`; Beziehungsgraph `parent`/`prev`/`next`/`figure_refs`/`block_ids`; ersetzt den Übergangs-Builder aus 1.10. Schema 13 fügt die dafür nötigen Unit-Spalten hinzu. |
| 3.3 | Search | Kontextueller Header (behebt D1): Titel, Abschnittspfad, Seiten, Typ und Seiten-Summary, höchstens 15 % des Chunk-Budgets, nur auf `embedInput` (nie `content`/FTS); optional `CONTEXTUAL_CHUNK_LLM` mit einem Einordnungssatz pro Chunk als Batch-Worker-Stufe. |
| 3.4 | Search | Lexik und Bezeichner (behebt D9): `ts_de`/`ts_ident` (eigene `simple`-Normalisierung für Codes wie `WE-01/A`), Tabelle `vs_identifiers`, Bezeichner-Erkennung in der Anfrage und eine **dritte RRF-Liste** mit konfigurierbaren Gewichten. Schema 14 fügt `ts_ident` und die GIN-Indizes hinzu. |
| 3.5 | Search | Rerank-mit-Kontext (Input aus Titel/Pfad/Typ/Inhalt, ≤ 1024 Token), Diversifizierung (Zusammenfassen gleicher Tabellen/Abbildungen, Kappung pro Abschnitt) und `group_by: section`. |
| 3.6 | Search | Small-to-Big-Expansion: `expand: neighbors \| section \| page` mit `budget_chars` und `truncated`, nach Diversifizierung und vor Asset-Attach. |
| 3.7 | Search | Antwortformat v2 und `POST /v2/search`: Treffer mit `section_path`, `pages`, `expanded`, `assets[]`, `navigation`, `evidence`; Filter/Parameter nach Requirement 13.3. `/search` v1 **unverändert** (Requirement 13.7). |
| 3.8 | Extract/Search | Rendering bei Bedarf: Extract `POST /v2/render` (Quelle, Seite, BBox, Ziel-Pixel) mit Pixel-/Ratenlimit; Search ruft den Endpunkt für `region`/`full` auf und cacht das Ergebnis als Asset-Variante (Zoom-Cache). |
| 3.9 | Search | MCP-Navigationswerkzeuge: `search` (v2-Parameter), `get_outline`, `get_section`, `get_pages`, `get_context`, `list_figures`, `get_asset`, `get_table`, `find_identifier`, `follow_ref` mit Paginierung und Größenlimits. |
| 3.10 | Eval/Docs | Dieser Bericht; Retrieval-Metriken für Phase 3 im Harness gegen `/v2/search` ausrichtbar (`--v2`); Tuning-Stellschrauben-Inventar; Vorher/Nachher gegen die Baseline; Deployment-Runbook. |

Phase 3 hat **keine Flows geändert.** Die Flow-Versionierungsregel
(`aiperator/flows/*`) ist hier daher nicht einschlägig; es wurde keine
`metadata.version` berührt. `/v2/search` und die MCP-Werkzeuge sind additiv, der
v1-`/search`-Pfad bleibt unverändert.

## 2. Retrieval-Metriken (T3.10, Requirement 18.3)

Der Eval-Harness (`scripts/eval/`) berechnet die **Retrieval**-Seite aus Task 0.1
(die Extraktionsseite kam in Task 2.10 dazu). Es sind reine, deterministische
Funktionen (`metrics.ts`), die ohne Server aus einem Mitschnitt der Suchtreffer
scoren.

| Metrik | Definition | Modul |
| --- | --- | --- |
| **Page Recall@k** | Anteil der erwarteten Seiten, die innerhalb der Top-_k_ auftauchen, gemittelt über Seitenfragen. | `pageMetrics` |
| **Figure Recall@k** | dasselbe über erwartete Abbildungen; ein Treffer ist eine Abbildung, wenn er die Abbildung des Treffers selbst ist. | `figureMetrics` |
| **MRR** | Reziproker Rang des ersten korrekten Treffers (beliebige Granularität), gemittelt über Fragen. | `overallMrr` |
| **Figure-Hit-Rate@k** | Anteil der Abbildungsfragen mit mindestens einer erwarteten Abbildung in den Top-_k_. | `figureHitRate` |

Referenzen werden aus dem Trefferkontrakt abgeleitet: Dokument → `base_ref`,
Seite → `base_ref#page=<n>` für jede Seite in `page_start..page_end`, Abbildung →
`base_ref#figure=<figure_id>`, wenn der Treffer selbst eine Abbildung ist.

### Der Harness gegen `/v2/search` (`--v2`, neu in T3.10)

Bislang lief der Harness gegen v1 `POST /search`. Damit die **Phase-3-Pipeline**
(Bezeichner-RRF aus 3.4, Rerank-mit-Kontext und Diversifizierung aus 3.5,
Small-to-Big-Expansion aus 3.6) messbar wird, kann er mit dem Flag `--v2` jetzt
dieselben Golden-Fragen gegen `POST /v2/search` (Task 3.7) laufen lassen:

```bash
bun run eval:retrieval -- --collection golden --base-url <url> --v2 \
  --k 5,10 --out reports/retrieval --label phase-3-after \
  --capture reports/retrieval.phase-3-after.responses.json
```

Der v2-Treffer (Top-Level-`pages`, `assets[]`) wird über eine reine Funktion
(`normalizeV2Hit`) auf **dieselbe** referenztragende Form abgebildet, die der
v1-Pfad nutzt. Dadurch sind die Metriken und das Reportlayout **identisch und
direkt vergleichbar** — es unterscheiden sich nur Endpunkt und Request-Body. Ein
Abbildungstreffer ist ein Asset mit `relation:"hit"` und `figure_id` (das
v2-Äquivalent zu v1s Bild-Evidenz); referenzierte Abbildungen zählen — wie in v1
— nicht als eigene Abbildung des Treffers. Der Report hält unter
`parameters.endpoint` (`"v1"`/`"v2"`) fest, welchen Endpunkt ein Lauf getroffen
hat. Der v1-`/search`-Pfad des Harness bleibt der Weg für die v1-Baseline.

## 3. Tuning-Stellschrauben (Phase-3-Tuningfläche, design §7)

Dies ist eine **Dokumentation der Stellschrauben**, kein Live-Tuning-Lauf. Ein
Phase-3-Betreiber tunt Chunkgröße, RRF-Gewichte und den Kandidaten-Multiplikator
(sowie einige verwandte Regler) und misst den Effekt über den Harness (§2). Alle
Defaults stammen aus `apps/search/src/config.ts` bzw. den genannten Modulen.

| Stellschraube | Env / Option | Default | Was sie abwägt |
| --- | --- | --- | --- |
| **Chunk-Untergrenze** | `minChunkTokens` (Batch-Worker, Task 3.2) | 350 | Kleiner ⇒ präzisere, aber kontextärmere Einheiten; größer ⇒ mehr Kontext pro Einheit, gröbere Treffer. |
| **Chunk-Obergrenze** | `maxChunkTokens` (Batch-Worker, Task 3.2) | 500 | Deckelt Chunk und Tabellen-Zeilengruppe; zugleich das Token-Budget, an dem der kontextuelle Header (15 %) bemessen wird. |
| **RRF-Gewicht dicht** | `RRF_WEIGHT_DENSE` | 1.0 | Gewicht der dichten (Vektor-)Liste in der Fusion; höher ⇒ semantische Ähnlichkeit dominiert. |
| **RRF-Gewicht Volltext** | `RRF_WEIGHT_FTS` | 1.0 | Gewicht der Volltext-Liste; höher ⇒ lexikalische Übereinstimmung dominiert. |
| **RRF-Gewicht Bezeichner** | `RRF_WEIGHT_IDENTIFIER` | 1.0 | Gewicht der dritten Liste (exakte Bezeichner, Task 3.4); höher ⇒ Codes wie `WE-01/A` ziehen ihre Einheit stärker nach oben. Alle drei auf 1.0 ⇒ ungewichtetes Ranking wie zuvor. |
| **Kandidaten-Multiplikator** | `RERANK_CANDIDATE_MULTIPLIER` (`rerankCandidateMultiplier`) | 4 | Wie viele Kandidaten pro Trefferfenster vorab geholt werden (Kandidatenpool = `limit × Multiplikator`), bevor Rerank/Diversifizierung/Collapse das Fenster füllen; höher ⇒ mehr Recall-Spielraum, mehr Rechenlast. |
| **Header-Anteil** | `CONTEXT_HEADER_MAX_FRACTION` (Task 3.3) | 0.15 | Höchstanteil des Chunk-Budgets, den der kontextuelle Header belegen darf; höher ⇒ mehr Einordnung im Embedding, weniger Platz für den eigentlichen Inhalt. |
| **Kontext-LLM** | `CONTEXTUAL_CHUNK_LLM` (Task 3.3) | `false` | Schaltet den Einordnungssatz pro Chunk über das Text-LLM zu; an ⇒ reichere Header, aber der Vektor ist nicht mehr byte-reproduzierbar und es entstehen Text-LLM-Kosten. |
| **Diversifizierung pro Abschnitt** | `perSectionCap` (`DEFAULT_SECTION_CAP`, Task 3.5) | 3 | Höchstzahl Treffer pro Abschnittspfad; niedriger ⇒ breitere Streuung über Abschnitte, höher ⇒ mehr Treffer aus einem starken Abschnitt. ≤ 0 deaktiviert die Kappung (Tabellen-/Abbildungs-Collapse läuft weiter). |
| **Expansions-Budget** | `budget_chars` (`DEFAULT_EXPAND_BUDGET_CHARS`, Task 3.6) | 4000 | Zeichenbudget der Small-to-Big-Expansion; höher ⇒ mehr Umgebungskontext pro Treffer, längere Antworten; meldet `truncated`, wenn Einheiten wegfallen mussten. |

## 4. Vorher/Nachher gegen die Baseline (Requirement 18.4)

Was **offline** (in dieser Umgebung, ohne Live-Cluster) messbar ist:

- **Harness-Korrektheit, auch auf dem v2-Pfad.** Gegen einen synthetischen
  „perfekten" Mitschnitt (jede erwartete Seite/Abbildung als Treffer) liefert der
  Harness im `--v2`-Modus deterministisch Page Recall = 100 %, Figure Recall =
  100 %, MRR = 1.0000, Figure-Hit-Rate = 100 %; gegen einen leeren Mitschnitt
  `pending`, alle Metriken 0. Die neue `normalizeV2Hit`-Abbildung, die
  Referenzableitung und die Reportgenerierung arbeiten korrekt (Unit-Tests §5).
- **Baseline unverändert als Bezug.** `scripts/eval/baseline/retrieval.baseline.{json,md}`
  ist weiterhin ein **PENDING-Skelett** (`"pending": true`, alle Retrieval-Metriken
  0, Coverage: 120 Seiten-, 78 Abbildungsfragen). Sie ist der eingefrorene
  „Vorher"-Stand; Phase 3 ändert an ihr nichts (Requirement 18.4 verlangt einen
  Bericht, kein Überschreiben der Baseline).

Der eigentliche **Vorher/Nachher-Vergleich mit echten Zahlen** hängt an einem
Live-Lauf (§6): „vorher" ist die eingefrorene v1-Baseline, „nachher" der
`--v2`-Lauf gegen die Collection mit dem Phase-3-Index/-Retrieval. Es werden
**keine** Live-Cluster-Metriken fingiert.

| Metrik | Vorher (Baseline, v1 `/search`) | Nachher (Phase 3, `--v2` `/v2/search`) | Quelle |
| --- | --- | --- | --- |
| Page Recall@5/10 | _pending_ (0) | _Live-Lauf_ | `--capture`-Mitschnitt |
| Figure Recall@5/10 | _pending_ (0) | _Live-Lauf_ | `--capture`-Mitschnitt |
| MRR@5/10 | _pending_ (0) | _Live-Lauf_ | `--capture`-Mitschnitt |
| Figure-Hit-Rate@5/10 | _pending_ (0) | _Live-Lauf_ | `--capture`-Mitschnitt |

### Offline vs. Live — was misst was

- **Offline (hier verifiziert):** die Reinheit und Korrektheit der
  Retrieval-Metriken, die `normalizeV2Hit`-Abbildung des v2-Treffers, das
  Tuning-Stellschrauben-Inventar (§3), die deterministische
  Report-/Baseline-Generierung. Der Harness selbst — inklusive des neuen
  `--v2`-Pfads — ist vollständig geprüft.
- **Live (Nutzer-Follow-up):** die tatsächlichen Recall-/MRR-Werte. Sie entstehen
  erst, wenn eine Search-Instanz mit dem Phase-3-Index/-Retrieval die
  Golden-Dokumente indexiert hat und die Golden-Fragen über `--v2` gegen
  `/v2/search` laufen.

## 5. In dieser Umgebung verifiziert (offline)

- `bun run eval:test` — 53 Tests grün (Retrieval-Metriken, Extraktionsmetriken,
  Fixture-Loader **und** die neue `normalizeV2Hit`-Suite); zuvor 46.
- `bun run eval:typecheck` — `tsc --noEmit` fehlerfrei (inkl. der `--v2`-Wiring).
- **Harness end-to-end im Offline-`--v2`-Modus:** „perfekter" Mitschnitt → Page/
  Figure Recall, MRR und Figure-Hit-Rate je 100 %; leerer Mitschnitt → `pending`,
  alle 0; `parameters.endpoint` = `"v2"` im Report.
- `bun run lint:baseline` — „At baseline" (202 Fehler, 659 Warnungen unverändert).

## 6. Runbook — was noch in einer Live-Umgebung zu tun ist

Voraussetzungen: eine laufende Search-Instanz mit dem Phase-3-Index/-Retrieval-Build,
die Golden-Dokumente in einer dedizierten Collection indexiert, Modell-Endpunkte
(Embedding, optional Reranker/Text-LLM), Cluster-Zugriff.

### (a) v1-Baseline als „Vorher" einfrieren (falls noch nicht geschehen)

Analog zum Verfahren aus Phase 0 (`scripts/eval/README.md`): einen v1-`/search`-Lauf
über die Golden-Dokumente mitschneiden und in `scripts/eval/baseline/` einfrieren.

### (b) Phase-3-Lauf über `/v2/search` aufnehmen

```bash
bun run eval:retrieval -- --collection golden --base-url <url> --v2 \
  --k 5,10 --out reports/retrieval --label phase-3-after \
  --capture reports/retrieval.phase-3-after.responses.json
```

### (c) Vorher/Nachher diffen

Den `--v2`-Report (`reports/retrieval.phase-3-after.json`, „nachher") gegen die
eingefrorene v1-Baseline (`scripts/eval/baseline/retrieval.baseline.json`,
„vorher") vergleichen. Erwarteter Effekt der Phase-3-Pipeline: höherer Page-/
Figure-Recall und MRR — insbesondere für Bezeichner-Fragen (RRF-Liste aus 3.4)
und für Abbildungen (Diversifizierung/Collapse aus 3.5). Optionale Release-Gates
(`--min-page-recall`, `--min-figure-recall`) brechen mit Exit-Code ≠ 0 ab, wenn
ein Floor gerissen wird.

### (d) Tuning (optional, §3)

Chunkgröße (`minChunkTokens`/`maxChunkTokens`), RRF-Gewichte
(`RRF_WEIGHT_*`) und den Kandidaten-Multiplikator
(`RERANK_CANDIDATE_MULTIPLIER`) verstellen, neu indexieren bzw. neu suchen und
den `--v2`-Lauf wiederholen; den Effekt am Vorher/Nachher aus (c) ablesen.

## 7. Deployment-Runbook (Phase 3)

Phase 3 änderte die **Index-/Retrieval-Pipeline** und fügte den `/v2/render`-Pfad
in Extract hinzu, aber **keine Flows** und keinen v1-Vertrag (`/search` bleibt
unverändert). Das Deployment braucht einen Live-Cluster und ist ein
**Nutzer-Follow-up**; es wird hier kein Deployment ausgeführt und es werden keine
Deployment-Metriken erfunden.

### Was auszurollen ist

- **Search** mit dem Phase-3-Index/-Retrieval-Build (Unit-Builder 3.2,
  kontextueller Header 3.3, Bezeichner-RRF 3.4, Rerank-mit-Kontext/Diversifizierung
  3.5, Small-to-Big 3.6, `/v2/search` 3.7, MCP-Werkzeuge 3.9).
- **Collection-Migration auf Schema 14** für `ts_ident` und die
  `vs_identifiers`-Tabelle, plus die **Schema-13-Unit-Spalten** (Beziehungsgraph,
  `figure_refs`, `table_id`). Beide laufen **automatisch** über den
  Migrations-/DDL-Rahmen beim Search-Start (`CURRENT_SCHEMA_VERSION = 14`); die
  Spalten/Indizes sind additiv und nullable, sodass eine Legacy-/v1-Zeile
  unverändert wie zuvor durchsucht wird.
- **Extract** mit dem Phase-3-Build für `POST /v2/render` (On-Demand-Render mit
  Pixel-/Ratenlimit), den der Zoom-Cache in Search bedient.

### Wie zu verifizieren ist (nach dem Rollout)

- **Unit-Typ-Verteilung / `/v2/search` liefert v2-Treffer.** Eine Suche über
  `/v2/search` gegen eine frisch verarbeitete Collection prüfen: Treffer tragen
  `unit_type`, `section_path`, `pages`, `navigation` und — je nach
  `include_assets` — `assets[]`. Die Unit-Typen sollten die volle Bandbreite
  (`chunk`/`table`/`figure`/`section`/`page`/`document`) zeigen.
- **Bezeichner-RRF feuert.** Eine Anfrage mit einem Code (z. B. `WE-01/A`)
  stellen und prüfen, dass die exakt passende Einheit nach oben gezogen wird —
  Beleg, dass die dritte RRF-Liste (3.4) aktiv ist.
- **`ts_ident`/`vs_identifiers` befüllt.** Nach der Verarbeitung eines Dokuments
  mit Bezeichnern prüfen, dass `vs_identifiers` Zeilen für die Collection trägt
  und die betroffenen Einheiten ein nicht-leeres `ts_ident` haben (Schema 14
  angewandt).
- **Render-Cache bedient einen Zoom.** Einen `region`/`full`-Render über den
  Search-Asset-Pfad anfordern und prüfen, dass das Ergebnis als Asset-Variante
  gecacht wird (der zweite Aufruf trifft den Cache, statt erneut Extract
  `/v2/render` zu bemühen).
- **`flow_version` im Trace — nicht einschlägig.** Phase 3 änderte keine Flows;
  es gibt daher kein neues `flow_version` zu prüfen. Der Wert bleibt auf dem in
  Phase 0 (0.8) gesetzten Stand. Sollte ein späterer Task Flows ändern, greift
  die Flow-Versionierungsregel wieder.

## 8. Blockiert auf eine Live-Umgebung

- **Reale Retrieval-Metriken (vorher/nachher mit echten Zahlen)** — kein
  laufender Search-Backend, keine indexierten Golden-Dokumente, keine
  Modell-Endpunkte. Die Baseline bleibt bis dahin ein PENDING-Skelett (§4).
- **Deployment und Post-Rollout-Verifikation** (Unit-Typ-Verteilung,
  Bezeichner-RRF, `ts_ident`/`vs_identifiers`, Render-Cache) — kein
  Cluster/Deploy-Ziel verfügbar; über das Runbook (§7) vom Betreiber
  abzuschließen. Die Schema-13/14-Migrationen laufen dabei automatisch beim
  Search-Start.

Alles, was ohne Live-Umgebung prüfbar ist (Metrik-Korrektheit inkl. des
`--v2`-Pfads, das Tuning-Stellschrauben-Inventar, die deterministische
Report-Generierung, Lint- und Typ-Stand), ist in §5 verifiziert. Es wird kein
Deployment und werden keine Metriken fingiert.
