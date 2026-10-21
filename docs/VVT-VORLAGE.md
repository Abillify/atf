<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Record of processing activities (RoPA, German "VVT") — template (Art. 30 GDPR / DSGVO)

One row per processing activity. ATF-specific activities are pre-filled;
fields marked `→` must be completed per deployment. Copy this file into the
deployment system (not back into the product repository).

| # | Activity | Controller | Purpose | Data subjects | Data categories | Recipients | Third-country transfer | Legal basis | Retention | Technical security |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Chat/assistance (Runtime `/v1/chat/completions`) | → | → | End users, persons named in documents | Chat content, PII where present (tokenised through the vault) | LLM providers (→ list) | → | → (Art. 6(1)(b)/(f), Art. 28 processing agreement) | → (execution TTL, audit period) | TLS, vault AES-GCM, tenant isolation, audit chain, decision receipts, log redaction, erasure of checkpoints, assistant data and usage log by `iss`+`sub` |
| 2 | Document ingest (Extract `/v1/ingest`) | → | → | Persons named in documents | Documents, metadata, owner (`created_by_*`) | Extract source store (`SOURCE_STORE_DIR`), Search asset store (`vs_assets`), converter (isolated) | → | → | → | TLS, volume encryption, non-root, erasure chain |
| 3 | Indexing/search (Search) | → | → | Persons named in documents | Text passages, embeddings | — | no | → | → | Tenant scoping, revisions; search statistics store a peppered query hash, no raw query by default (`STATS_STORE_RAW_QUERY`), no query text or user ids in logs |
| 4 | Audit logging (Runtime audit log; Gate file audit sink) | → | Accountability, security | End users (check for employee data!) | Actor, action, timestamp, hash | — | no | Art. 6(1)(c)/(f) | → (audit period) | Runtime: hash chain + signed anchors, append-only; Gate: sink-level redaction, subject erasure via `POST /v1/erasure` |
| 5 | Outpost sync (Docker/desktop) | → | → | Persons named in documents | Local folders/cloud sources → ATF | ATF instance | → | → | → (confirm-deletes) | TLS, non-root, read-only mounts, OS keychain (desktop) |
| 6 | Administration/monitoring (Gate `/monitor`, Control) | → | Operations | Operators (employee data) | Sessions, login log | — | no | Art. 6(1)(b)/(f) | Session TTL | OIDC, CSP nonces, Gate monitor token exchanged for an HttpOnly session cookie, Control BFF session cookie (`SameSite=Strict`) |
| 7 | → (Autopilot enabled?) | | | | | | | | | Human approval + drift guard (ADR 0008) |
| 8 | → (BYOK enabled?) | | | | Tenant provider keys | Provider | → | | Key rotation | AES-GCM at rest |

## Notes for filling in

- Document the **purpose** per flow — the flow inventory from Control
  (annex A of `DSFA-VORLAGE.md`) is the source; every flow change means a
  review of this record.
- **Third-country transfer**: the egress allowlist (`EGRESS_ALLOWED_HOSTS`) is the
  technical truth for this field **once it is set**. It is optional: while it is
  empty, guarded outbound calls reach every public host (private and metadata
  ranges stay blocked) and the production gate only warns. Set it before you
  state in this record that only the listed recipients can be reached.
- **Retention**: vault = execution TTL; sessions = `OIDC_SESSION_TTL_SECONDS`;
  audit = deployment policy; source and asset stores = deletion concept.
- **Extract retention**: finished jobs (persisted model responses, outboxes) until
  `JOB_RETENTION_DAYS` — the default keeps them, so state your period here and set it;
  abandoned uploads `UPLOAD_SESSION_MAX_AGE_HOURS` (72); converted-PDF cache bounded by
  `DERIVED_PDF_CACHE_MAX_MB`/`_MAX_AGE_HOURS`; source documents until
  `DELETE /v2/documents/{reference}` or an erasure removes them.
- **Retention targets** beyond the above (conversation checkpoints, assistant data, workspaces, cost ledger, analysis artifacts) are listed in `docs/CAPABILITIES.md` and purge by age.
- **Erasure receipts** contain sha256(tenant id | identifier); they are pseudonymous personal data (Art. 4(5) GDPR), not anonymous, because anyone who knows a candidate identifier can recompute the hash.
- **Employee data**: evaluating monitoring or audit data can amount to
  employee monitoring — check the works agreement (Germany).
- Version changes to this record with date and author (git in the
  deployment repository).
