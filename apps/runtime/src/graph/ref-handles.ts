// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Ref handles (`src/graph/ref-handles.ts`)
 *
 * A vectorsearch hit identifies its document with a long path-like reference
 * (`prod/richtlinien/logistik/wareneingang_pruefung_v3.pdf#kapitel-4.2`). The
 * model has to quote that string VERBATIM in the next tool call
 * (`get_document({reference: ...})`), and small/local models routinely fail at
 * this: they truncate the path to the bare `.pdf`, invent a plausible sibling,
 * or drop a segment (observed trace 55c5b138 — every follow-up read of the
 * turn failed because the model shortened the reference). The failure is a
 * copy-length problem, not a reasoning problem, and no prompt rule reliably
 * fixes it.
 *
 * The fix mirrors what {@link image-reference.ts} does for image bytes: park
 * the real value run-scoped and show the model a short handle instead.
 *
 *   real:  prod/richtlinien/logistik/wareneingang_pruefung_v3.pdf#kapitel-4.2
 *   model: K3NQ
 *
 * Design choices, and why:
 *   - Deterministic, NOT random: the handle is a base32 prefix of
 *     SHA-256(realRef). The same reference keeps the same handle across nodes,
 *     agent-loop steps, turns and even runtime restarts, so a handle quoted
 *     from conversation history still means the same document. A random per-run
 *     id would silently invalidate every handle the model saw last turn.
 *   - 4 characters (32-char alphabet ≈ 1.05M values): short enough to copy
 *     reliably, long enough that guessing a handle which happens to be VALID
 *     for a different document is improbable — unlike a 1-2 char label (`D2`),
 *     where a hallucinated label frequently collides with a real source and
 *     the wrong document is fetched SILENTLY. An unknown handle fails loudly
 *     with the valid list instead (see `resolveRefHandleArgs`).
 *   - Uppercase A-Z2-7 (RFC 4648 base32, no padding): visually distinct from
 *     the lowercase paths it replaces, and unambiguous when read back.
 *   - Exact-match resolution only: a handle resolves as a WHOLE argument
 *     value, never as a substring, so a real path typed by a user (or a
 *     hallucinated full path) still passes through to the tool unchanged.
 *   - The user never sees a handle: citations are registered with the REAL
 *     reference before masking (see `annotateVectorSearchCitations` in
 *     `agent-tools.ts`), and the SSE layer maps handles back to real
 *     references before the answer reaches the client. Handles are a
 *     model-facing transport encoding, nothing more.
 *
 * No `any` at module boundaries.
 */

import { createHash } from "node:crypto";

/** RFC 4648 base32 alphabet (uppercase, no I/L/O/U ambiguity). */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Handle length before collision handling. 32^4 = 1 048 576 values. */
const HANDLE_LENGTH = 4;

/**
 * A handle occurrence inside free text: the 4-char base32 body plus the
 * optional `~N` collision suffix, with word boundaries so a handle never
 * rewrites (or is rewritten by) surrounding identifier characters.
 */
const HANDLE_IN_TEXT = (handle: string): RegExp =>
  new RegExp(
    `(?<![A-Za-z0-9_~-])${escapeRegExp(handle)}(?![A-Za-z0-9_~-])`,
    "g",
  );

/** A trailing partial handle at the end of a streamed delta (hold-back). */
const TRAILING_HANDLE_PARTIAL = /(?<![A-Z2-7])[A-Z2-7]{1,4}(?:~[0-9]*)?$/;

/**
 * Tool argument keys that carry a document reference. Mirrors the keys
 * `annotateVectorSearchCitations` recognises (`reference`/`ref`/`base_ref` and
 * the plural list forms) — the same vocabulary the tools actually accept.
 */
export const REF_HANDLE_ARG_KEYS: readonly string[] = [
  "reference",
  "ref",
  "base_ref",
  "references",
  "refs",
];

/** A registered reference and the handle the model sees for it. */
export interface RefHandleInfo {
  /** Model-facing handle, e.g. `K3NQ` (or `K3NQ~2` after a collision). */
  handle: string;
  /** The real reference the handle stands for. */
  ref: string;
}

/** Outcome of {@link resolveRefHandleArgs}: rewritten args, or a model error. */
export type RefHandleArgResolution =
  | { ok: true; args: Record<string, unknown>; resolved: boolean }
  | { ok: false; unknownHandles: string[] };

