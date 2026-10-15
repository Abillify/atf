"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: split out of NodePropertyPanel.tsx: edge details, flow settings,
 * model provenance, model section, classifier, parallel and tool sections
 * live under ./nodepanel/; this file holds the panel composition. The
 * import paths (NodePropertyPanel, FlowSettingsPanel, EdgeSelection,
 * renameFlowVariable, JsonEditor) stay unchanged, without behavior
 * change.
 */

import type React from "react";
import { useEffect, useState } from "react";
import type { FlowNode } from "../types/flow";
import { Button } from "../lib/ui";
import type { NodeTypeCatalog } from "../lib/node-types";
import { nodeDocKeyForPath } from "../lib/json-key-path";
import { ConfigForm, ListInput } from "./ConfigForm";
import { FormulaInput, FormulaTextarea } from "./FormulaEditor";
import { PromptFileEditor } from "./PromptFileEditor";
import type { TopLevelField } from "../lib/node-types";
import {
  Field,
  Section,
  inputCls,
  numberOrUndefined,
  compact,
  JsonEditor,
} from "./form-controls";
import {
  EdgeDetailsPanel,
  type EdgeSelection,
} from "./nodepanel/EdgeDetailsPanel";
import { NodeIdHeading } from "./nodepanel/NodeIdHeading";
import { NodeModelSection } from "./nodepanel/NodeModelSection";
import { NodeClassifierSection } from "./nodepanel/NodeClassifierSection";
import { NodeParallelSection } from "./nodepanel/NodeParallelSection";
import { ToolArgsList } from "./nodepanel/ToolArgsList";
import { TOOL_SECTION_FLASH, UnreadFieldNotice } from "./nodepanel/shared";
import { translate } from "../lib/i18n";

