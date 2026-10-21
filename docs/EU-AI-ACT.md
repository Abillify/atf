# EU AI Act: roles, scope, and how ATF supports the obligations

> Orientation for operators and their data-protection and compliance staff. It is **not legal advice**:
> whether a system is a high-risk system, and who carries which duty, depends on the deployment and
> the use case, not on ATF. It maps obligations to the controls ATF provides, says what ATF does **not**
> do, and points at the evidence each control produces. Companion documents:
> [DSFA-VORLAGE.md](DSFA-VORLAGE.md) (Art. 35 GDPR), [VVT-VORLAGE.md](VVT-VORLAGE.md) (Art. 30 GDPR),
> [THREAT-MODEL.md](THREAT-MODEL.md).

## 1. Who is who

ATF is infrastructure: a flow runtime, a tool gateway, a retrieval service and a document-extraction
service. It is not an AI system with an intended purpose of its own. The purpose comes from the flows an
operator builds on it.

| Role (AI Act) | Typically | Consequence |
| --- | --- | --- |
| **Provider** of a general-purpose model | The model vendor (cloud API or self-hosted weights) | Model-level duties (technical documentation, copyright policy, GPAI duties) lie with them, not with ATF or with you |
| **Provider** of an AI system | The party that puts a flow or application built on ATF on the market or into service under its own name | Art. 16 and the high-risk requirements apply to **you** if the use case is high-risk |
| **Deployer** | The organisation that uses such a system under its own authority | Art. 26 duties (use per instructions, human oversight, log retention, informing affected people) |
| ATF itself | Software component | Supplies controls and evidence; does not carry the role |

If you integrate ATF into your own product and sell it, you are the provider of that product. If you
run flows for your own staff, you are the deployer, and also the provider if you built the flow yourself
and put it into service.

## 2. Is your use case high-risk?

ATF does not decide this. Check **Annex III** against what the flow does, not against the technology:
employment and worker management (screening, task allocation, monitoring, evaluation), access to
essential services (credit, insurance, benefits), education, biometric identification, law enforcement,
migration, administration of justice. A helpdesk flow that answers questions from product manuals is
normally not in scope; a flow that ranks applicants or flags employees is.

Pointers that help the assessment:

- `dataClasses` on each flow declares what it processes (`personal`, `sensitive`, `health`, …), see
  [FLOWS.md](FLOWS.md). The data-flow map (`GET /admin/compliance/ropa`, the Art. 30 record of processing) lists flows, providers
  and the classes that reach them, and flags flows that declare none.
- A flow that touches **employee data** (time recording, absence, payouts) is a strong signal to look at
  Annex III point 4, whatever the model does with it.
- Write the assessment down per flow. ATF cannot produce it for you.

## 3. Obligations and the ATF controls behind them

"Applies if high-risk" marks duties that bind high-risk systems only. Art. 50 and Art. 4 apply
regardless of risk class.

| Article | Duty | What ATF provides | Evidence | What stays with you |
| --- | --- | --- | --- | --- |
| **Art. 9** risk management | Continuous risk process over the lifecycle (applies if high-risk) | Red-team engine with attack registry and posture score per flow; tool authorization (`tool-authz.yaml`) and approvals; guardrails (PII, blocked patterns, tool-egress DLP); taint rule after prompt-injection findings | `GET /admin/compliance/dossier` security-posture section; red-team run history | The risk assessment, residual-risk decision, testing against your intended purpose |
| **Art. 10** data and data governance (applies if high-risk) | Quality, relevance, bias examination of training/validation data | Retrieval corpora are your data: ingestion with provenance (source digest, revision, collection ACL), erasure by reference/subject, retention settings | Extract job records, Search document metadata, erasure receipts | Choice and curation of the corpus, bias checks; ATF does not train models |
| **Art. 12** record-keeping (applies if high-risk) | Automatic logging over the lifetime | Hash-chained, append-only audit log with external anchors (`AUDIT_ANCHOR_FILE`); execution debug traces with `flow_version`, `flow_digest`, `subflow_versions`; decision provenance ("explainability card", ADR 0017) | Audit export and chain verification (`/monitoring/audit…`), dossier section "audit trail integrity" | Retention period (Art. 19/26: at least six months for deployers of high-risk systems), off-host anchor storage |
| **Art. 13** transparency to deployers (applies if high-risk) | Instructions for use, characteristics, limits | This documentation set; per-flow explainability card (why this answer, which model, which sources) | [FLOWS.md](FLOWS.md), ADR 0017, `/monitoring/...` explain endpoints | Instructions for *your* system's use, accuracy figures for *your* purpose |
| **Art. 14** human oversight (applies if high-risk) | Natural persons can oversee, intervene, override | Human approval for consequential tools (`requiresApproval`, fail-closed on timeout), operator approval queue, separate operator plane, abstention (`MIN_RERANK_SCORE`) | Audit entries for each approval decision | Naming and training the people who oversee; deciding which tools are consequential |
| **Art. 15** accuracy, robustness, cybersecurity (applies if high-risk) | Declared accuracy, resilience, protection against manipulation | Eval harness with run history per dataset (quotable pass rates); red-team posture score; prod-gates that refuse insecure configuration; STRIDE model ([THREAT-MODEL.md](THREAT-MODEL.md)); prompt-injection defences (data fencing in Extract prompts, `content_trust` in Search results) | Dossier model-quality and security-posture sections | Test sets that represent your use, acceptance thresholds, penetration tests |
| **Art. 26** deployer duties (applies if high-risk) | Use per instructions, oversight, input-data relevance, monitor, keep logs, inform workers and affected persons | Monitoring, SLO and alerting, audit export, DSAR self-service (`GET/DELETE /v1/me/data`) | Audit report (`GET /admin/compliance-policy/report`) | Informing works councils, workers and affected persons; incident reporting to the provider/authority |
| **Art. 50** transparency obligations | Tell people they interact with an AI system; mark synthetic content; disclose deep fakes | Opt-in machine-readable marker: `AI_DISCLOSURE=header\|field` flags successful completions as AI-generated (off by default). No notice or watermark in the text itself (see below) | — | Disclosure in the user interface or channel you operate; switching the marker on and keeping it through your own delivery chain where Art. 50(2) applies |
| **Art. 4** AI literacy | Staff have sufficient AI literacy | — | — | Training of the people operating and using the system |

