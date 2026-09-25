"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Editor for the prompt files behind `#[[file:prompts/x.md]]`.
 *
 * A node's `systemPrompt` usually holds nothing but that reference — the prompt
 * text itself lives in a Markdown file that the flow parser inlines on load.
 * Without this panel the Studio could show the reference but not the prompt, so
 * the actual wording of nearly every flow was not editable in the UI.
 *
 * The file is loaded and saved on its own (`/flows/prompts/*`), independently of
 * the flow: saving the flow leaves the reference untouched, saving here leaves
 * the flow untouched. `baseHash` gives the same 409-on-conflict protection the
 * flow write path has.
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../lib/ui";
import {
  fetchPromptFile,
  promptFileRefs,
  writePromptFile,
} from "../lib/prompt-files";

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

interface PromptFileCardProps {
  path: string;
  token: string | undefined;
  /** Notifies the parent that the file on disk changed (for a reload hint). */
  onSaved?: (path: string) => void;
}

function PromptFileCard({
  path,
  token,
  onSaved,
}: PromptFileCardProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [writable, setWritable] = useState(false);
  /** Content as loaded/last saved — drives the dirty flag and the save button. */
  const baseRef = useRef<{ content: string; hash: string }>({
    content: "",
    hash: "",
  });

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const file = await fetchPromptFile(path, token);
      baseRef.current = { content: file.content, hash: file.hash };
      setText(file.content);
      setWritable(file.writable);
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [path, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = text !== baseRef.current.content;

  const save = async (): Promise<void> => {
    setStatus({ kind: "saving" });
    try {
      const { hash } = await writePromptFile(
        path,
        text,
        baseRef.current.hash,
        token,
      );
      baseRef.current = { content: text, hash };
      setStatus({ kind: "saved" });
      onSaved?.(path);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const lineCount = text === "" ? 0 : text.split("\n").length;

  return (
    <div className="rounded border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-[11px]" title={path}>
          📝 {path}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
          {status.kind === "loading" && <span>loading…</span>}
          {status.kind === "saving" && <span>saving…</span>}
          {status.kind === "saved" && !dirty && <span>saved</span>}
          {dirty && status.kind !== "saving" && (
            <span className="text-amber-600 dark:text-amber-400">
              unsaved changes
            </span>
          )}
          {!writable && status.kind === "ready" && (
            <span title="FLOWS_DIR is not writable on this runtime">
              read-only
            </span>
          )}
          <span>
            {lineCount} lines · {text.length} chars
          </span>
        </span>
      </div>

      {status.kind === "error" ? (
        <div className="space-y-2 p-2">
          <p className="text-[11px] text-destructive">{status.message}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-2 p-2">
          <textarea
            aria-label={`Prompt file ${path}`}
            className="w-full resize-y rounded border border-border bg-card px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            rows={16}
            spellCheck={false}
            readOnly={!writable}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!writable || !dirty || status.kind === "saving"}
              title={
                writable
                  ? "Writes this prompt file — the flow itself is not changed"
                  : "The runtime's flow directory is mounted read-only"
              }
            >
              Save prompt file
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void load()}
              disabled={status.kind === "saving"}
              title="Discards local edits and reloads the file from disk"
            >
              Reload
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface PromptFileEditorProps {
  /** The node's `systemPrompt` value — the references are read from it. */
  systemPrompt: string | undefined;
  token: string | undefined;
  onSaved?: (path: string) => void;
}

/**
 * Renders one editor per prompt file referenced from `systemPrompt`. Returns
 * null when the prompt is inline (no `#[[file:...]]`), which keeps the node
 * panel unchanged for flows that don't use prompt includes.
 */
export function PromptFileEditor({
  systemPrompt,
  token,
  onSaved,
}: PromptFileEditorProps): React.JSX.Element | null {
  const refs = promptFileRefs(systemPrompt);
  if (refs.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-muted-foreground">
        The prompt text lives in {refs.length === 1 ? "this file" : "these files"}
        , not in the flow. Editing it here writes the file directly; the
        reference in the field above stays as it is.
      </p>
      {refs.map((ref) =>
        ref.editable ? (
          <PromptFileCard
            key={ref.path}
            path={ref.path}
            token={token}
            {...(onSaved ? { onSaved } : {})}
          />
        ) : (
          <p key={ref.path} className="text-[11px] text-muted-foreground">
            <span className="font-mono">{ref.path}</span> cannot be edited here:
            only Markdown files under <span className="font-mono">prompts/</span>{" "}
            are editable.
          </p>
        ),
      )}
    </div>
  );
}
