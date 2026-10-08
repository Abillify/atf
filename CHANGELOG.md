# Changelog

Notable changes to ATF are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Three things version independently of this file, because they are contracts rather than
releases:

- **Contract packages** under `packages/` carry their own versions. A breaking change to a
  cross-service message is a major bump there, and `integration/system` fails in CI when a
  change breaks the combined lifecycle.
- **Flows** declare `metadata.version` in their own YAML. That version appears as
  `flow_version` in the execution debug trace, which is how a deployed flow revision is
  verified after a rollout.
- **Node and tool schemas** are validated on load, so an incompatible flow fails at load
  time rather than mid-execution.

## [Unreleased]

## [0.14.0] — 2026-10-08
Platform-Härtung, Phase 1 (Fundament), Phase 3 (Audit-Integrität) und Phase 4
(Compliance/DSAR). Phase 1 bringt zwei neue interne Contract-/Sicherheitspakete, ohne dass
sich ein Service geändert verhält; die Migration der Services folgt in den nächsten Phasen.
Phase 3 härtet die Audit-Kette gegen Abzweigung, Genesis-Neustart nach Ausfall und
nachträgliche Veränderung, und schreibt Regulierte_Aktionen nur noch nach durablem
Audit-Erfolg fort. Phase 4 macht DSAR-Löschungen über alle Stores vollständig, idempotent
und ehrlich: Search, Extract und Gate melden je-Store-Teilergebnisse über den
Erasure-Contract, die Runtime verteilt als Orchestrator und stellt einen signierten
Erasure_Receipt aus; ein Outpost-MirrorDelete löst den vollständigen Search-Cascade aus.
Phase 5 härtet Extract gegen feindselige Dokumente (ZIP-Guard, sicheres XML, Parser- und
Converter-Isolation, Subprozess-Limits, gehärtetes LibreOffice-Profil) und begrenzt Kosten
und Speicher (Tagesbudget für Vision-Seiten, `MAX_PAGES`-Default, Upload-Spill auf Platte);
Phase 6 macht den Tenant-Scope in Search verpflichtend und stimmt das Retrieval ab, abgesichert
durch ein CI-Qualitäts-Gate gegen echte Modelle.
### Added
- **`@atf/security-kit`** (`packages/security-kit`, privat). Gemeinsame Sicherheitsbausteine:
  `safeEqual`/`safeEqualBytes` (SHA-256-Digest-Vergleich, timing-sicher), striktes
  Base64URL (Padding- und Bit-Prüfung, auch als `@atf/security-kit/browser` für Control),
  `EgressGuard` (Sperrtabelle inkl. 198.18/15, 192.0.0/24, 64:ff9b::/96, 2002::/16,
  IPv4-mapped/compatible, NAT64 und 6to4; DNS-Pinning über `lookup`, Redirect-Revalidierung,
  `maxBytes`, `timeoutMs`, `allowPrivateHosts`), JWT-/OIDC-Modul (feste Algorithmen,
  Multi-Issuer-Routing über unverifiziertes `iss`, Discovery mit Single-Flight,
  Positiv-Cache aus `Cache-Control` mit 5-min-Untergrenze, Negativ-Cache 30 s exponentiell
  bis 5 min), Rate-Limit-Kern (GCRA mit Memory-Backend inkl. Eviction und Redis-Backend
  über atomares Lua, konfigurierbarer Fail-Mode) sowie Prod_Gate-Regelbausteine mit
  gemeinsamem Reporter (Services behalten ihre eigene `prod-gate.ts`). Tests laufen unter
  Bun und Node (`test:node`).
- **`@atf/erasure-contract`** (`packages/erasure-contract`, privat). Normativer
  DSAR-Vertrag über Service-Grenzen: `ErasureRequestSchema` (idempotent über `requestId`,
  Scopes `subject`/`tenant`/`reference` mit Querschnittsprüfen), `ErasureStoreResultSchema`
  (`ok`/`failed`/`not_configured`, nicht-negative Zähler), `ErasureResponseSchema` und der
  signierbare `ErasureReceiptPayloadSchema` (Subjekt nur als `sha256(tenantId|identifier)`,
  kanonisches JSON mit rekursiv sortierten Keys als Signatur-Bytes; Signaturalgorithmus im
  Envelope, nicht im Payload).
- **Audit-Ketten-Integrität** (`@atf/runtime`, Req 1.1–1.3). Tip-Lesen, ID-Vergabe
  (`nextval`), Hash-Berechnung und INSERT laufen in einer Transaktion unter
  `pg_advisory_xact_lock(hashtext('atf:audit_log'))`; der Tip-Cache ist entfallen, die Kette
  wird ausschließlich aus dem persistierten Zustand fortgeschrieben. Genesis kommt nur bei
  nachweislich leerer Tabelle zum Einsatz — ein Lese- oder Schreibfehler wird geworfen statt
  die Kette still neu bei Genesis zu starten; ein Tip ohne Hash (beschädigte Kette) wird
  abgelehnt.
- **`recordRequired` / Regulierte_Aktionen** (`@atf/runtime`, Req 1.4–1.5). Neue
  `AuditLog.recordRequired()` löst erst nach durablem Schreibvorgang auf und wirft bei
  Fehler. `compliance/regulated-actions.ts` listet die regulierten Aktionen
  (`flows.publish`/`rollback`/`delete`, `approvals.resolve`, `dsar.self_erasure`,
  `compliance.forget`, `tenant.delete`, `api_key.create`/`revoke`, `byok.set`); deren Routen
  beantworten einen Audit-Fehler mit `503 AUDIT_UNAVAILABLE` und melden den Erfolg nicht als
  abgeschlossen.
- **Append-only `audit_log`** (`@atf/runtime`, Migration 42/43, Req 1.1/1.5). Trigger
  `audit_log_immutable` blockiert UPDATE/DELETE (Retention ausschließlich über
  `audit_log_purge(before_at)` als SECURITY-DEFINER-Funktion mit Vorab-Anker); Migration 42
  legt die Tabelle `audit_anchors` an, Migration 43 entzieht `aiperator_app` und
  `aiperator_operator` UPDATE/DELETE auf `audit_log` (auch in `rls-onboarding.ts`, dort
  tabellenexistenz-gesichert).
- **Anker, Metrik und Health** (`@atf/runtime`, Req 1.8–1.9). Prod_Gate warnt in Produktion
  ohne `AUDIT_ANCHOR_FILE`; die Metrik `aiperator_audit_write_failures_total` zählt
  fehlgeschlagene durable Schreibvorgänge (Hook in `createAuditLog`); `/health/ready` zeigt
  einen `audit`-Hinweis bei Schreibfehlern (nie 503); der Shutdown lässt die Schreib-Warteschlange
  in einem Grace-Fenster ablaufen und zählt nicht abgearbeitete Writes auf die Metrik.
- **DSAR-Löschung in Search** (`@atf/search`, Req 2.5–2.6, Tasks 4.2–4.5). Der
  Löschpfad über alle Tabellen ist aus `deleteRevisionCascade` extrahiert
  (`deleteDocumentCascade`) und auf Reference-, Metadaten-Delete und Revisions-Abort
  umgestellt; die Cache-Invalidierung erfolgt nach COMMIT. `POST /v1/erasure`
  (Scopes `subject`/`reference`/`tenant`) löscht inkl. Statistiken und
  Idempotenz-Ledger (Migration `GLOBAL_SCHEMA_VERSION = 9`,
  `vs_search_stats.query_hash`, `STATS_STORE_RAW_QUERY`); Property-Tests
  (Property 3) belegen die Vollständigkeit über alle Search-Tabellen.
- **DSAR-Löschung in Extract** (`@atf/extract`, Req 2.7, Task 4.6).
  `POST /v1/erasure` (Scope `extract.erasure`) für Jobs, Upload-Sessions,
  Seitenbilder und verwaiste Quell-Blobs mit Ledger
  (`extract.erasure_ledger`, DDL v4); der Aufruf löst die Search-Kaskade mit
  demselben `requestId` aus und meldet sie als Teilergebnis `search.documents`
  zurück — ohne Search-Ziel `not_configured`, nie Erfolg durch Weglassen.
  `DELETE /v2/documents` meldet das Ergebnis des Search-Cascade.
- **Audit-Redaction und Erasure im Gate** (`@atf/gate`, Req 2.8, Task 4.7).
  Audit-Events werden über `audit.redact` (Pfade und Extra-Keys) geschwärzt,
  `POST /v1/erasure` (Scope `gate.erasure`) löscht im persistenten Sink
  idempotent über das Erasure-Ledger mit Tombstones; Fingerprint über
  kanonisches JSON aus `@atf/erasure-contract`.
- **Erasure-Orchestrator** (`@atf/runtime`, Req 2.9–2.12, Tasks 4.8–4.13).
  `compliance/erasure-orchestrator.ts` verteilt DSAR-Löschungen parallel an alle
  konfigurierten Stores (lokale `RetentionService`-Ziele plus
  `ERASURE_TARGETS` = `[{service, url, tokenEnv}]`) mit Timeout, drei
  Versuchen und exponentiellem Backoff; Operationen und Je-Store-Teilergebnisse
  liegen in `erasure_requests` (Migration 44) und sind idempotent über
  `requestId` — ein Wiederholungsaufruf replayt das gespeicherte Ergebnis.
  Retry (`POST /admin/compliance/erasures/:id/retry`) läuft nur die
  fehlgeschlagenen Stores erneut. Die DSAR-Antwort (`DELETE /v1/me/data`)
  ist ehrlich: HTTP 200 nur bei Vollerfolg, 207 `ERASURE_PARTIAL` bei
  Teilergebnis, 502 bei Gesamtausfall; der Erfolgstext erscheint nur bei
  Vollerfolg (Property 4).
- **Erasure_Receipt** (`@atf/runtime`, Req 2.11, Tasks 4.11–4.12). Jeder
  abgeschlossene Löschvorgang erhält einen signierten Beleg über das
  kanonische JSON des Payloads (Ed25519 über `ERASURE_RECEIPT_SIGNING_KEY`,
  Fallback HMAC über `AUDIT_ANCHOR_SECRET` mit `alg`-Hinweis im Envelope);
  das Subjekt erscheint ausschließlich als `sha256(tenantId|identifier)`.
  `GET /v1/me/data/erasures/{id}` liefert den Beleg nur an das betroffene
  Subjekt desselben Tenants. Property 5: `verify(sign(receipt)) = true`,
  jede Bit-Änderung an Payload oder Signatur ergibt `false`.
- **Systemtest Erasure** (`integration/system/erasure.test.ts`, Task 4.13).
  Der echte Orchestrator fährt gegen Contract-konforme Stub-Server für
  Search, Extract und Gate (Verteilung, Je-Store-Ergebnis, Idempotenz,
  Teilfailure→partial→Retry, Receipt-Verifikation); live env-gated
  (`OUTPOST_IT_*`) zusätzlich Outpost-MirrorDelete → Extract → Search und die
  Extract-Kaskade `POST /v1/erasure` mit `search.documents`-Teilergebnis.
- **ZIP-Guard** (`@atf/extract`). Jeder ZIP-basierte Container (XLSX, VSDX, DOCX, PPTX und
  in DOCX eingebettete OOXML-Pakete) wird vor dem Entpacken allein anhand des
  Central Directory geprüft: Eintragsanzahl (`ZIP_MAX_ENTRIES`, 10000), Summe
  (`ZIP_MAX_TOTAL_BYTES`, 512 MiB) und größte unkomprimierte Größe (`ZIP_MAX_ENTRY_BYTES`,
  200 MiB) sowie Kompressionsverhältnis je Eintrag (`ZIP_MAX_RATIO`, 100). Ein Verstoß lehnt
  den Job mit dem neuen, nicht wiederholbaren Fehlercode `DOCUMENT_TOO_COMPLEX` (422) ab.
- **Sicheres XML** (`@atf/extract`). Alle `fast-xml-parser`-Instanzen entstehen zentral in
  `pipeline/safe-xml.ts` mit abgeschalteter Entity-Verarbeitung (XXE, Billion Laughs); die
  fünf vordefinierten XML-Entities werden gezielt dekodiert, sodass `&` in Zellen und
  Überschriften erhalten bleibt.
- **Parser-Isolation** (`@atf/extract`). Die nativen Parser (BPMN, XLSX, DOCX, VSDX, E-Mail)
  laufen in einem Worker-Thread mit Heap-Grenze (`PARSE_ISOLATED`, Default `true`;
  `PARSE_MEMORY_LIMIT_MB`, Default 512, durchgesetzt unter Node, von Bun ignoriert). Ein
  Überschreiten endet mit `DOCUMENT_TOO_COMPLEX` statt den Dienst mitzureißen; startet der
  Worker nicht, folgt `child_process.fork` und zuletzt der In-Process-Aufruf mit Warnung.
  `MAX_EMBED_DEPTH` (Default 2) begrenzt die Verschachtelung eingebetteter `.msg`-Nachrichten;
  tiefere werden mit Warnung übersprungen.
- **Isolierter Converter** (`@atf/extract`). `CONVERTER_MODE=isolated` leitet alle
  poppler-/LibreOffice-/Tesseract-Aufrufe per zeilenweisem JSON-RPC über einen Unix-Socket
  (`CONVERTER_SOCKET`, Default `/run/atf-converter/converter.sock`) an einen separaten
  Converter-Prozess (`node dist/converter/server.js`, gedacht für einen Container ohne
  Netzwerk, mit schreibgeschütztem Root-Dateisystem und ohne Root-Rechte). Über den Socket
  gehen nur Kommandozeile und Ausgabe, nie Dokument-Bytes; Ein- und Ausgabeverzeichnisse
  liegen auf einem gemeinsam gemounteten Volume unter demselben Pfad. Default bleibt `local`.
  Der Build erzeugt dafür zusätzlich `dist/pipeline/isolate-entry.js` und
  `dist/converter/server.js`.
- **Subprozess-Limits und gehärtetes LibreOffice** (`@atf/extract`). Unter Linux mit
  `prlimit` begrenzen `SUBPROCESS_MEMORY_LIMIT_MB` (`--as`, Default 0 = aus; im Container
  das cgroup-Limit verwenden) und `SUBPROCESS_CPU_LIMIT_S` (`--cpu`, Default 900) jeden
  Converter-Aufruf. Jedes private LibreOffice-Profil startet mit deaktivierten Makros,
  blockierten Links aus nicht vertrauenswürdigen Quellen und ohne Aktualisierung verknüpfter
  Inhalte.
- **Tesseract-OCR-Fallback** (`@atf/extract`). Mit `OCR_FALLBACK=tesseract`
  (`TESSERACT_BIN`, `OCR_LANG`, Default `deu`) erhält eine gescannte Seite bei Ausfall des
  Vision-Modells OCR-Text mit Warnung an der Seite statt zu scheitern. Default `off`; Binary
  und Traineddata müssen im Image bzw. im Converter vorhanden sein.
