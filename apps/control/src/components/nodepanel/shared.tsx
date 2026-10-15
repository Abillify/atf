"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: small shared pieces
 * (flash frame for the tools jump, hint about unread fields).
 * Taken over verbatim, without behavior change.
 */

import type React from "react";
import { translate } from "../../lib/i18n";

/** Classes that briefly frame the Tools section after a jump to it. */
export const TOOL_SECTION_FLASH = ["ring-2", "ring-info", "ring-offset-2", "ring-offset-background"];

/**
 * Shown when a node carries a field its type does not read. The field stays
 * editable on purpose: hiding it would leave a value in the file that looks
 * effective and never is, with no way to notice or delete it from the Studio.
 */
export function UnreadFieldNotice({
  field,
  type,
}: {
  field: string;
  type: string;
}): React.JSX.Element {
  return (
    <p className="rounded border border-warning-border bg-warning-solid/10 px-2 py-1 text-[10px] text-warning">
      A <span className="font-mono">{type}</span> {translate("shared.nodeDoesNotRead")}{" "}
      <span className="font-mono">{field}</span>{translate("shared.itIsSetHereBut")}
    </p>
  );
}
