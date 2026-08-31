// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Soul document logic (`src/assistants/soul-document.ts`)
 *
 * The pure half of the soul: normalisation, write-class enforcement, merging,
 * and content hashing. Kept separate from persistence so the rules that decide
 * *what a mutation is allowed to change* are unit-testable without a database
 * and cannot be bypassed by a second SQL statement written elsewhere.
 *
 * Three properties this module guarantees:
 *
 * 1. **Write-class containment.** An `agent` actor's mutation can only ever
 *    produce a document whose `directives` and `constraints` are byte-identical
 *    to the ones it read. This is enforced structurally in {@link applySoulPatch}
 *    (the other classes are copied from the base, never from the patch), not by
 *    checking and rejecting — so a caller that forgets to validate still cannot
 *    cause a cross-class write.
 *
 * 2. **Non-destructive merge.** A patch updates the fields it names and leaves
 *    every other field untouched. An agent rewriting its `vibe` cannot drop the
 *    `notes` it wrote last week by omitting them, which is the failure mode of
 *    replace-the-whole-document APIs.
 *
 * 3. **Placeholder rejection.** Template scaffolding ("not set yet", "pick
 *    something you like") is recognised and dropped rather than stored as a real
 *    value. Without this, a freshly provisioned assistant renders its own setup
 *    instructions into every prompt and then answers as if they were its
 *    identity.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import {
  SOUL_FIELD_MAX_CHARS,
  type SoulConstraints,
  type SoulDirectives,
  type SoulIdentity,
  type SoulWriteClass,
} from "./types.js";

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/** The three write classes as one value. */
export interface SoulDocument {
  identity: SoulIdentity;
  directives: SoulDirectives;
  constraints: SoulConstraints;
}

/** An empty soul — the state a freshly provisioned assistant starts in. */
export function emptySoulDocument(): SoulDocument {
  return { identity: {}, directives: {}, constraints: {} };
}

/** A patch names only the fields it intends to change. */
export interface SoulPatch {
  identity?: Partial<SoulIdentity>;
  directives?: Partial<SoulDirectives>;
  constraints?: Partial<SoulConstraints>;
}

// ---------------------------------------------------------------------------
// Field registries
// ---------------------------------------------------------------------------

/**
 * Known fields per write class, in RENDER ORDER.
 *
 * The order is part of the prompt contract: the rendered soul must be
 * byte-identical between turns when nothing changed, and iterating
 * `Object.keys()` of a JSONB round trip does not guarantee that. Declaring the
 * order here makes it a property of the code rather than of the storage engine.
 */
export const SOUL_IDENTITY_FIELDS = [
  "name",
  "emoji",
  "role",
  "vibe",
  "notes",
] as const satisfies readonly (keyof SoulIdentity)[];

export const SOUL_DIRECTIVE_FIELDS = [
  "instructions",
  "style",
  "about",
  "avoid",
] as const satisfies readonly (keyof SoulDirectives)[];

/** `deniedTools` is handled separately — it is a list, not prose. */
export const SOUL_CONSTRAINT_TEXT_FIELDS = [
  "rules",
  "compliance",
] as const satisfies readonly (keyof SoulConstraints)[];

/**
 * Which actor type owns which write class.
 *
 * `system` is intentionally absent: system writes go through the provisioning
 * path (which sets the whole document once) and must not be able to patch an
 * arbitrary class afterwards, or "system" becomes a way to launder any write.
 */
const WRITE_CLASS_OWNER: Record<SoulWriteClass, "agent" | "user" | "operator"> = {
  identity: "agent",
  directives: "user",
  constraints: "operator",
};

/**
 * Returns the SINGLE write class an actor owns, or `undefined` when it owns no single
 * one.
 *
 * `system` returns `undefined` even though {@link mayWriteClass} allows it every
 * class: it owns all of them, not one, so there is no single answer. A caller asking
 * "may this actor write X" must use {@link mayWriteClass}.
 */
export function writableClassFor(
  actorType: "agent" | "user" | "operator" | "system",
): SoulWriteClass | undefined {
  const entry = (
    Object.entries(WRITE_CLASS_OWNER) as [SoulWriteClass, "agent" | "user" | "operator"][]
  ).find(([, owner]) => owner === actorType);
  return entry?.[0];
}

/**
 * True when `actorType` may write `writeClass`.
 *
 * `system` may write every class, and that is the one exception worth stating: it is
 * the actor of provisioning (which sets the whole document once) and of restore
 * (which re-applies a snapshot that was already validated when it was first written).
 * Neither is a patch, so neither has a single owning class.
 *
 * The abuse protection is not in this function — it is that `system` is unreachable
 * from outside: no HTTP route and no model-facing tool can set it. Only
 * `SoulStore.restore` and the provisioning path do, and both are internal. Making
 * `system` own nothing (the first version of this) looked stricter but only made
 * `restore` fail, which is why it is spelled out here instead.
 */
export function mayWriteClass(
  actorType: "agent" | "user" | "operator" | "system",
  writeClass: SoulWriteClass,
): boolean {
  if (actorType === "system") return true;
  return WRITE_CLASS_OWNER[writeClass] === actorType;
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

/**
 * Scaffolding text that must never become a stored value.
 *
 * Compared after {@link normalizeFieldValue}, so case and surrounding markdown
 * decoration do not matter. Sourced from the onboarding template
 * ({@link SOUL_TEMPLATE_PLACEHOLDERS} feeds both this set and the template
 * itself, so the two cannot drift apart).
 */
export const SOUL_TEMPLATE_PLACEHOLDERS = [
  "not set yet",
  "pick something you like",
  "tbd",
  "todo",
  "describe yourself here",
  "your signature - pick one that feels right",
  "how do you come across?",
  "what are you responsible for?",
  "add standing instructions here",
  "n/a",
  "-",
] as const;

const PLACEHOLDER_SET = new Set<string>(SOUL_TEMPLATE_PLACEHOLDERS);

/**
 * Normalises a raw field value for storage.
 *
 * Collapses whitespace runs (a multi-line value would break the single-line
 * prompt rendering of short fields), strips surrounding markdown emphasis and
 * parenthesised template hints, and bounds the length. Returns `undefined` for
 * anything that is empty or a known placeholder — the caller then treats the
 * field as "not provided" rather than storing a meaningless value.
 *
 * `multiline` keeps newlines for the prose fields (`notes`, `instructions`,
 * `rules`, `compliance`) where paragraph structure is meaningful.
 */
export function normalizeFieldValue(
  raw: unknown,
  options: { multiline?: boolean } = {},
): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim();
  if (value.length === 0) return undefined;

  // Strip markdown emphasis wrappers so `*Molty*` stores as `Molty` and matches
  // the placeholder set the same way a bare value would.
  value = value.replace(/^[*_`\s]+/, "").replace(/[*_`\s]+$/, "");
  // A fully parenthesised value is template guidance, e.g. "(pick one)".
  if (value.startsWith("(") && value.endsWith(")")) {
    value = value.slice(1, -1).trim();
  }
  value =
    options.multiline === true
      ? // Normalise line endings and collapse 3+ blank lines, but keep paragraphs.
        value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n")
      : value.replace(/\s+/g, " ");

  if (value.length === 0) return undefined;
  if (PLACEHOLDER_SET.has(value.toLowerCase())) return undefined;

  return value.length > SOUL_FIELD_MAX_CHARS ? value.slice(0, SOUL_FIELD_MAX_CHARS) : value;
}

/** Fields whose content is prose and keeps its line structure. */
const MULTILINE_FIELDS = new Set<string>([
  "notes",
  "instructions",
  "about",
  "avoid",
  "rules",
  "compliance",
]);

// `T extends object` rather than `Record<string, unknown>`: the soul section
// interfaces declare named optional fields and therefore have no index
// signature, so they do not satisfy the Record constraint. The field list
// parameter is what actually constrains which keys are read.
function normalizeSection<T extends object>(raw: unknown, fields: readonly string[]): T {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  // Iterate the declared field list, not the input's keys: an unknown key in
  // stored JSONB (from an older shape or a hand-edited row) is dropped rather
  // than silently rendered into the prompt.
  for (const field of fields) {
    const value = normalizeFieldValue(source[field], {
      multiline: MULTILINE_FIELDS.has(field),
    });
    if (value !== undefined) out[field] = value;
  }
  return out as T;
}

/** Maximum number of denied tool ids. Bounded because the list is rendered. */
export const MAX_DENIED_TOOLS = 64;

/**
 * Normalises the denied-tool list: trimmed, de-duplicated, sorted, bounded.
 *
 * Sorting matters for the same reason field order does — this list is part of
 * the cacheable prompt prefix, and an unsorted list reorders on every JSONB
 * round trip.
 */
export function normalizeDeniedTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().toLowerCase();
    if (value.length === 0 || value.length > 128) continue;
    seen.add(value);
    if (seen.size >= MAX_DENIED_TOOLS) break;
  }
  return seen.size === 0 ? undefined : [...seen].sort();
}