- **Tagesbudget für Vision-Seiten** (`@atf/extract`, DDL v5). `VISION_BUDGET_PAGES_PER_DAY`
  begrenzt die VLM-Seiten je Tenant und UTC-Tag über alle Jobs (atomarer Zähler in
  `extract.vision_daily_usage`); ein Job, der die Grenze überschreiten würde, scheitert mit
  dem neuen Fehlercode `BUDGET_EXCEEDED` (429, nicht wiederholbar). Default 0 = aus; Prod_Gate
  warnt dann.
- **Structured Output für Vision** (`@atf/extract`). Mit `VISION_SUPPORTS_JSON_SCHEMA=true`
  sendet der Vision-Client `response_format: json_schema` für Seiten- und Pass-2-Anfragen;
  lehnt der Provider das Feld ab oder ist die Antwort kein konformes JSON, greift der
  bisherige Tag-Parser. Default `false`.
- **Upload-Spill auf Platte** (`@atf/extract`). Multipart-Uploads oberhalb
  `UPLOAD_MEMORY_THRESHOLD_BYTES` (Default 8 MiB, 0 = immer) werden unter `TEMP_DIR/uploads`
  zwischengespeichert statt im Heap auf einen Konvertierungsplatz zu warten; ein Sweep beim
  Start räumt Reste nach einem Absturz ab.
- **Retrieval-Qualitäts-Gate** (CI, `scripts/eval`). Der neue CI-Job `eval` startet
  `scripts/eval/compose.eval.yaml` (Search, Extract, TEI-CPU-Embedding und Cross-Encoder-
  Rerank, deterministischer HyDE-Mock), ingestiert den deterministischen Golden-Korpus und
  scheitert bei Unterschreitung von `scripts/eval/baseline/thresholds.json`; Baseline und
  Ablationen (dense, rerank, HyDE, Kontext-Header) liegen unter `scripts/eval/baseline/`.
### Changed
- CI-Job `contracts` läuft jetzt zusätzlich `security-kit` und `erasure-contract`;
  Supply-Chain-Inventare (`THIRD_PARTY_NOTICES.md`, `sbom.cdx.json`) neu generiert.
- Regulierte Aktionen (Flows, Tenants, Approvals, Compliance/DSAR) auditiert die Runtime über
  `recordRequired` statt best-effort `record()`; bei Audit-Unverfügbarkeit antworten sie mit
  `503 AUDIT_UNAVAILABLE` (`AUDIT_UNAVAILABLE` ist ein neuer Fehlercode).
- **Verpflichtender Tenant-Scope und Retrieval-Abstimmung** (`@atf/search`). Jede
  Zugriffs-SQL verlangt einen expliziten Scope (Operator-Pfade über `operatorScope()`);
  `DOCUMENT_ACL_DEFAULT` (Default `allow`, Prod_Gate warnt) und `ACL_REQUIRE_IDENTITY` mit
  Scope `search.assert-identity` für zugesicherte Identitäts-Header. HNSW mit iterativem Scan
  (`HNSW_ITERATIVE_SCAN`, Default `relaxed_order`) und `ef_search` ≥ Kandidatenlimit,
  Sparse-Fusion über FULL OUTER JOIN (`RRF_WEIGHT_SPARSE`, `RRF_MISSING_ZERO`), gemeinsame
  zeitliche Sichtbarkeits-CTE, `FTS_RANKER` (`ts_rank_cd` oder `bm25`) und
  `MIN_RERANK_SCORE` mit Enthaltungsfeld. Suchstatistiken speichern nur noch
  `query_hash` (HMAC mit `STATS_QUERY_PEPPER`); Rohanfragen nur mit `STATS_STORE_RAW_QUERY`.
- **`MAX_PAGES`-Default 0 → 500** (`@atf/extract`). Ohne explizite Konfiguration lehnt der
  synchrone v1-Konvertierungspfad Dokumente über 500 Seiten mit `TOO_MANY_PAGES` (422) ab.
- **Prod_Gate Extract**: `SUBPROCESS_TIMEOUT_MS=0` verhindert jetzt den Start in Produktion;
  `VISION_BUDGET_PAGES_PER_DAY=0` erzeugt eine Warnung.
### Migration
- Extract: Wer längere Dokumente verarbeitet, setzt `MAX_PAGES` explizit (0 = unbegrenzt).
  Produktionskonfigurationen mit `SUBPROCESS_TIMEOUT_MS=0` müssen einen positiven Wert setzen.
- Extract-DDL steigt auf Version 5 (`extract.vision_daily_usage`); die Migration läuft
  automatisch beim ersten Datenbankzugriff (Advisory-Lock, eine Transaktion) und ist additiv.
- Für `CONVERTER_MODE=isolated` muss neben Extract ein Converter-Prozess aus dem Extract-Build
  mit demselben `CONVERTER_SOCKET` und demselben Scratch-Volume (`TEMP_DIR`) laufen; für
  `OCR_FALLBACK=tesseract` muss `tesseract` samt Sprachdaten installiert sein. Das
  Beispiel-Image `deploy/examples/Dockerfile` enthält Tesseract nicht.

## [0.13.2] — 2026-10-05
Hardens the LLM tool loop for local models: the `maxToolSteps` budget ends with an answer
round, retries continue from the recorded tool results, and tool calls written as plain text
are never delivered as the answer. LLM nodes gain the opt-in configs `turnContext` and
`sourcesCheck`, and the execution debug trace reports `provider_attempts`. Control gains
per-flow run statistics, a flow diff page for any two flows or drafts, the full error recording
from the debug trace in the Live Graph, a user filter and conversation header rows in History,
and flow-local save modes in the prompt editor. Two read-only HTTP endpoints are added
(`GET /monitoring/flow-stats`, `GET /flows/diff/compare`); no environment variable, migration,
contract-package, or example-flow change.
### Added
- **Per-flow run statistics** (`@atf/runtime`, Control). `GET /monitoring/flow-stats?since=<ISO>`
  returns runs, average runtime, average and total cost per flow for executions started at or
  after `since` (400 without a valid timestamp; same read gate as the history endpoints;
  operator-plane across tenants like the other history reads). The flow table shows these as
  columns with a 1h/1d/1w/1m window selector (default 1d); flows without runs show a dash.
- **Flow diff between any two endpoints** (`@atf/runtime`, Control).
  `GET /flows/diff/compare?from=<flowId>&to=<flowId>` (optional `fromDraft`/`toDraft`, scope
  `flows:read`) diffs two arbitrary flows or drafts. Each side resolves to the named draft, else
  the published definition, else the file definition, else the default draft; an unknown flow
  or draft answers 404. The `/flow-diff` page picks both sides in a searchable picker that can
  list each flow's named drafts under it, and `GET /flows` entries carry their `drafts`
  (`draftId`, `label`).
- **Full error recording in the Live Graph** (Control). Failed nodes show the error type,
  structured details, the diagnostics timeline and the failing tool result from
  `GET /monitoring/debug/:executionId`, also as a hover tooltip on the node card. The trace is
  fetched once per execution and again when a running execution finishes; a 404 (trace evicted
  from the bounded in-memory buffer) falls back to the plain event `error_message`. Node status
  stays event-derived.
- **History grouping and user filter** (Control). Requests of one conversation sit under a
  header row with flow, user, summed runtime and cost, status and start. History and the Live
  Graph share a filter popover with flow include/exclude and a searchable user select; the
  Live Graph keyword filter also matches user, flow name and request id.
- **Flow-local save modes in the prompt editor** (Control). Besides saving the prompt file
  (which affects every flow that includes it), "Save as" writes a copy under a new name and
  points only this flow's `#[[file:…]]` reference at it, and "Copy into flow" replaces the
  include with the edited text without writing to disk.
- **`turnContext`** (LLM nodes, `@atf/runtime`). A template appended to the newest user turn
  instead of the system prompt, so per-request context such as a classifier's image
  transcription reaches the responder without system authority and without changing the
  cacheable prefix. Supports `{{context.*}}`, `{{now.*}}`,
  `{{node.<id>.classification.<field>}}` and `{{turn[n]...}}`; the block is omitted when every
  referenced placeholder resolves empty.
- **`provider_attempts` in the execution debug trace** (`@atf/runtime`). LLM nodes report
  `total`, `failed`, `final_attempt` and `final_outcome` of the provider calls made inside one
  node attempt, derived from the `llm_provider_attempt_completed` diagnostics. `attempt` keeps
  counting graph attempts only, so a provider retry no longer looks like a single clean call.
- **Opt-in post-answer sources check `sourcesCheck`** (LLM nodes, `@atf/runtime`). Off by
  default. `completeSection: true` appends every inline-cited `[n]` that the sources section
  (`heading`, default `## Quellen`) lacks, built only from the sources registered in the same
  execution, and creates the section when it is missing; the completion is streamed as a
  trailing chunk and persisted with the answer. Cited numbers without a registered source are
  reported, never invented. `stripRuleMarkers: true` separately removes the pseudo marker
  `[Regel: …]` from answer text that has not been streamed yet (for example with
  `suppressToolPreamble`); other bracketed content is left untouched. Results appear in the
  `answer_sources_check` diagnostic.
### Fixed
- **Tool loop ends with an answer round at the `maxToolSteps` budget** (`@atf/runtime`).
  When the budget is exhausted the node now runs one extra model round without tools and with
  an explicit answer instruction (diagnostic `tool_budget_final_answer_round`) instead of
  stopping right after the last tool result. Flows that exhaust the budget make one more model
  call per attempt. This round and the answer-only retries below keep tool calls out in a
  provider-valid way: OpenAI, Azure, Ollama and OpenAI-compatible endpoints get no tool
  definitions; Google keeps the declarations with function calling mode `NONE`; Anthropic,
  Bedrock and unknown providers get the recorded tool calls and results as plain text
  (tool name, call id, arguments, result) without tool definitions, because their SDKs drop
  the tools under tool choice `none`. Anthropic would otherwise reject the request, and
  Bedrock would silently remove the tool results from it.
- **`post_tool_answer_missing` retry continues from the tool results** (`@atf/runtime`). The
  retry replays the attempt's tool calls and results and offers no tools, instead of
  restarting from the original prompt with a truncated excerpt of the last result. The
  excerpt remains only as a fallback when no tool exchange can be recorded, and that retry
  offers no tools either.
- **Text tool calls are never delivered as the answer** (`@atf/runtime`). Tool calls written
  as plain text (Qwen XML `<function=…>`, Hermes `<tool_call>{…}</tool_call>`) are held back
  from `content` in every step, with or without `suppressToolPreamble`, and rejected
  (`text_tool_call_rejected`). After a tool exchange the retry is an answer-only continuation
  without tools; before any tool use it keeps the tools and asks for a native call (answer-only
  from the second-to-last attempt on). The node fails on the last attempt
  (`text_tool_call_unrecoverable`). Without `suppressToolPreamble`, prose already streamed
  before an inline call in the same step cannot be retracted.
- **Attachment markup no longer leaks into `{{query}}`** (`@atf/runtime`). Open WebUI's
  `<attached_files>…</attached_files>` part is stripped from the last user query before it
  is used in retrieval tool arguments.
- **Reasoning preamble no longer leaks into the persisted answer** (`@atf/runtime`). When the
  final assistant message is the streamed answer plus a prefix (a model echoing its reasoning
  through the LM Studio reasoning shim), the persisted and replayed response keeps only the
  streamed answer; diagnostic `reasoning_prefix_stripped` reports the removed length.
- **Tool node events carry the request identity** (`@atf/runtime`). Tool start and end events
  include `user_name` and `user_prompt`, so a live picker row built only from tool events (for
  example after joining mid-run) shows user and prompt before the parent node completes; the
  Live Graph also backfills these fields from the durable history row.
- **Auth config probe times out** (Control). The OIDC config probe aborts after 5 s and
  resolves to "disabled", so a hung request no longer leaves the dashboard on its loading
  spinner; failed probes are not cached, so a later page load retries.
- **History table row actions are full-size icon buttons** (Control). The per-row actions in
  the persisted history use a new outlined `size="icon"` button variant instead of small ghost
  buttons whose padding squeezed the icons.
## [0.13.1] — 2026-10-04
Keeps an MCP server online when a reconnect attempt fails. No configuration, schema, flow,
migration, HTTP endpoint, or contract-package change.
### Fixed
- **MCP reconnect is make-before-break** (`@atf/runtime`). `reconnect()` closed the shared
  client before opening the replacement, so a failed handshake (for example a connect timeout
  while the peer was busy) took every tool of that server offline until the next successful
  periodic reconnect. The replacement session is now opened first and the old client is only
  closed once the new one is live; a failed reconnect keeps the existing session, and a late
  handshake is closed instead of leaking a transport. A caller-authenticated server
  (`forwardAuthToken` without a static `Authorization` header) still gets no shared session on
  reconnect, and its stale shared client is now closed rather than only dropped.
## [0.13.0] — 2026-10-04
Studio works with named drafts per flow (Runtime schema migration 41), cost displays are
currency-labelled via `CURRENCY` / `NEXT_PUBLIC_CURRENCY` (default EUR, label only, no
conversion), and the graph shows per-edge data channels live during a run. Tool calls stream
the full effective argument JSON instead of key names, LLM and classifier nodes can skip
themselves when the current turn carries no attachments, LLM nodes can work with short
reference handles instead of long paths, and an opt-in guard stops runaway tool loops. No
contract-package or example-flow change.
### Added
- **Named drafts** (`@atf/runtime`, Control Studio). Several working copies per flow:
  `GET /flows/:id/drafts` lists them, `PUT`/`DELETE /flows/:id/drafts/:draftId` save and remove
  one, and publish selects a draft via `?draftId=`; the implicit `PUT /flows/:id/draft` stays
  the `default` draft. Studio switches drafts without a request per draft, shows the draft
  count, and offers a Draft↔Live switch for online flows.
- **Currency labelling** (`@atf/runtime` `CURRENCY`, Control `NEXT_PUBLIC_CURRENCY`).
  All cost displays render in one configured currency (`EUR`, `USD`, `CHF` or `GBP`; default
  `EUR`); values are never converted, only the symbol changes. This includes eval reports,
  explain cards and the daily-budget error message. Wire and config field names (`cost_usd`,
  `maxCostUsd`, …) are unchanged. An unknown value falls back to `EUR` (Runtime logs a
  warning).
- **Edge data channels in the Studio graph** (`@atf/control`, `@atf/runtime`). Each edge
  renders one line per payload actually passed (query, images, tool results, data), refreshed
  live while the run is in progress; clicking a channel opens the edge's property panel. The
  Runtime records them as `edge_flows` in the execution debug trace (content clamped to 1 KB
  per item, at most 16 items per record and 200 records per trace).
- **`toolLoopGuard`** (LLM nodes, opt-in). Detects identical repeats, same-tool argument
  churn, no-progress mutations and A→B cycles; the model gets one warning, then the call is
  refused with `tool_loop_blocked` without reaching MCP. Counted in
  `aiperator_tool_loop_guard_total`.
- **Per-server MCP timeouts and retries** (`MCP_SERVERS` entries). `requestTimeoutMs`
  (ms, 1 000–600 000) replaces the 5 s wrapper default for one call attempt; `retryAttempts`
  (1–10) replaces the annotation-based default (3 for `readOnlyHint`/`idempotentHint` tools,
  otherwise 1) for every tool of that server.
