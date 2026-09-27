// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/identity.ts
 *
 * What a job knows about the document it ingests, beyond the file: which
 * document it is (the canonical reference Search resolved), whether Search
 * already holds it (duplicate → skipped), and its version. The job runner
 * drives the steps; this module holds the job-config shape and the pure parts.
 *
 * Kept on the job's config (JSONB) so a resume never asks twice:
 *
 *   config.version            caller's explicit version       (input)
 *   config.sourceModifiedAt   caller's file time               (input)
 *   config.dedup              auto | exact | off               (input)
 *   config.parent             { reference, jobId } of the e-mail an attachment
 *                             came with                        (input)
 *   config.identity           {@link JobIdentity}              (result)
 *   config.email / title      the e-mail's headers and subject (result)
 *   config.title / tags / metadata / link / sourceLabel
 *                             the caller's document attributes, carried onto
 *                             `document.begin` (input, contract 2.2)
 */

import { createHash } from "node:crypto";
import {
  documentKeyOf,
  type DedupMode,
  type DocumentVersion,
  type DuplicateOf,
  type EmailHeaders,
  type IdentifyRequest,
} from "@atf/extract-contract";
import type { JobRow } from "../persistence/types.js";
import type { SummaryClient } from "../summary/client.js";
import {
  VERSION_LLM_SYSTEM_PROMPT,
  detectVersionInText,
  explicitVersion,
  parseLlmVersion,
  sourceModifiedVersion,
  versionLlmUserPrompt,
} from "./version-detect.js";

/** Config key of the identity result. */
export const IDENTITY_KEY = "identity";
/** Config key of an e-mail's threading headers. */
export const EMAIL_KEY = "email";

/** At most this many pages are read for the text fingerprint. */
export const FINGERPRINT_MAX_PAGES = 2000;

export interface JobIdentity {
  requestedReference: string;
  canonicalReference: string;
  /** `unidentified`: Search offers no identification; the job ingests as before. */
  decision: "new" | "new_version" | "duplicate" | "unidentified";
  duplicateOf?: DuplicateOf;
  version?: DocumentVersion;
  /** Search holds a claim for this job: its revision carries `X-Source-Id`. */
  registered: boolean;
  /** Both identification phases are done; a resume skips them. */
  complete: boolean;
}

