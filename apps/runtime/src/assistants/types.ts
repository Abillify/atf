// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant domain types (`src/assistants/types.ts`)
 *
 * An **assistant** is a durable, per-user entity — not a request. The platform's
 * existing execution primitives (`RequestContext`, `ExecRuntime`) are
 * per-request and die at turn end, which is exactly why a persistent, learning,
 * self-configuring assistant could not be expressed with them alone.
 *
 * The identity axis is the triple {@link AssistantScope}: `(tenantId, userId,
 * assistantId)`. It is the isolation boundary for memory, skills, workspace,
 * credentials and messaging. Everything in this subsystem is scoped by it, and
 * resolution FAILS CLOSED (see `resolveAssistantScope`) rather than falling back
 * to a weaker identity — an isolation boundary must never depend on a fallback
 * chain.
 *
 * Design note on the tenant sentinel: single-tenant deployments carry no
 * `clientId`. Because `tenant_id` participates in primary keys and RLS
 * predicates, a NULL there would make two assistants non-distinct under SQL
 * NULL semantics. The sentinel {@link NO_TENANT} is used instead, consistently
 * on both the SQL and TypeScript side.
 *
 * No `any` at module boundaries.
 */

// ---------------------------------------------------------------------------
// Identity axis
// ---------------------------------------------------------------------------

/**
 * Sentinel used for `tenant_id` when a deployment is single-tenant. A real
 * value never collides with it: {@link isValidAssistantIdentifier} rejects it as
 * a user- or assistant-supplied identifier.
 */
export const NO_TENANT = "_" as const;

/** The isolation boundary for every assistant-scoped resource. */
export interface AssistantScope {
  /** Tenant the user belongs to, or {@link NO_TENANT} for single-tenant. */
  tenantId: string;
  /** Stable user identity within the tenant. */
  userId: string;
  /** Assistant identity within the user. */
  assistantId: string;
}

/**
 * Maximum length of a user- or client-supplied identifier segment. Bounded
 * because these values become path segments on disk (workspace directories) and
 * container names; an unbounded value would hit `ENAMETOOLONG` at a point far
 * from where it was accepted.
 */
