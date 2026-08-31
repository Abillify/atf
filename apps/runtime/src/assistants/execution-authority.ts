// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Execution authority (`src/assistants/execution-authority.ts`)
 *
 * Decides, for one assistant run, **whose authority its tool calls carry**.
 * Pure and exhaustive — no I/O, no clock, no network — so the rule can be read
 * and tested in one place instead of being distributed across the call sites that
 * happen to need a token.
 *
 * ## The problem this solves
 *
 * Every protected tool call goes out with `ctx.ssoToken` (see
 * `mcp/wrapper/client.ts`, which injects it as `user_token` and refuses when it
 * is empty). That works for an interactive turn, where the user's request carried
 * the token. It does not work for the runs that make an assistant an assistant:
 *
 *   - a scheduled/background turn, where the user is absent by definition;
 *   - the post-turn learning pass, which runs after the request has finished;
 *   - a turn triggered by another assistant's message.
 *
 * The platform's scheduler previously substituted the placeholder
 * `scheduled:<executionId>`, which is not a credential and fails at the first
 * protected tool call. Substituting a service token instead would be worse: the
 * assistant would then act with more authority than its user has, and the tenant
 * isolation boundary would be gone.
 *
 * ## The rule
 *
 * There are exactly three authorities, and which one applies is determined by the
 * trigger plus what is actually available:
 *
 *   `interactive`  — the user's own request token. Full authority, no delegation.
 *   `delegated`    — an access token minted from a refresh token the user
 *                    explicitly granted (`offline_access`), limited to the scopes
 *                    they consented to delegate.
 *   `none`         — no authority. The run may still proceed, but every protected
 *                    tool is withheld and the model is told why.
 *
 * `none` is a first-class outcome, not an error: a learning pass needs no tool
 * authority at all, and refusing to run it would remove the capability rather
 * than protect it. What must never happen is a run that *believes* it has
 * authority and discovers otherwise at the first tool call — hence the decision
 * is made once, up front, and carried on the runtime.
 *
 * No `any` at module boundaries.
 */

import type { AssistantAutonomy, TurnTrigger } from "./types.js";

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

/** Which authority a run's tool calls carry. */
export type AuthorityKind = "interactive" | "delegated" | "none";

/**
 * Why no authority was established. Surfaced to the model and the operator so
 * the absence is explained rather than merely observed.
 */
export type NoAuthorityReason =
  /** Nothing was requested — the run needs no tool authority. */
  | "not-required"
  /** The trigger is autonomous and the user granted no delegation. */
  | "no-delegation-grant"
  /** A grant exists but was revoked. */
  | "grant-revoked"
  /** A grant exists but the refresh token no longer works. */
  | "grant-broken"
  /** The assistant's autonomy level forbids acting without the user present. */
  | "autonomy-forbids-background"
  /** The assistant is suspended or archived. */
  | "assistant-inactive";

/** The resolved authority for one run. */
export type ExecutionAuthority =
  | {
      kind: "interactive";
      /** The user's request token, passed through unchanged. */
      token: string;
    }
  | {
      kind: "delegated";
      /** A freshly minted access token. Never persisted. */
      token: string;
      /** Scopes the user consented to delegate. */
      scope: string;
      /** Epoch millis after which the token must be re-minted. */
      expiresAt: number;
    }
  | {
      kind: "none";
      reason: NoAuthorityReason;
      /**
       * Operator/model-facing explanation that states what to do next. Never a
       * bare "unauthorized": a dead end produces a retry loop, a stated next step
       * produces an outcome.
       */
      detail: string;
    };

// ---------------------------------------------------------------------------
// Trigger classification
// ---------------------------------------------------------------------------

/**
 * Triggers where the user is present and their own token is available.
 *
 * `api` counts as interactive: the caller authenticated with a credential of
 * their own, so authority comes from the request exactly as it does for a chat
 * turn.
 */
const INTERACTIVE_TRIGGERS: ReadonlySet<TurnTrigger> = new Set<TurnTrigger>(["user", "api"]);

/** True when the trigger implies the user is present to authorise the run. */
export function isInteractiveTrigger(trigger: TurnTrigger): boolean {
  return INTERACTIVE_TRIGGERS.has(trigger);
}

/**
 * Whether an autonomy level permits acting on the user's behalf while they are
 * absent.
 *
 * `supervised` deliberately cannot: it is the default, and a default that lets a
 * freshly provisioned assistant call protected tools unattended would make the
 * safe-by-default claim false. Raising it is a per-assistant decision the user
 * or operator takes knowingly.
 */
