# 22. Org Skill Registry

Date: 2026-08-02

## Status

Accepted

## Context

The per-user assistant subsystem (`src/assistants/`) already lets an
assistant learn a reusable procedure ("skill") from its own conversations:
`experience-review.ts` schedules a `learning-pass.ts` run, which proposes at
most one skill via `proposal-store.ts`, gated by `proposal-scanner.ts` (a
pure, deterministic scan for prompt-injection-laundering and secret
capture), and staged through `skill-canary.ts` (a per-conversation A/B
rollout) before it is fully trusted. This entire pipeline is intentionally
scoped to exactly one `AssistantScope` — `(tenantId, userId, assistantId)` —
with no route, table, or index anywhere that lets a second assistant read a
first assistant's skill.

That isolation is correct for an unproven procedure, but it means every
assistant in an organisation independently rediscovers the same techniques
from scratch, at the same cost (a learning pass, a scan, a canary) and the
same risk, with no way for one assistant's hard-won procedure to help
another assistant's user. No existing ADR documents this subsystem at all —
its design lives entirely in the extensive doc comments inside
`src/assistants/*.ts` — so this is the first ADR to touch it, and it must
preserve every boundary those files already established rather than
introduce a competing one. Two boundaries mattered most for this feature:

1. `assistants-admin.ts`'s explicit design choice that **an operator never
   applies a user's proposal** — only rejects. Approving new behaviour into
   someone's assistant is that person's decision.
2. A skill is **plain prompt text** (a trigger line plus a body), never
   executable code — the safety scanner defends against prompt-injection
   laundering and secret capture, not code execution. This materially lowers
   the bar for sharing (no sandboxing question), but the scanner itself was
   tuned for the risk of ONE learning pass reading ONE transcript, not for
   "is this content safe to inject into a DIFFERENT assistant with different
   constraints and autonomy" — a materially wider blast radius once a skill
   can reach a tenant-wide catalog.

## Decision

### The catalog is a snapshot, not a live reference

`SkillRecord` is keyed by a single scope and versioned/canaried per-scope;
there is no "many assistants read one skill row" indirection anywhere in the
platform. Introducing one for the registry would mean a rollback of the
ORIGIN skill (a normal, expected outcome of its own canary) silently
affecting every assistant that had installed from it — not what "share a
proven technique" should mean to an operator or a user. `org-skill-registry.ts`
therefore copies content twice: once into `org_skills` at publish time, and
again into the destination's own `ProposalStore` at install time. Each copy
is independent from that point on.

### Publishing is the source assistant's own user's decision

`publish()` requires the skill to be `active` (not `canary` — an
unresolved canary is, by definition, not yet decided to actually help), and
is reached only from `POST /v1/assistants/:id/skills/:name/publish` — a
route on the USER plane, resolved through the caller's own identity exactly
like every other route in `assistants.ts`. There is no operator-initiated
publish. This mirrors `PUT .../skills` (a user-authored skill going live
directly): a human already decided this content is worth sharing more
widely.

**Independent re-scan.** `publish()` calls `scanProposal()` again,
independent of whatever scan the origin proposal passed at learning time.
That earlier scan ran against risk local to ONE assistant's transcript;
publishing widens the blast radius to every assistant in the tenant, so the
gate is re-applied rather than trusted from history. A critical finding
refuses the publish outright (`OrgSkillScanBlockedError`) before any other
assistant could see the content.

### Installing is the destination assistant's own consent path

This is the decision that most directly protects the "operator never
applies" boundary from being circumvented by a side door. `installOrgSkill()`
does **not** write a live skill. It calls the destination's OWN
`ProposalStore.create()` — the exact function a self-learned procedure goes
through — producing an ordinary `pending` proposal with `createdBy:
"org-registry"` (distinct from `"experience-review"` so the audit trail
tells the two apart) and `autonomousCapture: false` (a human explicitly
chose this entry from the catalog; it is closer to a person authoring a
skill than to an unattended capture). From that point the installed content
is genuinely indistinguishable from a self-learned proposal: it is re-scanned
at proposal-create time, subject to the destination assistant's own
autonomy for auto-apply, and goes through that assistant's own canary if
applied. `POST /v1/org-skills/:id/install` resolves the destination scope
through the CALLER's own identity — a request cannot install into a foreign
assistant, even to accept a shared catalog entry into it.

