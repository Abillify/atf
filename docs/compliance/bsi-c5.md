<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# BSI C5 (cloud compliance criteria catalogue): which topics ATF serves and which it cannot

> **Draft mapping. Not legal advice. Clause references must be verified against the official text
> before use.**
>
> The *Reference* column is `TODO(human)` in every row by design; see
> [compliance/README.md](README.md) for why this mapping cannot be generated from the repository.
> Topic headings are paraphrases for orientation, not quotations, and deliberately carry no
> control code — the catalogue's structure, codes and wording must be taken from the C5 itself.

## 1. What C5 asks of, and where an AI runtime can be placed inside it

C5 is a catalogue of security requirements addressed at **cloud service providers**, and a C5
attestation is something a provider obtains from an auditor. It is not a product mark, and this
repository neither claims one nor supplies material that could be read as one. That leaves three
situations an operator will actually be in, and they need to be kept apart:

| Situation | Who is assessed | What ATF can contribute |
| --- | --- | --- |
| ATF runs in the operator's own infrastructure or private cloud | the operator's platform, not ATF | configuration and evidence that the *deployment* meets the technical requirements: isolation, access control, logging, cryptography, deletion |
| ATF is consumed as a hosted service | the party operating that service | the same, plus the supply-chain artefacts a customer's supplier assessment will ask for |
| A C5-attested platform hosts ATF | the underlying provider | nothing: an attestation of the IaaS does not extend to what runs above it, and ATF cannot inherit it |

C5 also predates the mainstream deployment of LLM-based systems, so several catalogue themes —
homogeneous redundancy, virtualisation isolation, physical security, personnel — have no AI-specific
reading at all. Those rows say **not covered** rather than reaching for an adjacent feature. The
themes where an AI runtime genuinely adds something are data-class governance, egress control,
key management, deletion evidence and monitoring, and those are treated in depth.

## Capability areas cited in this mapping

Every ATF control named in the tables below is documented in one of these sections of
[../CAPABILITIES.md](../CAPABILITIES.md).

