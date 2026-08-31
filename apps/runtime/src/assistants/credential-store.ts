// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant delegation credentials (`src/assistants/credential-store.ts`)
 *
 * Holds the OIDC refresh token a user explicitly delegated to one of their
 * assistants, encrypted at rest with {@link SecretCipher} — the same treatment
 * BYOK provider keys get, for the same reason: it must be recoverable, so a hash
 * will not do, and a database compromise alone must not yield it.
 *
 * ## What is and is not stored
 *
 * Stored: the refresh token (encrypted), the consented scope, the subject, and
 * failure bookkeeping. **Not** stored: access tokens. They are minted on demand
 * and held only in the process cache (`token-minter.ts`) for the few minutes they
 * are valid. Persisting them would multiply the number of places a live
 * credential can leak from while saving one IdP round trip per hour.
 *
 * ## Refresh-token rotation
 *
 * Most IdPs rotate the refresh token on each use and invalidate the old one. If
 * the rotated value is not written back, the grant works exactly once and then
 * appears broken. {@link recordRefreshSuccess} therefore accepts an optional new
 * refresh token and stores it in the same statement that clears the failure
 * counter.
 *
 * ## Failure accounting
 *
 * A refresh failure is counted, and past a threshold the grant is reported as
 * `broken` rather than `usable` (see {@link resolveDelegationState}). This turns a
 * silently non-functional assistant into a visible, diagnosable state — the
 * operator sees a broken grant, not an assistant that mysteriously stopped doing
 * its scheduled work.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { SecretCipher } from "../graph/secret-cipher.js";
import { toIso } from "./assistant-store.js";
import type { DelegationState } from "./execution-authority.js";
import type { AssistantScope } from "./types.js";

/**
 * Associated-data string binding a delegation credential's ciphertext to the
 * exact (tenant, user, assistant, issuer) row it belongs to. See
 * {@link SecretCipher} for why: without it, an `encrypted_refresh_token` value
 * copied to a different assistant's row (SQL-injection, backup restore, or
 * insider DB access) would decrypt successfully and hand that assistant
 * another user's delegated authority.
 */
