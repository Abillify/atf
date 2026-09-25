// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Prompt files in the Studio: the content behind `#[[file:prompts/x.md]]`.
 *
 * Most flows keep their system prompts in Markdown files next to the flow and
 * only reference them from `systemPrompt`; the flow parser expands the
 * reference on load (runtime: `graph/flow-parser/normalize.ts`). The Studio
 * therefore has to read and write those files separately from the flow itself —
 * saving the flow never touches them, and the reference must stay a reference
 * so the file remains the single source of the prompt.
 */

import { backendUrl } from "./backend-url";

/** Same pattern the runtime parser uses for `#[[file:...]]`. */
const PROMPT_INCLUDE_RE = /#\[\[file:([^\]]+)\]\]/g;

/** Paths the prompt endpoints accept: Markdown/text under `prompts/`. */
const EDITABLE_PROMPT_PATH_RE =
  /^prompts\/(?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt)$/i;

export interface PromptFileContent {
  path: string;
  content: string;
  /** SHA-256 of the content as read — sent back as `baseHash` on save. */
  hash: string;
  /** False on a read-only FLOWS_DIR mount: the editor stays read-only. */
  writable: boolean;
}

const headers = (token: string | undefined): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

async function errorMessage(resp: Response): Promise<string> {
  const body = (await resp.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? `HTTP ${resp.status}`;
}

/**
 * Every prompt file referenced from a `systemPrompt` value, in order of
 * appearance and without duplicates. Paths outside `prompts/` are reported too
 * (as `editable: false`) so the UI can say why they cannot be edited here
 * rather than silently hiding them.
 */
export function promptFileRefs(
  text: string | undefined,
): Array<{ path: string; editable: boolean }> {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: Array<{ path: string; editable: boolean }> = [];
  for (const match of text.matchAll(PROMPT_INCLUDE_RE)) {
    const path = (match[1] ?? "").trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    refs.push({
      path,
      editable: !path.includes("..") && EDITABLE_PROMPT_PATH_RE.test(path),
    });
  }
  return refs;
}

/** GET /flows/prompts/content — the file's current text plus its hash. */
export async function fetchPromptFile(
  path: string,
  token: string | undefined,
): Promise<PromptFileContent> {
  const resp = await fetch(
    backendUrl(`/flows/prompts/content?path=${encodeURIComponent(path)}`),
    { headers: headers(token) },
  );
  if (!resp.ok) throw new Error(await errorMessage(resp));
  const data = (await resp.json()) as Partial<PromptFileContent>;
  return {
    path: data.path ?? path,
    content: data.content ?? "",
    hash: data.hash ?? "",
    writable: data.writable ?? false,
  };
}

/**
 * POST /flows/prompts/write — writes the file back.
 *
 * `baseHash` is the hash from {@link fetchPromptFile}; the runtime answers 409
 * when the file changed in the meantime. The returned hash becomes the base for
 * the next save.
 */
export async function writePromptFile(
  path: string,
  content: string,
  baseHash: string | undefined,
  token: string | undefined,
): Promise<{ hash: string }> {
  const resp = await fetch(backendUrl("/flows/prompts/write"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers(token) },
    body: JSON.stringify({
      path,
      content,
      ...(baseHash !== undefined && baseHash !== "" ? { baseHash } : {}),
    }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return (await resp.json()) as { hash: string };
}
