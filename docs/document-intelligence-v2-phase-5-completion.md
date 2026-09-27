<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Phase 5 Abschlussbericht (T5.7)

Phase 5 ("Skalierung und Feinschliff") ist implementiert. Dieser Bericht
schließt zugleich das **Gesamtvorhaben Document Intelligence v2** ab. Er fasst
die in Phase 5 gelieferten Änderungen zusammen (Tasks 5.1–5.6), stellt die
**finale End-to-End-Evaluationsmethodik gegen die v1-Baseline** vor — die
vorhandenen Eval-Werkzeuge aus den Phasen 0, 2 und 3 zu einem Gesamtlauf
verdrahtet —, gibt dem Betreiber die exakten Kommandos und das
**Deployment-/Verifikations-Runbook** an die Hand und hält die beim Feinschliff
aufgetauchten **Follow-ups** als Betreiber-/Governance-Punkte fest. Wie in allen
vorigen Phasenabschlüssen (Phase 0–4) gilt die strikte **Offline-vs.-Live-Trennung**:
Alles ohne Live-Cluster Prüfbare ist hier verifiziert; jede konkrete Vorher/Nachher-Zahl
ist als „auf dem Zielcluster zu messen" gekennzeichnet und **nicht fingiert**. Diese
Umgebung hat keinen Cluster, kein GPU/vLLM und kein befülltes Korpus.

_Requirements: 18.4, 1.2_

## 1. In Phase 5 gelieferte Änderungen

| Task | Bereich | Änderung |
| --- | --- | --- |
| 5.1 | Extract | Kacheln für Großformate: `drawing`-Seiten bzw. Seiten über A3 werden in ein N×M-Raster mit 10 % Überlappung zerlegt (`TILE_TARGET_PIXELS`/`TILE_OVERLAP_FRACTION`/`TILE_MAX_PER_PAGE`); jede Kachel wird als eigene Stufe transkribiert und zusammengeführt; Kacheln werden als `tile:`-Assets gespeichert; der Zoom (Requirement 14.4) bedient eine BBox bevorzugt aus der überdeckenden Kachel statt aus der ganzen Seite (`handlers/render.ts` rekonstruiert dasselbe Kachelraster). |
| 5.2 | Extract | Queue-Lanes und Fairness: Jobs über `LARGE_JOB_PAGE_THRESHOLD` Seiten laufen in einer eigenen Lane mit begrenzter Parallelität (`LARGE_JOB_MAX_CONCURRENCY`, Default 1); Prioritäten, Budget-Warnung bei 80 %, Restzeitschätzung (`jobs/job-view.ts`, durchsatzbasiert `remaining × perUnit`). |
| 5.3 | Extract/Docs | Durchsatz-Tuning: `PAGE_CONCURRENCY` gegen die vLLM-Batch-Kapazität; wiederholbares Mess-Werkzeug `apps/extract/scripts/throughput-sweep.ts` mit dem unit-getesteten reinen Kern `jobs/throughput-tuning.ts` (Sweep-Planung, vLLM-`/metrics`-Parser, Pages/min- und Knie-Analyse); Prozedur in DEPLOYMENT.md. |
| 5.4 | Extract | Finalize-Pass: nach Dokumentende korrigiert `docpass/document-pass.ts#finalizeOutline` die Gliederungs-Metadaten deterministisch und **modellfrei**; selektives Re-Embedding **nur** der Einheiten, deren Überschriftenpfad sich geändert hat (`FINALIZE_PASS`, Default `true`). |
| 5.5 | Extract | Nativer VSDX-Parser (`pipeline/native/vsdx.ts`): Shape-Texte und Konnektoren → `process` bzw. `diagram`, `native:`-Asset; Rendering über LibreOffice. **Keine neue Abhängigkeit** — wiederverwendet fflate + fast-xml-parser aus Task 2.8. |
| 5.6 | Extract | Migration der Bestandskorpora: Re-Ingest-CLI `apps/extract/scripts/corpus-migrate.ts` mit reinem Kern `jobs/corpus-migration.ts`; `version`-Modus (alte Revision bleibt sichtbar bis zum Commit der neuen), Reihenfolge nach Nutzung (Req 17.3), Nachweis stabiler Asset-IDs über `buildAssetId` (Req 17.4). |
| 5.7 | Eval/Docs | Dieser Abschlussbericht; finale End-to-End-Evaluationsmethodik gegen die Baseline; Aktualisierung von README, ARCHITECTURE, DEPLOYMENT, CHANGELOG; Bestätigung, dass THIRD_PARTY_NOTICES unverändert bleibt. |