export function credentialAad(scope: AssistantScope, issuer: string): string {
  return `assistant-cred:${scope.tenantId}:${scope.userId}:${scope.assistantId}:${issuer}`;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A delegation grant, with the refresh token already decrypted. */
export interface DelegationCredential {
  scope: AssistantScope;
  issuer: string;
  refreshToken: string;
  /** Scopes the user consented to delegate. */
  consentedScope: string;
  /** IdP subject the grant belongs to. */
  subject?: string;
  grantedAt: string;
  grantedBy?: string;
  lastRefreshedAt?: string;
  refreshFailures: number;
  revokedAt?: string;
}

/** Metadata projection that never exposes the refresh token. */
export interface DelegationSummary {
  scope: AssistantScope;
  issuer: string;
  consentedScope: string;
  subject?: string;
  grantedAt: string;
  grantedBy?: string;
  lastRefreshedAt?: string;
  refreshFailures: number;
  revoked: boolean;
  /** Derived state the authority decision consumes. */
  state: DelegationState["status"];
}

export interface DelegationGrantInput {
  scope: AssistantScope;
  issuer: string;
  refreshToken: string;
  consentedScope: string;
  subject?: string;
  /** User id that consented. Must be the assistant's owning user. */
  grantedBy: string;
}

// ---------------------------------------------------------------------------
// Operator-plane (cross-scope) listing — the Revocation Console's data source
// ---------------------------------------------------------------------------

/** Filters for the operator-plane delegation listing. */
export interface OperatorDelegationListParams {
  /** Restrict to one tenant. Omitted means every tenant. */
  tenantId?: string;
  /** Restrict to one user within the tenant. */
  userId?: string;
  /** Restrict to one assistant within the user. */
  assistantId?: string;
  /** Restrict to grants in this derived state (see {@link resolveDelegationState}). */
  state?: DelegationState["status"];
  limit?: number;
  offset?: number;
}

/** One page of the operator-plane delegation listing plus the unpaged total. */
export interface OperatorDelegationListPage {
  delegations: DelegationSummary[];
  /** Total matching the filter, so the console can show "1-50 of N". */
  total: number;
}

/** Largest page the operator plane will return in one request. */
export const OPERATOR_DELEGATION_LIST_MAX_LIMIT = 200;
const OPERATOR_DELEGATION_LIST_DEFAULT_LIMIT = 50;
/**
 * Upper bound on rows fetched from Postgres before the in-process `state`
 * filter and paging are applied (see {@link PostgresCredentialStore.listForOperator}).
 * Large enough that a real deployment's delegation count fits comfortably
 * within one query, while still bounding worst-case memory/CPU for a single
 * request.
 */
const OPERATOR_DELEGATION_QUERY_CAP = 5_000;

/** Clamps caller-supplied paging onto the bounds above. */
function boundOperatorPaging(params: OperatorDelegationListParams | undefined): {
  limit: number;
  offset: number;
} {
  const rawLimit = params?.limit;
  const limit =
    rawLimit === undefined || !Number.isFinite(rawLimit) || rawLimit <= 0
      ? OPERATOR_DELEGATION_LIST_DEFAULT_LIMIT
      : Math.min(Math.floor(rawLimit), OPERATOR_DELEGATION_LIST_MAX_LIMIT);
  const rawOffset = params?.offset;
  const offset =
    rawOffset === undefined || !Number.isFinite(rawOffset) || rawOffset <= 0
      ? 0
      : Math.floor(rawOffset);
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Failure threshold
// ---------------------------------------------------------------------------

/**
 * Consecutive refresh failures after which a grant is reported as broken.
 *
 * Three rather than one: a single failure is routinely a transient network or
 * IdP hiccup, and declaring a grant broken on the first one would make every
 * blip look like revoked consent. Three consecutive failures are not a blip.
 */
export const MAX_REFRESH_FAILURES = 3;

/** Derives the decision-facing delegation state from a stored credential. */
export function resolveDelegationState(
  credential: DelegationCredential | undefined,
): DelegationState {
  if (credential === undefined) return { status: "absent" };
  if (credential.revokedAt !== undefined) return { status: "revoked" };
  if (credential.refreshFailures >= MAX_REFRESH_FAILURES) {
    return { status: "broken", failures: credential.refreshFailures };
  }
  return { status: "usable", scope: credential.consentedScope };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a grant is attempted without an encryption key configured.
 *
 * Fails loudly rather than storing plaintext. A deployment that has not set
 * `SECRET_ENCRYPTION_KEY` cannot hold delegated credentials, and pretending
 * otherwise would put long-lived refresh tokens in the clear.
 */
export class DelegationEncryptionUnavailableError extends Error {
  constructor() {
    super(
      "Delegated assistant credentials require an encryption key. " +
        "Set the secret encryption key (SECRET_ENCRYPTION_KEY) before granting delegation; " +
        "refresh tokens are never stored in plaintext.",
    );
    this.name = "DelegationEncryptionUnavailableError";
  }
}

/** Raised when the consenting user is not the assistant's owner. */
export class DelegationConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationConsentError";
  }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface CredentialStore {
  /** Stores (or replaces) a delegation grant. */
  grant(input: DelegationGrantInput): Promise<DelegationSummary>;
  /** Reads the grant with its decrypted refresh token, or `undefined`. */
  read(scope: AssistantScope, issuer: string): Promise<DelegationCredential | undefined>;
  /** Metadata for every grant of an assistant. Never exposes tokens. */
  list(scope: AssistantScope): Promise<DelegationSummary[]>;
  /**
   * Delegation grants across users, for the OPERATOR plane (the Revocation
   * Console).
   *
   * Separate from {@link list} rather than a widened version of it, for the
   * same reason `AssistantStore.listForOperator` is separate from
   * `listForUser`: that method is reached from a single assistant's scope and
   * must never be able to return a row belonging to a different assistant.
   * Keeping the cross-scope query behind its own name means no caller can
   * accidentally turn a per-assistant listing into an estate-wide one.
   *
   * Never exposes refresh tokens — same as {@link list}.
   */
  listForOperator(
    params?: OperatorDelegationListParams,
  ): Promise<OperatorDelegationListPage>;
  /**
   * Marks a refresh as successful, clearing the failure counter and storing a
   * rotated refresh token when the IdP issued one.
   */
  recordRefreshSuccess(params: {
    scope: AssistantScope;
    issuer: string;
    rotatedRefreshToken?: string;
  }): Promise<void>;
  /** Increments the failure counter and returns the new value. */
  recordRefreshFailure(scope: AssistantScope, issuer: string): Promise<number>;
  /**
   * Revokes a grant. The row is retained with `revoked_at` set rather than
   * deleted, so the audit answer "this assistant once held delegation, granted
   * then, revoked then" survives.
   */
  revoke(scope: AssistantScope, issuer: string): Promise<void>;
  /** Removes every grant of the assistant. Erase/purge path only. */
  purge(scope: AssistantScope): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface StoredCredential extends DelegationCredential {}

/**
 * Process-local credential store.
 *
 * Still encrypts. A test or no-database deployment gaining plaintext storage
 * would make the encryption path the one that is never exercised, which is how
 * an encryption bug reaches production untested.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  constructor(private readonly cipher?: SecretCipher) {}

  private key(scope: AssistantScope, issuer: string): string {
    return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}\u001f${issuer}`;
  }

  async grant(input: DelegationGrantInput): Promise<DelegationSummary> {
    assertConsent(input);
    if (this.cipher === undefined) {
      throw new DelegationEncryptionUnavailableError();
    }
    // Round-trip through the cipher even in memory so the encryption path is
    // exercised by every test that grants delegation.
    const aad = credentialAad(input.scope, input.issuer);
    const sealed = this.cipher.encrypt(input.refreshToken, aad);
    const record: StoredCredential = {
      scope: input.scope,
      issuer: input.issuer,
      refreshToken: this.cipher.decrypt(sealed, aad),
      consentedScope: input.consentedScope,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      grantedAt: new Date().toISOString(),
      grantedBy: input.grantedBy,
      refreshFailures: 0,
    };
    this.rows.set(this.key(input.scope, input.issuer), record);
    return toSummary(record);
  }

  async read(scope: AssistantScope, issuer: string): Promise<DelegationCredential | undefined> {
    return this.rows.get(this.key(scope, issuer));
  }

  async list(scope: AssistantScope): Promise<DelegationSummary[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.scope.tenantId === scope.tenantId &&
          r.scope.userId === scope.userId &&
          r.scope.assistantId === scope.assistantId,
      )
      .map(toSummary);
  }

  async listForOperator(
    params?: OperatorDelegationListParams,
  ): Promise<OperatorDelegationListPage> {
    const { limit, offset } = boundOperatorPaging(params);
    const matched = [...this.rows.values()]
      .filter(
        (r) =>
          (params?.tenantId === undefined || r.scope.tenantId === params.tenantId) &&
          (params?.userId === undefined || r.scope.userId === params.userId) &&
          (params?.assistantId === undefined ||
            r.scope.assistantId === params.assistantId) &&
          (params?.state === undefined ||
            resolveDelegationState(r).status === params.state),
      )
      .sort(
        (a, b) =>
          a.scope.tenantId.localeCompare(b.scope.tenantId) ||
          a.scope.userId.localeCompare(b.scope.userId) ||
          a.scope.assistantId.localeCompare(b.scope.assistantId) ||
          a.issuer.localeCompare(b.issuer),
      );
    return {
      delegations: matched.slice(offset, offset + limit).map(toSummary),
      total: matched.length,
    };
  }

  async recordRefreshSuccess(params: {
    scope: AssistantScope;
    issuer: string;
    rotatedRefreshToken?: string;
  }): Promise<void> {
    const existing = this.rows.get(this.key(params.scope, params.issuer));
    if (existing === undefined) return;
    existing.refreshFailures = 0;
    existing.lastRefreshedAt = new Date().toISOString();
    if (params.rotatedRefreshToken !== undefined) {
      existing.refreshToken = params.rotatedRefreshToken;
    }
  }

  async recordRefreshFailure(scope: AssistantScope, issuer: string): Promise<number> {
    const existing = this.rows.get(this.key(scope, issuer));
    if (existing === undefined) return 0;
    existing.refreshFailures += 1;
    return existing.refreshFailures;
  }

  async revoke(scope: AssistantScope, issuer: string): Promise<void> {
    const existing = this.rows.get(this.key(scope, issuer));
    if (existing === undefined) return;
    existing.revokedAt = new Date().toISOString();
  }

  async purge(scope: AssistantScope): Promise<void> {
    for (const [key, row] of [...this.rows.entries()]) {
      if (
        row.scope.tenantId === scope.tenantId &&
        row.scope.userId === scope.userId &&
        row.scope.assistantId === scope.assistantId
      ) {
        this.rows.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface CredentialRow {
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  issuer: string;
  encrypted_refresh_token: string;
  scope: string;
  subject: string | null;
  granted_at: string | Date;
  granted_by: string | null;
  revoked_at: string | Date | null;
  last_refreshed_at: string | Date | null;
  refresh_failures: number;
}

/** Durable, encrypted delegation store. */
export class PostgresCredentialStore implements CredentialStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher | undefined,
    private readonly logger?: Logger,
  ) {}

  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  private rowToCredential(row: CredentialRow): DelegationCredential | undefined {
    if (this.cipher === undefined) {
      // A stored ciphertext with no key is not recoverable. Reporting the grant
      // as absent (rather than throwing) keeps the authority decision working:
      // the run degrades to no-authority with a stated reason instead of failing.
      this.logger?.error(
        "Assistant delegation grant exists but no encryption key is configured; treating it as unavailable.",
        { assistantId: row.assistant_id, issuer: row.issuer },
      );
      return undefined;
    }
    let refreshToken: string;
    try {
      const scope: AssistantScope = {
        tenantId: row.tenant_id,
        userId: row.user_id,
        assistantId: row.assistant_id,
      };
      refreshToken = this.cipher.decrypt(
        row.encrypted_refresh_token,
        credentialAad(scope, row.issuer),
      );
    } catch (err) {
      // Wrong key or tampered ciphertext. Same reasoning as above: degrade
      // visibly rather than crash the run.
      this.logger?.error("Failed to decrypt assistant delegation credential", {
        assistantId: row.assistant_id,
        issuer: row.issuer,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
    const subject = row.subject ?? undefined;
    const grantedBy = row.granted_by ?? undefined;
    const lastRefreshed = toIso(row.last_refreshed_at);
    const revoked = toIso(row.revoked_at);
    return {
      scope: {
        tenantId: row.tenant_id,
        userId: row.user_id,
        assistantId: row.assistant_id,
      },
      issuer: row.issuer,
      refreshToken,
      consentedScope: row.scope,
      ...(subject !== undefined ? { subject } : {}),
      grantedAt: toIso(row.granted_at) ?? new Date().toISOString(),
      ...(grantedBy !== undefined ? { grantedBy } : {}),
      ...(lastRefreshed !== undefined ? { lastRefreshedAt: lastRefreshed } : {}),
      refreshFailures: Number(row.refresh_failures),
      ...(revoked !== undefined ? { revokedAt: revoked } : {}),
    };
  }

  async grant(input: DelegationGrantInput): Promise<DelegationSummary> {
    assertConsent(input);
    if (this.cipher === undefined) {
      throw new DelegationEncryptionUnavailableError();
    }
    const sealed = this.cipher.encrypt(
      input.refreshToken,
      credentialAad(input.scope, input.issuer),
    );
    const rows = await this.scoped(input.scope.tenantId, (db) =>
      db.query<CredentialRow>(
        `INSERT INTO assistant_credentials
           (tenant_id, user_id, assistant_id, issuer, encrypted_refresh_token,
            scope, subject, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, user_id, assistant_id, issuer) DO UPDATE
           SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
               scope = EXCLUDED.scope,
               subject = EXCLUDED.subject,
               granted_by = EXCLUDED.granted_by,
               granted_at = now(),
               -- Re-granting clears both the revocation and the failure count:
               -- the user has just re-consented, so the previous grant's history
               -- must not keep the new one in a broken state.
               revoked_at = NULL,
               refresh_failures = 0
         RETURNING *`,
        [
          input.scope.tenantId,
          input.scope.userId,
          input.scope.assistantId,
          input.issuer,
          sealed,
          input.consentedScope,
          input.subject ?? null,
          input.grantedBy,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Granting assistant delegation returned no row.");
    }
    this.logger?.info("Granted assistant delegation", {
      assistantId: input.scope.assistantId,
      issuer: input.issuer,
      consentedScope: input.consentedScope,
    });
    const credential = this.rowToCredential(row);
    return credential !== undefined
      ? toSummary(credential)
      : {
          scope: input.scope,
          issuer: input.issuer,
          consentedScope: input.consentedScope,
          grantedAt: new Date().toISOString(),
          grantedBy: input.grantedBy,
          refreshFailures: 0,
          revoked: false,
          state: "broken",
        };
  }

  async read(scope: AssistantScope, issuer: string): Promise<DelegationCredential | undefined> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<CredentialRow>(
        `SELECT * FROM assistant_credentials
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND issuer = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, issuer],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : this.rowToCredential(row);
  }

  async list(scope: AssistantScope): Promise<DelegationSummary[]> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<CredentialRow>(
        `SELECT * FROM assistant_credentials
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
          ORDER BY issuer`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return rows.flatMap((row) => {
      const credential = this.rowToCredential(row);
      // An undecryptable grant is still reported — as broken. Hiding it would
      // leave the operator with an assistant that silently cannot act and no
      // indication that a credential exists at all.
      return credential !== undefined
        ? [toSummary(credential)]
        : [
            {
              scope: {
                tenantId: row.tenant_id,
                userId: row.user_id,
                assistantId: row.assistant_id,
              },
              issuer: row.issuer,
              consentedScope: row.scope,
              grantedAt: toIso(row.granted_at) ?? new Date().toISOString(),
              refreshFailures: Number(row.refresh_failures),
              revoked: row.revoked_at !== null,
              state: "broken" as const,
            },
          ];
    });
  }

  async listForOperator(
    params?: OperatorDelegationListParams,
  ): Promise<OperatorDelegationListPage> {
    const { limit, offset } = boundOperatorPaging(params);
    // `withOperator`, not `withTenant`: this listing spans tenants by design,
    // reachable only from the operator plane, which authorises before calling
    // here — same rationale as `AssistantStore.listForOperator`.
    //
    // The `state` filter (revoked/broken/usable) is derived from decrypted
    // credential fields via `resolveDelegationState`, which cannot be pushed
    // into SQL without duplicating that logic in a second place. Rather than
    // filter-then-paginate incorrectly (which would report a `total` that
    // does not match the returned rows, or silently truncate), the SQL layer
    // applies only the structural (tenant/user/assistant) filters and a hard
    // cap; the state filter and paging are applied in-process against that
    // bounded set. The cap keeps this a bounded operator-console query, not an
    // unbounded table scan.
    const rows = await this.db.withOperator((db) =>
      db.query<CredentialRow>(
        `SELECT * FROM assistant_credentials
          WHERE ($1::text IS NULL OR tenant_id = $1)
            AND ($2::text IS NULL OR user_id = $2)
            AND ($3::text IS NULL OR assistant_id = $3)
          ORDER BY tenant_id, user_id, assistant_id, issuer
          LIMIT $4`,
        [
          params?.tenantId ?? null,
          params?.userId ?? null,
          params?.assistantId ?? null,
          OPERATOR_DELEGATION_QUERY_CAP,
        ],
      ),
    );
    const summaries = rows.flatMap((row) => {
      const credential = this.rowToCredential(row);
      // Mirrors `list()`: an undecryptable grant is still reported, as broken,
      // rather than hidden — the console must show it exists even when its
      // ciphertext cannot currently be read.
      return credential !== undefined
        ? [toSummary(credential)]
        : [
            {
              scope: {
                tenantId: row.tenant_id,
                userId: row.user_id,
                assistantId: row.assistant_id,
              },
              issuer: row.issuer,
              consentedScope: row.scope,
              grantedAt: toIso(row.granted_at) ?? new Date().toISOString(),
              refreshFailures: Number(row.refresh_failures),
              revoked: row.revoked_at !== null,
              state: "broken" as const,
            },
          ];
    });
    const filtered =
      params?.state === undefined
        ? summaries
        : summaries.filter((s) => s.state === params.state);
    return {
      delegations: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  async recordRefreshSuccess(params: {
    scope: AssistantScope;
    issuer: string;
    rotatedRefreshToken?: string;
  }): Promise<void> {
    const rotated =
      params.rotatedRefreshToken !== undefined && this.cipher !== undefined
        ? this.cipher.encrypt(
            params.rotatedRefreshToken,
            credentialAad(params.scope, params.issuer),
          )
        : null;
    await this.scoped(params.scope.tenantId, (db) =>
      db.query(
        `UPDATE assistant_credentials
            SET refresh_failures = 0,
                last_refreshed_at = now(),
                -- Rotation is written in the SAME statement that clears the
                -- failure count. Splitting them would leave a window where a
                -- crash loses the rotated token while the old one is already
                -- invalidated by the IdP — a grant that works exactly once.
                encrypted_refresh_token =
                  COALESCE($5, encrypted_refresh_token)
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND issuer = $4`,
        [
          params.scope.tenantId,
          params.scope.userId,
          params.scope.assistantId,
          params.issuer,
          rotated,
        ],
      ),
    );
  }

  async recordRefreshFailure(scope: AssistantScope, issuer: string): Promise<number> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<{ refresh_failures: number }>(
        `UPDATE assistant_credentials
            SET refresh_failures = refresh_failures + 1
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND issuer = $4
          RETURNING refresh_failures`,
        [scope.tenantId, scope.userId, scope.assistantId, issuer],
      ),
    );
    const failures = Number(rows[0]?.refresh_failures ?? 0);
    if (failures >= MAX_REFRESH_FAILURES) {
      // Logged at warn, not debug: this is the point at which the assistant's
      // background work stops functioning, and it must be findable in the log
      // without knowing to look for it.
      this.logger?.warn(
        "Assistant delegation grant is now considered broken after repeated refresh failures",
        {
          assistantId: scope.assistantId,
          issuer,
          failures,
        },
      );
    }
    return failures;
  }

  async revoke(scope: AssistantScope, issuer: string): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `UPDATE assistant_credentials
            SET revoked_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND issuer = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, issuer],
      ),
    );
    this.logger?.info("Revoked assistant delegation", {
      assistantId: scope.assistantId,
      issuer,
    });
  }

  async purge(scope: AssistantScope): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `DELETE FROM assistant_credentials
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Verifies that the consenting user owns the assistant.
 *
 * Delegation is the user handing their own authority to their own assistant. A
 * third party consenting on their behalf would be privilege escalation dressed as
 * a convenience, so the check lives here — in the only path that writes a grant —
 * rather than in each caller.
 */
function assertConsent(input: DelegationGrantInput): void {
  if (input.grantedBy !== input.scope.userId) {
    throw new DelegationConsentError(
      "Only the assistant's own user may grant delegation. " +
        `Grant attempted by ${JSON.stringify(input.grantedBy)} for an assistant owned by ${JSON.stringify(input.scope.userId)}.`,
    );
  }
  if (input.refreshToken.trim().length === 0) {
    throw new DelegationConsentError(
      "A refresh token is required. The authorization request must include the " +
        "`offline_access` scope for the identity provider to issue one.",
    );
  }
}

function toSummary(credential: DelegationCredential): DelegationSummary {
  return {
    scope: credential.scope,
    issuer: credential.issuer,
    consentedScope: credential.consentedScope,
    ...(credential.subject !== undefined ? { subject: credential.subject } : {}),
    grantedAt: credential.grantedAt,
    ...(credential.grantedBy !== undefined ? { grantedBy: credential.grantedBy } : {}),
    ...(credential.lastRefreshedAt !== undefined
      ? { lastRefreshedAt: credential.lastRefreshedAt }
      : {}),
    refreshFailures: credential.refreshFailures,
    revoked: credential.revokedAt !== undefined,
    state: resolveDelegationState(credential).status,
  };
}

/** Builds the durable store when a database is available, else in-memory. */
export function createCredentialStore(params: {
  db?: Database;
  cipher?: SecretCipher;
  logger?: Logger;
}): CredentialStore {
  return params.db !== undefined
    ? new PostgresCredentialStore(params.db, params.cipher, params.logger)
    : new InMemoryCredentialStore(params.cipher);
}
