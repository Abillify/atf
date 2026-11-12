<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# ISO/IEC 42001 (AI management system): which topics ATF serves and which it cannot

> **Draft mapping. Not legal advice. Clause references must be verified against the official text
> before use.**
>
> The *Reference* column is `TODO(human)` in every row by design; see
> [compliance/README.md](README.md) for why this mapping cannot be generated from the repository.
> Topic headings are paraphrases for orientation, not quotations, and carry no clause number.
> Companion: [../EU-AI-ACT.md](../EU-AI-ACT.md) for the legal obligations,
> [../CAPABILITIES.md](../CAPABILITIES.md) for what the controls actually do.

## Capability areas cited in this mapping

Every ATF control named in the tables below is documented in one of these sections of
[../CAPABILITIES.md](../CAPABILITIES.md). This is where the mapping's provenance lives; the
*Configuration* and *Evidence* columns then say which setting or artefact makes it checkable. A row
that begins with `—` names no capability: it either rests on a build artefact CAPABILITIES.md does
not cover, or on something ATF does not do.

| Capability area | Controls cited in this file |
| --- | --- |
| [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | policy as code and its activation boundary, tamper-evident audit log with signed anchors, compliance dossier, provider and region admission |
| [Human-in-the-loop approvals](../CAPABILITIES.md#human-in-the-loop-approvals) | separate-approver rule, approver scope, approval gate for consequential actions |
| [Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity) | operator roles from token claims, verified identity for approval decisions, issuer-to-tenant binding |
| [Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety) | input and output guardrails, injection detection, taint propagation, sandboxing |
| [Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access) | flows, providers and models as versioned configuration; the executed flow revision is identifiable in the run record |
| [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay) | eval runs with a judge model, groundedness scoring, shadow comparison, replay, bench-gated flow releases with signed receipts |
| [Document extraction](../CAPABILITIES.md#document-extraction) | per-page fidelity checks, truncation ladder, empty-page warnings |
| [Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control) | per-run budgets, tool-loop guard, queue limits, failover chains |
| [Privacy and the PII vault](../CAPABILITIES.md#privacy-and-the-pii-vault) | placeholder tokenization before the provider call, output-side redaction, the vault's documented reach |
| [Observability](../CAPABILITIES.md#observability) | posture report, per-execution debug traces, metrics and traces, degradation and fail-open counters |

## 1. Why this standard is a different kind of exercise

ISO/IEC 42001 certifies a **management system** — the set of policies, roles, processes and records
an organisation runs its AI activity with. It does not certify a product, and ATF is a product. So
for every topic the honest first question is who owns it:

| Owner | Character of the topic | Example |
| --- | --- | --- |
| Organisation only | governance, leadership, resources, competence, internal audit, management review | "an AI policy exists, is approved, and is communicated" |
| Organisation, with ATF as an instrument | processes that a runtime can make auditable but not decide | risk treatment: the decision is the operator's, the evidence of what was enforced is ATF's |
| ATF, largely | technical records and enforcement that the standard expects to exist somewhere | tamper-evident logging, retention, access control, change control over AI behaviour |

A certification body will ask the operator for documents in the first two rows. ATF's contribution
there is to make those documents **provable rather than asserted**: the posture report, the audit
chain, the flow version in a trace. Where a topic is purely organisational, this document says so
instead of pointing at a feature that does not discharge it.

## 2. Management-system topics

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| AI policy and objectives | — the policy is a document of the operating organisation. ATF can *enforce* a machine-readable subset of it, which is what makes policy-as-code useful: model allow/block, provider and data-class rules, approval requirements, retention and audit rules | `compliance-policy.yaml` in `FLOWS_DIR`, `COMPLIANCE_POLICY_REQUIRED=true`, [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence) | `GET /admin/compliance-policy` (loaded policy, `loadError`, `stale`, `blocked`); the policy text is embedded in the compliance dossier | `TODO(human)` |
| Roles, responsibilities and accountability | Separation of duties that the platform can actually enforce: an approval cannot be resolved by whoever requested it, and the resolver comes from the verified identity, never a client label. Everything else (naming an AI governance owner, a management representative) is organisational | `policies.approval.requireDifferentApprover`, `policies.approval.approverScope`, `OPERATOR_ROLE_CLAIM`, `OPERATOR_ROLE_MAP`, [Human-in-the-loop approvals](../CAPABILITIES.md#human-in-the-loop-approvals), [Multi-tenancy and identity](../CAPABILITIES.md#multi-tenancy-and-identity) | Audit entries per approval decision with `actor`, `target`, `outcome`; `aiperator_approvals_total` | `TODO(human)` |
| Resources for AI systems (data, tools, compute, human) | — inventory of what a flow consumes exists per flow and per run (models, providers, tools, data classes, cost, tokens), which is the technical half of a resource statement | `PROVIDERS`, flow `dataClasses`, `budgets` | `GET /monitoring/flow-stats?since=`, FinOps panels, cost and token metrics in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) | `TODO(human)` |
| Competence and awareness of staff | — not covered. Training records are organisational artefacts. The operator interface is bilingual, which helps and is not competence | — | — | `TODO(human)` |
| Communication, internal and external | Machine-readable signalling exists for the technical layer — an AI-generated marker on successful responses, and untrusted-content labels that survive the hop between services. Communication *to affected people* is the operator's channel ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `AI_DISCLOSURE=header\|field`, `TAINT_MODE=on-untrusted-source` | The response header or field itself; `aiperator_untrusted_source_total` | `TODO(human)` |
| Documented information and record control | Flows are files under version control and change without a restart; the executed revision is identifiable in the run record, so a document and an execution can be tied together. Documentation generation is checked in CI, so the reference cannot silently drift from the code ([Orchestration and model access](../CAPABILITIES.md#orchestration-and-model-access), [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `FLOWS_DIR`, flow `metadata.version`, `check:flow-versions` in CI | `flow_version`, `flow_digest`, `subflow_versions[]` in the execution debug trace; `GET /monitoring/debug/:executionId` | `TODO(human)` |
| Planning of changes | Change control over AI behaviour is a gate, not a convention: a release runs a bench of recorded conversations, refuses a pass-rate regression, and can emit a signed receipt over the flow and bench digest ([Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay)) | `bun run scripts/cli.ts flows release` (in `apps/runtime`), bench file `flows/bench/<flowId>.bench.yaml` | Ed25519-signed release receipt, verified offline with `atf-verify --release-receipt <file> --jwks <url|file>` | `TODO(human)` |
| Life cycle of AI systems | Staged change paths are implemented: canary on a traffic fraction, shadow on sampled production traffic with both answers judged, replay of an earlier execution, rollback. Side effects are suppressed in the comparison paths, so shadowing a flow cannot double-execute a write | `shadow.yaml` (`samplingRate`), `REPLAY_ENABLED`, [Quality: evaluation, canary, shadow, replay](../CAPABILITIES.md#quality-evaluation-canary-shadow-replay) | Shadow comparison and canary status in Control; eval run history | `TODO(human)` |
| Continuous improvement | A self-optimizing loop exists and is explicitly bounded, which is the part the standard cares about: drift guard, per-window promotion cap, optional human approval for any automated promotion ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `OPTIMIZER_ENABLED`, `AUTOPILOT_MAX_AUTO_PROMOTIONS_PER_WINDOW`, `AUTOPILOT_DRIFT_WINDOW_MS`, `AUTOPILOT_REQUIRE_APPROVAL`, [../adr/0008-autopilot-governance-human-approval-and-drift-guard.md](../adr/0008-autopilot-governance-human-approval-and-drift-guard.md) | Autopilot state and run history in Control; `autopilot_runs` retention target | `TODO(human)` |

## 3. Risk and impact topics

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| AI risk assessment | A scheduled attack suite probes configured flows and scores the results with a judge model, producing a posture value over time. This is an input to a risk assessment, not one: it tests the attack surface it was given ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `RED_TEAM_ENABLED`, `RED_TEAM_INTERVAL_MS`, `RED_TEAM_POSTURE_ALERT_THRESHOLD`, `RED_TEAM_ALERT_WEBHOOK_URL`, [../adr/0010-continuous-automated-red-teaming.md](../adr/0010-continuous-automated-red-teaming.md) | Security-posture section of the compliance dossier; red-team run history | `TODO(human)` |
| Risk treatment and controls | Authorization, approvals and guardrails are declarative and fail closed, which is what a treatment plan needs to be checkable: the question "is this control on" has one answer per deployment ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `TOOL_AUTHZ_FAIL_CLOSED`, `APPROVAL_GATE_ENABLED`, `APPROVAL_REQUIRE_TOOLS`, `INPUT_GUARDRAILS_ENABLED`, `OUTPUT_GUARDRAILS_ENABLED`, `TOOL_EGRESS_GUARDRAIL`, `ATF_PRESET=regulated` | `GET /monitoring/posture` scores each control ok/warn/fail; production gate result embedded | `TODO(human)` |
| Residual-risk acceptance | — the decision is a human one and is recorded by the operator. ATF records which controls were *not* active, which is the input to the decision | — | `GET /monitoring/posture`, `aiperator_degraded_total` for fail-open events | `TODO(human)` |
| AI impact assessment (individual, societal) | — no impact-assessment instrument. ATF supplies the technical inputs: which sources a given answer used, which model and version, which policy decisions | — | `GET /monitoring/explain/{executionId}` (explainability card, [../adr/0017-decision-provenance-explainability-card.md](../adr/0017-decision-provenance-explainability-card.md)); `GET /monitoring/citation-impact` for citation effect | `TODO(human)` |
| Data governance for AI systems | Retrieval corpora carry provenance (source digest, revision, collection access list), erasure works by reference or subject, and retention is a setting per store rather than a global default ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `RETENTION_ENABLED`, `RETENTION_MAX_AGE_DAYS`, `JOB_RETENTION_DAYS` (Extract), `REVISION_TTL` (Search), `STATS_RETENTION_DAYS` (Search) | Signed erasure receipts (`GET /v1/me/data/erasures/{id}`); the retention table in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) lists every store, default and whether erasure removes it | `TODO(human)` |
| Data quality | Extract reports quality per page instead of assuming it: a text layer that loses too many tokens is flagged (the check itself is always on, not a setting), a truncated model completion escalates through a token ladder and is counted, a page that cannot be completed becomes an empty page with a warning rather than a silent gap ([Document extraction](../CAPABILITIES.md#document-extraction)) | `VISION_MAX_TOKEN_VARIANTS`, `OCR_FALLBACK`, `MAX_PAGES` | `extract_text_fidelity_checks_total`, `extract_text_fidelity_divergences_total`, `extract_text_fidelity_missing_tokens_total`, `extract_vision_truncations_total`; `bun run eval:extract-quality` (CER, Heading-F1, table TEDS) | `TODO(human)` |
| Accuracy and reliability of outputs | Answers are scored against the retrieved sources, and quality is measured per dataset with a judge and repeatable assertions, so a threshold can be a gate rather than an opinion ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `GROUNDEDNESS_ENABLED`, `GROUNDEDNESS_MODE`, `GROUNDEDNESS_PASS_THRESHOLD` | `aiperator_groundedness_total` by result; eval run history in the dossier | `TODO(human)` |
| Robustness | Bounded work everywhere — per-run budgets, tool-loop guards, queue limits, execution timeouts, hostile-document hardening — plus explicit failover so a dead provider degrades predictably ([Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control), [Document extraction](../CAPABILITIES.md#document-extraction)) | `budgets` (`maxTokens`, `maxToolCalls`, `maxWallMs`), `MAX_TOOL_STEPS`, `QUEUE_MAX_DEPTH`, `EXECUTION_TIMEOUT_MS`, `FALLBACK_CHAIN`, `ZIP_MAX_*` | `aiperator_requests_rejected_total` by reason, `aiperator_tool_loop_guard_total`, `aiperator_llm_fallbacks_total`, `aiperator_llm_errors_total` | `TODO(human)` |
| Safety | Sandboxing for generated code and for plugins, network off by default; untrusted content is fenced before it reaches a model, and a write tool needs approval for the rest of a run after an injection finding | `SANDBOX_ENABLED`, `SANDBOX_NETWORK_ENABLED`, `PLUGINS_SANDBOX`, `PLUGINS_ALLOWLIST`, `RETRIEVAL_CONTEXT_MODE`, `TAINT_WRITE_TOOLS_REQUIRE_APPROVAL`, [Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety) | `aiperator_indirect_injection_total`, `aiperator_taint_approvals_total`; trace diagnostics `indirect_prompt_injection`, `tainted_write_tool_approval` | `TODO(human)` |

## 4. Trustworthiness topics the standard names explicitly

| Requirement topic | ATF control | Configuration | Evidence | Reference |
| --- | --- | --- | --- | --- |
| Transparency to users | Per-answer provenance: which model, which sources, which routing choice, which policy decision. The disclosure that a person is talking to a system belongs to the channel and is marked opt-in at the API ([Guardrails and safety](../CAPABILITIES.md#guardrails-and-safety)) | `AI_DISCLOSURE` | `GET /monitoring/explain/{executionId}`; response marker | `TODO(human)` |
| Explainability | The explainability card is a per-execution artefact rather than a post-hoc narrative, and it is what an "why this answer" request is answered with ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | — | [../adr/0017-decision-provenance-explainability-card.md](../adr/0017-decision-provenance-explainability-card.md) | `TODO(human)` |
| Fairness and bias | **Not covered.** No bias or representativeness measurement exists, for models or for corpora. This is a real gap, and a flow that makes decisions about people needs external assessment here | — | — | `TODO(human)` |
| Privacy and data protection | A reversible vault replaces detected personal data with placeholders *before* the provider call and restores mapped values afterwards; output-side redaction is a second layer. Its reach is exactly the model-facing boundary — tool results and retrieved chunks are not tokenized, which is recorded as ADR 0036 (Proposed) ([Privacy and the PII vault](../CAPABILITIES.md#privacy-and-the-pii-vault)) | `PII_VAULT_ENABLED`, `PII_DETECTORS`, `PII_VAULT_TYPES`, `PII_DETECTOR_FAIL_MODE=closed`, `PII_VAULT_MULTIMODAL_MODE`, `GUARDRAIL_REDACT_PII` | `aiperator_pii_vault_tokens_total`, `aiperator_guardrail_redactions_total` by finding type; action summary on the explainability card (counts only, never values) | `TODO(human)` |
| Accountability and traceability of decisions | Every consequential step is an audit entry, the log is append-only and hash-chained with periodic signed anchors, and the chain is verifiable by a third party without a shared secret ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) | `AUDIT_ANCHOR_FILE`, `AUDIT_ANCHOR_SECRET`, `AUDIT_ANCHOR_INTERVAL_MS`, `EVIDENCE_SIGNING_KEY` | `GET /.well-known/atf-evidence-jwks.json`; `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file>`; dossier section "audit trail integrity" | `TODO(human)` |
| Logging and monitoring | Per-execution debug traces, Prometheus metrics and OpenTelemetry traces on all four services, with metric authentication separate from the API ([Observability](../CAPABILITIES.md#observability)) | `METRICS_ENABLED`, `METRICS_AUTH`, `OTEL_EXPORTER_OTLP_ENDPOINT` | The metric catalogue in [../METRICS-AND-RETENTION.md](../METRICS-AND-RETENTION.md) | `TODO(human)` |
| Incident handling | Fail-open and degraded behaviour is a counter, not a log line, and the incident runbook is organized by severity with evidence handling and key-compromise procedures ([Observability](../CAPABILITIES.md#observability)) | — | `aiperator_degraded_total`, `aiperator_audit_write_failures_total`, `aiperator_policy_stale_total`; [../runbooks/incident.md](../runbooks/incident.md) | `TODO(human)` |
| Third-party and customer relationships | Which model providers exist is configuration, and the compliance policy's model and provider allow/block is applied at execution admission: a provider outside it, or in a known disallowed region, blocks. Every fallback member is included in the flow's model, capability and compliance accounting, so a failover cannot leave it. Separately, outbound destinations are constrained by the egress guard ([Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence), [Cost and reliability control](../CAPABILITIES.md#cost-and-reliability-control)) | `PROVIDERS`, model/provider allow-block in `compliance-policy.yaml`, `EGRESS_ALLOWED_HOSTS` | The active policy inside the dossier; `aiperator_llm_calls_total` by provider and model | `TODO(human)` |
| Outsourced / supplier assessment | — not a runtime capability, so there is no CAPABILITIES.md citation for it. The record is the artefact: a dependency tree with licences and an SBOM per release, generated for the artifact's platform, and a release-time verification that internal material is absent from what ships. Supplier due diligence itself is organisational | `bun run supply-chain` | [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md), [../../sbom.cdx.json](../../sbom.cdx.json), [IMAGE-LICENSES.md](../IMAGE-LICENSES.md) | `TODO(human)` |
| Internal audit | — not covered as a process. What can be audited automatically is the *configuration*: an offline preflight checks an environment file against the production-readiness gate and the governance posture without starting the service or printing a value | `bun run atf-doctor --service runtime\|search\|extract\|gate` | Non-zero exit with the failed checks; [Observability](../CAPABILITIES.md#observability) | `TODO(human)` |
| Management review | — not covered. The posture report and the dossier are the kind of input a review consumes; convening it is not a product feature | — | `GET /admin/compliance/dossier?format=json\|markdown` | `TODO(human)` |
| Nonconformity and corrective action | The technical half of "detected and recorded" exists: a failed flow load, a stale policy, a rejected request and a degraded component each produce a metric, so a control that stopped working is observable rather than assumed ([Observability](../CAPABILITIES.md#observability)) | — | `aiperator_flow_load_failures`, `aiperator_policy_stale_total`, `aiperator_requests_rejected_total`, `aiperator_degraded_total` | `TODO(human)` |

## 5. Configuration that changes the answer

A mapping that describes an enabled control while the deployment runs the defaults is misleading.
These are the switches that move a row from "available" to "enforced":

| Setting | Effect |
| --- | --- |
| `ATF_PROFILE=production` | the operating profile the gates and defaults below are written against; unknown values abort startup |
| `ATF_PRESET=regulated` / `regulated-multitenant` | turns on taint mode, AI disclosure and mandatory compliance policies, and in the production profile makes a missing `AUDIT_ANCHOR_FILE`, an empty `EGRESS_ALLOWED_HOSTS` or a missing `EVIDENCE_SIGNING_KEY` fatal instead of a warning |
| `COMPLIANCE_POLICY_REQUIRED=true` | startup refuses a production instance with no loaded policy, closing the one loading failure that does not fail closed (see [Compliance and evidence](../CAPABILITIES.md#compliance-and-evidence)) |
| `PII_DETECTOR_FAIL_MODE=closed` | the vault's detector failures block instead of passing text through; the default is `open` |
| `TOOL_AUTHZ_FAIL_CLOSED`, `APPROVAL_GATE_ENABLED` | tool authorization and human oversight, fail-closed by default for authorization, off for the gate unless enabled |
| `RETENTION_ENABLED` + `RETENTION_MAX_AGE_DAYS` | retention sweeps are opt-in per store; without them data is kept indefinitely |
| `EVIDENCE_SIGNING_KEY` | makes anchors, bundles and receipts verifiable offline; without it evidence is only as trustworthy as the platform that produced it |

## 6. Gaps to plan for

- **Fairness and bias**: no measurement, no instrument, no report. ([../EU-AI-ACT.md](../EU-AI-ACT.md)
  records the same gap for Art. 10.)
- **Impact assessment**: no instrument; only the technical inputs.
- **Management-system documentation**: policy, scope, roles, competence, internal audit and
  management review are the operator's documents. ATF cannot generate them and does not claim to.
- **Certification**: ATF is not certified and supplies no attestation. A certificate issued to an
  operator covers that operator's management system, not this software.
- **Retention defaults**: append-only audit entries and Extract jobs are retained indefinitely by
  default; the operator sets the periods the standard expects them to have.
- **PII vault reach**: tool results and retrieved content are not tokenized today
  ([../adr/0036-pii-vault-typed-tokens-and-tool-boundary.md](../adr/0036-pii-vault-typed-tokens-and-tool-boundary.md),
  Proposed). A "no plaintext to the provider" claim requires the ACL and index side, not the vault.

## See also

- [compliance/README.md](README.md) — scope, conventions, and why the reference column is empty
- [nis2.md](nis2.md) — operational security and incident reporting duties, which overlap most with
  this file's logging and incident rows
- [../EU-AI-ACT.md](../EU-AI-ACT.md) — the legal obligations a management system is often built to
  discharge
