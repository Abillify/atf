// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Root page — redirects to the Live Graph route.
 *
 * The monolithic dashboard that previously lived here has been split into
 * individual route pages under (dashboard)/. This redirect keeps old
 * bookmarks working (Req. 9.1).
 */
import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/graph");
}