/** The caller's ingest options, read from the job config. */
export interface JobIngestOptions {
  version?: string;
  sourceModifiedAt?: string;
  dedup: DedupMode;
  parentReference?: string;
  parentJobId?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function ingestOptionsOf(config: Record<string, unknown>): JobIngestOptions {
  const dedup = config.dedup === "exact" || config.dedup === "off" ? config.dedup : "auto";
  const parent = config.parent as { reference?: unknown; jobId?: unknown } | undefined;
  const version = str(config.version);
  const sourceModifiedAt = str(config.sourceModifiedAt);
  const parentReference = str(parent?.reference);
  const parentJobId = str(parent?.jobId);
  return {
    dedup,
    ...(version !== undefined ? { version } : {}),
    ...(sourceModifiedAt !== undefined ? { sourceModifiedAt } : {}),
    ...(parentReference !== undefined ? { parentReference } : {}),
    ...(parentJobId !== undefined ? { parentJobId } : {}),
  };
}

/** The caller's document attributes (contract 2.2), read from the job config. */
export interface DocumentAttributes {
  tags?: string[];
  metadata?: Record<string, unknown>;
  link?: string;
  sourceLabel?: string;
}

/** Config keys an e-mail attachment inherits from its e-mail's job. */
export const INHERITED_ATTRIBUTE_KEYS = ["tags", "metadata", "sourceLabel"] as const;

export function documentAttributesOf(config: Record<string, unknown>): DocumentAttributes {
  const tags = Array.isArray(config.tags)
    ? config.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
    : [];
  const metadata =
    config.metadata !== null && typeof config.metadata === "object" && !Array.isArray(config.metadata)
      ? (config.metadata as Record<string, unknown>)
      : undefined;
  const link = str(config.link);
  const sourceLabel = str(config.sourceLabel);
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(metadata !== undefined && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(sourceLabel !== undefined ? { sourceLabel } : {}),
  };
}

export function identityOf(config: Record<string, unknown>): JobIdentity | undefined {
  const raw = config[IDENTITY_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Partial<JobIdentity>;
  if (typeof r.canonicalReference !== "string" || typeof r.requestedReference !== "string") return undefined;
  return {
    requestedReference: r.requestedReference,
    canonicalReference: r.canonicalReference,
    decision: r.decision ?? "unidentified",
    ...(r.duplicateOf !== undefined ? { duplicateOf: r.duplicateOf } : {}),
    ...(r.version !== undefined ? { version: r.version } : {}),
    registered: r.registered === true,
    complete: r.complete === true,
  };
}

export function emailOf(config: Record<string, unknown>): EmailHeaders | undefined {
  const raw = config[EMAIL_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return typeof (raw as { messageId?: unknown }).messageId === "string" ? (raw as EmailHeaders) : undefined;
}

/** The identify request for one phase. */
export function identifyRequestFor(
  job: JobRow,
  args: {
    phase: "source" | "content";
    requestedReference: string;
    dedup: DedupMode;
    textHash?: string | undefined;
    minhash?: number[] | undefined;
    messageId?: string | undefined;
    version?: DocumentVersion | undefined;
  },
): IdentifyRequest {
  const source = (job.config as { source?: { filename?: unknown; mimeType?: unknown } }).source;
  const acl = jobAcl(job);
  return {
    sourceId: job.id,
    phase: args.phase,
    reference: args.requestedReference,
    documentKey: documentKeyOf(args.requestedReference),
    ...(typeof source?.filename === "string" ? { filename: source.filename } : {}),
    ...(typeof source?.mimeType === "string" ? { mimeType: source.mimeType } : {}),
    sourceSha256: job.source_sha256,
    ...(args.textHash !== undefined ? { textHash: args.textHash } : {}),
    ...(args.minhash !== undefined ? { minhash: args.minhash } : {}),
    ...(args.messageId !== undefined ? { messageId: args.messageId } : {}),
    ...(args.version !== undefined ? { version: args.version } : {}),
    ...(acl !== undefined ? { allowedUsers: acl.allowedUsers, allowedGroups: acl.allowedGroups } : {}),
    dedup: args.dedup,
  };
}

/**
 * The job's ACL (`config.acl`, resolved for the uploading caller by the ingest
 * handlers), or undefined for a job created without one.
 */
export function jobAcl(job: JobRow): { allowedUsers: string[]; allowedGroups: string[] } | undefined {
  const raw = (job.config as { acl?: { allowedUsers?: unknown; allowedGroups?: unknown } }).acl;
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  return { allowedUsers: list(raw.allowedUsers), allowedGroups: list(raw.allowedGroups) };
}

/**
 * Resolve a document's version from the strongest available source: the
 * caller's explicit value, the first page's text (label, then date), the text
 * model reading the first page, then the file time. `llm` is only asked when
 * the patterns found nothing and there is text to read; its failures are
 * swallowed (the version is a nice-to-have, never a reason to fail a job).
 */
export async function resolveVersion(args: {
  options: JobIngestOptions;
  firstPageText: string | undefined;
  llm?: SummaryClient | null;
  signal?: AbortSignal;
  now?: Date;
  onTokens?: (tokens: number) => Promise<void>;
  onLlmError?: (err: unknown) => void;
}): Promise<DocumentVersion | undefined> {
  const now = args.now ?? new Date();
  if (args.options.version !== undefined) {
    const explicit = explicitVersion(args.options.version);
    if (explicit) return explicit;
  }
  const text = args.firstPageText?.trim() ?? "";
  if (text !== "") {
    const fromText = detectVersionInText(text, now);
    if (fromText) return fromText;
    const complete = args.llm?.complete;
    if (complete !== undefined && args.llm) {
      try {
        const answer = await complete.call(args.llm, {
          system: VERSION_LLM_SYSTEM_PROMPT,
          user: versionLlmUserPrompt(text),
          maxTokens: 120,
          ...(args.signal !== undefined ? { signal: args.signal } : {}),
        });
        await args.onTokens?.(answer.usage.totalTokens);
        const fromLlm = parseLlmVersion(answer.text, now);
        if (fromLlm) return fromLlm;
      } catch (err) {
        args.onLlmError?.(err);
      }
    }
  }
  return sourceModifiedVersion(args.options.sourceModifiedAt);
}

/**
 * A deterministic UUID for the `index`-th attachment job of a parent job, so a
 * resumed parent finds the child it already created instead of creating a
 * second one.
 */
export function childJobId(parentJobId: string, index: number): string {
  const hex = createHash("sha256").update(`${parentJobId}:attachment:${index}`).digest("hex");
  // RFC 4122 layout with version 5-style and variant bits set.
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The reference of an attachment: `<e-mail reference>/<file name>`, made unique
 * among the message's attachments with a ` (2)`-style suffix.
 */
export function attachmentReference(parentReference: string, filename: string, taken: Set<string>): string {
  const clean = filename.replace(/[\\/]/g, "_").trim() || "attachment";
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let candidate = `${parentReference}/${clean}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${parentReference}/${stem} (${n})${ext}`;
  taken.add(candidate);
  return candidate;
}