| Capability area | Controls cited in this file |
| --- | --- |
| [Human-in-the-loop approvals](../CAPABILITIES.md#human-in-the-loop-approvals) | separate-approver rule, approver scope |
| [Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity) | tenant isolation and row-level security, JWT with issuer-to-tenant binding, operator roles, BYOK |
| [Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access) | flows, providers and models as versioned configuration; the executed flow revision is identifiable in the run record |
| [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | policy as code with data classes and residency rules, tamper-evident audit log with signed anchors, compliance dossier and posture report, erasure receipts |
| [Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety) | untrusted-content fencing, taint propagation, sandboxing with network off by default, hostile-document limits |
| [Observability](../CAPABILITIES.md#observability) | metrics, traces and logs on all services, metric authentication, alerting, offline configuration preflight |
| [Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control) | per-run budgets, tool-loop guard, failover chains, bounded queues, SLO breach counters |
| [Retrieval](../CAPABILITIES.md#retrieval) | bounded retrieval context, provenance per chunk, golden-set evaluation with latency budgets |
| [Operator interface](../CAPABILITIES.md#operator-interface) | session and CSP model, operator plane binding, provider bench |
| [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay) | eval runs with a judge model, groundedness, replay, bench-gated flow releases with signed receipts |

## 2. Governance, organisation and contract

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Information security management system | — not covered. ATF cannot be an ISMS and cannot be certified as one. It can make the technical part of an ISMS observable: which controls are on, which are failing | `ATF_PROFILE=production`, `ATF_PRESET=regulated` | `GET /monitoring/posture` — ok/warn/fail per control, plus the production-gate result; offline `bun run atf-doctor --service runtime\|search\|extract\|gate` | `TODO(human)` |
| Roles, separation of duties | Separation the platform enforces rather than documents: an approval cannot be resolved by the person who requested it, the resolver is taken from the verified identity and never from a client label, and operator capabilities are mapped from token claims ([Human-in-the-loop approvals](../CAPABILITIES.md#human-in-the-loop-approvals)) | `policies.approval.requireDifferentApprover`, `policies.approval.approverScope`, `OPERATOR_ROLE_CLAIM`, `OPERATOR_ROLE_MAP` | Audit entries with `actor`, `target`, `outcome` per decision; `aiperator_approvals_total` | `TODO(human)` |
| Contractual and legal topics, incl. government access requests | — not covered. No law-enforcement access-request process, no transparency report, no contractual terms are produced here. What exists technically: tenant data is separated and retrievable only within the tenant's own scope | `TENANT_ISOLATION_ENABLED`, `TENANT_RLS_ENABLED`, `TENANT_RLS_REQUIRED` | `GET /v1/me/data` (subject self-service export) | `TODO(human)` |
| Personnel management, screening, training | — not covered; organisational | — | — | `TODO(human)` |
| Compliance monitoring and evidence of compliance | A configuration that is declarative and a posture that is queryable: the question "is this requirement implemented" resolves to a named setting plus a reported state, instead of an interview ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `COMPLIANCE_POLICY_REQUIRED=true`, `ATF_PRESET` | `GET /admin/compliance-policy`, `GET /admin/compliance/dossier?format=json\|markdown` | `TODO(human)` |
| Change control and configuration management | Flows are files under version control, validated against a schema, hot-reloaded without restart, and CI refuses a flow change without a version bump. The executed revision is identifiable in the run record ([Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access), [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `FLOWS_DIR`, flow `metadata.version`, `check:flow-versions` | `flow_version`, `flow_digest`, `subflow_versions[]` in `GET /monitoring/debug/:executionId` | `TODO(human)` |
| Supply chain management | Which plugins load at all is enforced configuration: a name allowlist or a hash manifest, and in production a plugin with neither is refused. The default sandbox is off, so an in-process plugin keeps full process privileges ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)). The dependency and licence inventory below is a build artefact, not a runtime control — CAPABILITIES.md does not cover it | `PLUGINS_ALLOWLIST`, `bun run supply-chain`, `bun run verify:public:release` | [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md), [../../sbom.cdx.json](../../sbom.cdx.json), [../IMAGE-LICENSES.md](../IMAGE-LICENSES.md) | `TODO(human)` |
| Incident response and emergency management | Severity-graded runbook with first-response steps, investigation aids and specific procedures for a compromised evidence-signing key or leaked tokens ([Observability](../CAPABILITIES.md#observability)) | — | [../runbooks/incident.md](../runbooks/incident.md), [../runbooks/key-rotation.md](../runbooks/key-rotation.md) | `TODO(human)` |
| Business continuity | Long runs survive a restart through checkpoints; queue depth and flow-load failures are metrics; rate-limit state is shared so throttling stays correct across replicas. Backup is documented and manual, with no scheduler ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `CHECKPOINTING_ENABLED`, `RATE_LIMIT_REDIS_URL`, `REPLICAS` | [../runbooks/backup-restore.md](../runbooks/backup-restore.md), [../runbooks/redis-outage.md](../runbooks/redis-outage.md), [../runbooks/scaling.md](../runbooks/scaling.md) | `TODO(human)` |

## 3. Data protection, residency and deletion

This is the cluster where ATF is strongest, because data-class governance, reachability and deletion
evidence are implemented as enforcement rather than as policy text.

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Data minimisation and purpose limitation | Retrieval returns only the passages selected for the question, the prompt is assembled from a bounded context, and personal data detected on the way to a model is replaced by a placeholder — the provider sees the vault's token, not the value ([Retrieval](../CAPABILITIES.md#retrieval)) | `PII_VAULT_ENABLED`, `PII_VAULT_TYPES`, `PII_DETECTORS`, `SEARCH_MAX_QUERY_CHARS` | `aiperator_pii_vault_tokens_total`, `aiperator_guardrail_redactions_total` by finding type | `TODO(human)` |
| Data locality and residency | A flow declares the data classes it processes; the compliance policy constrains model choice and provider/data rules, and a provider outside an allowlist or in a known disallowed region blocks admission. Region metadata is the operator's responsibility — a *required but unknown* region is advisory, not blocking | `dataClasses` per flow, provider/data rules in `compliance-policy.yaml`, `EGRESS_ALLOWED_HOSTS` | `GET /admin/compliance-policy`; the policy embedded in the dossier; see [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | `TODO(human)` |
| Separation and tenant isolation | Per-tenant namespaces across the stores, optional row-level security, and a documented split between control and data planes so one tenant's operator cannot read another's ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `TENANT_ISOLATION_ENABLED`, `TENANT_RLS_ENABLED`, `TENANT_RLS_REQUIRED`, `JWT_ISSUER_TENANTS` | [../adr/0005-tenant-data-isolation.md](../adr/0005-tenant-data-isolation.md); [../THREAT-MODEL.md](../THREAT-MODEL.md) | `TODO(human)` |
| Encryption of data at rest | Encrypted storage for tenant keys and secrets, the PII-vault mapping, and AAD-bound re-encryption for delegated credentials; bring-your-own-key so the platform's ability to read is separable from the data's confidentiality ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `BYOK_ENABLED`, `BYOK_ENCRYPTION_KEY`, `PII_VAULT_ENCRYPTION_KEY` | [../runbooks/key-rotation.md](../runbooks/key-rotation.md) | `TODO(human)` |
| Encryption of data in transit | HTTPS on the internal services with optional client-certificate verification; the desktop sidecar binds to loopback only ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_CLIENT_CA_FILE` | `GET /monitoring/posture` | `TODO(human)` |
| Cryptography and key management | Ed25519 for evidence, anchors and receipts, with the algorithm fixed in the artefact so verification cannot silently downgrade; a deliberate dual-key overlap for rotation ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `EVIDENCE_SIGNING_KEY`, `RECEIPT_SIGNING_KEY`, `API_KEY_PEPPER`, `API_TOKEN_NEXT` | `GET /.well-known/atf-evidence-jwks.json`, `GET /.well-known/atf-receipt-jwks.json`; [../runbooks/transaction-token-rotation.md](../runbooks/transaction-token-rotation.md) | `TODO(human)` |
| Deletion concepts and proof of deletion | Subject-scoped erasure with a signed receipt, export of what is held about a subject, and a per-store retention table naming the setting and whether erasure actually removes the record. Two deliberate exclusions: the audit log is append-only and never purged, and erasure keeps the row with the subject set to NULL so the accountability record survives ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `RETENTION_ENABLED`, `RETENTION_MAX_AGE_DAYS`, `JOB_RETENTION_DAYS` (Extract), `REVISION_TTL` (Search), `STATS_RETENTION_DAYS` (Search) | `GET /v1/me/data`, signed erasure receipts (`GET /v1/me/data/erasures/{id}`); [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) | `TODO(human)` |
| Transparency to the data subject and user | Per-answer provenance — model, sources, routing, policy decisions — and an opt-in marker that a response is AI-generated ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `AI_DISCLOSURE` | `GET /monitoring/explain/{executionId}` | `TODO(human)` |

## 4. Operations, platform security, and development

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Access control and identity management | JWT with JWKS verification, multiple issuers, audience checks, issuer-to-tenant binding, RBAC for the operator plane, policy-based tool authorization that fails closed, and scopes that change what a tool exposes rather than only whether it runs ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `AUTHN_MODE`, `JWT_*`, `JWT_ISSUER_TENANTS`, `TRUSTED_IDENTITY_HEADERS`, `STRICT_IDENTITY_HEADERS`, `TOOL_AUTHZ_FAIL_CLOSED` | `mcpgate_auth_failures_total`; `aiperator_requests_rejected_total` by reason | `TODO(human)` |
| Session and interface security | The browser never holds an access token in the recommended mode; session handling is server-side, and the content security policy is emitted per request with a script nonce ([Operator interface](../CAPABILITIES.md#operator-interface)) | `CONTROL_SESSION_MODE=bff`, `CONTROL_SESSION_SECRET`, `CONTROL_PUBLIC_ORIGIN`, `CONTROL_CSP_MODE` | [../adr/0013-oidc-backend-driven-session-authentication.md](../adr/0013-oidc-backend-driven-session-authentication.md), [../adr/0027-csp-nonce-operator-plane.md](../adr/0027-csp-nonce-operator-plane.md) | `TODO(human)` |
| Network and perimeter protection | Every outbound call goes through an egress guard that resolves the name first and rejects link-local, loopback and private ranges per request, with an optional destination allow-list; tool-call arguments are scanned before they leave the runtime; callbacks carry their own host allow-list; per-service ports have separate credential types ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `EGRESS_ALLOWED_HOSTS`, `CALLBACK_ALLOWED_HOSTS` (Extract) | [../adr/0024-shared-security-kit.md](../adr/0024-shared-security-kit.md); [../THREAT-MODEL.md](../THREAT-MODEL.md) | `TODO(human)` |
| Virtualisation and resource isolation | Sandboxing for generated code and for plugins with network access off by default; bounded work per run so one execution cannot exhaust a shared worker ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `SANDBOX_ENABLED`, `SANDBOX_NETWORK_ENABLED`, `PLUGINS_SANDBOX`, `budgets` (`maxTokens`, `maxToolCalls`, `maxWallMs`) | `aiperator_tool_loop_guard_total`, request rejections by reason | `TODO(human)` |
| Malware and hostile-input protection | Documents are treated as hostile from the first byte — bounded decompression, entry and ratio ceilings — and untrusted content is fenced before it reaches a model, with taint labels that survive the hop between services ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `ZIP_MAX_ENTRIES`, `ZIP_MAX_ENTRY_BYTES`, `ZIP_MAX_TOTAL_BYTES`, `ZIP_MAX_RATIO`, `TAINT_MODE=on-untrusted-source` | `aiperator_untrusted_source_total`, `aiperator_indirect_injection_total` | `TODO(human)` |
| Testing, surveillance and monitoring | Prometheus metrics, OpenTelemetry traces and structured logs on all four services, with metric access separated from API access; SLO, cost-anomaly and posture alerting to a webhook ([Observability](../CAPABILITIES.md#observability)) | `METRICS_ENABLED`, `METRICS_AUTH`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `SLO_ALERT_WEBHOOK_URL`, `COST_ANOMALY_ENABLED` | The metric catalogue in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md); `GET /monitoring/flow-health` | `TODO(human)` |
| Logging and tamper evidence | Append-only, hash-chained audit log with periodic signed anchors, verifiable by a third party without a shared secret; pseudonymous subject identifiers so the record does not carry identifiers in the clear ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `AUDIT_ANCHOR_FILE`, `AUDIT_ANCHOR_SECRET`, `AUDIT_ANCHOR_INTERVAL_MS`, `AUDIT_PSEUDONYM_PEPPER` | `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file>`; chain verification inside the dossier | `TODO(human)` |
| Vulnerability and patch management | — no patch SLA, no advisory feed, no disclosure channel is defined here. Dependency currency is a release-engineering practice inside the project | — | [../../SECURITY.md](../../SECURITY.md) | `TODO(human)` |
| Secure development | Flows are validated against a JSON schema on load, and the flow reference in [../FLOWS.md](../FLOWS.md) is generated from the node catalog and checked in CI, so documentation cannot drift from the implementation. On top of that a release runs a bench of recorded conversations and can emit a signed receipt ([Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access), [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay)) | `bun run scripts/cli.ts flows release` (in `apps/runtime`), `check:flow-versions` | Signed release receipt, verified with `atf-verify --release-receipt <file> --jwks <url|file>` | `TODO(human)` |
| Availability, reliability, redundancy | Replicas declared as configuration, circuit breakers, failover chains, bounded queues that reject rather than degrade silently. No homogeneous-redundancy or geographic-redundancy concept exists ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `REPLICAS`, `FALLBACK_CHAIN`, `QUEUE_MAX_DEPTH` (Extract) | `aiperator_llm_fallbacks_total`, `aiperator_degraded_total`, `aiperator_queue_depth` | `TODO(human)` |
| Service level management | Flow-level service objectives with breach counters, plus budget and cost-anomaly alerts. No contractual SLA is defined by the software ([Observability](../CAPABILITIES.md#observability)) | `SLO_ALERT_WEBHOOK_URL`, `BUDGET_ALERT_THRESHOLDS`, `BUDGET_DAILY_PER_TENANT` | `aiperator_flow_slo_breach_total{flow_id,objective}` | `TODO(human)` |
| Termination, exit, interoperability and portability | Behaviour is files (flows, subflows, policy) and can be rebuilt from a repository; rollback is a file change; published flow definitions are comparable across versions. No data-export format standard and no vendor migration tooling ([Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access)) | `FLOWS_DIR` | `GET /flows/diff/compare?from=&to=`; Git history of flow files | `TODO(human)` |
| Physical and environmental security | — not covered. This belongs to the facility hosting the deployment | — | — | `TODO(human)` |

## 5. Gaps to plan for

- **No C5 attestation, audit report or provider-level assurance artefact exists**, and nothing in
  this repository should be submitted as one. An operator's auditor assesses the deployment and the
  organisation running it.
- **The catalogue's provider-side themes have no product answer**: ISMS, personnel, physical
  security, homogeneous and geographic redundancy, government engagement, contractual terms, exit
  assistance, service-level agreements. These rows are marked not covered on purpose.
- **Residency depends on metadata the operator supplies.** A *required but unknown* provider region
  is advisory rather than blocking, so a residency requirement is only as good as the region data
  and the egress allowlist. See [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence).
- **C5's language predates LLM systems.** Concepts such as prompt injection, tool authorization,
  retrieval poisoning and model failover do not appear in the catalogue; they map to
  "secure development", "network protection" and "monitoring" only loosely, and an operator should
  present them as such rather than as named controls.
- **Defaults are permissive.** Anchors, egress allowlists, guardrails, retention sweeps, tenant
  row-level security and the PII vault are off or warn-only outside a preset. Any statement about
  what is implemented must name the profile and preset it describes.

## See also

- [compliance/README.md](README.md) — scope, conventions, and why the reference column is empty
- [nis2.md](nis2.md) and [dora.md](dora.md) — the regulatory framings an operator in scope of C5
  usually has at the same time
- [../THREAT-MODEL.md](../THREAT-MODEL.md) — per-service threat model behind the operational rows
