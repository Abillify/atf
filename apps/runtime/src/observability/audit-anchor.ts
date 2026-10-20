// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Audit chain anchoring service (`src/observability/audit-anchor.ts`)
 *
 * The audit log (`audit-log.ts`) is a SHA-256 hash chain. On its own that
 * detects an isolated edit/delete/reorder, but an attacker with sustained
 * database write access can recompute the ENTIRE chain consistently and
 * {@link verifyAuditChain} would still report `valid: true`. The only defence
 * against that is an EXTERNAL, signed checkpoint of the chain tip kept OUTSIDE
 * the audit database — `signAuditAnchor`/`verifyAuditAnchor` were provided for
 * exactly this but were never wired to a scheduler (they only appeared in
 * tests). This service closes that gap:
 *
 *   - Periodically (and on demand) it signs the current chain tip with the
 *     shared Ed25519 evidence key (`EVIDENCE_SIGNING_KEY`, ADR 0030) so the
 *     anchor is verifiable offline by auditors via the published evidence
 *     JWKS — or, when no asymmetric key is configured, with the operator-held
 *     HMAC secret (`AUDIT_ANCHOR_SECRET`) that lives in the
 *     environment/secret store, NOT in the audit database (legacy form;
 *     anchors produced this way stay verifiable for existing deployments).
 *   - It keeps the latest anchor in memory and, when `AUDIT_ANCHOR_FILE` is
 *     set, appends each anchor to an append-only JSONL file (intended to sit on
 *     separate storage / a log shipper — the "outside the DB" requirement).
 *   - {@link verifyLatest} re-checks the stored anchor against the CURRENT
 *     chain, so a wholesale rebuild after the anchor was taken is detectable.
 *
 * The compliance dossier consumes {@link AuditAnchorService.status} so its
 * `tamperEvident` claim reflects whether external anchoring is actually active
 * and still verifies — instead of being a hard-coded literal.
 *
 * Key-gated: with neither `EVIDENCE_SIGNING_KEY` nor `AUDIT_ANCHOR_SECRET`
 * configured the service is not constructed and the dossier reports chain-only
 * integrity honestly.
 *
 * No `any` at module boundaries.
 */

import { appendFile } from "node:fs/promises";
import {
  signAuditAnchor,
  verifyAuditAnchor,
  type AuditChainAnchor,
  type AuditLog,
} from "./audit-log.js";
import type { Ed25519EvidenceKey } from "./evidence-key.js";
import type { Logger } from "./logger.js";

export interface AuditAnchorStatus {
  /** Whether anchoring is configured/active at all. */
  active: boolean;
  /** The most recent anchor produced (in memory), if any. */
  latest?: AuditChainAnchor;
  /** Result of re-verifying {@link latest} against the current chain. */
  verified?: boolean;
  /** Why verification failed, when it did. */
  reason?: "record_not_found" | "hash_mismatch" | "signature_mismatch";
}

export interface AuditAnchorService {
  /** Signs the current chain tip and stores/persists the anchor. */
  anchorNow(): Promise<AuditChainAnchor | undefined>;
  /** Re-verifies the latest stored anchor against the current chain. */
  verifyLatest(): Promise<AuditAnchorStatus>;
  /** Latest anchor + verification snapshot (does not re-verify). */
  status(): AuditAnchorStatus;
  /** Starts the periodic anchoring timer (idempotent). */
  start(): void;
  /** Stops the periodic timer. */
  stop(): void;
}

export interface AuditAnchorServiceOptions {
  /**
   * Signing material: the shared Ed25519 evidence key (preferred, ADR 0030) or
   * the legacy HMAC secret. Exactly one of the two must be provided.
   */
  key: Ed25519EvidenceKey | string;
  /** Interval between automatic anchors (ms). Default 6h. */
  intervalMs?: number;
  /** Optional append-only JSONL file to persist anchors OUTSIDE the DB. */
  filePath?: string;
  logger?: Logger;
}

class AuditAnchorServiceImpl implements AuditAnchorService {
  private readonly key: Ed25519EvidenceKey | string;
  private readonly intervalMs: number;
  private readonly filePath: string | undefined;
  private readonly logger: Logger | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private latest: AuditChainAnchor | undefined;
  private lastVerified: boolean | undefined;
  private lastReason: AuditAnchorStatus["reason"];

