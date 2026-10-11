"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: the parallel children section.
 * Without behavior change.
 */

import type React from "react";
import { parallelChildId, type FlowNode } from "../../types/flow";
import { Field, Section, inputCls, JsonEditor } from "../form-controls";

export function NodeParallelSection({
  node,
  set,
  onFocusField,
}: {
  node: FlowNode;
  set: (patch: Partial<FlowNode>) => void;
  onFocusField?: (key: string) => void;
}): React.JSX.Element {
  const parallel = node.parallelNodes ?? [];
  const parallelHasConditions = parallel.some((p) => typeof p !== "string");
  return (
            <Section title="Parallel children">
              <fieldset
                className="m-0 min-w-0 border-0 p-0"
                onFocus={() => onFocusField?.("parallelNodes")}
              >
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
              </fieldset>
            </Section>
  );
}
