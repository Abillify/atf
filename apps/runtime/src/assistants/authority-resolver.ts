// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Authority resolution (`src/assistants/authority-resolver.ts`)
 *
 * Joins the pure decision (`execution-authority.ts`), the stored grant
 * (`credential-store.ts`) and the minting step (`token-minter.ts`) into the one
 * call an assistant run makes before it does anything else.
 *
 * Thin by design: every rule worth arguing about lives in the pure module, so
 * this file contains only sequencing and the two failure translations. If a rule
 * appears here, it is in the wrong place.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import type { CredentialStore } from "./credential-store.js";
import { resolveDelegationState } from "./credential-store.js";
import {
  completeDelegatedAuthority,
  decideExecutionAuthority,
  delegationMintFailure,
  type ExecutionAuthority,
} from "./execution-authority.js";
import type { DelegatedTokenMinter } from "./token-minter.js";
import type { AssistantAutonomy, AssistantScope, AssistantStatus, TurnTrigger } from "./types.js";

export interface AuthorityResolverOptions {
  credentials: CredentialStore;
  minter?: DelegatedTokenMinter;
  /**
   * Issuer delegation grants are held against. Absent when the deployment has no
   * OIDC configured, in which case delegation is unavailable and background runs
   * resolve to no authority with a stated reason.
   */
  issuer?: string;
  logger?: Logger;
  now?: () => number;
}

export interface ResolveAuthorityInput {
  scope: AssistantScope;
  trigger: TurnTrigger;
  autonomy: AssistantAutonomy;
  status: AssistantStatus;
  /** The user's request token, when this run carries one. */
  requestToken?: string;
  /** False for runs that may not use protected tools at all (learning pass). */
  requiresToolAuthority: boolean;
  /** True only when a trusted channel proves the owning user initiated the run. */
  userInitiated?: boolean;
}

/** Resolves which authority a run's tool calls carry. */
export class AuthorityResolver {
  private readonly now: () => number;

  constructor(private readonly options: AuthorityResolverOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Drops any cached delegated access token for (scope, issuer).
   *
   * Revoking a grant (`CredentialStore.revoke`) stops FUTURE minting — a
   * revoked grant's `DelegationState` resolves to `"revoked"` on the next
   * `resolve()` call — but does nothing about a token already minted and
   * cached by {@link DelegatedTokenMinter}: that cache is keyed independently
   * and survives up to its own TTL (default a few minutes) regardless of the
   * credential row. Without this, a revoked assistant could keep calling
   * protected tools with the old access token until it expired on its own,
   * which is not what "revoke" means to an operator pressing the button.
   *
   * Safe to call even when no minter is configured (delegation unavailable on
   * this deployment) — a no-op in that case.
   */
  invalidateDelegatedToken(scope: AssistantScope, issuer: string): void {
    this.options.minter?.invalidate(scope, issuer);
  }

  async resolve(input: ResolveAuthorityInput): Promise<ExecutionAuthority> {
    const issuer = this.options.issuer;

    // Reading the grant is skipped whenever it cannot influence the outcome: an
    // interactive turn uses the user's own token regardless, and a run needing no
    // authority needs no grant. Both are the common case, so this keeps the hot
    // path free of a database read.
    const needsDelegation =
      input.requiresToolAuthority &&
      (input.requestToken === undefined || input.requestToken.trim().length === 0);

    const credential =
      needsDelegation && issuer !== undefined
        ? await this.options.credentials.read(input.scope, issuer)
        : undefined;

    const decision = decideExecutionAuthority({
      trigger: input.trigger,
      autonomy: input.autonomy,
      assistantActive: input.status === "active",
      ...(input.requestToken !== undefined ? { requestToken: input.requestToken } : {}),
      delegation: needsDelegation ? resolveDelegationState(credential) : { status: "absent" },
      ...(needsDelegation && issuer !== undefined && this.options.minter
        ? (() => {
            const cached = this.options.minter.cached(input.scope, issuer);
            return cached !== undefined ? { cachedAccessToken: cached } : {};
          })()
        : {}),
      now: this.now(),
      requiresToolAuthority: input.requiresToolAuthority,
      ...(input.userInitiated !== undefined
        ? { userInitiated: input.userInitiated }
        : {}),
    });

    if (!decision.mintDelegated) return decision.authority;

    // The decision asked for a mint. Both "no minter" cases are configuration
    // gaps rather than user errors, and they are reported as such so an operator
    // reading the log can fix the deployment instead of chasing a consent problem.
    const minter = this.options.minter;
    if (minter === undefined || issuer === undefined) {
      return delegationMintFailure(
        "no OIDC client is configured on this deployment, so delegated tokens cannot be minted.",
      );
    }

    const minted = await minter.mint(input.scope, issuer);
    if (!minted.ok) {
      this.options.logger?.warn("Delegated authority unavailable", {
        assistantId: input.scope.assistantId,
        trigger: input.trigger,
        transient: minted.transient,
        detail: minted.detail,
      });
      return delegationMintFailure(minted.detail);
    }
    return completeDelegatedAuthority({
      token: minted.token.token,
      scope: minted.token.scope,
      expiresAt: minted.token.expiresAt,
    });
  }
}
