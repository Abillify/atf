"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: the model provenance of a
 * node: shortcut OR explicit provider+model, never both.
 * Without behavior change.
 */

import { useRef, useState } from "react";
import type React from "react";
import type { FlowNode, Provider } from "../../types/flow";
import { FormulaInput } from "../FormulaEditor";
import { Field, inputCls } from "../form-controls";

const PROVIDERS: Provider[] = [
  "openai",
  "google",
  "ollama",
  "azure",
  "bedrock",
  "anthropic",
];

type ModelSource = "shortcut" | "explicit";

/**
 * Where a node's model comes from: a shortcut from flows/model-shortcuts.yaml
 * OR an explicit provider + model — never both (the parser expands the
 * shortcut over provider/model, the flow schema rejects the mix). Switching
 * removes the other side from the node; it is kept here so switching back
 * during the session restores it.
 */
export function ModelSourceFields({
  node,
  setLlm,
  shortcuts,
  onFocusField,
}: {
  node: FlowNode;
  setLlm: (patch: Record<string, unknown>) => void;
  shortcuts?: string[] | undefined;
  /** Reports the focused model sub-field (`llm.shortcut`, …) for the docs. */
  onFocusField?: (key: string) => void;
}): React.JSX.Element {
  const llm = node.llm;
  const hasShortcut = !!llm?.shortcut;
  const hasExplicit = !!llm?.provider || !!llm?.model;
  const [mode, setMode] = useState<ModelSource>(
    hasShortcut ? "shortcut" : hasExplicit ? "explicit" : (shortcuts?.length ?? 0) > 0 ? "shortcut" : "explicit",
  );
  const stash = useRef<{ shortcut?: string; provider?: string; model?: string }>({});

  const switchTo = (next: ModelSource): void => {
    if (next === mode) return;
    if (next === "explicit") {
      if (llm?.shortcut) stash.current.shortcut = llm.shortcut;
      setLlm({ shortcut: undefined, provider: stash.current.provider, model: stash.current.model });
    } else {
      if (llm?.provider) stash.current.provider = llm.provider;
      if (llm?.model) stash.current.model = llm.model;
      setLlm({ provider: undefined, model: undefined, shortcut: stash.current.shortcut });
    }
    setMode(next);
  };

  const tab = (m: ModelSource, label: string, title: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => switchTo(m)}
      title={title}
      className={`flex-1 px-2 py-1 text-[11px] ${
        mode === m ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      <div role="tablist" aria-label="Model source" className="flex overflow-hidden rounded border border-border">
        {tab("shortcut", "Shortcut", "A named preset from flows/model-shortcuts.yaml (provider, model and parameters)")}
        {tab("explicit", "Provider + model", "Name the provider and model directly")}
      </div>
      {mode === "shortcut" ? (
        <Field
          label="Shortcut"
          hint="A name from flows/model-shortcuts.yaml or {{vars.…}}. It sets provider, model and the preset's parameters; parameters below override the preset's."
        >
          <FormulaInput
            kind="vars"
            replace
            ariaLabel="Shortcut"
            title="Model shortcut"
            className={`${inputCls} font-mono text-xs`}
            value={llm?.shortcut ?? ""}
            placeholder="e.g. fast-pool or {{vars.model_main}}"
            list={`shortcuts-${node.id}`}
            onFocus={() => onFocusField?.("llm.shortcut")}
            onChange={(v) => setLlm({ shortcut: v || undefined })}
          />
          {shortcuts && (
            <datalist id={`shortcuts-${node.id}`}>
              {shortcuts.map((sc) => (
                <option key={sc} value={sc} />
              ))}
            </datalist>
          )}
        </Field>
      ) : (
        <div className="flex gap-2">
          <Field label="Provider">
            <FormulaInput
              kind="vars"
              replace
              ariaLabel="Provider"
              className={inputCls}
              list="studio-provider-options"
              value={llm?.provider ?? ""}
              onFocus={() => onFocusField?.("llm.provider")}
              onChange={(v) => setLlm({ provider: v || undefined })}
            />
            <datalist id="studio-provider-options">
              {PROVIDERS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field label="Model">
            <FormulaInput
              kind="vars"
              replace
              ariaLabel="Model"
              className={inputCls}
              value={llm?.model ?? ""}
              onFocus={() => onFocusField?.("llm.model")}
              onChange={(v) => setLlm({ model: v || undefined })}
            />
          </Field>
        </div>
      )}
      {mode === "shortcut" && hasExplicit && (
        <p role="alert" className="flex items-start gap-2 text-[11px] text-warning">
          <span>
            This node also sets provider/model ({[llm?.provider, llm?.model].filter(Boolean).join(" · ")}), which the
            shortcut overwrites.
          </span>
          <button
            type="button"
            onClick={() => setLlm({ provider: undefined, model: undefined })}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-foreground hover:bg-muted"
          >
            Remove
          </button>
        </p>
      )}
    </div>
  );
}