### Art. 50: what ATF does and does not do

Art. 50 has applied since 2 August 2026. ATF returns model output through its chat-completions and
retrieval APIs unchanged: it does **not** insert a notice or a watermark into the text. What it can do,
when you ask for it, is flag the response as AI-generated for the systems downstream (below).

- **Interaction with a person (Art. 50(1))**: the disclosure belongs to the front end or channel that
  talks to the user (Open WebUI, your application, a voicebot). Put it there.
- **Synthetic text published to inform the public (Art. 50(4))**: if flows generate such text, the
  disclosure or the human-review exemption is your decision. The execution record shows which flow, model
  and version produced a text (`flow_version`, explainability card), which is the evidence for the
  exemption "human review or editorial control".
- **Machine-readable marking (Art. 50(2))**: set `AI_DISCLOSURE` on the Runtime. `header` adds
  `X-AI-Generated: true` to every successful `/v1/chat/completions` and `/v1/responses` response;
  `field` adds `metadata.ai_generated: true` to a non-streaming JSON body and, because a stream has no
  single body, the header to a streamed response. Error responses are not marked, and the default is
  `off`, so existing clients see no change. This marks the API response, not the content once it is
  copied out: a marker that has to survive in a document, an e-mail or an image is applied at the
  point where the text leaves your system. Whether your use case needs it, and which of the two
  forms, is your assessment, not the product's.

## 4. Evidence an auditor can be handed

| Question | Where it is answered |
| --- | --- |
| What was deployed when | `flow_version`, `flow_digest`, `subflow_versions` in the execution debug trace; flow publishing is a regulated, audited action |
| Who approved what | Audit log entries for approvals (`actor`, `target`, `outcome`), hash-chained |
| Was the log altered | Chain verification and the anchor file; `EVIDENCE_SIGNING_KEY` (Ed25519) makes anchors and bundles verifiable offline via `/.well-known/atf-evidence-jwks.json` |
| Was personal data erased | Signed erasure receipts (`GET /v1/me/data/erasures/{id}`); receipts carry pseudonymous hashes (SHA-256 of tenant id and identifier — pseudonymous personal data, not anonymous), never the identifier |
| How good is the flow | Eval run history per dataset, shown in the dossier |
| Everything in one place | `GET /admin/compliance/dossier?format=json\|markdown` |

## 5. Switches that make the controls binding

Several of these are warnings by default so existing systems keep starting; tighten them for a system
you classify as high-risk:

| Setting | Effect |
| --- | --- |
| `ATF_PRESET=regulated` / `regulated-multitenant` | Preset that fills the control bundle above (`TAINT_MODE=on-untrusted-source`, `AI_DISCLOSURE=header`, `COMPLIANCE_POLICY_REQUIRED=true` and the guardrail/PII/retention flags); explicit env values still win. In the production Betriebsprofil the preset makes a missing `AUDIT_ANCHOR_FILE`, an empty `EGRESS_ALLOWED_HOSTS` and a missing `EVIDENCE_SIGNING_KEY` fatal instead of warnings |
| `ATF_PROFILE=production` | Turns the production-readiness gates on (authentication, tenant isolation, RLS, audit anchoring warnings) |
| `COMPLIANCE_POLICY_REQUIRED=true` | Production refuses to start without a loaded `compliance-policy.yaml`, so residency and data-class rules cannot be silently absent |
| `EGRESS_ALLOWED_HOSTS` | Restricts guarded outbound calls to the destinations in your record of processing; empty means every public host |
| `AUDIT_ANCHOR_FILE` + `EVIDENCE_SIGNING_KEY` | Keeps audit anchors across restarts and makes the evidence chain verifiable by third parties |
| `requiresApproval` on nodes, `tool-authz.yaml` | Human oversight for consequential tools |
| `AI_DISCLOSURE` | Marks successful completions as AI-generated (`header` or `field`); off by default |
| `JOB_RETENTION_DAYS` (Extract) | Bounds how long page-level model responses are kept |

## 6. Gaps to plan for

- No Art. 50 notice or watermark in the generated text; the API marker is opt-in (`AI_DISCLOSURE`, section 3).
- No built-in conformity assessment, technical-documentation (Annex IV) generator or EU database
  registration. The dossier covers the evidence part of Annex IV; the descriptive part is yours.
- Bias and representativeness checks (Art. 10) are not automated.
- Log retention periods are set by you; the audit log does not expire entries on its own.