- **`sources` on non-streaming chat completions.** `stream: false` responses carry the
  indexed citation sources the SSE path already emitted, so `[n]` markers resolve.
- **Studio panels** (`@atf/control`). Side panels are resizable (width remembered per
  browser, keyboard-operable separator); the properties panel only appears while something is
  selected, with a Flow settings button for flow-level settings; Copilot and Run & Trace are
  toggled individually and stack vertically. The sub-flow palette lists sub-flow files inline
  and includes one by click, double-click or drop onto the canvas. JSON editors mark the
  documentation entry for the key under the cursor.
- **Run & Trace** (`@atf/control`). Reasoning streams into an open Thinking block that
  collapses when the answer starts, and images attached to a test prompt are sent as
  `image_url` content parts.
- **Execution history** (`@atf/control`). Only requests of one conversation form a
  collapsible group (single requests render as plain rows), and row actions are compact icon
  buttons with accessible names.
- **`inputFilter: current-turn-attachments`** (LLM and classifier nodes). The node is
  skipped without a model call when the current user turn has no attachments; the
  classifier records `classifier_skipped_no_attachments` and continues with its
  `fallback`. Saves a full LLM round-trip per text-only turn.
- **`refHandles: true`** (LLM nodes). Tool results carry short deterministic reference
  handles instead of long paths; the runtime resolves them before the MCP call and maps
  them back in everything the user sees. A guessed handle fails loudly with the list of
  valid handles.
- **Sortable History columns** (`GET /monitoring/history?sortBy=&sortDir=`). Server-side
  sorting (whitelisted columns only, `NULLS LAST` + stable tiebreaker) for started, flow,
  user, nodes, latency, runtime and cost; the History table headers toggle direction.
- **`metadata.hidden: true`** (`@atf/runtime`, flow files). Internal helper flows are
  omitted from `GET /v1/models` and answer `404` on `GET /v1/models/:id`, so clients such
  as Open WebUI do not offer them in the model picker. The flow stays loaded and
  dispatchable; only discovery is affected.
### Changed
- **Full effective tool-argument JSON in the live stream.** Tool-call events carry the
  exact arguments the tool received (post egress-DLP) instead of `{"argument_keys":[…]}`;
  raw model arguments are still never emitted before the effective ones. `tool` and
  `retrieval` nodes and the local tools (`select_tools`, image inspection, media tools) report
  their effective arguments the same way.
- **Debug trace keeps the final answer.** `final_response` has its own 64 KB budget
  (`finalResponseBytes`) instead of the 512-byte per-node excerpt limit.
- **Agent harness coverage.** With a complete server-side rerank, search-driven discovery
  promotes hits by score threshold only; the rank rule remains the fallback when the rerank is
  missing or incomplete. Coverage deduplicates documents by canonical document-unit identity
  (chunk hits collapse onto their unit), and the debug trace reports the exact number of
  documents still owing work.
- **Tool-loop detection** no longer counts failed calls (transport errors, timeouts, `isError`
  results) towards argument churn.
- **Docs and Copilot examples** use the neutral route `RETOURE`; `docs/FLOWS.md` documents the
  node `label` field, tool-node `args`, `toolLoopGuard`, `refHandles` and the extended
  `overrides` matching.
### Fixed
- **Trace lookups by chat id.** ids of the form `chatcmpl-<uuid>` (and
  `chatcmpl-replay-<uuid>`) resolve to the execution again in explain, debug, history and
  optimizer endpoints instead of `404`.
- **Classifier after a result-injecting tool node.** Non-leading system messages are folded
  into an adjacent turn before the classifier prompt, so strict chat templates no longer
  reject the request and silently route to `fallback`.
- **Planning narration between tool steps** no longer leaks into the visible answer when
  narration suppression is on; only the final answer is released.
- **Control with operator auth disabled.** A stale session token without a `role` claim no
  longer greys out the UI; the role is `admin` whenever auth is not required. Server-side
  authorization is unchanged.
- **`cli.ts validate`** skips the shared `constants.yaml`, like the flow loader.
- Extract creates its `TEMP_DIR` scratch root on demand before allocating render and conversion work directories, so a cleaned or missing scratch root no longer fails `/v2/render` and conversions with HTTP 500.
### Migration
- Runtime schema version 41 adds `flow_drafts` (PK `flow_id`/`draft_id`) and backfills each
  flow's current draft as `default`. Applied automatically on start; no manual step.
- Cost figures and pricing (`LLM_PRICING`, built-in table) are now labelled in `CURRENCY`,
  default `EUR`. Deployments that priced in US dollars set `CURRENCY=USD` and
  `NEXT_PUBLIC_CURRENCY=USD` to keep the `$` label.
- Control freezes `NEXT_PUBLIC_CURRENCY` at build time; it should match the runtime's
  `CURRENCY` so Studio and API views label costs identically.
## [0.12.0] — 2026-09-30
Adds the Extract Outpost, a locally operated sync agent that mirrors local folders, S3, Google
Drive and Dropbox into Extract, plus the three Extract extensions it relies on.
`@atf/extract-contract` moves to 2.2.0 (additive). Extract applies schema migration 3 on start.
No flow or configuration-variable change; the new scope `extract.delete` must be granted to
clients that delete documents.
### Added
- **Extract Outpost** (`@atf/outpost-core`, `apps/outpost`, `apps/outpost-desktop`). Sync core
  with change planning, resumable uploads, job polling, retry policy, crash-safe journal state
  and a delete planner with mirror-delete threshold and explicit confirmation. Docker runtime
  with health endpoint, graceful shutdown, `source-login` and `confirm-deletes`; Tauri desktop
  app with a Node SEA sidecar, loopback Control API and OS-keychain credentials. Extract
  authentication via API token, client credentials, device code or PKCE; cloud sources
  authorize read-only via OAuth (or a Google service account). See `apps/outpost/README.md`
  and the Extract Outpost section in `DEPLOYMENT.md`.
- **`GET /v1/whoami`** (`@atf/extract`). Reports principal, scopes, feature flags and
  `limits.maxUploadBytes` for any valid token.
- **`DELETE /v2/documents/{reference}`** (`@atf/extract`). Deletes a document by reference
  under the new scope `extract.delete`: cancels active jobs, removes it from Search, `404` when
  nothing was deleted. New metric `extract_documents_deleted_total`.
- **Own-job reads** (`@atf/extract`). `GET /v2/jobs/{id}` is readable with `extract.ingest` by
  the job's originator; foreign jobs answer like unknown ids. Listing stays `extract.admin`.
- **`@atf/extract-contract` 2.2.0**: `whoamiResponseSchema`, `deleteDocumentResponseSchema`
  and the `NOT_FOUND`/`FORBIDDEN` error shapes.
- **`outpost-release` workflow** for `outpost-v*` tags (test and Docker image jobs); the
  updater repository comes from the repository variable `OUTPOST_UPDATER_REPO`.
### Migration
- Extract schema version 3 adds the nullable columns `created_by_subject` and
  `created_by_tenant` to `extract.jobs`. Existing jobs stay owner-less and admin-only.
## [0.11.1] — 2026-09-30
Fixes a guaranteed `403` on Search MCP calls that pass `requesting_user` while authorization is
disabled. No configuration, schema, flow, migration, HTTP endpoint, or contract-package change.
### Fixed
- **`requesting_user` with `AUTHZ_ENABLED=false`** (`@atf/search`). `requireActingUser` compared
  the requested user with the principal's identity even under the authorization bypass, where no
  identity exists, so `search` MCP calls with `requesting_user` always failed with
  "The requested user does not match the authenticated principal". The bypass now skips the
  match like every other check in the access scope; an empty `requesting_user` is still refused.
  With authorization enabled, behaviour is unchanged.
## [0.11.0] — 2026-09-28
Brings the Extract operator console to full Document Intelligence v2 support, adds HTML as an
input format, and fixes the v2 hand-off from Extract to Search (batch digests, new collections)
as well as transaction envelopes for token-exchange MCP servers. `@atf/extract-contract` moves
to 2.1.0; the `atf-extract/2.0.0` wire contract is unchanged. No configuration, migration or
flow change.
### Added
- **Extract operator console: full Document Intelligence v2 support.** With
  `EXTRACT_DATABASE_URL` set, a new "Neuer Job" tab uploads sources as resumable, per-chunk
  checksummed sessions (or pulls a `source_url`, or takes a stored sha256) and creates jobs with
  every `POST /v2/jobs` option. The ingest tab follows a `202` job to completion, reports
  duplicates, versions and revisions, and sends `X-Dedup` and `X-Source-Modified`. The Jobs tab
  adds reparse, resume with a resume policy, identity and revision details, a status/reference
  filter and an on-demand page preview. Health shows the `-bbox-layout` probe. New cookie BFF
  routes `/ui/uploads` and `/ui/render` mirror `/v2/uploads` and `/v2/render`.
- **`@atf/extract-contract` 2.1.0**: `POST /v2/jobs` accepts an optional `filename` (its
  extension types the source); the `Job` view gains optional `sourceSha256`, `sourceFilename`,
  `collection`, `visibility`, `resumePolicy` and `priority`.
- **Extract: HTML input** (`.html`, `.htm`, XHTML, sniffed from the content). LibreOffice Writer
  lays the page out after every reference it could follow is stripped (embedding elements,
  `<meta http-equiv>`, URL attributes except `<a href>` and inline `data:` images, CSS `url(…)`
  and `@import`), so an uploaded page cannot make Extract fetch internal URLs or read local
  files. External images are not rendered.
- **Extract: `GET /v2/jobs/{id}/figures`** (and `/ui/jobs/{id}/figures`) lists the figure blocks
  of a job's staged page records; crops render on demand through `POST /v2/render`.
- **Extract: `source_url` pulls report `content_type` and a derived `filename`**, so a job
  created from a pulled source is typed.

### Changed
- **`POST /v2/jobs` and the job-backed `POST /v1/ingest` validate the collection name up
  front** (Search's rule: a letter, then letters, digits or underscores) and answer 400,
  instead of a job that failed at emit after every page went through the model. The contract
  schema enforces the same rule, so a client validating with `jobRequestSchema` rejects such
  names too.
- **Extract: a failed job carries its cause as a warning** (at most 500 characters) in the
  status read and the console.
- **Search: an invalid collection name is 400 `INVALID_COLLECTION_NAME`** before the access
  check rather than an access denial, and `POST /v2/search` on a missing collection is 404
  instead of an embedding provenance mismatch.

### Fixed
- **Extract → Search: every v2 batch was refused with `CONTENT_DIGEST_MISMATCH`.** The emitter
  sent the sha-256 as hex inside the RFC 9530 `Content-Digest` structured field; it is now
  base64.
- **Search: the first v2 revision for a new collection failed forever** on the missing table.
  The batch worker now creates the collection with the embedding's vector size and the v1 ingest
  defaults.
- **Extract uploads**: a chunk's `204` is sent only after the session lock is released, so an
  immediately following chunk no longer hits a spurious 409; `complete` compares the declared
  size numerically (Postgres `BIGINT` arrives as a string) and records the stored digest, so a
  retried `complete` answers idempotently.
- **Extract jobs: a non-UUID job id is 404** instead of a 500 from a Postgres cast error.
- **Runtime: transaction envelopes for token-exchange MCP servers bind the exchanged subject.**
  `userId` in the envelope was the caller's login `sub`, while the peer authenticates the
  exchanged token, whose `sub` follows the target provider's subject mode (e.g. Taiga login
  `user_id` vs. `user_email` on the target). Search rejected every call with
  `403 TRANSACTION_IDENTITY_MISMATCH`, so RAG nodes failed. The envelope now uses the subject
  of the cached exchanged token (`McpWrapperService.targetSubject`).
- **Runtime: deterministic tool nodes emit a `tool_execution_failed` diagnostic** with only the
  structural failure class (error name, HTTP status, upper-case peer error code) when a call
  throws; the node result stays anonymized.
## [0.10.2] — 2026-09-28
Fixes an empty answer after a failed tool call and transaction rejections on token-exchange MCP
servers, and makes both failure classes visible in traces and server logs. No configuration,
schema, flow, migration, HTTP endpoint, or contract-package change.
### Changed
- **Diagnostics** (`@atf/runtime`). A step prompt that fails AI SDK message validation is reported
  as `llm_prompt_schema_invalid` with message index, role, and schema path; the rejected prompt
  value is no longer embedded in `llm_provider_error_detail`. An MCP error result records its
  bounded raw cause (at most 300 characters, server-side only) as `tool_result_error`. Warn- and
  error-level node diagnostics are mirrored to the server log with execution, flow, and node ids.
### Fixed
- **Empty answer after a failed tool** (`@atf/runtime`). The tool-result sanitizer replaced an
  error output with a bare `{ isError, error }` object, which is not a valid `ToolResultOutput`;
  the AI SDK rejected the next step with `AI_InvalidPromptError` and the node ended without text.
  The anonymized error is now replayed as `error-json`, so the model can answer the failure.
- **Tool errors shown as successful in the debug trace** (`@atf/runtime`). An error result that
  was already sanitized upstream was recorded as `is_error: false`.
- **Session binding of transaction envelopes** (`@atf/gate`, `@atf/runtime`). Gate compared an
  envelope's `sessionId` with its own MCP request id as well as the token's session claims, so a
  real OIDC `sid` never matched and every call was rejected with "Envelope.sessionId does not match
  the authenticated session". Only `sid`/`session_id` claims count now. Runtime no longer binds
  `sessionId` for `tokenExchange` servers, whose exchanged token carries no caller session.
## [0.10.1] — 2026-09-28
Reliability and diagnostics fixes for LLM provider failover and RFC 8693 token exchange, plus
neutral example data. No configuration, schema, flow, migration, HTTP endpoint, or contract-package
change.
### Changed
- **Diagnostics.** A failed provider attempt records its raw error chain (status, code; bounded,
  server-side only) as the `llm_provider_error_detail` trace diagnostic. Tools whose schema cannot
  be loaded are reported once per server and cause as `tool_schema_unavailable`, and a rejected
  token exchange is logged with its audience and IdP error code, never token material.
- **Examples.** Documentation, the node-type catalog, the Studio hint, and tests use neutral
  example names (`casework`, `cases`) instead of deployment-specific ones.
