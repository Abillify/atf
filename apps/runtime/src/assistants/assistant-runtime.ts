// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant runtime (`src/assistants/assistant-runtime.ts`)
 *
 * The one object a flow node needs in order to serve an assistant turn. Bundles
 * the stores, resolves the turn's context in a single pass, and records the turn
 * facts the learning pass and the canaries later read.
 *
 * ## Why the context is assembled in one place
 *
 * Soul, skill index, inbox and authority are all needed by the same turn, and each
 * one influences the prompt budget of the others. Assembling them separately would
 * mean no single place knows the total, and the budget would be enforced per
 * section while the sum silently exceeded the model's window.
 *
 * ## Why turn facts are recorded rather than derived
 *
 * `recordTurn` writes what happened at the turn boundary: depth, tool count,
 * success, whether the user aborted, which canary skills were injected. Every one
 * of those is answerable *later* by combining node events and token counters — and
 * every one of those derivations produces a different answer as soon as a sibling
 * node path changes. The learning gate and the canary attribution both depend on
 * these facts being right, so they are recorded where they occur.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { ApprovalRegistry } from "../graph/approval-gate.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import { toIso } from "./assistant-store.js";
import type { AssistantStore } from "./assistant-store.js";
import type { AuthorityResolver } from "./authority-resolver.js";
import type { CredentialStore } from "./credential-store.js";
import type { OrgSkillStore } from "./org-skill-registry.js";
import {
  authorityPromptNotice,
  authorityToken,
  type ExecutionAuthority,
} from "./execution-authority.js";
import { AssistantMessenger, type MessagingStore } from "./messaging-store.js";
import { renderInbox } from "./messaging-policy.js";
import type { ProposalStore } from "./proposal-store.js";
import { isCanaryTurn, type SkillCanaryStore } from "./skill-canary.js";
import { renderSkillIndex, type SkillIndexEntry } from "./skill-index.js";
import type { SkillStore } from "./skill-store.js";
import { renderSoul, buildSoulTruncationNotice } from "./soul-render.js";
import type { SoulStore } from "./soul-store.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { AssistantSessionStore, AssistantToolJournal } from "./session-store.js";
import type { PostgresAssistantRunStore } from "./run-store.js";
import type { AssistantSessionIndex } from "./session-index.js";
import {
  SKILL_INDEX_MAX_CHARS,
  SOUL_RENDER_MAX_CHARS,
  type AssistantRecord,
  type AssistantScope,
  type AssistantTurnRecord,
  type TurnTrigger,
} from "./types.js";

// ---------------------------------------------------------------------------
// Assembled context
// ---------------------------------------------------------------------------

/** Everything a turn needs, resolved once. */
export interface AssistantTurnContext {
  assistant: AssistantRecord;
  /** Prompt section: identity, directives, constraints. */
  soulText: string;
  /** Prompt section: the stage-1 skill index. */
  skillIndexText: string;
  /** Prompt section: peer messages, framed as untrusted reports. */
  inboxText: string;
  /** Prompt section: why protected tools are unavailable, when they are. */
  authorityNotice?: string;
  /** Prompt section: what was dropped for budget reasons. */
  budgetNotice?: string;
  /** The authority this turn's tool calls carry. */
  authority: ExecutionAuthority;
  /** Token to place in `RequestContext.ssoToken`. Empty when there is none. */
  ssoToken: string;
  /** Skills visible to the model this turn, for `skill_read` resolution. */
  visibleSkills: SkillIndexEntry[];
  /** Canary skill ids injected this turn, recorded for outcome attribution. */
  canarySkillIds: string[];
  /** Inbox message ids shown, so they can be marked delivered after the turn. */
  shownMessageIds: string[];
  /** Total characters the assistant sections occupy. */
  promptChars: number;
}

/**
 * Total budget for all assistant-owned prompt sections.
 *
 * One number for the sum, not per section, because the sections compete: an
 * assistant with a long soul should get a shorter skill index rather than both
 * being individually "within budget" while the total is not.
 */
