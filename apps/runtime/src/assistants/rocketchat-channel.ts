// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { trimTrailingSlashes } from "@atf/security-kit";

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import { egressFetch } from "../security/egress.js";
import type { Logger } from "../observability/logger.js";
import type { AssistantRun, PostgresAssistantRunStore } from "./run-store.js";
import type { AssistantScope } from "./types.js";

export interface RocketChatBinding {
  id: string;
  scope: AssistantScope;
  serverUrl: string;
  rocketUserId: string;
  rocketUsername?: string;
  roomId: string;
  flowId: string;
  enabled: boolean;
  consentedAt: string;
  verifiedAt?: string;
  pairingRequired: boolean;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RocketChatBindingInput {
  rocketUserId: string;
  rocketUsername?: string;
  roomId: string;
  flowId: string;
}

export class RocketChatBindingConflictError extends Error {
  constructor() {
    super("This Rocket.Chat identity is already bound to another assistant.");
    this.name = "RocketChatBindingConflictError";
  }
}

interface BindingRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  server_url: string;
  rocket_user_id: string;
  rocket_username: string | null;
  room_id: string;
  flow_id: string;
  enabled: boolean;
  consented_at: string | Date;
  verified_at: string | Date | null;
  pairing_code_hash: string | null;
  pairing_expires_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("ROCKETCHAT_BASE_URL must use HTTPS.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = trimTrailingSlashes(url.pathname);
  return url.toString().replace(/\/$/, "");
}

function pairingHash(value: string): string {
  return crypto.createHash("sha256").update(value.trim()).digest("hex");
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

export class PostgresRocketChatBindingStore {
  readonly serverUrl: string;

  constructor(
    private readonly db: Database,
    serverUrl: string,
  ) {
    this.serverUrl = normalizeBaseUrl(serverUrl);
  }

  private inTenant<T>(scope: AssistantScope, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(scope.tenantId, fn) : fn(this.db);
  }

  private binding(row: BindingRow): RocketChatBinding {
    return {
      id: row.id,
      scope: {
        tenantId: row.tenant_id,
        userId: row.user_id,
        assistantId: row.assistant_id,
      },
      serverUrl: row.server_url,
      rocketUserId: row.rocket_user_id,
      ...(row.rocket_username !== null ? { rocketUsername: row.rocket_username } : {}),
      roomId: row.room_id,
      flowId: row.flow_id,
      enabled: row.enabled,
      consentedAt: iso(row.consented_at),
      ...(row.verified_at !== null ? { verifiedAt: iso(row.verified_at) } : {}),
      pairingRequired: !row.enabled && row.revoked_at === null && row.pairing_code_hash !== null,
      ...(row.revoked_at !== null ? { revokedAt: iso(row.revoked_at) } : {}),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async get(scope: AssistantScope): Promise<RocketChatBinding | undefined> {
    const rows = await this.inTenant(scope, (db) =>
      db.query<BindingRow>(
        `SELECT * FROM assistant_rocketchat_bindings
        WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3
        ORDER BY created_at DESC LIMIT 1`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return rows[0] === undefined ? undefined : this.binding(rows[0]);
  }

  async getActive(scope: AssistantScope): Promise<RocketChatBinding | undefined> {
    const rows = await this.inTenant(scope, (db) =>
      db.query<BindingRow>(
        `SELECT b.* FROM assistant_rocketchat_bindings b
          JOIN assistants a ON a.tenant_id=b.tenant_id AND a.user_id=b.user_id
                           AND a.assistant_id=b.assistant_id AND a.status='active'
         WHERE b.tenant_id=$1 AND b.user_id=$2 AND b.assistant_id=$3
           AND b.enabled AND b.revoked_at IS NULL
         ORDER BY b.created_at DESC LIMIT 1`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return rows[0] === undefined ? undefined : this.binding(rows[0]);
  }

  async getActiveById(scope: AssistantScope, id: string): Promise<RocketChatBinding | undefined> {
    const rows = await this.inTenant(scope, (db) =>
      db.query<BindingRow>(
        `SELECT b.* FROM assistant_rocketchat_bindings b
          JOIN assistants a ON a.tenant_id=b.tenant_id AND a.user_id=b.user_id
                           AND a.assistant_id=b.assistant_id AND a.status='active'
         WHERE b.id=$4::uuid AND b.tenant_id=$1 AND b.user_id=$2 AND b.assistant_id=$3
           AND b.enabled AND b.revoked_at IS NULL`,
        [scope.tenantId, scope.userId, scope.assistantId, id],
      ),
    );
    return rows[0] === undefined ? undefined : this.binding(rows[0]);
  }

  async put(
    scope: AssistantScope,
    input: RocketChatBindingInput,
  ): Promise<{ binding: RocketChatBinding; pairingCode: string }> {
    const pairingCode = `AIPERATOR-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const rows = await this.inTenant(scope, (db) =>
      db.query<BindingRow>(
        `WITH revoked AS (
           UPDATE assistant_rocketchat_bindings
              SET enabled=false,revoked_at=now(),pairing_code_hash=NULL,
                  pairing_expires_at=NULL,updated_at=now()
            WHERE tenant_id=$2 AND user_id=$3 AND assistant_id=$4
              AND revoked_at IS NULL RETURNING id
         ), cancelled AS (
           UPDATE assistant_rocketchat_outbox
              SET cancelled_at=now(),lease_owner=NULL,lease_expires_at=NULL
            WHERE binding_id IN (SELECT id FROM revoked)
              AND delivered_at IS NULL AND cancelled_at IS NULL
         )
         INSERT INTO assistant_rocketchat_bindings
           (id,tenant_id,user_id,assistant_id,server_url,rocket_user_id,rocket_username,room_id,flow_id,
            enabled,consented_at,verified_at,pairing_code_hash,pairing_expires_at,revoked_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,false,now(),NULL,$10,
                 now()+interval '15 minutes',NULL)
         RETURNING *`,
        [
          crypto.randomUUID(),
          scope.tenantId,
          scope.userId,
          scope.assistantId,
          this.serverUrl,
          input.rocketUserId,
          input.rocketUsername ?? null,
          input.roomId,
          input.flowId,
          pairingHash(pairingCode),
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("Could not create Rocket.Chat pairing.");
    return { binding: this.binding(row), pairingCode };
  }

  async confirmPairing(
    rocketUserId: string,
    roomId: string,
    pairingCode: string,
  ): Promise<RocketChatBinding | undefined> {
    try {
      const rows = await this.db.withOperator((db) =>
        db.query<BindingRow>(
          `UPDATE assistant_rocketchat_bindings b
              SET enabled=true,verified_at=now(),pairing_code_hash=NULL,
                  pairing_expires_at=NULL,updated_at=now()
            WHERE b.server_url=$1 AND b.rocket_user_id=$2 AND b.room_id=$3
              AND b.pairing_code_hash=$4 AND b.pairing_expires_at>now()
              AND b.revoked_at IS NULL AND EXISTS (
                SELECT 1 FROM assistants a
                 WHERE a.tenant_id=b.tenant_id AND a.user_id=b.user_id
                   AND a.assistant_id=b.assistant_id AND a.status='active'
              )
            RETURNING b.*`,
          [this.serverUrl, rocketUserId, roomId, pairingHash(pairingCode)],
        ),
      );
      return rows.length === 1 && rows[0] !== undefined ? this.binding(rows[0]) : undefined;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "23505"
      ) {
        throw new RocketChatBindingConflictError();
      }
      throw error;
    }
  }

  async revoke(scope: AssistantScope): Promise<boolean> {
    const rows = await this.inTenant(scope, (db) =>
      db.query(
        `WITH revoked AS (
           UPDATE assistant_rocketchat_bindings
              SET enabled=false, revoked_at=now(), updated_at=now()
            WHERE tenant_id=$1 AND user_id=$2 AND assistant_id=$3
              AND revoked_at IS NULL RETURNING id
         ), cancelled AS (
           UPDATE assistant_rocketchat_outbox
              SET cancelled_at=now(), lease_owner=NULL, lease_expires_at=NULL
            WHERE binding_id IN (SELECT id FROM revoked)
              AND delivered_at IS NULL AND cancelled_at IS NULL
         )
         SELECT id FROM revoked`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return rows.length === 1;
  }

  async revokeInbound(rocketUserId: string, roomId: string): Promise<boolean> {
    const rows = await this.db.withOperator((db) =>
      db.query(
        `WITH revoked AS (
           UPDATE assistant_rocketchat_bindings
              SET enabled=false, revoked_at=now(), pairing_code_hash=NULL,
                  pairing_expires_at=NULL, updated_at=now()
            WHERE server_url=$1 AND rocket_user_id=$2 AND room_id=$3
              AND enabled AND revoked_at IS NULL RETURNING id
         ), cancelled AS (
           UPDATE assistant_rocketchat_outbox
              SET cancelled_at=now(), lease_owner=NULL, lease_expires_at=NULL
            WHERE binding_id IN (SELECT id FROM revoked)
              AND delivered_at IS NULL AND cancelled_at IS NULL
         )
         SELECT id FROM revoked`,
        [this.serverUrl, rocketUserId, roomId],
      ),
    );
    return rows.length === 1;
  }

  async resolveInbound(
    rocketUserId: string,
    roomId: string,
  ): Promise<RocketChatBinding | undefined> {
    const rows = await this.db.withOperator((db) =>
      db.query<BindingRow>(
        `SELECT b.* FROM assistant_rocketchat_bindings b
          JOIN assistants a ON a.tenant_id=b.tenant_id AND a.user_id=b.user_id
                           AND a.assistant_id=b.assistant_id AND a.status='active'
         WHERE b.server_url=$1 AND b.rocket_user_id=$2 AND b.room_id=$3
           AND b.enabled AND b.revoked_at IS NULL LIMIT 2`,
        [this.serverUrl, rocketUserId, roomId],
      ),
    );
    return rows.length === 1 && rows[0] !== undefined ? this.binding(rows[0]) : undefined;
  }
}

export interface RocketChatClientOptions {
  baseUrl: string;
  botUserId: string;
  authToken: string;
  timeoutMs?: number;
  /** Guarded outbound fetch (Egress_Guard, Req 7.1/7.2). */
  fetchFn?: typeof fetch;
}

export class RocketChatClient {
  readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly updateEndpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: RocketChatClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.endpoint = new URL(
      "/api/v1/chat.sendMessage",
      `${this.baseUrl}/`,
    ).toString();
    this.updateEndpoint = new URL(
      "/api/v1/chat.update",
      `${this.baseUrl}/`,
    ).toString();
    this.fetchFn = options.fetchFn ?? egressFetch;
  }

  private requestOptions(body: Record<string, unknown>): RequestInit {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Auth-Token": this.options.authToken,
        "X-User-Id": this.options.botUserId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        Math.min(60_000, Math.max(1_000, this.options.timeoutMs ?? 10_000)),
      ),
    };
  }

  async verifiedPrimaryEmail(
    rocketUserId: string,
  ): Promise<string | undefined> {
    const endpoint = new URL(
      `/api/v1/users.info?userId=${encodeURIComponent(rocketUserId)}`,
      `${this.baseUrl}/`,
    );
    const response = await this.fetchFn(endpoint, {
      headers: {
        "X-Auth-Token": this.options.authToken,
        "X-User-Id": this.options.botUserId,
      },
      signal: AbortSignal.timeout(
        Math.min(60_000, Math.max(1_000, this.options.timeoutMs ?? 10_000)),
      ),
    });
    if (!response.ok)
      throw new Error(
        `Rocket.Chat user lookup failed with HTTP ${response.status}.`,
      );
    const payload = (await response.json()) as {
      user?: { emails?: Array<{ address?: string; verified?: boolean }> };
    };
    const address = payload.user?.emails?.find(
      (entry) => entry.verified === true && typeof entry.address === "string",
    )?.address;
    return address?.trim().toLowerCase();
  }

  private async apiResult(
    response: Response,
  ): Promise<{ body: string; succeeded: boolean }> {
    const body = await response.text();
    let declaredSuccess: unknown;
    if (body.length > 0) {
      try {
        declaredSuccess = (JSON.parse(body) as { success?: unknown }).success;
      } catch {
        // Some Rocket.Chat versions return an empty or non-JSON success body.
      }
    }
    return { body, succeeded: response.ok && declaredSuccess !== false };
  }

  private apiError(operation: string, response: Response, body: string): Error {
    let detail: string | undefined;
    if (body.length > 0) {
      try {
        const payload = JSON.parse(body) as {
          error?: unknown;
          errorType?: unknown;
          message?: unknown;
        };
        detail = [payload.errorType, payload.error, payload.message].find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        );
      } catch {
        // Avoid logging an arbitrary HTML/proxy response body.
      }
    }
    const suffix =
      detail === undefined
        ? ""
        : ` (${detail.replace(/\s+/g, " ").slice(0, 200)})`;
    return new Error(
      `${operation} failed with HTTP ${response.status}${suffix}.`,
    );
  }

  private isDuplicateMessage(response: Response, body: string): boolean {
    if (response.status !== 400 && response.status !== 409 && !response.ok)
      return false;
    return /duplicate|already exists|error-message-id-already-exists/i.test(
      body,
    );
  }

  private async createMessage(input: {
    messageId: string;
    roomId: string;
    text: string;
  }): Promise<"created" | "exists"> {
    const response = await this.fetchFn(
      this.endpoint,
      this.requestOptions({
        message: { _id: input.messageId, rid: input.roomId, msg: input.text },
      }),
    );
    const result = await this.apiResult(response);
    if (result.succeeded) return "created";
    // A retry after Rocket.Chat accepted the deterministic `_id` but before our
    // acknowledgement is safe: a duplicate means the intended message exists.
    if (this.isDuplicateMessage(response, result.body)) return "exists";
    throw this.apiError("Rocket.Chat delivery", response, result.body);
  }

  private async tryUpdateMessage(input: {
    messageId: string;
    roomId: string;
    text: string;
  }): Promise<void> {
    const response = await this.fetchFn(
      this.updateEndpoint,
      this.requestOptions({
        roomId: input.roomId,
        msgId: input.messageId,
        text: input.text,
      }),
    );
    const result = await this.apiResult(response);
    if (result.succeeded) return;
    throw this.apiError("Rocket.Chat message update", response, result.body);
  }

  async sendMessage(input: {
    messageId: string;
    roomId: string;
    text: string;
  }): Promise<void> {
    await this.createMessage(input);
  }

  async updateMessage(input: {
    messageId: string;
    roomId: string;
    text: string;
  }): Promise<void> {
    await this.tryUpdateMessage(input);
  }

  /** Updates a deterministic message, creating it after any failed first update. */
  async upsertMessage(input: {
    messageId: string;
    roomId: string;
    text: string;
  }): Promise<void> {
    try {
      await this.tryUpdateMessage(input);
      return;
    } catch (updateError) {
      try {
        if ((await this.createMessage(input)) === "created") return;
      } catch (createError) {
        const updateMessage =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);
        const createMessage =
          createError instanceof Error
            ? createError.message
            : String(createError);
        throw new Error(
          `Rocket.Chat upsert failed: ${updateMessage}; ${createMessage}`,
        );
      }
    }
    // Another delivery may have created the deterministic id between our update
    // and create calls. Resolve that race by applying the intended text now.
    await this.tryUpdateMessage(input);
  }
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  external_message_id: string;
  room_id: string;
  message_text: string;
  finalized: boolean;
}

export interface RocketChatQueuedMessage {
  messageId: string;
  roomId: string;
  text: string;
}

function externalMessageId(runId: string): string {
  return `aiperator-${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

export class RocketChatOutbox {
  constructor(
    private readonly db: Database,
    private readonly bindings: PostgresRocketChatBindingStore,
  ) {}

  private async enqueueRunMessage(
    run: AssistantRun,
    text: string,
    finalized: boolean,
  ): Promise<RocketChatQueuedMessage | undefined> {
    const bindingId =
      typeof run.resumePayload.bindingId === "string" ? run.resumePayload.bindingId : undefined;
    const binding =
      bindingId === undefined ? undefined : await this.bindings.getActiveById(run.scope, bindingId);
    if (binding === undefined || !binding.enabled || binding.revokedAt !== undefined)
      return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    const inTenant =
      this.db.withTenant !== undefined
        ? this.db.withTenant.bind(this.db)
        : async <T>(_tenantId: string, fn: (db: Database) => Promise<T>): Promise<T> => fn(this.db);
    const rows = await inTenant(run.scope.tenantId, (db) =>
      db.query<OutboxRow>(
        `INSERT INTO assistant_rocketchat_outbox
         (id,tenant_id,user_id,assistant_id,binding_id,run_id,external_message_id,room_id,message_text,finalized)
       SELECT $1::uuid,$2,$3,$4,b.id,$5::uuid,$6,b.room_id,$7,$9
         FROM assistant_rocketchat_bindings b
        WHERE b.id=$8::uuid AND b.tenant_id=$2 AND b.user_id=$3 AND b.assistant_id=$4
          AND b.enabled AND b.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM assistants a
            WHERE a.tenant_id=b.tenant_id AND a.user_id=b.user_id
              AND a.assistant_id=b.assistant_id AND a.status='active')
       ON CONFLICT (tenant_id,external_message_id) DO UPDATE
         SET message_text=CASE
               WHEN assistant_rocketchat_outbox.finalized
               THEN assistant_rocketchat_outbox.message_text ELSE EXCLUDED.message_text END,
             finalized=assistant_rocketchat_outbox.finalized OR EXCLUDED.finalized,
             delivered_at=CASE
               WHEN assistant_rocketchat_outbox.finalized
               THEN assistant_rocketchat_outbox.delivered_at ELSE NULL END,
             available_at=CASE
               WHEN assistant_rocketchat_outbox.finalized
               THEN assistant_rocketchat_outbox.available_at ELSE now() END,
             last_error=CASE
               WHEN assistant_rocketchat_outbox.finalized
               THEN assistant_rocketchat_outbox.last_error ELSE NULL END
         WHERE assistant_rocketchat_outbox.cancelled_at IS NULL
       RETURNING id,tenant_id,user_id,assistant_id,external_message_id,room_id,message_text,finalized`,
        [
          crypto.randomUUID(),
          run.scope.tenantId,
          run.scope.userId,
          run.scope.assistantId,
          run.id,
          externalMessageId(run.id),
          trimmed,
          binding.id,
          finalized,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined || (!finalized && row.finalized)) return undefined;
    return {
      messageId: row.external_message_id,
      roomId: row.room_id,
      text: row.message_text,
    };
  }

  enqueueRunProgress(
    run: AssistantRun,
    text: string,
  ): Promise<RocketChatQueuedMessage | undefined> {
    return this.enqueueRunMessage(run, text, false);
  }

  enqueueRunResult(run: AssistantRun, text: string): Promise<RocketChatQueuedMessage | undefined> {
    return this.enqueueRunMessage(run, text, true);
  }
}

export class RocketChatOutboxSweeper {
  constructor(
    private readonly db: Database,
    private readonly client: RocketChatClient,
    private readonly logger?: Logger,
  ) {}

  private async deliver(row: OutboxRow, owner: string): Promise<void> {
    await this.db.withOperator(async (operatorDb) => {
      const execute = async (db: Database): Promise<void> => {
        await db.query("BEGIN");
        try {
          const active = await db.query<OutboxRow>(
            `SELECT o.id,o.tenant_id,o.user_id,o.assistant_id,o.external_message_id,
                    o.room_id,o.message_text,o.finalized
               FROM assistant_rocketchat_outbox o
              JOIN assistant_rocketchat_bindings b ON b.id=o.binding_id
              JOIN assistants a ON a.tenant_id=o.tenant_id AND a.user_id=o.user_id
                               AND a.assistant_id=o.assistant_id AND a.status='active'
             WHERE o.id=$1::uuid AND o.lease_owner=$2
               AND o.delivered_at IS NULL AND o.cancelled_at IS NULL
               AND b.enabled AND b.revoked_at IS NULL
             FOR UPDATE OF o`,
            [row.id, owner],
          );
          const current = active[0];
          if (current === undefined) {
            await db.query("COMMIT");
            return;
          }
          // The row lock is held across the external call. Revoke/rebind waits
          // for this transaction, so once it returns no old-generation send can
          // start or still be in flight. Reading the text under that same lock
          // prevents a claimed stale progress revision from overwriting the final.
          await this.client.upsertMessage({
            messageId: current.external_message_id,
            roomId: current.room_id,
            text: current.message_text,
          });
          await db.query(
            `UPDATE assistant_rocketchat_outbox
                SET delivered_at=now(),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL
              WHERE id=$1::uuid AND lease_owner=$2`,
            [row.id, owner],
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      };
      if (operatorDb.withConnection !== undefined) {
        await operatorDb.withConnection(execute);
      } else {
        await execute(operatorDb);
      }
    });
  }

  async sweep(limit = 50, leaseMs = 60_000): Promise<number> {
    const owner = crypto.randomUUID();
    await this.db.withOperator((db) =>
      db.query(
        `UPDATE assistant_rocketchat_outbox o
            SET cancelled_at=now(),lease_owner=NULL,lease_expires_at=NULL
          WHERE o.delivered_at IS NULL AND o.cancelled_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM assistant_rocketchat_bindings b
                JOIN assistants a ON a.tenant_id=b.tenant_id AND a.user_id=b.user_id
                                 AND a.assistant_id=b.assistant_id AND a.status='active'
               WHERE b.id=o.binding_id AND b.tenant_id=o.tenant_id
                 AND b.user_id=o.user_id AND b.assistant_id=o.assistant_id
                 AND b.enabled AND b.revoked_at IS NULL
            )`,
      ),
    );
    const rows = await this.db.withOperator((db) =>
      db.query<OutboxRow>(
        `WITH candidates AS (
         SELECT id FROM assistant_rocketchat_outbox
          WHERE delivered_at IS NULL AND cancelled_at IS NULL AND available_at<=now()
            AND (lease_expires_at IS NULL OR lease_expires_at<=now())
          ORDER BY available_at LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE assistant_rocketchat_outbox o SET lease_owner=$2,
         lease_expires_at=now()+($3::bigint*interval '1 millisecond')
       FROM candidates WHERE o.id=candidates.id
       RETURNING o.id,o.tenant_id,o.user_id,o.assistant_id,o.external_message_id,o.room_id,
                 o.message_text,o.finalized`,
        [Math.min(200, Math.max(1, limit)), owner, Math.min(900_000, Math.max(1_000, leaseMs))],
      ),
    );
    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.deliver(row, owner);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const attempts = await this.db.withOperator((db) =>
            db.query<{ attempts: number }>(
              `UPDATE assistant_rocketchat_outbox SET attempts=attempts+1,last_error=$3,
             available_at=now()+(LEAST(3600,2^LEAST(attempts,10))*interval '1 second'),
             lease_owner=NULL,lease_expires_at=NULL
           WHERE id=$1::uuid AND lease_owner=$2 RETURNING attempts`,
              [row.id, owner, errorMessage],
            ),
          );
          this.logger?.warn("Rocket.Chat delivery failed; retained for retry", {
            outboxId: row.id,
            attempts: attempts[0]?.attempts,
            error: errorMessage,
          });
        }
      }),
    );
    return rows.length;
  }
}

export class RocketChatOutboxScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly sweeper: RocketChatOutboxSweeper,
    private readonly logger?: Logger,
  ) {}

  private run(): void {
    void this.sweeper.sweep().catch((error: unknown) => {
      this.logger?.error("Rocket.Chat outbox sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  start(intervalMs = 10_000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.run(), Math.max(1_000, intervalMs));
    this.timer.unref?.();
    this.run();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export interface RocketChatChannel {
  botUserId: string;
  webhookToken: string;
  bindings: PostgresRocketChatBindingStore;
  outbox: RocketChatOutbox;
  /** Immediately drains pending revisions through the same locked path as scheduled retries. */
  flushOutbox: () => Promise<number>;
  runs: PostgresAssistantRunStore;
  /** The bot's PAT-backed REST client; used only for verified-email lookup and replies. */
  client: RocketChatClient;
}
