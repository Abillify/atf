// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import type { AssistantScope } from "./types.js";
import type { TranscriptEntry } from "./transcript-store.js";
import type { WorkspaceTranscriptStore } from "./transcript-store.js";

interface OutboxRow {
  id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  payload: TranscriptEntry;
}

/**
 * Delivers the optional workspace JSONL projection after the authoritative
 * Postgres commit. A lease makes concurrent sweepers safe; appendProjected is
 * event-id idempotent, so a crash after file write and before acknowledgement is
 * reconciled by the next sweep.
 */
export class AssistantMirrorOutboxSweeper {
  constructor(private readonly db: Database, private readonly workspace: WorkspaceTranscriptStore, private readonly logger?: Logger) {}

  async sweep(limit = 50, leaseMs = 60_000): Promise<number> {
    const owner = crypto.randomUUID();
    const rows = await this.db.withOperator((db) => db.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id FROM assistant_mirror_outbox
          WHERE delivered_at IS NULL AND available_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY available_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE assistant_mirror_outbox o SET lease_owner = $2,
         lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
       FROM candidates WHERE o.id = candidates.id
       RETURNING o.id, o.tenant_id, o.user_id, o.assistant_id, o.payload`,
      [Math.min(Math.max(limit, 1), 200), owner, Math.min(Math.max(leaseMs, 1_000), 15 * 60_000)],
    ));
    for (const row of rows) {
      const scope: AssistantScope = { tenantId: row.tenant_id, userId: row.user_id, assistantId: row.assistant_id };
      try {
        await this.workspace.appendProjected(scope, row.payload);
        await this.db.withOperator((db) => db.query(
          `UPDATE assistant_mirror_outbox SET delivered_at = now(), lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1::uuid AND lease_owner = $2`, [row.id, owner],
        ));
      } catch (error) {
        const attempts = await this.db.withOperator((db) => db.query<{ attempts: number }>(
          `UPDATE assistant_mirror_outbox SET attempts = attempts + 1, last_error = $3,
             available_at = now() + (LEAST(3600, 2 ^ LEAST(attempts, 10)) * interval '1 second'),
             lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $1::uuid AND lease_owner = $2 RETURNING attempts`,
          [row.id, owner, error instanceof Error ? error.message : String(error)],
        ));
        this.logger?.warn("Assistant workspace mirror delivery failed; retained for retry", { outboxId: row.id, attempts: attempts[0]?.attempts });
      }
    }
    return rows.length;
  }
}

export class AssistantMirrorOutboxScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly sweeper: AssistantMirrorOutboxSweeper) {}
  start(intervalMs = 10_000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.sweeper.sweep(); }, Math.max(1_000, intervalMs));
    this.timer.unref?.();
    void this.sweeper.sweep();
  }
  stop(): void { if (this.timer !== undefined) clearInterval(this.timer); this.timer = undefined; }
}