### Fixed
- **LLM failover on an unreachable provider** (`@atf/runtime`). Bun socket failures ("The socket
  connection was closed unexpectedly", codes such as `ConnectionClosed`) wrapped in an AI SDK
  `RetryError` were not recognised as transport failures, so a dead provider was retried three
  times with backoff and even reset its circuit breaker. Transport detection now follows `lastError` and
  `errors` as well as `cause` and knows Bun's socket codes and wording; a wrapped 4xx stays
  non-transport. While another candidate remains, `llm` and `classifier` nodes disable the provider
  SDK's internal retries, so a dead endpoint costs one fast attempt instead of about 6 s per try.
  Classifier nodes now report transport failures to the flow's provider circuit breaker.
## [0.10.0] — 2026-09-28
Adds OAuth 2.0 Token Exchange (RFC 8693) for caller-authenticated MCP servers and records the
acting party of delegated tokens end to end. Every change is opt-in and additive: without the new
`tokenExchange` (Runtime) or `oauth.actorPolicy` (Gate) settings, behaviour is unchanged. No
executable flow, migration, or HTTP endpoint changes. One independently versioned contract package
changes additively (see **Changed**).
### Added
- **Runtime token exchange** (`@atf/runtime`). A `forwardAuthToken` MCP server can declare
  `tokenExchange`; Runtime then exchanges the caller's verified bearer for a token minted for that
  server's `audience` (optionally scope-reduced) instead of forwarding the raw login token.
  Exchanged tokens are cached per subject, audience, scope, and actor, and concurrent misses are
  coalesced. The token endpoint is configured directly or discovered from `issuer`.
- **Delegation (on-behalf-of).** An optional `tokenExchange.actor` (`client_credentials`) adds an
  `actor_token`, so the issued token carries an RFC 8693 `act` claim that names Runtime as the
  acting party. The flow identity audit classifies such servers as `exchanged-token` or
  `delegated-token`.
- **Gate actor policy** (`@atf/gate`). Gate parses the `act` claim of OAuth tokens and records
  the actor on `tool_call` monitor events. The optional `oauth.actorPolicy` can require delegated
  tokens (`requireActor`) and restrict accepted actor subjects (`allowedActorSubjects`).
### Changed
- **Identity contract** (`@atf/identity-contract`) 1.1.0 → 1.2.0: the identity-principal
  contract version advances to 1.1.0 with an optional `actor`, and `GatePrincipalInput` accepts
  an optional `actor`. Principals with version 1.0.0 and no actor are still accepted.
  `@atf/contract-adapter` and `integration/system` reference the new version exactly.
### Fixed
- **`version:sync`** rewrote a file incorrectly when it held several occurrences and the new
  version had a different length (e.g. `0.9.2` → `0.10.0`), because later match offsets went
  stale. Occurrences are now rewritten back to front.
### Security
- Token exchange fails closed. Runtime exits at startup when `tokenExchange` lacks
  `forwardAuthToken: true`, is combined with `allowAnonymous`, or references an unset secret
  environment variable. At call time, a failed exchange or actor mint fails the tool call and
  never falls back to forwarding the un-exchanged token. A caller session whose exchanged token
  enters the refresh margin, or is rejected with HTTP 401, is rebuilt with a freshly exchanged
  token; the rejected call itself is not replayed. Secrets are configured only by
  environment-variable name (`clientSecretEnv`), and token material is never logged.
- Setup and Authentik requirements are documented in
  [docs/MCP-2026-CONTEXT-LAYER.md](docs/MCP-2026-CONTEXT-LAYER.md).

## [0.9.1] — 2026-09-28

Dependency maintenance plus one build fix for the optional Search Node.js artifact. Every
dependency change is a backward-compatible upgrade of an existing dependency; there is no
source, schema, flow, migration, or independently versioned contract-package change. Version
0.9.0 was never tagged, so this entry's compare link spans from `v0.3.0`, the last published
tag, and the release also carries everything documented under 0.9.0 and earlier untagged
versions. Third-party notices and the SBOM are regenerated to match the upgraded versions.

### Changed

- **Control** (`@atf/control`): `next` 16.3.5 → 16.3.6, `lucide-react` 1.45.0 → 1.48.0.
- **Runtime** (`@atf/runtime`): `@langchain/core` 1.2.11 → 1.2.13, `@langchain/langgraph`
  1.4.16 → 1.4.18 (transitively `@langchain/langgraph-sdk` 1.11.2 → 1.12.0).
- **Search** (`@atf/search`): dev `fast-check` 4.9.0 → 4.10.2, aligned with the other
  workspaces.
- **Workspace override**: transitive `adm-zip` (via `onnxruntime-node`) 0.6.0 → 0.6.1.

### Fixed

- **Search Node.js artifact.** `build:node` now marks `sharp` as external, matching Extract.
  `sharp` is a native module that `bun build --target node` cannot bundle; the Node artifact
  therefore expects `sharp` 0.35.4 to be installed for the target platform next to `dist-node`.
  The Bun target is unchanged.

## [0.9.0] — 2026-09-27

Version 0.8.0 is documented below but was never tagged either, so this entry's compare link
spans from `v0.3.0`, the last published tag, and it carries the work of 0.4.0 through 0.8.0 as
well.

Adds Document Intelligence v2. The HTTP surface is additive — `/search`, `/ingest-file`, and the
v1 Extract endpoints keep working — but the release runs database migrations in Search and
creates a new schema in Extract, makes one breaking contract-package change, and tightens the
conversion-callback SSRF policy in a way that can refuse existing internal receivers (see
**Security**). No executable flow in this repository changes; the research flows that use the new
navigation tools live in the private deployment repository and carry their own
`metadata.version` bumps. The upgrade path, rollback, and corpus re-ingest are described in
[docs/document-intelligence-v2-migration.md](docs/document-intelligence-v2-migration.md).

- **Search migrations.** The global schema advances from version 4 to 8: version 5 adds the v2
  ingest staging tables (`vs_revisions`, `vs_ingest_batches`, `vs_segments`,
  `vs_document_revisions`) and `vs_assets` with a backfill from `vs_document_assets`; version 6
  adds the shared identifier index `vs_identifiers`; version 7 reconciles these system tables
  eagerly at startup. Every collection table advances from version 11 to 14: v2 index-unit
  columns (12), unit relationship columns `parent_unit_id`, `prev_unit_id`, `next_unit_id`,
  `block_ids`, `figure_refs`, and `table_id` (13), and the identifier FTS vector `ts_ident` with its GIN index (14). All added
  columns are nullable, so legacy rows migrate forward untouched and are searched as before.
  Global version 8 adds the document-identity tables `vs_document_sources`, `vs_mail_messages`,
  and `vs_document_groups` and the nullable `vs_revisions.source_id` / `document_info` columns.
- **Extract schema.** With `EXTRACT_DATABASE_URL` set, Extract creates its own `extract` schema
  (tracked in `extract.schema_migrations`, target version 2): `jobs`, `page_stages`,
  `figure_stages`, `tile_stages`, `docpass_state`, `emit_outbox`, `asset_outbox`, and `uploads`.
  Version 2 adds token reservations, the emit generation, auto-resume, and the owning page of an
  outboxed asset. Without the variable no schema is created, and v2 jobs, resumable uploads, and
  `source_url` pulls are unavailable.
- **Contract.** `@atf/extract-contract` advances from 1.1.0 to 2.0.0. This is breaking for
  importers: the package root now exports the v2 NDJSON record stream, and the v1 marker grammar
  is available only under the `@atf/extract-contract/v1` subpath (`./v2` is also exported
  explicitly). Code importing v1 symbols from the root must switch to `/v1`. The wire contract
  is `atf-extract/2.1.0`: `document.begin` gains the optional `version`, `email`, and
  `parentReference`, and the package adds the identify API types and the shared
  `documentKeyOf` / `compareDocumentVersions` rules — additive, so a 2.0 consumer is unaffected.
  Wire contract 2.2 adds the caller's document attributes (`title`, `tags`, `metadata`, `link`,
  `sourceLabel`) to the job request and all but the already present `title` to
  `document.begin`; 2.3 adds `continues`,
  `continuationOf`, and `continuationText` to paragraph and list blocks. Both are additive; the
  producer now reports `atf-extract/2.3.0`.

### Added

- **Document Intelligence v2**, an end-to-end rework of the document ingestion, indexing, and
  retrieval path, delivered across phases 0–5. The v1 `/search` path and the v1 extract HTTP
  path keep working unchanged, and the new Search schema columns are nullable so a legacy row is
  searched exactly as before.
  - **Resumable, contract-versioned ingestion.** A persistent Extract job (lease, epoch, token
    budget, per-unit stage checkpoints) and a Search revision (idempotency key, staged batches,
    TTL) are joined by an at-least-once emitter that reconciles against the receiver, so a
    10 000-page document survives crashes, network faults, and restarts without losing model
    tokens or producing duplicate index units. Both halves speak the single
    `@atf/extract-contract` v2 NDJSON stream; Search refuses an incompatible major via the
    `X-Extract-Contract` header. Resumable uploads (`/v2/uploads`) confirm bytes one chunk at a
    time; sources are content-addressed and full-resolution page images are re-rendered on
    demand.
  - **Deterministic page analysis and transcribed visual content.** Per-word geometry
    (`pdftotext -bbox-layout`), page classification, header/footer detection, and render-hash
    dedup; a streaming document pass builds the outline, merges cross-page tables, resolves
    references, and extracts identifiers; figures get a snapped bounding box and a structured
    transcription per kind (BPMN, masks, drawings, charts, table images); large formats are
    tiled with overlap and stored as `tile:` assets. Native parsers read DOCX heading levels,
    XLSX worksheets as tables, BPMN as a `process` transcription, and VSDX shapes and connectors
    instead of rendering and guessing; PPTX goes through LibreOffice → PDF like before, and
    DOCX and VSDX keep that render for the page image.
  - **Multi-level index and retrieval.** Units at `chunk`, `table`, `figure`, `section`, `page`,
    and `document` level with a relationship graph and a contextual embedding header; German
    stemming plus an identifier vector and a third RRF list for exact codes; rerank with
    context, per-section diversification, small-to-big expansion, and `/v2/search` with
    `section_path`, `pages`, `expanded`, `assets[]`, `navigation`, and `evidence`; on-demand
    region/full zoom (`/v2/render`) cached as an asset variant.
  - **Runtime and flows.** RAG node v2 (`ragProfiles` with `expand`, `granularity`,
    `include_assets`, and `assets: { attach, maxImages, variant }`) attaching images only on
    confirmed `visionInput`, with page/figure citations; `inspect_image` for `asset:<id>[#bbox]`
    references, fail-closed; research flows wired with the MCP navigation tools and a research
    routine.
  - **Scale and finish.** A bounded large-job lane (`LARGE_JOB_PAGE_THRESHOLD`,
    `LARGE_JOB_MAX_CONCURRENCY`), `PAGE_CONCURRENCY` throughput tuning against the vLLM batch,
    tiling knobs (`TILE_TARGET_PIXELS`, `TILE_OVERLAP_FRACTION`, `TILE_MAX_PER_PAGE`), an
    optional model-free outline finalize pass (`FINALIZE_PASS`) with selective re-embedding, and
    a corpus re-ingest CLI that migrates existing corpora in `version` mode ordered by usage
    with proven asset-id stability. See the
    [migration guide](docs/document-intelligence-v2-migration.md) and the v2 tuning knobs in
    [docs/operations-and-retrieval.md](docs/operations-and-retrieval.md).
- **Extract v2 endpoints**: resumable uploads (`POST /v2/uploads`, `PATCH /v2/uploads/{id}`,
  `POST /v2/uploads/{id}/complete`, with `source_url` as an alternative to uploading bytes);
  persistent jobs (`POST`/`GET /v2/jobs`, `GET /v2/jobs/{id}`, and the actions `pause`,
  `resume`, `cancel`, `retry-failed`, and `reparse` under `/v2/jobs/{id}/`); a Jobs tab in the
  Extract UI backed by `/ui/jobs`; and on-demand page or region rendering
  (`POST /v2/render`, own rate limit, `extract.admin` scope). The upload, job, and UI job routes
  are mounted only when `EXTRACT_DATABASE_URL` is set.
- **Search v2 endpoints**: the revision protocol under `/v2/documents/{ref}/revisions` (open;
  status and abort of `{rev}`; `batches/{seq}`, `segments/{n}/commit`, `commit`, and
  `heartbeat`), `PUT`/`GET /v2/assets/{assetId}`, and `POST /v2/search`.
- **Nine MCP navigation tools** in Search: `get_outline`, `get_section`, `get_pages`,
  `get_context`, `list_figures`, `get_asset`, `get_table`, `find_identifier`, and `follow_ref`.
- **Runtime**: `imageInspection.assetSource` (`server`, optional `collection` and `variant`)
  enables `asset:<id>[#bbox]` references in `inspect_image`, fetched through MCP `get_asset`;
  `ragProfiles` v2 adds `expand`, `granularity`, `include_assets`, and
  `assets: { attach, maxImages, variant }`.
- **Evaluation scripts** at the repository root: `eval:fixture` (golden-set fixture),
  `eval:retrieval` (retrieval harness), `eval:test`, and `eval:typecheck`.
- **Configuration.** Notable new variables — Extract: `EXTRACT_DATABASE_URL`,
  `SOURCE_STORE_DIR`, `UPLOAD_TMP_DIR`, `SOURCE_URL_ALLOWED_HOSTS`, `SOURCE_URL_MAX_BYTES`,
  `SOURCE_URL_TIMEOUT_MS`, `JOB_LEASE_SECONDS`, `EMIT_BATCH_PAGES`, `TEXT_FAST_PATH`,
  `FIGURE_PASS2_KINDS`, `RENDER_RATE_LIMIT`, `RENDER_MAX_PIXELS`, plus the large-job, tiling,
  and `FINALIZE_PASS` knobs above; Search: `ASSET_STORE_BACKEND`, `ASSET_STORE_DIR`,
  `BATCH_WORKER`, `REVISION_TTL`, `RRF_WEIGHT_IDENTIFIER`, `CONTEXTUAL_CHUNK_LLM`, and
  `TOKENIZE_URL`. [docs/CONFIGURATION.md](docs/CONFIGURATION.md) lists every variable with its
  default; [docs/document-intelligence-v2-migration.md](docs/document-intelligence-v2-migration.md)
  says which ones an upgrade needs.
- **Duplicate detection on ingest.** Every v2 job identifies its source with Search
  (`POST /v2/sources/identify`) before any work: the same file, the same normalised text, or the
  same e-mail Message-ID anywhere in the collection, and a near-identical text (MinHash) of the
  same document in the same version, are skipped. Whitespace, hyphenation, ligatures, case,
  punctuation, and page numbers do not make two exports differ, so a PDF and the DOCX it was made
  from are recognised as one. A skipped upload completes without extraction or model calls, reports
  `duplicateOf` (`status: skipped` on `/v1/ingest`), and is kept as an additional source of the
  indexed document (`GET /v2/documents/{ref}/sources`). `dedup` / `X-Dedup` (`auto`, `exact`,
  `off`) controls it; `SOURCE_CLAIM_TTL`, `DEDUP_NEAR_THRESHOLD`, and `DEDUP_DUPLICATE_SIMILARITY`
  tune it in Search.