export function autonomyAllowsBackgroundAuthority(autonomy: AssistantAutonomy): boolean {
  return autonomy === "assisted" || autonomy === "autonomous";
}

// ---------------------------------------------------------------------------
// Delegation state
// ---------------------------------------------------------------------------

/**
 * What the credential store knows about a delegation, reduced to what the
 * decision needs. Deliberately not the storage row: the decision must not depend
 * on encrypted material or on how it is stored.
 */
export type DelegationState =
  | { status: "absent" }
  | { status: "revoked" }
  /**
   * The refresh token has failed repeatedly. Kept distinct from `absent` so the
   * operator sees a broken grant instead of concluding the user never granted
   * one — the remedies differ (re-consent vs. investigate the IdP).
   */
  | { status: "broken"; failures: number }
  | { status: "usable"; scope: string };

/** A previously minted access token that may still be reusable. */
export interface CachedAccessToken {
  token: string;
  scope: string;
  /** Epoch millis. */
  expiresAt: number;
}

/**
 * Safety margin before expiry.
 *
 * A token that expires in ten seconds is not usable: the tool call it authorises
 * may still be in flight when it lapses, and the resulting failure looks like a
 * permission problem rather than a timing one. Sixty seconds covers a slow tool
 * round trip with headroom.
 */