export interface RefHandleRegistry {
  /**
   * Registers one real reference and returns its handle. Registering the same
   * reference twice returns the same handle. Returns the input unchanged (no
   * mapping created) when the budget is exhausted or the value is blank —
   * masking/resolution then simply never involve that reference.
   */
  register(ref: string): string;
  /**
   * Resolves a WHOLE handle value back to its real reference, or `undefined`
   * when the value is not a known handle (including real paths, which pass
   * through untouched at the call site).
   */
  resolve(value: string): string | undefined;
  /**
   * Registers every document reference found in a (parsed or JSON-string)
   * tool-result payload: any string value under `reference`/`ref`/`base_ref`,
   * including inside the MCP text-content wrapper. Called BEFORE
   * {@link maskContent} so the real values are known before the model ever
   * sees handles.
   */
  registerFromPayload(content: unknown): void;
  /**
   * Replaces known real references with their handles throughout a tool
   * result the model is about to read: exact string values anywhere in the
   * JSON structure, and substring occurrences inside longer strings (e.g. the
   * `(Ref: ...)` suffix of a citation note). Structural, never blind: values
   * that are not registered references stay byte-identical.
   */
  maskContent(content: unknown): unknown;
  /**
   * Replaces known real references with their handles inside one plain-text
   * block (substring substitution, longest reference first). Used for the
   * injected grounding context — the `(Ref: ...)` lines a tool node hands the
   * next LLM node as `get_document` arguments — which never flows through
   * {@link maskContent} because it is a prompt section, not a tool result.
   */
  maskText(text: string): string;
  /**
   * Replaces every handle occurrence in streamed text with its real
   * reference — the user-facing direction. Handles that are not (or no
   * longer) registered pass through unchanged.
   */
  unmapText(text: string): string;
  /**
   * Structural inverse of {@link maskContent}: deep-walks a tool result and
   * replaces handle occurrences inside every string (whole values and
   * substrings) with their real references. Used for everything the USER
   * consumes structurally — the client `tool_calls` details block, the live
   * graph's findings table, debug traces, and the persisted conversation
   * history — so a handle never leaks past the model boundary anywhere.
   */
  unmapContent(content: unknown): unknown;
  /**
   * Holds back the tail of a streamed delta while it could still be the start
   * of a handle split across deltas, returning only text that is safe to emit
   * (already unmapped). `final=true` flushes the held tail. Per (channel,
   * node) buffers so concurrent nodes never interleave held fragments.
   */
  unmapStreamText(
    channel: "token" | "reasoning",
    nodeId: string,
    text: string,
    final?: boolean,
  ): string;
  /** Every live mapping, in registration order (diagnostics / error hints). */
  list(): readonly RefHandleInfo[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deterministic base32(SHA-256(ref)) prefix — the collision-free-by-retry base handle. */
function baseHandle(ref: string): string {
  const digest = createHash("sha256").update(ref).digest();
  let out = "";
  // 5 bits per character, big-endian bit stream over the digest.
  for (let i = 0; i < HANDLE_LENGTH; i++) {
    const bitPos = i * 5;
    const byteIdx = Math.floor(bitPos / 8);
    const shift = 8 - (bitPos % 8) - 5;
    // shift is always >= 3 for i < 6, so a single byte always covers the 5 bits.
    const value = (digest[byteIdx] as number >>> shift) & 0x1f;
    out += BASE32.charAt(value);
  }
  return out;
}

/** Default cap on live mappings — past it, refs pass through unmasked. */
const DEFAULT_MAX_REFS = 2048;

/** Keys whose string values identify a document inside a tool payload. */
const REFERENCE_VALUE_KEYS = new Set(["reference", "ref", "base_ref"]);

/**
 * Run-scoped reference-handle registry.
 *
 * Created once per flow execution (like {@link CitationRegistry}) when a node
 * opts in via `config.refHandles: true`, so every node and agent-loop step of
 * the run shares one handle space. The mapping is deterministic, which makes
 * it robust to the registry being empty at the start of a follow-up turn: a
 * handle the model quotes from history still decodes to the same reference
 * once that reference is (re-)registered, and until then resolution fails
 * LOUDLY rather than fetching a wrong document.
 */
export class HashRefHandleRegistry implements RefHandleRegistry {
  private readonly maxRefs: number;
  /** realRef → handle (first registration wins). */
  private readonly byRef = new Map<string, string>();
  /** handle → realRef. */
  private readonly byHandle = new Map<string, string>();
  /** Insertion order for diagnostics and the longest-first replacement lists. */
  private readonly infos: RefHandleInfo[] = [];
  /** baseHandle → number of refs that collided onto it (drives `~N` suffixes). */
  private readonly collisions = new Map<string, number>();
  /** (channel, node) → held-back tail of a streamed delta. */
  private readonly streamBufs = new Map<string, string>();

  constructor(options?: { maxRefs?: number }) {
    this.maxRefs = Math.max(1, options?.maxRefs ?? DEFAULT_MAX_REFS);
  }

  register(ref: string): string {
    const value = ref.trim();
    if (value === "") return ref;
    const existing = this.byRef.get(value);
    if (existing !== undefined) return existing;
    if (this.byRef.size >= this.maxRefs) {
      // Budget exhausted: the reference keeps flowing as itself. Masking is an
      // optimisation, never a correctness requirement — dropping the mapping
      // must not break the tool call.
      return ref;
    }
    const base = baseHandle(value);
    const seen = this.collisions.get(base) ?? 0;
    this.collisions.set(base, seen + 1);
    let handle = base;
    if (seen > 0) {
      // Two different references hashed to the same 4-char base. Suffixing an
      // ordinal keeps handles short while making each unique; the FIRST
      // registrant keeps the bare handle.
      for (let n = 2; this.byHandle.has(handle); n++) {
        handle = `${base}~${n}`;
      }
    }
    this.byRef.set(value, handle);
    this.byHandle.set(handle, value);
    this.infos.push({ handle, ref: value });
    return handle;
  }

  resolve(value: string): string | undefined {
    return this.byHandle.get(value);
  }

  registerFromPayload(content: unknown): void {
    for (const value of collectReferenceValues(parseMaybeJson(content))) {
      this.register(value);
    }
  }

  maskContent(content: unknown): unknown {
    if (this.infos.length === 0) return content;
    // Longest reference first, so a reference that contains another one is
    // masked as a whole rather than partially.
    const sortedByRefLength = [...this.infos].sort(
      (a, b) => b.ref.length - a.ref.length,
    );
    const substring = (s: string): string => {
      let out = s;
      for (const info of sortedByRefLength) {
        if (!out.includes(info.ref)) continue;
        out = out.split(info.ref).join(info.handle);
      }
      return out;
    };
    // Walk the ORIGINAL structure without re-parsing envelopes: every string
    // (including JSON inside MCP text parts) gets substring substitution, so
    // the payload keeps its exact shape — a whole-value reference becomes the
    // bare handle, and a reference inside longer text (e.g. the `(Ref: ...)`
    // suffix of a citation note) is replaced in place.
    const mask = (value: unknown): unknown => {
      if (typeof value === "string") return substring(value);
      if (Array.isArray(value)) return value.map(mask);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            mask(v),
          ]),
        );
      }
      return value;
    };
    return mask(content);
  }

  maskText(text: string): string {
    if (this.infos.length === 0 || text.length === 0) return text;
    // Longest reference first, mirroring maskContent: a reference that contains
    // another one must be masked as a whole.
    let out = text;
    for (const info of [...this.infos].sort((a, b) => b.ref.length - a.ref.length)) {
      if (!out.includes(info.ref)) continue;
      out = out.split(info.ref).join(info.handle);
    }
    return out;
  }

  unmapText(text: string): string {
    if (this.infos.length === 0 || text.length === 0) return text;
    return replaceHandlesIn(text, this.sortedByHandleLength());
  }

  unmapContent(content: unknown): unknown {
    if (this.infos.length === 0) return content;
    const infos = this.sortedByHandleLength();
    const unmap = (value: unknown): unknown => {
      if (typeof value === "string") return replaceHandlesIn(value, infos);
      if (Array.isArray(value)) return value.map(unmap);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            unmap(v),
          ]),
        );
      }
      return value;
    };
    return unmap(content);
  }

  unmapStreamText(
    channel: "token" | "reasoning",
    nodeId: string,
    text: string,
    final = false,
  ): string {
    if (this.infos.length === 0) return text;
    const key = `${channel}:${nodeId}`;
    const buf = (this.streamBufs.get(key) ?? "") + text;
    if (final) {
      this.streamBufs.delete(key);
      return this.unmapText(buf);
    }
    // Hold back a trailing run that could still complete into a handle
    // (`K3` + next delta `NQ`); a run longer than the handle body, or one not
    // starting at a word boundary, can never become a handle and is released.
    const partial = buf.match(TRAILING_HANDLE_PARTIAL);
    const hold = partial?.[0].length ?? 0;
    const safeLen = buf.length - hold;
    // Persist the buffer BEFORE the early return: when the whole buffer is a
    // partial (`safeLen <= 0`), the held-back text must survive for the next
    // delta. Skipping the set here silently deleted every delta that happened
    // to consist only of handle-shaped characters (`17`, `A`, `KO`), which
    // corrupted streamed answers token by token.
    this.streamBufs.set(key, buf.slice(safeLen));
    if (safeLen <= 0) return "";
    return this.unmapText(buf.slice(0, safeLen));
  }

  list(): readonly RefHandleInfo[] {
    return this.infos;
  }

  /** Longest handle first, so `K3NQ~2` wins over its `K3NQ` prefix. */
  private sortedByHandleLength(): readonly RefHandleInfo[] {
    return [...this.infos].sort((a, b) => b.handle.length - a.handle.length);
  }
}

