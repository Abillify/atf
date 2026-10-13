<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# DPIA template (Data Protection Impact Assessment, German "DSFA", Art. 35 GDPR / DSGVO)

A working aid for the controller. ATF provides the technical building
blocks; the legal assessment is the responsibility of the controller and the
data protection officer. This template is adapted to the ATF architecture
(0.14) — the notes it ships (`→ ATF:`) are not legal advice; they show which
controls the platform contributes.

## 1. Description of the processing

| Field | To fill in | ATF reference |
| --- | --- | --- |
| Controller / processor | | ATF can play either role (SaaS = data processing agreement, self-hosted = tool) |
| Purpose(s) | | e.g. document intelligence, assistance, research |
| Categories of data subjects | | End users, persons named in documents |
| Data categories | | Chat content, documents, metadata, audit log |
| Special categories (Art. 9)? | | Document content may contain Art. 9 data → check the PII-vault mode |
| Storage locations / recipients | | Postgres, outstore, LLM providers (attach the list!) |
| Retention periods | | TTLs: vault, sessions, audit — configurable |

→ ATF: the processing overview comes from the record of processing
activities (`VVT-VORLAGE.md`); flows document the concrete data flow.

## 2. Processors and third countries

- [ ] Data processing agreements documented for hosting, LLM providers and embedding providers
- [ ] Adequacy decision or SCC + TIA per provider
- [ ] Provider egress restricted to the approved list
      → ATF: the egress allowlist technically enforces what was agreed contractually
- [ ] BYOK: the tenant's key ownership documented

## 3. Principles check (Art. 5)

| Principle | Measure | ATF control |
| --- | --- | --- |
| Purpose limitation | Flows define the use; no cross-tenant use | Tenant isolation (ADR 0005) |
| Data minimisation | PII only where needed; tokenisation instead of clear text | PII vault (ADR 0007), detector pipeline (ADR 0015) |
| Storage limitation | TTLs for vault/sessions, deletion concept | Cross-service erasure (ADR 0025), confirm-deletes (Outpost) |
| Integrity/confidentiality | Encryption at rest and in transit, audit | Runtime audit hash chain + signed anchors (ADR 0026), secret cipher |
| Accountability | Evidence per processing activity | Evidence dossier (ADR 0009), audit log, decision receipts (ADR 0029) |

## 4. Data subject rights

| Right | Implementation | Deadline tooling |
| --- | --- | --- |
| Access (Art. 15) | Export per subject/tenant through Control/API (`GET /v1/me/data`) | — |
| Rectification (Art. 16) | Re-ingest replaces the document version | Revisions in Search |
| Erasure (Art. 17) | Runtime erasure orchestrator (`DELETE /v1/me/data`, operator DSAR `POST /admin/compliance/forget`) fans out to the `POST /v1/erasure` endpoints of Search, Extract and Gate; the aggregate status is honest about partial results | Every erasure is audited; signed erasure receipt (`GET /v1/me/data/erasures/{id}`) |
| Objection (Art. 21) | Disable the flow per tenant | — |

- [ ] Deletion concept documented (periods per data category)
- [ ] Erasure test run documented (date, sample, result)

## 5. Risks to rights and freedoms (likelihood × severity)

| Risk | Likelihood | Severity | Measures | Residual risk |
| --- | --- | --- | --- | --- |
| Unauthorised access to documents | | | AuthN/tenant scoping, volume encryption | |
| PII exposure to the LLM provider | | | PII vault, output guardrails, egress allowlist | |
| AI decision that cannot be traced | | | Decision provenance (ADR 0017), trace per execution, decision receipts | |
| Data leaking through tool misuse (prompt injection) | | | Tool policy (ADR 0011), red-teaming (ADR 0010) | |
| Audit tampering | | | Hash chain + externally stored signed anchor | |

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