- **Document versions.** A document is identified by its reference without file extension, so
  `handbuch.docx` is ingested as a new revision of an indexed `handbuch.pdf`. Without an explicit
  `version` / `X-Version`, Extract reads the version from the first page (label, then a labelled or
  unambiguous date; the text LLM when configured; a scan's transcribed first page), else takes
  `sourceModifiedAt` / `X-Source-Modified`. Search makes a revision the latest only when its
  version is not older than the current one; an older version arriving late is indexed but stays
  in the history.
- **E-mail ingestion (`.eml`).** Parsed natively (MIME, transfer and header encodings, any WHATWG
  charset, HTML bodies) into one page per message with quoted history and signature removed.
  Messages are threaded in Search by Message-ID, In-Reply-To, References, and the Outlook
  Thread-Index — across independent ingests, in any order, merging threads a message links — with
  a subject and participant fallback. Attachments are ingested as documents of their own, grouped
  with their e-mail's thread. `groupByDocument` / `group_by: document` merge a thread into one
  result, and the new expansion mode `document` (`X-Expand`, `expand`, MCP `expand`) returns a
  whole thread or document in reading order.
- **Outlook `.msg` and mbox.** `.msg` files (CFB/MAPI) are parsed natively — transport headers
  first, MAPI properties as fallback, embedded messages become child `.eml` documents — and are
  recognised by their streams even without a file name. An mbox export with several messages is
  split: every message becomes a child e-mail, the export itself an index page.
- **Quoted history is kept when the quoted message is missing.** A reply's quoted history is only
  dropped when its direct parent (In-Reply-To, else the last References entry) is already in the
  collection or in the same mbox export; otherwise it is indexed under a "Zitierter Verlauf"
  section. Inline replies keep the up to three quoted lines directly above each answer.
- **Embedded objects in DOCX** (`word/embeddings/`: OOXML packages, OLE package objects such as
  `.bpmn` or `.pdf`, OOXML-in-OLE, legacy DOC/XLS storages) are ingested as child documents with
  their native parsers, grouped under the Word document.
- **Paragraphs over a page break.** The document pass marks a paragraph or list that continues on
  the next page; Search indexes and embeds the page's last chunk with the continuation's leading
  sentence (kept out of document reads via `display_len`), and links the chunks of a section
  across the pages of a batch, so `get_context` crosses the break.
- **Headerless table continuations** inherit the header rows and the caption (marked
  "(Fortsetzung)") of the table they continue, so their rows are indexed and read with column
  names.
- **Document attributes on the v2 path.** `/ingest-file` and Extract's `/v1/ingest` wrapper pass
  `X-Title`, `X-Tags`, `X-Metadata`, `X-Link`, and `X-Source` (plus `X-Version`,
  `X-Source-Modified`, `X-Dedup` on `/ingest-file`) through the job; Search stores them on every
  unit, so tag and metadata filters find v2 documents. E-mail attachments inherit tags,
  metadata, and source label.
- **MCP.** New tool `get_thread` (a whole e-mail thread chronologically, paginated with
  `offset`/`next_offset`, optionally restricted by `path_prefix`). Search hits, `get_document`,
  and `get_summaries` name their `document_group`; a grouped hit merged from several e-mails
  carries `group_members` and heads each message with `[Nachricht: <ref>]`. `find_identifier`
  accepts `path_prefix`. The read tools (`get_document`, `get_documents`, `get_summary`,
  `get_summaries`, `get_outline`, `get_section`, `get_pages`, `list_figures`, `get_table`,
  `find_identifier`) accept `valid_at` and read the version valid at that instant.
- **Runtime coverage queue.** Every message of a thread-grouped search hit (`group_members`)
  becomes a candidate of its own instead of riding on the representative message.
- **Studio tool chips.** Every node that offers tools (or whose traced run called tools) shows
  them as chips beside it on the canvas, with run status (running, completed, error, dimmed when
  unused), call counts, pinned static arguments, and tools called but not listed drawn dashed.
  Clicking a chip opens the node's Tools settings at that tool.
- **Static tool arguments in Studio.** The node's Tools section edits `config.toolArgs` per tool
  (JSON or template) and warns about arguments stored for tools the node no longer lists.
- **Studio Start panel shows the run's input.** With a traced or pinned run, Start shows the
  request messages (all roles, tool calls), the values templates and conditions see, token
  claims, and the trace metadata (`flow_version`, session, user, client) from
  `GET /monitoring/debug/:id`, with a switch between the current and the pinned run. The panel
  is only as visible as the monitoring debug trace itself, which already carries these fields.
- Extract `/metrics` exposes the text-fidelity gate as `extract_text_fidelity_checks_total`,
  `extract_text_fidelity_divergences_total`, and `extract_text_fidelity_missing_tokens_total`.
- Extract `/health` probes `pdftotext -bbox-layout` once per process (again on `?deep=1`) and
  reports it as `bbox_layout`. A missing capability is reported, not fatal: the deterministic
  page analysis is skipped and pages fall through to vision.

### Changed

- The figure-kind filter (`list_figures` `kind`, `search`/`/v2/search` `figure_kind`) accepts the
  stored kinds plus aliases (`process` = `bpmn` + `flowchart`, `drawing`, `data`, `mask`,
  `table`, German equivalents) and rejects an unknown value with the vocabulary instead of
  silently matching nothing.
- Search `/ingest-file` rejects an `X-Metadata` header that is not a JSON object with 400.
- MCP `get_section` and `get_pages` (Markdown format) return Extract's section/page/document
  summaries in a separate `summaries` array instead of mixing them into `markdown`; `units`
  counts the body units only.
- **Studio run path.** While a run is traced, the nodes and edges it passed through (including
  Start and the exit that answered) are highlighted and the rest dimmed; untraced editor nodes
  are no longer drawn as pending. Node types show an icon on canvas cards and in the palette
  instead of an emoji. `apps/control` pins the dev dependency `postcss` 8.5.26.
- The final revision switch supersedes only committed revisions of a document; a revision still
  staging finishes and is ordered by its version when it commits, so two formats of one document
  ingested concurrently no longer abort each other. Deleting a document by reference also removes
  its revision pointer, source records, and thread membership.
- New runtime dependencies: `fast-xml-parser` 5.11.1, `fflate` 0.8.3, and `pg` 8.23.0 in
  Extract (native OOXML/BPMN parsing and the `extract` schema), and `sharp` 0.35.4 in Search
  (asset variants). Third-party notices and the supply-chain inventory are regenerated.
- The quickstart Extract image (`deploy/examples/Dockerfile`) additionally installs LibreOffice
  impress and draw for PPTX and VSDX, and the build fails if `pdftotext` lacks `-bbox-layout` or
  a converter is missing. Custom Extract images need the same packages.
- Extract's production-readiness gate flags an empty `SOURCE_URL_ALLOWED_HOSTS` when the v2
  routes are mounted (fatal in production, a warning elsewhere), and warns in production when
  `EXTRACT_DATABASE_URL` is unset, since v2 jobs, resumable uploads, and `source_url` pulls are
  then disabled.

### Fixed

- **Whole-document reads of v2 documents.** `get_document` / `get_documents` read only the body
  units (`chunk`, `table`, `figure`) in reading order (page, block position, ordinal), a table
  once (its grid, not the "Spalte: Wert" lines), a figure marked with its id, kind and asset id;
  evidence spans carry `unit_id` and pages. Extract's section/page/document summaries are no
  longer read back as the original. `get_summary` / `get_summaries` fall back to the v2
  `document` unit's summary and the first non-empty title; the summary backfill lists and writes
  one row per v2 document instead of every unit.
- `valid_at` reads of v2 documents select a whole revision (keyed by `revision_id`) and never a
  revision that is still staging or was aborted.
- Selecting Start or End on the Studio canvas had no effect.

### Security

- **Row ACL on the v2 ingest path.** Documents ingested through Extract's v2 jobs were written
  without row ACL, so every reader of the collection could find them. The job's ACL (narrowed to
  the uploading caller) now travels with the revision (`X-Allowed-Users/-Groups`) and is written
  onto every unit; a service write without one falls back to the collection ACL. Duplicate
  detection and version chains only match sources of the same ACL, and the source listing only
  shows readable sources. Documents ingested through v2 before this change keep their empty row
  ACL until re-ingested.

- **Conversion callbacks without `CALLBACK_ALLOWED_HOSTS` reach public addresses only.** The
  callback host is resolved at delivery, the connection is pinned to the validated address, and
  every resolved address must be public unicast: private, loopback, CGNAT, ULA, multicast, and
  their IPv4-embedded forms are refused, as IP literals already at request time. This is
  breaking for internal orchestrators on cluster DNS names or private addresses, which must now
  be listed in `CALLBACK_ALLOWED_HOSTS`. An allowlisted host may resolve to private space but
  never to a link-local or metadata address.
- **`source_url` pulls** are guarded by the same host rules plus an address check that applies
  with or without `SOURCE_URL_ALLOWED_HOSTS`: every resolved address must be public, the
  connection is pinned against DNS rebinding, and each redirect hop is re-validated. See
  [SECURITY.md](SECURITY.md).

## [0.8.0] — 2026-09-25

Versions 0.4.0 through 0.7.2 are documented below but were never tagged, so this entry's compare
link spans from `v0.3.0`, the last published tag, and it carries the work of those versions as
well.

Reworks the Control Studio into a complete flow builder, extends flow variables with constants,
allowlisted environment values, and calculations, and adds provider monitoring. All changes are
backward compatible: existing flows, variables, and API clients keep working unchanged. The only
schema change is one added index (version 40, `execution_snapshots (flow_id, created_at DESC)`) —
no table, column or data is changed — and there is no independently versioned contract-package
change.

### Added

- **`docs/FLOWS.md`**, a complete flow configuration reference — flow and node fields, the
  `llm` block and its parameters, every node type with its settings, examples and notes, edges and
  the condition grammar, runtime placeholders and where each renders, variables, constants and
  calculations. It is generated by `bun run flow-reference` from the flow schema, the node type
  catalog, and the new `apps/runtime/src/graph/flow-reference-data.ts`, the same sources the
  Studio's settings forms, node docs, and expression builder use. CI checks it is current
  (`flow-reference:check`), and tests pin the reference data to the engine (condition context,
  prompt placeholders, calculation functions).
- The flow schema's fields carry descriptions, so `schemas/flow.schema.json` now gives editors
  hover documentation. `flow-reference` regenerates it together with `docs/FLOWS.md`.
- **Flow variables** can reference other variables (`{{vars.x}}`, evaluated in dependency
  order), global constants from the new `FLOWS_DIR/constants.yaml` (`constants: { name: value }`,
  read as `{{const.name}}`), environment values whose name starts with `FLOW_PUBLIC_`
  (`{{env.FLOW_PUBLIC_NAME}}`), and calculations (`{{= round(vars.max_tokens / 2) }}`: arithmetic,
  comparisons, `&&`/`||`, `a ? b : c`, and a fixed set of functions, using a dedicated parser and
  no code evaluation). A value that is exactly one placeholder keeps its type. Cycles, unknown
  references, non-allowlisted env, and calculation errors are reported by the validator as
  `variables.<name>`. The same references (constants, env, calculations) also work in any node
  or edge value; unresolvable ones are reported with their node/edge path. `constants.yaml` is a reserved file, never loaded as a flow; changing it
  reloads all flows.
- Runtime routes for the Studio: `GET /flows/node-types` (node type catalog with config fields,
  docs and examples, connected tool ids, model shortcuts with a one-line description, preset model
  ids, constants, and `FLOW_PUBLIC_*` values), `POST /flows/variables/evaluate`,
  `POST /flows/expressions/evaluate` (condition check against sample values), and
  `POST /flows/:id/test-run` (runs the canvas state through an ephemeral `<id>@studio-<nonce>`
  registration, max. 50, expiring after 30 minutes, never replacing the live flow).
- **The node panel only offers fields the node type actually reads**, taken from the runtime's node
  type catalog (`topLevel` in `GET /flows/node-types`) instead of a second list maintained in the
  UI, which had drifted from the engine. A field the type ignores is hidden while unset; a field
  that IS set on a type that ignores it stays visible with a warning, so a dead setting can be seen
  and removed rather than sitting unread in the flow file. Without a catalog (offline, or an older
  runtime) the previous defaults apply.
- **`agent-harness` documents its `systemPrompt`**: it is guidance for the PLANNER, prepended to
  the planning instructions — not a prompt for the delegated nodes, which carry their own. A
  plannerless harness (`config.plannerless: true`) never reads it, so leaving it empty there is
  correct and setting it has no effect. The field was offered in the Studio without any of this
  being stated anywhere.
- **Every node type now states its position on `llm`, `systemPrompt` and `tools`**, checked against
  the handlers that do the reading. Previously seven types declared no node fields at all, which
  reads as "not applicable" but is indistinguishable from an undocumented gap. Corrected along the
  way, each with the reason and where the setting belongs instead: `tool` applies `overrides` (the
  only way to vary its tool list) — that was undocumented; `classifier` does NOT apply `overrides`
  (it reads `llm`/`systemPrompt` directly and never calls `resolveNodeConfig`), and it does read
  `priority`; `parallel`'s `parallelNodes` is `recommended`, not `optional`; `retrieval` and
  `memory` ignore `llm` (the embedding model is a deployment setting, not a node field);
  `assistant-context` ignores `systemPrompt` (its prompt is rendered from the assistant's own
  identity). Three new tests pin these claims to the code — the `resolveNodeConfig` callers, the
  queue-priority type filter, and direct field reads per handler — so the catalog cannot drift from
  the engine unnoticed.
- The Studio only offers `priority` on the types whose priority the queue actually reads (`llm`,
  `classifier`), and flags an `overrides` block on a type that never applies it.
- **A flow save keeps its YAML anchors and aliases.** Several flows share a config block between
  nodes via `&anchor` plus `*alias` references, but the definition the editor sends back is the
  expanded form — nothing in it says which sites are the same block. The comment-preserving write
  therefore replaced every alias with a literal copy: content stayed correct, the file grew by
  about a third, the anchors were left with nothing referencing them, and one shared block quietly
  became several independent ones, so a later edit to the anchor no longer reached the nodes that
  used to follow it. An alias is now kept whenever the value at that site is unchanged; a site that
  genuinely diverged is written out on its own, because it is no longer the shared value. The
  result is verified by reading it back, and falls back to the expanding merge unless it parses to
  exactly the submitted definition — which covers the one corrupting case, the anchor's own
  definition being edited while an alias site is not.
- **Prompt files are editable**: `GET /flows/prompts/content?path=prompts/x.md` and
  `POST /flows/prompts/write` read and write the Markdown file behind a
  `#[[file:prompts/x.md]]` system-prompt reference. Reading needs `flows:read`, writing
  `flows:write`; both paths are pinned to the flow directory's `prompts/` subtree (traversal and
  non-Markdown paths are rejected), the write is atomic and takes a `baseHash` for the same
  409-on-conflict protection `/flows/write` has, and it is recorded as `flows.prompts.write` in the
  audit log. In the Studio the node panel now shows an editor for each referenced prompt file
  below the system prompt field: previously the field held only the reference, so the prompt text
  of nearly every flow could not be changed from the UI. Saving the prompt file does not touch the
  flow, and saving the flow leaves the reference intact.
- **The eval judge runs against a real model.** `createLlmJudge` takes either an AI SDK model (what
  `createLlmProvider` returns) or the previous `{ invoke }` shape, prompts it for a JSON verdict,
  and reads the score from that JSON — a `<think>` block is stripped first, so a number inside the
  reasoning can't be mistaken for the grade. A missing model or a reply without a score now throws
  instead of scoring 0, because a fabricated failing grade is indistinguishable from a bad answer
  and silently poisons every comparison built on it.