Phase 5 hat **keine Flows geändert.** Die Flow-Versionierungsregel
(`aiperator/flows/*.yaml`) ist hier daher nicht einschlägig; es wurde keine
`metadata.version` berührt. Der zuletzt in Phase 4 (Task 4.4) gesetzte
Flow-Stand bleibt unverändert (siehe §4). Phase 5 hat außerdem **keine neue
Laufzeit-Abhängigkeit** eingeführt: Der VSDX-Parser (5.5) nutzt die bereits in
Phase 2 aufgenommenen, permissiv lizenzierten Bibliotheken fflate und
fast-xml-parser weiter (Requirement 1.2, §6).

## 2. Finale End-to-End-Evaluation gegen die Baseline (Requirement 18.4)

Dies ist der **Endbericht** des Gesamtvorhabens: er verdrahtet die über die
Phasen entstandenen Eval-Werkzeuge zu einem einzigen Vorher/Nachher-Lauf gegen
die eingefrorene **v1-Baseline** (aus Task 0.1). Alle Werkzeuge sind reine,
deterministische Funktionen bzw. dünne Treiber, die offline planen und erst mit
`--base-url`/Cluster reale Zahlen erzeugen. **Es werden keine Benchmark-Zahlen
fingiert.** Jede konkrete Vorher/Nachher-Zelle unten ist als „auf dem Zielcluster
zu messen" gekennzeichnet.

### Die drei Messachsen und ihre Werkzeuge

| Achse | Werkzeug (bereits vorhanden) | Task | Metriken |
| --- | --- | --- | --- |
| **Retrieval** | `scripts/eval/retrieval.ts` (`bun run eval:retrieval`), `--v2`-Modus | 0.1, 3.10 | Page/Figure Recall@5/10, MRR, Figure-Hit-Rate |
| **Extraktion** | derselbe Harness, `--extractions`-Capture; `scripts/eval/extraction-metrics.ts` | 2.10 | Tabellenzellen-Genauigkeit, Label-Coverage, BPMN-Knoten-/Kanten-Recall |
| **Durchsatz** | `apps/extract/scripts/throughput-sweep.ts` (Kern `throughput-tuning.ts`) | 5.3 | Pages/min, mittlere/95p-Latenz, vLLM-Batch-Auslastung, Knie |

Zusätzlich bietet die Search-seitige Eval-Infrastruktur
(`apps/search/src/retrieval-evaluation.ts` + `handlers/evaluation.ts`) den
serverseitigen Bewertungspfad; der Golden-Set trägt die Soll-Annotationen
(Seite, Abbildung, Tabellenzelle, BPMN-Knoten/-Kanten) als versionierte Fixture
ohne vertrauliche Inhalte (`scripts/eval/golden-set/`, Task 0.1).

### Exakte Betreiber-Kommandos (auf dem Zielcluster)

Voraussetzungen: eine laufende Search-Instanz mit dem v2-Index/-Retrieval-Build,
die Golden-Dokumente über die v2-Pipeline in einer dedizierten Collection
indexiert, Modell-Endpunkte (Embedding, optional Reranker/Text-LLM), für die
Durchsatzachse ein erreichbarer vLLM mit `/metrics`.

**(a) Retrieval — v1-Baseline als „Vorher" (falls noch nicht eingefroren):**