export const ASSISTANT_CONTEXT_MAX_CHARS = SOUL_RENDER_MAX_CHARS + SKILL_INDEX_MAX_CHARS + 12_000;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface AssistantRuntimeOptions {
  assistants: AssistantStore;
  souls: SoulStore;
  skills: SkillStore;
  proposals: ProposalStore;
  canaries: SkillCanaryStore;
  messaging: MessagingStore;
  credentials: CredentialStore;
  authority: AuthorityResolver;
  /** Tenant-wide curated skill catalog (Org Skill Registry). Optional: a
   * deployment that has not opted in simply has no publish/browse/install
   * routes reachable — see `org-skill-registry.ts`. */
  orgSkills?: OrgSkillStore;
  sandbox?: SandboxService;
  approvals?: ApprovalRegistry;
  /** Complete, file-backed conversation history in each assistant workspace. */
  transcripts?: TranscriptStore;
  /** Durable pending/completed journal used immediately around tool side effects. */
  toolJournal?: AssistantToolJournal;
  /** Authoritative session lifecycle (lineage, snapshots and recovery). */
  sessionStore?: AssistantSessionStore;
  /** Durable runs and scheduled run slots (PostgreSQL deployments only). */
  runStore?: PostgresAssistantRunStore;
  /** Optional MCP-backed projection; append failures remain best-effort. */
  sessionIndex?: AssistantSessionIndex;
  db?: Database;
  logger?: Logger;
  /** Whether the learning pass runs at all on this deployment. */
  learningEnabled?: boolean;
  now?: () => number;
}

/** Bundles the assistant subsystem for use by flow nodes. */
export class AssistantRuntime {
  readonly messenger: AssistantMessenger;
  private readonly now: () => number;
  private sessionIndex: AssistantSessionIndex | undefined;

  constructor(private readonly options: AssistantRuntimeOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sessionIndex = options.sessionIndex;
    this.messenger = new AssistantMessenger(options.messaging, this.now);
  }

  get stores(): AssistantRuntimeOptions {
    return this.options;
  }

  get learningEnabled(): boolean {
    return this.options.learningEnabled ?? true;
  }

  get sandbox(): SandboxService | undefined {
    return this.options.sandbox;
  }

  /** Late wiring avoids a bootstrap cycle: MCP connects before the HTTP API, while assistants are built earlier. */
  setSessionIndex(index: AssistantSessionIndex | undefined): void {
    this.sessionIndex = index;
  }

  async indexSessionDocument(params: Parameters<AssistantSessionIndex["ingestEvent"]>[0]): Promise<void> {
    await this.sessionIndex?.ingestEvent(params);
  }

  /**
   * Provisions the assistant if needed and returns its record.
   *
   * Idempotent, and cheap enough to call per turn: the underlying upsert is a single
   * statement. Auto-provisioning here is what makes "every user gets an assistant
   * without their own setup" true — the first request that names an assistant
   * creates it and proceeds.
   */
  async ensureAssistant(params: {
    scope: AssistantScope;
    displayName?: string;
  }): Promise<AssistantRecord> {
    return this.options.assistants.ensure({
      scope: params.scope,
      ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
    });
  }