- **The optimizer can optimize a flow that exists only as a file** in `FLOWS_DIR`: it reads the
  source form the Studio edits when the flow has no online version. Promoting a variant publishes
  an online version, which then takes precedence over the file, exactly as publishing from the
  Studio does. Its synthetic definitions (`<flowId>@variant/<label>`, a scoped sub-flow) are
  registered as ephemeral flows for the duration of the eval instead of being parked as drafts in
  the flow store, which the runtime's executor never resolved — so a variant used to be evaluated
  against the unchanged flow.
- A finished Autopilot run links to the optimizer run holding its variants, scores and the promote
  action.
- A Studio "Canvas" run of a canvas with no unsaved edits runs the live flow under its real id, so
  it counts as that flow's traffic (Autopilot and optimizer snapshots) instead of being recorded as
  a throwaway `<id>@studio-…` test run. An edited canvas still runs ephemerally.
- `GET /flows/:id` returns a file flow's source form (`sourceDefinition`: shortcuts,
  `{{vars.*}}`, prompt includes, and sub-flow origins kept), its file, and a content hash;
  `GET /flows` reports whether the flows directory is writable (`fileWriting`).
- **Studio** (Control): flow picker with deep link (`/studio?flow=<id>`), collapsible side
  panels and a focus mode, a settings form per node type generated from the catalog with the full
  node type reference beside it, a variables table (typed values, usage counts, rename that
  rewrites references, delete confirmation, live result of formulas), an expression builder
  behind every ƒx button (variable browser, operators, live result or condition check),
  drafts/publish/write-back to the flow file, diff of the draft against the live version or file,
  undo/redo, rename and delete of nodes with reference rewriting, auto-layout ("Tidy up"), dashed
  reference links for parallel children and harness verifier/delegates, and a Run & Trace panel
  that tests the canvas or the live flow with per-node tokens and cost.
- The Studio Copilot can edit node settings (`configPatch`, shortcut, parallel children,
  classifier schema, priority) restricted to catalog-documented keys; its proposal is shown as an
  overlay on the canvas and must be accepted. Schema failures are reported per field, and an
  invalid proposal gets one repair round.
- The Studio canvas separates the run's flow from tool connections: flow edges keep docking
  bottom → top, while the links from a node to the nodes it calls (parallel children, harness
  workers and verifier) dock at a handle on the caller's right edge and the called node's left
  edge, drawn dashed and right-angled. The canvas toggle is now called "Tool links".
- Sub-flows in the Studio: the nodes of each sub-flow file (`metadata.$include`) are drawn in a
  coloured box labelled with the file name, and auto-layout keeps them together. The palette has a
  Subflows section — "New subflow" (moves the selected nodes into `subflows/<name>.yaml`, or
  starts it with one node) and "Include…" (lists `subflows/` with description, nodes and the flows
  using each file, and places a file's nodes and edges on the canvas). Nodes dropped onto a box
  join that sub-flow, and a node's settings show and change the file it is saved in. Saving writes
  new files and updates `$include`. Backed by `GET /flows/subflows` and
  `GET /flows/subflows/content?path=`.
- A copilot in the Studio's expression builder writes or changes the field from an instruction
  (`POST /flows/expressions/copilot`). It is given exactly what the builder offers for the field —
  variables, constants, public env, node results, request and user data, run state, with pinned
  run values and the reason where an entry does not work — plus the field's grammar (operators,
  functions, rules). The proposal is checked with the engine's own condition parser, calculation
  evaluator and placeholder rules (one repair round), shown as a diff against the current value,
  and applied only when accepted.
- Pinned run data in the Studio's expression builder: pick a recorded run of the flow (live or a
  Studio test run) — or pin a test run right after it finished — and its query, user context and
  node results fill the tree (📌) and the previews of prompts, tool arguments and conditions. The
  pin is remembered per flow in the browser. Backed by `GET /monitoring/debug?flowId=` (runs of a
  flow, including its Studio test runs, with the triggering message) and
  `GET /monitoring/debug/:executionId/sample` (a run as sample values shaped like the run-time
  roots).
- Start and End on the Studio canvas: neither is a node of the flow definition, they make the
  compiler's implicit rules visible — the run starts at the flow's first node, and it ends after a
  node with no outgoing edge or one whose outgoing edges are all conditional and none matches.
  Selecting them shows what a request brings in (query, user context, variables) and what the flow
  returns, from the pinned run and from the run currently traced in Run & Trace.
- An **Optimize** panel in the Studio shows cheaper candidate models for the nodes that declare
  `config.routing.candidates`, with the expected cost saving, quality loss and where the quality
  figure comes from. It reads either the definition on the canvas — unsaved edits and drafts
  included — through the new `POST /optimizer/routing-advice`, which resolves shortcuts,
  `{{vars.*}}` and `$include` like a flow file and saves nothing, or the flows the runtime has
  loaded through `GET /optimizer/routing-advice`.
- A request in the Live Graph opens in the Studio (`/studio?flow=…&execution=…`): Run & Trace
  attaches to that execution — running or finished — and shows it as if it had been started there,
  with the trace on the canvas, the prompt, the answer and the option to pin it as sample data.
  Durable events are merged with live ones, so a late `running` event cannot regress a node that
  has already finished.
- Eval cases can be saved from a Studio test run with an expected answer and removed again from
  the Eval page (with confirmation) or right after saving in the Run & Trace panel.
- Provider monitoring: `GET /monitoring/providers` reports per provider the protocol, seen models,
  capabilities (now including `reasoning` and `toolCalling`), reachability from an engine-wide
  circuit-breaker observer, and call/error/token counters, plus the model-shortcut pools.
  `GET /monitoring/providers/:name/models` and `POST /monitoring/providers/test/{prompt,
  capabilities,performance}` drive live tests (`monitoring:write`). Control shows them on
  `/providers` and a new `/provider-testing` bench.

### Changed

- The Studio replaces the former flow editor and playground: `/flows` is the registry, and
  editing and inspecting a flow open it in Studio. Writing a file flow keeps its authoring form —
  shortcuts, `{{vars.*}}`, prompt includes, sub-flow files with their `$include` block, and
  comments — and a value-only edit changes just those lines.
- Flow validation names the node and field of a schema failure (e.g.
  `nodes[4](answer-fast).llm.provider`) instead of a bare "Schema validation failed".
- The circuit breaker stays per execution; reachability is additionally observed engine-wide for
  monitoring without letting one flow's failures skip a provider for other flows.
- The Studio's expression builder takes placeholders, condition fields and operators, and
  calculation operators and functions from the runtime (`reference` in `GET /flows/node-types`)
  instead of its own copies. It shows the whole data context in every field as a tree — flow
  variables, constants, public env, node results per node, the latest classification, request
  and user data, run state, date and time, calculation functions — and keeps entries that do not
  work in the field visible but disabled, with the reason. Operators are grouped and
  colour-coded, with a Clear action, clickable examples, a guide to conditions or calculations,
  and for load-time references the value the field resolves to when the flow loads.
- Studio canvas nodes are more compact, and the empty "not run yet" status dot is no longer shown
  on them (it read like an unconnected port).
- Every place that picks a flow — Optimizer, Autopilot, Security, the metrics filter — uses the
  Studio's searchable picker instead of a native `<select>` of two dozen long German names, and the
  multi-selects of Live Graph, History and Eval list flows by name with a search box. All of them
  sort alphabetically by name with numbers in order ("Flow 9" before "Flow 10") and match on name
  or id.
- A running node is marked by an arc travelling around its border rather than a pulsing dot, on the
  canvas, the Start/End cards and in the legend; the status colour moved from amber to sky, so
  "running" is no longer the colour of a warning. `prefers-reduced-motion` gets a static ring.
- Snapshots are queried per flow in the database (`list(limit, { flowId })`) instead of filtering a
  global window afterwards, where busy flows crowded a quiet flow out of the window and made the
  optimizer skip it for lack of samples. Backed by the new index.
- An edge label is now part of the line: the text runs along the path inside a capsule outlined in
  the edge's colour, instead of a separate box that cuts the line. It is dropped when it does not
  fit on the edge, and it never renders upside down.
- The optimizer routes are always mounted. Routing advice and trace analysis do not need the
  self-optimizing loop, so the Studio's Optimize panel works without `OPTIMIZER_ENABLED`; the
  loop's own endpoints answer `501` with the setting that enables them instead of returning
  404 for the whole namespace.

### Removed

- The standalone flow editor, flow versions panel, and Studio playground components in Control,
  superseded by the Studio builder.

### Fixed

- Control pages and panels now load with operator auth disabled (`AUTHN_MODE=disabled`): queries
  are gated on `isAuthenticated` instead of on a token being present, and the Authorization
  header is sent only with a real token.
- Saving an eval case from Studio posted to a non-existent route and without the required
  expected answer; it now posts to `/eval/cases` and reports failures instead of claiming success.
- The canvas Fit control is visible in dark mode.
- An optimizer run whose baseline could not be scored, or whose every variant failed, reported
  `done` with nothing to compare; it now ends in `error` naming the reason (typically a judge
  failure), and a judge error on a case is carried into that case's `error` instead of being
  hidden in its assertions. The "too few snapshots" message says that Studio canvas test runs
  deliberately don't count.
- The Studio's Start/End links disappeared on any re-render — a click, an incoming run status —
  because React Flow forgets the handle positions of a node handed back without its measured size,
  and the measurement changes for those two cards were dropped. Links to the tool handle were
  likewise lost when the handle appeared, since handles are only re-measured on a size change.
- Edge labels on the canvas: two edges between the same pair of nodes share one curve and put both
  labels in the same spot, now they sit at their own points along it; a label longer than the edge
  is cut at the end with "…" and carries the full text as its tooltip instead of vanishing; a step
  edge between close handles no longer zigzags right where its label sits; and identical delegation
  labels fanning out from one harness are drawn once, on the link with the most room.
- A node that only an `agent-harness` calls no longer floats unconnected on the canvas: its
  delegation link stays drawn even while the harness is not selected, since it has no other link
  that would explain it.
- The expression builder inserted flow variables into conditions as `vars.x`, which conditions
  cannot read; it now inserts `{{vars.x}}`, which is replaced when the flow loads.
- The Studio's expression builder offered `{{context.tenantId}}`, which the request context does
  not have (it always rendered empty), and offered `{{classification.*}}` and `{{classLabel}}`
  for system prompts, where the runtime does not render them. It now lists only real fields and
  marks placeholders that work only in tool arguments or only in prompts.
- `deploy/examples/flows/README.md` linked to the documentation with paths that pointed outside
  the repository.
- `schemas/flow.schema.json` rejected valid flow files: it described only the expanded runtime
  form, so an editor using it flagged every `llm: { shortcut: … }`, every `_comment` key, and every
  flow whose nodes and edges come from `metadata.$include`. It now describes the file form: `llm`
  is either `{ shortcut, parameters? }` or `{ provider, model, … }` (on nodes and overrides),
  `_`-prefixed annotation keys are allowed, and `nodes`/`edges` are optional when
  `metadata.$include` is set. Other unknown keys are still errors.

### Security

- Runtime's CSRF check now applies to `POST` only. It rejected every body-less `DELETE` from the
  allowlisted dashboard origin (a missing Content-Type counts as form data), so deleting an eval
  case failed with 403. HTML forms can send only GET and POST; cross-origin PUT/PATCH/DELETE need
  a CORS preflight, which the `CORS_ORIGINS` allowlist already governs. Cross-origin form POSTs
  are still rejected.
- A `POST` that carries an `Authorization` header is no longer CSRF-checked. A page cannot set that
  header cross-origin without a CORS preflight, which the `CORS_ORIGINS` allowlist governs, and the
  credential is not one a browser attaches by itself, so the header itself rules out the
  form-POST vector the check exists for. Without this, the dashboard's own body-less actions — for
  example publishing a flow, where a missing Content-Type counts as form data — were refused with a
  bare `Forbidden` whenever `Origin`/`Sec-Fetch-Site` were not exactly same-origin. A `POST`
  without an `Authorization` header stays checked.
- Flows can read environment values only through the `FLOW_PUBLIC_` prefix; no other variable,
  such as API keys, is readable by a flow. Variables supplied with a request are literals and are
  never evaluated as references or calculations.

## [0.7.2] — 2026-09-23

Dependency maintenance only. Every change is a backward-compatible upgrade of an existing
dependency to a newer release; there is no source, schema, flow, migration, or
independently versioned contract-package change. Third-party notices are regenerated to
match the upgraded versions.

### Changed

- **Runtime** (`@atf/runtime`): AI SDK providers and core bumped — `ai` 7.0.93 → 7.0.107,
  `@ai-sdk/amazon-bedrock` 5.0.76 → 5.0.88, `@ai-sdk/anthropic` 4.0.49 → 4.0.58,
  `@ai-sdk/azure` 4.0.63 → 4.0.75, `@ai-sdk/google` 4.0.64 → 4.0.76,
  `@ai-sdk/openai` 4.0.60 → 4.0.71, `@ai-sdk/provider` 4.0.10 → 4.0.17;
  `@langchain/core` 1.2.9 → 1.2.11, `@langchain/langgraph` 1.4.14 → 1.4.16;
  `@aws-sdk/client-bedrock-agent-runtime` 3.1127.0 → 3.1136.0; `jose` 6.2.4 → 6.2.12;
  dev `fast-check` 4.9.0 → 4.10.2.
- **Control** (`@atf/control`): `next` 16.3.4 → 16.3.5, `react`/`react-dom` 19.2.8 → 19.3.0,
  `lucide-react` 1.35.0 → 1.45.0; dev `@types/react`/`@types/react-dom` → 19.3.0,
  `@types/node` 26.4.1 → 26.6.2.
- **Gate** (`@atf/gate`): `@aws-sdk/client-bedrock-runtime` 3.1127.0 → 3.1136.0,
  `express-rate-limit` 8.5.2 → 8.7.0, `jose` 5.10.0 → 6.2.12, `mysql2` 3.24.2 → 3.24.4;
  dev `@types/node` 26.4.1 → 26.6.2.
- **Search** (`@atf/search`): `@aws-sdk/client-bedrock-runtime` 3.1127.0 → 3.1136.0,
  `jose` 6.2.4 → 6.2.12; dev `@types/node` 26.4.1 → 26.6.2.
- **Extract** (`@atf/extract`): `jose` 6.2.4 → 6.2.12; dev `fast-check` 4.9.0 → 4.10.2,
  `@types/node` 26.4.1 → 26.6.2.
- **Extract contract** (`@atf/extract-contract`): dev `fast-check` 4.9.0 → 4.10.2.
- **Quickstart image** (`deploy/examples/Dockerfile`): base `oven/bun` 1.4.0 → 1.4.2.

## [0.7.1] — 2026-09-23

Fixes pool failover for schema-enforced `llm` nodes. Backward compatible: a single-model
(non-pool) structured node keeps its previous behaviour, and no schema, migration, or
independently versioned contract-package change is included.

