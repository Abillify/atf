<!--
SPDX-License-Identifier: Elastic-2.0
SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
-->

# Document Intelligence v2 — Phase 1 Abschlussbericht (T1.17)

Phase 1 ("Contract v2 und fortsetzbares Fundament") ist implementiert. Dieser Bericht fasst die
gelieferten Änderungen zusammen, dokumentiert die in dieser Umgebung durchgeführte Verifikation
und hält fest, welcher Schritt eine Live-Umgebung braucht und daher hier nur vorbereitet, nicht
ausgeführt werden kann.

_Requirements: 17.1, 17.2_

## 1. In Phase 1 gelieferte Änderungen

| Task | Bereich | Änderung |
| --- | --- | --- |
| 1.1 | Contract | `@atf/extract-contract` 2.0.0: v2 NDJSON-Blockmodell, Codec, Validator, `renderMarkdown`, Asset-ID v2; v1-Grammatik unter dem `/v1`-Subpfad. |
| 1.2 | Search | Legacy-`/ingest`-Adapter nutzt den v1-Parser des Contracts; `X-Extract-Contract`-Prüfung lehnt inkompatible Major-Versionen ab. |
| 1.3 | Extract | Persistenzschicht (`EXTRACT_DATABASE_URL`, Schema `extract`, Migrationsrunner, Job-/Stage-/Upload-/Outbox-Tabellen). |
| 1.4 | Extract | Content-adressierter Quellspeicher, fortsetzbarer Chunk-Upload (`/v2/uploads`), `source_url`-Pull mit SSRF-Allowlist. |
| 1.5 | Extract | Job-Worker und Job-API (`/v2/jobs`), Lease/Epoch/Fencing, Zustandsmaschine, `retry-failed`, `reparse`. |
| 1.6 | Extract | Stufen-Framework mit Checkpoints je `input_hash`, `transient`/`permanent`-Fehlerklassen, Budgetprüfung. |
| 1.7 | Extract | Bestehende Pipeline auf Stufen portiert, geordnete Emission ohne RAM-Sammlung. |
| 1.8 | Search | Migrationen für `vs_revisions`, `vs_ingest_batches`, `vs_segments`, `vs_document_revisions`, `vs_assets` (inkl. Backfill aus `vs_document_assets`). |
| 1.9 | Search | Revisions-API (`/v2/documents/{ref}/revisions`, Batches, Segmente, Commit, Heartbeat, TTL). |
| 1.10 | Search | Batch-Worker (`SKIP LOCKED`, deterministische `unit_id`, Backoff bei Embedding-Ausfall). |
| 1.11 | Search | Asset-API v2 (`/v2/assets`), AssetStore `postgres`/`filesystem`, `thumb`/`preview`-Varianten. |
| 1.12 | Extract | Emitter mit Outbox und Abgleich, begrenzte Asset-Parallelität, Segment-/Final-Commit. |
| 1.13 | Search | Sichtbarkeit `progressive`/`on_commit`, Revisionszeiger, atomarer Wechsel. |
| 1.14 | Beide | Kompatibilitätspfade: `/v1/ingest` und `/ingest-file` starten intern v2-Jobs; Assets werden gespeichert. |
| 1.15 | Beide | Chaos- und Resume-Testsuite (Fault-Injection, Hash-Identität, keine Doppelaufrufe/-einheiten). |
| 1.16 | Beide | Skalierungstest mit 10.000 Seiten (Speicher wächst nicht mit der Seitenzahl). |
| 1.17 | Docs/Deploy | Dieser Bericht, API-/ARCHITECTURE-/SECURITY-Doku, Migrationsleitfaden, Deployment-Compose. |

## 2. Dokumentation (T1.17)

- **API (v2-Routen).** Die OpenAPI-Dokumente beider Dienste bilden die v2-Routen jetzt als
  echte Pfad-Einträge ab (nicht nur in Beschreibungen):
  - Extract `/openapi.json`: `/v2/uploads`, `/v2/uploads/{id}` (HEAD/PATCH),
    `/v2/uploads/{id}/complete`, `/v2/jobs`, `/v2/jobs/{id}` und die Aktionen `pause`, `resume`,
    `cancel`, `retry-failed`, `reparse`. Sichtbar, sobald `EXTRACT_DATABASE_URL` gesetzt ist
    (`v2Enabled`), passend zu den nur dann gemounteten Routen.
  - Search `/openapi.json`: `/v2/documents/{ref}/revisions` (POST/GET/DELETE), `…/{rev}`
    (GET/DELETE), `…/batches/{seq}` (PUT), `…/segments/{n}/commit`, `…/commit`, `…/heartbeat`
    und `/v2/assets/{assetId}` (PUT/HEAD/GET).
- **ARCHITECTURE.** [../ARCHITECTURE.md](../ARCHITECTURE.md) beschreibt den v2-Datenfluss
  (persistente Extract-Jobs → Quellspeicher → gestufte Pipeline → Emitter/Outbox →
  Search-Revisionen → Batch-Worker → Einheiten → Revisionszeiger) samt Diagramm und Invarianten;
  System-Overview und State-Abschnitt sind aktualisiert.
- **SECURITY.** [../SECURITY.md](../SECURITY.md) dokumentiert den fortsetzbaren Upload
  (content-adressierter Speicher, Prüfsummen pro Chunk und für die ganze Datei) und die
  `source_url`-SSRF-Kontrollen (`SOURCE_URL_ALLOWED_HOSTS`, Ablehnung von Link-local/Metadata,
  Re-Validierung bei Redirects).