  /**
   * Assembles the turn context.
   *
   * Order of assembly is chosen so the most important sections claim budget first:
   * soul (identity and hard limits), then the skill index, then the inbox. Peer
   * messages are last because they are the least likely to be essential to the
   * user's actual request and the most likely to be large.
   */
  async buildTurnContext(params: {
    scope: AssistantScope;
    trigger: TurnTrigger;
    /** Conversation key, used for canary bucketing. */
    routingKey: string;
    /** The user's request token, when this run has one. */
    requestToken?: string;
    /** False for runs that may not use protected tools (the learning pass). */
    requiresToolAuthority?: boolean;
    displayName?: string;
    maxChars?: number;
  }): Promise<AssistantTurnContext> {
    const assistant = await this.ensureAssistant({
      scope: params.scope,
      ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
    });
    const budget = params.maxChars ?? ASSISTANT_CONTEXT_MAX_CHARS;

    // Independent reads, issued together: three sequential round trips per turn is
    // latency the user pays for nothing.
    const [soul, allSkills, authority] = await Promise.all([
      this.options.souls.get(params.scope),
      this.options.skills.listForPrompt(params.scope),
      this.options.authority.resolve({
        scope: params.scope,
        trigger: params.trigger,
        autonomy: assistant.autonomy,
        status: assistant.status,
        ...(params.requestToken !== undefined ? { requestToken: params.requestToken } : {}),
        requiresToolAuthority: params.requiresToolAuthority ?? true,
      }),
    ]);

    const soulRender = renderSoul(
      {
        identity: soul.identity,
        directives: soul.directives,
        constraints: soul.constraints,
      },
      {
        maxChars: Math.min(SOUL_RENDER_MAX_CHARS, budget),
        assistantDisplayName: assistant.displayName,
      },
    );
    let remaining = budget - soulRender.chars;

    // A skill under canary is only injected for the conversations that fall in its
    // treatment bucket. Filtering here — before rendering — is what makes the
    // control arm a real control: the model never sees the skill at all.
    const eligibleSkills = allSkills.filter((skill) => {
      if (skill.canary !== true) return true;
      return isCanaryTurn({
        skillId: skill.id,
        routingKey: params.routingKey,
        // The stored per-canary percentage would need an extra read per skill; the
        // default split is used here and the canary record remains the source of
        // truth for the statistics.
        trafficPercent: 50,
      });
    });
    const skillRender = renderSkillIndex(eligibleSkills, {
      maxChars: Math.max(0, Math.min(SKILL_INDEX_MAX_CHARS, remaining)),
    });
    remaining -= skillRender.chars;

    // The inbox is only collected when there is budget left for it. Reading it and
    // then discarding it would spend a query to produce nothing.
    const inboxMessages = remaining > 1_000 ? await this.messenger.collectInbox(params.scope) : [];
    const inboxRender = renderInbox(
      inboxMessages.map((message) => ({
        id: message.id,
        fromAssistantId: message.from.assistantId,
        subject: message.subject,
        body: message.body,
        createdAt: message.createdAt,
      })),
      { maxChars: Math.max(0, remaining) },
    );

    const notices: string[] = [];
    const soulNotice = buildSoulTruncationNotice(soulRender);
    if (soulNotice !== undefined) notices.push(soulNotice);
    if (skillRender.truncated) {
      notices.push(
        `[Skill index truncated] ${skillRender.omittedCount} of your procedures are not listed. ` +
          "Use `skill_search` when the listed ones do not cover the task.",
      );
    }

    const shownMessageIds = inboxMessages
      .slice(0, inboxRender.renderedCount)
      .map((message) => message.id);

    return {
      assistant,
      soulText: soulRender.text,
      skillIndexText: skillRender.text,
      inboxText: inboxRender.text,
      ...(authorityPromptNotice(authority) !== undefined
        ? { authorityNotice: authorityPromptNotice(authority) }
        : {}),
      ...(notices.length > 0 ? { budgetNotice: notices.join("\n") } : {}),
      authority,
      ssoToken: authorityToken(authority),
      visibleSkills: eligibleSkills,
      canarySkillIds: skillRender.canaryIds,
      shownMessageIds,
      promptChars: soulRender.chars + skillRender.chars + inboxRender.text.length,
    };
  }

  /**
   * Renders the assembled context as one system-prompt block.
   *
   * Section order encodes precedence, and it is the inverse of the assembly order
   * for the two that matter: hard limits sit inside the soul block, which is
   * rendered with constraints LAST, and the untrusted inbox sits after everything
   * the platform authored. A peer message must never appear before the rules it
   * might try to talk the model out of.
   */
  renderContextPrompt(context: AssistantTurnContext): string {
    const sections = [
      context.soulText,
      context.skillIndexText,
      context.authorityNotice,
      context.budgetNotice,
      // Last, deliberately: untrusted peer content after every platform-authored
      // instruction.
      context.inboxText,
    ].filter((section): section is string => (section ?? "").trim().length > 0);
    return sections.join("\n\n");
  }

