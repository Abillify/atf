// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";
import type { MonitoringConfig } from "../config/schema.ts";
import type { MonitorBus, MonitorEvent } from "./events.ts";
import { logger } from "../logger.ts";
import { isSensitiveKey, REDACTED } from "../observability/redact.ts";
import type { ErasureRequest, ErasureStoreResult } from "@atf/erasure-contract";

/** The `monitoring.audit` block after schema defaults. */
export type AuditConfig = NonNullable<MonitoringConfig["audit"]>;

/** Logical store name reported in erasure results. */
export const GATE_AUDIT_STORE = "gate.audit";

/**
 * Replace the value at a dotted path (relative to an event's `meta`) with the
 * redaction marker. Missing intermediate segments are a no-op — a path that
 * does not exist cannot leak. Returns a shallow-copied meta only when
 * something was replaced, so the hot path stays allocation-free.
 */
function redactPath(
  meta: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return meta;
  // Verify the path exists before copying anything.
  let cursor: unknown = meta;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return meta;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  // Rebuild along the path with the leaf replaced.
  const [head, ...rest] = parts;
  if (head === undefined) return meta;
  if (rest.length === 0) return { ...meta, [head]: REDACTED };
  const child = meta[head];
  if (child === null || typeof child !== "object") return meta;
  return {
    ...meta,
    [head]: redactPath(child as Record<string, unknown>, rest.join(".")),
  };
}

/**
 * Sink-level redaction of one event, applied right before it is persisted.
 *
 * The MonitorBus already redacts by key name at its single choke point; this
 * second layer exists because key-based redaction never touches positional
 * array VALUES — the values of `meta.query.bindings` (SQL parameters) survive
 * the bus under the non-sensitive key `bindings` and are exactly the kind of
 * data a subject can ask to be forgotten. `paths` therefore replaces whole
 * configured subtrees, and `extraKeys` extends the denylist for this sink.
 */
function applyAuditRedaction(
  event: MonitorEvent,
  paths: string[],
  extraKeys: string[],
): MonitorEvent {
  if (event.meta === undefined) return event;
  let meta = event.meta;
  for (const path of paths) meta = redactPath(meta, path);
  if (extraKeys.length > 0) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      out[k] = isSensitiveKey(k, extraKeys) ? REDACTED : v;
    }
    meta = out;
  }
  return meta === event.meta ? event : { ...event, meta };
}

/** Identifiers a subject erasure request matches audit events on. */
interface SubjectMatch {
  subjects: Set<string>;
  usernames: Set<string>;
  emails: Set<string>;
}

function buildSubjectMatch(request: ErasureRequest): SubjectMatch {
  const subjects = new Set<string>();
  const usernames = new Set<string>();
  const emails = new Set<string>();
  const subject = request.subject;
  if (subject?.userId !== undefined) {
    subjects.add(subject.userId);
    usernames.add(subject.userId);
  }
  if (subject?.email !== undefined) {
    emails.add(subject.email.toLowerCase());
    // An email is commonly used as the display username in static configs.
    usernames.add(subject.email);
  }
  for (const externalId of subject?.externalIds ?? []) {
    subjects.add(externalId);
    usernames.add(externalId);
  }
  return { subjects, usernames, emails };
}

/**
 * Does one persisted audit event belong to the erasure subject?
 *
 * Matching is deliberately structural (event.subject / event.username /
 * meta.claims) rather than a substring search over the serialized line: a
 * DSAR deletion must not sweep up unrelated events that merely mention an
 * identifier in a payload.
 */
function eventMatchesSubject(
  line: Record<string, unknown>,
  match: SubjectMatch,
): boolean {
  const subject = line.subject;
  if (typeof subject === "string" && match.subjects.has(subject)) return true;
  const username = line.username;
  if (typeof username === "string" && match.usernames.has(username))
    return true;
  const meta = line.meta;
  if (meta !== null && typeof meta === "object") {
    const claims = (meta as Record<string, unknown>).claims;
    if (claims !== null && typeof claims === "object") {
      const c = claims as Record<string, unknown>;
      if (typeof c.sub === "string" && match.subjects.has(c.sub)) return true;
      if (
        typeof c.email === "string" &&
        match.emails.has(c.email.toLowerCase())
      )
        return true;
      if (
        typeof c.preferred_username === "string" &&
        match.usernames.has(c.preferred_username)
      )
        return true;
    }
  }
  return false;
}