function replaceHandlesIn(text: string, infos: readonly RefHandleInfo[]): string {
  let out = text;
  for (const info of infos) {
    if (!out.includes(info.handle)) continue;
    out = out.replace(HANDLE_IN_TEXT(info.handle), info.ref);
  }
  return out;
}

/**
 * Collects document-reference string values from a parsed payload: any string
 * under `reference`/`ref`/`base_ref`, at any depth, including inside JSON
 * strings of MCP text parts (handled by {@link parseMaybeJson} upstream).
 */
function collectReferenceValues(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceValues(item, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (REFERENCE_VALUE_KEYS.has(key)) {
        if (typeof nested === "string" && nested.trim() !== "") found.push(nested);
        else if (Array.isArray(nested)) {
          for (const item of nested) {
            if (typeof item === "string" && item.trim() !== "") found.push(item);
          }
        }
      }
      collectReferenceValues(nested, found);
    }
    return found;
  }
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (parsed !== value) collectReferenceValues(parsed, found);
  }
  return found;
}

/** Parses JSON strings / MCP text-part arrays; returns the input when not JSON. */
function parseMaybeJson(content: unknown): unknown {
  if (typeof content === "string") {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  }
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        typeof (p as { text?: unknown }).text === "string",
    )
  ) {
    const first = content[0] as { text: string };
    try {
      return JSON.parse(first.text) as unknown;
    } catch {
      return content;
    }
  }
  return content;
}

