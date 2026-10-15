"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: model section of the node
 * panel (provenance, parameters, pool). Without behavior change.
 */

import type React from "react";
import type { FlowNode } from "../../types/flow";
import type { NodeTypeCatalog } from "../../lib/node-types";
import {
  Field,
  Section,
  inputCls,
  NumberOrVarInput,
  compact,
  JsonEditor,
} from "../form-controls";
import { ModelSourceFields } from "./ModelSourceFields";
import { UnreadFieldNotice } from "./shared";
import { translate } from "../../lib/i18n";

const REASONING_EFFORTS = ["", "none", "minimal", "low", "medium", "high"];

export function NodeModelSection({
  node,
  setLlm,
  setParam,
  isUnread,
  catalog,
  onFocusField,
}: {
  node: FlowNode;
  setLlm: (patch: Record<string, unknown>) => void;
  setParam: (key: string, value: unknown) => void;
  isUnread: (key: string) => boolean;
  catalog?: NodeTypeCatalog;
  onFocusField?: (key: string) => void;
}): React.JSX.Element {
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
  return (
            <Section title={translate("nodeModelSection.model")}>
              {isUnread("llm") && (
                <UnreadFieldNotice field="llm" type={node.type} />
              )}
              <ModelSourceFields
                key={node.id}
                node={node}
                setLlm={setLlm}
                shortcuts={catalog?.shortcuts}
                {...(onFocusField ? { onFocusField } : {})}
              />
              <div className="flex gap-2">
                <NumberOrVarInput
                  label={translate("nodeModelSection.temperature")}
                  value={params.temperature}
                  onFocus={() => onFocusField?.("llm.parameters.temperature")}
                  onChange={(v) => setParam("temperature", v)}
                />
                <NumberOrVarInput
                  label={translate("nodeModelSection.maxTokens")}
                  value={params.maxTokens}
                  onFocus={() => onFocusField?.("llm.parameters.maxTokens")}
                  onChange={(v) => setParam("maxTokens", v)}
                />
              </div>
              <div className="flex gap-2">
                <Field label={translate("nodeModelSection.reasoningEffort")}>
                  <select
                    className={inputCls}
                    onFocus={() =>
                      onFocusField?.("llm.parameters.reasoningEffort")
                    }
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
                      !REASONING_EFFORTS.includes(
                        String(params.reasoningEffort),
                      ) && (
                        <option value={String(params.reasoningEffort)}>
                          {String(params.reasoningEffort)}
                        </option>
                      )}
                  </select>
                </Field>
                <NumberOrVarInput
                  label={translate("nodeModelSection.contextLength")}
                  value={params.contextLength}
                  onFocus={() => onFocusField?.("llm.parameters.contextLength")}
                  onChange={(v) => setParam("contextLength", v)}
                />
              </div>
              <JsonEditor
                key={`${node.id}-params`}
                label={translate("nodeModelSection.otherModelParameters")}
                hint={translate("nodeModelSection.chatTemplateKwargsExtraBodyVisionInput")}
                rows={4}
                {...(onFocusField
                  ? { onCursorKey: (): void => onFocusField("llm.parameters") }
                  : {})}
                value={
                  Object.keys(extraParams).length > 0 ? extraParams : undefined
                }
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
                label={translate("nodeModelSection.modelPool")}
                hint={translate("nodeModelSection.strategyCandidatesProviderModelFirst")}
                rows={4}
                {...(onFocusField
                  ? { onCursorKey: (): void => onFocusField("llm.pool") }
                  : {})}
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
  );
}
