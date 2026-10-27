// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill proposal state machine (`src/assistants/proposal-store.ts`)
 *
 * The lifecycle of a learned procedure between "the model suggested it" and "it is
 * in the prompt":
 *
 *   pending ──apply──▶ applied
 *      │  ├──reject──▶ rejected
 *      │  ├─quarantine─▶ quarantined      (scan found something critical)
 *      │  └──stale────▶ stale             (target changed underneath it)
 *      └── revise ──▶ pending (revision + 1)
 *
 * Four properties make this safe enough to run without a human in the loop:
 *
 * 1. **Scan gate.** `apply` requires `scan_state = 'clean'`. `pending` and
 *    `failed` are refused as firmly as `quarantined` — an unchecked proposal and a
 *    rejected one are equally unfit to enter a prompt.
 *
 * 2. **Optimistic lock.** Every mutation states the revision hash it read. A
 *    reviewer revising a proposal while an operator rejects it loses the race
 *    visibly instead of overwriting the decision.
 *
 * 3. **Rollback record.** Written BEFORE the skill is touched, holding the exact
 *    prior content. Every apply is therefore reversible without replaying history.
 *
 * 4. **Append-only event log.** State lives in the proposals table and is mutated;
 *    history lives in the events table and is not. An audit answer assembled from
 *    a mutable row is not evidence.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { toIso } from "./assistant-store.js";
import { scanBlockReason, scanPermitsApply, scanProposal } from "./proposal-scanner.js";
import { normalizeTriggerLine } from "./skill-index.js";
import {
  normalizeSkillBody,
  normalizeSkillName,
  skillBodyHash,
  type SkillStore,
} from "./skill-store.js";
import {
  MAX_PENDING_PROPOSALS,
  type AssistantScope,
  type ProposalCreator,
  type ProposalEvent,
  type ProposalEventType,
  type ProposalKind,
  type ProposalRecord,
  type ProposalScanFinding,
  type ProposalScanState,
  type ProposalStatus,
  type SkillRecord,
  type SkillRollbackRecord,
  type SoulActorType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a mutation's expected revision hash does not match. */
export class ProposalConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly currentRevisionHash: string,
  ) {
    super(
      `Proposal was modified concurrently (now at revision ${currentRevision}). ` +
        "Re-read it and re-apply your change against the current revision.",
    );
    this.name = "ProposalConflictError";
  }
}

/** Raised when a transition is not legal from the current status. */
export class ProposalTransitionError extends Error {
  constructor(
    readonly from: ProposalStatus,
    readonly to: ProposalStatus,
    detail?: string,
  ) {
    super(
      `A proposal cannot go from "${from}" to "${to}".` +
        (detail !== undefined ? ` ${detail}` : ""),
    );
    this.name = "ProposalTransitionError";
  }
}

/** Raised when apply is blocked by the safety scan. */
export class ProposalScanBlockedError extends Error {
  constructor(readonly scanState: ProposalScanState) {
    super(scanBlockReason(scanState) ?? "The safety scan does not permit applying this proposal.");
    this.name = "ProposalScanBlockedError";
  }
}

/** Raised when the pending-proposal cap is reached. */
export class ProposalLimitError extends Error {
  constructor(
    readonly pending: number,
    readonly limit: number,
  ) {
    super(
      `This assistant already has ${pending} undecided proposals (limit ${limit}). ` +
        "Decide some before proposing more.",
    );
    this.name = "ProposalLimitError";
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Legal terminal transitions from `pending`.
 *
 * Only `pending` has outgoing transitions: a decided proposal is final. Reopening
 * one would make the event log ambiguous about which decision was in force at a
 * point in time, and "decide again" is expressible as a new proposal.
 */
const TERMINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  "applied",
  "rejected",
  "quarantined",
  "stale",
]);

/** True when `status` permits any further mutation. */
export function isMutableStatus(status: ProposalStatus): boolean {
  return status === "pending";
}

// ---------------------------------------------------------------------------
// Revision hashing
// ---------------------------------------------------------------------------

/**
 * Content hash serving as the optimistic-lock token.
 *
 * Covers the fields a mutation can change plus the status, so a decision (which
 * changes only the status) also invalidates a concurrent revision's token.
 */
