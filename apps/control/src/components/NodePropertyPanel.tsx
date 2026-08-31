"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import type { FlowNode, Provider } from "../types/flow";
import { Button } from "../lib/ui";

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
  onEdgeChange: (edge: EdgeSelection) => void;
  onDeleteEdge: (id: string) => void;
}

const PROVIDERS: Provider[] = [
  "openai",
  "google",
  "ollama",
  "azure",
  "bedrock",
  "anthropic",
];

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded border border-border px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function NodePropertyPanel({
  node,
  edge,
  onNodeChange,
  onDeleteNode,
  onEdgeChange,
  onDeleteEdge,
}: NodePropertyPanelProps): React.JSX.Element {
  if (edge !== null) {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Edge</h4>
        <Field label="Condition (routing expression)">
          <input
            className={inputCls}
            value={edge.conditions}
            placeholder="classLabel == 'COLLECTIONS'"
            onChange={(e) =>
              onEdgeChange({ ...edge, conditions: e.target.value })
            }
          />
        </Field>
        <Field label="Label">
          <input
            className={inputCls}
            value={edge.label}
            onChange={(e) => onEdgeChange({ ...edge, label: e.target.value })}
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
      <p className="py-8 text-center text-xs text-muted-foreground">
        Select a node or edge to edit, or add a node from the toolbar.
      </p>
    );
  }

  const set = (patch: Partial<FlowNode>): void =>
    onNodeChange({ ...node, ...patch });
  const setLlm = (patch: Partial<NonNullable<FlowNode["llm"]>>): void =>
    set({
      llm: {
        provider: node.llm?.provider ?? "openai",
        model: node.llm?.model ?? "",
        ...node.llm,
        ...patch,
      },
    });
  const setParam = (
    key: "temperature" | "maxTokens",
    value: number | undefined,
  ): void => setLlm({ parameters: { ...node.llm?.parameters, [key]: value } });

  const showLlm = node.type === "llm" || node.type === "classifier";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">
          Node{" "}
          <span className="font-mono text-xs text-muted-foreground">
            {node.id}
          </span>
        </h4>
        <span className="rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
          {node.type}
        </span>
      </div>

      <Field label="Label">
        <input
          className={inputCls}
          value={node.label ?? ""}
          onChange={(e) => set({ label: e.target.value })}
        />
      </Field>

      {showLlm && (
        <>
          <div className="flex gap-2">
            <Field label="Provider">
              <select
                className={inputCls}
                value={node.llm?.provider ?? "openai"}
                onChange={(e) =>
                  setLlm({ provider: e.target.value as Provider })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <input
                className={inputCls}
                value={node.llm?.model ?? ""}
                onChange={(e) => setLlm({ model: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Field label="Temperature">
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                className={inputCls}
                value={node.llm?.parameters?.temperature ?? ""}
                onChange={(e) =>
                  setParam(
                    "temperature",
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              />
            </Field>
            <Field label="Max tokens">
              <input
                type="number"
                min="1"
                className={inputCls}
                value={node.llm?.parameters?.maxTokens ?? ""}
                onChange={(e) =>
                  setParam(
                    "maxTokens",
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              />
            </Field>
          </div>
          <Field label="System prompt">
            <textarea
              className={`${inputCls} h-20 resize-y`}
              value={node.systemPrompt ?? ""}
              onChange={(e) =>
                set({ systemPrompt: e.target.value || undefined })
              }
            />
          </Field>
        </>
      )}

      {(node.type === "llm" || node.type === "tool") && (
        <Field label="Tools (one per line, e.g. mcp/search)">
          <textarea
            className={`${inputCls} h-16 resize-y font-mono text-xs`}
            value={(node.tools ?? []).join("\n")}
            onChange={(e) =>
              set({
                tools: e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
          />
        </Field>
      )}

      {node.type === "classifier" && (
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
      )}

      {node.type === "parallel" && (
        <Field label="Parallel child node ids (one per line)">
          <textarea
            className={`${inputCls} h-16 resize-y font-mono text-xs`}
            value={(node.parallelNodes ?? []).join("\n")}
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

      <Button
        variant="destructive"
        size="sm"
        onClick={() => onDeleteNode(node.id)}
      >
        Delete node
      </Button>
    </div>
  );
}