export const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** True when a cached token can still be used at `now`. */
export function isAccessTokenFresh(cached: CachedAccessToken, now: number): boolean {
  return cached.expiresAt - ACCESS_TOKEN_EXPIRY_MARGIN_MS > now;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Everything the decision depends on. */
export interface AuthorityDecisionInput {
  trigger: TurnTrigger;
  autonomy: AssistantAutonomy;
  /** True unless the assistant is suspended or archived. */
  assistantActive: boolean;
  /**
   * The user's request token, when this run has one. Passed as the raw string so
   * the decision does not need to know how it was extracted.
   */
  requestToken?: string;
  delegation: DelegationState;
  /** A cached delegated token, when one is available and possibly still fresh. */
  cachedAccessToken?: CachedAccessToken;
  now: number;
  /**
   * Whether this run needs tool authority at all. The learning pass sets this to
   * `false`: it may only write a proposal, so establishing credentials for it
   * would grant authority no part of it can use.
   */
  requiresToolAuthority: boolean;
  /** True only for a run directly initiated by the owning user on a trusted channel. */
  userInitiated?: boolean;
}

/**
 * The decision, plus whether the caller must mint a token to satisfy it.
 *
 * `mintDelegated` separates "delegation is the right answer" from "performing the
 * network call", which keeps this function pure. The caller mints and then calls
 * {@link completeDelegatedAuthority}.
 */
export type AuthorityDecision =
  | { authority: ExecutionAuthority; mintDelegated: false }
  | { mintDelegated: true; scope: string };

/**
 * Resolves the execution authority for a run.
 *
 * Order of checks is the policy, so it is worth stating: an inactive assistant is
 * refused before anything else (a suspended assistant must not act even for a
 * present user), then a run that needs no authority short-circuits, then the
 * user's own token wins whenever it exists, and only an autonomous trigger
 * reaches delegation.
 */
export function decideExecutionAuthority(input: AuthorityDecisionInput): AuthorityDecision {
  if (!input.assistantActive) {
    return {
      mintDelegated: false,
      authority: {
        kind: "none",
        reason: "assistant-inactive",
        detail:
          "This assistant is suspended or archived, so it may not call tools. " +
          "Reactivate it before expecting tool access.",
      },
    };
  }

  if (!input.requiresToolAuthority) {
    return {
      mintDelegated: false,
      authority: {
        kind: "none",
        reason: "not-required",
        detail: "This run does not use protected tools, so no credential was resolved.",
      },
    };
  }

  // An interactive request always uses the user's own token, even when a
  // delegation exists. Delegation is a fallback for absence, never an upgrade:
  // preferring it would let a run act with delegated scopes while the user was
  // right there with narrower ones.
  const requestToken = input.requestToken?.trim();
  if (requestToken !== undefined && requestToken.length > 0) {
    return {
      mintDelegated: false,
      authority: { kind: "interactive", token: requestToken },
    };
  }

  // A trusted channel may mark a run as directly user-initiated even though it
  // cannot carry the browser's request token itself. This permits a supervised
  // assistant to use the user's explicit delegation for that one turn, without
  // also enabling unattended schedules or peer-triggered messages.
  if (
    input.userInitiated !== true &&
    !autonomyAllowsBackgroundAuthority(input.autonomy)
  ) {
    return {
      mintDelegated: false,
      authority: {
        kind: "none",
        reason: "autonomy-forbids-background",
        detail:
          `This assistant runs at autonomy "${input.autonomy}", which does not permit acting ` +
          "while its user is absent. Protected tools are withheld for this run. " +
          'Raise it to "assisted" or "autonomous" to allow background tool use.',
      },
    };
  }

  if (input.delegation.status === "absent") {
    return {
      mintDelegated: false,
      authority: {
        kind: "none",
        reason: "no-delegation-grant",
        detail:
          "No user is present and this assistant holds no delegation grant, so protected tools " +
          "are withheld. The user can grant one from the assistant's settings; it requires their " +
          "explicit consent and can be revoked at any time.",
      },
    };
  }
  if (input.delegation.status === "revoked") {
    return {
      mintDelegated: false,
      authority: {
        kind: "none",
        reason: "grant-revoked",
        detail:
          "The delegation grant for this assistant was revoked, so it cannot act while its user " +
          "is absent. A new grant requires the user's consent.",
      },
    };
  }
  if (input.delegation.status === "broken") {
    return {
      mintDelegated: false,
      authority: {
        kind: "none",
        reason: "grant-broken",
        detail:
          `The delegation grant could not be used (${input.delegation.failures} consecutive refresh failures). ` +
          "The identity provider may have invalidated it. The user must grant delegation again.",
      },
    };
  }

  // Delegation is usable. Reuse a cached token when it is still comfortably
  // valid — minting one per turn would add an IdP round trip to every background
  // run for no benefit.
  const cached = input.cachedAccessToken;
  if (cached !== undefined && isAccessTokenFresh(cached, input.now)) {
    return {
      mintDelegated: false,
      authority: {
        kind: "delegated",
        token: cached.token,
        scope: cached.scope,
        expiresAt: cached.expiresAt,
      },
    };
  }
  return { mintDelegated: true, scope: input.delegation.scope };
}

/**
 * Wraps a freshly minted token into a delegated authority.
 *
 * Separate from {@link decideExecutionAuthority} so the impure minting step stays
 * outside the decision, and so a mint failure has an obvious, typed landing
 * place: {@link delegationMintFailure}.
 */
export function completeDelegatedAuthority(params: {
  token: string;
  scope: string;
  expiresAt: number;
}): ExecutionAuthority {
  return {
    kind: "delegated",
    token: params.token,
    scope: params.scope,
    expiresAt: params.expiresAt,
  };
}

/** The authority to use when minting a delegated token failed. */
export function delegationMintFailure(detail: string): ExecutionAuthority {
  return {
    kind: "none",
    reason: "grant-broken",
    detail:
      `Could not mint a delegated access token: ${detail} ` +
      "Protected tools are withheld for this run.",
  };
}

// ---------------------------------------------------------------------------
// Projection onto the request context
// ---------------------------------------------------------------------------

/**
 * The token string to place in `RequestContext.ssoToken`.
 *
 * Returns the empty string for `none`. That is deliberate and matches what the
 * MCP wrapper already does with an empty token: it refuses the call with
 * "Missing required protected parameter value: user_token". The alternative —
 * a placeholder that looks like a token — produces a confusing downstream
 * failure at the IdP instead of a clear local one, which is exactly the defect
 * the `scheduled:<id>` placeholder caused.
 */
export function authorityToken(authority: ExecutionAuthority): string {
  return authority.kind === "none" ? "" : authority.token;
}

/**
 * Prompt text telling the model that protected tools are unavailable and why.
 *
 * Returned only for `none`, and only when authority was actually wanted: a
 * learning pass does not need to be told it has no credentials. Without this the
 * model repeatedly attempts a tool that will always be refused, burning round
 * trips and ending the turn with no visible outcome.
 */
export function authorityPromptNotice(authority: ExecutionAuthority): string | undefined {
  if (authority.kind !== "none" || authority.reason === "not-required") {
    return undefined;
  }
  return [
    "## Tool access for this run",
    "You are running without your user's credentials, so tools that act on their behalf are unavailable.",
    authority.detail,
    "Do not attempt those tools. Work with what you can do unattended, and state plainly in your answer what you could not do and why.",
  ].join("\n");
}
