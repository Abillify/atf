// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Root page — redirects to the operator overview.
 *
 * The monolithic dashboard that previously lived here has been split into
 * individual route pages under (dashboard)/. This redirect keeps old
 * bookmarks working (Req. 9.1).
 *
 * It used to land on `/graph`. Since the overview exists (review follow-up F1)
 * it is the better first screen: an operator sees readiness, open approvals and
 * the live flows before deciding which page to open.
 */
import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/overview");
}
