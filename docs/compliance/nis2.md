<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# NIS2 (cybersecurity and incident reporting): which topics ATF serves and which it cannot

> **Draft mapping. Not legal advice. Clause references must be verified against the official text
> before use.**
>
> The *Reference* column is `TODO(human)` in every row by design; see
> [compliance/README.md](README.md) for why this mapping cannot be generated from the repository.
> Topic headings are paraphrases for orientation, not quotations, and carry no clause number.

## 1. Who NIS2 addresses, and where ATF sits

NIS2 binds **entities** in named sectors — essential and important entities — not the software they
buy. If an operator runs ATF for a sector in scope, the operator is the regulated party and ATF is
one of its network and information systems. Two consequences shape every row below:

- **ATF never has a duty; the operator does.** What ATF can do is make the duty *satisfiable with
  evidence*: an audit chain that survives a dispute, an access model that can be shown rather than
  described, a degradation signal that turns "we think it was running" into a measurement.
- **ATF is also a supplier in the operator's supply chain.** The third-party rows therefore describe
  what ATF hands upstream so the operator's own supplier assessment has something to consume, and
  say plainly where it does not — no certification, no attestation report, no supplier security
  questionnaire is produced by this repository.

The AI-specific topic (security policy for AI as part of the risk-measure set) is the one where the
platform's own guardrails are directly on point, so it gets its own row rather than being folded
into generic access control.

## Capability areas cited in this mapping

Every ATF control named in the tables below is documented in one of these sections of
[../CAPABILITIES.md](../CAPABILITIES.md).

