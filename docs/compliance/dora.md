<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# DORA (digital operational resilience): which topics ATF serves and which it cannot

> **Draft mapping. Not legal advice. Clause references must be verified against the official text
> before use.**
>
> The *Reference* column is `TODO(human)` in every row by design; see
> [compliance/README.md](README.md) for why this mapping cannot be generated from the repository.
> Topic headings are paraphrases for orientation, not quotations, and carry no clause number.

## 1. Who DORA addresses, and what an AI runtime is inside it

DORA binds **financial entities** and, through them, their ICT service providers. An ATF deployment
inside a bank, insurer or fintech is an ICT system supporting functions of that entity; the entity
carries the obligations and must be able to show, on request, how the system is governed, how it
behaves under stress, what happens when it fails, and how it can be left.

Two framings keep this mapping honest:

- **DORA is about continuity under stress, not about capability.** The interesting questions are
  what a system does when its model provider is down, when a queue fills, when a run is killed
  mid-flight, and whether an operator can prove any of it after the fact. ATF has real answers to
  several of those and none to the governance ones.
- **DORA is explicit about third parties**, including a register of information and exit planning.
  An AI runtime is usually where a concentration risk lives, because one vendor's model sits behind
  every answer. The provider rows below are the technical substrate for that discussion; the
  contractual and register obligations are the operator's.

## Capability areas cited in this mapping

Every ATF control named in the tables below is documented in one of these sections of
[../CAPABILITIES.md](../CAPABILITIES.md). A row that begins with `—` names no capability: it either
rests on a build artefact CAPABILITIES.md does not cover, or on something ATF does not do.

