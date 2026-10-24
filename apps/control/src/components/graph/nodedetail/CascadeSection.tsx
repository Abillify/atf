"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * CascadeSection — shows the model-cascade outcome of a node (kept vs.
 * escalated, the escalation reasons, and the first/final model) from the
 * execution's debug trace. Renders nothing for nodes without a cascade.
 */

import type React from "react";
import type { DebugNodeCascade } from "../../../types/debug-trace";
import { translate } from "../../../lib/i18n";
import { AccordionSection, KvGrid } from "./Shared";

export function CascadeSection({
  cascade,
}: {
  cascade: DebugNodeCascade | undefined;
}) {
  if (cascade === undefined) return null;
  return (
    <AccordionSection
      title={translate("cascadeSection.modelCascade")}
      badge={
        cascade.escalated
          ? translate("cascadeSection.escalated")
          : translate("cascadeSection.kept")
      }
      defaultOpen
    >
      <KvGrid
        data={[
          [
            translate("cascadeSection.outcome"),
            <span
              key="outcome"
              data-testid="cascade-outcome"
              className={`font-semibold ${
                cascade.escalated ? "text-warning" : "text-success"
              }`}
            >
              {cascade.escalated
                ? translate("cascadeSection.escalated")
                : translate("cascadeSection.kept")}
            </span>,
          ] as [string, React.ReactNode],
          [
            translate("cascadeSection.firstModel"),
            <span key="first" className="font-mono">
              {cascade.firstModel}
            </span>,
          ] as [string, React.ReactNode],
          [
            translate("cascadeSection.finalModel"),
            <span key="final" className="font-mono">
              {cascade.finalModel}
            </span>,
          ] as [string, React.ReactNode],
          ...(cascade.reasons.length > 0
            ? ([
                [
                  translate("cascadeSection.reasons"),
                  <ul key="reasons" className="list-disc space-y-0.5 pl-4">
                    {cascade.reasons.map((reason, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: reasons are an immutable ordered list from the trace
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>,
                ],
              ] as [string, React.ReactNode][])
            : []),
        ]}
      />
    </AccordionSection>
  );
}
