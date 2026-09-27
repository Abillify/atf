<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Phase 4 Abschlussbericht (T4.7)

Phase 4 ("Runtime und Flows") ist implementiert. Dieser Bericht fasst die
gelieferten Änderungen zusammen (Tasks 4.1–4.6), dokumentiert die in dieser
Umgebung durchgeführte **Offline-Verifikation**, stellt das
**Deployment-Runbook** und — als Kernstück dieses Phasenabschlusses — die
Prozedur für den **`flow_version`-Trace-Check** (Requirement 16.6) vor. Wie schon
in Phase 0, 1, 2 und 3 sind die Schritte, die eine **Live-Umgebung** brauchen
(das eigentliche Deployment und der Trace-Check am ausgerollten Stand), als
Runbook vorbereitet und **nicht fingiert**.

_Requirements: 16.6_

## 1. In Phase 4 gelieferte Änderungen

| Task | Bereich | Änderung |
| --- | --- | --- |
| 4.1 | Runtime | RAG-Knoten v2: `ragProfiles` um `expand`, `granularity`, `include_assets` und `assets: { attach, maxImages, variant }` erweitert; Bild-Parts nur bei bestätigtem `visionInput`; Belegzeile v2 mit Zitaten aus Seite und Abbildung (page/figure citations). |
| 4.2 | Runtime | `inspect_image` löst `asset:<id>[#bbox]`-Referenzen über MCP `get_asset` auf (Region-Zoom), parkt das Bild im Media-Store als `img-N`, wertet es über das konfigurierte Vision-Sub-LLM aus; fail-closed (unauflösbare/verbotene Assets → `unknown_image`, ohne die Ursache zu leaken). |
| 4.3 | Runtime | Knotentyp `retrieval` verifiziert implementiert (`graph/handlers/retrieval.ts`) und registriert (`flow-parser/validate.ts`); das Beispiel `deploy/examples/flows/05-support-assistant.yaml` validiert (Requirement 16.7 über den „implementiert"-Zweig erfüllt). |
| 4.4 | Flows | Die Recherche-Flows des privaten Deployment-Repositories mit den neun Phase-3-MCP-Navigationswerkzeugen + Collection-Pin + Rechercheroutine (outline → section → pages → figure → zoom → follow_ref / find_identifier) verdrahtet; Versionen aller betroffenen Entry-Flows minor-gebumpt. |
| 4.5 | UI | Extract-UI: Jobs-Tab + `GET /v2/jobs`-Liste (Fortschritt pro Stufe, Warnungen, Kosten, Restzeitschätzung; Aktionen Pause/Fortsetzen/Retry/Abbruch; barrierefrei). |
| 4.6 | Runtime | End-to-End-Test: Frage → Treffer mit Asset → Bild beim Vision-Modell (auto-attach) bzw. über `inspect_image` → Antwort mit Zitat (Seite, Abbildung). |
| 4.7 | Docs | Dieser Abschlussbericht; Deployment-Runbook; `flow_version`-Trace-Check-Prozedur mit den erwarteten Soll-Versionen je Flow. |

### Versionsstand der betroffenen Entry-Flows (aus 4.4)

Phase 4 hat — anders als Phase 1, 2 und 3 — **Flows geändert** (Task 4.4). Die
Flow-Versionierungsregel ist damit einschlägig: die `metadata.version` jedes
betroffenen Entry-Flows wurde in 4.4 minor-gebumpt (die neuen Phase-3-Werkzeuge
und die Rechercheroutine sind rückwärtskompatible Ablauferweiterungen, kein
Vertragsbruch). Diese Bumps sind in `aiperator/flows/flows/*.yaml` des privaten
Deployment-Repositories deklariert; dieser Docs-Task ändert **keine** Flows.

Die konkreten Flow-Namen und Soll-Versionen stehen im Changelog der jeweiligen
Flow-Dateien im privaten Deployment-Repository (`metadata.changelog`); sie werden
hier bewusst nicht wiederholt, weil dieser Tree öffentlich ist. Jeder betroffene
Entry-Flow wurde gegenüber dem Stand vor Phase 0 um zwei Minor-Versionen
angehoben (Phase 0: Asset-Werkzeug, Phase 4: Navigationswerkzeuge). Diese Werte
sind die **Soll-Werte**, die nach dem Deployment im Trace-Feld `flow_version`
erscheinen müssen (siehe §4).

## 2. In dieser Umgebung verifiziert (offline)

Alles, was ohne Live-Cluster prüfbar ist, ist hier grün. Es wird **kein**
Deployment ausgeführt und es werden **keine** Trace-Werte fingiert.

- **Phase-4-Runtime-Kette (Tasks 4.1/4.2/4.6).** `bun test` über den E2E-Test
  (`rag-asset-vision-e2e.test.ts`), den RAG-v2-Knoten
  (`parallel-rag-assets.test.ts`) und das `inspect_image`-Werkzeug
  (`image-inspection-tool.test.ts`) — **28 Tests grün, 0 Fehler**. Bewiesen: der
  Auto-Attach-Pfad (Bild erreicht den Responder nur bei `visionInput`, Kappung
  auf `maxImages`), der `inspect_image`-Pfad (`get_asset` mit id + Region, das
  Vision-Sub-LLM sieht die Bytes, der hostende Responder nie das Base64), die
  Belegzeile v2 (Abschnittspfad, Seiten, Abbildungs-`kind` und -Caption) und das
  Zitat aus Seite + Abbildung.
- **Knotentyp `retrieval` (Task 4.3).** `retrieval` ist als Handler
  implementiert (`graph/handlers/retrieval.ts`, `nodeType.type = "retrieval"`)
  und in der Knotentyp-Allowlist der Flow-Validierung registriert
  (`flow-parser/validate.ts`); der Node-Typ-Katalog und die
  `node-type-catalog`-Tests führen ihn. Das Beispiel `05-support-assistant.yaml`
  nutzt den Typ, damit greift der „implementiert"-Zweig von Requirement 16.7 (die
  Alias-auf-`parallel`-Alternative war nicht nötig).
