// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Comment-preserving YAML write-back (`src/graph/flow-yaml-merge.ts`)
 *
 * ## The problem this solves
 *
 * The flow editor round-trips a flow through JSON: the UI reads the parsed
 * definition, the operator edits a model or a prompt, and the route writes the
 * result back. Serialising that plain object with `stringify()` produces valid,
 * equivalent YAML — and silently destroys every comment in the file, because
 * comments do not exist in the object graph at all.
 *
 * In this repository that is a real loss, not a cosmetic one. The bundled flows
 * carry hundreds of comment lines that hold the *reasoning*: which override
 * ordering is deliberate and must not be "cleaned up", why a schema is forced,
 * which production incident led to a rule. One save from the UI removed all of
 * it, and the resulting file looked perfectly fine — so nothing signalled the
 * loss.
 *
 * ## How it works
 *
 * Instead of re-serialising from scratch, the existing file is parsed into a
 * `yaml` Document (which retains comments, key order and scalar styles) and the
 * new definition is merged INTO it:
 *
 *   - unchanged leaves are left completely untouched, so their comments, quoting
 *     and block-scalar style survive verbatim;
 *   - a changed leaf has its value replaced, carrying the old node's own comments
 *     across;
 *   - a removed key is deleted together with its comments (the key is gone, so
 *     its explanation should go too);
 *   - an added key is appended as a fresh node.
 *
 * ## Why sequences are matched by `id`, not by index
 *
 * `nodes` and `edges` are arrays whose entries are identified by `id`, and the
 * editor may reorder them. An index-based merge would then graft the comments of
 * one node onto a different node — worse than deleting them, because the file
 * would look correct while documenting the wrong thing. Entries that carry a
 * scalar `id` are therefore matched by that id, and the sequence is reordered to
 * the new order with each entry's comments still attached to it.
 *
 * ## Known limitation: the comment above the FIRST sequence entry
 *
 * The `yaml` parser attaches a comment that precedes the first entry of a
 * sequence to the SEQUENCE node (`seq.commentBefore`), not to that entry — the
 * position is genuinely ambiguous, since such a comment may equally be a heading
 * for the whole list ("# nodes run in order") or a note about the first entry.
 * It therefore stays pinned to the top of the list even if that entry is removed
 * or moved. Re-homing it onto whichever entry happens to be first would be
 * guesswork that can silently relocate a section heading, so this module leaves
 * the placement alone. Every SUBSEQUENT entry's comment travels with its entry.
 *
 * ## Anchors and aliases (`&name` / `*name`)
 *
 * Several bundled flows share a config block between nodes via an anchor and
 * plain alias references (`toolArgs: *primaryArgs`, `tools: *branchTools`). The
 * definition the editor sends back is the EXPANDED form — the parser resolved
 * every alias on load, so each site carries its own copy of the value and there
 * is nothing in the object graph that says "these five are the same block".
 *
 * A naive merge therefore replaced every alias with a literal copy: the content
 * stayed correct, but the file grew by a third, the anchors were left dangling
 * with nothing referencing them, and the shared block silently became five
 * independent ones — so a later edit to the anchor no longer reached the nodes
 * that used to follow it. {@link mergeNode} keeps an alias when the value at
 * that site is unchanged, which covers every save that does not touch the
 * shared block. A site whose value genuinely diverged is inlined, because it is
 * no longer the shared value.
 *
 * Alias preservation is verified, not trusted: {@link mergeFlowIntoYaml}
 * re-parses its own output and falls back to the alias-expanding merge unless
 * the result reads back exactly as `next`. That closes the one case where
 * keeping an alias would change content — the anchor's own definition being
 * edited while an alias site is not.
 *
 * Pure and synchronous: no file I/O, so the merge itself is fully unit-testable.
 *
 * No `any` at module boundaries.
 */

import { isDeepStrictEqual } from "node:util";
import {
  parseDocument,
  parse as parseYaml,
  Parser,
  Composer,
  CST,
  isAlias,
  isMap,
  isSeq,
  isScalar,
  isPair,
  type Alias,
  type Document,
  type Node as YamlNode,
  type YAMLMap,
  type YAMLSeq,
  type Scalar,
  type Pair,
} from "yaml";

/** Raised when the existing text cannot be used as a merge base. */
export class YamlMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlMergeError";
  }
}

