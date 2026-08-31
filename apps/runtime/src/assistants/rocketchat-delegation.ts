// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { SecretCipher } from "../graph/secret-cipher.js";
import { credentialAad } from "./credential-store.js";
import type { AssistantScope } from "./types.js";

export interface RocketChatDelegationBridge {
  readonly issuer: string;
  readonly clientId: string;
  stage(params: {
    requestId: string;
    subject: string;
    refreshToken: string;
    consentedScope: string;
  }): Promise<void>;
  consumeAndActivate(params: {
    requestId: string;
    subject: string;
    scope: AssistantScope;
    serverUrl: string;
    flowId: string;
  }): Promise<string>;
  shutdown(): void;
}

interface StagedGrantRow {
  encrypted_refresh_token: string;
  oidc_scope: string;
  rocket_user_id: string;
  room_id: string;
}

function stagingAad(requestId: string, subject: string, issuer: string): string {
  return `rocketchat-connect:${requestId}:${subject}:${issuer}`;
}

export class PostgresRocketChatDelegationBridge
  implements RocketChatDelegationBridge
{
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    readonly issuer: string,
    readonly clientId: string,
  ) {
    void this.clearExpired();
    this.cleanupTimer = setInterval(() => void this.clearExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  shutdown(): void {
    clearInterval(this.cleanupTimer);
  }

  private async clearExpired(): Promise<void> {
    await this.db
      .withOperator((db) =>
        db.query(
          `UPDATE rocketchat_connect_requests
              SET encrypted_refresh_token = NULL, oidc_scope = NULL,
                  oidc_issuer = NULL, delegation_consumed_at = NULL
            WHERE (expires_at <= now() OR consumed_at IS NOT NULL)
              AND encrypted_refresh_token IS NOT NULL`,
        ),
      )
      .catch(() => undefined);
  }

  async stage(params: {
    requestId: string;
    subject: string;
    refreshToken: string;
    consentedScope: string;
  }): Promise<void> {
    if (params.refreshToken.trim().length === 0) {
      throw new Error("The identity provider returned no refresh token.");
    }
    const sealed = this.cipher.encrypt(
      params.refreshToken,
      stagingAad(params.requestId, params.subject, this.issuer),
    );
    const updated = await this.db.withOperator((db) =>
      db.query<{ id: string }>(
        `UPDATE rocketchat_connect_requests
            SET oidc_subject = $2, encrypted_refresh_token = $3,
                oidc_scope = $4, oidc_issuer = $5,
                delegation_consumed_at = NULL
          WHERE id = $1::uuid AND consumed_at IS NULL AND expires_at > now()
          RETURNING id`,
        [
          params.requestId,
          params.subject,
          sealed,
          params.consentedScope,
          this.issuer,
        ],
      ),
    );
    if (updated.length !== 1) {
      throw new Error("The Rocket.Chat connection request expired before delegation was staged.");
    }
  }

  async consumeAndActivate(params: {
    requestId: string;
    subject: string;
    scope: AssistantScope;
    serverUrl: string;
    flowId: string;
  }): Promise<string> {
    if (params.scope.userId !== params.subject) {
      throw new Error("The delegation subject does not own the selected assistant.");
    }
    return this.db.withOperator(async (operatorDb) => {
      const execute = async (db: Database): Promise<string> => {
        await db.query("BEGIN");
        try {
          const rows = await db.query<StagedGrantRow>(
            `SELECT encrypted_refresh_token, oidc_scope, rocket_user_id, room_id
               FROM rocketchat_connect_requests
              WHERE id = $1::uuid AND oidc_subject = $2
                AND consumed_at IS NULL AND expires_at > now()
                AND encrypted_refresh_token IS NOT NULL
                AND oidc_scope IS NOT NULL AND oidc_issuer = $3
              FOR UPDATE`,
            [params.requestId, params.subject, this.issuer],
          );
          const staged = rows[0];
          if (staged === undefined) {
            throw new Error(
              "No usable delegated credential is staged for this connection request.",
            );
          }
          const refreshToken = this.cipher.decrypt(
            staged.encrypted_refresh_token,
            stagingAad(params.requestId, params.subject, this.issuer),
          );
          const finalCiphertext = this.cipher.encrypt(
            refreshToken,
            credentialAad(params.scope, this.issuer),
          );
          await db.query(
            `INSERT INTO assistant_credentials
               (tenant_id, user_id, assistant_id, issuer,
                encrypted_refresh_token, scope, subject, granted_by)
             VALUES ($1,$2,$3,$4,$5,$6,$2,$2)
             ON CONFLICT (tenant_id,user_id,assistant_id,issuer) DO UPDATE
               SET encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
                   scope=EXCLUDED.scope, subject=EXCLUDED.subject,
                   granted_by=EXCLUDED.granted_by, granted_at=now(),
                   revoked_at=NULL, refresh_failures=0`,
            [
              params.scope.tenantId,
              params.scope.userId,
              params.scope.assistantId,
              this.issuer,
              finalCiphertext,
              staged.oidc_scope,
            ],
          );
          await db.query(
            `UPDATE assistant_rocketchat_bindings
                SET enabled=false, revoked_at=now(), updated_at=now()
              WHERE server_url=$1 AND rocket_user_id=$2 AND room_id=$3
                AND enabled AND revoked_at IS NULL`,
            [params.serverUrl, staged.rocket_user_id, staged.room_id],
          );
          const bindingId = crypto.randomUUID();
          await db.query(
            `INSERT INTO assistant_rocketchat_bindings
               (id,tenant_id,user_id,assistant_id,server_url,rocket_user_id,
                room_id,flow_id,enabled,consented_at,verified_at)
             VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,true,now(),now())`,
            [
              bindingId,
              params.scope.tenantId,
              params.scope.userId,
              params.scope.assistantId,
              params.serverUrl,
              staged.rocket_user_id,
              staged.room_id,
              params.flowId,
            ],
          );
          await db.query(
            `UPDATE rocketchat_connect_requests
                SET consumed_at=now(), delegation_consumed_at=now(),
                    encrypted_refresh_token=NULL, oidc_scope=NULL,
                    oidc_issuer=NULL
              WHERE id=$1::uuid AND oidc_subject=$2`,
            [params.requestId, params.subject],
          );
          await db.query("COMMIT");
          return bindingId;
        } catch (error) {
          await db.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      };
      return operatorDb.withConnection !== undefined
        ? operatorDb.withConnection(execute)
        : execute(operatorDb);
    });
  }
}