- **Eval-Harness unverändert grün.** `bun run eval:test` — 53 Tests grün
  (Retrieval-/Extraktionsmetriken, Fixture-Loader, `normalizeV2Hit`); der
  Harness-Stand aus Phase 3 bleibt intakt.
- **`flow_version` liest genau das gebumpte Feld.** Der Wert im Debug-Trace
  stammt direkt aus `metadata.version` des aufgelösten Entry-Flows: der Typ
  `DebugTrace.flow_version` ist dokumentiert als „Declared `metadata.version` of
  the resolved entry flow" (`apps/runtime/src/types/debug-trace.ts`) und wird in
  `graph/graph-engine/handler-factories.ts` beim Anlegen des Trace gesetzt
  (`flow_version: flowVersion`). Es ist also exakt das Feld, das 4.4 erhöht hat.
- **Lint-Stand unverändert.** `bun run lint:baseline` — „At baseline"
  (202 Fehler, 659 Warnungen unverändert). Ein reiner Docs-Task berührt den Lint
  nicht; bestätigt.

Dieser Task ändert **keinen** Code und **keine** Flows — er ist reine
Dokumentation. Die in 4.1–4.6 gelieferten Änderungen wurden nicht erneut
ausgeführt; die obigen Suiten dienen der Bestätigung des grünen Stands.

## 3. Deployment-Runbook (Phase 4)

Das Deployment braucht einen Live-Cluster und ist ein **Nutzer-Follow-up**; hier
wird nichts ausgerollt und es werden keine Deployment-Metriken erfunden.

### Voraussetzungen

Die Extract-/Search-Builds der Phasen 1–3 sind die **Vorbedingung** dieses
Rollouts und über ihre eigenen Phasen-Runbooks abgedeckt (Search-Index/-Retrieval
+ `/v2/render` aus Phase 3, Contract v2 + Persistenz + Revisions-/Asset-API aus
Phase 1, Extraktionsqualität aus Phase 2). Phase 4 setzt darauf auf.

### Was auszurollen ist

- **Runtime** mit dem Phase-4-Build:
  - dem v2-RAG-Knoten (Task 4.1: `ragProfiles` mit `expand`/`granularity`/
    `include_assets`/`assets{attach,maxImages,variant}`, Belegzeile v2, page/
    figure-Zitate),
  - der `inspect_image`-Asset-Unterstützung (Task 4.2: `asset:<id>[#bbox]` über
    MCP `get_asset`, fail-closed).
  - Der Knotentyp `retrieval` (Task 4.3) ist bereits Teil des Runtime-Builds;
    kein separater Rollout-Schritt.
- **Deployment-Repository: die in 4.4 gebumpten Recherche-Flows.** Die fünf
  Entry-Flows plus eingebundene Subflows/Prompts/Modell-Shortcuts validieren und
  über den üblichen Flow-Deploy-Pfad ausrollen:

  ```bash
  cli validate           # Flows validieren (aus 4.4)
  # anschließend Deployment über den Flow-Deploy-Pfad des privaten
  # Deployment-Repositories (aiperator/flows + deploy/)
  ```

- **Extract-UI** mit dem Jobs-Tab (Task 4.5), der `GET /v2/jobs` bedient.

### Wie zu verifizieren ist (nach dem Rollout)

1. **`flow_version` im Debug-Trace** — der Kern-Check dieser Phase, im Detail in
   §4.
2. **Eine Recherche-Anfrage liefert eine zitierte Antwort mit Abbildung.** Über
   einen der Recherche-Flows eine Frage stellen, deren Antwort an einer Abbildung
   hängt, und prüfen, dass die Antwort die Abbildung entweder **auto-attached**
   (bei bestätigtem `visionInput`) oder über **`inspect_image`** (Region-Zoom)
   einbezieht und Seite + Abbildung zitiert — die Live-Entsprechung des
   E2E-Tests aus 4.6.
3. **Die Jobs-UI ist erreichbar.** Der Jobs-Tab der Extract-UI listet Jobs mit
   Fortschritt pro Stufe, Warnungen, Kosten und Restzeit und bietet Pause/
   Fortsetzen/Retry/Abbruch (Task 4.5).