/** True when the text contains at least one YAML comment line or trailing comment. */
export function yamlHasComments(text: string): boolean {
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) return /(^|\s)#/m.test(text);
    let found = false;
    visitNodes(doc.contents, (node) => {
      if (found) return;
      const n = node as { comment?: unknown; commentBefore?: unknown };
      if (
        typeof n.comment === "string" ||
        typeof n.commentBefore === "string"
      ) {
        found = true;
      }
    });
    return (
      found ||
      typeof doc.comment === "string" ||
      typeof doc.commentBefore === "string"
    );
  } catch {
    // Unparseable: fall back to a textual probe rather than claiming "no
    // comments" — the caller uses this to decide whether anything is at risk.
    return /(^|\s)#/m.test(text);
  }
}

/** Walks every node and pair of a tree, including keys and values. */
function visitNodes(
  node: unknown,
  fn: (node: unknown) => void,
): void {
  if (node === null || typeof node !== "object") return;
  fn(node);
  if (isMap(node)) {
    for (const item of node.items) {
      if (isPair(item)) {
        fn(item);
        visitNodes(item.key, fn);
        visitNodes(item.value, fn);
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items) visitNodes(item, fn);
  }
}

/** Comment fields a node may carry, copied when a value is replaced. */
interface Commented {
  comment?: string | null;
  commentBefore?: string | null;
  spaceBefore?: boolean;
}

function carryComments(from: unknown, to: unknown): void {
  if (
    from === null ||
    typeof from !== "object" ||
    to === null ||
    typeof to !== "object"
  ) {
    return;
  }
  const src = from as Commented;
  const dst = to as Commented;
  if (typeof src.comment === "string") dst.comment = src.comment;
  if (typeof src.commentBefore === "string") {
    dst.commentBefore = src.commentBefore;
  }
  if (src.spaceBefore === true) dst.spaceBefore = true;
}

/** Reads a plain JS value out of a node for equality comparison. */
function plainValueOf(node: unknown): unknown {
  if (isScalar(node)) return (node as Scalar).value;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns the scalar `id` of a sequence entry, when it has one. */
function entryId(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const idNode = (node as YAMLMap).get("id", true);
  const value = plainValueOf(idNode);
  return typeof value === "string" ? value : undefined;
}

function plainEntryId(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  return typeof value.id === "string" ? value.id : undefined;
}

/**
 * The resolved value of every anchor in the document, captured BEFORE the merge
 * mutates anything. An alias site may only stay an alias when the incoming value
 * still equals this — comparing against the live tree would be order-dependent,
 * since the anchor's definition may or may not have been merged already.
 */
function pristineAnchorValues(doc: Document): Map<string, unknown> {
  const values = new Map<string, unknown>();
  visitNodes(doc.contents, (node) => {
    const anchor = (node as { anchor?: unknown }).anchor;
    if (typeof anchor !== "string" || anchor === "" || values.has(anchor)) return;
    const asJson = (node as { toJSON?: () => unknown }).toJSON;
    if (typeof asJson === "function") {
      values.set(anchor, (node as { toJSON: () => unknown }).toJSON());
    }
  });
  return values;
}

/** How {@link mergeNode} treats an alias node it encounters. */
interface MergeOptions {
  /**
   * Resolved anchor values from {@link pristineAnchorValues}. When absent,
   * aliases are expanded into literal values (the fallback behaviour).
   */
  anchors?: Map<string, unknown>;
}

/**
 * Merges `next` into `current` (a Document node), returning the node to use.
 *
 * Returns `current` when it could be mutated in place (the comment-preserving
 * path), or a freshly created node when the shape changed incompatibly.
 */
function mergeNode(
  doc: Document,
  current: unknown,
  next: unknown,
  opts: MergeOptions = {},
): unknown {
  // --- Alias (`*name`) ---
  // `next` holds the expanded value at this site. As long as that value still
  // matches what the anchor resolved to, the alias says exactly the same thing
  // and is left in place; replacing it would inline the shared block.
  if (isAlias(current) && opts.anchors !== undefined) {
    const name = (current as Alias).source;
    if (
      opts.anchors.has(name) &&
      isDeepStrictEqual(next, opts.anchors.get(name))
    ) {
      return current;
    }
    // The value at this site diverged from the shared block, so it is not the
    // shared value any more and has to be written out on its own.
    const created = doc.createNode(next);
    carryComments(current, created);
    return created;
  }

  // --- Map ---
  if (isPlainObject(next)) {
    if (!isMap(current)) {
      // Shape changed (e.g. scalar → object): a fresh node is the only option,
      // but keep whatever comment the old node carried.
      const created = doc.createNode(next);
      carryComments(current, created);
      return created;
    }
    const map = current as YAMLMap;
    const nextKeys = new Set(Object.keys(next));

    // Remove keys that no longer exist. Iterated over a copy because deleting
    // mutates `items`.
    for (const item of [...map.items]) {
      if (!isPair(item)) continue;
      const key = plainValueOf((item as Pair).key);
      if (typeof key === "string" && !nextKeys.has(key)) {
        map.delete(key);
      }
    }

    for (const [key, value] of Object.entries(next)) {
      const existing = map.get(key, true);
      if (existing === undefined) {
        // New key — appended in the new definition's order.
        map.set(key, doc.createNode(value));
        continue;
      }
      const merged = mergeNode(doc, existing, value, opts);
      if (merged !== existing) map.set(key, merged);
    }
    return map;
  }

  // --- Sequence ---
  if (Array.isArray(next)) {
    if (!isSeq(current)) {
      const created = doc.createNode(next);
      carryComments(current, created);
      return created;
    }
    const seq = current as YAMLSeq;

    // Index existing entries by id so a reordered array keeps each entry's
    // comments attached to the RIGHT entry.
    const byId = new Map<string, unknown>();
    const withoutId: unknown[] = [];
    for (const item of seq.items) {
      const id = entryId(item);
      if (id !== undefined && !byId.has(id)) byId.set(id, item);
      else withoutId.push(item);
    }

    let positional = 0;
    const rebuilt: unknown[] = next.map((nextItem) => {
      const id = plainEntryId(nextItem);
      if (id !== undefined) {
        const existing = byId.get(id);
        if (existing !== undefined) {
          byId.delete(id);
          return mergeNode(doc, existing, nextItem, opts);
        }
        return doc.createNode(nextItem);
      }
      // Entries without an id (e.g. a plain string in `parallelNodes`) fall back
      // to positional matching among the id-less entries — the only signal
      // available, and safe because they carry no identity of their own.
      const existing = withoutId[positional++];
      if (existing !== undefined) return mergeNode(doc, existing, nextItem, opts);
      return doc.createNode(nextItem);
    });

    seq.items = rebuilt as YamlNode[];
    return seq;
  }

  // --- Scalar / null ---
  if (isScalar(current) && plainValueOf(current) === next) {
    // Unchanged: leave the node completely alone so its quoting, block style
    // and comments are byte-identical after the round-trip.
    return current;
  }
  const created = doc.createNode(next);
  carryComments(current, created);
  return created;
}

/**
 * Merges `next` into the YAML text `existingYaml`, preserving comments,
 * key order and scalar styles wherever the value did not change.
 *
 * @throws {YamlMergeError} when `existingYaml` cannot serve as a merge base
 *   (unparseable, or not a mapping at the top level). The caller should then
 *   fall back to a plain serialisation.
 */
export function mergeFlowIntoYaml(
  existingYaml: string,
  next: unknown,
  opts: { lineWidth?: number } = {},
): string {
  const lossless = patchYamlLosslessly(existingYaml, next);
  if (lossless !== null) return lossless;

  const lineWidth = opts.lineWidth ?? 120;

  const run = (doc: Document, mergeOpts: MergeOptions): string => {
    const merged = mergeNode(doc, doc.contents, next, mergeOpts);
    doc.contents = merged as typeof doc.contents;
    return doc.toString({ lineWidth });
  };

  const doc = parseBase(existingYaml);

  // Keep `*alias` references where the shared value did not change. Verified by
  // reading the result back: an alias whose anchor was edited elsewhere would
  // resolve to a different value, and that must never leave this function.
  const anchors = pristineAnchorValues(doc);
  if (anchors.size === 0) return run(doc, {});

  const preserved = run(doc, { anchors });
  let readsBack = false;
  try {
    readsBack = isDeepStrictEqual(parseYaml(preserved), next);
  } catch {
    readsBack = false;
  }
  // The merge mutated `doc`, so the fallback needs a fresh base.
  return readsBack ? preserved : run(parseBase(existingYaml), {});
}

/** Parses the merge base, rejecting anything that cannot serve as one. */
function parseBase(existingYaml: string): Document {
  let doc: Document;
  try {
    doc = parseDocument(existingYaml);
  } catch (err) {
    throw new YamlMergeError(
      `existing YAML could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    throw new YamlMergeError(
      `existing YAML has parse errors: ${firstError.message}`,
    );
  }
  if (!isMap(doc.contents)) {
    throw new YamlMergeError(
      "existing YAML is not a mapping at the top level, so it cannot be merged into",
    );
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Lossless fast path
// ---------------------------------------------------------------------------
//
// Re-serialising a `yaml` Document is NOT byte-stable even when nothing
// changed: folded (`>`) and plain multi-line scalars are re-wrapped to
// `lineWidth`, which rewrites hundreds of hand-wrapped lines in these flow
// files. For the common editor saves that is avoidable:
//
//   - content unchanged            -> return the file text as is;
//   - only scalar VALUES changed   -> rewrite just those scalars in the CST
//     (a label, a prompt, a temperature, a model shortcut) and leave every
//     other byte of the file untouched.
//
// Anything structural (keys added/removed, list length or order changed)
// returns null and takes the Document merge above. The result is re-parsed and
// must equal `next` exactly, so a styling surprise can never change content.

/** Returns the patched text, or null when the fast path does not apply. */
export function patchYamlLosslessly(existingYaml: string, next: unknown): string | null {
  let current: unknown;
  try {
    current = parseYaml(existingYaml);
  } catch {
    return null;
  }
  if (isDeepStrictEqual(current, next)) return existingYaml;

  const tokens = [...new Parser().parse(existingYaml)];
  const docs = [...new Composer({ keepSourceTokens: true }).compose(tokens)];
  const doc = docs[0];
  if (docs.length !== 1 || doc === undefined || doc.errors.length > 0) return null;

  const changes: Array<{ node: Scalar; value: unknown }> = [];
  if (!collectScalarChanges(doc.contents, current, next, changes)) return null;

  for (const { node, value } of changes) {
    const token = node.srcToken;
    if (token === undefined || !CST.isScalar(token)) return null;
    try {
      CST.setScalarValue(token, scalarSource(value), {
        type: scalarStyleFor(token.type, value),
      });
    } catch {
      return null;
    }
  }

  const out = tokens.map((t) => CST.stringify(t)).join("");
  try {
    return isDeepStrictEqual(parseYaml(out), next) ? out : null;
  } catch {
    return null;
  }
}

function collectScalarChanges(
  node: unknown,
  current: unknown,
  next: unknown,
  out: Array<{ node: Scalar; value: unknown }>,
): boolean {
  if (isDeepStrictEqual(current, next)) return true;

  if (isPlainObject(current) && isPlainObject(next)) {
    if (!isMap(node)) return false;
    const keys = Object.keys(current);
    if (keys.length !== Object.keys(next).length) return false;
    for (const key of keys) {
      if (!(key in next)) return false;
      const pair = node.items.find(
        (p) => isScalar(p.key) && String(p.key.value) === key,
      );
      if (pair === undefined) return false;
      if (!collectScalarChanges(pair.value, current[key], next[key], out)) return false;
    }
    return true;
  }

  if (Array.isArray(current) && Array.isArray(next)) {
    if (!isSeq(node) || current.length !== next.length) return false;
    // Entries identified by `id` (nodes, edges) must keep their order —
    // otherwise values would be patched onto the wrong entry's text/comments.
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = next[i];
      if (isPlainObject(a) && isPlainObject(b) && a["id"] !== b["id"]) return false;
      if (!collectScalarChanges(node.items[i], a, b, out)) return false;
    }
    return true;
  }

  const isLeaf = (v: unknown) => v === null || typeof v !== "object";
  if (isLeaf(current) && isLeaf(next) && isScalar(node)) {
    out.push({ node, value: next });
    return true;
  }
  return false;
}

function scalarSource(value: unknown): string {
  return value === null ? "null" : String(value);
}

/**
 * Keeps the scalar's existing style where that still round-trips the value's
 * type; a string that would read back as something else in plain style (a
 * number, `true`, `{{vars.x}}`, …) is double-quoted, and a number/bool/null is
 * written plain.
 */
function scalarStyleFor(current: CST.FlowScalar["type"] | CST.BlockScalar["type"], value: unknown): Scalar.Type {
  if (typeof value !== "string") return "PLAIN";
  if (current === "block-scalar") {
    return "BLOCK_LITERAL";
  }
  if (current === "scalar") {
    let readsBack = false;
    try {
      readsBack = parseYaml(value) === value && !value.includes("\n");
    } catch {
      readsBack = false;
    }
    return readsBack ? "PLAIN" : "QUOTE_DOUBLE";
  }
  return current === "single-quoted-scalar" ? "QUOTE_SINGLE" : "QUOTE_DOUBLE";
}
