// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant subsystem builder (`src/bootstrap/assistants.ts`)
 *
 * Constructs the per-user assistant runtime: stores, workspace resolver, delegation
 * credentials, sandbox, and the learning-pass scheduler.
 *
 * Returns `undefined` when assistants are disabled, so the caller wires nothing and
 * the two assistant node types pass their turns through unchanged. That is the shape
 * of every optional subsystem in this codebase (persistence, cache, MCP) and it keeps
 * a flow using assistant nodes working on a deployment that does not run them.
 *
 * ## Startup probes
 *
 * The container runtime is probed once here rather than per run. A per-run probe
 * doubles the process spawns and the answer does not change while the process lives.
 * When the probe fails, the sandbox is constructed WITHOUT a backend: the policy then
 * refuses execution with "no container runtime is available", which is a diagnosable
 * message, instead of every run failing at spawn time.
 *
 * No `any` at module boundaries.
 */

import path from "node:path";
import type { AppConfig } from "../config/index.js";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { ApprovalRegistry } from "../graph/approval-gate.js";
import {
  createSecretCipher,
  type SecretCipher,
} from "../graph/secret-cipher.js";
import { AssistantRuntime } from "../assistants/assistant-runtime.js";
import { createAssistantStore } from "../assistants/assistant-store.js";
import { AuthorityResolver } from "../assistants/authority-resolver.js";
import { createCredentialStore } from "../assistants/credential-store.js";
import {
  ExperienceReviewScheduler,
  type ReviewCandidate,
} from "../assistants/experience-review.js";
import { createMessagingStore } from "../assistants/messaging-store.js";
import { createOrgSkillStore } from "../assistants/org-skill-registry.js";
import { createProposalStore } from "../assistants/proposal-store.js";
import { createSkillCanaryStore } from "../assistants/skill-canary.js";
import { createSkillStore } from "../assistants/skill-store.js";
import { createSoulStore } from "../assistants/soul-store.js";
import { AssistantWorkspaceResolver } from "../assistants/workspace.js";
import { WorkspaceTranscriptStore } from "../assistants/transcript-store.js";
import { AssistantMirrorOutboxScheduler, AssistantMirrorOutboxSweeper } from "../assistants/mirror-outbox.js";
import {
  MirroredTranscriptStore,
  PostgresAssistantSessionStore,
} from "../assistants/session-store.js";
import {
  AssistantRunRecoverySweeper,
  PostgresAssistantRunStore,
  type AssistantRun,
} from "../assistants/run-store.js";
import {
  PostgresRocketChatBindingStore,
  RocketChatClient,
  RocketChatOutbox,
  RocketChatOutboxScheduler,
  RocketChatOutboxSweeper,
  type RocketChatChannel,
} from "../assistants/rocketchat-channel.js";
import {
  DelegatedTokenMinter,
  createTokenEndpointResolver,
} from "../assistants/token-minter.js";
import type { ReviewGateInput } from "../assistants/review-gating.js";
import { ContainerSandboxBackend } from "../sandbox/docker-backend.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import type { AssistantScope, TurnTrigger } from "../assistants/types.js";
import {
  PostgresRocketChatDelegationBridge,
  type RocketChatDelegationBridge,
} from "../assistants/rocketchat-delegation.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface AssistantsResult {
  runtime: AssistantRuntime;
  /**
   * Process-wide learning scheduler. Absent when learning is disabled.
   *
   * Process-wide rather than per-request because its single-flight latch spans every
   * assistant: a deployment where many assistants go idle together must not fire
   * dozens of model calls at once.
   */
  reviewScheduler?: ExperienceReviewScheduler;
  /**
   * Resolves credentials for scheduled runs. Passed to the trigger scheduler so a
   * cron-fired assistant turn carries its delegated token instead of a placeholder.
   */
  resolveScheduledAuthority: (params: {
    flowId: string;
    nodeId: string;
    executionId: string;
    tenantId?: string;
    userId?: string;
    assistantId?: string;
  }) => Promise<{ token: string; scope?: string; notice?: string }>;
  /** Resolves authority for a durable assistant run with an explicit trigger origin. */
  resolveRunAuthority: (params: {
    scope: AssistantScope;
    trigger: TurnTrigger;
    userInitiated?: boolean;
  }) => Promise<{ token: string; scope?: string; notice?: string }>;
  /** Secure hand-off from Rocket.Chat OIDC consent into the assistant credential vault. */
  rocketChatDelegation?: RocketChatDelegationBridge;
  /** Optional durable Rocket.Chat transport, present only with complete secure configuration. */
  rocketChat?: RocketChatChannel;
  /** Binds the existing graph dispatcher after the engine is constructed and starts durable run draining. */
  setRunDispatcher: (dispatcher: (run: AssistantRun) => Promise<void>) => void;
  /** Releases timers. Called on shutdown. */
  shutdown: () => void;
}