export { JsonEditor } from "./form-controls";
export type { EdgeSelection } from "./nodepanel/EdgeDetailsPanel";
export {
  FlowSettingsPanel,
  renameFlowVariable,
} from "./nodepanel/FlowSettingsPanel";

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
      <EdgeDetailsPanel
        edge={edge}
        onEdgeChange={onEdgeChange}
        onDeleteEdge={onDeleteEdge}
      />
    );
  }

  if (node === null) {
    return (
      <>
        {emptyContent ?? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {translate("nodePropertyPanel.selectANodeOrEdge")}
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <NodeIdHeading
          key={node.id}
          id={node.id}
          {...(onRenameNode
            ? { onRename: (next: string) => onRenameNode(node.id, next) }
            : {})}
        />
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
          {node.type}
        </span>
      </div>

      {onOriginChange && (
        <label className="flex items-center gap-2 text-[11px]">
          <span className="shrink-0 font-medium uppercase tracking-wide text-muted-foreground">
            {translate("nodePropertyPanel.savedIn")}
          </span>
          <select
            aria-label={translate("nodePropertyPanel.savedIn")}
            value={origin ?? ""}
            onChange={(e) =>
              onOriginChange(e.target.value === "" ? null : e.target.value)
            }
            className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px]"
            title={translate("nodePropertyPanel.theFileThisNodeIs")}
          >
            <option value="">{translate("nodePropertyPanel.thisFlowSFile")}</option>
            {[...new Set([...originOptions, ...(origin ? [origin] : [])])]
              .sort()
              .map((p) => (
                <option key={p} value={p}>
                  📄 {p}
                </option>
              ))}
          </select>
        </label>
      )}

      <div role="tablist" className="flex gap-1 text-xs">
        {(["form", "json"] as const).map((t) => (
          <button
            type="button"
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
            {t === "form" ? translate("nodePropertyPanel.form") : translate("nodePropertyPanel.jSONAllFields")}
          </button>
        ))}
      </div>

      {tab === "json" ? (
        <JsonEditor
          key={node.id}
          label={translate("nodePropertyPanel.nodeDefinition")}
          hint={translate("nodePropertyPanel.editsApplyWhileTheJSON")}
          rows={24}
          allowEmpty={false}
          value={node}
          onChange={(v) => {
            if (v === null || typeof v !== "object" || Array.isArray(v)) return;
            onNodeChange({ ...(v as FlowNode), id: node.id });
          }}
          // The docs panel follows the cursor: the key path under it maps onto
          // a documented passage (config.* → bare key, llm.* → model field).
          {...(onFocusField
            ? {
                onCursorKey: (path: string | undefined): void => {
                  const docKey = nodeDocKeyForPath(path, catalog?.llmFields);
                  if (docKey !== undefined) onFocusField(docKey);
                },
              }
            : {})}
        />
      ) : (
        <>
          <Field label={translate("nodePropertyPanel.label")}>
            <FormulaInput
              kind="vars"
              ariaLabel={translate("nodePropertyPanel.label")}
              className={inputCls}
              value={node.label ?? ""}
              onFocus={() => onFocusField?.("label")}
              onChange={(v) => set({ label: v || undefined })}
            />
          </Field>
          {/* Only `llm` and `classifier` node priorities feed the queue
              priority; on any other type the number is read by nobody. */}
          {showPriority && (
            <>
              <Field label={translate("nodePropertyPanel.priority")} hint={translate("nodePropertyPanel.queuePriorityHigherRunsFirst")}>
                <input
                  type="number"
                  className={inputCls}
                  value={node.priority ?? ""}
                  onFocus={() => onFocusField?.("priority")}
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
            <NodeModelSection
              node={node}
              setLlm={setLlm}
              setParam={setParam}
              isUnread={isUnread}
              {...(catalog ? { catalog } : {})}
              {...(onFocusField ? { onFocusField } : {})}
            />
          )}

          {showPrompt && (
            <Section title={translate("nodePropertyPanel.systemPrompt")}>
              {isUnread("systemPrompt") && (
                <UnreadFieldNotice field="systemPrompt" type={node.type} />
              )}
              <FormulaTextarea
                ariaLabel={translate("nodePropertyPanel.systemPrompt")}
                title={translate("nodePropertyPanel.systemPromptId", { id: node.id })}
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
                onSystemPromptChange={(v) =>
                  set({ systemPrompt: v || undefined })
                }
              />
            </Section>
          )}

          {showTools && (
            <Section
              title={translate("nodePropertyPanel.toolsValue", { value: node.tools?.length ?? 0 })}
              sectionId="tools"
            >
              {isUnread("tools") && (
                <UnreadFieldNotice field="tools" type={node.type} />
              )}
              <Field
                label={translate("nodePropertyPanel.mCPTools")}
                hint={
                  catalog && catalog.tools.length > 0
                    ? translate("nodePropertyPanel.suggestionsLengthToolsOfConnected", { length: catalog.tools.length })
                    : translate("nodePropertyPanel.toolIdsLikeVectorsearchSearch")
                }
              >
                <fieldset
                  className="m-0 min-w-0 border-0 p-0"
                  onFocus={() => onFocusField?.("tools")}
                >
                  <ListInput
                    listId={`tools-${node.id}`}
                    value={node.tools}
                    onChange={(v) => set({ tools: v })}
                    highlight={toolHighlight}
                    {...(catalog ? { suggestions: catalog.tools } : {})}
                    placeholder={translate("nodePropertyPanel.addToolEnter")}
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
            <NodeClassifierSection
              node={node}
              set={set}
              {...(onFocusField ? { onFocusField } : {})}
            />
          )}

          {node.type === "parallel" && (
            <NodeParallelSection
              node={node}
              set={set}
              {...(onFocusField ? { onFocusField } : {})}
            />
          )}

          <Section
            title={translate("nodePropertyPanel.settingsValue", { value: node.config ? ` (${Object.keys(node.config).length} set)` : "" })}
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
                label={translate("nodePropertyPanel.nodeConfig")}
                hint={
                  catalog
                    ? translate("nodePropertyPanel.noSettingsCatalogForType", { type: node.type })
                    : translate("nodePropertyPanel.typeSpecificSettingsAsJSON")
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
            <Section title={translate("nodePropertyPanel.overrides")} defaultOpen={false}>
              {/* Only `llm` and `tool` nodes consult `overrides`
                  (graph-engine/node-config.ts). A classifier in particular
                  reads llm/systemPrompt directly and skips them. */}
              {isUnread("overrides") && (
                <UnreadFieldNotice field="overrides" type={node.type} />
              )}
              <fieldset
                className="m-0 min-w-0 border-0 p-0"
                onFocus={() => onFocusField?.("overrides")}
              >
                <JsonEditor
                  key={`${node.id}-overrides`}
                  label={translate("nodePropertyPanel.overrides")}
                  rows={6}
                  value={node.overrides}
                  onChange={(v) =>
                    set({ overrides: v as unknown[] | undefined })
                  }
                />
              </fieldset>
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
          {translate("nodePropertyPanel.deleteNode")}
        </Button>
      </div>
    </div>
  );
}