// ---------------------------------------------------------------------------
// Normalisation + merge
// ---------------------------------------------------------------------------

/** Normalises a whole document, dropping unknown keys and placeholders. */
export function normalizeSoulDocument(raw: {
  identity?: unknown;
  directives?: unknown;
  constraints?: unknown;
}): SoulDocument {
  const constraintsSource = (raw.constraints ?? {}) as Record<string, unknown>;
  const deniedTools = normalizeDeniedTools(constraintsSource.deniedTools);
  return {
    identity: normalizeSection<SoulIdentity>(raw.identity, SOUL_IDENTITY_FIELDS),
    directives: normalizeSection<SoulDirectives>(raw.directives, SOUL_DIRECTIVE_FIELDS),
    constraints: {
      ...normalizeSection<SoulConstraints>(raw.constraints, SOUL_CONSTRAINT_TEXT_FIELDS),
      ...(deniedTools !== undefined ? { deniedTools } : {}),
    },
  };
}

/**
 * Sentinel a patch uses to CLEAR a field.
 *
 * Needed because `undefined` already means "leave unchanged" (that is what makes
 * the merge non-destructive), so there would otherwise be no way to remove a
 * value once set. An explicit sentinel keeps both intents expressible without
 * overloading `null`, which JSON round-trips inconsistently through JSONB.
 */