  constructor(
    private readonly auditLog: AuditLog,
    opts: AuditAnchorServiceOptions,
  ) {
    this.key = opts.key;
    this.intervalMs = opts.intervalMs ?? 6 * 60 * 60_000;
    this.filePath = opts.filePath;
    this.logger = opts.logger;
  }

  /** Reads the current chain tip (newest record's id + hash). */
  private async tip(): Promise<{ id: number; hash: string } | undefined> {
    const rows = await this.auditLog.list({ limit: 1 });
    const top = rows[0];
    if (top === undefined) return undefined;
    return { id: top.id, hash: top.hash };
  }

  async anchorNow(): Promise<AuditChainAnchor | undefined> {
    try {
      const tip = await this.tip();
      if (tip === undefined) return undefined; // empty chain — nothing to anchor
      const anchor = signAuditAnchor(tip, this.key);
      this.latest = anchor;
      this.lastVerified = true;
      this.lastReason = undefined;
      if (this.filePath !== undefined) {
        try {
          await appendFile(
            this.filePath,
            `${JSON.stringify(anchor)}\n`,
            "utf-8",
          );
        } catch (err) {
          this.logger?.warn(
            "Audit anchor file append failed (kept in memory)",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      this.logger?.info("Audit chain anchored", {
        uptoId: anchor.uptoId,
        anchoredAt: anchor.anchoredAt,
      });
      return anchor;
    } catch (err) {
      this.logger?.warn("Audit anchoring failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async verifyLatest(): Promise<AuditAnchorStatus> {
    if (this.latest === undefined) return { active: true };
    const anchor = this.latest;
    try {
      // Re-check the anchored record's hash + signature. Use a TARGETED lookup
      // by id (not a bounded newest-first page) so verification stays correct no
      // matter how many records accrued since the anchor — a windowed scan would
      // drop the anchored id after enough new events and produce a FALSE tamper
      // alarm in the dossier.
      const rec =
        this.auditLog.getById !== undefined
          ? await this.auditLog.getById(anchor.uptoId)
          : (await this.auditLog.list({ limit: 100_000 })).find(
              (r) => r.id === anchor.uptoId,
            );
      const result = verifyAuditAnchor(
        anchor,
        rec !== undefined ? { id: rec.id, hash: rec.hash } : undefined,
        this.key,
      );
      this.lastVerified = result.valid;
      this.lastReason = result.reason;
      return {
        active: true,
        latest: anchor,
        verified: result.valid,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    } catch (err) {
      this.logger?.warn("Audit anchor verification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { active: true, latest: anchor, verified: false };
    }
  }

  status(): AuditAnchorStatus {
    return {
      active: true,
      ...(this.latest !== undefined ? { latest: this.latest } : {}),
      ...(this.lastVerified !== undefined
        ? { verified: this.lastVerified }
        : {}),
      ...(this.lastReason !== undefined ? { reason: this.lastReason } : {}),
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    // Anchor once shortly after start, then on the interval.
    void this.anchorNow();
    this.timer = setInterval(() => void this.anchorNow(), this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Builds an {@link AuditAnchorService}, or undefined when neither an Ed25519
 * evidence key nor an anchor secret is configured (chain-only integrity — the
 * dossier reports this honestly). The asymmetric key wins when both are
 * present: anchors are then independently verifiable without a shared secret.
 */
export function createAuditAnchorService(
  auditLog: AuditLog,
  opts: {
    key?: Ed25519EvidenceKey;
    secret?: string;
    intervalMs?: number;
    filePath?: string;
    logger?: Logger;
  },
): AuditAnchorService | undefined {
  const key =
    opts.key ??
    (opts.secret !== undefined && opts.secret.trim().length > 0
      ? opts.secret
      : undefined);
  if (key === undefined) {
    return undefined;
  }
  return new AuditAnchorServiceImpl(auditLog, {
    key,
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    ...(opts.filePath !== undefined ? { filePath: opts.filePath } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
}