```bash
# v1 /search über die Golden-Dokumente mitschneiden und in scripts/eval/baseline/ einfrieren
# (Verfahren aus Phase 0, siehe scripts/eval/README.md)
bun run eval:retrieval -- --collection golden --base-url <url> \
  --k 5,10 --out reports/retrieval --label baseline \
  --capture reports/retrieval.baseline.responses.json
```

**(b) Retrieval — v2 als „Nachher" (die volle v2-Pipeline: Bezeichner-RRF 3.4,
Rerank-mit-Kontext/Diversifizierung 3.5, Small-to-Big 3.6):**

```bash
bun run eval:retrieval -- --collection golden --base-url <url> --v2 \
  --k 5,10 --out reports/retrieval --label v2-final \
  --capture reports/retrieval.v2-final.responses.json
```

**(c) Extraktion — Tabellenzellen, Label-Coverage, BPMN-Knoten/-Kanten (offline
gegen die Golden-Annotationen, sobald ein Extract-Lauf die Ausgabe geliefert
hat):**

```bash
# Die von einem Extract-Lauf produzierte Transkription je Frage-ID als
# reports/extractions.v2-final.json ablegen (Schema: table/process/labels je Frage-ID),
# dann offline und deterministisch scoren:
bun run eval:retrieval -- --collection golden --base-url <url> --v2 \
  --k 5,10 --out reports/retrieval --label v2-final \
  --extractions reports/extractions.v2-final.json
```

**(d) Durchsatz — `PAGE_CONCURRENCY`-Sweep gegen die vLLM-Batch-Kapazität:**

```bash
# Plan (ohne Cluster, fingiert nichts):
bun run scripts/throughput-sweep.ts --plan --max-num-seqs 16 --concurrent-jobs 2
# Je Leiterwert: PAGE_CONCURRENCY setzen, Extract neu starten, eine Messzeile anhängen:
bun run scripts/throughput-sweep.ts \
  --base-url http://127.0.0.1:3004 --token <bearer> \
  --source-sha <sha256> --reference tuning/corpus.pdf \
  --concurrency 8 --vllm-metrics-url http://vllm:8000/metrics \
  --out reports/page-concurrency-sweep
```