### Fixed

- A structured-output `llm` node (one declaring `config.outputSchema`) now fails over across its
  pool candidates and any deployment-level fallback model, exactly like the streaming `llm` and
  `classifier` paths. Previously the structured-output path received only the pool's primary
  candidate and retried that one provider, so an unreachable primary (e.g. an offline local
  endpoint) failed the node with `Cannot connect to API` instead of rotating to a reachable
  fallback. Each candidate keeps its own bounded empty-output retry budget; the run's deadline
  firing still fails immediately (no failover past the budget), and only exhausting every
  candidate fails the node. Emits `structured_output_candidate_failed`/`fallback` diagnostics on
  each hand-off.

## [0.7.0] — 2026-09-22

Adds model pools to shortcuts and a priority-aware execution queue, and relaxes the flow
schema's `llm.provider` from a fixed enum to any operator-configured provider name. All three
are backward compatible: existing single-model shortcuts, unprioritized flows, and the
previously enumerated provider names keep working unchanged. No database migration or
independently versioned contract-package change is included.

### Added

- Model shortcuts in `flows/model-shortcuts.yaml` can now resolve to a **pool** instead of a
  single engine/model pair. A pool is an ordered list of members — each a concrete engine/model
  pair (with optional extra parameters and a relative `weight`) or a reference to another shortcut
  (nested pools are flattened) — carrying a selection `strategy`: `fallback` (configured order is
  the priority order), `round-robin`, `weighted-round-robin`, `random`, `weighted-random`, or
  `least-used`. The flow parser writes the first candidate into the node's `provider`/`model`/
  `parameters` and attaches a concrete `pool` to the `LlmConfig`, so every consumer that only
  understands a plain config (admission, compliance, cost, capability collection) keeps working off
  the primary while the streaming `llm` and `classifier` handlers select among the candidates per
  strategy. All pool members are counted for compliance data-flow mapping, capability collection,
  and token-limit accounting — a rotated-to or failed-over member is never invisible to those
  checks. A malformed pool (unknown member, cyclic reference, empty member list) leaves the
  `shortcut` key in place so the node fails validation loudly rather than running on a wrong model.
- Flows and individual `llm`/`classifier` nodes accept an optional `priority` (integer 0–100).
  The execution concurrency semaphore now admits waiting requests highest-priority-first, with
  FIFO order preserved among equal priorities. A flow's effective queue priority is the maximum of
  its own `priority` (default 50) and the `priority` of its LLM/classifier nodes, so a latency-
  sensitive flow can jump the queue ahead of bulk work under a concurrency cap.

- The `classifier` handler, when its node resolves to a pool, now tries the pool candidates in
  the strategy's order and falls through to the next candidate on a generation error or an
  unparseable classification before resorting to the node's configured `fallback` class. A
  single-model (non-pool) classifier keeps its previous behaviour.

### Changed

- The flow schema no longer restricts an `llm.provider` to a fixed enum (`openai`, `google`,
  `ollama`, `azure`, `bedrock`, `anthropic`). A provider is now any operator-configured `PROVIDERS`
  name (1–64 chars) or a `{{vars.*}}` reference, matching how deployments already alias several
  endpoints of the same wire protocol under distinct names.
- The streaming `llm` handler now fails over immediately when a provider is unreachable. A
  transport failure (connection refused, DNS failure, connect timeout, 5xx/408) on a candidate
  that still has another candidate behind it (a pool member or a deployment-level fallback) skips
  the remaining retries against the dead endpoint and moves to the next candidate at once, emitting
  an `llm_provider_unreachable_failover` diagnostic. The failure still counts toward the provider's
  circuit breaker, and the last candidate keeps the full retry path so a lone endpoint can still
  recover from a transient hiccup.

### Removed

- The Control app's `/rag` collection-management page (and its loading skeleton) has been removed
  along with its navigation entry; the RAG index is no longer managed from this UI.

### Fixed

- Removed a stray double semicolon at the end of the `llm` node handler that Biome flagged as
  unreachable code (`lint/correctness/noUnreachable`), which broke the lint baseline.
- The Studio builder's Copilot panel now uses a distinct React `key`, so it no longer shares a key
  with the canvas and remounts correctly when the canvas is reset.

## [0.6.1] — 2026-09-18

Hardens the staged coverage queue against a cross-source identity gap and makes a failed
delegated tool call diagnosable. Both changes are backward compatible: the queue's public
behavior is unchanged for references that already matched, and the tool-error handling adds
a server-side diagnostic without altering the anonymized result the model sees. No database
migration, independently versioned contract-package change, or executable flow change is
included in this repository. Downstream research flows that consume this runtime bump their own
`metadata.version` in their respective deployment repositories.

### Fixed

- The staged coverage queue now deduplicates documents across the two retrieval paths by a
  canonical document identity instead of a raw reference string. Summary triage seeds the
  ledger with a document-level reference, while a discovery search hit can carry a deeper
  chunk/section reference when the store omits `base_ref`; the raw-string compare then failed
  to recognize the two as the same physical document, so a search hit's promotion was silently
  lost and — where two reference forms for one document coexisted — the same original could be
  read twice. Seeding and search-hit promotion now key on a normalized document identity
  (NFC, trimmed, trailing-slash- and case-insensitive, truncated to the parent document file).
  The reference handed to `get_document` is unchanged. Ledger seeding still fails closed when
  summary pages are genuinely missing.

### Added

- A delegated tool call that throws before returning a result now emits a server-side
  `tool_execution_failed` diagnostic carrying the raw error class (name and message) into the
  execution debug trace. The model-facing result stays the anonymized `Tool execution failed.`
  envelope, and tool arguments are deliberately excluded so a reference or query payload is
  never written to diagnostics. Previously the raw cause was discarded, making an adapter or
  transport failure indistinguishable from a budget, identity, or evidence guard.

## [0.6.0] — 2026-09-17

Makes structured output survive the three ways a local OpenAI-compatible server breaks it: the
document delivered in the reasoning channel, a near-miss response the strict schema parse rejects,
and a schema-enforced call whose prompt ends on an assistant turn. The plannerless coverage-report
extraction is the flow that hit all three; it now also names the refs it must decide and gets an
output ceiling that covers the largest supported batch. Every change is backward compatible: the
recoveries only engage on a response that would otherwise have failed, and the thinking-channel
toggle is scoped to a single verified model. No database migration, independently versioned
contract-package change, or executable flow change is included in this repository.

### Fixed

- Structured-output `llm` nodes no longer fail when an OpenAI-compatible server delivers the
  generated document in the reasoning channel with an empty `message.content`. Verified against the
  LM Studio build serving `qwen/qwen3.6-35b-a3b`: a `response_format: json_schema` request whose
  thinking channel is active returns the complete object in `reasoning_content`, which the AI SDK
  saw as empty text and reported as `No object generated: could not parse the response.` — failing
  every attempt and discarding a usable document. The response is now repaired at the fetch layer,
  scoped to non-streaming responses of requests that asked for `json_schema` / `json_object`, so no
  chain-of-thought can reach a free-form answer.
- A structured-output response that the strict schema parse rejects but that still contains a valid
  JSON object (code fence, trailing prose) is recovered from the error's raw text and emitted
  canonically, instead of consuming all three attempts and failing the node. Provider token usage
  attached to the error is accounted rather than reported as zero.
- The schema-enforced coverage-report extraction no longer sends a prompt that ends on an assistant
  turn. llama.cpp reads a trailing assistant message as a prefill to continue and then has to seed
  the `json_schema` grammar with that free text, which aborts sampler setup with HTTP 400
  `Failed to initialize samplers` before a token is produced — so every coverage report of a run was
  refused as `structured_output_failed` and the queue never advanced. A short user turn is appended
  where the shape requires it; a reply already ending on a user or tool turn is left untouched.
- The extraction prompt now enumerates the assigned refs, ordered and counted, with an explicit
  "each exactly once". The schema's ref `enum` is a decoding constraint, not information: with the
  refs absent from the prompt a constrained model repeated the first legal enum value for every
  array element, and the report was rejected as a duplicate ref.
- The extraction output ceiling rose from 12288 to 16384 tokens. A report costs roughly 120 output
  tokens per document, so a 100-document assignment stopped on `length` with truncated JSON and was
  refused as `invalid_json`, silently capping the queue.

### Added

- A `structured_output_salvaged` diagnostic and the `aiperator_llm_structured_salvaged_total`
  counter record when a node succeeded on a tolerant parse of the raw text rather than on enforced
  output, so a recovered near-miss is visible in the trace instead of looking like a clean success.
- Model capabilities carry `suppressThinkingKwargs`, the `chat_template_kwargs` that switch off a
  hybrid-reasoning model's thinking channel for engine-internal calls that are pure format
  conversion. It fails closed per model — a hosted OpenAI endpoint rejects unrecognized request
  arguments — and is currently declared only for the verified local `Qwen3.8-Flash-Next` build,
  which is also now recognized as accepting image input.

### Changed

- The `structured_output_failed` and `structured_output_empty_retry` diagnostics carry the
  provider's `finish_reason`, response length and output-token count when the SDK supplies them, so
  a truncated document (`finish_reason` `length` → raise `maxTokens`) is distinguishable from an
  empty one.
- The coverage-report extraction call switches the thinking channel off where the model declares the
  toggle. The reasoning is already done by the worker and the thinking tokens are billed against the
  same output ceiling as the report. Measured against a live llama.cpp endpoint on a 25-document
  batch: 11–15s and a stable 2.8k output tokens with the channel off versus 34–73s and 4.5k–7.1k
  with it on, at identical validity. An operator's own `chatTemplateKwargs` are preserved and only
  the toggle is forced.

## [0.5.0] — 2026-09-16

Adds a deterministic hard cap that shrinks an oversized prompt before the output-token allowance
would collapse to one token, and teaches the offline flow validator to resolve named providers.
Both changes are backward compatible: truncation only engages when a known context window would
otherwise be exceeded, and provider resolution during validation is opt-in via the existing
`PROVIDERS` environment variable. No database migration, independently versioned contract-package
change, or executable flow change is included in this repository.

### Added

- Deterministic prompt truncation for `llm` nodes: when an assembled prompt would exceed the
  model's usable input budget, the runtime shortens the largest earlier string message (never the
  final task turn), preserving head and tail around an explicit elision marker, instead of letting
  the output-token allowance be floored at one token. The current-task message is always kept
  intact, image and tool-call content are left untouched, and the operation is a pure function of
  its inputs so provider prompt-cache reuse is preserved.
- The event is recorded in the execution debug trace as a `context_truncated` diagnostic carrying
  the removed character count, the number of shortened messages, and the estimated prompt tokens
  before and after.
- The offline flow validator (`scripts/cli.ts validate`) resolves named `llm.provider` references
  by reading provider instances from the `PROVIDERS` environment variable, so deployment flows that
  target a named local endpoint validate without a running server. Malformed or schema-invalid
  `PROVIDERS` input is ignored with a warning rather than aborting validation, and an unset variable
  preserves the prior protocol-only behaviour.

### Fixed

- Removed an unused import in the agent-harness loop.

## [0.4.0] — 2026-09-15

Adds on-demand image inspection for text-only Runtime nodes and hardens plannerless coverage
report diagnostics. Existing flows remain compatible because image inspection is opt-in and the
stagnation limit remains opt-in. No database migration, independently versioned contract-package
change, or executable flow change is included in this repository.

### Added

- `llm` nodes can declare `config.imageInspection` with a dedicated vision-capable model. Inline
  image bytes are replaced by deterministic run-scoped `img-N` references, and the hosting model
  can call the collision-safe `inspect_image` tool only when visual evidence is needed.
- Image references cover initial attachments and same-loop tool-result images, deduplicate by
  canonical MIME type plus bytes, and retain active bytes independently of transient publication
  store eviction.
- Inspection calls report separate model usage, cost, success/error metrics and synthetic
  tool-node trace attribution. Static model-policy and capability discovery include the secondary
  inspection model.
- Invalid coverage reports now identify the violated report rule and expose a rejection streak
  scoped to the logical assignment.

### Fixed

- Productive coverage work in one parallel assignment resets global stagnation even when a sibling
  report is rejected, preventing valid progress from being terminated by an unrelated worker.
- Repeated invalid coverage reports consume the optional plannerless stagnation budget instead of
  silently retrying until the global iteration limit.
- Inspection-tool names are reserved after configured, media and caller tools are merged, so a
  caller-supplied `inspect_image` cannot replace the internal server-executed tool.
- Remote, undecodable, malformed-base64 and oversized image inputs fail closed rather than being
  forwarded to a text-only host or deferred to a paid vision failure.
- Run-owned image copies are bounded to 32 live references, 128 MiB per execution and 25 MiB per
  image. Transient media storage rejects empty or oversized items without evicting valid entries.
- Coverage rejection diagnostics no longer retain excerpts of worker output, avoiding duplication
  of source content into debug-trace details.

### Security

- Image-inspection documentation now states the direct vision-provider egress boundary, the
  default-off multimodal PII behavior, the distinction from MCP tool-egress controls, and the
  operator responsibility to verify no-plaintext image handling when required.
- Strict base64 canonicalization rejects invalid alphabets, padding and impossible lengths before
  image bytes enter Runtime's media or inspection stores.

### Compatibility

- Existing nodes without `config.imageInspection` keep their previous multimodal behavior. The
  new block requires a known vision-capable model or explicit `parameters.visionInput: true`.
- Evicted `img-N` references become unavailable and are never rebound to another image. Operators
  should size image-heavy flows within the documented fixed per-run bounds.
- No flow YAML is tracked in this repository. External flows opting into image inspection require
  their own semantic `metadata.version` bump and post-deployment `flow_version` verification.

## [0.3.0] — 2026-09-14

Adds deterministic worker routing for plannerless coverage queues. Existing flows remain
compatible: every assignment mode without an override continues to use the first valid
allowlist target. No database migration, independently versioned contract-package change, or
executable flow change is included in this repository.

### Added

- Agent-harness coverage queues accept optional
  `config.coverageQueue.targets.{summary,discovery,original}` entries, allowing summary triage,
  targeted discovery, and original-document review to run on different worker nodes.
- Flow validation trims configured targets and requires every target to be non-empty and present
  in the harness allowlist. Runtime validation also fails closed before delegation when a
  configured non-empty target does not resolve to an allowlisted node, even if schema validation
  was bypassed.

### Compatibility

- Omitting `coverageQueue.targets`, or omitting an individual mode, preserves the previous
  behavior by selecting the first valid allowlist target.
- Deployments may opt into mode-specific workers without migrating stored data. Any external
  executable flow changed to use the new configuration still requires its own semantic
  `metadata.version` bump and post-deployment `flow_version` verification in the execution
  debug trace.

### Security

- Mode-specific routing does not expand worker authority: configured targets must remain in the
  harness allowlist and resolve to valid, non-cyclic nodes before any task is delegated.

## [0.2.1] — 2026-09-11

