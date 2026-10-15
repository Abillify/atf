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
 *
 * Before saving, the editor offers three scopes: saving the file (every flow
 * including it is affected), saving under a new name and pointing only this
 * flow's reference at it ("save as"), or dropping the include and keeping the
 * modified text in this flow alone ("copy into flow").
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../lib/ui";
import {
  fetchPromptFile,
  inlinePromptRef,
  isEditablePromptPath,
  promptFileRefs,
  rewritePromptRef,
  writePromptFile,
} from "../lib/prompt-files";
import { translate } from "../lib/i18n";

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

interface PromptFileCardProps {
  path: string;
  token: string | undefined;
  /** The node's current `systemPrompt` — rewritten by the flow-local modes. */
  systemPrompt: string | undefined;
  /** Notifies the parent that the file on disk changed (for a reload hint). */
  onSaved?: (path: string) => void;
  /**
   * Applies a new `systemPrompt` to this flow only: "save as" points the
   * reference at the new file, "copy into flow" replaces the include with the
   * prompt text. Flows other than this one are never touched.
   */
  onSystemPromptChange?: (systemPrompt: string) => void;
}

function PromptFileCard({
  path,
  token,
  systemPrompt,
  onSaved,
  onSystemPromptChange,
}: PromptFileCardProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [writable, setWritable] = useState(false);
  /** Content as loaded/last saved — drives the dirty flag and the save button. */
  const baseRef = useRef<{ content: string; hash: string }>({
    content: "",
    hash: "",
  });
  /** "Save as…": the path row is hidden until the button opens it. */
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsPath, setSaveAsPath] = useState("");

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

  /**
   * "Save as": write a copy under a new name and point this flow's reference
   * at it. The old file is left alone, so every other flow keeps its prompt.
   */
  const saveAs = async (): Promise<void> => {
    const target = saveAsPath.trim();
    if (!isEditablePromptPath(target)) return;
    setStatus({ kind: "saving" });
    try {
      // No baseHash — the target is a new file, not an edit of an existing one.
      await writePromptFile(target, text, undefined, token);
      setSaveAsOpen(false);
      setStatus({ kind: "saved" });
      onSystemPromptChange?.(
        rewritePromptRef(systemPrompt ?? "", path, target),
      );
      onSaved?.(target);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * "Copy into flow": replace the include with the (modified) prompt text.
   * Nothing is written to disk — the file and all other flows stay as they are.
   */
  const copyIntoFlow = (): void => {
    onSystemPromptChange?.(inlinePromptRef(systemPrompt ?? "", path, text));
  };

  const lineCount = text === "" ? 0 : text.split("\n").length;

  return (
    <div className="rounded border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-[11px]" title={path}>
          📝 {path}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
          {status.kind === "loading" && <span>{translate("promptFileEditor.loading")}</span>}
          {status.kind === "saving" && <span>{translate("promptFileEditor.saving")}</span>}
          {status.kind === "saved" && !dirty && <span>saved</span>}
          {dirty && status.kind !== "saving" && (
            <span className="text-warning">
              {translate("promptFileEditor.unsavedChanges")}
            </span>
          )}
          {!writable && status.kind === "ready" && (
            <span title={translate("promptFileEditor.fLOWSDIRIsNotWritable")}>
              read-only
            </span>
          )}
          <span>
            {translate("promptFileEditor.lineCountLinesLengthChars", { lineCount, length: text.length })}
          </span>
        </span>
      </div>

      {status.kind === "error" ? (
        <div className="space-y-2 p-2">
          <p className="text-[11px] text-destructive">{status.message}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            {translate("promptFileEditor.retry")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2 p-2">
          <textarea
            aria-label={translate("promptFileEditor.promptFilePath", { path })}
            className="w-full resize-y rounded border border-border bg-card px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            rows={16}
            spellCheck={false}
            readOnly={!writable}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!writable || !dirty || status.kind === "saving"}
              title={
                writable
                  ? translate("promptFileEditor.writesThisPromptFileEvery")
                  : translate("promptFileEditor.theRuntimeSFlowDirectory")
              }
            >
              {translate("promptFileEditor.savePromptFile")}
            </Button>
            {onSystemPromptChange && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSaveAsPath(path);
                  setSaveAsOpen((open) => !open);
                }}
                disabled={!writable || status.kind === "saving"}
                title={translate("promptFileEditor.writesACopyUnderA")}
              >
                {translate("promptFileEditor.saveAs")}
              </Button>
            )}
            {onSystemPromptChange && (
              <Button
                size="sm"
                variant="secondary"
                onClick={copyIntoFlow}
                disabled={status.kind === "saving"}
                title={translate("promptFileEditor.movesThePromptTextInto")}
              >
                {translate("promptFileEditor.copyIntoFlow")}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void load()}
              disabled={status.kind === "saving"}
              title={translate("promptFileEditor.discardsLocalEditsAndReloads")}
            >
              {translate("promptFileEditor.reload")}
            </Button>
          </div>
          {saveAsOpen && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={translate("promptFileEditor.newPromptFilePathFor", { path })}
                className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={saveAsPath}
                onChange={(e) => setSaveAsPath(e.target.value)}
                placeholder="prompts/another-prompt.md"
              />
              <Button
                size="sm"
                onClick={() => void saveAs()}
                disabled={
                  !isEditablePromptPath(saveAsPath.trim()) ||
                  status.kind === "saving"
                }
              >
                {translate("promptFileEditor.saveAs2")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setSaveAsOpen(false)}
              >
                {translate("promptFileEditor.cancel")}
              </Button>
            </div>
          )}
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
  /**
   * Applies a modified `systemPrompt` to this flow — what the flow-local save
   * modes ("save as", "copy into flow") need. Without it only the plain file
   * save is offered.
   */
  onSystemPromptChange?: (systemPrompt: string) => void;
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
  onSystemPromptChange,
}: PromptFileEditorProps): React.JSX.Element | null {
  const refs = promptFileRefs(systemPrompt);
  if (refs.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-muted-foreground">
        {translate("promptFileEditor.thePromptTextLivesIn")}{" "}
        {refs.length === 1 ? translate("promptFileEditor.thisFile") : translate("promptFileEditor.theseFiles")}{translate("promptFileEditor.notInTheFlowSaving")}
        {onSystemPromptChange
          ? translate("promptFileEditor.saveAsAndCopyInto")
          : ""}
      </p>
      {refs.map((ref) =>
        ref.editable ? (
          <PromptFileCard
            key={ref.path}
            path={ref.path}
            token={token}
            systemPrompt={systemPrompt}
            {...(onSaved ? { onSaved } : {})}
            {...(onSystemPromptChange ? { onSystemPromptChange } : {})}
          />
        ) : (
          <p key={ref.path} className="text-[11px] text-muted-foreground">
            <span className="font-mono">{ref.path}</span> {translate("promptFileEditor.cannotBeEditedHereOnly")}{" "}
            <span className="font-mono">prompts/</span> {translate("promptFileEditor.areEditable")}
          </p>
        ),
      )}
    </div>
  );
}