  /**
   * Records the turn's facts and settles the per-turn bookkeeping.
   *
   * Everything here is best-effort: a failure to record a fact must not fail a turn
   * that already produced an answer for the user. The consequences of a lost record
   * are a missed learning opportunity and one uncounted canary sample, both of which
   * are invisible; a failed turn is not.
   */
  async recordTurn(params: {
    scope: AssistantScope;
    executionId: string;
    trigger: TurnTrigger;
    modelIterations: number;
    toolCalls: number;
    succeeded: boolean;
    aborted: boolean;
    errored: boolean;
    stopReason?: string;
    canarySkillIds: readonly string[];
    shownMessageIds: readonly string[];
    usedSkillIds: readonly string[];
    /** Optional quality score in [0,1] for canary attribution. */
    qualityScore?: number;
  }): Promise<void> {
    const tasks: Promise<unknown>[] = [];

    if (params.shownMessageIds.length > 0) {
      // Marked delivered even on a failed turn: the content already entered the
      // model's context, so re-injecting it next turn would duplicate it.
      tasks.push(this.options.messaging.markDelivered(params.shownMessageIds));
    }
    if (params.usedSkillIds.length > 0) {
      tasks.push(this.options.skills.recordUse(params.scope, params.usedSkillIds));
    }
    if (params.canarySkillIds.length > 0) {
      tasks.push(
        this.options.canaries.recordOutcome(
          params.scope,
          params.canarySkillIds.map((skillId) => ({
            skillId,
            treatment: true,
            errored: params.errored || !params.succeeded,
            ...(params.qualityScore !== undefined ? { score: params.qualityScore } : {}),
          })),
        ),
      );
    } else {
      // A turn with no canary skill injected is a CONTROL sample for every running
      // canary. Without recording it there is nothing to compare the treatment arm
      // against, and the rollback decision can never fire.
      tasks.push(
        this.options.canaries.listRunning(params.scope).then((running) =>
          running.length === 0
            ? undefined
            : this.options.canaries.recordOutcome(
                params.scope,
                running.map((canary) => ({
                  skillId: canary.skillId,
                  treatment: false,
                  errored: params.errored || !params.succeeded,
                  ...(params.qualityScore !== undefined ? { score: params.qualityScore } : {}),
                })),
              ),
        ),
      );
    }
    tasks.push(this.options.assistants.touch(params.scope));
    tasks.push(this.persistTurnRecord(params));

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        this.options.logger?.debug("Assistant turn bookkeeping failed", {
          assistantId: params.scope.assistantId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  /** Writes the turn fact row. No-op without a database. */
  private async persistTurnRecord(params: {
    scope: AssistantScope;
    executionId: string;
    trigger: TurnTrigger;
    modelIterations: number;
    toolCalls: number;
    succeeded: boolean;
    aborted: boolean;
    errored: boolean;
    stopReason?: string;
    canarySkillIds: readonly string[];
  }): Promise<void> {
    const db = this.options.db;
    if (db === undefined) return;
    const run = (scoped: Database): Promise<unknown> =>
      scoped.query(
        `INSERT INTO assistant_turns
           (execution_id, tenant_id, user_id, assistant_id, model_iterations,
            tool_calls, succeeded, aborted, errored, trigger, stop_reason,
            canary_skill_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text::jsonb)
         -- Idempotent under a retried finalisation: the turn is keyed by its
         -- execution, and a second write must not create a second learnable turn.
         ON CONFLICT (execution_id) DO UPDATE
           SET model_iterations = EXCLUDED.model_iterations,
               tool_calls = EXCLUDED.tool_calls,
               succeeded = EXCLUDED.succeeded,
               aborted = EXCLUDED.aborted,
               errored = EXCLUDED.errored,
               stop_reason = EXCLUDED.stop_reason,
               canary_skill_ids = EXCLUDED.canary_skill_ids`,
        [
          params.executionId,
          params.scope.tenantId,
          params.scope.userId,
          params.scope.assistantId,
          params.modelIterations,
          params.toolCalls,
          params.succeeded,
          params.aborted,
          params.errored,
          params.trigger,
          params.stopReason ?? null,
          params.canarySkillIds.length > 0 ? JSON.stringify([...params.canarySkillIds]) : null,
        ],
      );
    await (db.withTenant !== undefined ? db.withTenant(params.scope.tenantId, run) : run(db));
  }

  /** Reads the recorded turn fact, for the learning pass's preflight. */
  async readTurn(
    scope: AssistantScope,
    executionId: string,
  ): Promise<AssistantTurnRecord | undefined> {
    const db = this.options.db;
    if (db === undefined) return undefined;
    const run = (scoped: Database) =>
      scoped.query<{
        execution_id: string;
        model_iterations: number;
        tool_calls: number;
        succeeded: boolean;
        aborted: boolean;
        errored: boolean;
        trigger: string;
        stop_reason: string | null;
        reviewed: boolean;
        created_at: string | Date;
      }>(
        `SELECT * FROM assistant_turns
          WHERE execution_id = $1 AND tenant_id = $2 AND user_id = $3
            AND assistant_id = $4`,
        [executionId, scope.tenantId, scope.userId, scope.assistantId],
      );
    const rows = await (db.withTenant !== undefined ? db.withTenant(scope.tenantId, run) : run(db));
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      executionId: row.execution_id,
      scope,
      modelIterations: Number(row.model_iterations),
      toolCalls: Number(row.tool_calls),
      succeeded: row.succeeded === true,
      aborted: row.aborted === true,
      errored: row.errored === true,
      trigger: row.trigger as TurnTrigger,
      ...(row.stop_reason !== null ? { stopReason: row.stop_reason } : {}),
      reviewed: row.reviewed === true,
      createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    };
  }

  /** Marks a turn reviewed so a learning pass cannot run against it twice. */
  async markTurnReviewed(scope: AssistantScope, executionId: string): Promise<void> {
    const db = this.options.db;
    if (db === undefined) return;
    const run = (scoped: Database): Promise<unknown> =>
      scoped.query(
        `UPDATE assistant_turns SET reviewed = true
          WHERE execution_id = $1 AND tenant_id = $2 AND user_id = $3
            AND assistant_id = $4`,
        [executionId, scope.tenantId, scope.userId, scope.assistantId],
      );
    await (db.withTenant !== undefined ? db.withTenant(scope.tenantId, run) : run(db));
  }

  /**
   * Settles every running canary that has reached a verdict.
   *
   * Run after a turn's outcome is recorded, so the newest sample is included.
   * Promotion flips the skill to `active`; rollback retires it and reverses the
   * proposal that introduced it, which is what makes an auto-applied learned
   * procedure a recoverable decision rather than a permanent one.
   */
  async settleCanaries(scope: AssistantScope): Promise<void> {
    const { evaluateSkillCanary } = await import("./skill-canary.js");
    let running: Awaited<ReturnType<SkillCanaryStore["listRunning"]>>;
    try {
      running = await this.options.canaries.listRunning(scope);
    } catch (err) {
      this.options.logger?.debug("Canary listing failed", {
        assistantId: scope.assistantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const canary of running) {
      const verdict = evaluateSkillCanary(canary);
      if (verdict.action === "continue") continue;
      try {
        const skill = await this.options.skills.getById(scope, canary.skillId);
        if (skill === undefined) {
          // The skill is gone (retired or purged); settle the canary so it stops
          // being evaluated rather than leaving it running forever.
          await this.options.canaries.settle({
            scope,
            skillId: canary.skillId,
            state: "rolled-back",
            reason: "The skill no longer exists.",
          });
          continue;
        }
        if (verdict.action === "promote") {
          await this.options.skills.patch(scope, skill.name, {
            status: "active",
          });
          await this.options.canaries.settle({
            scope,
            skillId: canary.skillId,
            state: "promoted",
            reason: verdict.reason,
          });
          this.options.logger?.info("Learned skill promoted", {
            assistantId: scope.assistantId,
            skill: skill.name,
          });
          continue;
        }
        await this.options.skills.retire(scope, skill.name, verdict.reason);
        await this.options.canaries.settle({
          scope,
          skillId: canary.skillId,
          state: "rolled-back",
          reason: verdict.reason,
        });
        this.options.logger?.info("Learned skill rolled back", {
          assistantId: scope.assistantId,
          skill: skill.name,
          reason: verdict.reason,
        });
      } catch (err) {
        this.options.logger?.warn("Canary settlement failed", {
          assistantId: scope.assistantId,
          skillId: canary.skillId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