| Capability area | Controls cited in this file |
| --- | --- |
| [Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety) | input guardrails, tool output validation, taint propagation, sandboxing |
| [Operator interface](../CAPABILITIES.md#operator-interface) | flow registry with per-flow run and cost statistics, server-side session and per-request CSP nonce |
| [Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access) | flows, providers and models as versioned configuration; the executed flow revision is identifiable in the run record |
| [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | policy as code, provider and region admission, tamper-evident audit log with signed anchors, compliance dossier and posture report |
| [Observability](../CAPABILITIES.md#observability) | metrics and traces, SLO and posture alerting, degradation counters, flow health and statistics endpoints |
| [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay) | eval runs with a judge model, groundedness, replay, bench-gated flow releases with signed receipts |
| [Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control) | failover chains, circuit breakers, bounded queues, checkpointed runs, cost anomaly detection |

## 2. ICT risk management and governance

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| ICT risk management framework | A documented threat model per service, a scheduled attack suite with a scored posture, and a production-readiness gate that refuses an unsafe configuration instead of warning about it ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `RED_TEAM_ENABLED`, `RED_TEAM_INTERVAL_MS`, `ATF_PROFILE=production` | [../THREAT-MODEL.md](../THREAT-MODEL.md); `GET /monitoring/posture`; the security-posture section of `GET /admin/compliance/dossier` | `TODO(human)` |
| Management body responsibility, oversight, control functions | — not covered. No governance bodies, no three-lines model, no separation between risk and operation is a product feature | — | — | `TODO(human)` |
| Inventory of ICT systems and supporting assets | Flows, providers, models, tools and MCP servers are declarative configuration, and the registry shows what is actually loaded with per-flow run and cost statistics ([Operator interface](../CAPABILITIES.md#operator-interface), [Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access)) | `FLOWS_DIR`, `PROVIDERS` | `GET /monitoring/flow-stats?since=`, `GET /monitoring/posture`, provider and pool health in Control | `TODO(human)` |
| Mapping of functions and dependencies | Each run records the model, provider, flow version and digest, tools used, and policy decisions, so a function's dependency on a given model or tool is reconstructible per execution rather than asserted from an architecture diagram ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | — | `GET /monitoring/debug/:executionId`; `GET /monitoring/explain/{executionId}` | `TODO(human)` |
| Layered security and access control | Policy-based tool authorization failing closed, RBAC for the operator plane, separate credential types per surface, split upload/processing credentials, loopback-only desktop sidecar, SSRF defences on callbacks ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `TOOL_AUTHZ_FAIL_CLOSED`, `OPERATOR_ROLE_CLAIM`, `EGRESS_ALLOWED_HOSTS`, `CALLBACK_ALLOWED_HOSTS`, `TLS_*` | [../THREAT-MODEL.md](../THREAT-MODEL.md); audit log per authorization outcome | `TODO(human)` |
| Security policy including AI-related security | Guardrails in, tool and retrieval output validation, taint propagation across services, approval for consequential writes after an injection finding, sandboxing with network off by default ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `INPUT_GUARDRAILS_ENABLED`, `TOOL_OUTPUT_VALIDATOR_ENABLED`, `TAINT_MODE`, `SANDBOX_ENABLED`, `SANDBOX_NETWORK_ENABLED` | `aiperator_input_guardrail_total`, `aiperator_indirect_injection_total`, `aiperator_taint_approvals_total` | `TODO(human)` |

## 3. Incident management, classification and reporting

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| ICT incident management capability | Failures that would otherwise be invisible are counters — degraded components, audit write failures, stale policy, rejected requests, queue depth — so "the control silently stopped working" is a detectable event class rather than a later discovery ([Observability](../CAPABILITIES.md#observability)) | — | `aiperator_degraded_total`, `aiperator_audit_write_failures_total`, `aiperator_policy_stale_total`, `aiperator_requests_rejected_total`, `aiperator_queue_depth` | `TODO(human)` |
| Classification of incidents by severity and materiality | The incident runbook has a severity model with first-15-minutes steps and specific procedures for a compromised signing key or leaked tokens. It is operational triage; materiality against a regulatory threshold is the operator's call ([Observability](../CAPABILITIES.md#observability)) | — | [../runbooks/incident.md](../runbooks/incident.md) | `TODO(human)` |
| Reporting of major ICT-related incidents to the authority | ATF supplies the content: what was deployed, which flow version and digest, who approved what, which tenant and subject, and when — from an append-only hash-chained log with periodic signed anchors that a third party can verify without a shared secret ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `AUDIT_ANCHOR_FILE`, `EVIDENCE_SIGNING_KEY` | `GET /.well-known/atf-evidence-jwks.json`; `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file>` | `TODO(human)` |
| Tracking and register of incidents, root-cause analysis, follow-up | — no incident register, no case management. The audit log and debug traces are the evidence a register entry is written from | — | `GET /monitoring/history`, `GET /monitoring/debug/:executionId` | `TODO(human)` |
| Alerting that an incident is happening | Alerts on SLOs, cost anomalies, red-team posture, and flow-level objectives, delivered to a webhook ([Observability](../CAPABILITIES.md#observability)) | `SLO_ALERT_WEBHOOK_URL`, `COST_ANOMALY_ENABLED`, `RED_TEAM_POSTURE_ALERT_THRESHOLD`, `BUDGET_ALERT_THRESHOLDS` | `aiperator_flow_slo_breach_total{flow_id,objective}`; alert history in the delivery channel configured by the operator | `TODO(human)` |

## 4. Digital operational resilience testing

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Regular, independent testing of ICT systems | An automated attack suite runs on an interval against configured flows, scores results with a judge model, and trends the posture. Automated, repeatable, and not independent — an internal suite is not an external test ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `RED_TEAM_ENABLED`, `RED_TEAM_INTERVAL_MS`, `RED_TEAM_POSTURE_ALERT_THRESHOLD`, [../adr/0010-continuous-automated-red-teaming.md](../adr/0010-continuous-automated-red-teaming.md) | Red-team run history; security-posture section of the dossier | `TODO(human)` |
| Performance, capacity and stress testing | Partial: the retrieval evaluation carries latency budgets (`p50_latency_ms`, `p95_latency_ms` as must-not-exceed thresholds) over a fixed corpus, so retrieval performance is comparable across endpoints and runs. There is no load or soak test, and no throughput benchmark for the model gateway ([Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay)) | golden-set thresholds in `scripts/eval/README.md` | `GET /monitoring/flow-stats?since=`, latency histograms listed in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) | `TODO(human)` |
| Threat-led penetration testing | — not covered. TLPT requires a threat-intelligence-led live exercise with an external team, real systems and a regulator-accepted scope. Nothing here substitutes | — | — | `TODO(human)` |
| Testing that behaviour did not regress | A release runs a bench of recorded conversations and refuses a pass-rate regression; it can also emit a signed receipt over the flow and bench digest, so a tested state is provable later ([Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay)) | `bun run scripts/cli.ts flows release` (in `apps/runtime`), `flows/bench/<flowId>.bench.yaml` | Ed25519-signed release receipt, verified with `atf-verify --release-receipt <file> --jwks <url|file>` | `TODO(human)` |
| Quality assurance on model behaviour | Eval runs with a judge model, groundedness scoring of answers against retrieved sources, and extraction-quality metrics over a golden set ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `GROUNDEDNESS_ENABLED`, `GROUNDEDNESS_MODE`, `GROUNDEDNESS_PASS_THRESHOLD` | `aiperator_groundedness_total` by result; `bun run eval:groundedness`, `bun run eval:retrieval`, `bun run eval:extract-quality` | `TODO(human)` |

## 5. ICT third-party risk, concentration, and exit

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Register of information on contractual arrangements | — not covered. A contractual register is a document of the entity. ATF's contribution is that the technical dependency set is configuration and therefore enumerable | `PROVIDERS`, `EGRESS_ALLOWED_HOSTS` | Provider/pool inventory in Control; `aiperator_llm_calls_total` by provider and model | `TODO(human)` |
| Risk assessment before contracting and ongoing monitoring | Provider health, pool health and per-provider latency/error/cost are measured continuously, so a third party's behaviour is monitored rather than assumed ([Observability](../CAPABILITIES.md#observability)) | `PROVIDERS`, `FALLBACK_CHAIN` | `aiperator_llm_errors_total`, `aiperator_llm_fallbacks_total`, provider health panels | `TODO(human)` |
| Concentration risk on a third-country provider | Two mechanisms matter: a failover chain across pool members so one provider's outage is survivable, and a regional restriction in the compliance policy that can block a provider outright. Both are policy, and both are auditable — with one caveat worth knowing: a *known* disallowed region blocks, while a required but unknown provider region is advisory only, so residency as a hard requirement needs region metadata supplied | `FALLBACK_CHAIN`, `PROVIDERS`, provider/data rules in `compliance-policy.yaml`, `EGRESS_ALLOWED_HOSTS` | `GET /admin/compliance-policy`; the active policy inside the dossier; see [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | `TODO(human)` |
| Exit strategy, reversibility and portability | Behaviour is files: flows, subflows and the compliance policy live in `FLOWS_DIR`. Rollback is a file change; a deployment can be rebuilt from a repository rather than an interface. No migration tooling exists to move an operator off a specific model vendor's formats ([Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access)) | `FLOWS_DIR` | Git history of flow files; `GET /flows/diff/compare?from=&to=` | `TODO(human)` |
| Supply-chain security of the software itself | — no CAPABILITIES.md citation: this is build output, not a control the runtime enforces. A dependency tree with licences and an SBOM is produced for the shipped artifact's platform, and a release-time check verifies that internal material is absent from it | `bun run supply-chain`, `bun run verify:public:release` | [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md), [../../sbom.cdx.json](../../sbom.cdx.json) | `TODO(human)` |
| Full access, audit and termination rights in provider contracts | — contractual, not technical. What can be handed to an auditor is verifiable evidence artefacts | — | JWKS endpoints, signed bundles and receipts | `TODO(human)` |
| Information-sharing arrangements | — no sharing mechanism exists. Offline verifiability of evidence is the precondition for sharing it without sharing a secret | — | `atf-verify` | `TODO(human)` |

## 6. Business continuity, availability, and recovery

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| ICT business continuity policy and disaster recovery plan | — the plan is the operator's document. ATF's contribution is that recovery is described and rehearsed in runbooks, and that long runs survive a restart | `CHECKPOINTING_ENABLED` | [../runbooks/backup-restore.md](../runbooks/backup-restore.md), [../runbooks/redis-outage.md](../runbooks/redis-outage.md), [../runbooks/scaling.md](../runbooks/scaling.md) | `TODO(human)` |
| Backup and restore, with regular testing | Documented, including what to back up and how a restore is verified. No scheduler and no automated restore test ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | — | [../runbooks/backup-restore.md](../runbooks/backup-restore.md) | `TODO(human)` |
| Availability, scalability and elasticity | Horizontal scaling with per-replica circuit breakers, Redis-backed shared rate limiting so throttling stays correct across replicas, bounded queues that reject rather than melt, and replicas declared as configuration ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `REPLICAS`, `RATE_LIMIT_REDIS_URL`, `QUEUE_MAX_DEPTH` (Extract) | `aiperator_queue_depth`, `aiperator_active_executions`, `aiperator_requests_rejected_total{reason="queue_full"}` | `TODO(human)` |
| Integrity and availability of data | The audit log is append-only and hash-chained with signed anchors and is deliberately outside deletion and retention sweeps; other stores have explicit, per-store retention ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `RETENTION_ENABLED`, `RETENTION_MAX_AGE_DAYS`, `REVISION_TTL` (Search), `JOB_RETENTION_DAYS` (Extract) | Chain verification result inside the dossier; the retention table in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) | `TODO(human)` |
| Minimum functions and continuity under partial failure | Degradation is designed and measured rather than accidental: failover chains, circuit breakers, model fallback counted as degradation, and a posture report that says which controls are weak right now ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `FALLBACK_CHAIN`, `PII_DETECTOR_FAIL_MODE`, `INPUT_GUARDRAIL_MODEL_FAIL_MODE` | `aiperator_degraded_total` by component, `GET /monitoring/posture` | `TODO(human)` |
| Recovery time and continuity testing | — no RTO/RPO is defined by this repository, and no continuity test is automated. The runbooks give procedure, not a proven time | — | — | `TODO(human)` |

## 7. Gaps to plan for

- **Governance is absent.** Management-body responsibility, control functions, risk committees and
  the annual reporting around them are not product features and cannot be bought with a licence.
- **No independent testing.** The red-team suite is automated and internal; TLPT and external
  penetration testing are outside this repository. An operator's testing programme has to supply
  independence itself.
- **No incident register, no reporting mechanism, no notifiability rules.** DORA's reporting is a
  process obligation; ATF supplies evidence for it, not the filing.
- **No contractual artefacts**: no register of information, no exit-plan template, no standard
  contractual clauses, no outsourced-arrangement classification.
- **No RTO/RPO, no continuity test, no backup automation.** Recovery is documented and manual.
- **Defaults are permissive.** Anchors, egress allowlists, guardrails, retention sweeps and the PII
  vault are off or warn-only outside a preset, so an assessment has to state which preset and which
  profile it describes.

## See also

- [compliance/README.md](README.md) — scope, conventions, and why the reference column is empty
- [nis2.md](nis2.md) — the broader security-of-network-and-information-systems topics
- [bsi-c5.md](bsi-c5.md) — the cloud-controls catalogue, which is the closest thing to a checklist
  an operator can be assessed against in Germany