export const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Identifier charset for `assistantId` and for the sanitised form of `userId`
 * used in filesystem paths and container names.
 *
 * Deliberately narrow: lowercase alphanumerics plus `-` and `_`, and it must
 * start with an alphanumeric. This excludes `.`, `/`, `\`, whitespace and any
 * shell metacharacter, so a value that passes this check cannot traverse a path
 * (`..`), cannot become a hidden file, and cannot be misread by a shell. That
 * makes the check a real boundary rather than cosmetic validation.
 */
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Reserved identifiers that would collide with sentinels or path conventions. */
const RESERVED_IDENTIFIERS = new Set([NO_TENANT, ".", "..", "shared", "system"]);

/** True when `value` is safe to use as an assistant/path identifier segment. */
export function isValidAssistantIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
  if (RESERVED_IDENTIFIERS.has(value)) return false;
  return IDENTIFIER_PATTERN.test(value);
}

/**
 * Lifecycle status of an assistant.
 *
 * `suspended` differs from `archived`: a suspended assistant retains its state
 * and can be resumed (used when a budget is exhausted or a credential grant was
 * revoked), while an archived one is retired and only readable.
 */
export type AssistantStatus = "active" | "suspended" | "archived";

/**
 * How much an assistant may do without a human in the loop.
 *
 * This is deliberately a property of the ASSISTANT, not of the flow: the same
 * generic flow serves every assistant, and two assistants of the same user may
 * legitimately warrant different autonomy. It gates three distinct things:
 * whether learned skills auto-apply, whether code execution needs approval, and
 * whether background (user-absent) runs are permitted at all.
 */
export type AssistantAutonomy = "supervised" | "assisted" | "autonomous";

/** A provisioned assistant. */
export interface AssistantRecord {
  scope: AssistantScope;
  displayName: string;
  status: AssistantStatus;
  /**
   * Flow the assistant runs on. Normally absent, meaning "the platform default
   * assistant flow" — which is the point of the design: individuality lives in
   * state, not in a per-assistant flow file. Set only when an operator
   * deliberately pins one assistant to a specialised flow.
   */
  flowId?: string;
  /** Absolute, realpath-resolved workspace directory. */
  workspacePath: string;
  autonomy: AssistantAutonomy;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

/** Listing projection — avoids shipping the workspace path to list views. */
export interface AssistantSummary {
  scope: AssistantScope;
  displayName: string;
  status: AssistantStatus;
  autonomy: AssistantAutonomy;
  updatedAt: string;
  lastActiveAt?: string;
  /** Count of applied, non-retired skills. */
  skillCount: number;
  /** Count of proposals awaiting a decision. */
  pendingProposalCount: number;
}

// ---------------------------------------------------------------------------
// Soul
// ---------------------------------------------------------------------------

/**
 * Who may write which part of the soul.
 *
 * The three classes exist because "system prompt" conflates three things with
 * genuinely different trust levels: what the assistant is (it may change this),
 * what its user wants (only the user may), and what the organisation forbids
 * (only an operator may). Collapsing them means an agent that can rewrite its
 * own identity can also rewrite its own constraints.
 */
export type SoulWriteClass = "identity" | "directives" | "constraints";

/** Who performed a mutation. */
export type SoulActorType = "agent" | "user" | "operator" | "system";

/**
 * Agent-writable self-description.
 *
 * Every field is optional and free-form-ish on purpose: this is the part the
 * assistant may shape. Values are length-bounded at write time
 * (`SOUL_FIELD_MAX_CHARS`) because they land in the cacheable prompt prefix.
 */
export interface SoulIdentity {
  /** How the assistant refers to itself. */
  name?: string;
  /** A single glyph used in channel prefixes and UI. */
  emoji?: string;
  /** Short self-description of manner ("dry, precise, allergic to filler"). */
  vibe?: string;
  /** Domain the assistant considers itself responsible for. */
  role?: string;
  /** Free-form self-notes the assistant maintains about how it works. */
  notes?: string;
}

/** User-writable instructions. Only the owning user may change these. */
export interface SoulDirectives {
  /** Standing instructions ("always answer in German", "cite sources"). */
  instructions?: string;
  /** Preferred output shape/verbosity. */
  style?: string;
  /** Facts about the user the assistant should always know. */
  about?: string;
  /** Topics/actions the user does not want the assistant to pursue. */
  avoid?: string;
}

/**
 * Operator-writable hard limits. Rendered LAST in the prompt so they cannot be
 * shadowed by earlier text, and writable only through the operator plane.
 */
export interface SoulConstraints {
  /** Non-negotiable rules ("never send external email"). */
  rules?: string;
  /** Compliance/legal framing the assistant must respect. */
  compliance?: string;
  /**
   * Tool ids the assistant may never call, regardless of its own skills or the
   * user's directives. Enforced by the tool-authz layer, not by prompt text —
   * the prompt copy exists so the model knows why a tool is absent instead of
   * repeatedly attempting it.
   */
  deniedTools?: string[];
}

/** The complete soul document with its optimistic-lock metadata. */
export interface SoulRecord {
  scope: AssistantScope;
  identity: SoulIdentity;
  directives: SoulDirectives;
  constraints: SoulConstraints;
  revision: number;
  /**
   * Content hash over the whole document. A mutation states the hash it read;
   * a mismatch means someone else wrote in between and the mutation is refused
   * rather than clobbering. This is what keeps a self-editing agent and a
   * concurrently-editing user from losing each other's writes.
   */
  revisionHash: string;
  updatedAt: string;
}

/** One historical soul state. */
export interface SoulRevisionRecord {
  scope: AssistantScope;
  revision: number;
  revisionHash: string;
  writeClass: SoulWriteClass;
  actorType: SoulActorType;
  actorId?: string;
  identity: SoulIdentity;
  directives: SoulDirectives;
  constraints: SoulConstraints;
  reason?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an applied skill.
 *
 * `canary` is a live state, not a staging area: the skill IS applied, but is
 * injected into only a fraction of turns while its effect is measured. It
 * becomes `active` on promotion and `retired` on rollback.
 */
export type SkillStatus = "active" | "canary" | "retired";

/** Where a skill came from. Drives whether auto-apply is permissible. */
export type SkillOrigin = "learned" | "user" | "operator" | "template";

/** A live procedure the assistant has available. */
export interface SkillRecord {
  id: string;
  scope: AssistantScope;
  name: string;
  /**
   * One line stating WHEN the skill is relevant. This is the only part injected
   * into every prompt; the model reads {@link body} on demand. Bounded at
   * `SKILL_TRIGGER_MAX_CHARS`.
   */
  triggerLine: string;
  /** Full procedure text, served whole (never windowed) via the read tool. */
  body: string;
  bodyHash: string;
  version: number;
  /**
   * Stable prompt-ordering key. Prompt-cache preservation requires that the
   * injected skill list be byte-identical between turns when nothing changed;
   * ordering by a database default or by Map iteration order breaks that.
   */
  sortKey: string;
  status: SkillStatus;
  origin: SkillOrigin;
  useCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Org Skill Registry — publishing a proven skill for reuse by OTHER assistants
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a catalog entry.
 *
 * `published` is installable. `deprecated` remains visible (installs already
 * made from it are unaffected — a skill is a copy at install time, not a
 * live reference) but is hidden from new browsing/install by default, the
 * same "retire, never delete" reasoning `SkillStatus` already uses for a live
 * skill: the audit trail (which installs came from this entry) must survive.
 */
export type OrgSkillStatus = "published" | "deprecated";

/**
 * Visibility of a catalog entry.
 *
 * `tenant` (the default and only currently-implemented value) means every
 * assistant within the SAME tenant that published it may browse and install
 * it. Cross-tenant sharing is deliberately not offered by this iteration —
 * see the ADR for why a curated, operator-gated cross-tenant tier is a
 * separate, later decision rather than a flag here.
 */
export type OrgSkillVisibility = "tenant";

/**
 * A skill published to the tenant-wide catalog for reuse by other assistants.
 *
 * This is a SNAPSHOT — a copy of the originating skill's content at publish
 * time, not a live reference. `SkillRecord` is keyed by a single
 * `(tenant, user, assistant)` triple and versioned per-scope; there is no
 * existing "many assistants read one skill row" indirection, and introducing
 * one would mean every assistant sharing a live row could be affected by
 * another assistant's canary/rollback of the ORIGIN skill, which is not
 * remotely the guarantee "install a copy of a proven technique" implies.
 * Installing therefore always copies content into the destination
 * assistant's own proposal pipeline (see `org-skill-registry.ts`'s
 * `installOrgSkill`), where it is re-scanned and goes through that
 * assistant's own consent path exactly like a self-learned proposal would.
 */
export interface OrgSkillRecord {
  id: string;
  tenantId: string;
  name: string;
  triggerLine: string;
  body: string;
  bodyHash: string;
  visibility: OrgSkillVisibility;
  status: OrgSkillStatus;
  /** The assistant this was published FROM, kept for provenance/attribution. */
  sourceScope: AssistantScope;
  /** User id who authorised publishing (the source assistant's own user). */
  publishedBy: string;
  /** Short human note on what the skill does / why it was published. */
  summary?: string;
  /**
   * Evidence the publisher supplied that the skill actually helped — e.g. a
   * skill-canary outcome summary from the ORIGIN assistant. Free text: the
   * registry does not (yet) require a specific evidentiary shape, only that
   * a human decided this was worth sharing.
   */
  evidence?: string;
  /** How many times this entry has been installed. Best-effort, non-authoritative. */
  installCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrgSkillListPage {
  total: number;
  skills: OrgSkillRecord[];
}

// ---------------------------------------------------------------------------
// Skill proposals — the learning state machine
// ---------------------------------------------------------------------------

/** `pending` is the only state from which a proposal may still be applied. */
export type ProposalStatus = "pending" | "applied" | "rejected" | "quarantined" | "stale";

/** A proposal either introduces a new skill or revises an existing one. */
export type ProposalKind = "create" | "update";

/**
 * Safety-scan state. `apply` is gated on `clean`.
 *
 * `pending` means the scan has not completed — apply must refuse, not assume
 * success. This is the boundary that makes autonomous capture acceptable: the
 * learning pass writes proposals with no approval, but nothing unscanned can
 * reach the prompt of a future turn.
 */
export type ProposalScanState = "pending" | "clean" | "failed" | "quarantined";

/**
 * Who created a proposal.
 *
 * `org-registry` marks a proposal seeded from installing a catalog entry (see
 * `org-skill-registry.ts`) — distinct from `api` (an arbitrary external
 * caller) so the audit trail and the UI can tell "this assistant learned it
 * itself" apart from "a user pulled this in from the shared catalog".
 */
export type ProposalCreator = "experience-review" | "user" | "operator" | "api" | "org-registry";

/** Every state transition recorded in the append-only event log. */
export type ProposalEventType =
  | "created"
  | "revised"
  | "scanned"
  | "applied"
  | "rejected"
  | "quarantined"
  | "stale"
  | "canary_started"
  | "canary_promoted"
  | "canary_rolled_back";

/** One finding from the proposal safety scan. */
export interface ProposalScanFinding {
  severity: "critical" | "warn" | "info";
  /** Stable rule id, e.g. `secret-material`, `prompt-injection`. */
  rule: string;
  message: string;
  /** 1-based line in the proposal body, when the rule is line-scoped. */
  line?: number;
}

/** A pending or decided skill proposal. */
export interface ProposalRecord {
  id: string;
  scope: AssistantScope;
  kind: ProposalKind;
  status: ProposalStatus;
  /** Skill name this proposal targets (existing for `update`, new for `create`). */
  targetSkill: string;
  targetSkillId?: string;
  title: string;
  triggerLine: string;
  body: string;
  bodyHash: string;
  revision: number;
  /** Optimistic lock — see {@link SoulRecord.revisionHash}. */
  revisionHash: string;
  /** What the proposal claims to improve. */
  goal?: string;
  /** Concrete evidence from the reviewed trajectory. */
  evidence?: string;
  /** True only for proposals written by an autonomous learning pass. */
  autonomousCapture: boolean;
  createdBy: ProposalCreator;
  scanState: ProposalScanState;
  scanFindings?: ProposalScanFinding[];
  originExecutionId?: string;
  originRunId?: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

/** One proposal lifecycle event. */
export interface ProposalEvent {
  sequence: number;
  proposalId: string;
  eventType: ProposalEventType;
  revision: number;
  revisionHash: string;
  actorType: SoulActorType;
  actorId?: string;
  payload?: Record<string, unknown>;
  occurredAt: string;
}

/** Prior skill state captured before an apply, enabling exact reversal. */
export interface SkillRollbackRecord {
  proposalId: string;
  skillId?: string;
  action: ProposalKind;
  previousName?: string;
  previousTrigger?: string;
  previousBody?: string;
  previousVersion?: number;
  writtenAt: string;
}

// ---------------------------------------------------------------------------
// Skill canary
// ---------------------------------------------------------------------------

/** Per-arm outcome counters for a skill under canary. */
export interface SkillCanaryArm {
  runs: number;
  errors: number;
  scoreSum: number;
}

/** A learned skill being validated against live turns of its own assistant. */
export interface SkillCanaryRecord {
  skillId: string;
  scope: AssistantScope;
  trafficPercent: number;
  treatment: SkillCanaryArm;
  control: SkillCanaryArm;
  state: "running" | "promoted" | "rolled-back";
  startedAt: string;
  decidedAt?: string;
  decisionReason?: string;
}

// ---------------------------------------------------------------------------
// Turn facts
// ---------------------------------------------------------------------------

/** What triggered a turn. Background triggers are excluded from learning. */
export type TurnTrigger = "user" | "schedule" | "message" | "learning" | "api";

/**
 * Facts recorded at the turn boundary.
 *
 * These are RECORDED, not derived. The learning pass and the canary both need
 * to know what happened in a turn; answering that by re-combining node events,
 * token counters and error strings produces a different answer as soon as any
 * sibling node path changes. Writing the fact where it occurs keeps both
 * consumers correct.
 */
export interface AssistantTurnRecord {
  executionId: string;
  scope: AssistantScope;
  /** Assistant-message round trips in the turn — the learning depth signal. */
  modelIterations: number;
  toolCalls: number;
  succeeded: boolean;
  /** User stopped the turn. Distinct from `errored` — see review gating. */
  aborted: boolean;
  /** The turn failed for environmental reasons (provider/transport). */
  errored: boolean;
  trigger: TurnTrigger;
  stopReason?: string;
  /** Skill ids that were injected under canary treatment in this turn. */
  canarySkillIds?: string[];
  reviewed: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Agent-to-agent exchange
// ---------------------------------------------------------------------------

/**
 * What a grant permits.
 *
 * `message` allows enqueueing a message only. `message+read` additionally lets
 * the sender see delivery status. Neither ever conveys the receiver's
 * credentials or lets the sender execute anything in the receiver's context.
 */
export type GrantScope = "message" | "message+read";

/** An explicit, revocable authorisation for one assistant to message another. */
export interface AssistantGrant {
  id: string;
  from: AssistantScope;
  to: AssistantScope;
  scope: GrantScope;
  /**
   * User id that authorised the grant. Must be the RECEIVING side's user: the
   * receiver bears the consequence of accepting foreign input, so only they can
   * consent to it.
   */
  grantedBy: string;
  note?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** Delivery state of an inter-assistant message. */
export type AssistantMessageStatus = "pending" | "delivered" | "failed" | "expired";

/**
 * A message from one assistant to another.
 *
 * The receiver processes this in its OWN run with its OWN credentials, and the
 * body is presented to its model as untrusted evidence — never as an
 * instruction. That is the whole reason this is a queue and not a call.
 */
export interface AssistantMessage {
  id: string;
  grantId: string;
  from: AssistantScope;
  to: AssistantScope;
  subject: string;
  body: string;
  /** Links a reply back to the message that prompted it. */
  correlationId?: string;
  status: AssistantMessageStatus;
  deliveredAt?: string;
  deliveryError?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Hard caps on model-visible assistant state.
 *
 * Every one of these guards the same failure: unbounded state silently becoming
 * unbounded prompt. They are constants rather than configuration because a
 * deployment that raises them does not get a better assistant, it gets a slower
 * and more expensive one with a cold prompt cache.
 */
export const SOUL_FIELD_MAX_CHARS = 2_000;
/** A trigger line is injected on EVERY turn, so it is the tightest budget. */
export const SKILL_TRIGGER_MAX_CHARS = 160;
export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_BODY_MAX_CHARS = 20_000;
/** Skills listed in the prompt index. Beyond this, ranking decides. */
export const SKILL_INDEX_MAX_ENTRIES = 40;
/** Total characters the skill index may occupy in the prompt. */
export const SKILL_INDEX_MAX_CHARS = 8_000;
/** Total characters the rendered soul may occupy in the prompt. */
export const SOUL_RENDER_MAX_CHARS = 12_000;
/** Pending proposals per assistant. Beyond this, capture stops. */
export const MAX_PENDING_PROPOSALS = 32;

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Reason a scope could not be resolved. Returned instead of `undefined` so the
 * caller can tell the model/operator WHY there is no assistant context, rather
 * than silently running without one.
 */
export type ScopeResolutionFailure =
  | "no-user-identity"
  | "no-assistant-id"
  | "invalid-user-identity"
  | "invalid-assistant-id";

/** Discriminated result of scope resolution — never a bare `undefined`. */
export type ScopeResolution =
  | { ok: true; scope: AssistantScope }
  | { ok: false; reason: ScopeResolutionFailure; detail: string };

/**
 * Sanitises a raw identity value into an identifier segment.
 *
 * Applied to `userId`, which legitimately arrives as an email address or an
 * opaque OIDC `sub` containing characters that are unsafe as a path segment.
 * The transform is deterministic and collision-resistant *enough* for a path
 * segment because the authoritative identity remains the raw `userId` stored in
 * the database; the sanitised form is only ever used for the on-disk directory
 * name and container label.
 *
 * A value that cannot be reduced to a valid identifier yields `undefined` — the
 * caller must then fail closed rather than substitute a default.
 */
export function sanitizeIdentitySegment(raw: string): string | undefined {
  const lowered = raw.trim().toLowerCase();
  if (lowered.length === 0) return undefined;
  const replaced = lowered
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-");
  if (replaced.length === 0) return undefined;
  const bounded = replaced.slice(0, MAX_IDENTIFIER_LENGTH);
  // Truncation can leave a trailing separator; re-trim rather than emit one.
  const trimmed = bounded.replace(/[-_]+$/, "");
  if (!isValidAssistantIdentifier(trimmed)) return undefined;
  return trimmed;
}

/** Case-insensitive tenant normalisation to the sentinel when absent. */
export function normalizeTenantId(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase();
  return value === undefined || value.length === 0 ? NO_TENANT : value;
}

/**
 * Resolves the assistant scope from an authenticated identity plus a requested
 * assistant id.
 *
 * Fails closed deliberately. The platform's pre-existing memory scope resolution
 * accepted `userEmail ?? requestParams.user_id ?? conversation_id`, which means
 * an isolation boundary could come to rest on a conversation id — two different
 * people sharing a conversation id would share memory, and one person's identity
 * would change between requests. For an assistant that owns a workspace, learned
 * skills and delegated credentials, that is not an acceptable degradation, so a
 * missing identity is an error here rather than a weaker scope.
 *
 * `userId` is the raw authenticated identity (kept verbatim for storage);
 * `assistantId` must already be a valid identifier — callers normalise it via
 * {@link sanitizeIdentitySegment} when it originates from a display name.
 */
export function resolveAssistantScope(params: {
  userId: string | undefined;
  assistantId: string | undefined;
  tenantId?: string | undefined;
}): ScopeResolution {
  const userId = params.userId?.trim();
  if (userId === undefined || userId.length === 0) {
    return {
      ok: false,
      reason: "no-user-identity",
      detail:
        "The request carries no authenticated user identity. Assistants are " +
        "per-user by construction, so no assistant context can be established.",
    };
  }
  if (sanitizeIdentitySegment(userId) === undefined) {
    return {
      ok: false,
      reason: "invalid-user-identity",
      detail: `User identity ${JSON.stringify(userId)} cannot be reduced to a safe identifier.`,
    };
  }
  const assistantId = params.assistantId?.trim().toLowerCase();
  if (assistantId === undefined || assistantId.length === 0) {
    return {
      ok: false,
      reason: "no-assistant-id",
      detail:
        "No assistant was selected for this request. Select one by requesting the " +
        'model `assistant-<id>`, by sending `metadata.assistant_id`, or by giving ' +
        "the flow's `assistant-context` node a `defaultAssistantId` so a request " +
        "that names none still resolves.",
    };
  }
  if (!isValidAssistantIdentifier(assistantId)) {
    return {
      ok: false,
      reason: "invalid-assistant-id",
      detail:
        `Assistant id ${JSON.stringify(assistantId)} is not a valid identifier ` +
        `(lowercase alphanumerics, "-" and "_", starting with an alphanumeric, ` +
        `at most ${MAX_IDENTIFIER_LENGTH} characters).`,
    };
  }
  return {
    ok: true,
    scope: {
      tenantId: normalizeTenantId(params.tenantId),
      userId,
      assistantId,
    },
  };
}

/**
 * Stable, collision-resistant string form of a scope.
 *
 * Uses the unit-separator (U+001F) as the delimiter, mirroring the existing
 * memory-collection key convention: it cannot occur in any of the three
 * components, so the encoding is unambiguous without escaping.
 */
export function scopeKey(scope: AssistantScope): string {
  return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}`;
}

/** True when two scopes denote the same assistant. */
export function sameScope(a: AssistantScope, b: AssistantScope): boolean {
  return a.tenantId === b.tenantId && a.userId === b.userId && a.assistantId === b.assistantId;
}

/** URL-safe opaque id for a scope, used in route params. */
export function encodeScopeParam(scope: AssistantScope): string {
  return Buffer.from(scopeKey(scope), "utf8").toString("base64url");
}

/** Inverse of {@link encodeScopeParam}; `undefined` when malformed. */
export function decodeScopeParam(param: string): AssistantScope | undefined {
  let raw: string;
  try {
    raw = Buffer.from(param, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const parts = raw.split("\u001f");
  if (parts.length !== 3) return undefined;
  const [tenantId, userId, assistantId] = parts;
  if (tenantId === undefined || userId === undefined || assistantId === undefined) {
    return undefined;
  }
  if (userId.length === 0 || !isValidAssistantIdentifier(assistantId)) {
    return undefined;
  }
  return { tenantId, userId, assistantId };
}