function eventTenant(line: Record<string, unknown>): string | undefined {
  const meta = line.meta;
  if (meta === null || typeof meta !== "object") return undefined;
  const claims = (meta as Record<string, unknown>).claims;
  if (claims === null || typeof claims !== "object") return undefined;
  const c = claims as Record<string, unknown>;
  for (const key of ["tenant_id", "tenant", "tid"]) {
    const value = c[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Tombstone replacing a matched event. The line count and the event's basic
 * shape stay intact (so log shippers and replay tools keep working) while
 * every subject-attributable field is dropped.
 */
function tombstone(line: Record<string, unknown>): Record<string, unknown> {
  return {
    id: line.id,
    ts: line.ts,
    type: line.type,
    message: "[erased]",
    erased: true,
  };
}

/**
 * Persistent audit sink with a subject-erasure capability.
 *
 * Subscribes to the MonitorBus and writes each (optionally filtered) event as
 * a single JSON line to a file, giving a durable record that survives process
 * restarts — unlike the in-memory ring buffer. One object per line (JSONL) so
 * it streams cleanly into log shippers and is trivial to grep or replay.
 *
 * Req 2.8: events pass a sink-level redaction policy before persisting, and
 * `erase()` redacts/deletes subject events where the sink is not committed to
 * append-only retention. When `appendOnly` is set, `erase()` reports
 * `not_configured` honestly instead of pretending.
 */
export class AuditSink {
  private stream?: WriteStream;
  private unsubscribe?: () => void;
  private readonly allowed?: Set<string>;
  private readonly redactPaths: string[];
  private readonly redactExtraKeys: string[];

  constructor(private readonly config: AuditConfig) {
    if (config.events && config.events.length > 0) {
      this.allowed = new Set(config.events);
    }
    const redact = config.redact;
    this.redactPaths = redact?.enabled === false ? [] : (redact?.paths ?? []);
    this.redactExtraKeys =
      redact?.enabled === false ? [] : (redact?.extraKeys ?? []);
  }

  /** Open the audit file and start recording. No-op when disabled/misconfigured. */
  attach(bus: MonitorBus): void {
    if (!this.config.enabled) return;
    if (!this.config.file) {
      logger.warn(
        "audit logging enabled but monitoring.audit.file is not set — audit disabled",
      );
      return;
    }
    try {
      mkdirSync(dirname(this.config.file), { recursive: true });
      this.stream = createWriteStream(this.config.file, { flags: "a" });
      this.stream.on("error", (err) =>
        logger.error(`audit log write error: ${err.message}`),
      );
    } catch (err) {
      logger.error(
        `failed to open audit log '${this.config.file}': ${(err as Error).message}`,
      );
      return;
    }

    this.unsubscribe = bus.subscribe((event) => this.write(event));
    logger.info(`audit log enabled → ${this.config.file}`);
  }

  private write(event: MonitorEvent): void {
    if (!this.stream) return;
    if (this.allowed && !this.allowed.has(event.type)) return;
    try {
      const redacted = applyAuditRedaction(
        event,
        this.redactPaths,
        this.redactExtraKeys,
      );
      this.stream.write(JSON.stringify(redacted) + "\n");
    } catch (err) {
      logger.error(`audit log write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Forget one subject in the persistent file (Req 2.8).
   *
   * Honest states:
   * - `not_configured` — sink disabled or append-only retention committed.
   * - `failed` — the file could not be read or rewritten.
   * - `ok` — matched events were tombstoned (or a dry run counted them).
   *
   * The rewrite is atomic (tmp file + rename). The live append stream is
   * closed for the duration and reopened afterwards so buffered writes
   * cannot resurrect erased lines after the rename.
   */
  async erase(
    request: ErasureRequest,
    dryRun: boolean,
  ): Promise<ErasureStoreResult> {
    if (!this.config.enabled || !this.config.file) {
      return {
        store: GATE_AUDIT_STORE,
        status: "not_configured",
        erased: 0,
        error: "the persistent audit sink is not configured",
      };
    }
    if (this.config.appendOnly) {
      return {
        store: GATE_AUDIT_STORE,
        status: "not_configured",
        erased: 0,
        error:
          "monitoring.audit.appendOnly is enabled — the sink is committed to append-only retention and cannot forget subject events",
      };
    }
    // Flush and detach the append stream before rewriting the file.
    const stream = this.stream;
    if (stream) {
      this.stream = undefined;
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    }
    try {
      let raw: string;
      try {
        raw = readFileSync(this.config.file, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { store: GATE_AUDIT_STORE, status: "ok", erased: 0 };
        }
        throw err;
      }
      const match = buildSubjectMatch(request);
      let erased = 0;
      const out: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed === null || typeof parsed !== "object")
            throw new Error("not an object");
        } catch {
          // A corrupt line cannot be attributed to a subject; keep it verbatim
          // rather than silently dropping audit data.
          out.push(line);
          continue;
        }
        const tenant = eventTenant(parsed);
        if (request.scope === "tenant") {
          // Tenant-scope: erase every event verifiably belonging to the
          // requesting tenant. Events without a tenant claim cannot be
          // attributed and are kept rather than guessed at.
          if (tenant === request.tenantId) {
            erased++;
            if (!dryRun) out.push(JSON.stringify(tombstone(parsed)));
          } else {
            out.push(line);
          }
          continue;
        }
        if (tenant !== undefined && tenant !== request.tenantId) {
          out.push(line);
          continue;
        }
        if (eventMatchesSubject(parsed, match)) {
          erased++;
          if (!dryRun) out.push(JSON.stringify(tombstone(parsed)));
        } else {
          out.push(JSON.stringify(parsed));
        }
      }
      if (!dryRun) {
        const tmp = `${this.config.file}.erasing-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, out.length > 0 ? `${out.join("\n")}\n` : "", "utf8");
        renameSync(tmp, this.config.file);
      }
      return { store: GATE_AUDIT_STORE, status: "ok", erased };
    } catch (err) {
      return {
        store: GATE_AUDIT_STORE,
        status: "failed",
        erased: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Reopen the append stream regardless of the rewrite outcome.
      if (stream && this.config.enabled && this.config.file) {
        try {
          const reopened = createWriteStream(this.config.file, { flags: "a" });
          reopened.on("error", (e) =>
            logger.error(`audit log write error: ${e.message}`),
          );
          this.stream = reopened;
        } catch (err) {
          logger.error(
            `failed to reopen audit log after erasure: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /** Stop recording and flush the file. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}
