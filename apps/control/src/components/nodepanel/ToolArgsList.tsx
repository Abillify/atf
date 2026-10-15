"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: static arguments per
 * tool (`config.toolArgs[ref]`). Without behavior change.
 */

import type React from "react";
import type { FlowNode } from "../../types/flow";
import { JsonEditor } from "../form-controls";
import { translate } from "../../lib/i18n";

/**
 * Static arguments per tool (`config.toolArgs[ref]`), next to the tool list
 * they belong to. The same map is editable as a whole under Settings →
 * "Forced tool arguments"; this is the per-tool view of it.
 */
export function ToolArgsList({
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
        {translate("toolArgsList.staticArguments")} <code className="normal-case text-[10px] text-muted-foreground/70">config.toolArgs</code>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        {isToolNode
          ? translate("toolArgsList.theCompleteArgumentsOfEach")
          : translate("toolArgsList.fixedPerToolAndMerged")}{" "}
        {translate("toolArgsList.templatesLike")} {translate("toolArgsList.query")} or {translate("toolArgsList.classificationField")} {translate("toolArgsList.areResolvedAgainstTheRun")}
      </p>
      {isToolNode && defaults !== undefined && (
        <p className="text-[10px] text-muted-foreground">
          {translate("toolArgsList.toolsWithoutAnEntryGet")} <code>config.args</code>: <code className="break-all">{JSON.stringify(defaults)}</code>
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
                  hot ? "border-info-border ring-2 ring-info/60" : "border-border"
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
                          : translate("toolArgsList.noArguments")
                        : translate("toolArgsList.modelDecidesAll")}
                  </span>
                </summary>
                <div className="mt-1">
                  <JsonEditor
                    label={translate("toolArgsList.staticArgumentsForRef", { ref })}
                    formulaKind="template"
                    rows={Math.min(8, Math.max(3, JSON.stringify(args ?? {}, null, 2).split("\n").length + 1))}
                    value={args}
                    onChange={(v) => setArgs(ref, v)}
                  />
                  {args === undefined && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      e.g. <code>{'{ "collection": "cases" }'}</code> {translate("toolArgsList.emptyNothingFixed")}
                    </p>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      {orphans.length > 0 && (
        <p className="text-[10px] text-warning">
          {translate("toolArgsList.argumentsForToolsNotIn", { value: orphans.join(", ") })}
        </p>
      )}
    </div>
  );
}
