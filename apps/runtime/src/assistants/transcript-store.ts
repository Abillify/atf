// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Durable assistant conversation transcripts.
 *
 * The assistant workspace is its private persistent state.  Unlike execution
 * checkpoints (which are an engine concern and may be disabled), this store
 * always writes a compact, append-only JSONL transcript below
 * `<workspace>/data/conversations`.  It therefore survives restarts even when
 * Postgres is not configured.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssistantScope } from "./types.js";
import type { AssistantWorkspaceResolver } from "./workspace.js";

export type TranscriptRole = "user" | "assistant" | "tool" | "event";

export interface TranscriptEntry {
  version: 1;
  id: string;
  executionId: string;
  conversationId: string;
  role: TranscriptRole;
  content: string;
  createdAt: string;
  /** Authoritative per-conversation sequence when assigned by the durable store. */
  sequence?: number;
  /** Tool name or event type, when the entry is not ordinary chat prose. */
  name?: string;
}

export type TranscriptAppendInput = Omit<TranscriptEntry, "version" | "id" | "createdAt" | "sequence">;

export interface TranscriptStore {
  /** Returns the exact persisted record so projections reuse its identity. */
  append(scope: AssistantScope, entry: TranscriptAppendInput): Promise<TranscriptEntry>;
  read(scope: AssistantScope, conversationId: string, limit?: number): Promise<TranscriptEntry[]>;
  search(scope: AssistantScope, query: string, limit?: number): Promise<TranscriptEntry[]>;
}

const MAX_ENTRY_CHARS = 64_000;
const DEFAULT_READ_LIMIT = 80;

function stableConversationFile(conversationId: string): string {
  return `${crypto.createHash("sha256").update(conversationId).digest("hex")}.jsonl`;
}

function clippedContent(content: string): string {
  return content.length <= MAX_ENTRY_CHARS
    ? content
    : `${content.slice(0, MAX_ENTRY_CHARS)}\n[truncated while persisting transcript]`;
}

/**
 * File-backed transcript store. Writes are serialised per transcript inside this
 * process, and each entry is one append operation so a crash can lose at most an
 * unfinished line; readers ignore such a trailing partial line.
 */
export class WorkspaceTranscriptStore implements TranscriptStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly workspaces: AssistantWorkspaceResolver) {}

  async append(
    scope: AssistantScope,
    entry: TranscriptAppendInput,
  ): Promise<TranscriptEntry> {
    const file = await this.fileFor(scope, entry.conversationId);
    let persisted: TranscriptEntry | undefined;
    const operation = async (): Promise<void> => {
      const record: TranscriptEntry = {
        version: 1,
        id: crypto.randomUUID(),
        executionId: entry.executionId,
        conversationId: entry.conversationId,
        role: entry.role,
        content: clippedContent(entry.content),
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        createdAt: new Date().toISOString(),
      };
      persisted = record;
      await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    };
    const previous = this.tails.get(file) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(file, current);
    try {
      await current;
      if (persisted === undefined) throw new Error("Transcript append produced no record.");
      return persisted;
    } finally {
      if (this.tails.get(file) === current) this.tails.delete(file);
    }
  }

  /** Idempotent projection entrypoint used by the Postgres mirror outbox. */
  async appendProjected(scope: AssistantScope, entry: TranscriptEntry): Promise<void> {
    const file = await this.fileFor(scope, entry.conversationId);
    const operation = async (): Promise<void> => {
      const existing = await this.readFile(file, Number.MAX_SAFE_INTEGER);
      if (existing.some((candidate) => candidate.id === entry.id)) return;
      await fs.promises.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    };
    const previous = this.tails.get(file) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tails.set(file, current);
    try { await current; } finally { if (this.tails.get(file) === current) this.tails.delete(file); }
  }

  async read(scope: AssistantScope, conversationId: string, limit = DEFAULT_READ_LIMIT): Promise<TranscriptEntry[]> {
    const file = await this.fileFor(scope, conversationId);
    return this.readFile(file, limit);
  }

  async search(scope: AssistantScope, query: string, limit = 20): Promise<TranscriptEntry[]> {
    const needle = query.trim().toLocaleLowerCase("de-DE");
    if (needle === "") return [];
    const directory = await this.directoryFor(scope);
    const files = await fs.promises.readdir(directory, { withFileTypes: true });
    const matches: TranscriptEntry[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const entries = await this.readFile(path.join(directory, file.name), Number.MAX_SAFE_INTEGER);
      for (const entry of entries) {
        if (entry.content.toLocaleLowerCase("de-DE").includes(needle)) matches.push(entry);
      }
    }
    return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  private async directoryFor(scope: AssistantScope): Promise<string> {
    const workspace = await this.workspaces.ensureWorkspace(scope);
    const directory = path.join(workspace, "data", "conversations");
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async fileFor(scope: AssistantScope, conversationId: string): Promise<string> {
    return path.join(await this.directoryFor(scope), stableConversationFile(conversationId));
  }

  private async readFile(file: string, limit: number): Promise<TranscriptEntry[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isTranscriptEntry(parsed)) entries.push(parsed);
      } catch {
        // A process may have crashed mid-append. Earlier JSONL records remain
        // valid and are still useful for resume, so one bad trailing line never
        // makes a conversation unreadable.
      }
    }
    return entries.slice(-Math.max(0, limit));
  }
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<TranscriptEntry>;
  return entry.version === 1 &&
    typeof entry.id === "string" &&
    typeof entry.executionId === "string" &&
    typeof entry.conversationId === "string" &&
    (entry.role === "user" || entry.role === "assistant" || entry.role === "tool" || entry.role === "event") &&
    typeof entry.content === "string" &&
    typeof entry.createdAt === "string";
}