/**
 * Resolves handle-valued tool arguments back to their real references.
 *
 * For every {@link REF_HANDLE_ARG_KEYS} key holding a string (or an array of
 * strings), a known handle is replaced by its real reference; anything else is
 * forwarded UNCHANGED so real paths — typed by a user or produced by a tool
 * the registry never saw — keep working. When a value is SHAPE-identical to a
 * handle (4 base32 chars, optional `~N`) but NOT registered, the call is
 * rejected with the list of valid handles: that is precisely the
 * hallucination class this indirection exists to catch, and forwarding the
 * bogus value would let the tool silently search for nothing (or the wrong
 * thing).
 *
 * Exported for unit testing.
 */
export function resolveRefHandleArgs(
  registry: RefHandleRegistry,
  args: Record<string, unknown>,
): RefHandleArgResolution {
  const unknownHandles: string[] = [];
  let resolved = false;
  const out: Record<string, unknown> = { ...args };
  for (const key of REF_HANDLE_ARG_KEYS) {
    const value = out[key];
    if (typeof value === "string") {
      const real = registry.resolve(value);
      if (real !== undefined) {
        out[key] = real;
        resolved = true;
      } else if (looksLikeHandle(value)) {
        unknownHandles.push(value);
      }
    } else if (Array.isArray(value)) {
      const mapped = value.map((item) => {
        if (typeof item !== "string") return item;
        const real = registry.resolve(item);
        if (real !== undefined) {
          resolved = true;
          return real;
        }
        if (looksLikeHandle(item)) unknownHandles.push(item);
        return item;
      });
      if (mapped.some((item, i) => item !== value[i])) out[key] = mapped;
    }
  }
  if (unknownHandles.length > 0) return { ok: false, unknownHandles };
  return { ok: true, args: out, resolved };
}

/** Shape test for an UNREGISTERED value that was clearly meant as a handle. */
function looksLikeHandle(value: string): boolean {
  return /^[A-Z2-7]{4}(~[0-9]{1,3})?$/.test(value);
}