| Capability area | Controls cited in this file |
| --- | --- |
| [Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity) | JWT verification with issuer-to-tenant binding, operator roles, pseudonymous audit identifiers |
| [Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety) | input guardrails, injection detection, taint propagation across services, sandboxing with network off by default |
| [Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control) | bounded queues, checkpointed runs, shared rate-limit state, per-run budgets |
| [Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access) | flows, providers and models as versioned configuration; the executed flow revision is identifiable in the run record |
| [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay) | bench-gated flow releases with signed receipts |
| [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | policy as code, tamper-evident hash-chained audit log with signed anchors, compliance dossier and posture report |
| [Governed tool and data access](../CAPABILITIES.md#governed-tool-and-data-access) | fail-closed tool authorization, egress allowlists, callback and SSRF defences |
| [Privacy and the PII vault](../CAPABILITIES.md#privacy-and-the-pii-vault) | placeholder substitution before the provider call, output-side redaction, subject erasure |
| [Operator interface](../CAPABILITIES.md#operator-interface) | posture and inventory views, `atf-doctor` |
| [Observability](../CAPABILITIES.md#observability) | metrics and traces, alerting on SLOs, cost anomalies and posture, degradation and fail-open counters, offline configuration preflight |

## 2. Governance and risk management

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Approval of and accountability for cybersecurity risk measures by the management body | — not covered; a product cannot convene a governing body. ATF's role is to make the effect of approved measures verifiable at a point in time, so an approval has an observable consequence | `ATF_PROFILE`, `ATF_PRESET` | `GET /monitoring/posture` — which controls are active, as ok/warn/fail, with the production-gate result | `TODO(human)` |
| Implementation of appropriate and proportionate technical and organisational measures | Production-readiness gates refuse an unsafe configuration instead of warning about it, and the whole measure set is one setting rather than forty remembered ones ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `ATF_PROFILE=production`, `ATF_PRESET=regulated` / `regulated-multitenant` | Gate output at startup; `GET /monitoring/posture`; offline preflight `bun run atf-doctor --service runtime\|search\|extract\|gate` | `TODO(human)` |
| Cybersecurity risk management approach | A documented STRIDE model per service, an attack suite that runs on a schedule, and a posture value tracked over time — the three inputs a risk process needs from a system ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `RED_TEAM_ENABLED`, `RED_TEAM_INTERVAL_MS`, `RED_TEAM_POSTURE_ALERT_THRESHOLD` | [../THREAT-MODEL.md](../THREAT-MODEL.md); security-posture section of `GET /admin/compliance/dossier` | `TODO(human)` |
| Basic cyber hygiene and security training | — not covered as training. The hygiene the platform enforces itself is named in the rows below: least privilege, secret scrubbing, no credential inheritance in sandboxes, loopback-only control surfaces | `PLUGINS_SANDBOX`, `BYOK_ENABLED`, `_FILE` secret variants (Outpost) | Posture report; [../runbooks/key-rotation.md](../runbooks/key-rotation.md) | `TODO(human)` |
| Policy on the security of supply chain | Which external destinations are reachable is enforced configuration rather than convention: the egress guard rejects private and link-local ranges per request and takes an optional destination allow-list. Every fallback model stays inside the flow's compliance accounting ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety), [Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `EGRESS_ALLOWED_HOSTS`, `PROVIDERS`, `CALLBACK_ALLOWED_HOSTS` (Extract) | Active policy in the dossier; `aiperator_llm_calls_total` by provider and model | `TODO(human)` |
| Security of acquisition, development and maintenance of ICT products | Flows are files under version control, validated against a schema on load, with CI refusing a flow change without a version bump; a release is gated on a bench of recorded conversations and can carry a signed receipt ([Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access), [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay)) | `FLOWS_DIR`, `check:flow-versions`, `bun run scripts/cli.ts flows release` (in `apps/runtime`) | `flow_version`, `flow_digest`, `subflow_versions[]` in the debug trace; signed release receipt verified offline | `TODO(human)` |
| Vulnerability disclosure and remediation policies | — no PSIRT, no advisory feed, no disclosure channel is defined by this repository. Dependency remediation is a release-engineering practice inside the project, not a published process | — | — | `TODO(human)` |
| Incident-response management | An incident runbook organized by severity, with first-15-minutes steps, investigation aids, named evidence paths and specific procedures for a compromised signing key or leaked tokens ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | — | [../runbooks/incident.md](../runbooks/incident.md); audit log as the reconstruction source | `TODO(human)` |
| Business continuity and crisis management | Long runs survive a restart via checkpoints, queue depth and flow-load failures are metrics rather than surprises, and shared rate-limit state keeps throttling correct across replicas ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `CHECKPOINTING_ENABLED`, `RATE_LIMIT_REDIS_URL`, `REPLICAS` | `aiperator_queue_depth`, `aiperator_flow_load_failures`, `aiperator_active_executions`; [../runbooks/redis-outage.md](../runbooks/redis-outage.md), [../runbooks/backup-restore.md](../runbooks/backup-restore.md), [../runbooks/scaling.md](../runbooks/scaling.md) | `TODO(human)` |
| Backup management | Documented, with what to back up and how a restore is verified; the platform does not schedule backups itself ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | — | [../runbooks/backup-restore.md](../runbooks/backup-restore.md) | `TODO(human)` |
| Use of cryptography | Ed25519 for evidence, anchors and receipts, verified by an algorithm field that never silently falls back; encrypted at-rest storage for tenant keys and the vault mapping; TLS and optional client certificates on the internal services ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `EVIDENCE_SIGNING_KEY`, `RECEIPT_SIGNING_KEY`, `BYOK_ENCRYPTION_KEY`, `PII_VAULT_ENCRYPTION_KEY`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_CLIENT_CA_FILE` | `GET /.well-known/atf-evidence-jwks.json`, `GET /.well-known/atf-receipt-jwks.json`; `bun run scripts/cli.ts verify-bundle` | `TODO(human)` |
| Security of AI-based systems | Guardrails on the way in, validation of what comes back from tools and retrieval, taint propagation across services, approval for consequential writes after an injection finding, and sandboxing for generated code and plugins ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `INPUT_GUARDRAILS_ENABLED`, `TOOL_OUTPUT_VALIDATOR_ENABLED`, `TAINT_MODE=on-untrusted-source`, `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`, `SANDBOX_ENABLED`, `SANDBOX_NETWORK_ENABLED` | `aiperator_input_guardrail_total`, `aiperator_indirect_injection_total`, `aiperator_taint_approvals_total`, `aiperator_tool_egress_findings_total` | `TODO(human)` |

## 3. Access, identity and asset topics

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Access control | Policy-based tool authorization that fails closed, RBAC for the operator plane mapped from token claims, and scopes that change what a tool exposes rather than only whether it runs ([Governed tool and data access](../CAPABILITIES.md#governed-tool-and-data-access)) | `TOOL_AUTHZ_FAIL_CLOSED`, `OPERATOR_ROLE_CLAIM`, `OPERATOR_ROLE_MAP`, `monitoring.oidc.requiredGroups` | Audit entries per authorization outcome; `GET /monitoring/posture` | `TODO(human)` |
| Identity assurance and multi-issuer trust | JWT with JWKS verification, multiple issuers, audience checks, and a binding that limits which tenants a given issuer may claim; identity headers are honoured only from configured sources ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `AUTHN_MODE`, `JWT_*`, `JWT_ISSUER_TENANTS`, `TRUSTED_IDENTITY_HEADERS`, `STRICT_IDENTITY_HEADERS` | Authentication failures: `mcpgate_auth_failures_total`; request rejections by reason: `aiperator_requests_rejected_total` | `TODO(human)` |
| Masking / pseudonymisation of personal data | A peppered pseudonym is used for audit identifiers, so the accountability record does not carry the identifier in the clear, and the vault replaces detected personal data before the provider call ([Privacy and the PII vault](../CAPABILITIES.md#privacy-and-the-pii-vault)) | `AUDIT_PSEUDONYM_PEPPER`, `PII_VAULT_ENABLED`, `API_KEY_PEPPER` | Erasure receipts carry pseudonymous hashes only; `aiperator_pii_vault_tokens_total` | `TODO(human)` |
| Asset management | Every model, provider, MCP server, tool and flow is declared configuration, and the flow registry shows what is actually running with its cost and run statistics ([Operator interface](../CAPABILITIES.md#operator-interface), [Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access)) | `PROVIDERS`, `FLOWS_DIR`, tool definitions in Gate | `GET /monitoring/flow-stats?since=`, `GET /monitoring/posture`, provider and pool health in Control | `TODO(human)` |
| Network and system security | Per-service boundaries with separate ports and credential types, split credentials between machine and session surfaces on Extract, loopback-only binding for the desktop sidecar, and SSRF defences on callbacks ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `CALLBACK_ALLOWED_HOSTS`, `TLS_*`, `CONTROL_SESSION_MODE=bff`, `CONTROL_PUBLIC_ORIGIN` | [../THREAT-MODEL.md](../THREAT-MODEL.md) | `TODO(human)` |
| Encryption of data in transit and at rest | HTTPS and client-certificate verification on Search and Extract; encrypted storage for BYOK keys, refresh tokens and the vault mapping, with AAD-bound re-encryption for delegated credentials ([Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity)) | `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_CLIENT_CA_FILE`, `BYOK_ENCRYPTION_KEY`, `PII_VAULT_ENCRYPTION_KEY` | Configuration audit via `atf-doctor`; [../runbooks/transaction-token-rotation.md](../runbooks/transaction-token-rotation.md) | `TODO(human)` |
| Human-resource security, screening, sanctions | — not covered; personnel security is organisational | — | — | `TODO(human)` |

## 4. Early warning, incident notification and cooperation

This is where a runtime matters most and where it must be most careful about what it claims. ATF can
produce the *content* of a notification quickly; it cannot file one, and it does not know which
events are notifiable — that judgement is the operator's, in their sector.

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Early warning and detection | Alerting on SLOs, on cost anomalies, on red-team posture, and on flow-level service objectives; degradation and fail-open events are counters, so a control that stopped protecting is visible ([Observability](../CAPABILITIES.md#observability)) | `SLO_ALERT_WEBHOOK_URL`, `COST_ANOMALY_ENABLED`, `RED_TEAM_POSTURE_ALERT_THRESHOLD`, `RED_TEAM_ALERT_WEBHOOK_URL`, `BUDGET_ALERT_WEBHOOK_URL` | `aiperator_flow_slo_breach_total{flow_id,objective}`, `aiperator_degraded_total`, `aiperator_audit_write_failures_total`, `aiperator_policy_stale_total`; `GET /monitoring/flow-health` | `TODO(human)` |
| Incident notification to the competent authority, on short deadlines | ATF supplies the facts a notification is written from — what was deployed, which flow version and digest, who approved what, which tenant and subject are involved, when — from an append-only chained log rather than from reconstructing it afterwards ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | — | Audit export and chain verification; `GET /monitoring/debug/:executionId`; `GET /monitoring/explain/{executionId}`; [../runbooks/incident.md](../runbooks/incident.md) | `TODO(human)` |
| Which events count as significant | — not decided by the product. The severity model in the runbook is an operational triage aid, not a mapping to a notifiability threshold | — | — | `TODO(human)` |
| Post-incident reporting and follow-up | Evidence for the final report is durable and independently verifiable: signed anchors survive the platform, and bundles tie an execution to its inputs, decisions, sources and outputs ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `AUDIT_ANCHOR_FILE`, `EVIDENCE_SIGNING_KEY` | `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file>`; [../adr/0026-audit-hash-chain-and-signed-anchors.md](../adr/0026-audit-hash-chain-and-signed-anchors.md), [../adr/0030-asymmetric-evidence-chain-ed25519.md](../adr/0030-asymmetric-evidence-chain-ed25519.md) | `TODO(human)` |
| Cooperation and peer sharing | — no information-sharing mechanism. Artefacts are verifiable offline, which is the precondition for sharing evidence with a peer or an authority without sharing a secret | `EVIDENCE_SIGNING_KEY` | The public JWKS endpoints | `TODO(human)` |
| Jurisdiction and registration for non-EU providers | — not covered; this is a question about the vendor of the software, not about its features | — | — | `TODO(human)` |

## 5. What an assessor is likely to ask for, and where it is

| Question | Artefact |
| --- | --- |
| Which controls are active in this deployment, right now | `GET /monitoring/posture` (or `cli.ts posture`) — ok/warn/fail per control plus the production-gate result |
| Prove it without starting anything | `bun run atf-doctor --service runtime\|search\|extract\|gate` — offline check of an environment file, never printing a value |
| Who did what, and can the record be trusted | Append-only hash-chained audit log with signed anchors; chain verification result inside `GET /admin/compliance/dossier` |
| What changed and when | `flow_version`, `flow_digest`, `subflow_versions[]` per execution; flow publishing is an audited action |
| Where is data kept and for how long | The retention table in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md), store by store, with the setting and whether erasure removes it |
| What third-party code is in the shipped artifact | [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md), [../../sbom.cdx.json](../../sbom.cdx.json), [../IMAGE-LICENSES.md](../IMAGE-LICENSES.md) |
| What are the known threats and what mitigates them | [../THREAT-MODEL.md](../THREAT-MODEL.md) per service, plus the red-team posture trend |
| How is a security incident handled | [../runbooks/incident.md](../runbooks/incident.md), including signing-key compromise and token leakage |

## 6. Gaps to plan for

- **No certification, attestation or audit report** exists for ATF, and no supplier questionnaire is
  answered by this repository. An operator's supplier assessment has to be answered by the vendor
  relationship, not by these files.
- **No vulnerability disclosure channel, security advisory feed, or published SLA for remediation.**
  [../../SECURITY.md](../../SECURITY.md) is the entry point in the repository; a NIS2-style
  disclosure policy is a document the operator may have to hold themselves.
- **No notifiability determination.** Which incident reaches an authority, and how fast, is outside
  the product; the runbook's severities are operational, not legal.
- **Defaults are permissive on purpose.** Retention sweeps, audit anchors, egress allowlists, input
  guardrails and the PII vault are off or warn-only outside a preset. A NIS2 audit against default
  settings finds the settings, not the code.
- **Personnel, training and governance** are entirely the operator's; nothing here discharges them.
- **Backup is documented, not performed.** No scheduler, no verified restore automation.

## See also

- [compliance/README.md](README.md) — scope, conventions, and why the reference column is empty
- [dora.md](dora.md) — the same operational topics with testing and third-party duties sharpened
- [../THREAT-MODEL.md](../THREAT-MODEL.md) — the STRIDE model behind the risk rows