## 4. `flow_version`-Trace-Check (Requirement 16.6 — die Kern-Verifikation)

Requirement 16.6: Wird ein Entry-Flow, Subflow, Prompt oder Shortcut geändert, so
wird die `metadata.version` jedes betroffenen Entry-Flows gebumpt (in 4.4
erledigt) — **und nach dem Deployment** wird `flow_version` im Debug-Trace
verifiziert. Dieser Check beweist, dass der ausgerollte Flow-Stand dem in 4.4
deklarierten Bump entspricht; er ist genau die Prüfung, die die
Flow-Versionierungsregel vorschreibt.

### Wo `flow_version` herkommt und wie man es liest

- Der `DebugTrace`-Typ (`apps/runtime/src/types/debug-trace.ts`) trägt das Feld
  `flow_version` = „Declared `metadata.version` of the resolved entry flow". Es
  stammt aus der Flow-Versionierungs-Infrastruktur der Phase 0 und wird in
  `graph/graph-engine/handler-factories.ts` beim Anlegen des Trace gesetzt.
- Der Trace wird über `GET /monitoring/debug/:executionId` ausgeliefert
  (bounded in-memory Ring-Buffer, `InMemoryDebugTraceStore(200)` — nur Operator-/
  Entwicklerwerkzeug, nie in der DB).
- Die `executionId` ist der `X-Execution-Id`-Response-Header bzw. die
  `chatcmpl-…`-Id der Chat-Antwort; beide reichen, um den Trace zu holen, solange
  er noch im Ring-Buffer resident ist.

### Prozedur

Nach dem Deployment der Phase-4-Flow-Versionen je **eine** Anfrage über jeden
betroffenen Recherche-Flow ausführen, den Debug-Trace über die Execution-Id
holen und prüfen, dass `flow_version` exakt der **deployierten**
Entry-Flow-Version entspricht:

```bash
# 1) Einen Turn über den Flow ausführen; die Execution-Id aus dem Response-Header
#    (X-Execution-Id) oder der chatcmpl-…-Id der Antwort abgreifen.
# 2) Den Debug-Trace holen und flow_version herausziehen:
curl -s "$RUNTIME_URL/monitoring/debug/$EXECUTION_ID" \
  -H "Authorization: Bearer $TOKEN" \
| jq '{flow_id, flow_version}'
```

Erwartete Soll-Werte: die `metadata.version` der betroffenen Entry-Flows im
privaten Deployment-Repository (siehe §1).

Stimmt `flow_version` je Flow mit der Soll-Version überein, ist der gebumpte
Flow-Stand aus 4.4 nachweislich ausgerollt. Weicht ein Wert ab, ist noch der alte
Flow-Stand aktiv — Deployment für den betroffenen Flow wiederholen und den Trace
erneut prüfen.

## 5. Offline vs. Live — was misst was

- **Offline (hier verifiziert, §2):** die Phase-4-Runtime-Kette (RAG-v2-Knoten,
  `inspect_image` mit Asset-Auflösung, der E2E-Test aus 4.6), die Registrierung
  und Implementierung des `retrieval`-Knotentyps samt validierendem Beispiel, der
  grüne Eval-Harness, die Herkunft von `flow_version` aus `metadata.version`, der
  unveränderte Lint-Stand. Die Versionsbumps aus 4.4 sind in den Flow-YAMLs
  **deklariert**.
- **Live (Nutzer-Follow-up, §3/§4):** das eigentliche Deployment (Runtime mit
  v2-RAG + `inspect_image`-Asset-Support, die gebumpten Recherche-Flows, die
  Extract-UI) und der **`flow_version`-Trace-Check** je Flow gegen die erwarteten
  Soll-Versionen — der Nachweis, dass der ausgerollte Stand dem deklarierten Bump
  entspricht. Dazu eine Live-Recherche-Anfrage, die eine zitierte Antwort mit
  attached/inspizierter Abbildung liefert, und die erreichbare Jobs-UI.

## 6. Blockiert auf eine Live-Umgebung

Die folgenden Teilschritte von T4.7 **können in dieser Umgebung nicht** ausgeführt
werden und sind über das Runbook (§3/§4) vom Nutzer abzuschließen:

- **Deployment** von Runtime (v2-RAG + `inspect_image`-Asset-Support), der in 4.4
  gebumpten Recherche-Flows und der Extract-UI — kein Cluster/Deploy-Ziel
  verfügbar.
- **`flow_version`-Trace-Check** je Flow gegen die erwarteten Soll-Versionen — hängt am ausgerollten Stand und an
  einer laufenden Runtime mit dem `/monitoring/debug/:executionId`-Endpunkt.
- **Live-Recherche-Anfrage mit zitierter Antwort und Abbildung** sowie die
  **erreichbare Jobs-UI** — hängen am Deployment.

Alles, was ohne Live-Umgebung prüfbar ist (die Runtime-Kette, der `retrieval`-Typ,
der Eval-Harness, die Herkunft von `flow_version`, der Lint-Stand), ist in §2
verifiziert. Es wird kein Deployment und werden keine Trace-Werte fingiert.
