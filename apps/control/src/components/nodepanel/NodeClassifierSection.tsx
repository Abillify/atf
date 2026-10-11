"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: the classifier section.
 * Without behavior change.
 */

import type React from "react";
import type { FlowNode } from "../../types/flow";
import { Field, Section, inputCls, JsonEditor } from "../form-controls";

export function NodeClassifierSection({
  node,
  set,
  onFocusField,
}: {
  node: FlowNode;
  set: (patch: Partial<FlowNode>) => void;
  onFocusField?: (key: string) => void;
}): React.JSX.Element {
  return (
            <Section title="Classifier">
              <fieldset
                className="m-0 min-w-0 border-0 p-0"
                onFocus={() => onFocusField?.("classifierSchema")}
              >
                <Field label="Class key">
                  <input
                    className={inputCls}
                    onFocus={() => onFocusField?.("classifierSchema")}
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
              </fieldset>
            </Section>
  );
}