- **Konfigurationsreferenz.** `bun run config-reference:check` ist grün; alle neuen Phase-1-Env-
  Variablen stehen in [CONFIGURATION.md](CONFIGURATION.md) (aus den Schemas generiert).
- **Migrationsleitfaden.** [document-intelligence-v2-migration.md](document-intelligence-v2-migration.md)
  beschreibt den Weg auf v2: v1-Subpfad des Contracts, `vs_document_assets`→`vs_assets`-Backfill,
  Aktivierung von `EXTRACT_DATABASE_URL` und `BATCH_WORKER`, und dass v1-Ingest weiterläuft.

## 3. Deployment-Compose (T1.17)

Der kombinierte Search-+-Extract-Compose im Deployment-Repository
(`search/compose.production.yaml`) wurde um den v2-Pfad erweitert:

- **Extract-DB.** `EXTRACT_DATABASE_URL` zeigt standardmäßig auf die gemeinsame Postgres-Instanz
  mit isoliertem `extract`-Schema (`search_path=extract`); der Migrationsrunner legt das Schema
  an. Ohne die Variable bleibt Extract auf dem v1-Synchronpfad.
- **Persistente Volumes.** Neues Volume `extract_sources` für `SOURCE_STORE_DIR` und
  `UPLOAD_TMP_DIR` unter `/var/lib/atf-extract` — bewusst getrennt vom tmpfs-Scratch, damit eine
  gespeicherte Quelle und ein laufender fortsetzbarer Upload einen Neustart überleben. Volume
  `search_assets` für den optionalen `filesystem`-Asset-Backend.
- **Worker.** `BATCH_WORKER=true` für Search; der Extract-Job-Worker läuft im Extract-Prozess,
  sobald die DB gesetzt ist.
- **Emitter/SSRF-Tunables.** `EMIT_BATCH_PAGES`, `SEGMENT_PAGES`, `ASSET_UPLOAD_CONCURRENCY`,
  `SOURCE_URL_ALLOWED_HOSTS`, `REVISION_TTL*`, `REVISION_BATCH_BODY_LIMIT`, `ASSET_STORE_*` mit
  Defaults; `.env.production.example` dokumentiert sie.

## 4. In dieser Umgebung verifiziert

- `bun run config-reference:check` — grün (531 Variablen, inkl. aller Phase-1-Variablen).
- `bun run lint:baseline` — "At baseline" (202 Fehler, 659 Warnungen; siehe §6).
- `bun run typecheck` — alle Workspaces fehlerfrei.
- Extract-OpenAPI-Tests (vitest) grün; die v2-Pfade erscheinen bei gesetzter DB im Dokument.
- Search-Unit-Tests im Batch-Worker-/Revisions-Bereich grün.
- `PREFLIGHT_ONLY=1 ./deploy-search.sh` — der kombinierte Compose validiert vollständig gegen die
  echte Produktions-Env (`docker compose config`), alle drei Dienste (postgres, vectorsearch,
  extract) werden aufgelöst.

## 5. Blockiert auf eine Live-Umgebung

- **Tatsächliches Deployment.** `deploy-search.sh` rollt per SSH/rsync auf den Remote-Host aus und
  schließt mit `docker compose pull && docker compose up -d`. Das braucht Cluster-Zugriff und die
  laufenden Postgres-/Modell-Dienste und kann hier nicht ausgeführt werden. Der Compose ist
  validiert und der Preflight ist grün; der Rollout ist vom Betreiber auszuführen.
- **Migrations-/Backfill-Laufzeit auf echten Korpora.** Der `vs_document_assets`→`vs_assets`-
  Backfill läuft idempotent beim ersten Search-Start nach dem Upgrade; die einmalige Laufzeit auf
  großen Korpora ist erst auf der Live-DB messbar.

Es wird kein Deployment fingiert.

## 6. Lint-Baseline

Der Aggregat-Lint-Stand war über die Phase-1-Arbeit auf 660 Warnungen gewandert, gegenüber der
committeten Baseline von 659 — obwohl jede einzelne neue Datei warnungsfrei war. Die eine
zusätzliche Warnung war eine `noNonNullAssertion` in einer neuen Testdatei
(`apps/extract/tests/persistence.test.ts`, `CONNECTION!` innerhalb eines `describeIfPg`-Guards).
Sie wurde an der Quelle behoben (Verengung auf eine lokale Konstante statt der Assertion), nicht
unterdrückt; `lint:baseline` meldet wieder "At baseline". Die committete Baseline
(`.biome-baseline.json`) bleibt bei 659/202 unverändert.

## 7. Test-Isolation (Nebenbefund, behoben)

Die Search-DB-Integrationssuites teilten sich unter paralleler Ausführung eine Datenbank; der
Batch-Worker beansprucht gestagte Batches per `SKIP LOCKED` nur nach Status, nicht nach Tenant,
sodass parallele Suites sich gegenseitig Batches stehlen konnten. Der Worker hat nun eine
optionale, nur im Test genutzte Claim-Verengung (`onlyTenantId`); in Produktion ist sie
undefiniert und ändert nichts (jeder Worker darf jeden Batch verarbeiten). Die Integrationssuites
übergeben ihren eigenen Tenant, wodurch sie unabhängig werden, ohne sie zu serialisieren.