export const CLEAR_FIELD = "\u0000clear" as const;

function mergeSection<T extends object>(
  base: T,
  patch: Partial<T> | undefined,
  fields: readonly string[],
): T {
  if (patch === undefined) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue;
    const raw = (patch as Record<string, unknown>)[field];
    if (raw === CLEAR_FIELD) {
      delete out[field];
      continue;
    }
    const value = normalizeFieldValue(raw, {
      multiline: MULTILINE_FIELDS.has(field),
    });
    // A patch value that normalises away (empty or placeholder) is a no-op, not
    // a clear: a model echoing back "not set yet" must not erase a real value.
    if (value !== undefined) out[field] = value;
  }
  return out as T;
}

/**
 * Applies `patch` to `base` on behalf of `actorType`.
 *
 * The write-class boundary is structural: only the section this actor owns is
 * merged, and the other two are carried over from `base` verbatim. A patch that
 * names a section the actor does not own is reported in `ignoredClasses` so the
 * caller can tell the actor its attempt was dropped — silently discarding it
 * would leave an agent believing it had changed its own constraints.
 */
export function applySoulPatch(params: {
  base: SoulDocument;
  patch: SoulPatch;
  actorType: "agent" | "user" | "operator" | "system";
}): { next: SoulDocument; changed: boolean; ignoredClasses: SoulWriteClass[] } {
  const { base, patch, actorType } = params;
  const ignoredClasses: SoulWriteClass[] = [];

  const wants: SoulWriteClass[] = [];
  if (patch.identity !== undefined) wants.push("identity");
  if (patch.directives !== undefined) wants.push("directives");
  if (patch.constraints !== undefined) wants.push("constraints");
  for (const writeClass of wants) {
    if (!mayWriteClass(actorType, writeClass)) ignoredClasses.push(writeClass);
  }

  const next: SoulDocument = {
    identity: mayWriteClass(actorType, "identity")
      ? mergeSection(base.identity, patch.identity, SOUL_IDENTITY_FIELDS)
      : base.identity,
    directives: mayWriteClass(actorType, "directives")
      ? mergeSection(base.directives, patch.directives, SOUL_DIRECTIVE_FIELDS)
      : base.directives,
    constraints: mayWriteClass(actorType, "constraints")
      ? mergeConstraints(base.constraints, patch.constraints)
      : base.constraints,
  };

  return {
    next,
    changed: soulDocumentHash(next) !== soulDocumentHash(base),
    ignoredClasses,
  };
}

function mergeConstraints(
  base: SoulConstraints,
  patch: Partial<SoulConstraints> | undefined,
): SoulConstraints {
  const merged = mergeSection(base, patch, SOUL_CONSTRAINT_TEXT_FIELDS);
  if (patch === undefined || !Object.hasOwn(patch, "deniedTools")) {
    return merged;
  }
  const raw = patch.deniedTools;
  // A denied-tool list is replaced wholesale rather than merged: an operator
  // removing an entry must be able to, and a merge would make removal
  // impossible. An empty array clears it.
  if (Array.isArray(raw) && raw.length === 0) {
    const { deniedTools: _dropped, ...rest } = merged;
    return rest;
  }
  const normalized = normalizeDeniedTools(raw);
  return normalized === undefined ? merged : { ...merged, deniedTools: normalized };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic content hash over the whole document, used as the optimistic
 * lock and as the revision identity.
 *
 * Serialisation walks the DECLARED field order rather than using `JSON.stringify`
 * on the object: stringify follows insertion order, so two documents with equal
 * content but different key order would hash differently and every mutation
 * would appear to conflict.
 */
export function soulDocumentHash(doc: SoulDocument): string {
  const parts: string[] = [];
  for (const field of SOUL_IDENTITY_FIELDS) {
    parts.push(`i.${field}=${doc.identity[field] ?? ""}`);
  }
  for (const field of SOUL_DIRECTIVE_FIELDS) {
    parts.push(`d.${field}=${doc.directives[field] ?? ""}`);
  }
  for (const field of SOUL_CONSTRAINT_TEXT_FIELDS) {
    parts.push(`c.${field}=${doc.constraints[field] ?? ""}`);
  }
  parts.push(`c.deniedTools=${(doc.constraints.deniedTools ?? []).join(",")}`);
  return crypto.createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
}

/** True when the document carries no meaningful value at all. */
export function isEmptySoulDocument(doc: SoulDocument): boolean {
  return soulDocumentHash(doc) === soulDocumentHash(emptySoulDocument());
}
