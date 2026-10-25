<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# DPIA template (Data Protection Impact Assessment, German "DSFA", Art. 35 GDPR / DSGVO)

A working aid for the controller. ATF provides the technical building
blocks; the legal assessment is the responsibility of the controller and the
data protection officer. This template is adapted to the ATF architecture
(0.19.0, 2026-10-22) — the notes it ships (`→ ATF:`) are not legal advice; they show which
controls the platform contributes.

## 1. Description of the processing

| Field | To fill in | ATF reference |
| --- | --- | --- |
| Controller / processor | | ATF can play either role (SaaS = data processing agreement, self-hosted = tool) |
| Purpose(s) | | e.g. document intelligence, assistance, research |
| Categories of data subjects | | End users, persons named in documents |
| Data categories | | Chat content, documents, metadata, audit log |
| Special categories (Art. 9)? | | Document content may contain Art. 9 data → check the PII-vault mode |
| Storage locations / recipients | | Postgres (including the Search asset store `vs_assets`), Extract source store (`SOURCE_STORE_DIR`), LLM providers (attach the list!), semantischer Antwort-Cache (`SEMANTIC_CACHE_ENABLED`): pro Tenant und Nutzer getrennt, Löschung je Nutzer, TTL `SEMANTIC_CACHE_TTL_SECONDS`, Citation-Index `answer_citations` (`CITATION_INDEX_ENABLED`, opt-in): Zweck Nachvollziehbarkeit erteilter Antworten (Nutzer-ID, Ausführungs-ID, Dokument- und Chunk-Referenzen, keine Antwort- oder Chunk-Texte), pro Tenant und Nutzer getrennt |
| Retention periods | | TTLs: vault, sessions, audit — configurable. Extract keeps finished jobs (with the stored model response of every page) until `JOB_RETENTION_DAYS` (default: forever), abandoned uploads for `UPLOAD_SESSION_MAX_AGE_HOURS` (72), the derived-PDF cache by size and age; source bytes until the document is deleted or erased |

→ ATF: the processing overview comes from the record of processing
activities (`VVT-VORLAGE.md`); flows document the concrete data flow.

## 2. Processors and third countries

- [ ] Data processing agreements documented for hosting, LLM providers and embedding providers
- [ ] Adequacy decision or SCC + TIA per provider
- [ ] Provider egress restricted to the approved list
      → ATF: `EGRESS_ALLOWED_HOSTS` technically enforces what was agreed contractually — only
        when it is set; empty means every public host (the production gate warns)
- [ ] BYOK: the tenant's key ownership documented

## 3. Principles check (Art. 5)

| Principle | Measure | ATF control |
| --- | --- | --- |
| Purpose limitation | Flows define the use; no cross-tenant use | Tenant isolation (ADR 0005) |
| Data minimisation | PII only where needed; tokenisation instead of clear text | PII vault (ADR 0007), detector pipeline (ADR 0015) |
| Storage limitation | TTLs for vault/sessions, deletion concept | Cross-service erasure (ADR 0025), confirm-deletes (Outpost); `answer_citations` via Retention-Sweep (`RETENTION_ENABLED`) und Löschkanal je Nutzer |
| Integrity/confidentiality | Encryption at rest and in transit, audit | Runtime audit hash chain + signed anchors (ADR 0026), secret cipher |
| Accountability | Evidence per processing activity | Evidence dossier (ADR 0009), audit log, decision receipts (ADR 0029) |

## 4. Data subject rights

| Right | Implementation | Deadline tooling |
| --- | --- | --- |
| Access (Art. 15) | Export per subject/tenant through Control/API (`GET /v1/me/data`) | — |
| Rectification (Art. 16) | Re-ingest replaces the document version | Revisions in Search |
| Erasure (Art. 17) | Runtime erasure orchestrator (`DELETE /v1/me/data`, operator DSAR `POST /admin/compliance/forget`) fans out to the `POST /v1/erasure` endpoints of Search, Extract and Gate; the aggregate status is honest about partial results | Every erasure is audited; signed erasure receipt (`GET /v1/me/data/erasures/{id}`). Self-service erasure is keyed on the token's `iss` and `sub` (an `email` only when `email_verified` is true), requires a tenant claim, and covers executions, usage log, checkpoints, assistant data and other runtime stores; a store that cannot be erased automatically turns the result into `partial` |
| Objection (Art. 21) | Disable the flow per tenant | — |

Erasure receipts contain sha256(tenant id | identifier). Whoever knows a
candidate identifier can recompute the hash, so receipts are pseudonymous
personal data in the sense of Art. 4(5) GDPR.

- [ ] Deletion concept documented (periods per data category)
- [ ] Erasure test run documented (date, sample, result)

Audit entries written by releases before this change may contain the erased
subject in clear text (details.subject); they remain in the append-only audit
log. Newer entries carry only subject hashes and keyed pseudonyms
(AUDIT_PSEUDONYM_PEPPER).

## 5. Risks to rights and freedoms (likelihood × severity)

| Risk | Likelihood | Severity | Measures | Residual risk |
| --- | --- | --- | --- | --- |
| Unauthorised access to documents | | | AuthN/tenant scoping, volume encryption | |
| PII exposure to the LLM provider | | | PII vault, output guardrails, egress allowlist | |
| AI decision that cannot be traced | | | Decision provenance (ADR 0017), trace per execution, decision receipts | |
| Data leaking through tool misuse (prompt injection) | | | Tool policy (ADR 0011), red-teaming (ADR 0010), retrieved context handed to the model as delimited untrusted data (`RETRIEVAL_CONTEXT_MODE`), injection scan on chunks and tool results, approval for write tools after a finding (`TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`); detection is heuristic | |
| Personal data in service logs | | | Shared log redaction for credentials and tokens, no raw search queries or user ids in Search logs, hashed emails in OIDC logs | |
| Audit tampering | | | Hash chain + externally stored signed anchor | |
| Frühere Revisionen mit personenbezogenen Daten bleiben über `document_diff` / `trace` lesbar | | | Gleiche Zugriffsrechte wie die Suche (`valid_at`-Regel auf dem Token des Aufrufenden); Löschung über Löschkonzept / Erasure und Revisions-TTL | Gelöschte oder ersetzte Inhalte früherer Revisionen sind für berechtigte Nutzer lesbar, solange die Revisionen gespeichert sind; Restlöschung erst mit Erasure oder TTL-Ablauf |

→ Detailed attack surfaces: `THREAT-MODEL.md` (STRIDE per service).

## 6. Remediation and residual-risk assessment

- [ ] Residual risks accepted by: ____________ (date, signature)
- [ ] Next review due on: ____________ (usually 2 years, or on a material
      change: new provider, new data category, enabling the updater,
      enabling Autopilot)

## 7. Annexes

- A: Flow inventory (from the Control export) with a data-flow sketch per flow
- B: Provider list with SCC/TIA references
- C: Outpost/desktop installations (which sources, which folders)
- D: Attestations: erasure test, audit-chain verification, pen-test/red-team report