Die Durchsatz-Prozedur ist im Detail in DEPLOYMENT.md
(„Throughput tuning: `PAGE_CONCURRENCY` vs. the vLLM batch") beschrieben.

### Vorher/Nachher — die Tabellenform (Zellen auf dem Zielcluster zu messen)

Der eigentliche Vorher/Nachher-Vergleich hängt an einem Live-Lauf (§7). „Vorher"
ist die eingefrorene v1-Baseline (`scripts/eval/baseline/retrieval.baseline.{json,md}`,
derzeit ein PENDING-Skelett: `"pending": true`, alle Retrieval-Metriken 0,
Coverage 120 Seiten-/78 Abbildungsfragen). „Nachher" ist der `--v2`-Lauf gegen
die Collection mit dem v2-Index. **Es werden keine Live-Cluster-Metriken erfunden.**

| Metrik | Vorher (v1-Baseline, `/search`) | Nachher (v2, `/v2/search`) | Quelle |
| --- | --- | --- | --- |
| Page Recall@5/10 | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--capture`-Mitschnitt |
| Figure Recall@5/10 | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--capture`-Mitschnitt |
| MRR@5/10 | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--capture`-Mitschnitt |
| Figure-Hit-Rate@5/10 | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--capture`-Mitschnitt |
| Tabellenzellen-Genauigkeit | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--extractions`-Capture |
| Label-Coverage | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--extractions`-Capture |
| BPMN-Knoten-Recall | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--extractions`-Capture |
| BPMN-Kanten-Recall | _pending_ (0) | _auf dem Zielcluster zu messen_ | `--extractions`-Capture |
| Durchsatz (Pages/min am Knie) | _n/a (v1 hatte keinen Sweep)_ | _auf dem Zielcluster zu messen_ | `throughput-sweep`-Report |

Erwarteter Effekt der v2-Pipeline (qualitativ, ohne fingierte Zahlen): höherer
Page-/Figure-Recall und MRR — insbesondere für Bezeichner-Fragen (RRF-Liste 3.4)
und Abbildungen (Diversifizierung/Collapse 3.5); höhere Tabellenzellen-Genauigkeit
und Label-Coverage durch die deterministische Seitengeometrie (2.1) und Pass 2
(2.5); belastbarer Durchsatz über den gemessenen `PAGE_CONCURRENCY`-Knie.

## 3. Deployment-Runbook (Phase 5)

Das Deployment braucht einen Live-Cluster und ist ein **Nutzer-Follow-up**; hier
wird nichts ausgerollt und es werden keine Deployment-Metriken erfunden. Phase 5
baut auf den ausgerollten Ständen der Phasen 1–4 auf.

### Was auszurollen ist

- **Extract** mit dem Phase-5-Build:
  - Kacheln für Großformate (5.1) inkl. der Zoom-Rekonstruktion in `handlers/render.ts`,
  - Queue-Lane für große Jobs (5.2),
  - Finalize-Pass (5.4).
- **Konfiguration** (alle additiv, mit sicheren Defaults — siehe
  [docs/CONFIGURATION.md](CONFIGURATION.md) für die vollständige Variablenliste):
  `TILE_TARGET_PIXELS` (2000), `TILE_OVERLAP_FRACTION` (0.1), `TILE_MAX_PER_PAGE`
  (16), `LARGE_JOB_PAGE_THRESHOLD` (1000), `LARGE_JOB_MAX_CONCURRENCY` (1),
  `FINALIZE_PASS` (true).
- **Keine Search-Schema-Migration** ist für Phase 5 nötig; `tile:`- und
  `native:`-Assets nutzen die bestehende `vs_assets`-Struktur (Schema aus Phase 1).
- **Keine Flow-Änderung** (§4).

### Wie zu verifizieren ist (nach dem Rollout)

- **Kacheln greifen bei Großformaten.** Ein `drawing`/A0-Dokument verarbeiten und
  prüfen, dass `tile:`-Assets entstehen und ein Region-Zoom aus der überdeckenden
  Kachel bedient wird (schärfer als die ganze, herunterskalierte Seite).
- **Große Jobs laufen in der Lane.** Einen Job über `LARGE_JOB_PAGE_THRESHOLD`
  Seiten starten und prüfen, dass die Lane die Parallelität begrenzt, die
  Budget-Warnung bei 80 % feuert und die Restzeitschätzung erscheint.
- **Finalize-Pass korrigiert modellfrei.** Nach Dokumentende prüfen, dass nur
  Einheiten mit geändertem Überschriftenpfad neu eingebettet wurden (kein
  Modellaufruf im Finalize-Schritt).
- **VSDX nativ.** Eine `.vsdx`-Datei einlesen und prüfen, dass Shape-Texte und
  Konnektoren als `process`/`diagram` ohne Vision-Aufruf erscheinen.
- **`flow_version` im Trace — nicht einschlägig.** Phase 5 änderte keine Flows
  (§4).

## 4. `flow_version`-Trace-Check (Requirement 16.6)

Phase 5 hat **keine Flows geändert**, daher ist die Flow-Versionierungsregel hier
nicht einschlägig und es gibt kein neues `flow_version` zu prüfen. Der Wert bleibt
auf dem in **Phase 4 (Task 4.4)** gesetzten Stand. Die Prozedur, wie `flow_version`
aus dem Debug-Trace gelesen und gegen die Soll-Version geprüft wird, ist im
Phase-4-Abschlussbericht dokumentiert
([document-intelligence-v2-phase-4-completion.md](document-intelligence-v2-phase-4-completion.md), §4):
Der Wert stammt direkt aus `metadata.version` des aufgelösten Entry-Flows
(`apps/runtime/src/types/debug-trace.ts`), wird beim Anlegen des Trace gesetzt und
über `GET /monitoring/debug/:executionId` ausgeliefert.

Phase 5 ändert keine Flows. Die Soll-Werte aus Phase 4 (die `metadata.version`
der betroffenen Entry-Flows im privaten Deployment-Repository) müssen auch nach
dem Phase-5-Rollout unverändert im Trace erscheinen.

Weicht ein Wert nach dem Phase-5-Rollout ab, ist das ein Deployment-Regress am
Flow-Stand (nicht durch Phase 5 verursacht) und über das Phase-4-Runbook zu
beheben.

## 5. Bekannte Follow-ups (Betreiber-/Governance-Punkte, keine Blocker)

Diese drei Punkte sind während des Feinschliffs aufgetaucht. Keiner blockiert den
Abschluss; sie sind als Betreiber- bzw. Governance-Entscheidungen zu führen.

### (a) `@nodable/entities@3.0.0` — Supply-Chain-Flag (Governance)

`bun run supply-chain:check` meldet einen bestehenden Verstoß: die transitive
Abhängigkeit `@nodable/entities@3.0.0` (über fast-xml-parser) deklariert die
MIT-Familie, es fehlt aber der vollständige Lizenz-/Notice-Text. Das ist **kein
neuer Verstoß durch Phase 5** — Phase 5 hat keine neue Abhängigkeit hinzugefügt
(§6) — und **kein Blocker** für den Abschluss. Auflösung: eine geprüfte
supplementäre Reuse-Regel (Repository-Reuse-Regel bzw. autoritative
Paket-/Projektfamilien-Regel) im Supply-Chain-Generator ergänzen. Das ist eine
**Governance-Entscheidung** und explizit außerhalb dieses Docs-Tasks.

### (b) v2-`/v1/ingest`-Wrapper liest `X-Version-Mode` nicht selbst (bekanntes Verhalten)

Der v2-Ingest-Wrapper in Extract (`apps/extract/src/handlers/ingest-v2.ts`)
liest den `X-Version-Mode`-Header **nicht** selbst. Die Versionierung auf dem
**v2-Pfad** wird durch den Revisions-Fluss des Emitters gesteuert (Extract öffnet
über die Search-Revisions-API eine neue Revision, Search führt den atomaren
`is_latest`-Wechsel beim Commit aus), während der Header auf dem **synchronen
v1-Search-Pfad** (`apps/search/src/handlers/ingest.ts`, dort `x-version-mode` →
`replace | version`) berücksichtigt wird. Das ist ein bewusst dokumentiertes
Verhalten und für das Korpus-Migrations-Werkzeug (Task 5.6) relevant: die CLI
setzt `X-Version-Mode: version` auf `/v1/ingest` und verlässt sich dort auf den
Revisions-Fluss; ein Betreiber muss wissen, dass die Versionierung je nach Pfad
unterschiedlich greift — über den Emitter-Revisions-Fluss (v2) bzw. über den
Header (synchroner v1-Search-Pfad).

### (c) `verify:spdx`-Vorbefund aus der Task-1.1-Dateiverschiebung (löst sich beim Commit)

Der bestehende `verify:spdx`-Vorbefund geht auf die Dateiverschiebung in Task 1.1
zurück (`packages/extract-contract/src/document.ts` → `src/v1/document.ts`). Er
**löst sich, sobald der Arbeitsbaum committet ist** — die SPDX-Prüfung arbeitet
gegen den getrackten Stand. Kein Handeln in diesem Task nötig; kein Blocker.

## 6. THIRD_PARTY_NOTICES und Lizenzen (Requirement 1.2)

Phase 5 sollte laut Taskvorgabe **keine neue Abhängigkeit** einführen, und tut es
nicht: der VSDX-Parser (5.5) verwendet die bereits in Phase 2 aufgenommenen,
permissiv lizenzierten Bibliotheken **fflate** und **fast-xml-parser** weiter.
Damit ist **keine Änderung an `THIRD_PARTY_NOTICES.md` erforderlich**.

`THIRD_PARTY_NOTICES.md` ist die **byte-stabile Linux-x64-Referenz** (siehe
DEPLOYMENT.md): sie führt bewusst Git-SHA `unknown` und wird von der **Linux-CI**
regeneriert und byte-für-byte verglichen. Sie wird daher **nicht von Hand und
nicht auf macOS** bearbeitet oder regeneriert. `bun run supply-chain:check`
meldet ausschließlich den bekannten `@nodable/entities@3.0.0`-Vorbefund (§5a) —
**kein neuer Eintrag** durch Phase 5. Sollte ein späterer, echt neuer
Laufzeit-Abhängigkeits-Eintrag nötig werden, regeneriert ihn die Linux-CI
(`supply-chain`), nicht ein manueller Edit auf dieser Plattform.

## 7. Offline vs. Live — was misst was

- **Offline (hier verifiziert, §8):** die Reinheit und Korrektheit der Eval-Werkzeuge
  (Retrieval-Metriken inkl. `--v2`-Pfad, Extraktionsmetriken, Durchsatz-Sweep-Kern,
  Korpus-Migrations-Kern), die Plan-Modi der Treiber (die ohne Cluster nichts
  fingieren), der Typ- und Supply-Chain-Stand, die dokumentierte Herkunft von
  `flow_version`, dass Phase 5 keine neue Abhängigkeit einführt.
- **Live (Nutzer-Follow-up, §2/§3):** die tatsächlichen Vorher/Nachher-Zahlen
  (Retrieval-, Extraktions- und Durchsatzmetriken), das eigentliche Deployment des
  Phase-5-Extract-Builds und die Post-Rollout-Verifikation (Kacheln, große-Job-Lane,
  Finalize-Pass, VSDX), sowie die reale Bestandskorpus-Migration über die CLI.

## 8. In dieser Umgebung verifiziert (offline)

- `npm run typecheck` (`bun run --filter '*' typecheck`) — fehlerfrei; ein reiner
  Docs-Task berührt keinen Code, dies bestätigt den grünen Stand.
- `bun run supply-chain:check` — meldet die **zwei bekannten**
  `@nodable/entities@3.0.0`-Zeilen (§5a) und **keinen neuen** Verstoß; Phase 5 hat
  keine Abhängigkeit hinzugefügt.
- `bun run config-reference:check` — `docs/CONFIGURATION.md` ist mit den Schemas in
  Sync; die Phase-5-Knöpfe (`TILE_*`, `LARGE_JOB_*`, `FINALIZE_PASS`) sind aus ihren
  Tasks bereits dokumentiert.
- Die Eval-Werkzeuge sind über die Phasen unit-getestet (`bun run eval:test` für den
  Retrieval-/Extraktions-Harness; `throughput-tuning.test.ts`,
  `corpus-migration.test.ts`, `native-vsdx.test.ts` für die Phase-5-Kerne).

## 9. Blockiert auf eine Live-Umgebung

- **Reale finale Vorher/Nachher-Metriken** (Retrieval, Extraktion, Durchsatz) — kein
  Cluster, kein GPU/vLLM, kein befülltes Korpus verfügbar. Die Baseline bleibt bis
  dahin ein PENDING-Skelett (§2).
- **Deployment des Phase-5-Extract-Builds** und die Post-Rollout-Verifikation
  (Kacheln, Queue-Lane, Finalize-Pass, VSDX) — über das Runbook (§3) vom Betreiber
  abzuschließen.
- **Bestandskorpus-Migration** über `corpus-migrate.ts` im `version`-Modus — der
  Plan-Modus ist offline prüfbar, der reale Re-Ingest hängt an einer laufenden
  Extract-/Search-Instanz.

Alles, was ohne Live-Umgebung prüfbar ist (die Werkzeug-Korrektheit, der Typ- und
Supply-Chain-Stand, die Config-Referenz-Synchronität, die `flow_version`-Herkunft),
ist in §8 verifiziert. Es wird kein Deployment und werden keine Metriken fingiert.