### The operator's role is deliberately narrow

`GET /admin/org-skills` (cross-tenant browse) and `POST
/admin/org-skills/:id/deprecate` are the only operator-plane routes. There is
no operator-publish and no operator-install, for the same reason
`assistants-admin.ts` has no proposal-apply route: both actions are user
decisions about content that will land in someone's own prompt.
`deprecate()` only hides an entry from future browsing/installing — it
cannot retract an install already made, because an install copied content
into that assistant's own proposal pipeline rather than keeping a live
reference back to the catalog entry.

### Cross-tenant sharing is explicitly out of scope

`OrgSkillVisibility` has exactly one value, `"tenant"`. A curated,
operator-gated cross-tenant tier (e.g. a platform-vetted "starter pack" of
skills offered to every tenant) is a plausible later feature, but it is a
separate trust decision — a cross-tenant catalog entry's provenance and
review bar are not the same question as "should assistants in my own
organisation share what they've learned" — and is deferred rather than
folded into this iteration as an unused flag.

## Consequences

- **Positive.** A proven technique spreads across an organisation's
  assistants without each one re-learning it from scratch and re-absorbing
  the same risk. No existing boundary (operator-apply, live-skill isolation,
  the scan gate) was weakened to build this — every one of them is either
  reused unchanged or re-applied at a new point (the independent re-scan on
  publish).
- **Negative / residual.** The independent re-scan at publish time uses the
  SAME regex-based rules the learning-pass scanner uses; it is not tuned
  specifically for "is this safe for an audience of many different
  assistants with different constraints", only re-run for defence in depth.
  A subtler cross-scope risk (a skill that is harmless for its origin
  assistant's constraints but conflicts with a different assistant's
  operator-set `deniedTools`) is not detected by either scan — the
  destination assistant's own tool-authz layer is the actual enforcement
  point for that, exactly as it already is for a self-learned skill.
- The catalog's `install_count` is a display-only popularity signal
  (best-effort increment, never blocks or fails an install) — it is not an
  audit trail of who installed what; that remains in each destination
  assistant's own proposal event log (`assistant_skill_proposal_events`),
  which already records `createdBy: "org-registry"` and the originating
  catalog entry id in its evidence field.

## Implementation

- `src/assistants/types.ts` — `OrgSkillRecord`, `OrgSkillStatus`,
  `OrgSkillVisibility`, `OrgSkillListPage`; `ProposalCreator` gained
  `"org-registry"`.
- `src/assistants/org-skill-registry.ts` — `OrgSkillStore`
  (publish/list/get/deprecate/recordInstall), `InMemoryOrgSkillStore`,
  `PostgresOrgSkillStore`, `installOrgSkill()`.
- `src/db/migrations.ts` — `org_skills` table (migration 25).
- `src/assistants/assistant-runtime.ts`, `src/bootstrap/assistants.ts` —
  `AssistantRuntimeOptions.orgSkills` wiring.
- `src/routes/assistants.ts` — `POST /v1/assistants/:id/skills/:name/publish`,
  `GET /v1/org-skills`, `POST /v1/org-skills/:id/install`.
- `src/routes/assistants-admin.ts` — `GET /admin/org-skills`, `POST
  /admin/org-skills/:id/deprecate`.
- `apps/control/src/components/AssistantsPanel.tsx` — "Skill Registry" tab
  (`SkillRegistryConsole`), browse + deprecate only.
- `src/assistants/__tests__/org-skill-registry.test.ts`,
  `src/routes/__tests__/org-skills.test.ts`,
  `apps/control/src/__tests__/AssistantsPanel.test.tsx`.
