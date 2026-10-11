// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /flow-diff — consolidated into /flows (Req. 9.9).
 *
 * The Flow Diff Viewer now lives in the "Diff" tab of /flows. This stub keeps
 * the old URL working (bookmarks, deep links) and lands on the tab directly.
 */

import { redirect } from "next/navigation";

export default function FlowDiffRedirect(): never {
  redirect("/flows?tab=diff");
}