export interface BuildAssistantsParams {
  config: AppConfig;
  logger: Logger;
  db?: Database;
  approvals?: ApprovalRegistry;
  /**
   * Runs one learning pass. Injected because it needs the graph engine, which is
   * built after this — the wiring passes a late-bound callback rather than creating
   * a construction cycle.
   */
  runLearningPass?: (candidate: ReviewCandidate) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildAssistants(
  params: BuildAssistantsParams,
): Promise<AssistantsResult | undefined> {
  const { config, logger, db } = params;
  if (config.assistantsEnabled !== true) return undefined;

  const workspaceRoot = path.resolve(
    config.assistantWorkspaceRoot ?? "./data/assistants",
  );
  let workspaces: AssistantWorkspaceResolver;
  try {
    workspaces = new AssistantWorkspaceResolver({ root: workspaceRoot });
  } catch (err) {
    // A workspace root that cannot be created is fatal for the subsystem: every
    // assistant owns a directory under it, and provisioning would fail per request
    // with a confusing message. Refusing to enable it here is the honest outcome.
    logger.error(
      "Assistants are enabled but the workspace root could not be prepared; the subsystem stays off.",
      {
        workspaceRoot,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }

  const assistants = createAssistantStore({
    ...(db !== undefined ? { db } : {}),
    workspaces,
    logger,
  });
  const souls = createSoulStore({ ...(db !== undefined ? { db } : {}), logger });
  const skills = createSkillStore({ ...(db !== undefined ? { db } : {}), logger });
  const proposals = createProposalStore({
    ...(db !== undefined ? { db } : {}),
    skills,
    logger,
  });
  const canaries = createSkillCanaryStore({
    ...(db !== undefined ? { db } : {}),
    logger,
  });
  const workspaceTranscripts = new WorkspaceTranscriptStore(workspaces);
  const sessionStore = db === undefined ? undefined : new PostgresAssistantSessionStore(db);
  const runStore = db === undefined ? undefined : new PostgresAssistantRunStore(db);
  let rocketChat: RocketChatChannel | undefined;
  let rocketChatScheduler: RocketChatOutboxScheduler | undefined;
  if (config.rocketChatEnabled === true) {
    const missing = [
      ["DATABASE_URL", db],
      ["ROCKETCHAT_BASE_URL", config.rocketChatBaseUrl],
      ["ROCKETCHAT_BOT_USER_ID", config.rocketChatBotUserId],
      ["ROCKETCHAT_BOT_AUTH_TOKEN", config.rocketChatBotAuthToken],
      ["ROCKETCHAT_WEBHOOK_TOKEN", config.rocketChatWebhookToken],
    ].filter(([, value]) => value === undefined).map(([name]) => name);
    if (missing.length > 0 || db === undefined || runStore === undefined) {
      logger.warn("Rocket.Chat channel is enabled but incomplete; integration remains disabled", { missing });
    } else {
      try {
        const bindings = new PostgresRocketChatBindingStore(db, config.rocketChatBaseUrl as string);
        const client = new RocketChatClient({
          baseUrl: config.rocketChatBaseUrl as string,
          botUserId: config.rocketChatBotUserId as string,
          authToken: config.rocketChatBotAuthToken as string,
          timeoutMs: config.rocketChatTimeoutMs,
        });
        const outbox = new RocketChatOutbox(db, bindings);
        const outboxSweeper = new RocketChatOutboxSweeper(db, client, logger);
        rocketChatScheduler = new RocketChatOutboxScheduler(outboxSweeper, logger);
        rocketChatScheduler.start(config.rocketChatSweepIntervalMs);
        rocketChat = {
          botUserId: config.rocketChatBotUserId as string,
          webhookToken: config.rocketChatWebhookToken as string,
          bindings,
          outbox,
          flushOutbox: () => outboxSweeper.sweep(),
          runs: runStore,
          client,
        };
        logger.info("Rocket.Chat assistant channel enabled", { baseUrl: client.baseUrl });
      } catch (error) {
        logger.error("Rocket.Chat channel configuration is invalid; integration remains disabled", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  // The engine is built by index.ts after this bootstrap. Keep the queue idle until
  // its dispatcher is explicitly bound, so startup cannot consume a run before it
  // has a real execution path.
  let runSweeper: AssistantRunRecoverySweeper | undefined;
  const transcripts = sessionStore === undefined
    ? workspaceTranscripts
    : new MirroredTranscriptStore(sessionStore, workspaceTranscripts);
  const mirrorScheduler = db === undefined
    ? undefined
    : new AssistantMirrorOutboxScheduler(new AssistantMirrorOutboxSweeper(db, workspaceTranscripts, logger));
  mirrorScheduler?.start();
  const messaging = createMessagingStore({
    ...(db !== undefined ? { db } : {}),
    logger,
  });
  const orgSkills = createOrgSkillStore({
    ...(db !== undefined ? { db } : {}),
    logger,
  });
  // Built here rather than injected: a malformed key must fail loudly at startup
  // (createSecretCipher throws) instead of surfacing later as "delegation is
  // unavailable", which would send an operator looking at their OIDC config.
  let cipher: SecretCipher | undefined;
  try {
    cipher = createSecretCipher(config.assistantEncryptionKey);
  } catch (err) {
    logger.error(
      "The assistant encryption key is malformed; delegated credentials cannot be stored. " +
        "Assistants stay enabled, but granting delegation will be refused.",
      { error: err instanceof Error ? err.message : String(err) },
    );
    cipher = undefined;
  }
  if (cipher === undefined) {
    logger.warn(
      "No assistant encryption key configured (ASSISTANT_ENCRYPTION_KEY or BYOK_ENCRYPTION_KEY). " +
        "Assistants work interactively; delegated background credentials cannot be stored.",
    );
  }
  const credentials = createCredentialStore({
    ...(db !== undefined ? { db } : {}),
    ...(cipher !== undefined ? { cipher } : {}),
    logger,
  });

  // -- Delegation ----------------------------------------------------------
  // Requires an issuer AND a confidential client: the refresh grant is exchanged
  // with client credentials. Without both, background runs resolve to no authority
  // with a stated reason, which is a working degraded mode rather than a failure.
  const issuer = config.assistantDelegationIssuer;
  const delegationClientId = config.assistantDelegationClientId;
  const delegationClientSecret = config.assistantDelegationClientSecret;
  const canMintDelegated =
    issuer !== undefined &&
    delegationClientId !== undefined &&
    delegationClientSecret !== undefined;
  const minter = canMintDelegated
    ? new DelegatedTokenMinter({
        credentials,
        clientId: delegationClientId as string,
        clientSecret: delegationClientSecret as string,
        resolveTokenEndpoint: createTokenEndpointResolver(),
        logger,
      })
    : undefined;
  if (!canMintDelegated) {
    logger.info(
      "Assistant delegation is unavailable (no OIDC issuer/client configured). " +
        "Assistants will work interactively; background runs will report that they have no credentials.",
    );
  }
  const authority = new AuthorityResolver({
    credentials,
    ...(minter !== undefined ? { minter } : {}),
    ...(issuer !== undefined ? { issuer } : {}),
    logger,
  });
  const rocketChatDelegation =
    db !== undefined &&
    cipher !== undefined &&
    issuer !== undefined &&
    delegationClientId !== undefined
      ? new PostgresRocketChatDelegationBridge(
          db,
          cipher,
          issuer,
          delegationClientId,
        )
      : undefined;

  // -- Sandbox -------------------------------------------------------------
  let sandbox: SandboxService | undefined;
  if (config.sandboxEnabled === true) {
    const backend = new ContainerSandboxBackend({
      binary: config.sandboxRuntime ?? "docker",
      image: config.sandboxImage ?? "aiperator/sandbox:1",
      user: config.sandboxUser ?? "1000:1000",
      logger,
    });
    // Probed once. A failed probe yields a sandbox with no backend, so the policy
    // refuses with a diagnosable reason instead of every run failing at spawn.
    const usable = await backend.probe();
    if (!usable) {
      logger.warn(
        "Sandbox is enabled but the container runtime is not reachable; script execution stays unavailable.",
        { runtime: config.sandboxRuntime ?? "docker" },
      );
    }
    sandbox = new SandboxService({
      workspaces,
      ...(usable ? { backend } : {}),
      ...(params.approvals !== undefined ? { approvals: params.approvals } : {}),
      enabled: true,
      network: config.sandboxNetworkEnabled === true ? "egress" : "none",
      limits: {
        ...(config.sandboxTimeoutMs !== undefined
          ? { timeoutMs: config.sandboxTimeoutMs }
          : {}),
        ...(config.sandboxMemoryMb !== undefined
          ? { memoryMb: config.sandboxMemoryMb }
          : {}),
        ...(config.sandboxCpus !== undefined ? { cpus: config.sandboxCpus } : {}),
      },
      logger,
    });
    if (usable) {
      logger.info("Assistant code sandbox ready", {
        image: config.sandboxImage ?? "aiperator/sandbox:1",
        network: config.sandboxNetworkEnabled === true ? "egress" : "none",
      });
    }
  }

  const learningEnabled = config.assistantLearningEnabled !== false;
  const runtime = new AssistantRuntime({
    assistants,
    souls,
    skills,
    proposals,
    canaries,
    messaging,
    credentials,
    authority,
    transcripts,
    ...(sessionStore !== undefined ? { toolJournal: sessionStore, sessionStore } : {}),
    ...(runStore !== undefined ? { runStore } : {}),
    orgSkills,
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(params.approvals !== undefined ? { approvals: params.approvals } : {}),
    ...(db !== undefined ? { db } : {}),
    logger,
    learningEnabled,
  });

  // -- Learning scheduler --------------------------------------------------
  let reviewScheduler: ExperienceReviewScheduler | undefined;
  if (learningEnabled && params.runLearningPass !== undefined) {
    const runLearningPass = params.runLearningPass;
    reviewScheduler = new ExperienceReviewScheduler({
      runReview: runLearningPass,
      // Late-bound eligibility: the pending-proposal count and the assistant's status
      // can both change during the idle window, so they are read at fire time rather
      // than when the timer was armed.
      preflight: async (candidate): Promise<ReviewGateInput | undefined> => {
        const assistant = await assistants.get(candidate.scope);
        if (assistant === undefined) return undefined;
        const turn = await runtime.readTurn(
          candidate.scope,
          candidate.executionId,
        );
        return {
          // The recorded turn fact wins over the in-memory candidate: it is the
          // authoritative record, and it also carries `reviewed`.
          turn: turn ?? candidate.turn,
          autonomy: assistant.autonomy,
          assistantActive: assistant.status === "active",
          pendingProposals: await proposals.countPending(candidate.scope),
          learningEnabled: true,
        };
      },
      logger,
    });
    logger.info("Assistant learning pass enabled");
  } else if (learningEnabled) {
    logger.debug(
      "Assistant learning is enabled but no pass runner was supplied; turns are recorded without capture.",
    );
  }

  // -- Run credentials -----------------------------------------------------
  const projectAuthority = async (params: {
    scope: AssistantScope;
    trigger: TurnTrigger;
    userInitiated?: boolean;
  }): Promise<{ token: string; scope?: string; notice?: string }> => {
    const assistant = await assistants.get(params.scope);
    if (assistant === undefined) {
      return {
        token: "",
        notice: `Assistant "${params.scope.assistantId}" is not provisioned.`,
      };
    }
    const resolved = await authority.resolve({
      scope: params.scope,
      trigger: params.trigger,
      autonomy: assistant.autonomy,
      status: assistant.status,
      requiresToolAuthority: true,
      ...(params.userInitiated !== undefined
        ? { userInitiated: params.userInitiated }
        : {}),
    });
    const { authorityToken, authorityPromptNotice } = await import(
      "../assistants/execution-authority.js"
    );
    const notice = authorityPromptNotice(resolved);
    return {
      token: authorityToken(resolved),
      // Only delegated authority has a consented scope string. Interactive HTTP
      // requests already carry verified claims in RequestContext; durable runs
      // do not, so this projection is what lets their transaction envelope
      // attest the same (or narrower) scopes as the forwarded bearer.
      ...(resolved.kind === "delegated" ? { scope: resolved.scope } : {}),
      ...(notice !== undefined ? { notice } : {}),
    };
  };

  const resolveScheduledAuthority = async (p: {
    flowId: string;
    nodeId: string;
    executionId: string;
    tenantId?: string;
    userId?: string;
    assistantId?: string;
  }): Promise<{ token: string; scope?: string; notice?: string }> => {
    if (p.assistantId === undefined) {
      return {
        token: "",
        notice:
          "This scheduled run is not bound to an assistant, so it carries no user credentials.",
      };
    }
    const owner =
      p.userId === undefined
        ? await findAssistantOwner({
            db,
            tenantId: p.tenantId,
            assistantId: p.assistantId,
          })
        : {
            tenantId: p.tenantId ?? "_",
            userId: p.userId,
            assistantId: p.assistantId,
          };
    if (owner === undefined) {
      return {
        token: "",
        notice: `No assistant "${p.assistantId}" is provisioned, so this run carries no credentials.`,
      };
    }
    return projectAuthority({ scope: owner, trigger: "schedule" });
  };

  logger.info("Per-user assistants enabled", {
    workspaceRoot,
    learning: learningEnabled,
    sandbox: sandbox !== undefined,
    delegation: canMintDelegated,
    durable: db !== undefined,
    rocketChat: rocketChat !== undefined,
  });

  return {
    runtime,
    ...(reviewScheduler !== undefined ? { reviewScheduler } : {}),
    ...(rocketChat !== undefined ? { rocketChat } : {}),
    ...(rocketChatDelegation !== undefined ? { rocketChatDelegation } : {}),
    resolveScheduledAuthority,
    resolveRunAuthority: projectAuthority,
    setRunDispatcher: (dispatcher) => {
      if (runStore === undefined || runSweeper !== undefined) return;
      runSweeper = new AssistantRunRecoverySweeper(runStore, dispatcher, logger);
      runSweeper.start();
      logger.info("Assistant durable run dispatcher started");
    },
    shutdown: () => {
      runSweeper?.stop();
      mirrorScheduler?.stop();
      rocketChatScheduler?.stop();
      reviewScheduler?.clear();
      rocketChatDelegation?.shutdown();
      minter?.clear();
    },
  };
}

/**
 * Finds the user that owns an assistant id within a tenant.
 *
 * Needed because a schedule names a flow and an assistant but not a person, while
 * every assistant-scoped read needs the full triple. Returns `undefined` when the id
 * is ambiguous — two users in one tenant may both have an assistant called
 * "primary", and guessing which one a schedule meant would run one user's assistant
 * with another's identity.
 */
async function findAssistantOwner(params: {
  db?: Database;
  tenantId?: string;
  assistantId: string;
}): Promise<AssistantScope | undefined> {
  if (params.db === undefined) return undefined;
  const tenantId = params.tenantId ?? "_";
  const rows = await params.db.withOperator((db) =>
    db.query<{ user_id: string }>(
      `SELECT user_id FROM assistants
        WHERE tenant_id = $1 AND assistant_id = $2 AND status = 'active'
        LIMIT 2`,
      [tenantId, params.assistantId],
    ),
  );
  // Exactly one match, or nothing. Two matches mean the schedule is ambiguous.
  if (rows.length !== 1) return undefined;
  const userId = rows[0]?.user_id;
  if (userId === undefined) return undefined;
  return { tenantId, userId, assistantId: params.assistantId };
}
