# 9. Declarative compliance policy engine and a separate auto-generated evidentiary dossier

Date: 2026-07-13

## Status

Accepted

## Context

aiperator already had scattered compliance-relevant controls — tenant
isolation, retention windows, an audit log, RTBF erasure, red-teaming, eval
history — each with its own configuration and its own read API. Two distinct
gaps remained, and they are different problems with different consumers:

1. **No machine-checkable policy.** Data-residency ("personal data may only
   go to an EU-region provider"), model allow/block lists, and per-tool
   approval requirements existed only as ad-hoc code paths and env vars, not
   as a single declarative artifact an operator (or an auditor) could read,
   version, and diff.
2. **No single "prove you're compliant" document.** An auditor does not ask
   "what happened in the last 24 hours" (which `generateAuditReport()` already
   answered) — they ask "prove this deployment IS compliant," which requires
   pulling together the active policy, the audit trail's own tamper-evidence,
   actual RTBF erasures performed (not just retention windows configured),
   eval history, and security posture into one document with a wider,
   auditor-relevant time window.

## Decision

We built two separate but related mechanisms, kept in separate modules because
they have different inputs, different consumers, and different failure modes.

### 1. Policy-as-code engine (`src/compliance/`)

- **Schema** (`policy-schema.ts`): a Zod schema for `compliance-policy.yaml` —
  `dataRules` (data class → allowed provider+region), `modelRules` (tenant →
  allow/block model list, `*` wildcard supported), `approvalRules` (tool
  pattern → human-approval requirement, extending the existing approval gate
  with per-flow/per-role scoping), `retentionRules` (data class → max age,
  overriding the env-based default), `auditRules` (action prefix → audit
  verbosity). `failClosed` defaults to `true`.
- **Loader** (`policy-loader.ts`): hot-reloads `compliance-policy.yaml`/`.json`
  from `FLOWS_DIR` via `resolveConfigFile` + the file-watcher's
  `onComplianceChange` hook, the same pattern as `canary.ts` and
  `flow-dispatcher.ts`. A missing or malformed file degrades to `policy ===
  undefined` (evaluator treats that as allow-all), never a crash.
- **Evaluator** (`policy-evaluator.ts`): `evaluatePolicy(policy, ctx)` is a
  pure function — no I/O — returning `{ decision: "allow" | "deny" |
  "require-approval", violations, policyAbsent }`. A `deny` from `dataRules` or
  `modelRules` short-circuits before `approvalRules` is even consulted (data
  and model rules are hard blocks; approval rules gate with a human, not deny
  outright). Evaluation errors are fail-closed (`deny`) when `policy.failClosed
  !== false`, matching the codebase's established fail-closed default (see
  ADR-0002's discussion of fail-open/fail-closed for the exceptions).

  It remains available at the operator dry-run endpoint, `POST
  /admin/compliance-policy/evaluate` (`src/routes/compliance-policy.ts`), for
  testing a hypothetical request context against the loaded policy without
  sending a real chat request.

  **Update (2026-07-13): live enforcement added.** `evaluatePolicy()` is now
  also called on the request path: `checkCompliancePolicy`
  (`src/routes/chat/metering.ts`) runs as an admission check in `POST
  /v1/chat/completions` (`src/routes/chat.ts`), after flow-authorization and
  before `GraphEngineService.executeFlow` — a `deny` verdict rejects the
  request with HTTP 403 and a `compliance.policy.deny` audit entry before any
  node runs. It evaluates `evaluatePolicyForModels(policy,
  collectFlowLlmConfigs(flow), ctx)`: every distinct `provider`/`model` pair
  statically declared across the flow's nodes (`chat/handler.ts`), so a
  multi-model flow is denied if *any* node's declared model violates a
  `dataRules`/`modelRules` entry, not just the first.

  **Update (2026-07-13, same day): approval rules wired too.**
  `evaluatePolicy()`'s `"require-approval"` decision genuinely cannot be
  reached from `checkCompliancePolicy` above (tool selection is not known
  before the graph executes), so it is wired at the point tool selection IS
  known instead: `policyRequiresToolApproval` (`policy-evaluator.ts`) is
  consulted per tool call by both runtime call sites that gate tool
  calls — the `llm` node's agent loop (`buildAiTools` in `agent-tools.ts`)
  and the deterministic `tool` node (`handlers/tool.ts`) — alongside the
  existing static `node.config.requiresApproval` / `APPROVAL_REQUIRE_TOOLS`
  check. A tool matching an `approvalRules` pattern now pauses for human
  approval exactly like a statically-configured one, with one hard
  precondition: **the approval gate must ALSO be enabled**
  (`APPROVAL_GATE_ENABLED` / a non-empty `APPROVAL_REQUIRE_TOOLS`). The
  policy decides *which* calls need approval; the gate provides the only
  pause/notify/resolve mechanism in the platform — the policy has none of
  its own. Bootstrap (`src/index.ts`) logs a startup warning when
  `approvalRules` are configured but the gate is not, so this
  misconfiguration is loud, not silent (verified live: boots with the
  warning when the gate is off, boots clean when
  `APPROVAL_GATE_ENABLED=true`).

  The policy reaches the engine via `GraphEngineService.setCompliancePolicy()`
  — a post-construction setter (same pattern as the pre-existing
  `setToolAuthzEngine`, needed because the policy loader is constructed after
  the engine in `src/index.ts`), set once at bootstrap and re-set on every
  `compliance-policy.yaml` hot-reload (`onComplianceChange`). Because this
  lives at the **engine** level rather than the **chat route** level, it is
  NOT limited to `POST /v1/chat/completions` — it applies to every entry
  point into `GraphEngineService.executeFlow` (webhook triggers, replay, the
  flow-as-MCP-server, shadow mode) for free. This is broader coverage than
  the model/data-rule admission check above, which remains chat-route-only
  (see its own residual-scope note).

  **Residual scope, stated explicitly rather than silently left open:**
  - ~~`dataRules` remain effectively inert. Enforcement needs
    `ctx.dataClasses`, and nothing in the codebase currently classifies a
    request's data.~~ **Update (2026-07-13, same day): fixed — deliberately
    via static declaration, not content-based detection.** `FlowDefinition`
    gained an optional `dataClasses?: DataClass[]` field (`types/flow.ts`,
    validated by `FlowDefinitionSchema` in `flow-parser/validate.ts`): a flow
    author states once, in the flow file, which data classifications the flow
    processes (e.g. `dataClasses: [personal, financial]`). `checkCompliancePolicy`
    (`chat/metering.ts`) passes `flow.dataClasses` into
    `evaluatePolicyForModels`, so `dataRules` are now checked against every
    node's declared model — a flow declaring `personal` data that also uses a
    provider not on that data class's `allowedProviders` list is denied with
    403, exactly like a `modelRules` violation.

    **Why static declaration, not auto-detection from message content:** a
    regex/pattern scan over live user text (the codebase already has one —
    `findPiiMatches` in `output-guardrails.ts`, used by the PII vault,
    ADR-0007) was considered and deliberately rejected *for this admission
    check*. A false-positive PII match denying a legitimate production
    request is a materially worse failure mode than an omitted `dataClasses`
    declaration (silently not enforced — the same state every flow was in
    before this field existed). Content-based classification remains a
    plausible future *additive* signal, but should be scoped as its own
    decision (with its own false-positive tolerance, and likely opt-in) rather
    than folded silently into this one. `DATA_CLASSES`/`DataClass` were moved
    from `compliance/policy-schema.ts` to `types/flow.ts` (with a re-export
    for backward compatibility) so the core flow-type module could reference
    them without depending on the compliance feature module — the compliance
    module now imports FROM the flow types, not the other way around, which
    matches how `LlmConfig` (also flow-owned) already flows into compliance
    code.

    Every `evaluatePolicyForModels`/`checkCompliancePolicy` residual-scope
    caveat now applies to `dataRules` too, symmetrically with `modelRules`:
    chat-route-only (see next bullet). Verified end-to-end against a real
    running server: a flow declaring `dataClasses: [personal]` on an
    OpenAI node is denied (403, citing the disallowed provider); an
    otherwise-identical flow on an `ollama` node (on the class's
    `allowedProviders` list) is admitted.
  - **The model/data-rule admission check (`checkCompliancePolicy`) is still
    chat-route-only.** Unlike `approvalRules` (engine-level, see above),
    `modelRules`/`dataRules` are evaluated once at request admission in
    `routes/chat.ts` — webhook triggers, replay, the flow-as-MCP-server, and
    shadow mode do not call it and can still reach a policy-blocked model.
  - ~~`ApprovalRule.timeoutMs` is accepted by the Zod schema... but is not
    wired to anything.~~ **Update (2026-07-13, same day): fixed.**
    `ApprovalRequest.timeoutMs` (`approval-gate.ts`) is now an optional
    per-request override — `ApprovalRegistryImpl.request()` uses
    `req.timeoutMs ?? this.timeoutMs`. `policyRequiresToolApproval` was
    changed from returning a `boolean` to a `ToolApprovalRequirement { required,
    timeoutMs? }`, backed by a new `findMatchingApprovalRule` helper
    (extracted from `evaluatePolicy`'s inline approval-rule matching, now
    shared by both so they cannot drift) that returns the matched rule itself
    instead of discarding it after the boolean check. Both call sites
    (`agent-tools.ts`, `handlers/tool.ts`) thread the matched rule's
    `timeoutMs` into `approval.gate.request(...)`. Also fixed in the same
    change: `DistributedApprovalRegistry`'s Redis mirror TTL
    (`distributed-approval.ts`'s `addMirror`) was sized once at construction
    from the registry's *global* timeout — a per-request override longer than
    that global default would have let the cluster-wide mirror expire (and
    vanish from `GET /monitoring/approvals` on other replicas) before the
    local waiter's actual timeout fired. `addMirror` now recomputes the TTL
    from `pending.timeoutMs` when present. Verified: `approval-gate.test.ts`
    (per-request override fires before/instead of a longer global timeout),
    `distributed-approval.test.ts` (mirror TTL reflects the override),
    `graph-engine-compliance-policy-approval.test.ts` (a 25ms rule-level
    timeout auto-denies in well under the gate's 5000ms global timeout,
    timed end-to-end through the real engine).
  - While fixing the wiring, a related evaluator bug was corrected: a
    data-residency violation with no region context in the request was
    documented as "logged but not blocking" but was actually counted as a
    hard `deny` (its `rule: "data"` tag made it indistinguishable from a real
    block in the final-decision filter). Fixed by adding
    `PolicyViolation.blocking` (defaults to `true`; the region-unknown case
    now sets it to `false`) — this was fixed before `dataRules` had any way to
    be exercised (see previous bullet); shipping the wiring without the fix
    would have made it a live-traffic-denying bug the moment `dataClasses`
    support landed, which it since has.

- **Report** (`audit-report.ts`): `generateAuditReport()` aggregates the audit
  log into policy summary + violation/approval counts + model usage, scoped to
  a short window (default 24h) — the "what happened recently" view, exposed at
  `GET /admin/compliance-policy/report[.csv]`.

### 2. Auto-generated evidentiary dossier (`src/compliance/dossier.ts`)

`generateComplianceDossier()` answers a structurally different question over a
much wider default window (30 days, vs. the audit report's 24h) by composing
sources the audit report does *not* touch:

- The active policy (via `generateAuditReport`, reused as a sub-section).
- **Audit-trail integrity**: `auditLog.verifyChain()` result embedded directly
  — the dossier carries proof of its own non-tampering, not just a claim.
- **RTBF evidence**: every `compliance.forget` / `dsar.self_erasure` audit
  entry actually recorded in the window (`buildRtbfEvidence()`) — evidence of
  erasures *performed*, which `generateAuditReport`'s violation-only view
  never surfaces (these are `outcome: "success"` operator actions, not
  policy violations, so they are fetched separately from the raw audit log).
- **Retention posture**: `RetentionService.describeTargets()` plus the
  policy's `retentionRules`.
- **Eval evidence**: most recent `EvalRunRecord` per dataset from
  `EvalRunHistory`, letting a claim like "flow X was evaluated on `<date>` with
  pass rate `<y>%`" be cited.
- **Security posture**: `RedTeamEngine.postureByFlow()` / `listRuns()`, when
  `RED_TEAM_ENABLED=true`.
- **Architectural guarantees**: a fixed, hand-maintained list
  (`ARCHITECTURAL_GUARANTEES` in `dossier.ts`) citing `docs/adr/0005-*.md`,
  `docs/adr/0006-*.md`, and the PII vault / audit-log modules directly, so a
  dossier claim about tenant isolation or plugin sandboxing traces to the
  design decision that backs it rather than restating it inline.

Every section degrades independently — a deployment with no red-teaming, no
eval history, or no loaded policy still gets a usable partial dossier rather
than a failed request. Output is JSON by default;
`formatDossierAsMarkdown()` renders a downloadable `.md` variant (`GET
/admin/compliance/dossier?format=markdown`), mirroring the eval runner's own
`formatReport` pattern rather than introducing a new document format
(no PDF/CSV generator exists in the codebase to build the dossier on).

## Consequences

- The policy engine and the dossier can be adopted independently: an operator
  can enable `compliance-policy.yaml` without ever calling
  `/admin/compliance/dossier`, and the dossier still renders (with an
  "enabled: false" policy section) for a deployment that has no policy file
  but wants the audit-integrity / RTBF / eval evidence sections.
- The dossier's architectural-guarantees section is hand-maintained prose, not
  derived from the ADRs programmatically — it will drift from `docs/adr/*.md`
  if a cited ADR is superseded and the dossier's copy is not updated in the
  same change.
- `modelRules` and `dataRules` are now both a real runtime hard gate on `POST
  /v1/chat/completions` (the latter via a flow's declared `dataClasses`), and
  `approvalRules` are now a real runtime gate on every tool call across every
  entry point into the graph engine — provided the approval gate is
  separately enabled (see the Update notes above). All three rule types in
  `compliance-policy.yaml` can now be relied on as genuine controls, not just
  documented intent — `dataRules` specifically only as strong as each flow's
  own `dataClasses` declaration, since nothing infers it automatically (a
  flow that carries personal data but forgets to declare `dataClasses:
  [personal]` is not covered — this is a completeness gap in individual flow
  authoring, not in the policy engine itself, and is the deliberate tradeoff
  described in the Update note above).
- `generateAuditReport()` and `generateComplianceDossier()` both filter the
  same `auditLog.list({ limit: 1000 })` call independently rather than sharing
  a windowed query — acceptable at current audit-log volumes, but a future
  scaling pass should give `AuditLog` a windowed/paginated list method instead
  of two call sites each re-implementing the same 1000-row fetch-and-filter.
