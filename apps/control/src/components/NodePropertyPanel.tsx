"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  parallelChildId,
  type FlowDefinition,
  type FlowNode,
  type Provider,
} from "../types/flow";
import { Button } from "../lib/ui";
import type { NodeTypeCatalog } from "../lib/node-types";
import { ConfigForm, ListInput } from "./ConfigForm";
import { FormulaInput, FormulaTextarea } from "./FormulaEditor";
import { PromptFileEditor } from "./PromptFileEditor";
import {
  type EvaluatedVariables,
  VariablesEditor,
  countVarUsages,
  varRefRe,
} from "./VariablesEditor";
import type { TopLevelField } from "../lib/node-types";
import {
  Field,
  Section,
  inputCls,
  numberOrUndefined,
  NumberOrVarInput,
  compact,
  JsonEditor,
} from "./form-controls";

export { JsonEditor } from "./form-controls";

export interface EdgeSelection {
  id: string;
  conditions: string;
  label: string;
}

export interface NodePropertyPanelProps {
  node: FlowNode | null;
  edge: EdgeSelection | null;
  onNodeChange: (node: FlowNode) => void;
  onDeleteNode: (id: string) => void;
  /**
   * Renames a node (references are followed by the caller). Returns an error
   * message, or null on success. Without it the id is read-only.
   */
  onRenameNode?: (oldId: string, newId: string) => string | null;
  /**
   * Which file the selected node is saved in: undefined = the flow file, else
   * a sub-flow path. With `onOriginChange` the panel offers to move it.
   */
  origin?: string | undefined;
  /** Sub-flow files available as targets (those on the canvas). */
  originOptions?: string[];
  onOriginChange?: (path: string | null) => void;
  onEdgeChange: (edge: EdgeSelection) => void;
  onDeleteEdge: (id: string) => void;
  /**
   * Rendered instead of the empty-state hint when nothing is selected (the
   * Studio builder passes its flow-level settings here).
   */
  emptyContent?: React.ReactNode;
  /** Node type catalog — enables the typed settings form (else JSON). */
  catalog?: NodeTypeCatalog;
  /** Ids of all nodes on the canvas (node pickers in the settings form). */
  nodeIds?: string[];
  /** A settings field got focus — the docs panel scrolls to it. */
  onFocusField?: (key: string) => void;
  /**
   * Operator token for the prompt-file endpoints (`/flows/prompts/*`). Without
   * it the prompt files behind `#[[file:…]]` are still listed, but loading them
   * fails on a runtime that requires authentication.
   */
  authToken?: string | undefined;
  /**
   * Open the Tools section and emphasise `tool` (a tool chip on the canvas
   * was clicked). A new `nonce` jumps again, e.g. on a second click.
   */
  focusTool?: { tool: string; nonce: number } | undefined;
}

/**
 * Static arguments per tool (`config.toolArgs[ref]`), next to the tool list
 * they belong to. The same map is editable as a whole under Settings →
 * "Forced tool arguments"; this is the per-tool view of it.
 */
