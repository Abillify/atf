// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * JSON cursor → documentation key (`src/lib/json-key-path.ts`)
 *
 * The Studio's JSON editors report which part of the edited JSON the cursor
 * sits in, so the documentation panel can mark the matching passage.
 * `jsonKeyPathAt` derives the dotted key path from the raw text and the
 * cursor offset (works on invalid, mid-edit JSON too); `nodeDocKeyForPath`
 * maps such a path of a node definition onto a documentation key
 * (`config.*` → the bare config key, `llm.*` → the dotted model-field key).
 */

/**
 * Dotted key path of the innermost entry containing `offset` in `text`, e.g.
 * `llm.parameters.temperature` or `config.toolArgs`. Inside an object between
 * entries the LAST key read at that depth is reported (the entry the cursor
 * visually belongs to); inside an array the array's own key; at the very top
 * of an empty document `undefined`. Tolerates invalid JSON — it scans tokens
 * rather than parsing, so a half-typed file still reports a sensible path.
 */
export function jsonKeyPathAt(text: string, offset: number): string | undefined {
  // One frame per open `{`/`[`: the key that led here, whether it is an array,
  // and how deep `path` was when it opened (to unwind on close).
  const stack: Array<{ key: string | null; isArr: boolean; pathLen: number }> = [];
  const path: string[] = [];
  let curKey: string | null = null;
  const n = Math.min(Math.max(offset, 0), text.length);
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length) {
        if (text[j] === "\\") {
          s += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        s += text[j] ?? "";
        j++;
      }
      // A string directly followed by `:` (inside an object, or at the root) is a key.
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k] ?? "")) k++;
      const frame = stack[stack.length - 1];
      const isKey = text[k] === ":" && (frame === undefined || !frame.isArr);
      if (offset <= j) {
        // Cursor inside this string: a key string reports itself, a value
        // keeps the state from before it (its own key).
        if (isKey) curKey = s;
        break;
      }
      if (isKey) curKey = s;
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push({ key: curKey, isArr: c === "[", pathLen: path.length });
      if (curKey !== null) path.push(curKey);
      curKey = null;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      const frame = stack.pop();
      if (frame !== undefined) {
        path.length = frame.pathLen;
        curKey = frame.key;
      }
      i++;
      continue;
    }
    i++;
  }
  const parts = path.slice();
  if (curKey !== null) parts.push(curKey);
  return parts.length > 0 ? parts.join(".") : undefined;
}

/** A documented model field (`llm.*`, with bare-key sub-fields below it). */
interface LlmFieldLike {
  key: string;
  fields?: LlmFieldLike[];
}

/**
 * Map a `jsonKeyPathAt` path of a NODE definition onto a documentation key:
 *
 * - `config.<…>` → the LAST segment (config docs mark bare keys at every depth)
 * - `llm` → the node-field passage; `llm.<…>` → the deepest documented
 *   `llmFields` entry (`llm.parameters.temperature`), falling back to `llm`
 * - anything else → the first segment (top-level node fields: `label`,
 *   `systemPrompt`, `tools`, `overrides`, `classifierSchema`, …)
 */
export function nodeDocKeyForPath(
  path: string | undefined,
  llmFields?: LlmFieldLike[],
): string | undefined {
  if (path === undefined) return undefined;
  const segs = path.split(".");
  const head = segs[0] ?? "";
  if (head === "config") return segs.length > 1 ? segs[segs.length - 1] : undefined;
  if (head === "llm") {
    if (segs.length === 1) return "llm";
    let matched: string | undefined = llmFields?.find((f) => f.key === `llm.${segs[1]}`)?.key;
    let level = llmFields?.find((f) => f.key === matched)?.fields;
    for (let i = 2; i < segs.length && level !== undefined; i++) {
      const next = level.find((f) => f.key === segs[i]);
      if (next === undefined) break;
      matched = `${matched}.${next.key}`;
      level = next.fields;
    }
    return matched ?? "llm";
  }
  return head;
}
