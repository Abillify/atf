"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /assistants — operator view of the per-user assistant estate.
 *
 * Reached with an operator role, so it spans users. A user's own assistant settings
 * live on the `/v1/assistants` API their client calls with their own identity; this
 * page is the operator counterpart and owns the `constraints` soul write class.
 */

import type React from "react";
import { AssistantsPanel } from "../../../components/AssistantsPanel";

export default function AssistantsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-1 text-xl font-semibold text-foreground">Assistants</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        Every user&apos;s personal assistant: its identity, its learned procedures, the
        credentials delegated to it, and the operator constraints it must obey.
      </p>
      <AssistantsPanel />
    </div>
  );
}