function ToolArgsList({
  node,
  highlight,
  onChange,
  onFocus,
}: {
  node: FlowNode;
  highlight: string | undefined;
  onChange: (config: Record<string, unknown> | undefined) => void;
  onFocus: () => void;
}): React.JSX.Element {
  const config = (node.config ?? {}) as Record<string, unknown>;
  const { toolArgs: raw, args: defaultArgs, ...rest } = config;
  const toolArgs =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const refs = [...new Set(node.tools ?? [])];
  const isToolNode = node.type === "tool";
  const defaults = isToolNode ? defaultArgs : undefined;
  const orphans = Object.keys(toolArgs).filter((k) => !refs.includes(k));

  const setArgs = (ref: string, value: unknown): void => {
    const { [ref]: _old, ...others } = toolArgs;
    const nextArgs = value === undefined ? others : { ...others, [ref]: value };
    const next: Record<string, unknown> = {
      ...rest,
      ...(defaultArgs !== undefined ? { args: defaultArgs } : {}),
      ...(Object.keys(nextArgs).length > 0 ? { toolArgs: nextArgs } : {}),
    };
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus is only reported to the docs panel
    <div className="space-y-1.5" onFocus={onFocus} data-testid="tool-args-list">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Static arguments <code className="normal-case text-[10px] text-muted-foreground/70">config.toolArgs</code>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        {isToolNode
          ? "The complete arguments of each call (no model involved)."
          : "Fixed per tool and merged over what the model supplies — the model still fills the rest."}{" "}
        Templates like {"{{query}}"} or {"{{classification.<field>}}"} are resolved against the run.
      </p>
      {isToolNode && defaults !== undefined && (
        <p className="text-[10px] text-muted-foreground">
          Tools without an entry get <code>config.args</code>: <code className="break-all">{JSON.stringify(defaults)}</code>
        </p>
      )}
      <ul className="space-y-1">
        {refs.map((ref) => {
          const args = toolArgs[ref];
          const keys = args !== null && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
          const hot = highlight === ref;
          return (
            <li key={ref}>
              <details
                data-tool-args={ref}
                // Opened by the jump (focusTool effect) or by hand — deliberately not bound
                // to `hot`, which would close it again when the highlight fades.
                className={`rounded border px-2 py-1 transition-shadow ${
                  hot ? "border-sky-500 ring-2 ring-sky-500/60" : "border-border"
                }`}
              >
                <summary className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                  <code className="min-w-0 flex-1 truncate font-mono text-foreground">{ref}</code>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {keys.length > 0
                      ? `📌 ${keys.join(", ")}`
                      : isToolNode
                        ? defaults !== undefined
                          ? "config.args"
                          : "no arguments"
                        : "model decides all"}
                  </span>
                </summary>
                <div className="mt-1">
                  <JsonEditor
                    label={`Static arguments for ${ref}`}
                    formulaKind="template"
                    rows={Math.min(8, Math.max(3, JSON.stringify(args ?? {}, null, 2).split("\n").length + 1))}
                    value={args}
                    onChange={(v) => setArgs(ref, v)}
                  />
                  {args === undefined && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      e.g. <code>{'{ "collection": "cases" }'}</code> — empty: nothing fixed.
                    </p>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      {orphans.length > 0 && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          Arguments for tools not in the list (no effect): {orphans.join(", ")} — edit them under Settings → Forced tool
          arguments.
        </p>
      )}
    </div>
  );
}

/** Classes that briefly frame the Tools section after a jump to it. */
const TOOL_SECTION_FLASH = ["ring-2", "ring-sky-500", "ring-offset-2", "ring-offset-background"];

const PROVIDERS: Provider[] = [
  "openai",
  "google",
  "ollama",
  "azure",
  "bedrock",
  "anthropic",
];

const REASONING_EFFORTS = ["", "none", "minimal", "low", "medium", "high"];

/**
 * Shown when a node carries a field its type does not read. The field stays
 * editable on purpose: hiding it would leave a value in the file that looks
 * effective and never is, with no way to notice or delete it from the Studio.
 */
function UnreadFieldNotice({
  field,
  type,
}: {
  field: string;
  type: string;
}): React.JSX.Element {
  return (
    <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400">
      A <span className="font-mono">{type}</span> node does not read{" "}
      <span className="font-mono">{field}</span>. It is set here but has no
      effect — clear it unless you are about to change the node type.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Flow-level settings (shown when nothing is selected)
// ---------------------------------------------------------------------------

/** Top-level keys owned by the canvas or edited by dedicated fields. */
const FLOW_OWNED_KEYS = new Set([
  "id",
  "name",
  "description",
  "variables",
  "nodes",
  "edges",
  "metadata",
]);

/**
 * Renames a flow variable, keeping its position in the map, and rewrites every
 * `vars.<old>` reference in nodes, edges and the other flow fields.
 */
export function renameFlowVariable(
  flow: FlowDefinition,
  from: string,
  to: string,
): FlowDefinition {
  const re = varRefRe(from);
  // Walks the flow key by key so the top-level order (and thus the YAML diff)
  // stays as it was.
  return Object.fromEntries(
    Object.entries(flow).map(([key, value]) => [
      key,
      key === "variables"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
              k === from ? to : k,
              v,
            ]),
          )
        : value === undefined
          ? value
          : JSON.parse(JSON.stringify(value).replace(re, `vars.${to}`)),
    ]),
  ) as FlowDefinition;
}

export function FlowSettingsPanel({
  flow,
  idEditable,
  onChange,
  catalog,
  evaluateVariables,
}: {
  flow: FlowDefinition;
  /** Runtime evaluation of the variables map (formula previews). */
  evaluateVariables?: (
    variables: Record<string, unknown>,
  ) => Promise<EvaluatedVariables>;
  /** Node type catalog — its model shortcuts/models feed the variables' ƒx. */
  catalog?: NodeTypeCatalog;
  /** Only a brand-new flow may still pick its id. */
  idEditable: boolean;
  onChange: (next: FlowDefinition) => void;
}): React.JSX.Element {
  const extra = Object.fromEntries(
    Object.entries(flow).filter(([k]) => !FLOW_OWNED_KEYS.has(k)),
  );
  const { variables: _vars, ...referencing } = flow;
  const usages = countVarUsages(
    Object.keys(flow.variables ?? {}),
    JSON.stringify(referencing),
  );

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-foreground">Flow settings</h4>
      <p className="text-[10px] text-muted-foreground">
        Nothing selected — select a node or edge on the canvas to edit it.
      </p>
      <Field
        label="Flow id"
        hint={idEditable ? "Lowercase letters, digits and dashes." : undefined}
      >
        <input
          className={`${inputCls} font-mono`}
          value={flow.id}
          disabled={!idEditable}
          onChange={(e) =>
            onChange({
              ...flow,
              id: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "-"),
            })
          }
        />
      </Field>
      <Field label="Name">
        <FormulaInput
          kind="vars"
          ariaLabel="Name"
          className={inputCls}
          value={flow.name}
          onChange={(v) => onChange({ ...flow, name: v })}
        />
      </Field>
      <Field label="Description">
        <FormulaTextarea
          kind="vars"
          ariaLabel="Description"
          title="Flow description"
          className={`${inputCls} w-full resize-y`}
          rows={3}
          value={flow.description ?? ""}
          onChange={(v) =>
            onChange(
              compact({
                ...flow,
                description: v || undefined,
              }),
            )
          }
        />
      </Field>
      <VariablesEditor
        value={flow.variables}
        usages={usages}
        onChange={(v) =>
          onChange(
            compact({
              ...flow,
              variables: v as FlowDefinition["variables"],
            }),
          )
        }
        onRename={(from, to) => onChange(renameFlowVariable(flow, from, to))}
        nodes={flow.nodes}
        {...(catalog ? { catalog } : {})}
        {...(evaluateVariables ? { evaluate: evaluateVariables } : {})}
      />
      <JsonEditor
        label="Other flow fields"
        hint="pricing, dataClasses, recovery, … — everything not edited above."
        rows={10}
        value={extra}
        onChange={(v) => {
          if (v === undefined || typeof v !== "object" || Array.isArray(v)) {
            return;
          }
          const owned = Object.fromEntries(
            Object.entries(flow).filter(([k]) => FLOW_OWNED_KEYS.has(k)),
          );
          onChange({ ...(v as object), ...owned } as FlowDefinition);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node id heading with inline rename
// ---------------------------------------------------------------------------

type ModelSource = "shortcut" | "explicit";

/**
 * Where a node's model comes from: a shortcut from flows/model-shortcuts.yaml
 * OR an explicit provider + model — never both (the parser expands the
 * shortcut over provider/model, the flow schema rejects the mix). Switching
 * removes the other side from the node; it is kept here so switching back
 * during the session restores it.
 */
function ModelSourceFields({
  node,
  setLlm,
  shortcuts,
}: {
  node: FlowNode;
  setLlm: (patch: Record<string, unknown>) => void;
  shortcuts?: string[] | undefined;
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
              onChange={(v) => setLlm({ model: v || undefined })}
            />
          </Field>
        </div>
      )}
      {mode === "shortcut" && hasExplicit && (
        <p role="alert" className="flex items-start gap-2 text-[11px] text-amber-600">
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

function NodeIdHeading({
  id,
  onRename,
}: {
  id: string;
  onRename?: (next: string) => string | null;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <h4 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
        Node
        <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
        {onRename && (
          <button
            type="button"
            onClick={() => {
              setDraft(id);
              setError(null);
              setEditing(true);
            }}
            title="Rename this node — edges and references in other nodes are updated too"
            className="rounded px-1 text-[10px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            rename
          </button>
        )}
      </h4>
    );
  }

  const apply = (): void => {
    const err = onRename?.(draft) ?? null;
    if (err) setError(err);
    else setEditing(false);
  };

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          aria-label="Node id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
            if (e.key === "Escape") setEditing(false);
          }}
          className={`${inputCls} font-mono text-xs ${error ? "border-red-400" : ""}`}
        />
        <button
          type="button"
          onClick={apply}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
        >
          OK
        </button>
      </div>
      {error && <p className="mt-0.5 text-[10px] text-red-600">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node panel
// ---------------------------------------------------------------------------

export function NodePropertyPanel({
  node,
  edge,
  onNodeChange,
  onDeleteNode,
  onRenameNode,
  onEdgeChange,
  onDeleteEdge,
  emptyContent,
  catalog,
  nodeIds = [],
  onFocusField,
  origin,
  originOptions = [],
  onOriginChange,
  authToken,
  focusTool,
}: NodePropertyPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<"form" | "json">("form");
  // Jump to the Tools section (a tool chip on the canvas was clicked): open
  // it, scroll it into view and emphasise the tool for a moment.
  const [toolHighlight, setToolHighlight] = useState<string | undefined>(undefined);
  const focusNonce = focusTool?.nonce;
  const focusToolName = focusTool?.tool;
  useEffect(() => {
    if (focusNonce === undefined || focusToolName === undefined) return;
    setTab("form");
    setToolHighlight(focusToolName);
    let flashed: HTMLElement | null = null;
    const frame = requestAnimationFrame(() => {
      const section = document.querySelector<HTMLDetailsElement>('[data-section="tools"]');
      if (!section) return;
      section.open = true;
      // The tool's static arguments first, else its entry in the list.
      const args = Array.from(section.querySelectorAll<HTMLDetailsElement>("[data-tool-args]")).find(
        (el) => el.dataset.toolArgs === focusToolName,
      );
      if (args) args.open = true;
      const item = Array.from(section.querySelectorAll<HTMLElement>("[data-list-item]")).find(
        (el) => el.dataset.listItem === focusToolName,
      );
      (args ?? item ?? section).scrollIntoView?.({ block: "center", behavior: "smooth" });
      section.classList.add(...TOOL_SECTION_FLASH);
      flashed = section;
    });
    const timer = setTimeout(() => {
      setToolHighlight(undefined);
      flashed?.classList.remove(...TOOL_SECTION_FLASH);
    }, 2500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      flashed?.classList.remove(...TOOL_SECTION_FLASH);
    };
  }, [focusNonce, focusToolName]);

  if (edge !== null) {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Edge</h4>
        <Field
          label="Condition (routing expression)"
          hint="Empty = unconditional edge."
        >
          <FormulaTextarea
            kind="condition"
            ariaLabel="Condition (routing expression)"
            title="Edge condition"
            className={`${inputCls} resize-y font-mono text-xs`}
            rows={3}
            value={edge.conditions}
            placeholder="classification.route == 'INKASSO'"
            onChange={(v) => onEdgeChange({ ...edge, conditions: v })}
          />
        </Field>
        <Field label="Label">
          <FormulaInput
            kind="vars"
            ariaLabel="Edge label"
            className={inputCls}
            value={edge.label}
            onChange={(v) => onEdgeChange({ ...edge, label: v })}
          />
        </Field>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDeleteEdge(edge.id)}
        >
          Delete edge
        </Button>
      </div>
    );
  }

  if (node === null) {
    return (
      <>
        {emptyContent ?? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            Select a node or edge to edit, or add a node from the toolbar.
          </p>
        )}
      </>
    );
  }

  const typeDoc = catalog?.types.find((t) => t.type === node.type);
  const set = (patch: Partial<FlowNode>): void =>
    onNodeChange(compact({ ...node, ...patch }));
  // No provider/model defaults are injected: a source-form node may carry
  // only `shortcut`, and inventing "openai" there would override it.
  const setLlm = (patch: Record<string, unknown>): void =>
    set({
      llm: compact({ ...node.llm, ...patch }) as NonNullable<FlowNode["llm"]>,
    });
  const setParam = (key: string, value: unknown): void =>
    setLlm({
      parameters: compact({ ...node.llm?.parameters, [key]: value }),
    });

  // Which node fields this type actually reads comes from the runtime's own
  // catalog (`topLevel`), so the form cannot drift from the engine the way a
  // second hand-maintained list here would. A field the type ignores is hidden
  // — unless the node carries a value for it, which must stay visible so it can
  // be seen and removed instead of lingering unread in the file.
  const fieldUsage = (key: string): TopLevelField["usage"] | undefined =>
    typeDoc?.topLevel.find((f) => f.key === key)?.usage;
  /** @param fallback Visibility when no catalog is loaded (offline/older runtime). */
  const usesField = (key: string, fallback: boolean): boolean => {
    if (node[key as keyof FlowNode] !== undefined) return true;
    const usage = fieldUsage(key);
    if (usage !== undefined) return usage !== "ignored";
    // The catalog describes this type but does not list the field at all.
    return typeDoc === undefined ? fallback : false;
  };
  /** Set on the node although this type does not read it. */
  const isUnread = (key: string): boolean =>
    node[key as keyof FlowNode] !== undefined &&
    typeDoc !== undefined &&
    (fieldUsage(key) ?? "ignored") === "ignored";

  const showLlm = usesField(
    "llm",
    node.type === "llm" || node.type === "classifier",
  );
  const showPrompt = usesField(
    "systemPrompt",
    showLlm || node.type === "agent-harness",
  );
  const showTools = usesField(
    "tools",
    node.type === "llm" || node.type === "tool",
  );
  const showPriority = usesField("priority", true);
  const showOverrides = usesField("overrides", false);
  const params = node.llm?.parameters ?? {};
  const knownParams = new Set([
    "temperature",
    "maxTokens",
    "reasoningEffort",
    "contextLength",
  ]);
  const extraParams = Object.fromEntries(
    Object.entries(params).filter(([k]) => !knownParams.has(k)),
  );
  const parallel = node.parallelNodes ?? [];
  const parallelHasConditions = parallel.some((p) => typeof p !== "string");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <NodeIdHeading
          key={node.id}
          id={node.id}
          {...(onRenameNode ? { onRename: (next: string) => onRenameNode(node.id, next) } : {})}
        />
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
          {node.type}
        </span>
      </div>

      {onOriginChange && (
        <label className="flex items-center gap-2 text-[11px]">
          <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground">Saved in</span>
          <select
            aria-label="Saved in"
            value={origin ?? ""}
            onChange={(e) => onOriginChange(e.target.value === "" ? null : e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px]"
            title="The file this node is written to on save — the flow file or a sub-flow (use “New subflow” in the palette to create one)"
          >
            <option value="">this flow's file</option>
            {[...new Set([...originOptions, ...(origin ? [origin] : [])])].sort().map((p) => (
              <option key={p} value={p}>
                📄 {p}
              </option>
            ))}
          </select>
        </label>
      )}

      <div role="tablist" className="flex gap-1 text-xs">
        {(["form", "json"] as const).map((t) => (
          <button type="button"
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded px-2 py-0.5 ${
              tab === t
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t === "form" ? "Form" : "JSON (all fields)"}
          </button>
        ))}
      </div>

      {tab === "json" ? (
        <JsonEditor
          key={node.id}
          label="Node definition"
          hint="Edits apply while the JSON is valid. The id cannot be changed here."
          rows={24}
          allowEmpty={false}
          value={node}
          onChange={(v) => {
            if (v === null || typeof v !== "object" || Array.isArray(v)) return;
            onNodeChange({ ...(v as FlowNode), id: node.id });
          }}
        />
      ) : (
        <>
          <Field label="Label">
            <FormulaInput
              kind="vars"
              ariaLabel="Label"
              className={inputCls}
              value={node.label ?? ""}
              onChange={(v) => set({ label: v || undefined })}
            />
          </Field>
          {/* Only `llm` and `classifier` node priorities feed the queue
              priority; on any other type the number is read by nobody. */}
          {showPriority && (
            <>
              <Field label="Priority" hint="Queue priority; higher runs first.">
                <input
                  type="number"
                  className={inputCls}
                  value={node.priority ?? ""}
                  onChange={(e) =>
                    set({ priority: numberOrUndefined(e.target.value) })
                  }
                />
              </Field>
              {/* Outside <Field>: its children sit inside the <label>, so a
                  notice in there would become part of the accessible name. */}
              {isUnread("priority") && (
                <UnreadFieldNotice field="priority" type={node.type} />
              )}
            </>
          )}

          {showLlm && (
            <Section title="Model">
              {isUnread("llm") && (
                <UnreadFieldNotice field="llm" type={node.type} />
              )}
              <ModelSourceFields
                key={node.id}
                node={node}
                setLlm={setLlm}
                shortcuts={catalog?.shortcuts}
              />
              <div className="flex gap-2">
                <NumberOrVarInput
                  label="Temperature"
                  value={params.temperature}
                  onChange={(v) => setParam("temperature", v)}
                />
                <NumberOrVarInput
                  label="Max tokens"
                  value={params.maxTokens}
                  onChange={(v) => setParam("maxTokens", v)}
                />
              </div>
              <div className="flex gap-2">
                <Field label="Reasoning effort">
                  <select
                    className={inputCls}
                    value={String(params.reasoningEffort ?? "")}
                    onChange={(e) =>
                      setParam("reasoningEffort", e.target.value || undefined)
                    }
                  >
                    {REASONING_EFFORTS.map((r) => (
                      <option key={r} value={r}>
                        {r || "—"}
                      </option>
                    ))}
                    {params.reasoningEffort !== undefined &&
                      !REASONING_EFFORTS.includes(String(params.reasoningEffort)) && (
                        <option value={String(params.reasoningEffort)}>
                          {String(params.reasoningEffort)}
                        </option>
                      )}
                  </select>
                </Field>
                <NumberOrVarInput
                  label="Context length"
                  value={params.contextLength}
                  onChange={(v) => setParam("contextLength", v)}
                />
              </div>
              <JsonEditor
                key={`${node.id}-params`}
                label="Other model parameters"
                hint="chatTemplateKwargs, extraBody, visionInput, …"
                rows={4}
                value={Object.keys(extraParams).length > 0 ? extraParams : undefined}
                onChange={(v) => {
                  const known = Object.fromEntries(
                    Object.entries(params).filter(([k]) => knownParams.has(k)),
                  );
                  setLlm({
                    parameters: {
                      ...known,
                      ...((v as Record<string, unknown> | undefined) ?? {}),
                    },
                  });
                }}
              />
              <JsonEditor
                key={`${node.id}-pool`}
                label="Model pool"
                hint="{ strategy, candidates: [{ provider, model }, …] } — first candidate should match the model above."
                rows={4}
                value={node.llm?.pool}
                onChange={(v) =>
                  setLlm(
                    compact({
                      pool: v as NonNullable<FlowNode["llm"]>["pool"],
                    }),
                  )
                }
              />
            </Section>
          )}

          {showPrompt && (
            <Section title="System prompt">
              {isUnread("systemPrompt") && (
                <UnreadFieldNotice field="systemPrompt" type={node.type} />
              )}
              <FormulaTextarea
                ariaLabel="System prompt"
                title={`System prompt — ${node.id}`}
                className={`${inputCls} w-full resize-y text-xs`}
                rows={10}
                value={node.systemPrompt ?? ""}
                onFocus={() => onFocusField?.("systemPrompt")}
                onChange={(v) => set({ systemPrompt: v || undefined })}
              />
              {/* `#[[file:prompts/x.md]]` keeps the prompt text out of the flow
                  file — without this the field above shows a reference and the
                  wording itself would not be editable in the Studio at all. */}
              <PromptFileEditor
                key={`${node.id}-prompt-files`}
                systemPrompt={node.systemPrompt}
                token={authToken}
              />
            </Section>
          )}

          {showTools && (
            <Section title={`Tools (${node.tools?.length ?? 0})`} sectionId="tools">
              {isUnread("tools") && (
                <UnreadFieldNotice field="tools" type={node.type} />
              )}
              <Field
                label="MCP tools"
                hint={
                  catalog && catalog.tools.length > 0
                    ? `Suggestions: ${catalog.tools.length} tools of connected MCP servers. Patterns like server/* are allowed.`
                    : "Tool ids like vectorsearch/search; patterns like server/* are allowed."
                }
              >
                <fieldset className="m-0 min-w-0 border-0 p-0" onFocus={() => onFocusField?.("tools")}>
                  <ListInput
                    listId={`tools-${node.id}`}
                    value={node.tools}
                    onChange={(v) => set({ tools: v })}
                    highlight={toolHighlight}
                    {...(catalog ? { suggestions: catalog.tools } : {})}
                    placeholder="Add tool… (Enter)"
                  />
                </fieldset>
              </Field>
              {(node.tools?.length ?? 0) > 0 && (
                <ToolArgsList
                  node={node}
                  highlight={toolHighlight}
                  onChange={(config) => set({ config })}
                  onFocus={() => onFocusField?.("toolArgs")}
                />
              )}
            </Section>
          )}

          {node.type === "classifier" && (
            <Section title="Classifier">
              <Field label="Class key">
                <input
                  className={inputCls}
                  value={node.classifierSchema?.classKey ?? ""}
                  onChange={(e) =>
                    set({
                      classifierSchema: {
                        schema: node.classifierSchema?.schema ?? {
                          type: "object",
                          properties: {},
                        },
                        classKey: e.target.value,
                      },
                    })
                  }
                />
              </Field>
              <JsonEditor
                key={`${node.id}-schema`}
                label="Output schema (JSON Schema)"
                rows={8}
                allowEmpty={false}
                value={node.classifierSchema?.schema ?? {}}
                onChange={(v) =>
                  set({
                    classifierSchema: {
                      classKey: node.classifierSchema?.classKey ?? "",
                      schema: v as Record<string, unknown>,
                    },
                  })
                }
              />
            </Section>
          )}

          {node.type === "parallel" && (
            <Section title="Parallel children">
              {parallelHasConditions ? (
                <JsonEditor
                  key={`${node.id}-parallel`}
                  label="Children"
                  hint='Plain ids or { "node": id, "condition": expr }.'
                  rows={6}
                  value={parallel}
                  onChange={(v) =>
                    set({
                      parallelNodes: Array.isArray(v)
                        ? (v as FlowNode["parallelNodes"])
                        : undefined,
                    })
                  }
                />
              ) : (
                <Field
                  label="Child node ids (one per line)"
                  hint={`${parallel.map(parallelChildId).length} child(ren)`}
                >
                  <textarea
                    className={`${inputCls} h-20 resize-y font-mono text-xs`}
                    value={parallel.map(parallelChildId).join("\n")}
                    onChange={(e) =>
                      set({
                        parallelNodes: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0),
                      })
                    }
                  />
                </Field>
              )}
            </Section>
          )}

          <Section
            title={`Settings${node.config ? ` (${Object.keys(node.config).length} set)` : ""}`}
            defaultOpen={typeDoc !== undefined || node.config !== undefined}
          >
            {typeDoc && catalog ? (
              <ConfigForm
                key={`${node.id}-config-form`}
                fields={typeDoc.config}
                common={catalog.common}
                value={node.config}
                onChange={(v) => set({ config: v })}
                nodeIds={nodeIds.filter((id) => id !== node.id)}
                tools={catalog.tools}
                shortcuts={catalog.shortcuts}
                {...(onFocusField ? { onFocusField } : {})}
              />
            ) : (
              <JsonEditor
                key={`${node.id}-config`}
                label="Node config"
                hint={
                  catalog
                    ? `No settings catalog for type "${node.type}" (plugin type?) — edit as JSON.`
                    : "Type-specific settings as JSON (the settings catalog is loading or unavailable)."
                }
                rows={12}
                value={node.config}
                onChange={(v) =>
                  set({ config: v as Record<string, unknown> | undefined })
                }
              />
            )}
          </Section>

          {showOverrides && (
            <Section title="Overrides" defaultOpen={false}>
              {/* Only `llm` and `tool` nodes consult `overrides`
                  (graph-engine/node-config.ts). A classifier in particular
                  reads llm/systemPrompt directly and skips them. */}
              {isUnread("overrides") && (
                <UnreadFieldNotice field="overrides" type={node.type} />
              )}
              <JsonEditor
                key={`${node.id}-overrides`}
                label="Overrides"
                rows={6}
                value={node.overrides}
                onChange={(v) =>
                  set({ overrides: v as unknown[] | undefined })
                }
              />
            </Section>
          )}
        </>
      )}

      <div className="border-t border-border pt-3">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDeleteNode(node.id)}
        >
          Delete node
        </Button>
      </div>
    </div>
  );
}
