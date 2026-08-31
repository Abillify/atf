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
 * Pure and synchronous: no file I/O, so the merge itself is fully unit-testable.
 *
 * No `any` at module boundaries.
 */

import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  isPair,
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
 * Merges `next` into `current` (a Document node), returning the node to use.
 *
 * Returns `current` when it could be mutated in place (the comment-preserving
 * path), or a freshly created node when the shape changed incompatibly.
 */
function mergeNode(
  doc: Document,
  current: unknown,
  next: unknown,
): unknown {
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
      const merged = mergeNode(doc, existing, value);
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
          return mergeNode(doc, existing, nextItem);
        }
        return doc.createNode(nextItem);
      }
      // Entries without an id (e.g. a plain string in `parallelNodes`) fall back
      // to positional matching among the id-less entries — the only signal
      // available, and safe because they carry no identity of their own.
      const existing = withoutId[positional++];
      if (existing !== undefined) return mergeNode(doc, existing, nextItem);
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

  const merged = mergeNode(doc, doc.contents, next);
  doc.contents = merged as typeof doc.contents;

  return doc.toString({
    lineWidth: opts.lineWidth ?? 120,
  });
}
