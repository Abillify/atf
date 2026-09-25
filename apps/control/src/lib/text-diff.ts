// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Minimal text diff for the expression builder's copilot proposals: line by
 * line for multi-line values (prompts, JSON), token by token for one-liners
 * (conditions, calculations). LCS-based; very large inputs fall back to
 * "all removed / all added" rather than an expensive table.
 */

export interface DiffPart {
  type: "same" | "add" | "del";
  text: string;
}

const MAX_CELLS = 400_000;

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...(a.length > 0 ? [{ type: "del" as const, text: a.join("") }] : []),
      ...(b.length > 0 ? [{ type: "add" as const, text: b.join("") }] : []),
    ];
  }
  const n = a.length;
  const m = b.length;
  // dp[i * (m + 1) + j] = LCS length of a[i..] and b[j..]
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  const at = (i: number, j: number): number => dp[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string | undefined): void => {
    if (text === undefined) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push("del", a[i]);
      i++;
    } else {
      push("add", b[j]);
      j++;
    }
  }
  for (; i < n; i++) push("del", a[i]);
  for (; j < m; j++) push("add", b[j]);
  return out;
}

/** Lines keep their newline so the parts concatenate back to the text. */
const lines = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Words, whitespace and punctuation as separate tokens. */
const tokens = (s: string): string[] => s.match(/\s+|[\w.[\]$]+|[^\s\w]/g) ?? [];

export function diffText(before: string, after: string): DiffPart[] {
  const multiLine = before.includes("\n") || after.includes("\n");
  return multiLine ? lcsDiff(lines(before), lines(after)) : lcsDiff(tokens(before), tokens(after));
}