Repairs multimodal LLM requests in Runtime. Image attachments now reach providers as AI SDK
file parts, local multimodal Qwen3 checkpoints are recognised as vision-capable, and an
optional vision step can be scoped to the current turn. No database migration, no contract
change and no executable flow change.

### Added

- LLM nodes accept `config.inputFilter: "current-turn-attachments"`, which skips the node
  unless the most recent user message itself carries an image or file part. The existing
  `"attachments"` filter keeps its behaviour of matching attachments anywhere in the
  checkpointed history.
- Model capabilities mark local vLLM Qwen3 NVFP4 checkpoints served over the OpenAI protocol
  as vision-capable. Local model ids match no cloud pattern and previously failed closed on
  vision; the rule is scoped to the multimodal build so text-only Qwen deployments stay closed.

### Fixed

- Image content is mapped to AI SDK `file` parts with the validated MIME type instead of the
  legacy `image` part, so providers receive the declared media type. Image detection, context
  window estimation and text rendering all recognise the file-part shape, including checkpoints
  written before this release.
- A vision preprocessing step filtered on attachments no longer runs for a later text-only
  request because an earlier checkpointed turn contained an image.
- The PII image describer passes the attachment MIME type through to the description request
  rather than sending an untyped image part.

## [0.2.0] — 2026-09-11

Expands Extract's document surface and progress contract. This release does not run a database
migration and does not change an executable flow. The independently versioned
`@atf/extract-contract` advances from 1.0.0 to 1.1.0 with additive fields.

### Added

- Extract and Search accept legacy DOC/XLS plus TIFF, BMP and WebP. LibreOffice handles both
  legacy and OOXML Office files; raster formats share the bounded image pipeline, with a dedicated
  decoded-pixel ceiling for BMP.
- Conversion responses expose aggregate token usage and pipeline timings in JSON and through
  `X-Token-Usage`, `X-Model` and the compatible `X-Vision-Model` header.
- SSE conversion now reports `queued`, `converting`, `progress` and `heartbeat` in addition to
  acceptance, completion and error events. Progress carries ordered page Markdown, cumulative
  tokens, ETA, elapsed time and per-page timing.
- `X-Callback-Events: extract|progress|all` opts asynchronous callers into equivalent ordered,
  best-effort progress callback POSTs before the terminal callback.

### Changed

- `@atf/extract-contract` 1.1.0 adds optional timing and progress telemetry. Consumers continue to
  gate on major version 1; the canonical Markdown grammar is unchanged.
- Search's `/ingest-file` proxy accepts every format supported by Extract and preserves the
  `atf-extract/1.1.0` provenance.
- Health output reports DOC, DOCX, XLS and XLSX as degraded when LibreOffice is unavailable.

### Fixed

- Legacy Office admission follows the complete CFB FAT and directory chains instead of assuming
  the primary Word or Excel stream is in the first directory sector.
- Slow progress callback receivers no longer delay page conversion or create an unbounded
  completion backlog. Intermediate delivery keeps one in-flight and the latest pending event,
  remains ordered and timeout-bounded, and the terminal callback retains its retry budget.
- Queue hook failures now restore active/waiting state instead of leaking capacity.

### Security

- DOC/XLS are admitted only after their OLE container contains the expected Word or Excel primary
  stream; unrelated compound formats are rejected before LibreOffice sees them.
- The supported parser surface grows to legacy OLE and an explicit BMP decoder. Existing upload,
  decoded-pixel, page and queue limits remain the resource boundaries; deployments should retain
  corpus and fuzz testing for untrusted documents.

### Compatibility

- SSE clients must ignore unknown event names for forward compatibility. Existing terminal `done`
  and error handling remains available, but the observable event sequence now includes queue and
  conversion state.
- DOC/XLS conversion requires LibreOffice. A deployment without it stays healthy but advertises
  those formats as degraded.
- No flow YAML is tracked in this repository, so no `metadata.version` changes here. A later flow
  deployment still requires checking `flow_version` in the execution debug trace.

## [0.1.4] — 2026-09-11

Corrects version metadata that 0.1.2 and 0.1.3 left behind, and adds the check that should have
caught it.

### Fixed

- **Service identities announced the wrong version.** Search's OpenAPI document
  (`GET /openapi.json`) and Gate's MCP server identity — the `serverInfo` in a discovery
  response, and the client identity Gate presents when proxying or importing another MCP server —
  still reported `0.1.1` after both preceding releases. A client reading either to record which
  version produced a result recorded a wrong answer. The README release badge, the project-status
  line, and the supported-versions table in [SECURITY.md](SECURITY.md) were stale for the same
  reason.
- README and DEVELOPMENT.md still described four applications and four Quickstart image targets.
  Both have been five since 0.1.2.

### Added

- `bun run verify:version` compares every hardcoded product-version occurrence against the root
  `package.json` and fails when they disagree; `bun run version:sync` rewrites them. CI runs the
  check in the Hygiene job. The declared occurrences live in
  `scripts/check-product-version.ts` — a new one belongs in that list, and the script fails
  loudly when a file it knows about changes shape.

  The duplication itself stays: a badge URL, a Zod schema default and an MCP client identity
  cannot import a version at the point they are written. Verifying the copies is the smaller
  mechanism than removing them.

## [0.1.3] — 2026-09-11

Security patch for the upload path introduced in 0.1.2. No contract-package or executable flow
version changed, and no migration runs.

### Security

- **`multer` 2.1.1 → 2.3.0** in Extract, closing five advisories against the multipart upload
  parser, three of them high severity: denial of service via crafted multipart field names, via
  an oversized array index in a field name, and via deeply nested field names, plus a file-size
  limit bypass through an async `fileFilter` race and incomplete cleanup on abort. Extract
  reaches this parser from four routes — `POST /v1/convert` and `POST /v1/ingest`, plus the
  browser equivalents under `/ui` — whenever the request is `multipart/form-data`, so the fix
  matters for any deployment an untrusted client can reach. The upgrade
  is API-compatible: `multer` 2.3.0 carries the same dependencies, and Extract uses only
  `memoryStorage`, `limits`, `single()` and the documented `LIMIT_*` error codes.

### Changed

- `bun.lock` now records the workspace versions that `package.json` declares. They had drifted
  because Bun only rewrites them when dependency resolution itself changes.

Adds a fifth application and an as-of dimension to retrieval. Read the migration notes: one
collection migration runs automatically, and evidence-pack hashes change for unchanged content.

### Added

- **Extract (`apps/extract`)**, a fifth application: document-to-Markdown extraction for PDF,
  DOCX, XLSX, PNG, JPEG and GIF. Every format funnels through one PDF page loop, so page
  numbers, page images and text offsets agree across formats. Each page is rendered and sent to
  a vision model together with its text layer, which stays authoritative for wording while the
  rendered page is authoritative for structure. Sync, SSE and async-callback response modes are
  selected by request header. It is the one application needing external binaries
  (`poppler-utils`, LibreOffice), which is why it is a separate service rather than part of
  Search. See [`apps/extract/README.md`](apps/extract/README.md).
- **`@atf/extract-contract` 1.0.0**, the canonical extracted-document grammar shared by Extract
  and Search: `## Seite N` page markers, `<figure>` entries with normalised geometry, per-page
  `<summary>` blocks, merged-cell HTML tables, figure asset identity, and the ingest headers.
- **`POST /ingest-file` in Search**: binary document ingest by proxying to Extract and then
  running the unchanged ingest path. Mounted only when `CONVERTER_URL` is set, otherwise 404.
  It forwards Markdown only, so figure descriptions are indexed but the images are not
  (`X-Figure-Assets: not-stored`). Use Extract's own `POST /v1/ingest` when crops should be
  viewable. New Search variables: `CONVERTER_URL`, `CONVERTER_TOKEN`, `CONVERTER_TIMEOUT_MS`
  (default 15 min, because conversion runs one vision call per page), `CONVERTER_UPLOAD_LIMIT`.
- **Temporal document validity in Search.** Retrieval already distinguished current from
  historical versions; this adds the *business* validity dimension, so a query can ask what a
  document set said at a given instant rather than only what is newest. `X-Valid-From` on
  ingest records when a revision takes effect, `X-Valid-At` on search and `valid_at` on
  `POST /evaluations/retrieval` and the MCP read tools select as of an instant, and every hit
  now carries `valid_from` (nullable) and `effective_valid_from`
  (`COALESCE(valid_from, created)`). Timestamps without a UTC offset are rejected rather than
  guessed. Omitting the headers leaves the previous behaviour unchanged.
- `ragProfiles` sources in Runtime accept `includeAllVersions` and `validAt`, forwarded to
  Search as `include_all_versions` and `valid_at`, so a flow can pin retrieval to an instant.
- `ingest_document` over MCP accepts `version_mode` and `valid_from`. The default stays
  `replace`, which is what the tool did implicitly before.

### Changed

- **Evidence-pack `snapshotHash` and `evidenceId` change for identical content.** The hash input
  is now a canonical JSON object and includes `versionSource`, `validFrom` and
  `effectiveValidFrom`; `retrieve_evidence` additionally binds `effective_valid_from`. The
  schema version stays `v2` because the pack's *shape* is unchanged, so a stored hash compared
  against a freshly computed one will mismatch without any schema signal. Recompute persisted
  evidence identifiers, or keep them alongside the pack that produced them.
- `temporalScope` in the evidence pack gained `as_of_latest` and `as_of_all`, and a `validAt`
  field. Existing values keep their meaning; an exhaustive consumer-side switch needs the two
  new arms.
- **`is_latest` is now decided per ingest revision rather than per row.** Every chunk of one
  revision shares a private version-group id (`metadata._atf_version_group`), so an as-of
  selection can no longer return half a version. For multi-chunk documents ingested in version
  mode this changes which rows the default search returns — previously one row per `base_ref`
  won. The group id is written into `metadata` and is therefore visible to anything reading
  metadata raw.
- The Quickstart image inventory now covers all five image targets. The Extract image installs
  Debian packages (`poppler-utils`, LibreOffice, metric-compatible fonts) whose licenses are not
  covered by the generated JavaScript inventories; see [DEPLOYMENT.md](DEPLOYMENT.md).
- Artifact size budgets now cover `apps/search/dist` and `apps/extract/dist`, so a bundle
  regression in either service fails CI instead of going unnoticed.

### Fixed

- `deploy/examples/.env.example` was missing `ATF_EXTRACT_PORT`, which `compose.yaml` reads.

### Migration notes

- **Collection schema 10 → 11**, applied automatically at Search startup under the existing
  advisory lock. It adds a nullable `valid_from TIMESTAMPTZ` column and one index, both with
  `IF NOT EXISTS`: no rename, no type change, no backfill, no `NOT NULL`. Existing rows stay
  valid and their effective validity is their `created` timestamp. Rolling back to 0.1.1 is
  data-safe — the older binary ignores the column — but the stored `schema_version` remains 11.
- Rebuilding the index is not blocking, but on a large collection it is not instant either.
  Plan the first start after the upgrade accordingly.
- If you persist `evidencePackHash`, `snapshotHash` or `evidenceId`, recompute them; see the
  first entry under Changed.

## [0.1.1] — 2026-09-02

Public-release hardening patch. No contract-package or executable flow version changed.

### Added

- Contributor Copyright Assignment Agreement 1.0 with individual and corporate execution,
  assignment/exclusive-rights fallback, commercial and alternative-licensing rights, patent
  terms, and a versioned acceptance trailer.
- A synthetic, non-auto-loaded compliance-policy example with documented activation and
  fail-open loading boundary.
- Canonical CC0-1.0 license text for the narrowly reviewed `type-fest@0.13.1` expression.

### Changed

- Contribution templates, CI trailer validation, copyright, licensing, and ownership
  documentation now use one assignment model in favor of Abillify Technology GmbH.
- Control documentation now matches the implementation: relative same-origin Runtime URLs are
  the production default, `NEXT_PUBLIC_BACKEND_URL` is an explicit build-time override, and CSP
  modes are `legacy` or report-only rather than enforcement.
- Architecture, security, compliance, PII, RLS, Gate-driver, image-generation, Quickstart, and
  Playwright claims now state their configuration, deployment, and verification boundaries.
- Product metadata for Runtime, Control, Search, Gate, system integration, Search OpenAPI, and
  Gate MCP identities is `0.1.1`.

### Fixed

- Third-party licensing is now an exact fail-closed SPDX-expression allowlist that requires
  complete text for every AND/OR branch; the Apache-2.0 copy is canonical rather than
  vendor-specific.
- SPDX header application preserves additional third-party copyright holders.
- Generated configuration documentation records Search `NODE_ENV` correctly and no longer
  emits a phantom `T`; volatile hand-maintained variable counts were removed.
- Tenant RLS documentation now uses the implemented, reviewable `rls-status` and
  `rls-setup --confirm` CLI instead of a nonexistent SQL file.

## [0.1.0] — 2026-09-01

Initial public release of the Aiperator Trust Fabric monorepo: Runtime, Control, Search, and
Gate, with the versioned contract packages that connect them.

The four applications, their request path, and the design rules are described in
[ARCHITECTURE.md](ARCHITECTURE.md). The capability surface is enumerated in
[docs/CAPABILITIES.md](docs/CAPABILITIES.md), and every environment variable in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md). Architecture decisions carried over from the
predecessor repositories are in [docs/adr/](docs/adr/); a version statement inside a migrated
ADR describes that document's point in time, not this release.

### What `0.1.0` commits to

ATF is pre-1.0, and this release does not promise a stable public surface. Concretely:

- The **contract packages** under `packages/` are the surfaces that already carry a stability
  promise, because a break there breaks a running deployment across services. They version
  independently of this file.
- Environment variables, flow YAML fields, and HTTP routes **may change without a major bump**
  before 1.0. Breaking changes will be listed here with the migration.
- Two names are already deprecated aliases kept for compatibility and will be removed in a
  future major: the `X-Mandant-Id` request header (use `X-Tenant-Id`) and the implicit
  `clientClientdocs` default for `ragProfiles.authoritativeTagField` (declare the field
  explicitly).
- A small number of environment variables are read outside Runtime's startup schema and are
  marked **read directly — not validated at startup** in
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Migrating them into the schema is tracked
  work, not settled design.

See [SECURITY.md](SECURITY.md) for which versions receive security fixes.

[Unreleased]: https://github.com/abillify/atf/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/abillify/atf/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/abillify/atf/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/abillify/atf/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/abillify/atf/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/abillify/atf/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/abillify/atf/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/abillify/atf/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/abillify/atf/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/abillify/atf/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/abillify/atf/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/abillify/atf/compare/v0.3.0...v0.9.1
[0.9.0]: https://github.com/abillify/atf/compare/v0.3.0...v0.9.0
[0.8.0]: https://github.com/abillify/atf/compare/v0.3.0...v0.8.0
[0.7.2]: https://github.com/abillify/atf/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/abillify/atf/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/abillify/atf/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/abillify/atf/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/abillify/atf/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/abillify/atf/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/abillify/atf/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/abillify/atf/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/abillify/atf/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/abillify/atf/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/abillify/atf/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/abillify/atf/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/abillify/atf/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/abillify/atf/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/abillify/atf/releases/tag/v0.1.0