export function proposalRevisionHash(params: {
  status: ProposalStatus;
  revision: number;
  targetSkill: string;
  triggerLine: string;
  body: string;
  scanState: ProposalScanState;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      [
        params.status,
        String(params.revision),
        params.targetSkill,
        params.triggerLine,
        params.body,
        params.scanState,
      ].join("\u001f"),
      "utf8",
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface ProposalCreateInput {
  scope: AssistantScope;
  kind: ProposalKind;
  /** Name of the skill this proposal targets. */
  targetSkill: string;
  title: string;
  triggerLine: string;
  body: string;
  goal?: string;
  evidence?: string;
  createdBy: ProposalCreator;
  /** True for proposals written by an autonomous learning pass. */
  autonomousCapture?: boolean;
  originExecutionId?: string;
  originRunId?: string;
  actorType: SoulActorType;
  actorId?: string;
}

export interface ProposalReviseInput {
  scope: AssistantScope;
  proposalId: string;
  expectedRevisionHash?: string;
  title?: string;
  triggerLine?: string;
  body?: string;
  goal?: string;
  evidence?: string;
  actorType: SoulActorType;
  actorId?: string;
}

export interface ProposalDecisionInput {
  scope: AssistantScope;
  proposalId: string;
  expectedRevisionHash?: string;
  reason?: string;
  actorType: SoulActorType;
  actorId?: string;
}

export interface ProposalApplyResult {
  proposal: ProposalRecord;
  skill: SkillRecord;
  rollback: SkillRollbackRecord;
}

export interface ProposalStore {
  create(input: ProposalCreateInput): Promise<ProposalRecord>;
  revise(input: ProposalReviseInput): Promise<ProposalRecord>;
  get(scope: AssistantScope, proposalId: string): Promise<ProposalRecord | undefined>;
  list(
    scope: AssistantScope,
    options?: { status?: ProposalStatus; limit?: number },
  ): Promise<ProposalRecord[]>;
  countPending(scope: AssistantScope): Promise<number>;
  /**
   * Applies the proposal to the live skill set.
   *
   * @param options.asCanary Applies the skill in `canary` status so it is injected
   *   into only a fraction of turns while its effect is measured. This is the
   *   staged-rollout path for autonomously captured procedures.
   */
  apply(input: ProposalDecisionInput & { asCanary?: boolean }): Promise<ProposalApplyResult>;
  reject(input: ProposalDecisionInput): Promise<ProposalRecord>;
  quarantine(input: ProposalDecisionInput): Promise<ProposalRecord>;
  /** Marks a proposal stale because its target changed underneath it. */
  markStale(input: ProposalDecisionInput): Promise<ProposalRecord>;
  /** Reverses an applied proposal using its rollback record. */
  rollback(input: ProposalDecisionInput): Promise<ProposalRecord>;
  events(
    scope: AssistantScope,
    options?: { proposalId?: string; limit?: number },
  ): Promise<ProposalEvent[]>;
  purge(scope: AssistantScope): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 200;
const MAX_GOAL_CHARS = 1_000;
const MAX_EVIDENCE_CHARS = 4_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function boundLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

function boundText(raw: string | undefined, max: number): string | undefined {
  const value = raw?.replace(/\s+/g, " ").trim();
  if (value === undefined || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/** Normalises and scans proposal content. Shared by create and revise. */
function prepareContent(params: { targetSkill: string; triggerLine: string; body: string }): {
  targetSkill: string;
  triggerLine: string;
  body: string;
  bodyHash: string;
  scanState: ProposalScanState;
  findings: ProposalScanFinding[];
} {
  const targetSkill = normalizeSkillName(params.targetSkill);
  const triggerLine = normalizeTriggerLine(params.triggerLine);
  const body = normalizeSkillBody(params.body);
  // Scanned at write time, not at apply time. A proposal that was never scanned
  // could otherwise sit in `pending` looking decidable, and an operator clicking
  // apply would be the one to discover it is unscannable.
  const scan = scanProposal({ triggerLine, body });
  return {
    targetSkill,
    triggerLine,
    body,
    bodyHash: skillBodyHash(triggerLine, body),
    scanState: scan.state,
    findings: scan.findings,
  };
}

function assertMutable(record: ProposalRecord, to: ProposalStatus): void {
  if (!isMutableStatus(record.status)) {
    throw new ProposalTransitionError(
      record.status,
      to,
      TERMINAL_STATUSES.has(record.status)
        ? "The proposal is already decided. Create a new proposal instead of reopening this one."
        : undefined,
    );
  }
}

function assertLock(record: ProposalRecord, expectedRevisionHash: string | undefined): void {
  if (expectedRevisionHash !== undefined && expectedRevisionHash !== record.revisionHash) {
    throw new ProposalConflictError(record.revision, record.revisionHash);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface MemoryState {
  proposals: Map<string, ProposalRecord>;
  events: ProposalEvent[];
  rollbacks: Map<string, SkillRollbackRecord>;
  sequence: number;
}

/**
 * Process-local proposal store.
 *
 * Shares the validation and transition helpers above with the Postgres variant so
 * the two cannot diverge on the rules that matter (scan gate, lock, transitions).
 */
export class InMemoryProposalStore implements ProposalStore {
  private readonly states = new Map<string, MemoryState>();

  constructor(private readonly skills: SkillStore) {}

  private key(scope: AssistantScope): string {
    return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}`;
  }

  private state(scope: AssistantScope): MemoryState {
    const existing = this.states.get(this.key(scope));
    if (existing !== undefined) return existing;
    const created: MemoryState = {
      proposals: new Map(),
      events: [],
      rollbacks: new Map(),
      sequence: 0,
    };
    this.states.set(this.key(scope), created);
    return created;
  }

  private record(
    scope: AssistantScope,
    proposal: ProposalRecord,
    eventType: ProposalEventType,
    actorType: SoulActorType,
    actorId: string | undefined,
    payload?: Record<string, unknown>,
  ): void {
    const state = this.state(scope);
    state.sequence += 1;
    state.events.push({
      sequence: state.sequence,
      proposalId: proposal.id,
      eventType,
      revision: proposal.revision,
      revisionHash: proposal.revisionHash,
      actorType,
      ...(actorId !== undefined ? { actorId } : {}),
      ...(payload !== undefined ? { payload } : {}),
      occurredAt: new Date().toISOString(),
    });
  }

  async create(input: ProposalCreateInput): Promise<ProposalRecord> {
    const state = this.state(input.scope);
    const pending = [...state.proposals.values()].filter((p) => p.status === "pending").length;
    if (pending >= MAX_PENDING_PROPOSALS) {
      throw new ProposalLimitError(pending, MAX_PENDING_PROPOSALS);
    }
    const content = prepareContent(input);
    const now = new Date().toISOString();
    const revision = 1;
    const record: ProposalRecord = {
      id: crypto.randomUUID(),
      scope: input.scope,
      kind: input.kind,
      status: "pending",
      targetSkill: content.targetSkill,
      title: boundText(input.title, MAX_TITLE_CHARS) ?? content.targetSkill,
      triggerLine: content.triggerLine,
      body: content.body,
      bodyHash: content.bodyHash,
      revision,
      revisionHash: proposalRevisionHash({
        status: "pending",
        revision,
        targetSkill: content.targetSkill,
        triggerLine: content.triggerLine,
        body: content.body,
        scanState: content.scanState,
      }),
      ...(boundText(input.goal, MAX_GOAL_CHARS) !== undefined
        ? { goal: boundText(input.goal, MAX_GOAL_CHARS) }
        : {}),
      ...(boundText(input.evidence, MAX_EVIDENCE_CHARS) !== undefined
        ? { evidence: boundText(input.evidence, MAX_EVIDENCE_CHARS) }
        : {}),
      autonomousCapture: input.autonomousCapture === true,
      createdBy: input.createdBy,
      scanState: content.scanState,
      ...(content.findings.length > 0 ? { scanFindings: content.findings } : {}),
      ...(input.originExecutionId !== undefined
        ? { originExecutionId: input.originExecutionId }
        : {}),
      ...(input.originRunId !== undefined ? { originRunId: input.originRunId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    state.proposals.set(record.id, record);
    this.record(input.scope, record, "created", input.actorType, input.actorId, {
      scanState: content.scanState,
      critical: content.findings.filter((f) => f.severity === "critical").length,
    });
    // The scan result is itself an event: "when was this checked and what did the
    // check say" must be answerable without re-running the scan.
    this.record(input.scope, record, "scanned", "system", undefined, {
      scanState: content.scanState,
      findings: content.findings.length,
    });
    return record;
  }

  async revise(input: ProposalReviseInput): Promise<ProposalRecord> {
    const state = this.state(input.scope);
    const existing = state.proposals.get(input.proposalId);
    if (existing === undefined) {
      throw new Error(`Proposal ${input.proposalId} not found.`);
    }
    assertLock(existing, input.expectedRevisionHash);
    assertMutable(existing, "pending");
    const content = prepareContent({
      targetSkill: existing.targetSkill,
      triggerLine: input.triggerLine ?? existing.triggerLine,
      body: input.body ?? existing.body,
    });
    const revision = existing.revision + 1;
    const next: ProposalRecord = {
      ...existing,
      title: boundText(input.title, MAX_TITLE_CHARS) ?? existing.title,
      triggerLine: content.triggerLine,
      body: content.body,
      bodyHash: content.bodyHash,
      revision,
      revisionHash: proposalRevisionHash({
        status: "pending",
        revision,
        targetSkill: content.targetSkill,
        triggerLine: content.triggerLine,
        body: content.body,
        scanState: content.scanState,
      }),
      scanState: content.scanState,
      ...(content.findings.length > 0
        ? { scanFindings: content.findings }
        : { scanFindings: undefined }),
      updatedAt: new Date().toISOString(),
    };
    if (boundText(input.goal, MAX_GOAL_CHARS) !== undefined) {
      next.goal = boundText(input.goal, MAX_GOAL_CHARS);
    }
    if (boundText(input.evidence, MAX_EVIDENCE_CHARS) !== undefined) {
      next.evidence = boundText(input.evidence, MAX_EVIDENCE_CHARS);
    }
    state.proposals.set(next.id, next);
    this.record(input.scope, next, "revised", input.actorType, input.actorId);
    this.record(input.scope, next, "scanned", "system", undefined, {
      scanState: content.scanState,
      findings: content.findings.length,
    });
    return next;
  }

  async get(scope: AssistantScope, proposalId: string): Promise<ProposalRecord | undefined> {
    return this.state(scope).proposals.get(proposalId);
  }

  async list(
    scope: AssistantScope,
    options: { status?: ProposalStatus; limit?: number } = {},
  ): Promise<ProposalRecord[]> {
    const all = [...this.state(scope).proposals.values()];
    const filtered =
      options.status !== undefined ? all.filter((p) => p.status === options.status) : all;
    return filtered
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, boundLimit(options.limit));
  }

  async countPending(scope: AssistantScope): Promise<number> {
    return [...this.state(scope).proposals.values()].filter((p) => p.status === "pending").length;
  }

  async apply(input: ProposalDecisionInput & { asCanary?: boolean }): Promise<ProposalApplyResult> {
    const state = this.state(input.scope);
    const existing = state.proposals.get(input.proposalId);
    if (existing === undefined) {
      throw new Error(`Proposal ${input.proposalId} not found.`);
    }
    assertLock(existing, input.expectedRevisionHash);
    assertMutable(existing, "applied");
    if (!scanPermitsApply(existing.scanState)) {
      throw new ProposalScanBlockedError(existing.scanState);
    }

    // Rollback is captured BEFORE the skill is touched. Doing it after would leave
    // a window in which the prior content is already gone and unrecorded.
    const prior = await this.skills.getByName(input.scope, existing.targetSkill);
    const rollback: SkillRollbackRecord = {
      proposalId: existing.id,
      ...(prior !== undefined ? { skillId: prior.id } : {}),
      action: prior !== undefined ? "update" : "create",
      ...(prior !== undefined
        ? {
            previousName: prior.name,
            previousTrigger: prior.triggerLine,
            previousBody: prior.body,
            previousVersion: prior.version,
          }
        : {}),
      writtenAt: new Date().toISOString(),
    };
    state.rollbacks.set(existing.id, rollback);

    const skill = await this.skills.upsert({
      scope: input.scope,
      name: existing.targetSkill,
      triggerLine: existing.triggerLine,
      body: existing.body,
      origin: existing.autonomousCapture ? "learned" : "user",
      status: input.asCanary === true ? "canary" : "active",
    });

    const now = new Date().toISOString();
    const applied: ProposalRecord = {
      ...existing,
      status: "applied",
      targetSkillId: skill.id,
      revisionHash: proposalRevisionHash({
        status: "applied",
        revision: existing.revision,
        targetSkill: existing.targetSkill,
        triggerLine: existing.triggerLine,
        body: existing.body,
        scanState: existing.scanState,
      }),
      ...(input.reason !== undefined ? { statusReason: input.reason } : {}),
      updatedAt: now,
      decidedAt: now,
    };
    state.proposals.set(applied.id, applied);
    this.record(input.scope, applied, "applied", input.actorType, input.actorId, {
      skillId: skill.id,
      canary: input.asCanary === true,
    });
    return { proposal: applied, skill, rollback };
  }

  private async decide(
    input: ProposalDecisionInput,
    status: Extract<ProposalStatus, "rejected" | "quarantined" | "stale">,
    eventType: ProposalEventType,
  ): Promise<ProposalRecord> {
    const state = this.state(input.scope);
    const existing = state.proposals.get(input.proposalId);
    if (existing === undefined) {
      throw new Error(`Proposal ${input.proposalId} not found.`);
    }
    assertLock(existing, input.expectedRevisionHash);
    assertMutable(existing, status);
    const now = new Date().toISOString();
    const next: ProposalRecord = {
      ...existing,
      status,
      revisionHash: proposalRevisionHash({
        status,
        revision: existing.revision,
        targetSkill: existing.targetSkill,
        triggerLine: existing.triggerLine,
        body: existing.body,
        scanState: existing.scanState,
      }),
      ...(input.reason !== undefined ? { statusReason: input.reason } : {}),
      updatedAt: now,
      decidedAt: now,
    };
    state.proposals.set(next.id, next);
    this.record(input.scope, next, eventType, input.actorType, input.actorId);
    return next;
  }

  reject(input: ProposalDecisionInput): Promise<ProposalRecord> {
    return this.decide(input, "rejected", "rejected");
  }

  quarantine(input: ProposalDecisionInput): Promise<ProposalRecord> {
    return this.decide(input, "quarantined", "quarantined");
  }

  markStale(input: ProposalDecisionInput): Promise<ProposalRecord> {
    return this.decide(input, "stale", "stale");
  }

  async rollback(input: ProposalDecisionInput): Promise<ProposalRecord> {
    const state = this.state(input.scope);
    const existing = state.proposals.get(input.proposalId);
    if (existing === undefined) {
      throw new Error(`Proposal ${input.proposalId} not found.`);
    }
    if (existing.status !== "applied") {
      throw new ProposalTransitionError(
        existing.status,
        "rejected",
        "Only an applied proposal can be rolled back.",
      );
    }
    const rollback = state.rollbacks.get(existing.id);
    if (rollback === undefined) {
      throw new Error(
        `No rollback record exists for proposal ${existing.id}; its effect cannot be reversed automatically.`,
      );
    }
    if (rollback.action === "create") {
      // The apply created the skill, so reversal retires it. Retirement rather
      // than deletion keeps the row that the event log and this proposal refer to.
      await this.skills.retire(
        input.scope,
        existing.targetSkill,
        input.reason ?? "Proposal rolled back",
      );
    } else {
      await this.skills.patch(input.scope, existing.targetSkill, {
        ...(rollback.previousTrigger !== undefined
          ? { triggerLine: rollback.previousTrigger }
          : {}),
        ...(rollback.previousBody !== undefined ? { body: rollback.previousBody } : {}),
        status: "active",
      });
    }
    const next: ProposalRecord = {
      ...existing,
      statusReason: input.reason ?? "Rolled back",
      updatedAt: new Date().toISOString(),
    };
    state.proposals.set(next.id, next);
    this.record(input.scope, next, "canary_rolled_back", input.actorType, input.actorId, {
      action: rollback.action,
    });
    return next;
  }

  async events(
    scope: AssistantScope,
    options: { proposalId?: string; limit?: number } = {},
  ): Promise<ProposalEvent[]> {
    const all = this.state(scope).events;
    const filtered =
      options.proposalId !== undefined
        ? all.filter((e) => e.proposalId === options.proposalId)
        : all;
    return [...filtered].reverse().slice(0, boundLimit(options.limit));
  }

  async purge(scope: AssistantScope): Promise<void> {
    this.states.delete(this.key(scope));
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface ProposalRow {
  id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  kind: string;
  status: string;
  target_skill: string;
  target_skill_id: string | null;
  title: string;
  trigger_line: string;
  body: string;
  body_hash: string;
  revision: number;
  revision_hash: string;
  goal: string | null;
  evidence: string | null;
  autonomous_capture: boolean;
  created_by: string;
  scan_state: string;
  scan_findings: unknown;
  origin_execution_id: string | null;
  origin_run_id: string | null;
  status_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  decided_at: string | Date | null;
}

function parseFindings(value: unknown): ProposalScanFinding[] | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(raw) ? (raw as ProposalScanFinding[]) : undefined;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToProposal(row: ProposalRow): ProposalRecord {
  const findings = parseFindings(row.scan_findings);
  const decidedAt = toIso(row.decided_at);
  return {
    id: row.id,
    scope: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      assistantId: row.assistant_id,
    },
    kind: row.kind as ProposalKind,
    status: row.status as ProposalStatus,
    targetSkill: row.target_skill,
    ...(row.target_skill_id !== null ? { targetSkillId: row.target_skill_id } : {}),
    title: row.title,
    triggerLine: row.trigger_line,
    body: row.body,
    bodyHash: row.body_hash,
    revision: Number(row.revision),
    revisionHash: row.revision_hash,
    ...(row.goal !== null ? { goal: row.goal } : {}),
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    autonomousCapture: row.autonomous_capture === true,
    createdBy: row.created_by as ProposalCreator,
    scanState: row.scan_state as ProposalScanState,
    ...(findings !== undefined && findings.length > 0 ? { scanFindings: findings } : {}),
    ...(row.origin_execution_id !== null ? { originExecutionId: row.origin_execution_id } : {}),
    ...(row.origin_run_id !== null ? { originRunId: row.origin_run_id } : {}),
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
  };
}

/** Durable proposal store. */
export class PostgresProposalStore implements ProposalStore {
  constructor(
    private readonly db: Database,
    private readonly skills: SkillStore,
    private readonly logger?: Logger,
  ) {}

  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  private async appendEvent(
    db: Database,
    proposal: ProposalRecord,
    eventType: ProposalEventType,
    actorType: SoulActorType,
    actorId: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await db.query(
      `INSERT INTO assistant_skill_proposal_events
         (proposal_id, event_type, revision, revision_hash, actor_type, actor_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)`,
      [
        proposal.id,
        eventType,
        proposal.revision,
        proposal.revisionHash,
        actorType,
        actorId ?? null,
        payload !== undefined ? JSON.stringify(payload) : null,
      ],
    );
  }

  async create(input: ProposalCreateInput): Promise<ProposalRecord> {
    const content = prepareContent(input);
    const revision = 1;
    const revisionHash = proposalRevisionHash({
      status: "pending",
      revision,
      targetSkill: content.targetSkill,
      triggerLine: content.triggerLine,
      body: content.body,
      scanState: content.scanState,
    });
    return this.scoped(input.scope.tenantId, async (db) => {
      // The cap is enforced inside the same scoped call as the insert so a burst
      // of concurrent learning passes cannot each observe "under the limit" and
      // collectively exceed it. Under RLS this is one transaction; without it the
      // window is a few milliseconds and the consequence is a slightly high count,
      // not a correctness problem.
      const pendingRows = await db.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM assistant_skill_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND status = 'pending'`,
        [input.scope.tenantId, input.scope.userId, input.scope.assistantId],
      );
      const pending = Number(pendingRows[0]?.count ?? 0);
      if (pending >= MAX_PENDING_PROPOSALS) {
        throw new ProposalLimitError(pending, MAX_PENDING_PROPOSALS);
      }

      const rows = await db.query<ProposalRow>(
        `INSERT INTO assistant_skill_proposals
           (id, tenant_id, user_id, assistant_id, kind, status, target_skill,
            title, trigger_line, body, body_hash, revision, revision_hash,
            goal, evidence, autonomous_capture, created_by, scan_state,
            scan_findings, origin_execution_id, origin_run_id)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18::text::jsonb, $19, $20)
         RETURNING *`,
        [
          crypto.randomUUID(),
          input.scope.tenantId,
          input.scope.userId,
          input.scope.assistantId,
          input.kind,
          content.targetSkill,
          boundText(input.title, MAX_TITLE_CHARS) ?? content.targetSkill,
          content.triggerLine,
          content.body,
          content.bodyHash,
          revision,
          revisionHash,
          boundText(input.goal, MAX_GOAL_CHARS) ?? null,
          boundText(input.evidence, MAX_EVIDENCE_CHARS) ?? null,
          input.autonomousCapture === true,
          input.createdBy,
          content.scanState,
          content.findings.length > 0 ? JSON.stringify(content.findings) : null,
          input.originExecutionId ?? null,
          input.originRunId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Creating a skill proposal returned no row.");
      }
      const record = rowToProposal(row);
      await this.appendEvent(db, record, "created", input.actorType, input.actorId, {
        scanState: content.scanState,
      });
      await this.appendEvent(db, record, "scanned", "system", undefined, {
        scanState: content.scanState,
        findings: content.findings.length,
      });
      this.logger?.info("Skill proposal created", {
        assistantId: input.scope.assistantId,
        proposalId: record.id,
        targetSkill: record.targetSkill,
        scanState: record.scanState,
      });
      return record;
    });
  }

  async revise(input: ProposalReviseInput): Promise<ProposalRecord> {
    return this.scoped(input.scope.tenantId, async (db) => {
      const existing = await this.readInTx(db, input.scope, input.proposalId);
      assertLock(existing, input.expectedRevisionHash);
      assertMutable(existing, "pending");
      const content = prepareContent({
        targetSkill: existing.targetSkill,
        triggerLine: input.triggerLine ?? existing.triggerLine,
        body: input.body ?? existing.body,
      });
      const revision = existing.revision + 1;
      const revisionHash = proposalRevisionHash({
        status: "pending",
        revision,
        targetSkill: content.targetSkill,
        triggerLine: content.triggerLine,
        body: content.body,
        scanState: content.scanState,
      });
      const rows = await db.query<ProposalRow>(
        `UPDATE assistant_skill_proposals
            SET title = COALESCE($5, title),
                trigger_line = $6,
                body = $7,
                body_hash = $8,
                revision = $9,
                revision_hash = $10,
                goal = COALESCE($11, goal),
                evidence = COALESCE($12, evidence),
                scan_state = $13,
                scan_findings = $14::text::jsonb,
                updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4
            -- Compare-and-set on the revision we read, so a concurrent decision
            -- is not overwritten by this revision.
            AND revision = $15 AND status = 'pending'
          RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.userId,
          input.scope.assistantId,
          input.proposalId,
          boundText(input.title, MAX_TITLE_CHARS) ?? null,
          content.triggerLine,
          content.body,
          content.bodyHash,
          revision,
          revisionHash,
          boundText(input.goal, MAX_GOAL_CHARS) ?? null,
          boundText(input.evidence, MAX_EVIDENCE_CHARS) ?? null,
          content.scanState,
          content.findings.length > 0 ? JSON.stringify(content.findings) : null,
          existing.revision,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        const latest = await this.readInTx(db, input.scope, input.proposalId);
        throw new ProposalConflictError(latest.revision, latest.revisionHash);
      }
      const record = rowToProposal(row);
      await this.appendEvent(db, record, "revised", input.actorType, input.actorId);
      await this.appendEvent(db, record, "scanned", "system", undefined, {
        scanState: content.scanState,
        findings: content.findings.length,
      });
      return record;
    });
  }

  private async readInTx(
    db: Database,
    scope: AssistantScope,
    proposalId: string,
  ): Promise<ProposalRecord> {
    const rows = await db.query<ProposalRow>(
      `SELECT * FROM assistant_skill_proposals
        WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4`,
      [scope.tenantId, scope.userId, scope.assistantId, proposalId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Proposal ${proposalId} not found.`);
    }
    return rowToProposal(row);
  }

  async get(scope: AssistantScope, proposalId: string): Promise<ProposalRecord | undefined> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<ProposalRow>(
        `SELECT * FROM assistant_skill_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, proposalId],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToProposal(row);
  }

  async list(
    scope: AssistantScope,
    options: { status?: ProposalStatus; limit?: number } = {},
  ): Promise<ProposalRecord[]> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<ProposalRow>(
        `SELECT * FROM assistant_skill_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND ($4::text IS NULL OR status = $4)
          ORDER BY created_at DESC
          LIMIT $5`,
        [
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          options.status ?? null,
          boundLimit(options.limit),
        ],
      ),
    );
    return rows.map(rowToProposal);
  }

  async countPending(scope: AssistantScope): Promise<number> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM assistant_skill_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND status = 'pending'`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async apply(input: ProposalDecisionInput & { asCanary?: boolean }): Promise<ProposalApplyResult> {
    const existing = await this.get(input.scope, input.proposalId);
    if (existing === undefined) {
      throw new Error(`Proposal ${input.proposalId} not found.`);
    }
    assertLock(existing, input.expectedRevisionHash);
    assertMutable(existing, "applied");
    if (!scanPermitsApply(existing.scanState)) {
      throw new ProposalScanBlockedError(existing.scanState);
    }

    const prior = await this.skills.getByName(input.scope, existing.targetSkill);
    const rollback: SkillRollbackRecord = {
      proposalId: existing.id,
      ...(prior !== undefined ? { skillId: prior.id } : {}),
      action: prior !== undefined ? "update" : "create",
      ...(prior !== undefined
        ? {
            previousName: prior.name,
            previousTrigger: prior.triggerLine,
            previousBody: prior.body,
            previousVersion: prior.version,
          }
        : {}),
      writtenAt: new Date().toISOString(),
    };

    // Rollback row first, then the skill write, then the status flip. The order is
    // the recovery story: a crash after step 1 leaves an unused rollback row
    // (harmless), after step 2 leaves an applied skill with a still-pending
    // proposal (visible and re-runnable), and only after step 3 is the transition
    // complete. The reverse order would leave an applied proposal whose effect
    // cannot be reversed.
    await this.scoped(input.scope.tenantId, (db) =>
      db.query(
        `INSERT INTO assistant_skill_rollbacks
           (proposal_id, skill_id, action, previous_name, previous_trigger,
            previous_body, previous_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (proposal_id) DO NOTHING`,
        [
          rollback.proposalId,
          rollback.skillId ?? null,
          rollback.action,
          rollback.previousName ?? null,
          rollback.previousTrigger ?? null,
          rollback.previousBody ?? null,
          rollback.previousVersion ?? null,
        ],
      ),
    );

    const skill = await this.skills.upsert({
      scope: input.scope,
      name: existing.targetSkill,
      triggerLine: existing.triggerLine,
      body: existing.body,
      origin: existing.autonomousCapture ? "learned" : "user",
      status: input.asCanary === true ? "canary" : "active",
    });

    const revisionHash = proposalRevisionHash({
      status: "applied",
      revision: existing.revision,
      targetSkill: existing.targetSkill,
      triggerLine: existing.triggerLine,
      body: existing.body,
      scanState: existing.scanState,
    });
    return this.scoped(input.scope.tenantId, async (db) => {
      const rows = await db.query<ProposalRow>(
        `UPDATE assistant_skill_proposals
            SET status = 'applied',
                target_skill_id = $5,
                revision_hash = $6,
                status_reason = COALESCE($7, status_reason),
                updated_at = now(),
                decided_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4
            AND status = 'pending' AND revision = $8
          RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.userId,
          input.scope.assistantId,
          input.proposalId,
          skill.id,
          revisionHash,
          input.reason ?? null,
          existing.revision,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        const latest = await this.readInTx(db, input.scope, input.proposalId);
        throw new ProposalConflictError(latest.revision, latest.revisionHash);
      }
      const record = rowToProposal(row);
      await this.appendEvent(db, record, "applied", input.actorType, input.actorId, {
        skillId: skill.id,
        canary: input.asCanary === true,
      });
      this.logger?.info("Skill proposal applied", {
        assistantId: input.scope.assistantId,
        proposalId: record.id,
        skill: record.targetSkill,
        canary: input.asCanary === true,
      });
      return { proposal: record, skill, rollback };
    });
  }

  private async decide(
    input: ProposalDecisionInput,
    status: Extract<ProposalStatus, "rejected" | "quarantined" | "stale">,
    eventType: ProposalEventType,
  ): Promise<ProposalRecord> {
    return this.scoped(input.scope.tenantId, async (db) => {
      const existing = await this.readInTx(db, input.scope, input.proposalId);
      assertLock(existing, input.expectedRevisionHash);
      assertMutable(existing, status);
      const revisionHash = proposalRevisionHash({
        status,
        revision: existing.revision,
        targetSkill: existing.targetSkill,
        triggerLine: existing.triggerLine,
        body: existing.body,
        scanState: existing.scanState,
      });
      const rows = await db.query<ProposalRow>(
        `UPDATE assistant_skill_proposals
            SET status = $5,
                revision_hash = $6,
                status_reason = COALESCE($7, status_reason),
                updated_at = now(),
                decided_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4
            AND status = 'pending' AND revision = $8
          RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.userId,
          input.scope.assistantId,
          input.proposalId,
          status,
          revisionHash,
          input.reason ?? null,
          existing.revision,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        const latest = await this.readInTx(db, input.scope, input.proposalId);
        throw new ProposalConflictError(latest.revision, latest.revisionHash);
      }
      const record = rowToProposal(row);
      await this.appendEvent(db, record, eventType, input.actorType, input.actorId);
      return record;
    });
  }

  reject(input: ProposalDecisionInput): Promise<ProposalRecord> {
    return this.decide(input, "rejected", "rejected");
  }

  quarantine(input: ProposalDecisionInput): Promise<ProposalRecord> {
    return this.decide(input, "quarantined", "quarantined");
  }

  markStale(input: ProposalDecisionInput): Promise<ProposalRecord> {
    return this.decide(input, "stale", "stale");
  }

  async rollback(input: ProposalDecisionInput): Promise<ProposalRecord> {
    const existing = await this.get(input.scope, input.proposalId);
    if (existing === undefined) {
      throw new Error(`Proposal ${input.proposalId} not found.`);
    }
    if (existing.status !== "applied") {
      throw new ProposalTransitionError(
        existing.status,
        "rejected",
        "Only an applied proposal can be rolled back.",
      );
    }
    const rows = await this.scoped(input.scope.tenantId, (db) =>
      db.query<{
        action: string;
        previous_trigger: string | null;
        previous_body: string | null;
      }>(
        `SELECT action, previous_trigger, previous_body
           FROM assistant_skill_rollbacks WHERE proposal_id = $1`,
        [existing.id],
      ),
    );
    const rollbackRow = rows[0];
    if (rollbackRow === undefined) {
      throw new Error(
        `No rollback record exists for proposal ${existing.id}; its effect cannot be reversed automatically.`,
      );
    }
    if (rollbackRow.action === "create") {
      await this.skills.retire(
        input.scope,
        existing.targetSkill,
        input.reason ?? "Proposal rolled back",
      );
    } else {
      await this.skills.patch(input.scope, existing.targetSkill, {
        ...(rollbackRow.previous_trigger !== null
          ? { triggerLine: rollbackRow.previous_trigger }
          : {}),
        ...(rollbackRow.previous_body !== null ? { body: rollbackRow.previous_body } : {}),
        status: "active",
      });
    }
    return this.scoped(input.scope.tenantId, async (db) => {
      const updated = await db.query<ProposalRow>(
        `UPDATE assistant_skill_proposals
            SET status_reason = $5, updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3 AND id = $4
          RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.userId,
          input.scope.assistantId,
          input.proposalId,
          input.reason ?? "Rolled back",
        ],
      );
      const row = updated[0];
      const record = row !== undefined ? rowToProposal(row) : existing;
      await this.appendEvent(db, record, "canary_rolled_back", input.actorType, input.actorId, {
        action: rollbackRow.action,
      });
      this.logger?.info("Skill proposal rolled back", {
        assistantId: input.scope.assistantId,
        proposalId: record.id,
        action: rollbackRow.action,
      });
      return record;
    });
  }

  async events(
    scope: AssistantScope,
    options: { proposalId?: string; limit?: number } = {},
  ): Promise<ProposalEvent[]> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<{
        sequence: string | number;
        proposal_id: string;
        event_type: string;
        revision: number;
        revision_hash: string;
        actor_type: string;
        actor_id: string | null;
        payload: unknown;
        occurred_at: string | Date;
      }>(
        // The join scopes events to the assistant: the events table has no scope
        // columns of its own (it references the proposal), so querying it directly
        // would be a cross-tenant read.
        `SELECT e.* FROM assistant_skill_proposal_events e
           JOIN assistant_skill_proposals p ON p.id = e.proposal_id
          WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.assistant_id = $3
            AND ($4::uuid IS NULL OR e.proposal_id = $4)
          ORDER BY e.sequence DESC
          LIMIT $5`,
        [
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          options.proposalId ?? null,
          boundLimit(options.limit),
        ],
      ),
    );
    return rows.map((row) => {
      const payload = typeof row.payload === "string" ? safeParse(row.payload) : row.payload;
      return {
        sequence: Number(row.sequence),
        proposalId: row.proposal_id,
        eventType: row.event_type as ProposalEventType,
        revision: Number(row.revision),
        revisionHash: row.revision_hash,
        actorType: row.actor_type as SoulActorType,
        ...(row.actor_id !== null ? { actorId: row.actor_id } : {}),
        ...(payload !== undefined && payload !== null
          ? { payload: payload as Record<string, unknown> }
          : {}),
        occurredAt: toIso(row.occurred_at) ?? new Date().toISOString(),
      };
    });
  }

  async purge(scope: AssistantScope): Promise<void> {
    // Events and rollbacks cascade from the proposal rows (ON DELETE CASCADE), so
    // one delete is sufficient and cannot leave orphans.
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `DELETE FROM assistant_skill_proposals
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
  }
}

/** Builds the durable store when a database is available, else in-memory. */
export function createProposalStore(params: {
  db?: Database;
  skills: SkillStore;
  logger?: Logger;
}): ProposalStore {
  return params.db !== undefined
    ? new PostgresProposalStore(params.db, params.skills, params.logger)
    : new InMemoryProposalStore(params.skills);
}
